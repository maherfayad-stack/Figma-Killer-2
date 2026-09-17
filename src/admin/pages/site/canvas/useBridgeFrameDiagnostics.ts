/**
 * useBridgeFrameDiagnostics — the parent-side half of Z5: routes a Tier-2 live
 * frame's outbound `error` messages into `canvasDiagnosticsBuffer.ts`, the same
 * buffer `CanvasDiagnosticsInjector` fills for a portal frame.
 *
 * ## Why this is a hook and not another injector
 *
 * `CanvasDiagnosticsInjector` works by reaching INTO the frame's `Window` and
 * installing taps. A bridge frame is cross-origin: there is nothing to reach
 * into, the taps are already installed on the other side (`runtime.ts`), and
 * all that is left on this side is to record what arrives. That is a
 * subscription on an adapter, which is a hook.
 *
 * ## Keyed by the iframe's own `contentWindow`, deliberately
 *
 * `studio_page_diagnostics` (`agent/studioPageDiagnostics.ts`) finds a page's
 * board frame in the DOM and reads `iframe.contentWindow` — that is the key the
 * whole agent-facing read is built on, and it works for a cross-origin frame
 * too: the `WindowProxy` reference is obtainable from the parent even when
 * nothing on it is readable. Recording under the same key is what makes a
 * Tier-2 frame's findings visible to the agent with **no change to the tool at
 * all**. The alternative — a second, bridge-only registry — would have meant
 * `studio_page_diagnostics` reporting `no-collector` for exactly the frames
 * most likely to be broken.
 *
 * The iframe element comes from `canvasFrameAdapterRegistry` (every
 * `IframeFrameSurface` registers itself there under its own element, portal and
 * bridge alike) rather than from a ref this hook would have to be handed —
 * same lookup `useBridgeComputedValues.ts` already does, and it keeps this hook
 * mountable from anywhere that holds the adapter.
 *
 * ## Mapping the wire kind onto the frozen finding vocabulary
 *
 * One place, below. `@core/ai`'s `PageDiagnosticCode` is a frozen contract
 * shared with the MCP tool, so a Tier-2 finding has to land on exactly the code
 * a Tier-0 finding for the same failure would — `isModuleResolutionMessage`
 * (shared with the portal injector and with `runtime.ts` itself) is what makes
 * "the specifier did not resolve" read alike on both paths.
 */
import { useEffect } from 'react'
import { isModuleResolutionMessage, type RuntimeErrorKind } from '@core/studio-runtime'
import type { PageDiagnosticCode } from '@core/ai'
import {
  disposeFrameDiagnostics,
  ensureFrameDiagnostics,
  recordFrameDiagnostic,
  type CanvasDiagnosticKind,
} from './canvasDiagnosticsBuffer'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { isBridgeFrameAdapter } from './frameAdapter/BridgeFrameAdapter'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'

/** The `Window` an already-registered adapter's own iframe exposes, or `null` while the frame is not (yet) registered. */
function frameWindowFor(adapter: FrameDocumentAdapter): Window | null {
  for (const [iframe, registered] of listFrameAdapters()) {
    if (registered === adapter) return iframe.contentWindow
  }
  return null
}

/**
 * Wire kind -> (collector kind, finding code). A `module-resolution-failed` is
 * classified from the MESSAGE rather than from the kind, because every engine
 * reports it as an ordinary exception — the same rule the portal injector
 * applies, from the same shared predicate.
 */
function classify(kind: RuntimeErrorKind, message: string): { kind: CanvasDiagnosticKind; code: PageDiagnosticCode } {
  switch (kind) {
    case 'exception':
      return {
        kind: 'uncaughtError',
        code: isModuleResolutionMessage(message) ? 'module-resolution-failed' : 'runtime-uncaught-error',
      }
    case 'unhandledrejection':
      return {
        kind: 'unhandledRejection',
        code: isModuleResolutionMessage(message) ? 'module-resolution-failed' : 'runtime-unhandled-rejection',
      }
    case 'resource':
      return {
        kind: 'resource',
        code: isModuleResolutionMessage(message) ? 'module-resolution-failed' : 'asset-load-failed',
      }
    case 'console':
      return { kind: 'consoleError', code: 'runtime-console-error' }
    case 'network':
      return { kind: 'network', code: 'network-request-failed' }
  }
}

/**
 * @param adapter   the frame's adapter — ignored unless it is a bridge one
 *                  (a portal frame collects its own diagnostics from inside).
 * @param scopeKey  the UI subscription key this frame publishes under, so the
 *                  board frame's badge can watch it. See
 *                  `CanvasDiagnosticsScopeContext`.
 */
export function useBridgeFrameDiagnostics(adapter: FrameDocumentAdapter | null, scopeKey: string): void {
  useEffect(() => {
    if (!isBridgeFrameAdapter(adapter)) return
    const view = frameWindowFor(adapter)
    if (!view) return
    ensureFrameDiagnostics(view, scopeKey)
    const unsubscribe = adapter.on('error', (event) => {
      const { kind, code } = classify(event.kind, event.message)
      recordFrameDiagnostic(view, {
        kind,
        code,
        message: event.message,
        ...(event.source ? { url: event.source } : {}),
        ...(event.stack ? { stack: event.stack } : {}),
      })
    })
    return () => {
      unsubscribe()
      disposeFrameDiagnostics(view)
    }
  }, [adapter, scopeKey])
}
