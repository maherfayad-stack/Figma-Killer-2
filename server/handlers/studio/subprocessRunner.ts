/**
 * subprocessRunner — the one place a byte-capped, timeout-guarded subprocess
 * capture lives. `installDeps.ts` (WS-1.4, `bun install`/`pnpm install`/…)
 * and `styleCompile.ts` (WS-2.1/`sec-01`, running the workspace's own
 * Sass/PostCSS/Tailwind compiler) both need EXACTLY this shape: an argv
 * array (never a shell string — no caller-supplied value is ever
 * interpolated into a command string), a timeout that kills the child, and
 * stdout/stderr capture that cannot grow unbounded. Extracted here so the
 * mechanics — draining both streams concurrently so a full pipe buffer can't
 * wedge the exit syscall, racing a kill against the timeout, capping bytes —
 * exist in exactly one place. See `.claude/agents/security-guard.md`
 * "Subprocesses".
 *
 * `env` is a REQUIRED option on every entry point here — `Bun.spawn` silently
 * inherits the whole parent process's environment when `env` is omitted,
 * which is exactly the ambient-authority leak `sec-01` was opened to close
 * (a workspace's `postcss.config.js` or a package manager's child process
 * would otherwise see `STUDIO_SECRET_KEY`, `DATABASE_URL`, any AI provider
 * key). `minimalSubprocessEnv` builds an explicit, small allowlist instead —
 * callers add whatever else their specific child genuinely needs.
 */

const BASE_SUBPROCESS_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
] as const

/**
 * Builds an explicit, minimal subprocess env from the current process's own
 * `process.env` — never `process.env` forwarded wholesale. Always includes
 * the small, cross-platform set of vars a spawned `bun`/package-manager
 * process needs just to start up (locate itself on `PATH`, resolve a
 * home/temp dir on POSIX and on Windows). Callers add whatever else THEIR
 * specific child genuinely needs via `extraKeys` — e.g. `installDeps.ts`
 * needs `APPDATA`/`LOCALAPPDATA` for npm/yarn/pnpm's own cache/config
 * resolution; `styleCompile.ts`'s worker needs nothing beyond the base set,
 * because Sass/PostCSS do no OS-level work beyond reading the files this
 * hands them.
 *
 * `overrides` merges in explicit key/value pairs the caller computed itself
 * (NOT read from this process's own env) — e.g. `server/ai/drivers/claudeCli.ts`
 * sets `CLAUDE_CONFIG_DIR` to a per-user directory it resolved, and optionally
 * `CLAUDE_CODE_OAUTH_TOKEN` to a decrypted per-user credential. Those values
 * don't exist in Studio's own `process.env`, so `extraKeys` (a pass-through
 * allowlist) can't carry them — `overrides` is the deliberate second
 * mechanism, applied last so it always wins over anything in the base set.
 */
export function minimalSubprocessEnv(
  extraKeys: readonly string[] = [],
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...BASE_SUBPROCESS_ENV_KEYS, ...extraKeys]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...overrides }
}

/** The minimal shape `captureSubprocess`/`runCappedSubprocess` need from a spawned child — real `Bun.spawn` output already satisfies it. `pid` is optional and purely informational (e.g. `installDeps.ts` records it for forensic display in an `'interrupted'` job's warning text) — nothing here ever probes OS process liveness by it. */
export interface SpawnedProcessLike {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  readonly pid?: number
  kill(): void
}

/**
 * `stdin` is `'ignore'` for every caller that has nothing to send, and a byte
 * payload for the one that does: `claudeCli.ts` writes the user's prompt here
 * rather than passing it as an argv positional. That is a correctness
 * requirement on Windows, not a preference — see `spawnClaudeCliNdjson`.
 */
export type SubprocessSpawnFn = (
  argv: string[],
  options: {
    cwd: string
    env: Record<string, string>
    stdout: 'pipe'
    stderr: 'pipe'
    stdin: 'ignore' | Uint8Array
  },
) => SpawnedProcessLike

const defaultSpawn: SubprocessSpawnFn = (argv, options) =>
  Bun.spawn(argv, options) as unknown as SpawnedProcessLike

export interface CappedSubprocessResult {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  exitCode: number | null
  timedOut: boolean
}

interface CaptureOptions {
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  /** Test seam — inject to assert/trigger the timeout deterministically, without a real wait. */
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export interface CappedText {
  text: string
  truncated: boolean
}

/**
 * Reads a stream to completion, keeping only the first `maxBytes` — draining
 * the rest so a chatty child never blocks on a full pipe buffer, but
 * discarding anything past the cap. Exported so callers that need their own
 * read loop over stdout (e.g. `claudeCliSpawn.ts`'s incremental NDJSON line
 * reader, which can't wait for process exit like `captureSubprocess` does)
 * can still cap-and-drain stderr with this exact, tested primitive instead of
 * duplicating it.
 */
export async function pumpCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<CappedText> {
  if (!stream) return { text: '', truncated: false }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || truncated) continue
      const chunk = decoder.decode(value, { stream: true })
      const currentBytes = Buffer.byteLength(text, 'utf8')
      const incomingBytes = Buffer.byteLength(chunk, 'utf8')
      if (currentBytes + incomingBytes <= maxBytes) {
        text += chunk
        continue
      }
      const remaining = Math.max(0, maxBytes - currentBytes)
      if (remaining > 0) text += Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8')
      text += '\n…[output truncated — exceeded the cap]'
      truncated = true
    }
  } finally {
    reader.releaseLock()
  }
  return { text, truncated }
}

/**
 * Races an already-spawned process against a timeout (killing it on expiry)
 * while draining stdout/stderr concurrently, each capped independently. Does
 * NOT spawn — callers that already own the spawn step (e.g. `installDeps.ts`,
 * which spawns synchronously before returning a job id) call this directly
 * with the live `proc`. Callers that don't care about that distinction use
 * `runCappedSubprocess` below.
 */
export async function captureSubprocess(proc: SpawnedProcessLike, options: CaptureOptions): Promise<CappedSubprocessResult> {
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout

  let timedOut = false
  const timer = setTimeoutImpl(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      // already exited — nothing to kill
    }
  }, options.timeoutMs)

  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    pumpCapped(proc.stdout, options.maxStdoutBytes),
    pumpCapped(proc.stderr, options.maxStderrBytes),
    proc.exited,
  ])
  clearTimeoutImpl(timer)

  return {
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
    exitCode,
    timedOut,
  }
}

export interface RunCappedSubprocessOptions extends CaptureOptions {
  cwd: string
  env: Record<string, string>
  /** Test seam — defaults to `Bun.spawn`. */
  spawn?: SubprocessSpawnFn
}

/** Spawn + `captureSubprocess`, composed — for callers that don't need the spawn step split out. `argv[0]` is executed directly, never through a shell; no caller-supplied value may be interpolated into a command string before reaching this function. */
export async function runCappedSubprocess(argv: string[], options: RunCappedSubprocessOptions): Promise<CappedSubprocessResult> {
  const spawn = options.spawn ?? defaultSpawn
  const proc = spawn(argv, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  return captureSubprocess(proc, options)
}
