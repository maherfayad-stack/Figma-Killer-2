/**
 * Cross-iframe pointer relay signal.
 *
 * Parent-document drags cannot receive native pointermove/up events once the
 * cursor enters a breakpoint iframe. `IframeFrameSurface` reads these flags
 * from the parent document and forwards iframe pointer events back to the
 * parent window while a canvas drag is active.
 */
export function markCanvasPointerRelay(pointerId: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.studioCanvasDragging = '1'
  document.documentElement.dataset.studioCanvasDraggingPointerId = String(pointerId)
}

export function clearCanvasPointerRelay(): void {
  if (typeof document === 'undefined') return
  delete document.documentElement.dataset.studioCanvasDragging
  delete document.documentElement.dataset.studioCanvasDraggingPointerId
}

export interface CanvasPointerRelay {
  pointerId: number
}

/**
 * Whether a canvas drag (`markCanvasPointerRelay`) is currently in flight on
 * `doc`, and which pointer started it — `null` when none is. Falls back to
 * pointer id `0` when the recorded id is missing or non-numeric, the same
 * fallback `useIframeEventForwarding.ts`'s own (now-equivalent) reader used
 * historically.
 *
 * The one implementation both the portal relay (`useIframeEventForwarding.ts`,
 * forwarding an in-flight PARENT drag's moves back out from inside an
 * iframe) and the bridge relay (`useBridgeFrameInteraction.ts`, `speed-06`,
 * replaying a bridge frame's own pointer messages onto the iframe element so
 * the same parent-doc `window` listeners see them) read — a second copy here
 * is exactly the kind of drift `standing-03` warns about.
 */
export function readCanvasPointerRelay(doc: Document): CanvasPointerRelay | null {
  if (doc.documentElement.dataset.studioCanvasDragging !== '1') return null
  const raw = doc.documentElement.dataset.studioCanvasDraggingPointerId
  const id = Number(raw ?? NaN)
  return { pointerId: Number.isFinite(id) ? id : 0 }
}
