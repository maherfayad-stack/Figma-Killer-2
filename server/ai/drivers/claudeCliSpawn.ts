/**
 * Low-level `claude` CLI process spawn — incremental NDJSON line reader.
 *
 * `runCappedSubprocess` (subprocessRunner.ts) is right for the availability
 * probe (`claude auth status --json`): a short one-shot call whose result is
 * only useful once the process has fully exited. A CHAT turn is the opposite
 * shape — the CLI streams `assistant`/`result` lines as the model produces
 * them, and the whole point of the AgentPanel's NDJSON wire protocol is that
 * the browser sees text as it arrives, not after the entire (possibly
 * multi-second, tool-using) turn finishes. So this module reads
 * `proc.stdout` incrementally and yields each parsed line as the child writes
 * it, while draining `stderr` into the same capped buffer
 * `subprocessRunner.ts` uses (`pumpCapped`) for the crash-diagnostic case —
 * WS-11 §4.0 confirms stderr is empty on every *non-crash* path, so anything
 * that does land there is exactly the "real crash" signal worth keeping.
 *
 * Reuses `subprocessRunner.ts`'s `SpawnedProcessLike`/`SubprocessSpawnFn` so
 * the same injectable-spawn test seam covers both call shapes.
 */

import {
  pumpCapped,
  type SpawnedProcessLike,
  type SubprocessSpawnFn,
} from '../../handlers/studio/subprocessRunner'

export interface ClaudeCliSpawnOptions {
  readonly argv: string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly signal: AbortSignal
  /** Test seam — defaults to `Bun.spawn`. */
  readonly spawn?: SubprocessSpawnFn
  /**
   * Backstop only — the primary cancellation path is `signal`. Guards against
   * a wedged process that never produces output and whose caller never
   * aborts (e.g. a genuinely hung `claude` binary).
   */
  readonly timeoutMs?: number
  readonly maxStderrBytes?: number
}

export type ClaudeCliRawEvent =
  | { readonly kind: 'line'; readonly value: unknown }
  /** Terminal — always the last event yielded, exactly once. */
  | { readonly kind: 'exit'; readonly exitCode: number | null; readonly stderr: string; readonly timedOut: boolean }

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

const defaultSpawn: SubprocessSpawnFn = (argv, options) =>
  Bun.spawn(argv, options) as unknown as SpawnedProcessLike

export class ClaudeCliSpawnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ClaudeCliSpawnError'
  }
}

/**
 * Spawn `claude`, yielding one `{ kind: 'line' }` per NDJSON line on stdout as
 * it arrives, followed by exactly one terminal `{ kind: 'exit' }`. Never
 * throws for a clean process failure (non-zero exit) — that's represented by
 * the `exit` event; callers decide what a given exit code means. DOES throw
 * `ClaudeCliSpawnError` if the binary itself can't be started (not on PATH).
 */
export async function* spawnClaudeCliNdjson(
  options: ClaudeCliSpawnOptions,
): AsyncGenerator<ClaudeCliRawEvent, void, void> {
  const spawn = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES

  let proc: SpawnedProcessLike
  try {
    proc = spawn(options.argv, {
      cwd: options.cwd,
      env: options.env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
  } catch (err) {
    throw new ClaudeCliSpawnError(
      `Could not start the Claude CLI ("${options.argv[0]}"). Is it installed and on PATH?`,
      { cause: err },
    )
  }

  let timedOut = false
  let killed = false
  const kill = (): void => {
    if (killed) return
    killed = true
    try {
      proc.kill()
    } catch {
      // already exited — nothing to kill
    }
  }

  const onAbort = (): void => kill()
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) kill()

  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutMs)

  // Drain stderr concurrently and independently of stdout — a full stderr
  // pipe buffer must never block the child from writing more stdout (the
  // same "drain both streams concurrently" discipline `captureSubprocess`
  // uses, just without waiting for exit before doing anything with stdout).
  const stderrPromise = pumpCapped(proc.stderr, maxStderrBytes)

  try {
    yield* readLines(proc.stdout)
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
  }

  const [stderrResult, exitCode] = await Promise.all([stderrPromise, proc.exited])
  yield { kind: 'exit', exitCode, stderr: stderrResult.text, timedOut }
}

async function* readLines(
  stream: ReadableStream<Uint8Array> | null,
): AsyncGenerator<ClaudeCliRawEvent, void, void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line.trim()) {
          const parsed = tryParseJsonLine(line)
          if (parsed !== undefined) yield { kind: 'line', value: parsed }
        }
      }
    }
    // A final line with no trailing newline (the CLI closed stdout right
    // after writing it) is still worth parsing.
    if (buffer.trim()) {
      const parsed = tryParseJsonLine(buffer)
      if (parsed !== undefined) yield { kind: 'line', value: parsed }
    }
  } finally {
    reader.releaseLock()
  }
}

function tryParseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    // A stray non-JSON line (rare, but not fatal) — the translator layer
    // only ever sees well-formed JSON.
    return undefined
  }
}
