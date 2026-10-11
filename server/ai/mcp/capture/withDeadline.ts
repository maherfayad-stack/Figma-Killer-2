/**
 * withDeadline — settle a capture step in bounded time or say which one stalled.
 *
 * Every step of a capture that talks to something outside this process (the
 * Chromium launch, the open editor tab) can stall without ever rejecting. The
 * browser pool serialises captures behind one promise chain, so a single
 * stalled step blocks every capture queued after it — a share, a thumbnail —
 * with no error and no end. Each such step gets a deadline instead.
 *
 * The underlying work is not cancelled (it has no cancel handle); the caller
 * simply stops waiting and reports the timeout. A late result is discarded
 * UNLESS the work produced something that holds a resource - a launched browser
 * is a process - in which case the caller passes `onLateResult` and the value
 * that arrives after the deadline is handed to it to release. Without that, every
 * launch that finished one second too late stayed running forever: six orphaned
 * `chrome-headless-shell` processes on a loaded machine.
 */

export class DeadlineExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${Math.round(ms / 1000)}s.`)
    this.name = 'DeadlineExceededError'
  }
}

export interface DeadlineOptions<T> {
  /** Called with a value that resolved AFTER the deadline had already fired. Release whatever it holds. */
  onLateResult?: (value: T) => void | Promise<void>
}

export function withDeadline<T>(work: Promise<T>, ms: number, label: string, options: DeadlineOptions<T> = {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new DeadlineExceededError(label, ms))
    }, ms)
  })
  const { onLateResult } = options
  if (onLateResult) {
    work.then(
      (value) => {
        if (!expired) return
        void Promise.resolve(onLateResult(value)).catch((err: unknown) => {
          console.error('[withDeadline] releasing a late result failed:', err)
        })
      },
      () => {
        // A rejection is the race's to report (or, after the deadline, nobody's).
      },
    )
  }
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
