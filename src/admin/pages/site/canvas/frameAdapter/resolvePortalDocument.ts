/**
 * The frame's `Document`, through the portal-mode escape hatch instead of a
 * direct `iframeElement.contentDocument`/`contentWindow` reach-in (`live-05`,
 * STATE.md).
 *
 * `null` for an iframe with no registered adapter yet (not booted / not a
 * canvas frame — callers already poll or bail, unchanged) OR one registered
 * in bridge mode — a real, cross-origin frame has no `Document` a portal
 * caller can read. Every caller of this helper is therefore portal-mode
 * ONLY; see each call site's own doc comment for what its bridge-mode gap is
 * (or isn't).
 *
 * Shared by every `canvas/` file that still needs a raw same-origin
 * `Document`/`Window` for something the curated `FrameDocumentAdapter`
 * interface doesn't (and shouldn't) cover — `canvasDomGeometry.ts`'s
 * drop-candidate enumeration, `CanvasTreeLadderOverlay.tsx`'s Alt-hover
 * inspect, `BreakpointSelectionOverlay.tsx`'s 60fps selection/hover RAF loop.
 */
import { listFrameAdapters } from './canvasFrameAdapterRegistry'
import { isPortalFrameAdapter } from './PortalFrameAdapter'

export function resolvePortalDocument(
  iframeElement: HTMLIFrameElement | null | undefined,
): Document | null {
  if (!iframeElement) return null
  const adapter = listFrameAdapters().get(iframeElement)
  if (!adapter || !isPortalFrameAdapter(adapter)) return null
  return adapter.getPortalWindow()?.document ?? null
}
