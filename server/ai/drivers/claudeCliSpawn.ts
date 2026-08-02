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
  type CappedText,
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
  /**
   * Bounds the final drain — `stderr` + `proc.exited` — that runs once the
   * stdout loop has already ended (naturally or via `kill()`). That drain is
   * otherwise unbounded: `proc.kill()`/the POSIX process-group kill (see
   * `killDescendants`) are best-effort, and a grandchild that somehow escapes
   * the group still holds the write end of the `stderr` pipe open, so
   * `pumpCapped` never sees EOF and its promise never settles. This grace
   * period is what turns that into a completed turn instead of a generator
   * that never returns — the exact defect that permanently wedged a
   * conversation's stream lock (server chat handler never reaches its
   * `finally`) once the CLI's own subagent processes outlived it on macOS.
   * Test seam — production default is `DEFAULT_DRAIN_GRACE_MS`.
   */
  readonly drainGraceMs?: number
  /**
   * POSIX only — how long `killDescendants` waits after SIGTERM before
   * escalating to SIGKILL on the process group. See that function's doc
   * comment for why SIGTERM must go first (the CLI's own `--resume` session
   * transcript needs a chance to flush). Test seam — production default is
   * `DEFAULT_POSIX_KILL_GRACE_MS`.
   */
  readonly posixKillGraceMs?: number
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

/**
 * Five seconds. The final drain races `stderr` + `proc.exited` against this
 * once the stdout loop has already ended — by that point the process is
 * either exiting on its own (should settle near-instantly) or already killed
 * (see `drainGraceMs` doc on `ClaudeCliSpawnOptions`). Five seconds is ample
 * for a normal OS-level exit/pipe-close and still small next to the 10-minute
 * idle window, so it can never mask a turn that is genuinely still working.
 */
const DEFAULT_DRAIN_GRACE_MS = 5_000

/**
 * One second. `killDescendants` SIGTERMs the POSIX process group, then waits
 * this long before checking whether it's still alive and escalating to
 * SIGKILL only if so. A terminal Ctrl+C sends SIGINT, not SIGKILL, and
 * `claude` is written to handle a graceful stop by flushing its own
 * `--resume` session transcript before exiting — SIGKILL gives it none of
 * that chance, and a transcript truncated mid-write leaves the NEXT turn
 * resuming against a corrupt session (`shouldEstablishClaudeCliSession`
 * finds a file that exists but is broken) — the same class of
 * permanently-broken-conversation bug this whole change exists to fix, just
 * relocated from the stream lock to the CLI's own session file. One second
 * is ample for an fs write + exit, and stays comfortably inside
 * `DEFAULT_DRAIN_GRACE_MS` so the escalation can never make the overall
 * final drain (b) the effective ceiling.
 */
const DEFAULT_POSIX_KILL_GRACE_MS = 1_000

const defaultSpawn: SubprocessSpawnFn = (argv, options) =>
  Bun.spawn(argv, {
    ...options,
    // Detached so the child leads its own process group (POSIX `setsid()`) —
    // `killDescendants` signals the whole group with a negative pid, which is
    // the only reliable way to reach the CLI's own subagent grandchildren.
    // Meaningless on Windows (`taskkill /T` walks the process tree there
    // instead, by parent/child records, not process groups) and Bun's
    // Windows `detached` semantics are unrelated (`UV_PROCESS_DETACHED`), so
    // it's scoped to non-Windows only.
    ...(process.platform === 'win32' ? {} : { detached: true }),
  }) as unknown as SpawnedProcessLike

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
  const posixKillGraceMs = options.posixKillGraceMs ?? DEFAULT_POSIX_KILL_GRACE_MS

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
    killDescendants(proc, posixKillGraceMs)
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
  // `stderrSnapshot` tracks the running capture so the bounded final drain
  // below can report "whatever was captured" even if `stderrPromise` itself
  // never settles (a surviving grandchild holding the pipe open never yields
  // EOF, so `pumpCapped`'s own returned promise would otherwise hang forever).
  let stderrSnapshot: CappedText = { text: '', truncated: false }
  const stderrPromise = pumpCapped(proc.stderr, maxStderrBytes, (snapshot) => { stderrSnapshot = snapshot })

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

  // Bounded so a `stderr` pipe (or, in principle, `exited`) that never settles
  // — an unrelated process still holding a duplicated file descriptor open —
  // degrades to a completed turn instead of hanging this generator (and, one
  // level up, the chat handler's `finally` that releases the conversation's
  // stream lock) forever. Each half races the SAME deadline independently:
  // if only one is stuck, the other's real value is still reported rather
  // than throwing away information the process actually gave us.
  const graceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const graceExpired = new Promise<typeof DRAIN_TIMED_OUT>((resolve) => {
    graceTimer = setTimeout(() => resolve(DRAIN_TIMED_OUT), graceMs)
  })
  let stderrResult: CappedText
  let exitCode: number | null
  try {
    ;[stderrResult, exitCode] = await Promise.all([
      Promise.race([stderrPromise, graceExpired]).then((r) => (r === DRAIN_TIMED_OUT ? stderrSnapshot : r)),
      Promise.race([proc.exited, graceExpired]).then((r) => (r === DRAIN_TIMED_OUT ? null : r)),
    ])
  } finally {
    clearTimeout(graceTimer)
  }
  yield { kind: 'exit', exitCode, stderr: stderrResult.text, timedOut }
}

/** Sentinel resolved by the final drain's bounded grace period — never a value a real drain result could equal. */
const DRAIN_TIMED_OUT = Symbol('claude-cli-drain-timed-out')

/**
 * Kill the child's own descendants.
 *
 * `proc.kill()` signals ONLY the direct child, and the `claude` CLI spawns its
 * own subagent processes — so killing the parent used to strand them. They then
 * hold every handle they inherited, including this server's listening socket
 * on Windows, and the `stderr` pipe everywhere — which is what wedged a whole
 * conversation's stream lock on macOS (server-14's Windows fix didn't reach
 * POSIX; the ceiling of this generator's final drain is `drainGraceMs`/(b),
 * not this function).
 *
 * Best-effort and deliberately silent: the process may already be gone, and a
 * failure to reap a descendant must never turn into a turn-level error. Skipped
 * entirely when `pid` is absent, which is exactly the injected-fake case in
 * tests — no test ever shells out to a real process killer or signals a real
 * pid.
 *
 * Cross-platform, by two different mechanisms:
 * - **Windows:** `taskkill /pid <pid> /T /F` — walks the OS's own parent/child
 *   process-tree records. There is no process-group concept to lean on here,
 *   and no graceful-first step: `taskkill` has no "SIGTERM the tree" mode,
 *   only `/F`. Unchanged from server-14.
 * - **POSIX:** `defaultSpawn` starts the child `detached`, so it calls
 *   `setsid()` and becomes its own process-group leader — its pgid equals its
 *   own pid. Signalling the NEGATIVE pid reaches the whole group in one
 *   syscall, including every subagent grandchild, not just the direct child
 *   `proc.kill()` (called by the caller just before this) already signalled.
 *   ESCALATES rather than going straight to SIGKILL: SIGTERM the group
 *   first — the same signal family a terminal Ctrl+C (SIGINT) delivers, which
 *   `claude` is written to handle gracefully, flushing its own `--resume`
 *   session transcript before exiting. Only if the group is STILL ALIVE
 *   after `posixKillGraceMs` (probed with signal `0`, which delivers nothing
 *   and only reports whether the pid/group still exists) does SIGKILL
 *   follow. A transcript truncated mid-write by a graceless SIGKILL would
 *   leave the NEXT turn resuming against a corrupt session — the same class
 *   of permanently-broken-conversation bug this whole change exists to fix,
 *   just relocated.
 */
function killDescendants(proc: SpawnedProcessLike, posixKillGraceMs: number): void {
  const pid = proc.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
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
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Group already gone (process exited before we got here), or this
    // process lacks permission to signal it — best-effort and silent, same
    // as the Windows branch above. Nothing to escalate to.
    return
  }
  setTimeout(() => {
    try {
      // Signal 0 delivers nothing — it's the POSIX-standard "does this
      // pid/group still exist" probe, throwing (ESRCH) once it's gone.
      process.kill(-pid, 0)
    } catch {
      return // SIGTERM was enough — nothing left to escalate against.
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Exited between the probe and here, or a permission error — same
      // best-effort posture as every other branch in this function.
    }
  }, posixKillGraceMs)
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
