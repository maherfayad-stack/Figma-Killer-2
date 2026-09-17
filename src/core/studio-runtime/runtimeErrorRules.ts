/**
 * runtimeErrorRules — the ONE implementation of "what did this frame's runtime
 * just say went wrong, in words", shared by both halves of the canvas exactly
 * like `hoverSuppressionRules`/`scrollUnrollRules`/`animationFreezeRules`/
 * `selectionChromeCss` already are:
 *
 *   - `src/admin/pages/site/canvas/CanvasDiagnosticsInjector.tsx` — portal mode
 *     (Tier 0/1), reading the frame's `Window` directly.
 *   - `src/core/studio-runtime/runtime.ts` — bridge mode (Tier 2), inside a
 *     cross-origin live frame, posting what it finds over the wire as
 *     `messages.ts`'s outbound `error` message (Z5).
 *
 * Before this module existed the portal injector carried these predicates
 * privately and bridge mode carried nothing at all, which is precisely why a
 * crash inside a Tier-2 live frame reached NOTHING in Studio (plan §7 defect 5).
 * Two copies of "is this message a module-resolution failure" would have meant a
 * live frame and a design frame classifying the same exception differently — so
 * there is one copy, here, and the classification is identical on both sides of
 * the iframe boundary.
 *
 * Everything here is a pure function over values a browser hands you. No DOM is
 * created, nothing is observed, nothing is posted — the two callers own their
 * own transport. It imports nothing, so it costs the runtime bundle
 * (`scripts/sync-studio-runtime.ts`) only its own bytes.
 *
 * ## Cross-realm safety
 *
 * Every check here duck-types rather than using `instanceof`. A canvas frame's
 * `ErrorEvent`/`Element` come from the IFRAME's realm, not the parent's, so
 * `event instanceof ErrorEvent` is `false` for a genuine error event in portal
 * mode. This is not a style preference: the portal injector was written this way
 * for that exact reason, and the bridge runtime runs inside a realm whose
 * globals a user's own code may well have replaced.
 */

/** Elements whose failed load is a missing ASSET rather than a script fault. Uppercase — `Element.tagName` is uppercase for HTML elements. */
export const RESOURCE_ERROR_TAGS: ReadonlySet<string> = new Set([
  'IMG',
  'SCRIPT',
  'LINK',
  'SOURCE',
  'VIDEO',
  'AUDIO',
  'TRACK',
  'IFRAME',
])

/**
 * Messages every major engine uses for a specifier that could not be resolved
 * or fetched. Matched case-insensitively against the exception text; a miss only
 * means the finding is reported as a plain runtime error, never that it is
 * dropped.
 */
const MODULE_RESOLUTION_PATTERNS: readonly RegExp[] = [
  /failed to resolve module specifier/i,
  /failed to fetch dynamically imported module/i,
  /error resolving module specifier/i,
  /cannot find module/i,
  /module not found/i,
  /does not provide an export named/i,
  /unable to resolve/i,
]

export function isModuleResolutionMessage(message: string): boolean {
  return MODULE_RESOLUTION_PATTERNS.some((pattern) => pattern.test(message))
}

/** Duck-typed `Element` narrowing — see "Cross-realm safety" in the module doc. */
export function isElementTarget(target: EventTarget): target is Element {
  return typeof (target as Element).tagName === 'string'
}

/** `ErrorEvent`-shaped or not, duck-typed on the fields the callers actually read. */
export function asErrorEventLike(event: Event): Partial<ErrorEvent> | null {
  const candidate = event as Partial<ErrorEvent>
  return typeof candidate.message === 'string' || candidate.error !== undefined ? candidate : null
}

/** The URL a failed resource element was pointing at, bounded so a data: URI cannot carry a megabyte into a diagnostic. */
export function resourceElementUrl(el: Element): string {
  const raw = el.getAttribute('src') ?? el.getAttribute('href') ?? el.getAttribute('srcset') ?? ''
  return raw.slice(0, 300)
}

/** The URL a `fetch()` call was made against, whatever shape its first argument took. */
export function requestUrlOf(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 300)
  const url = (input as { url?: unknown } | null | undefined)?.url
  if (typeof url === 'string') return url.slice(0, 300)
  return String(input).slice(0, 300)
}

/** The `stack` of an arbitrary thrown/rejected value, when it has one. */
export function errorStackOf(value: unknown): string | undefined {
  const stack = (value as { stack?: unknown } | null | undefined)?.stack
  return typeof stack === 'string' && stack.length > 0 ? stack : undefined
}

/**
 * A one-line, never-throwing rendering of an arbitrary console argument,
 * rejection reason, or thrown value. Never throws: this runs inside a
 * `console.error` tap, and a collector that can throw would swallow the very
 * message it exists to preserve.
 */
export function describeErrorValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const message = (value as { message?: unknown }).message
  if (typeof message === 'string') {
    const name = (value as { name?: unknown }).name
    return typeof name === 'string' && name.length > 0 ? `${name}: ${message}` : message
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch (_err) {
    // Circular structures and exotic proxies both land here; the type name is
    // still more useful than dropping the argument entirely.
    return `[${typeof value}]`
  }
}

/** Truncate loudly — a silently cut message reads as a different error than the one that happened. */
export function boundDiagnosticText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
