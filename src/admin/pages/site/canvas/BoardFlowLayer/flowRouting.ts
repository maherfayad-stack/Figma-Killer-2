/**
 * flowRouting — turning the DERIVED flows plus a board's frames into the lines
 * to draw.
 *
 * Authored links are not routed here. They are anchored to the ELEMENT the user
 * drew them on and are drawn by `BoardPrototypeLayer`, which also owns the
 * gesture that creates them; this module is frame-to-frame, which is the right
 * granularity for a claim about the repository rather than about one button.
 * See `BoardPrototypeLayer`'s docblock for the split.
 *
 * Two decisions live here, and they are both about not drawing N lines where
 * the user has one thought:
 *
 * ONE LINE PER FRAME PAIR, NOT PER FLOW
 * ─────────────────────────────────────
 * Three buttons on Home that all reach Details is one flow. Drawing three
 * curves between the same two frames would stack them exactly on top of each
 * other — the same pair of frames has the same geometry — so the second and
 * third are literally invisible while still costing three DOM subtrees. The
 * count on the chip carries what the extra curves would have.
 *
 * NEAREST TARGET FRAME, NOT EVERY TARGET FRAME
 * ────────────────────────────────────────────
 * A page can appear on the board more than once (WS-10's "duplicate as
 * variant": two `BoardFrame`s, one `pageId`, different preview axes). A flow
 * belongs to the PAGE, so it is equally true of every variant, and connecting
 * all of them would draw S × T lines for one fact. Each source frame connects
 * to the nearest frame of the target page instead: every variant still shows
 * its outgoing flow, and the line goes to the copy the user is most likely
 * looking at.
 * */
import type { BoardFrame } from '@core/studio-board'
import { FRAME_HEIGHT, FRAME_WIDTH } from '@core/studio-board'
import { groupCodeFlowByPagePair, type CodeFlowEdge } from '@core/studio-prototype'
import { flowConnector, type FlowConnector, type FlowRect } from './flowGeometry'

/** One row of a line's tooltip: what the flow is, and where that came from. */
export interface FlowDetail {
  key: string
  primary: string
  secondary: string
}

/** A drawn connector, with everything the layer needs to render and justify it. */
export interface FlowLine {
  /** Stable across re-derives: the two frames it runs between. */
  key: string
  connector: FlowConnector
  /** The chip's text: short enough to read at a glance over a frame. */
  chip: string
  details: FlowDetail[]
}

/** A frame's board box, with `width`/`height` defaulted the same way the renderer defaults them. */
function frameRect(frame: BoardFrame): FlowRect {
  return {
    x: frame.x,
    y: frame.y,
    w: frame.width ?? FRAME_WIDTH,
    h: frame.height ?? FRAME_HEIGHT,
  }
}

function centerDistance(a: FlowRect, b: FlowRect): number {
  return Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2))
}

function framesByPage(frames: readonly BoardFrame[]): Map<string, BoardFrame[]> {
  const byPage = new Map<string, BoardFrame[]>()
  for (const frame of frames) {
    const list = byPage.get(frame.pageId)
    if (list) list.push(frame)
    else byPage.set(frame.pageId, [frame])
  }
  return byPage
}

/**
 * Every `(source frame, nearest target frame)` connector for one page pair.
 *
 * Returns nothing when either page has no frame on THIS board — the flow is
 * still real, and still lives in the file, but there is nowhere here to point
 * at. That is the same reason a link outlives the board it was drawn on
 * (`@core/studio-prototype`'s `types.ts`).
 */
function connectorsForPagePair(
  sourcePageId: string,
  targetPageId: string,
  byPage: ReadonlyMap<string, BoardFrame[]>,
): { key: string; connector: FlowConnector }[] {
  const sourceFrames = byPage.get(sourcePageId)
  const targetFrames = byPage.get(targetPageId)
  if (!sourceFrames || !targetFrames) return []

  const result: { key: string; connector: FlowConnector }[] = []
  for (const sourceFrame of sourceFrames) {
    const source = frameRect(sourceFrame)
    let nearest: BoardFrame | undefined
    let nearestDistance = Infinity
    for (const candidate of targetFrames) {
      // A frame never connects to itself. Two DIFFERENT frames of the same page
      // do connect — that is a variant-to-variant flow, and it is the honest
      // drawing of a page that navigates to itself when the board happens to
      // hold two copies of it.
      if (candidate.id === sourceFrame.id) continue
      const distance = centerDistance(source, frameRect(candidate))
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = candidate
      }
    }
    if (!nearest) continue
    const connector = flowConnector(source, frameRect(nearest))
    if (!connector) continue
    result.push({ key: `${sourceFrame.id}->${nearest.id}`, connector })
  }
  return result
}

/** The read-only lines: navigation Studio derived from the project's source. */
export function routeCodeFlow(edges: readonly CodeFlowEdge[], frames: readonly BoardFrame[]): FlowLine[] {
  const byPage = framesByPage(frames)
  const lines: FlowLine[] = []

  for (const pair of groupCodeFlowByPagePair(edges)) {
    for (const { key, connector } of connectorsForPagePair(pair.sourcePageId, pair.targetPageId, byPage)) {
      lines.push({
        key: `code:${key}`,
        connector,
        chip: pair.edges.length > 1 ? `${pair.edges.length} links` : (pair.edges[0]?.evidence ?? ''),
        details: pair.edges.map((edge) => ({
          key: edge.id,
          primary: edge.evidence,
          secondary: edge.sourceNodeId,
        })),
      })
    }
  }

  return lines
}
