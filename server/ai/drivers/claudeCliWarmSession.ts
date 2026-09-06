/**
 * One long-lived `claude` subprocess, serving many turns of ONE conversation.
 *
 * `claudeCliSpawn.ts` is the cold shape: spawn, write the prompt, read until
 * the process exits, done. That is the right shape for a one-shot — and it is
 * what this driver did for EVERY turn, which meant every turn paid a full
 * process start plus an `initialize` handshake with every MCP server attached
 * to it, before the model saw a single token. This module is the warm shape:
 * the process outlives the turn, stdin stays open, and turn N+1 costs a single
 * line of NDJSON.
 *
 * The wire protocol it speaks — and the spike that established it, including
 * the measured 956 ms → 3 ms first-line difference and the rule that malformed
 * stdin is fatal — is documented in `claudeCliStdinProtocol.ts`. Read that
 * first; this module is the process lifecycle around it.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns: the process, the persistent stdout line reader, the capped stderr
 * drain, one turn at a time, abort-by-interrupt, and death detection. It does
 * NOT own: which conversation gets which process, whether an existing process
 * may be reused, or when an idle one is killed — that is
 * `claudeCliSessionPool.ts`, a different reason to change. It also does not
 * own the MCP connector or the temp files the argv points at; the pool holds
 * those, because their lifetime is the SESSION's, not this object's.
 *
 * ## `ClaudeCliRawEvent`, on purpose
 *
 * `runTurn` yields the exact event type `spawnClaudeCliNdjson` yields, so the
 * consuming loop in `claudeCli.ts` is byte-for-byte the same for a warm turn
 * and a cold one. The warm path is not a parallel implementation of the
 * driver — it is a different way to obtain the same line stream.
 *
 * ## Death is a fallback, not an error
 *
 * If the process is dead (or dies before this turn has produced any output),
 * `runTurn` throws `ClaudeCliWarmSessionDeadError` and the caller silently
 * re-runs the turn down the cold path. The cold path therefore REMAINS in the
 * driver as the crash-recovery mechanism — that is its job now, not a legacy
 * shim kept out of caution. Once a turn HAS streamed output to the user, a
 * silent retry would duplicate text, so a death after that point yields the
 * same terminal `exit` event the cold path yields and surfaces the same honest
 * message.
 */

import {
  pumpCapped,
  type CappedText,
  type SpawnedProcessLike,
  type SubprocessSpawnFn,
} from '../../handlers/studio/subprocessRunner'
import { ClaudeCliSpawnError, type ClaudeCliRawEvent } from './claudeCliSpawn'
import { buildControlRequestLine, buildUserMessageLine, encodeStdinLine } from './claudeCliStdinProtocol'

/** A spawned process whose stdin stayed open — what `stdin: 'pipe'` returns, narrowed so the rest of this file can rely on it. */
type WarmSpawnedProcess = SpawnedProcessLike & { readonly stdin: NonNullable<SpawnedProcessLike['stdin']> }

/** Thrown by `runTurn` when the process cannot serve this turn AND nothing has been streamed yet — the caller's signal to fall back to a cold spawn. */
export class ClaudeCliWarmSessionDeadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeCliWarmSessionDeadError'
  }
}

export interface ClaudeCliWarmSessionOptions {
  readonly argv: string[]
  readonly cwd: string
  readonly env: Record<string, string>
  /** Test seam — defaults to `Bun.spawn` with a piped stdin. The SAME seam the cold path uses, so one injected fake covers both. */
  readonly spawn?: SubprocessSpawnFn
  /** Called once when the process exits for any reason. The pool evicts on this. */
  readonly onExit?: () => void
  /**
   * Silence on the child's stdout that ends a turn, in ms. Same meaning and
   * same default as the cold path's `idleTimeoutMs`: an IDLE window sized for
   * the longest legitimate gap between two writes (one slow tool call), never
   * a cap on how long a turn may take.
   */
  readonly idleTimeoutMs?: number
  /** How long an `interrupt` gets to produce its `result` line before the session is killed instead. */
  readonly interruptGraceMs?: number
  readonly maxStderrBytes?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

/**
 * Five seconds. The spike measured a real interrupt at ~1 ms from control
 * request to the terminating `result` line, so this is three orders of
 * magnitude of headroom — long enough that a busy process is never killed for
 * being slow to acknowledge, short enough that a genuinely wedged one does not
 * leave the user staring at a cancelled turn that will not end.
 */
const DEFAULT_INTERRUPT_GRACE_MS = 5_000

const defaultWarmSpawn: SubprocessSpawnFn = (argv, options) =>
  Bun.spawn(argv, {
    ...options,
    // Same reasoning as `claudeCliSpawn.ts`'s `defaultSpawn`: detached so the
    // child leads its own process group and `dispose()` can signal the whole
    // group, reaching the CLI's own subagent grandchildren. A warm session
    // outlives more turns than a cold one, so a stranded grandchild here would
    // be stranded for longer.
    ...(process.platform === 'win32' ? {} : { detached: true }),
  }) as unknown as WarmSpawnedProcess

export class ClaudeCliWarmSession {
  readonly startedAt = Date.now()
  private readonly proc: WarmSpawnedProcess
  private readonly idleTimeoutMs: number
  private readonly interruptGraceMs: number
  private readonly queue: unknown[] = []
  private waiters: (() => void)[] = []
  private exited = false
  private exitCode: number | null = null
  private stderrSnapshot: CappedText = { text: '', truncated: false }
  private turnInFlight = false
  private disposed = false
  private controlSeq = 0
  private turns = 0

  private constructor(proc: WarmSpawnedProcess, options: ClaudeCliWarmSessionOptions) {
    this.proc = proc
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.interruptGraceMs = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS

    void pumpCapped(proc.stderr, options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, (snapshot) => {
      this.stderrSnapshot = snapshot
    })
    void this.readStdout()
    void proc.exited.then((code) => {
      this.exitCode = code
      this.exited = true
      this.wake()
      options.onExit?.()
    })
  }

  /** Start the process. Throws `ClaudeCliSpawnError` when the binary itself cannot be started — the same error, with the same message, the cold path throws. */
  static start(options: ClaudeCliWarmSessionOptions): ClaudeCliWarmSession {
    const spawn = options.spawn ?? defaultWarmSpawn
    let proc: SpawnedProcessLike
    try {
      proc = spawn(options.argv, {
        cwd: options.cwd,
        env: options.env,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      })
    } catch (err) {
      throw new ClaudeCliSpawnError(
        `Could not start the Claude CLI ("${options.argv[0]}"). Is it installed and on PATH?`,
        { cause: err },
      )
    }
    if (!proc.stdin) {
      // `Bun.spawn` with `stdin: 'pipe'` always returns a writable stdin, so
      // in production this is unreachable. It is reachable from a test seam
      // that only models a one-shot process — and a warm session with nothing
      // to write to is useless, so say so instead of failing later on a turn.
      proc.kill()
      throw new ClaudeCliSpawnError('The Claude CLI process was started without a writable stdin.')
    }
    return new ClaudeCliWarmSession(proc as WarmSpawnedProcess, options)
  }

  get alive(): boolean {
    return !this.exited && !this.disposed
  }

  /** True while a turn is streaming. The pool refuses to hand out a busy session rather than interleaving two turns on one stdin. */
  get busy(): boolean {
    return this.turnInFlight
  }

  get turnsServed(): number {
    return this.turns
  }

  /**
   * Run one turn: write the user line, yield every stdout line until the
   * `result` that terminates it (§2 of the protocol doc), leave the process
   * running.
   *
   * Throws `ClaudeCliWarmSessionDeadError` — and only ever BEFORE yielding
   * anything — when the process is unusable, so the caller can fall back to a
   * cold spawn without the user seeing a duplicated or truncated reply.
   */
  async *runTurn(prompt: string, signal: AbortSignal): AsyncGenerator<ClaudeCliRawEvent, void, void> {
    if (!this.alive) throw new ClaudeCliWarmSessionDeadError('The warm Claude CLI session is no longer running.')
    if (this.turnInFlight) throw new ClaudeCliWarmSessionDeadError('The warm Claude CLI session is already serving a turn.')

    // Anything still queued belongs to a previous turn (a late
    // `control_response` from an interrupt is the realistic case) and must
    // never be read as this turn's output.
    this.queue.length = 0
    this.turnInFlight = true
    this.turns += 1

    let interruptSentAt: number | null = null
    const onAbort = (): void => {
      // Abort cancels the TURN, not the session — verified in the spike: the
      // running generation stops, a normal `result` line closes the turn, and
      // the next user message on the same stdin is answered normally.
      interruptSentAt = Date.now()
      this.sendControl({ subtype: 'interrupt' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()

    try {
      try {
        this.write(encodeStdinLine(buildUserMessageLine(prompt)))
      } catch (err) {
        // A write to a pipe whose reader has gone is the classic "the process
        // died between the pool handing it over and us using it" race.
        throw new ClaudeCliWarmSessionDeadError(
          `The warm Claude CLI session could not accept the turn: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      let yieldedAnything = false
      for (;;) {
        const deadline =
          interruptSentAt === null
            ? this.idleTimeoutMs
            : Math.max(0, this.interruptGraceMs - (Date.now() - interruptSentAt))
        const line = await this.nextLine(deadline)

        if (line === undefined) {
          // Either the process died, or it went silent for the whole window.
          // With nothing yielded yet this turn is recoverable by a cold retry;
          // once output has reached the user it is not, so it degrades to the
          // same terminal `exit` event the cold path produces.
          const timedOut = this.alive
          this.dispose()
          if (!yieldedAnything) {
            throw new ClaudeCliWarmSessionDeadError(
              timedOut
                ? 'The warm Claude CLI session stopped responding before the turn started.'
                : 'The warm Claude CLI session exited before the turn started.',
            )
          }
          yield { kind: 'exit', exitCode: this.exitCode, stderr: this.stderrSnapshot.text, timedOut }
          return
        }

        yieldedAnything = true
        yield { kind: 'line', value: line }
        if (isResultLine(line)) return
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.turnInFlight = false
    }
  }

  /** Kill the process and everything it spawned. Idempotent; safe from a `finally`. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.proc.stdin.end()
    } catch {
      // Already closed — the kill below is what actually matters.
    }
    try {
      this.proc.kill()
    } catch {
      // Already exited.
    }
    killProcessGroup(this.proc.pid)
    this.wake()
  }

  private sendControl(request: Parameters<typeof buildControlRequestLine>[1]): void {
    this.controlSeq += 1
    try {
      this.write(encodeStdinLine(buildControlRequestLine(`studio-${this.controlSeq}`, request)))
    } catch (err) {
      // The process is gone; the turn loop's own death detection handles it.
      console.error('[ai/claudeCli] failed to send a control request to the warm session:', err)
    }
  }

  private write(bytes: Uint8Array): void {
    this.proc.stdin.write(bytes)
    this.proc.stdin.flush?.()
  }

  private async readStdout(): Promise<void> {
    const stream = this.proc.stdout
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          if (!line.trim()) continue
          try {
            this.queue.push(JSON.parse(line))
          } catch {
            // Same posture as the cold reader: a stray non-JSON line on the
            // CLI's stdout is rare and not fatal, and the translator layer
            // must only ever see well-formed JSON.
          }
        }
        this.wake()
      }
    } catch {
      // The pipe broke — `proc.exited` is the authority on what that means.
    } finally {
      reader.releaseLock()
      this.wake()
    }
  }

  /** The next stdout line, or `undefined` when the process died or stayed silent for `timeoutMs`. */
  private async nextLine(timeoutMs: number): Promise<unknown | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.queue.length > 0) return this.queue.shift()
      if (this.exited || this.disposed) return undefined
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 250))
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  private wake(): void {
    const pending = this.waiters
    this.waiters = []
    for (const resolve of pending) resolve()
  }
}

function isResultLine(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'result'
}

/**
 * SIGTERM the child's whole process group, so the CLI's own subagent
 * grandchildren go with it.
 *
 * Simpler than `claudeCliSpawn.ts`'s `killDescendants` on purpose, and the
 * difference is deliberate: that one escalates to SIGKILL after a grace period
 * because a cold turn's generator must not return while a descendant still
 * holds the stderr pipe open. Nothing awaits a warm session's exit — disposal
 * is fire-and-forget and the pool has already unlinked the entry — so there is
 * no promise to protect from hanging, and SIGTERM alone (which lets the CLI
 * flush its own session transcript) is both sufficient and kinder.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      Bun.spawn(['taskkill', '/pid', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
    } catch {
      // Nothing to reap, or taskkill unavailable — the direct kill stands.
    }
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Group already gone, or no permission to signal it. Best-effort, silent.
  }
}
