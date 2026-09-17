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
 *
 * ## The parent's own rate bound (`sec-06`, `sec-10`)
 *
 * `ErrorMessageSchema` bounds the SIZE of each field and
 * `canvasDiagnosticsBuffer.ts` bounds the COUNT of distinct problems, both on
 * this side. The RATE was bounded only at the sender (`runtimeErrorTaps.ts`:
 * 10/second, 50 per document) — and the sender is exactly the thing a
 * same-realm script co-resident with `runtime.ts` replaces. Every accepted
 * record costs the trusted parent a `publishScope`: a copy-and-sort of up to
 * `MAX_DISTINCT_ENTRIES` entries plus a `useSyncExternalStore` notification,
 * for one cheap cross-process `postMessage`. A flood of forged REPEATS of a
 * single message rides that amplification indefinitely — a repeat bumps a
 * count and re-publishes rather than being dropped as a duplicate, so the
 * distinct-entry cap never engages.
 *
 * So {@link admitBridgeDiagnostic} caps the rate here too, independently of
 * anything the frame promises about itself.
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
 * Records per second this side will accept from one frame, deliberately well
 * ABOVE the honest sender's own 10/second.
 *
 * Matching the sender exactly would drop honest findings: the two windows are
 * started by different clocks, so a frame that legitimately posts its full 10
 * can straddle a receiver window and present 20 inside one of them. And the
 * sender's LIFETIME cap (50 per document) resets on every frame navigation
 * while this hook's budget does not — a cross-origin frame keeps one stable
 * `WindowProxy` across reloads — so a lifetime cap here would silently stop
 * reporting a frame the user had merely reloaded a few times. A pure rate cap
 * with 6x headroom is never reached by an honest frame, and still bounds a
 * forged flood to a fixed, small amount of parent work per second.
 */
export const MAX_BRIDGE_DIAGNOSTICS_PER_SECOND = 60
const BRIDGE_DIAGNOSTIC_WINDOW_MS = 1000

/**
 * A fixed-window rate gate, one per mounted frame. Answers `false` for anything
 * past the budget; the caller drops it without recording, which is the right
 * answer for traffic that by construction is either forged or a frame claiming
 * to have observed far more than it honestly could.
 *
 * `now` is injectable so the bound can be tested as the security property it is
 * rather than through a mounted component with a real clock.
 */
export function admitBridgeDiagnostic(now: () => number = Date.now): () => boolean {
  let windowStart = 0
  let inWindow = 0
  return () => {
    const at = now()
    if (at - windowStart >= BRIDGE_DIAGNOSTIC_WINDOW_MS) {
      windowStart = at
      inWindow = 0
    }
    if (inWindow >= MAX_BRIDGE_DIAGNOSTICS_PER_SECOND) return false
    inWindow += 1
    return true
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
    const admit = admitBridgeDiagnostic()
    const unsubscribe = adapter.on('error', (event) => {
      // Before anything is classified, stored, or published — see "The parent's
      // own rate bound" in the module doc.
      if (!admit()) return
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
