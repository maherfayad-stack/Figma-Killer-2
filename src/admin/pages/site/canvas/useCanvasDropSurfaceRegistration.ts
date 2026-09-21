/**
 * useCanvasDropSurfaceRegistration — D2 G3: publishes one breakpoint frame as
 * a place a drag from ANOTHER frame can land, for as long as it may.
 *
 * Registration is the viewport test: the overlay this is called from only
 * exists for a frame that is mounted, which `frameVirtualization.ts` (plus
 * the mount pool) already decided. There is deliberately no second on-screen
 * check here, and no store selector enumerating frames — a drag reads this
 * list on every animation frame, and a `useEditorStore` selector that
 * scanned the board would re-run on every unrelated store change.
 *
 * Gated on `enabled` (`canEditStructureHere`) so a read-only session, or a
 * frame whose breakpoint is not the active one, is never offered as a drop
 * target. The refs are read through a closure rather than captured, because
 * the drop layer is populated by React AFTER this effect runs on the first
 * commit and `iframeElement` is replaced wholesale on a frame reload.
 *
 * Split out of `BreakpointSelectionOverlay.tsx` when `live-13` pushed that
 * file past the 700-line ceiling.
 */
import { useEffect, type RefObject } from 'react'
import { registerCanvasDropSurface, unregisterCanvasDropSurface } from './canvasDropSurfaceRegistry'

export interface CanvasDropSurfaceRegistrationOptions {
  enabled: boolean
  frameId: string | null
  pageId: string | null
  viewportRef: RefObject<HTMLElement | null>
  iframeElement: HTMLIFrameElement | null
  dropLayerRef: RefObject<HTMLElement | null>
}

export function useCanvasDropSurfaceRegistration({
  enabled,
  frameId,
  pageId,
  viewportRef,
  iframeElement,
  dropLayerRef,
}: CanvasDropSurfaceRegistrationOptions): void {
  useEffect(() => {
    if (!enabled || !pageId) return
    const viewport = viewportRef.current
    if (!viewport) return
    const key = {}
    registerCanvasDropSurface(key, {
      frameId,
      pageId,
      viewport,
      iframe: iframeElement,
      dropLayer: () => dropLayerRef.current,
    })
    return () => unregisterCanvasDropSurface(key)
  }, [enabled, pageId, frameId, iframeElement, viewportRef, dropLayerRef])
}
