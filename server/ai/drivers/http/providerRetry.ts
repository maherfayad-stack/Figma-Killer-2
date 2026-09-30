/**
 * providerRetry — how long the tool loop waits before re-sending a request
 * the provider was momentarily unable to serve (AI-8).
 *
 * A 429, a 5xx, Anthropic's 529 "overloaded", a dropped connection, or an
 * `overloaded_error` in the stream before the model said anything: each one
 * used to end the turn with a red banner, although the same request usually
 * succeeds a second later. The loop now retries those — bounded, with
 * exponential backoff, and honouring the provider's own `retry-after` — and
 * tells the panel it is retrying (a quiet status, not an error).
 *
 * Pure except for {@link providerRetryTiming}, the one seam tests replace so
 * a retry costs no wall-clock time.
 */

/** Re-sends after the first failure. Four requests in all, the last after ~7 s of waiting. */
export const MAX_TRANSIENT_RETRIES = 3

/** First backoff step; each later one doubles. */
const BASE_DELAY_MS = 1_000

/** A single wait never exceeds this, whatever the backoff says. */
const MAX_DELAY_MS = 20_000

/**
 * A provider asking for a longer pause than this is not describing a blip —
 * it is a quota window. Waiting it out inside a turn would look like a hang,
 * so the loop reports the failure instead.
 */
export const MAX_HONOURED_RETRY_AFTER_MS = 60_000

/**
 * The provider's requested pause, from `retry-after-ms` (OpenAI) or
 * `retry-after` (seconds or an HTTP date — Anthropic, most gateways). `null`
 * when it named none, or named something unreadable.
 */
export function retryAfterMs(headers: Headers, nowMs: number = Date.now()): number | null {
  const ms = headers.get('retry-after-ms')
  if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms))
  const value = headers.get('retry-after')
  if (value === null) return null
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1_000)
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs)
}

/**
 * The wait before retry number `attempt` (1-based): the provider's own
 * `retry-after` when it gave one, else 1 s, 2 s, 4 s. `null` means "do not
 * retry": the provider asked for longer than {@link MAX_HONOURED_RETRY_AFTER_MS}.
 */
export function transientRetryDelayMs(attempt: number, requestedMs: number | null): number | null {
  if (requestedMs !== null) {
    if (requestedMs > MAX_HONOURED_RETRY_AFTER_MS) return null
    return requestedMs
  }
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))
}

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** The loop's clock. Tests swap `sleep` so a retry is instant; nothing else writes it. */
export const providerRetryTiming: { sleep: (ms: number, signal: AbortSignal) => Promise<void> } = {
  sleep: abortableSleep,
}
