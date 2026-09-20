/**
 * nodeIdIndexing — the ONE "Nth element sharing a `data-node-id` value, in
 * document order" implementation, shared by every caller that needs it.
 *
 * ## Why this exists
 *
 * A `.map()` loop compiles to ONE JSX call site executed N times, so every
 * row's DOM element in a live frame carries the SAME stamped `data-node-id`
 * (`idStamp.ts` has no per-iteration information to mint a unique one with).
 * Three, independently-motivated call sites all need to disambiguate this
 * the identical way — "the Nth element sharing this node id, counted in
 * document order":
 *
 *   - `hmrState.ts`'s `keyFor`/`resolveKey` — HMR state survival across a
 *     Fast Refresh, frame-local only, never crosses the wire.
 *   - `runtime.ts`'s inbound `findByNodeId` — resolving a wire
 *     `{ nodeId, occurrenceIndex }` pair (L5's `messages.ts` extension) back
 *     to a specific DOM element for `select`/`hover`/`measure`/`optimistic.*`.
 *   - `runtime.ts`'s OUTBOUND pointer/text-edit forwarders — computing the
 *     `occurrenceIndex` of the element that was actually clicked/edited, so
 *     the parent-side `BridgeFrameAdapter` (L5) can pair it back to the
 *     correct canonical tree node id via `liveNodeResolve.ts`.
 *
 * Before this module existed, `hmrState.ts` had the only copy of this loop.
 * Rather than let `runtime.ts` grow two MORE copies (one inbound, one
 * outbound) for L5, this is the one implementation all three call through —
 * this repo's own "one implementation, three call sites" rule
 * (CLAUDE.md → "No dead code").
 */

export const NODE_ID_ATTR = 'data-node-id'

/**
 * The Nth (0-based, document order) element in `doc` carrying
 * `data-node-id="nodeId"`, or `null` if fewer than `occurrenceIndex + 1`
 * such elements exist.
 */
export function findNthNodeById(doc: Document, nodeId: string, occurrenceIndex: number): Element | null {
  let seen = 0
  for (const el of doc.querySelectorAll(`[${NODE_ID_ATTR}]`)) {
    if (el.getAttribute(NODE_ID_ATTR) !== nodeId) continue
    if (seen === occurrenceIndex) return el
    seen += 1
  }
  return null
}

export interface NodeIdOccurrence {
  nodeId: string
  occurrenceIndex: number
}

/**
 * `el`'s own `data-node-id` value, paired with its 0-based position (document
 * order) among every element in `doc` sharing that exact value. `null` when
 * `el` itself carries no node id (callers that need the NEAREST stamped
 * ancestor's occurrence resolve the ancestor first, then call this on it —
 * see `runtime.ts`'s outbound forwarders).
 */
export function occurrenceIndexOf(doc: Document, el: Element): NodeIdOccurrence | null {
  const nodeId = el.getAttribute(NODE_ID_ATTR)
  if (!nodeId) return null
  let index = 0
  for (const sibling of doc.querySelectorAll(`[${NODE_ID_ATTR}]`)) {
    if (sibling.getAttribute(NODE_ID_ATTR) !== nodeId) continue
    if (sibling === el) return { nodeId, occurrenceIndex: index }
    index += 1
  }
  return null
}
