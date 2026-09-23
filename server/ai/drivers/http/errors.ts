/**
 * Shared error classification for the direct provider HTTP drivers.
 *
 * Direct REST gives us the HTTP status code, so we can classify auth/billing
 * failures precisely (401 → bad key, 402/429 → quota) and surface actionable
 * copy in the admin-only chat surface, rather than forwarding a raw stack
 * trace or a generic "something went wrong".
 */

/**
 * True when an error is the result of the request abort signal firing — a
 * cancelled chat or client disconnect. Drivers return cleanly on these
 * (no `error` event) so the UI doesn't flash a spurious failure.
 */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted'))
  )
}

/**
 * Classify a non-OK HTTP response into a user-facing message. `bodyText` is
 * the (already-read) response body; the provider's `{ error: { message } }`
 * envelope is preferred when present, otherwise a status-based fallback.
 */
export function classifyHttpError(
  providerLabel: string,
  status: number,
  bodyText: string,
): string {
  return classifyHttpFailure(providerLabel, status, bodyText).message
}

/**
 * What the tool loop may do about a failed request:
 *
 *   - `transient` — the provider was momentarily unable (rate limit, overload,
 *     a 5xx). The same request can succeed after a pause: retried with backoff
 *     (AI-8).
 *   - `replayOverflow` — the conversation is too big for the provider; one
 *     retry with historical images elided.
 *   - `unsupportedParameter` — a 400 naming the reasoning parameters
 *     (`thinking`, `effort`, `reasoning`): this model does not take the ones
 *     `effort` mapped to. Retried once without them (AI-11).
 *   - `generic` — nothing a retry changes.
 */
export interface ProviderHttpFailure {
  kind: 'replayOverflow' | 'transient' | 'unsupportedParameter' | 'generic'
  message: string
}

/** Statuses a pause can fix. 529 is Anthropic's "overloaded". */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529])

/** A 429 that is an exhausted balance rather than a rate limit — waiting does not refill it. */
function isQuotaExhausted(bodyText: string): boolean {
  return /insufficient_quota|billing|credit balance/i.test(bodyText)
}

/** Structured classification lets the tool loop retry only what a retry can fix. */
export function classifyHttpFailure(
  providerLabel: string,
  status: number,
  bodyText: string,
): ProviderHttpFailure {
  const detail = extractErrorMessage(bodyText)

  if (status === 401 || status === 403) {
    return {
      kind: 'generic',
      message: `${providerLabel} authentication failed. Check your API key in Settings → AI → Providers.`,
    }
  }
  if (status === 402 || (status === 429 && isQuotaExhausted(bodyText))) {
    return {
      kind: 'generic',
      message: `${providerLabel} quota or rate limit reached${detail ? `: ${detail}` : ''}. Check your account balance.`,
    }
  }
  if (status === 429) {
    return {
      kind: 'transient',
      message: `${providerLabel} rate limit reached${detail ? `: ${detail}` : ''}. Wait a moment and send the message again.`,
    }
  }
  if (status === 400 && namesReasoningParameter(bodyText)) {
    return {
      kind: 'unsupportedParameter',
      message: `${providerLabel} rejected the reasoning settings for this model${detail ? `: ${detail}` : ''}.`,
    }
  }
  if (requestExceedsProviderContext(status, bodyText, detail)) {
    return {
      kind: 'replayOverflow',
      message: `${providerLabel} could not accept this conversation because it exceeds the provider's request or context limit${detail ? `: ${detail}` : ''}. Your history is still saved; start a new conversation or choose a model with a larger context window.`,
    }
  }
  if (status >= 500 || TRANSIENT_STATUSES.has(status)) {
    return {
      kind: TRANSIENT_STATUSES.has(status) ? 'transient' : 'generic',
      message: `${providerLabel} service error (${status})${detail ? `: ${detail}` : ''}. Please try again.`,
    }
  }
  return {
    kind: 'generic',
    message: `${providerLabel} error (${status})${detail ? `: ${detail}` : ''}.`,
  }
}

/** A bad request whose complaint is about the reasoning parameters `effort` maps to. */
function namesReasoningParameter(bodyText: string): boolean {
  return /\b(?:thinking|budget_tokens|output_config|effort|reasoning(?:_effort)?)\b/i.test(bodyText)
}

function requestExceedsProviderContext(
  status: number,
  bodyText: string,
  detail: string | null,
): boolean {
  if (status === 413) return true
  if (status !== 400) return false
  const providerSignal = `${detail ?? ''} ${bodyText}`
  return /(?:context.{0,24}(?:length|limit|window|exceed)|maximum.{0,16}tokens|too[_ ]many[_ ]tokens|request[_ ].{0,16}(?:too[_ ]large|exceed)|input[_ ]too[_ ]long|too[_ ]many[_ ]images|image.{0,16}(?:count|limit|maximum))/i.test(providerSignal)
}

/**
 * Pull a short message out of a provider error body. Providers return
 * `{ error: { message } }` (Anthropic/OpenAI) or `{ error: "..." }`; anything
 * unparseable collapses to the raw text (capped) so we never lose the detail
 * entirely.
 */
function extractErrorMessage(bodyText: string): string | null {
  const trimmed = bodyText.trim()
  if (!trimmed) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error
      if (typeof err === 'string') return err
      if (err && typeof err === 'object' && 'message' in err) {
        const msg = (err as { message: unknown }).message
        if (typeof msg === 'string') return msg
      }
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return trimmed.slice(0, 200)
}
