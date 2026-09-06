/**
 * flowRouting — turning derived edges plus a board's frames into the lines to
 * draw.
 *
 * Two decisions live here, and both are about not drawing N lines where the
 * user has one thought:
 *
 * ONE LINE PER FRAME PAIR, NOT PER EDGE
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
 */
import type { BoardFrame } from '@core/studio-board'
import { FRAME_HEIGHT, FRAME_WIDTH } from '@core/studio-board'
import { groupCodeFlowByPagePair, type CodeFlowEdge } from '@core/studio-prototype'
import { flowConnector, type FlowConnector, type FlowRect } from './flowGeometry'

/** One connector, with the facts that justify it. */
export interface FlowLine {
  /** Stable across re-derives: the two frames it runs between. */
  key: string
  connector: FlowConnector
  /** Every code edge this line stands for, in source order. */
  edges: CodeFlowEdge[]
}

/** A frame's board box, with `width`/`height` defaulted the same way the renderer defaults them. */
export function frameRect(frame: BoardFrame): FlowRect {
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
 * The lines to draw for a board.
 *
 * A pair whose source or target page has no frame on THIS board draws nothing —
 * the flow is still real, and still lives in the file, but there is nowhere on
 * this board to point at. That is the same reason a link outlives the board it
 * was drawn on (`@core/studio-prototype`'s `types.ts`).
 */
export function routeCodeFlow(edges: readonly CodeFlowEdge[], frames: readonly BoardFrame[]): FlowLine[] {
  const byPage = framesByPage(frames)
  const lines: FlowLine[] = []

  for (const pair of groupCodeFlowByPagePair(edges)) {
    const sourceFrames = byPage.get(pair.sourcePageId)
    const targetFrames = byPage.get(pair.targetPageId)
    if (!sourceFrames || !targetFrames) continue

    for (const sourceFrame of sourceFrames) {
      const source = frameRect(sourceFrame)
      let nearest: BoardFrame | undefined
      let nearestDistance = Infinity
      for (const candidate of targetFrames) {
        // A frame never connects to itself. Two DIFFERENT frames of the same
        // page do connect — that is a variant-to-variant flow, and it is the
        // honest drawing of a page that navigates to itself when the board
        // happens to hold two copies of it.
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
      lines.push({ key: `${sourceFrame.id}->${nearest.id}`, connector, edges: pair.edges })
    }
  }

  return lines
}
