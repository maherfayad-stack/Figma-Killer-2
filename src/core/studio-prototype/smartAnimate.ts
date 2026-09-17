/**
 * smartAnimate — which element on the OUTGOING screen is which element on the
 * INCOMING one.
 *
 * Pure: two page trees in, a list of pairs out. No DOM, no measurement, no
 * animation. The canvas half (`canvas/smartAnimateFlip.ts`) turns a pair into
 * two rects and a WAAPI animation; this file only answers the question that
 * decides whether any of that means anything.
 *
 * WHY `NodeHint`, AND NOT A LAYER NAME
 * ────────────────────────────────────
 * Figma matches smart-animate layers by NAME, because a Figma layer has a
 * stable name and a stable id. A Studio node has neither: its id is
 * `relFile:line:col` — a source POSITION — and its "name" is whatever the JSX
 * element is called, which is `<div>` several hundred times per screen.
 *
 * What Studio does have is the primitive `.studio/prototype.json` already
 * depends on for exactly this problem: a `NodeHint` of
 * `{ nodeId, indexPath, moduleId, textSnippet }`, re-resolved against a tree
 * (`@core/studio-anchor`). Re-resolving an outgoing node's hint against the
 * INCOMING tree asks precisely the right question — "is there a node of the
 * same kind at the same structural address?" — and the confidence it reports
 * already separates the three answers that matter:
 *
 *   - `moved`    — same address, same module, same text. The strongest match:
 *                  a shared header that is literally the same element.
 *   - `drifted`  — same address, same module, DIFFERENT text. Still a match,
 *                  and the interesting one: a title whose words changed is the
 *                  thing you most want to see animate rather than cross-fade.
 *   - `detached` — nothing of the kind is there. No pair.
 *
 * `exact` (the stored id still resolves) can only happen when the two screens
 * genuinely share a source position — the same imported component rendered on
 * both — which is a match too, and the best possible one.
 *
 * WHAT IT REFUSES
 * ───────────────
 * One-to-one, always. An incoming node already claimed by a shallower outgoing
 * node is not offered again: two elements animating into the same box is a
 * visibly wrong answer, and structurally the second claim is the weaker one.
 *
 * And the root is never a pair. It is the screen itself — it matches trivially,
 * it always "moves" by exactly nothing, and pairing it would put a full-screen
 * ghost over the transition.
 */
import { getChildren, type NodeTree } from '@core/page-tree'
import { captureNodeHint, resolveNodeAnchor } from '@core/studio-anchor'

/** One element on the outgoing screen and the element it becomes. */
export interface ScreenNodeMatch {
  fromNodeId: string
  toNodeId: string
}

export interface ScreenNodeMatching {
  /** Pairs, SHALLOWEST FIRST — see `MAX_SMART_ANIMATE_PAIRS`. */
  matched: ScreenNodeMatch[]
  /** Outgoing nodes with no counterpart. They dissolve. */
  leaving: string[]
  /** Incoming nodes nothing animated into. They dissolve. */
  entering: string[]
}

/**
 * How many pairs a single transition will animate.
 *
 * A screen is routinely several hundred nodes and the FLIP measures both sides
 * of every pair — an uncapped match would make the one transition that is
 * supposed to look expensive the one that stutters. Breadth-first order means
 * the cap keeps the OUTERMOST elements, which are the big, visible boxes a
 * viewer actually tracks between two screens; the twentieth nested `<span>`
 * inside a card that is itself animating adds nothing anyone can see.
 */
export const MAX_SMART_ANIMATE_PAIRS = 24

/** Node ids breadth-first from the root, root excluded. */
function breadthFirstNodeIds(tree: NodeTree): string[] {
  const out: string[] = []
  let frontier = getChildren(tree, tree.rootNodeId).map((node) => node.id)
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      out.push(id)
      for (const child of getChildren(tree, id)) next.push(child.id)
    }
    frontier = next
  }
  return out
}

/**
 * Match the outgoing screen's elements to the incoming screen's.
 *
 * `limit` caps `matched` only. `leaving`/`entering` stay complete, because they
 * are a claim about the screens rather than a workload: a caller that dissolves
 * the remainder has to know it is the whole remainder.
 */
export function matchScreenNodes(
  from: NodeTree,
  to: NodeTree,
  limit: number = MAX_SMART_ANIMATE_PAIRS,
): ScreenNodeMatching {
  const fromIds = breadthFirstNodeIds(from)
  const toIds = breadthFirstNodeIds(to)

  const matched: ScreenNodeMatch[] = []
  const leaving: string[] = []
  const entering: string[] = []
  const claimed = new Set<string>()

  for (const fromNodeId of fromIds) {
    const hint = captureNodeHint(from, fromNodeId)
    const resolved = hint ? resolveNodeAnchor(hint, to) : null
    const toNodeId = resolved && resolved.confidence !== 'detached' ? resolved.nodeId : null

    // The root of the incoming tree is not a pair — see the module doc — and a
    // node another pair already claimed is not offered twice.
    if (!toNodeId || toNodeId === to.rootNodeId || claimed.has(toNodeId)) {
      leaving.push(fromNodeId)
      continue
    }

    claimed.add(toNodeId)
    if (matched.length < limit) matched.push({ fromNodeId, toNodeId })
    // Past the cap the pair is still a MATCH — it simply is not animated. It
    // must not fall into `leaving`, or the caller would be told an element
    // vanished when it is standing right there on the new screen.
  }

  for (const toNodeId of toIds) {
    if (!claimed.has(toNodeId)) entering.push(toNodeId)
  }

  return { matched, leaving, entering }
}
