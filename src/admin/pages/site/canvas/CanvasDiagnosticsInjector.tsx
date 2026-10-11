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
import { describeErrorValue, requestUrlOf } from '@core/studio-runtime'
import {
  disposeFrameDiagnostics,
  ensureFrameDiagnostics,
  recordFrameDiagnostic,
} from './canvasDiagnosticsBuffer'
import { CanvasDiagnosticsScopeContext, CanvasFrameAdapterContext } from './CanvasContexts'
import { recordErrorEvent, recordRejectionEvent } from './runtimeErrorRecording'
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
