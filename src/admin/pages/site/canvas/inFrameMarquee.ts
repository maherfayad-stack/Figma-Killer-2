/**
 * inFrameMarquee — which layers an in-frame marquee selects (P5-E, IX-16,
 * OD-6). Pure; the gesture is `useInFrameMarquee`.
 *
 * Inside a frame every pixel belongs to some layer, so a drag is a move — the
 * marquee needs a place where a press means nothing else. OD-6: a press on
 * the frame's ROOT where no child is under the pointer (Penpot's "no shape
 * here" branch). ⌘-drag stays free move (the conflict register).
 *
 * The rule (Figma's, in tree terms): the layers whose boxes the marquee
 * touches, at the SHALLOWEST level below the root that has any hit — so a
 * sweep across three cards selects the cards, not their titles. ⌥ selects the
 * DEEPEST hits instead (Figma's ⌘-marquee). Hidden and locked layers are not
 * selectable by a sweep.
 */

export interface MarqueeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MarqueeCandidate {
  nodeId: string
  /** Depth below the root: its children are 1. */
  depth: number
  rect: MarqueeRect
}

export function rectsIntersect(a: MarqueeRect, b: MarqueeRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** The marquee between two points, never negative. */
export function marqueeBetween(a: { x: number; y: number }, b: { x: number; y: number }): MarqueeRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

/**
 * The ids the marquee selects: every hit at the shallowest hit depth, or with
 * `deepest` every hit that has no hit descendant. Candidate order is kept
 * (tree order, from the caller).
 */
export function marqueeHits(
  candidates: readonly MarqueeCandidate[],
  marquee: MarqueeRect,
  options: { deepest: boolean; isDescendant: (nodeId: string, ancestorId: string) => boolean },
): string[] {
  const hits = candidates.filter((candidate) => candidate.rect.width + candidate.rect.height > 0 && rectsIntersect(candidate.rect, marquee))
  if (hits.length === 0) return []
  if (options.deepest) {
    return hits
      .filter((hit) => !hits.some((other) => other !== hit && options.isDescendant(other.nodeId, hit.nodeId)))
      .map((hit) => hit.nodeId)
  }
  const shallowest = Math.min(...hits.map((hit) => hit.depth))
  return hits.filter((hit) => hit.depth === shallowest).map((hit) => hit.nodeId)
}
