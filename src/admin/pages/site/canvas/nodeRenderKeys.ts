/**
 * nodeRenderKeys — the React key a canvas node renders under, carried across
 * a re-parse that renumbered its id (audit PERF-6).
 *
 * A studio-imported node's id IS its source location (`rel:line:col`), so a
 * structural write renumbers everything below it in the file. `NodeRenderer`
 * keyed each child by that id, so after the post-write re-read every element
 * below the edit got a NEW key and React unmounted and remounted it: fresh DOM,
 * every effect torn down and re-run, the frame re-laid out from scratch, for
 * elements that did not change.
 *
 * `patchPages` already knows which new element each old one became — the
 * content alignment `reparseNodeFollow.ts` builds for the selection
 * (`alignPageTrees`). It hands that alignment here, and each moved node keeps
 * the key it had before, so React reconciles it in place: it re-renders (its
 * id genuinely changed), it does not remount.
 *
 * The keys are per page and must stay unique among siblings, so:
 *  - an aligned node keeps its old key;
 *  - an unaligned node uses its own id, unless an aligned node already
 *    carries that id as its key, in which case it gets a key minted with a
 *    separator no node id contains;
 *  - a node created after the last re-read (a local optimistic insert) has
 *    no entry and resolves the same way, at render time.
 *
 * Off-store on purpose, like `canvasHover.ts`: a key is not document state,
 * nothing may subscribe to it, and it only matters when a parent renders its
 * child list — which a re-read that changed a child's id always causes,
 * because the parent's `children` array changed with it. Written by the
 * reload paths only, synchronously before the store write that renders it.
 */
import type { NodeTree, PageNode } from '@core/page-tree'

/** A character no `rel:line:col` or nanoid id can contain. */
const SEP = String.fromCharCode(0)

interface PageRenderKeys {
  /** Node id -> render key, for every node whose key is not its own id. */
  keyOf: Map<string, string>
  /** Every value of `keyOf` — the keys a node other than their namesake holds. */
  inUse: Set<string>
}

const keysByPage = new Map<string, PageRenderKeys>()
let minted = 0

/** The React key `nodeId` renders under on `pageId`. */
export function nodeRenderKey(pageId: string | null, nodeId: string): string {
  const page = pageId === null ? undefined : keysByPage.get(pageId)
  if (!page) return nodeId
  const carried = page.keyOf.get(nodeId)
  if (carried !== undefined) return carried
  // A node the last re-read did not see, whose id some moved node carries as
  // its key: a suffix no id or minted key can equal keeps the siblings apart.
  return page.inUse.has(nodeId) ? nodeId + SEP + 'local' : nodeId
}

/**
 * Re-key `after` from `before` through `alignment` (old id -> new id, from
 * `alignPageTrees`). Called by `patchPages` for a page whose node ids changed.
 */
export function carryNodeRenderKeys(
  pageId: string,
  before: NodeTree<PageNode>,
  after: NodeTree<PageNode>,
  alignment: ReadonlyMap<string, string>,
): void {
  const previous = keysByPage.get(pageId)
  const aligned = new Map<string, string>()
  for (const [oldId, newId] of alignment) {
    if (!before.nodes[oldId] || !after.nodes[newId]) continue
    aligned.set(newId, previous?.keyOf.get(oldId) ?? oldId)
  }
  const carried = new Set(aligned.values())
  const keyOf = new Map<string, string>()
  const inUse = new Set<string>()
  for (const newId of Object.keys(after.nodes)) {
    let key = aligned.get(newId)
    if (key === undefined) key = carried.has(newId) ? newId + SEP + String(++minted) : newId
    if (key === newId) continue
    keyOf.set(newId, key)
    inUse.add(key)
  }
  if (keyOf.size === 0) keysByPage.delete(pageId)
  else keysByPage.set(pageId, { keyOf, inUse })
}

/** Forget `pageId`'s carried keys — the page is gone, new, or was re-read with no alignment. */
export function dropNodeRenderKeys(pageId: string): void {
  keysByPage.delete(pageId)
}

/** Forget every carried key — a full reload renders every node under its own id. */
export function clearNodeRenderKeys(): void {
  keysByPage.clear()
}
