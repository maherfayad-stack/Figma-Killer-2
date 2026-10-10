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
 * simply stops waiting and reports the timeout. A late result is discarded.
 */

export class DeadlineExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${Math.round(ms / 1000)}s.`)
    this.name = 'DeadlineExceededError'
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
