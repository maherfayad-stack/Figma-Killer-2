/**
 * posterFillPlan — which frame the background fill photographs next (SB-5).
 *
 * The fill exists so a board's first zoom-out shows pictures, not blanks:
 * frames that were never live (the cap, a zoom below 0.35, scrolled past
 * before their picture was due) are mounted one at a time, in idle time, just
 * long enough to be photographed. Pure — the store, the poster store and the
 * viewport come in as arguments — so the ordering is unit-tested.
 */

export interface FillCandidate {
  frameId: string
  /** The poster key the frame renders under right now (`posterKey.ts`). */
  key: string
  /** Board-space centre of the frame. */
  centerX: number
  centerY: number
}

export interface FillContext {
  /** Board-space point the viewport is centred on. */
  viewCenter: { x: number; y: number }
  liveFrameIds: ReadonlySet<string>
  hasPoster: (key: string) => boolean
  /** Keys a capture was already tried for and did not produce a picture; never retried in this session. */
  failedKeys: ReadonlySet<string>
}

/**
 * The nearest frame to the viewport centre that has no picture, is not live
 * (a live frame photographs itself) and has not already failed; `null` when
 * the board is fully photographed.
 */
export function nextFillCandidate(candidates: readonly FillCandidate[], context: FillContext): FillCandidate | null {
  let best: FillCandidate | null = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    if (context.liveFrameIds.has(candidate.frameId) || context.failedKeys.has(candidate.key) || context.hasPoster(candidate.key)) continue
    const distance = Math.hypot(candidate.centerX - context.viewCenter.x, candidate.centerY - context.viewCenter.y)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}
