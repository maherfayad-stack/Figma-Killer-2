/**
 * runtimeErrorTaps — the in-frame half of Z5: the four listeners/patches that
 * notice a live frame's runtime failing, plus the two bounds on how much of
 * that reaches the parent.
 *
 * Its own module rather than another section of `runtime.ts` for the reason
 * `module-size-budgets.test.ts` exists to force: this is a self-contained
 * responsibility (observe failures, bound them, report them) with one input
 * (`view`) and one output (`report`), and `runtime.ts` is already the biggest
 * file in the folder. `runtime.ts` supplies a `report` that wraps each finding
 * in the outbound `error` message and posts it; nothing here knows about
 * postMessage, envelopes or origins.
 *
 * ## The four taps, and why each one is load-bearing
 *
 *   - `error`, CAPTURE phase. One listener covers two genuinely different
 *     failures: an `ErrorEvent` (an exception escaped to `window.onerror`) and
 *     a bare `Event` whose target is an element (an `<img>`/`<script>`/`<link>`
 *     that failed to load). Resource errors do NOT bubble, which is exactly
 *     why the capture phase is mandatory — a bubble-phase listener on `window`
 *     never sees them at all.
 *   - `unhandledrejection` — an async failure that never reaches `onerror`.
 *   - `console.error`, tapped and passed straight through. React reports a
 *     failed render, an invalid hook call and a hydration mismatch through
 *     this channel and nowhere else.
 *   - `fetch`, wrapped so a rejection or a 4xx/5xx is recorded. Only FAILURES
 *     are recorded, and both the response and the rejection are passed through
 *     unchanged: observing a failure must never change how the authored code
 *     experiences it.
 *
 * Exactly the set `CanvasDiagnosticsInjector.tsx` installs for a portal frame,
 * with the classification predicates shared verbatim (`runtimeErrorRules.ts`).
 *
 * ## The two bounds, and why they are HERE and not only on the parent
 *
 *   - {@link MAX_ERROR_POSTS_PER_SECOND} — a React render loop emits the
 *     identical error hundreds of times a second. The parent aggregates by
 *     identity so nothing is lost by dropping the extras, but the postMessage
 *     traffic itself is not free and this is the only side that can refuse to
 *     make it.
 *   - {@link MAX_ERROR_POSTS} — a lifetime budget per document. Deliberately
 *     the FIRST 50 reports, not a ring of the last 50: the first error is
 *     almost always the cause and the rest are its consequences, so a ring
 *     would evict the one worth reading.
 *
 * ## Nothing here may throw into the user's own code
 *
 * `report` is called from inside a patched `console.error` and a patched
 * `fetch`. Every value goes through `describeErrorValue`, which never throws,
 * and the console tap additionally wraps its own call in a `try` — a collector
 * that can throw would swallow the very message it exists to preserve.
 */
import {
  RUNTIME_ERROR_MESSAGE_MAX,
  RUNTIME_ERROR_SOURCE_MAX,
  RUNTIME_ERROR_STACK_MAX,
  type RuntimeErrorKind,
} from './messages'
import {
  asErrorEventLike,
  boundDiagnosticText,
  describeErrorValue,
  errorStackOf,
  isElementTarget,
  requestUrlOf,
  resourceElementUrl,
  RESOURCE_ERROR_TAGS,
} from './runtimeErrorRules'

export const MAX_ERROR_POSTS = 50
export const MAX_ERROR_POSTS_PER_SECOND = 10
const ERROR_RATE_WINDOW_MS = 1000

/** One finding, already bounded to the wire schema's own `maxLength`s. */
export interface RuntimeErrorReport {
  kind: RuntimeErrorKind
  message: string
  stack?: string
  source?: string
}

/**
 * Installs all four taps on `view` and returns a disposer that removes the two
 * listeners and restores the EXACT original `console.error`/`fetch`
 * references — a frame whose bridge was torn down must be left with the
 * console and the fetch it started with.
 */
export function startRuntimeErrorTaps(
  view: Window & typeof globalThis,
  report: (finding: RuntimeErrorReport) => void,
): () => void {
  let postsTotal = 0
  let windowStart = 0
  let postsInWindow = 0

  function send(kind: RuntimeErrorKind, message: string, stack?: string, source?: string): void {
    if (postsTotal >= MAX_ERROR_POSTS) return
    const now = Date.now()
    if (now - windowStart >= ERROR_RATE_WINDOW_MS) {
      windowStart = now
      postsInWindow = 0
    }
    if (postsInWindow >= MAX_ERROR_POSTS_PER_SECOND) return
    postsInWindow += 1
    postsTotal += 1
    report({
      kind,
      message: boundDiagnosticText(message, RUNTIME_ERROR_MESSAGE_MAX),
      ...(stack ? { stack: boundDiagnosticText(stack, RUNTIME_ERROR_STACK_MAX) } : {}),
      ...(source ? { source: boundDiagnosticText(source, RUNTIME_ERROR_SOURCE_MAX) } : {}),
    })
  }

  function onError(ev: Event): void {
    const target = ev.target
    // A resource error's target is the failing ELEMENT and the event carries no
    // message. Checked first: an ErrorEvent's target is the window itself.
    if (target && target !== view && isElementTarget(target) && RESOURCE_ERROR_TAGS.has(target.tagName)) {
      const url = resourceElementUrl(target)
      const tagName = target.tagName.toLowerCase()
      send(
        'resource',
        url ? `<${tagName}> failed to load ${url}` : `<${tagName}> failed to load (no src/href attribute)`,
        undefined,
        url || undefined,
      )
      return
    }
    const errorEvent = asErrorEventLike(ev)
    const message = errorEvent?.message || describeErrorValue(errorEvent?.error) || 'Uncaught error (no message reported).'
    const line = typeof errorEvent?.lineno === 'number' && errorEvent.lineno > 0 ? `:${errorEvent.lineno}` : ''
    const column = typeof errorEvent?.colno === 'number' && errorEvent.colno > 0 ? `:${errorEvent.colno}` : ''
    send(
      'exception',
      message,
      errorStackOf(errorEvent?.error),
      errorEvent?.filename ? `${errorEvent.filename}${line}${column}` : undefined,
    )
  }
  view.addEventListener('error', onError, true)

  function onRejection(ev: Event): void {
    const reason = (ev as { reason?: unknown }).reason
    send(
      'unhandledrejection',
      describeErrorValue(reason) || 'Unhandled promise rejection (no reason reported).',
      errorStackOf(reason),
    )
  }
  view.addEventListener('unhandledrejection', onRejection)

  const frameConsole = view.console
  const nativeConsoleError = typeof frameConsole?.error === 'function' ? frameConsole.error : null
  if (nativeConsoleError) {
    frameConsole.error = ((...args: unknown[]) => {
      try {
        send('console', args.map(describeErrorValue).filter(Boolean).join(' ') || 'console.error called with no arguments.')
      } catch (_err) {
        // See "Nothing here may throw into the user's own code" above.
      }
      nativeConsoleError.apply(frameConsole, args as Parameters<Console['error']>)
    }) as Console['error']
  }

  const nativeFetch = typeof view.fetch === 'function' ? view.fetch : null
  if (nativeFetch) {
    view.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrlOf(input)
      try {
        const response = await nativeFetch.call(view, input as RequestInfo, init)
        if (!response.ok) {
          send(
            'network',
            `fetch ${url} responded ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
            undefined,
            url,
          )
        }
        return response
      } catch (err) {
        send('network', `fetch ${url} failed: ${describeErrorValue(err) || 'network error'}`, errorStackOf(err), url)
        throw err
      }
    }) as typeof view.fetch
  }

  return () => {
    view.removeEventListener('error', onError, true)
    view.removeEventListener('unhandledrejection', onRejection)
    if (nativeConsoleError) frameConsole.error = nativeConsoleError
    if (nativeFetch) view.fetch = nativeFetch
  }
}
