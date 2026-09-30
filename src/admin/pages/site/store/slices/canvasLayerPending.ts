/**
 * canvasLayerPending — which loose layers have a write on the wire (P5-G).
 *
 * A create's placement exists a moment before its module does; a delete's
 * module a moment after its placement is gone. The heal in
 * `canvasLayerSlice.ts` reconciles placements with modules and must not "fix"
 * either of those, so a gesture marks its layers here until its write settles
 * or is taken back (`canvasLayerGestures.ts`). Module-scoped, not store state:
 * nothing renders from it, and a render must never wait on it.
 */
const pendingLayerIds = new Set<string>()

export function markCanvasLayerPending(layerId: string): void {
  pendingLayerIds.add(layerId)
}

export function clearCanvasLayerPending(layerId: string): void {
  pendingLayerIds.delete(layerId)
}

export function isCanvasLayerPending(layerId: string): boolean {
  return pendingLayerIds.has(layerId)
}
