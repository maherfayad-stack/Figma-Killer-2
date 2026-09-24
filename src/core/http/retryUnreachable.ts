/**
 * retryUnreachable — try a request again, quietly, when it got no answer.
 *
 * The failures this is for are the dev server restarting (`bun --watch`
 * restarts on a file change, often the very file the last write touched) and a
 * network blip. Neither is the user's doing, and a red toast for either is the
 * editor reporting its own weather. `apiRequest` already rides out the dev
 * proxy's empty 502/503/504 on its own short ladder; what it does NOT retry is
 * a request that got no response at all — `fetch` rejecting with a
 * `TypeError` — or a gateway status that outlived its ladder. This covers both.
 *
 * A response the server DID construct — a refusal, a 4xx, a 500 envelope — is
 * an answer, never retried: the same request would get the same answer.
 *
 * Safe only where running the request twice is harmless: a read, or a write
 * the server makes idempotent (a PUT of a whole document, a route in
 * `apiClient.ts`'s `IDEMPOTENT_REPLAY_PATHS` called with one idempotency key
 * across attempts). "No response" does not mean "not done" — a handler can
 * finish and die before it answers. Callers own that judgement; the ladder
 * only decides WHEN to try again.
 */
import { ApiError, isAbortError } from './apiClient'

/** Waits before retry 1, 2 and 3; the length is the budget. */
export const UNREACHABLE_RETRY_BACKOFF_MS = [1000, 2000, 4000] as const

const GATEWAY_STATUSES = new Set([502, 503, 504])

/** Whether `err` means the request never got an answer from the server — the only failure worth trying again. */
export function isUnreachableFailure(err: unknown): boolean {
  if (isAbortError(err)) return false
  if (err instanceof ApiError) return GATEWAY_STATUSES.has(err.status)
  return err instanceof TypeError
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
let sleep = realSleep

/** Test seam: make every ladder's waits instant (or restore real ones with `null`). */
export function setUnreachableRetrySleepForTests(next: ((ms: number) => Promise<void>) | null): void {
  sleep = next ?? realSleep
}

export interface RetryWhileUnreachableOptions {
  /** Waits before each retry; the length is the budget. Defaults to {@link UNREACHABLE_RETRY_BACKOFF_MS}. */
  backoffMs?: readonly number[]
  /** Told before each wait — for a caller that shows "trying again" somewhere quiet (a status chip, a loading line). */
  onRetry?: (err: unknown, waitMs: number) => void
}

/**
 * `attempt()`, tried again on {@link isUnreachableFailure} after each wait in
 * `backoffMs`. Throws the last failure — or the first one that was an answer.
 * An attempt that throws an `AbortError` stops the ladder at once.
 */
export async function retryWhileUnreachable<T>(
  attempt: () => Promise<T>,
  options: RetryWhileUnreachableOptions = {},
): Promise<T> {
  const backoffMs = options.backoffMs ?? UNREACHABLE_RETRY_BACKOFF_MS
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt()
    } catch (err) {
      const wait = backoffMs[tries]
      if (wait === undefined || !isUnreachableFailure(err)) throw err
      console.warn(`[retryUnreachable] no answer from the server, retrying in ${wait}ms:`, err)
      options.onRetry?.(err, wait)
      await sleep(wait)
    }
  }
}
