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
  /**
   * The `-p` prompt, written to the child's stdin instead of passed as an
   * argv positional.
   *
   * This is a Windows correctness requirement, confirmed empirically. `claude`
   * on PATH resolves to npm's `claude.cmd` shim, and `Bun.spawn` executes it
   * through `cmd.exe`, which RE-PARSES the command line. A newline anywhere in
   * an argument terminates that line, so every flag after the prompt is
   * silently dropped: `--output-format stream-json` never arrives, the CLI
   * falls back to plain-text output, and this driver — which only understands
   * NDJSON — sees a clean `exit 0` with nothing it can read. It then reports
   * "exited (0) without a result", blaming auth for a quoting bug.
   *
   * Measured, same binary, same flags:
   *   prompt "Reply with exactly: OK"        → exit 0, stream-json: YES
   *   prompt "Reply with exactly: OK\n\n…"   → exit 0, stream-json: NO ("OK")
   *
   * That made every multi-line prompt fail, and every prompt with an
   * attachment, since `describeAttachmentsForPrompt` appends "\n\n…".
   * Piping the prompt keeps user text off the command line entirely, which
   * also removes the ~32 KB Windows command-line ceiling as a failure mode.
   */
  readonly stdin: Uint8Array
  readonly signal: AbortSignal
  /** Test seam — defaults to `Bun.spawn`. */
  readonly spawn?: SubprocessSpawnFn
  /**
   * Backstop only — the primary cancellation path is `signal`. Guards against
   * a wedged process that never produces output and whose caller never
   * aborts (e.g. a genuinely hung `claude` binary).
   *
   * This is an IDLE window, not a total-turn cap: it measures silence on the
   * child's stdout, and every chunk the child writes re-arms it. A turn that
   * keeps streaming — a long tool-using agent run, an hour of `Bash` calls —
   * is by definition not wedged and must never be killed for taking a while.
   * (It used to be a total cap, which killed productive turns at five minutes
   * and reported them to the user as "timed out before producing a reply"
   * even though the reply was actively arriving.)
   *
   * Time the CONSUMER spends between yields doesn't count either — the window
   * re-arms when the consumer hands control back, so a slow reader can't kill
   * a healthy child.
   */
  readonly idleTimeoutMs?: number
  readonly maxStderrBytes?: number
}

export type ClaudeCliRawEvent =
  | { readonly kind: 'line'; readonly value: unknown }
  /** Terminal — always the last event yielded, exactly once. */
  | { readonly kind: 'exit'; readonly exitCode: number | null; readonly stderr: string; readonly timedOut: boolean }

/**
 * Ten minutes of TOTAL SILENCE. Sized for the longest legitimate gap between
 * two stdout writes, which is a single slow tool call: the CLI emits the
 * `tool_use` line, then says nothing until the tool returns — and an agent in
 * this repo can plausibly run `bun test` or a full `vite build` in there.
 * Anything past that is a binary that has genuinely stopped.
 *
 * Kept in sync with the user-facing message in `claudeCliExitErrorMessage`.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
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
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES

  let proc: SpawnedProcessLike
  try {
    proc = spawn(options.argv, {
      cwd: options.cwd,
      env: options.env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: options.stdin,
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
    killDescendants(proc)
  }

  const onAbort = (): void => kill()
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) kill()

  // Armed once here, then re-armed on every sign of life (see `armIdleTimer`
  // call sites below). `timer` is reassigned, so the `finally` clears whichever
  // one is currently in flight.
  let timer: ReturnType<typeof setTimeout> | undefined
  const pauseIdleTimer = (): void => {
    clearTimeout(timer)
    timer = undefined
  }
  const armIdleTimer = (): void => {
    pauseIdleTimer()
    if (killed) return
    timer = setTimeout(() => {
      timedOut = true
      kill()
    }, idleTimeoutMs)
  }
  armIdleTimer()

  // Drain stderr concurrently and independently of stdout — a full stderr
  // pipe buffer must never block the child from writing more stdout (the
  // same "drain both streams concurrently" discipline `captureSubprocess`
  // uses, just without waiting for exit before doing anything with stdout).
  const stderrPromise = pumpCapped(proc.stderr, maxStderrBytes)

  let drainedStdout = false
  try {
    // The clock runs only while we are WAITING ON THE CHILD:
    //   - `readLines` re-arms it on every stdout chunk — bytes from the child
    //     are proof of life even when they don't complete a parseable line;
    //   - it is paused across the `yield` and resumed when the consumer hands
    //     control back, so a slow reader can never look like a wedged child.
    for await (const event of readLines(proc.stdout, armIdleTimer)) {
      pauseIdleTimer()
      yield event
      armIdleTimer()
    }
    drainedStdout = true
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
    // The leak this closes: a generator abandoned before stdout ran dry — the
    // consumer `break`s out of the `for await`, throws, or is garbage-collected
    // — used to fall through here having cleared the timeout AND removed the
    // abort listener, leaving a live `claude` process with nothing left in the
    // world able to stop it. Observed in the wild: nine orphaned CLI processes
    // from a single turn, plus one holding the server's inherited listening
    // socket open, which kept port 3001 bound after the server died and made
    // every restart fail with EADDRINUSE.
    if (!drainedStdout) kill()
  }

  const [stderrResult, exitCode] = await Promise.all([stderrPromise, proc.exited])
  yield { kind: 'exit', exitCode, stderr: stderrResult.text, timedOut }
}

/**
 * Kill the child's own descendants.
 *
 * `proc.kill()` signals ONLY the direct child, and the `claude` CLI spawns its
 * own subagent processes — so killing the parent used to strand them. They then
 * hold every handle they inherited, including this server's listening socket.
 *
 * Best-effort and deliberately silent: the process may already be gone, and a
 * failure to reap a descendant must never turn into a turn-level error. Skipped
 * entirely when `pid` is absent, which is exactly the injected-fake case in
 * tests — no test ever shells out to a real process killer.
 *
 * **Windows only, and knowingly so.** This was diagnosed on Windows, where the
 * damage is worst: children inherit the server's listening socket, so one
 * stranded process keeps the port bound and blocks every restart. The POSIX
 * equivalent wants a process group (`detached` + `kill(-pgid)`) rather than a
 * `taskkill` translation, which is a different change to the spawn call itself
 * — not done here rather than half-done and untested on a platform this bug has
 * not been observed on.
 */
function killDescendants(proc: SpawnedProcessLike): void {
  const pid = proc.pid
  if (pid === undefined) return
  if (process.platform !== 'win32') return
  try {
    // /T = tree (the process and its descendants), /F = force.
    Bun.spawn(['taskkill', '/pid', String(pid), '/T', '/F'], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    })
  } catch {
    // Nothing to reap, or taskkill unavailable — the direct kill above stands.
  }
}

async function* readLines(
  stream: ReadableStream<Uint8Array> | null,
  /** Called on every chunk read off the pipe — the idle-timer re-arm hook. */
  onChunk: () => void = () => {},
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
      onChunk()
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
