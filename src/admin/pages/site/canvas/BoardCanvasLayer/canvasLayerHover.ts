/**
 * canvasLayerHover — which loose layer the pointer is over (P5-G), for the hover
 * ring. A tiny external store rather than editor-store state for the reason
 * `canvasHover.ts` gives for node hover (P2-I): the pointer crosses layers far
 * more often than anything else changes, and a store write per crossing would
 * re-run every selector on the board. It notifies only when the id changes.
 */
let hovered: string | null = null
const listeners = new Set<() => void>()

export function setHoveredCanvasLayer(id: string | null): void {
  if (hovered === id) return
  hovered = id
  for (const listener of listeners) listener()
}

export function getHoveredCanvasLayer(): string | null {
  return hovered
}

export function subscribeHoveredCanvasLayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
