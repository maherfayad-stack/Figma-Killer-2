/**
 * The chat turn's lifecycle guards — split out of `handlers/chat.ts` (which owns the
 * request and the stream) so the handler stays under the module-size ceiling.
 * Outside `handlers/` because nothing here touches a `Request`
 * (`ai-handlers-capability-gated.test.ts`).
 */

export const REQUEST_ABORTED = Symbol('request-aborted')

/**
 * Guarantees that `release` runs the moment `signal` aborts, independently of
 * whatever ALSO calls `release` on the "natural" path (the stream handler's
 * own `finally`), which may be blocked awaiting a driver that never settles.
 *
 * **Immediate, deliberately — there is no grace period.** This originally
 * waited 15s, on the reasoning that releasing the lock while the old turn
 * might still write would permit exactly the interleaved assistant/tool rows
 * `acquireConversationStream` exists to prevent. That reasoning was correct
 * at the time and is now obsolete: `release` here is `abandonTurn`, which
 * aborts `turnDeath` BEFORE releasing, and `runChat` checks that signal
 * before every remaining write. Releasing is therefore safe by construction
 * rather than by hope, and once it is safe, delay buys nothing and costs the
 * user everything.
 *
 * What the delay cost: pressing Stop and immediately sending another message
 * returned 409 "This conversation is already generating a response" for up to
 * 15 seconds — plus the driver's own teardown (a bounded stderr drain and the
 * SIGTERM→SIGKILL escalation, several more seconds). Stop means stopped. A
 * user who has just stopped a turn is telling us the turn is over; making
 * them wait to be believed is the bug, not the safety.
 *
 * The subprocess teardown still proceeds in the background on its own
 * schedule — it simply no longer holds the conversation hostage while it
 * finishes.
 *
 * Returns `dispose()`, which the natural path calls once it settles, so the
 * listener is not left attached to a long-lived signal. Exported for its own
 * focused unit test — standing up the full HTTP handler to prove this is
 * unnecessary weight.
 */
export function armAbortedReleaseGuard(
  signal: AbortSignal,
  release: () => void,
): () => void {
  const onAbort = (): void => release()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  return () => {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * The action performed once `armAbortedReleaseGuard`'s grace period expires:
 * mark the turn dead, THEN release the lock — in that exact order. Order is
 * the whole point: `runChat` (`server/ai/runtime/runner.ts`) checks
 * `turnDeath.signal` before every remaining persister write, so a new turn
 * must never be able to acquire the conversation lock (via `release`) before
 * this one has already been marked unable to write. Releasing first, even by
 * one microtask, would reopen exactly the interleaved-writes hazard
 * `acquireConversationStream` exists to prevent — a new turn writing while
 * this one might still be mid-write, "sound by construction" would just be
 * "usually fine."
 *
 * Exported for its own unit test — proving the ordering doesn't require
 * standing up the full HTTP handler.
 */
export function abandonTurn(turnDeath: AbortController, release: () => void): void {
  turnDeath.abort()
  release()
}

export function clientClosedRequest(): Response {
  return new Response(null, { status: 499, statusText: 'Client Closed Request' })
}

export function waitForRequest<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof REQUEST_ABORTED> {
  if (signal.aborted) return Promise.resolve(REQUEST_ABORTED)
  return new Promise<T | typeof REQUEST_ABORTED>((resolve, reject) => {
    const onAbort = () => resolve(REQUEST_ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
