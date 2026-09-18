/**
 * How the dev-stack supervisors (`scripts/dev.ts`, `scripts/e2e-dev.ts`) spawn
 * their children, so that a child's liveness never depends on anyone reading
 * our output.
 *
 * ## The bug this exists for
 *
 * `bun run test:e2e` could not start its own stack on Windows. Playwright's
 * `webServer` spawns the command with `stdio: ['pipe','pipe','pipe']`
 * (`playwright-core`'s `launchProcess`), so `scripts/e2e-dev.ts` runs with
 * anonymous pipes where a console would be, and it handed those pipes straight
 * to Vite. Vite then, intermittently, **bound its port, printed nothing, and
 * answered nothing** — Playwright's readiness probe would connect (so the
 * listener existed) and then hang until the timeout, with the run showing only
 * the CMS's two startup lines. Started by hand in a terminal the same command
 * comes up in 2-5 s, which is why this read as flakiness for seven weeks
 * (`verify-01` finding 3, `STUDIO-FIGMA-FEEL-PLAN.md` §9).
 *
 * All three symptoms are one thing: **a process blocked writing to a pipe
 * nobody is draining stops running.** The banner never arrives because the
 * write is what blocked, and the request is never answered because the event
 * loop is inside that write.
 *
 * Measured 2026-09-18 on this Windows machine, `bun run e2e:dev` under a real
 * Playwright `webServer`, ten boots per configuration, ports asserted free
 * before each:
 *
 * | Children's stdout/stderr | boots that came up |
 * |---|---|
 * | inherited from our own pipes | 3 / 10 |
 * | `'pipe'` + forwarded by us   | 3 / 10 |
 * | `'ignore'`                   | 6 / 8  |
 * | **a FILE, tailed by us**     | **8 / 10** |
 *
 * (`scripts/e2e-dev.ts` closes the remaining gap by supervising the boot and
 * restarting a child that never answers. Read its header too.)
 *
 * ## The rule
 *
 * Inherit when we genuinely own a terminal — that keeps `bun run dev`
 * interactive, coloured, and byte-for-byte what it was. Otherwise give the
 * child a FILE and tail that file to our own stdout. A file write never blocks
 * on a reader, so the child cannot be stalled by our consumer, by Playwright's,
 * or by ours stalling on Playwright's. One rule, decided from one fact
 * (`isTTY`), applied to every child of both supervisors — so `bun run dev >
 * dev.log` cannot reproduce the same hang either.
 */
import { closeSync, openSync } from 'node:fs'

/** How often the tail loop looks for new bytes in a child's log file. */
const TAIL_INTERVAL_MS = 200

/**
 * True when this process's own stdout AND stderr are a terminal. Both, not
 * either: a child inherits the pair, and `bun run dev 2> errors.log` hands it
 * one console and one pipe.
 */
export function ownsATerminal(): boolean {
  return process.stdout.isTTY === true && process.stderr.isTTY === true
}

/**
 * Echoes everything appended to `logPath` to our stdout until the returned
 * function is called. Deliberately a poll rather than a filesystem watcher:
 * this runs while the machine is starting two servers, and a missed change
 * event would silently swallow the stack's output for the rest of the run.
 */
function tailToStdout(logPath: string): () => void {
  let offset = 0
  const timer = setInterval(() => {
    void (async () => {
      const file = Bun.file(logPath)
      const size = file.size
      if (size <= offset) return
      const chunk = await file.slice(offset, size).arrayBuffer()
      offset = size
      process.stdout.write(new Uint8Array(chunk))
    })()
  }, TAIL_INTERVAL_MS)
  return () => clearInterval(timer)
}

export interface StackChild {
  process: Bun.Subprocess
  /** Stops tailing this child's log. A no-op when the child inherited a terminal. */
  stopTail: () => void
}

/** Empties a child log, so one RUN's evidence never runs into the previous run's. */
export function truncateChildLog(logPath: string): void {
  closeSync(openSync(logPath, 'w'))
}

/** Creates `logPath` if it does not exist, without disturbing what is in it. */
function ensureLogExists(logPath: string): void {
  closeSync(openSync(logPath, 'a'))
}

/**
 * Spawn one half of the dev stack, relaying its output to ours.
 *
 * `logPath` is where the child's stdout and stderr go when we do not own a
 * terminal; callers empty it once per run with {@link truncateChildLog}.
 * `stdin` is always inherited — neither child reads it, and inheriting keeps a
 * terminal's Ctrl+C behaviour unchanged.
 */
export function spawnStackChild(
  command: string[],
  env: Record<string, string | undefined>,
  logPath: string,
): StackChild {
  if (ownsATerminal()) {
    return {
      process: Bun.spawn(command, {
        env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
      stopTail: () => {},
    }
  }

  // Opened for APPEND only to guarantee the file exists for the tail below.
  // Never truncated here: callers give each restart attempt its own path and
  // empty them once per run, and truncating a file a dying child still holds
  // open fails outright on Windows.
  ensureLogExists(logPath)
  const child = Bun.spawn(command, {
    env,
    stdin: 'inherit',
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  })
  return { process: child, stopTail: tailToStdout(logPath) }
}

/**
 * A supervisor's own narration — "I killed that child and am starting another".
 *
 * Straight to our stdout, and deliberately not into any child's log: these
 * lines are emitted at the moments a child is being killed or the process is
 * about to exit, and both alternatives lose them. Routing them through the
 * 200 ms tail poll loses the last one when we exit first; appending to a log
 * file a dying child still holds open throws on Windows, which would take the
 * supervisor down in the middle of explaining a failure.
 */
export function logSupervisor(message: string): void {
  process.stdout.write(`${message}\n`)
}
