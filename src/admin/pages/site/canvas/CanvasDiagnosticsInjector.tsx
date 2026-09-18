/**
 * CanvasDiagnosticsInjector — collects what a canvas frame's RUNTIME says went
 * wrong, so an agent (and the panel behind `studio_page_diagnostics`) can read
 * it instead of inferring it from a picture.
 *
 * Why
 * ───
 * A frame whose component throws paints a blank rectangle. A screenshot of that
 * is indistinguishable from an empty screen, a collapsed layout, or a capture
 * taken too early — so the next move is another screenshot and a stylesheet
 * edit, against a page that never executed. Meanwhile the frame's own document
 * has already said exactly what happened, once, into a console nobody is
 * reading. This injector is the listener that was missing.
 *
 * Five sources, one buffer (`canvasDiagnosticsBuffer.ts`):
 *
 *   - `error` on the frame window, CAPTURE phase. One listener covers two
 *     genuinely different failures: an `ErrorEvent` (an exception escaped to
 *     `window.onerror`) and a bare `Event` whose target is an element (an
 *     `<img>`/`<script>`/`<link>` that failed to load). Resource errors do NOT
 *     bubble, which is precisely why the capture phase is mandatory here — a
 *     bubble-phase listener on `window` never sees them at all.
 *   - `unhandledrejection` — an async failure that never reaches `onerror`.
 *   - `console.error`, tapped and passed straight through. React reports a
 *     failed render, an invalid hook call, and a hydration mismatch through
 *     this channel and nowhere else; dropping it would miss the most common
 *     real defect in an imported project.
 *   - `fetch` from inside the frame, wrapped so a rejection or a 4xx/5xx is
 *     recorded. Only FAILURES are recorded — a successful request is not a
 *     diagnostic.
 *   - Module-resolution failures, which arrive as an ordinary exception whose
 *     message names the specifier. Classified apart from a plain runtime error
 *     (`module-resolution-failed`) because the fix is completely different: a
 *     missing dependency or a wrong path, not a bug in the component.
 *
 * What it does NOT cover, stated rather than implied: `XMLHttpRequest` is not
 * wrapped (nothing in the canvas path uses it, and patching two request APIs to
 * catch one class of failure is not worth the surface), and neither is a
 * `WebSocket`. A `<canvas>`/WebGL failure that never throws is invisible here,
 * as is anything the authored code catches and swallows itself.
 *
 * No DOM
 * ──────
 * This component renders `null` and inserts NOTHING into the frame — no
 * wrapper, no marker element, not even a `<style>`. The canvas DOM must stay
 * the DOM React renders (see `IframeFrameSurface`'s docblock); a diagnostics
 * probe is exactly the kind of "just one div" that breaks a `%` height chain
 * or an `:nth-child` selector in the user's own CSS.
 *
 * Scope
 * ─────
 * Every frame, both interaction modes. A live/preview frame's runtime errors
 * are as real as a design frame's, and collecting costs nothing until something
 * actually fails.
 *
 * Portal mode only, and now honestly so (`live-05`, STATE.md, Batch 5): a
 * bridge-mode (Tier 2) frame's runtime is cross-origin, so this component
 * cannot reach into it at all. That frame installs the SAME four taps on its
 * own side — `@core/studio-runtime`'s `runtime.ts`, Z5 — and posts what it
 * finds over the wire as the outbound `error` message, which
 * `useBridgeFrameDiagnostics` records into the same buffer this one writes to.
 * The classification predicates the two share (which tags are resources, which
 * messages mean a module did not resolve, how to render an arbitrary thrown
 * value as one line) live in `@core/studio-runtime`'s `runtimeErrorRules.ts` —
 * ONE implementation, exactly like hover suppression and scroll unroll, so a
 * live frame and a design frame cannot classify the same exception
 * differently.
 *
 * Known gap, stated rather than implied: the bridge half carries no `nodeId`
 * on a resource failure. `runtime.ts` speaks stamped ids, not canonical ones,
 * and the wire message deliberately carries no id at all — so a Tier-2
 * `asset-load-failed` answers with a URL where a Tier-0 one also answers with
 * a source position.
 */

import { useContext, useEffect } from 'react'
import {
  asErrorEventLike,
  describeErrorValue,
  errorStackOf,
  isElementTarget,
  isModuleResolutionMessage,
  requestUrlOf,
  resourceElementUrl,
  RESOURCE_ERROR_TAGS,
} from '@core/studio-runtime'
import {
  disposeFrameDiagnostics,
  ensureFrameDiagnostics,
  recordFrameDiagnostic,
} from './canvasDiagnosticsBuffer'
import { CanvasDiagnosticsScopeContext, CanvasFrameAdapterContext } from './CanvasContexts'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'

export function CanvasDiagnosticsInjector() {
  const adapter = useContext(CanvasFrameAdapterContext)
  const scopeKey = useContext(CanvasDiagnosticsScopeContext)

  useEffect(() => {
    if (!isPortalFrameAdapter(adapter)) return
    const view = adapter.getPortalWindow()
    if (!view) return
    ensureFrameDiagnostics(view, scopeKey ?? undefined)

    const onError = (event: Event) => recordErrorEvent(view, event)
    const onRejection = (event: Event) => recordRejectionEvent(view, event)

    // Capture phase is load-bearing for the resource half — see the docblock.
    view.addEventListener('error', onError, true)
    view.addEventListener('unhandledrejection', onRejection)
    const restoreConsole = patchConsoleError(view)
    const restoreFetch = patchFetch(view)

    return () => {
      view.removeEventListener('error', onError, true)
      view.removeEventListener('unhandledrejection', onRejection)
      restoreConsole?.()
      restoreFetch?.()
      disposeFrameDiagnostics(view)
    }
  }, [adapter, scopeKey])

  return null
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function recordErrorEvent(view: Window, event: Event): void {
  const target = event.target
  // A resource error's target is the failing ELEMENT and the event carries no
  // message. Checked first: an ErrorEvent's target is the window itself.
  if (target && target !== view && isElementTarget(target) && RESOURCE_ERROR_TAGS.has(target.tagName)) {
    const url = resourceElementUrl(target)
    const tagName = target.tagName.toLowerCase()
    // A module `<script>` that fails to load is a resolution failure, not a
    // missing picture — same code the thrown-specifier case uses, so both
    // shapes of the same problem read alike.
    const isModuleScript = target.tagName === 'SCRIPT' && target.getAttribute('type') === 'module'
    // The failing element's own node id, when it has one: a Studio node id is a
    // source position, so this is what turns "an image 404'd" into "line 42 of
    // Checkout.tsx points at a file that is not there".
    const nodeId = target.closest?.('[data-node-id]')?.getAttribute('data-node-id') ?? ''
    recordFrameDiagnostic(view, {
      kind: 'resource',
      code: isModuleScript
        ? 'module-resolution-failed'
        : 'asset-load-failed',
      message: url
        ? `<${tagName}> failed to load ${url}`
        : `<${tagName}> failed to load (no src/href attribute)`,
      ...(url ? { url } : {}),
      tagName,
      ...(nodeId ? { nodeId } : {}),
    })
    return
  }

  const errorEvent = asErrorEventLike(event)
  const message = errorEvent?.message || describeErrorValue(errorEvent?.error) || 'Uncaught error (no message reported).'
  recordFrameDiagnostic(view, {
    kind: 'uncaughtError',
    code: isModuleResolutionMessage(message)
      ? 'module-resolution-failed'
      : 'runtime-uncaught-error',
    message,
    ...(errorEvent?.filename ? { url: errorEvent.filename } : {}),
    ...(typeof errorEvent?.lineno === 'number' && errorEvent.lineno > 0 ? { line: errorEvent.lineno } : {}),
    ...(typeof errorEvent?.colno === 'number' && errorEvent.colno > 0 ? { column: errorEvent.colno } : {}),
    ...(errorStackOf(errorEvent?.error) ? { stack: errorStackOf(errorEvent?.error) } : {}),
  })
}

function recordRejectionEvent(view: Window, event: Event): void {
  const reason = (event as { reason?: unknown }).reason
  const message = describeErrorValue(reason) || 'Unhandled promise rejection (no reason reported).'
  recordFrameDiagnostic(view, {
    kind: 'unhandledRejection',
    code: isModuleResolutionMessage(message)
      ? 'module-resolution-failed'
      : 'runtime-unhandled-rejection',
    message,
    ...(errorStackOf(reason) ? { stack: errorStackOf(reason) } : {}),
  })
}

// ---------------------------------------------------------------------------
// Patches
//
// Both live in plain functions rather than inline in the effect, for the same
// reason `CanvasAnimationInjector.patchReducedMotionMatchMedia` does: a direct
// `view.x = …` assignment inside the component body reads to the React
// Compiler as mutating something reachable from `adapter`.
// Both restore the EXACT original reference on cleanup.
// ---------------------------------------------------------------------------

function patchConsoleError(view: Window & typeof globalThis): (() => void) | undefined {
  const console = view.console
  if (!console || typeof console.error !== 'function') return undefined
  const nativeError = console.error
  console.error = ((...args: unknown[]) => {
    try {
      recordFrameDiagnostic(view, {
        kind: 'consoleError',
        code: 'runtime-console-error',
        message: args.map(describeErrorValue).filter(Boolean).join(' ') || 'console.error called with no arguments.',
      })
    } catch (_err) {
      // Recording must never be able to break the frame's own logging — a
      // failure here would swallow the very message it exists to preserve.
    }
    // Pass through: the browser console stays the browser console.
    nativeError.apply(console, args as Parameters<typeof console.error>)
  }) as typeof console.error
  return () => {
    console.error = nativeError
  }
}

function patchFetch(view: Window): (() => void) | undefined {
  const nativeFetch = view.fetch
  if (typeof nativeFetch !== 'function') return undefined
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrlOf(input)
    try {
      const response = await nativeFetch.call(view, input as RequestInfo, init)
      if (!response.ok) {
        recordFrameDiagnostic(view, {
          kind: 'network',
          code: 'network-request-failed',
          message: `fetch ${url} responded ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
          url,
          status: response.status,
        })
      }
      return response
    } catch (err) {
      recordFrameDiagnostic(view, {
        kind: 'network',
        code: 'network-request-failed',
        message: `fetch ${url} failed: ${describeErrorValue(err) || 'network error'}`,
        url,
      })
      // Rethrown unchanged — observing a failure must not change how the
      // authored code experiences it.
      throw err
    }
  }
  view.fetch = wrapped as typeof view.fetch
  return () => {
    view.fetch = nativeFetch
  }
}
