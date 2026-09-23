/**
 * reparseNodeFollow — after a reparse, which element is the one the user had
 * hold of before it?
 *
 * ERR-5 (`docs/audits/2026-09-23-studio-audit/02-errors-client.md`). A
 * studio-imported node's id IS its source location (`rel:line:col`), so any
 * write above an element renumbers it. Both reload paths used to keep an id
 * iff it still resolved, which is right when a shift VACATES an address and
 * silently wrong when it PERMUTES one: an agent inserts a banner on line 4, the
 * selected "Body" moves to line 5, and `a.tsx:4:5` — still a perfectly valid
 * key — now names the banner. The ring jumped, and the next inspector
 * keystroke, Delete or ⌘D went to disk against the wrong element.
 *
 * So both reload paths now ask this module where each id the canvas is holding
 * (selection, hover, inline edit, entered instances, the live drag) went, and
 * drop the ones it cannot answer. The contract, in the order it is asked:
 *
 *  1. **Alignment.** Each touched page's old tree is aligned against its new
 *     one from the root down. At every matched pair the two child lists are
 *     aligned by CONTENT, never by id: first by a deep fingerprint of the
 *     whole subtree (module, tag, label, text, props, classes and every
 *     descendant's fingerprint — ids excluded), then by the node's own
 *     shallow fingerprint, then — only when both sides have the same number of
 *     unmatched children and every pair agrees on module and tag — by position
 *     (an in-place edit), then by a module+tag that is unique on both sides.
 *     A single inserted or deleted run is resolved exactly: every old child
 *     whose side of the run is the same for every placement the fingerprints
 *     allow is mapped, and a child whose side depends on the placement (a run
 *     of identical siblings) is left unmatched.
 *  2. **Strict remap.** `buildReparseNodeIdRemap` (`historyNodeIdRemap.ts`),
 *     the isomorphic walk the undo stack is re-addressed with, is consulted
 *     for an id alignment could not place — and accepted only when the node
 *     at the new address still has the old one's module, tag, label and text.
 *  3. **Otherwise the id drops.** An element the tree alone cannot tell apart
 *     from its neighbour is not followed anywhere: an empty selection is a
 *     visible, recoverable state, a selection on the wrong element is a write
 *     to the wrong line.
 *
 * A node id composed into several routes (a Next.js `layout.tsx` node) must
 * land on the SAME new id on every page it is on, or it drops — re-addressing
 * half of a shared id would be the wrong-element bug in a new place.
 *
 * Cost: O(nodes) of the pages that hold an id being followed, computed lazily
 * and at most once per page — never the whole site. Pure: reads frozen trees,
 * writes nothing.
 */
import type { NodeTree, PageNode, SiteDocument } from '@core/page-tree'

/** Where `oldId` is now, or `null` when no element can honestly be said to be it. */
export type NodeIdFollower = (oldId: string) => string | null

const SEP = String.fromCharCode(0)

function stringProp(props: Record<string, unknown>, key: string): string {
  const value = props[key]
  return typeof value === 'string' ? value : ''
}

/** Module + tag: what KIND of element this is. */
function kindKey(node: PageNode): string {
  return node.moduleId + SEP + stringProp(node.props, 'tag') + SEP + stringProp(node.props, 'customTag')
}

/** Kind + the words a person would recognise it by. */
function shallowKey(node: PageNode): string {
  return kindKey(node) + SEP + (node.label ?? '') + SEP + stringProp(node.props, 'text')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch (_err) {
    // A prop value JSON cannot spell (a cycle) contributes nothing; the
    // shallow and kind keys still describe the node.
    return ''
  }
}

/**
 * Deep fingerprints for one page pair, interned so equal subtrees share one
 * integer and comparing two is O(1). Shared between the old and new tree so an
 * integer means the same content on both sides. Ids never enter a key.
 */
class SubtreeFingerprints {
  private readonly interned = new Map<string, number>()
  private readonly memo = new Map<NodeTree<PageNode>, Map<string, number>>()

  of(tree: NodeTree<PageNode>, id: string): number {
    let perTree = this.memo.get(tree)
    if (!perTree) {
      perTree = new Map()
      this.memo.set(tree, perTree)
    }
    const known = perTree.get(id)
    if (known !== undefined) return known
    const node = tree.nodes[id]
    if (!node) return -1
    const children = node.children.map((childId) => this.of(tree, childId)).join(',')
    const key =
      shallowKey(node) + SEP + safeJson(node.props) + SEP + node.classIds.join(' ') + SEP +
      safeJson(node.inlineStyles ?? null) + SEP + children
    let fingerprint = this.interned.get(key)
    if (fingerprint === undefined) {
      fingerprint = this.interned.size
      this.interned.set(key, fingerprint)
    }
    perTree.set(id, fingerprint)
    return fingerprint
  }
}

/**
 * Pair the children of one matched node. Returns `[oldIndex, newIndex]`
 * pairs; an old child absent from the result has no honest counterpart.
 */
function alignChildren(
  oldKeys: { deep: readonly number[]; shallow: readonly string[]; kind: readonly string[] },
  newKeys: { deep: readonly number[]; shallow: readonly string[]; kind: readonly string[] },
): [number, number][] {
  const n = oldKeys.deep.length
  const m = newKeys.deep.length
  let prefix = 0
  while (prefix < n && prefix < m && oldKeys.deep[prefix] === newKeys.deep[prefix]) prefix++
  let suffix = 0
  while (suffix < n && suffix < m && oldKeys.deep[n - 1 - suffix] === newKeys.deep[m - 1 - suffix]) suffix++

  // One contiguous run inserted (m > n) or deleted (n > m), and nothing else
  // changed: every placement `k` of that run the fingerprints allow is a valid
  // reading. An old child is mapped only when it sits on the same side of the
  // run under EVERY valid `k`.
  if (n !== m) {
    const d = Math.abs(n - m)
    const lo = n > m ? Math.max(0, n - d - suffix) : Math.max(0, n - suffix)
    const hi = n > m ? Math.min(prefix, m) : Math.min(prefix, n)
    if (lo <= hi) {
      const pairs: [number, number][] = []
      for (let i = 0; i < n; i++) {
        if (i < lo) pairs.push([i, i])
        else if (n > m ? i >= hi + d : i >= hi) pairs.push([i, n > m ? i - d : i + d])
      }
      return pairs
    }
  } else if (prefix === n) {
    return oldKeys.deep.map((_, i) => [i, i] as [number, number])
  }

  // Several changes. Prefix and suffix hold where they do not overlap; the
  // middle is matched by content, strictest key first.
  const pairs: [number, number][] = []
  const safePrefix = Math.min(prefix, n, m)
  const safeSuffix = Math.min(suffix, Math.min(n, m) - safePrefix)
  for (let i = 0; i < safePrefix; i++) pairs.push([i, i])
  for (let k = 0; k < safeSuffix; k++) pairs.push([n - 1 - k, m - 1 - k])

  let oldRest: number[] = []
  for (let i = safePrefix; i < n - safeSuffix; i++) oldRest.push(i)
  let newRest: number[] = []
  for (let j = safePrefix; j < m - safeSuffix; j++) newRest.push(j)

  const matchUnique = <K>(oldKey: (i: number) => K, newKey: (j: number) => K) => {
    const oldCount = new Map<K, number>()
    for (const i of oldRest) oldCount.set(oldKey(i), (oldCount.get(oldKey(i)) ?? 0) + 1)
    const newAt = new Map<K, number>()
    const newCount = new Map<K, number>()
    for (const j of newRest) {
      newCount.set(newKey(j), (newCount.get(newKey(j)) ?? 0) + 1)
      newAt.set(newKey(j), j)
    }
    const taken = new Set<number>()
    const keptOld: number[] = []
    for (const i of oldRest) {
      const key = oldKey(i)
      if (oldCount.get(key) === 1 && newCount.get(key) === 1) {
        const j = newAt.get(key)!
        pairs.push([i, j])
        taken.add(j)
      } else {
        keptOld.push(i)
      }
    }
    oldRest = keptOld
    newRest = newRest.filter((j) => !taken.has(j))
  }

  matchUnique((i) => oldKeys.deep[i]!, (j) => newKeys.deep[j]!)
  matchUnique((i) => oldKeys.shallow[i]!, (j) => newKeys.shallow[j]!)
  if (
    oldRest.length > 0 &&
    oldRest.length === newRest.length &&
    oldRest.every((i, k) => oldKeys.kind[i] === newKeys.kind[newRest[k]!])
  ) {
    oldRest.forEach((i, k) => pairs.push([i, newRest[k]!]))
    return pairs
  }
  matchUnique((i) => oldKeys.kind[i]!, (j) => newKeys.kind[j]!)
  return pairs
}

/** Old id -> new id for every node of `before` that has an honest counterpart in `after`. */
export function alignPageTrees(before: NodeTree<PageNode>, after: NodeTree<PageNode>): Map<string, string> {
  const out = new Map<string, string>()
  const rootA = before.nodes[before.rootNodeId]
  const rootB = after.nodes[after.rootNodeId]
  if (!rootA || !rootB || rootA.moduleId !== rootB.moduleId) return out
  const fingerprints = new SubtreeFingerprints()
  const keysOf = (tree: NodeTree<PageNode>, ids: readonly string[]) => {
    const nodes = ids.map((id) => tree.nodes[id])
    return {
      deep: ids.map((id) => fingerprints.of(tree, id)),
      shallow: nodes.map((node) => (node ? shallowKey(node) : '')),
      kind: nodes.map((node) => (node ? kindKey(node) : '')),
    }
  }
  const stack: [string, string][] = [[before.rootNodeId, after.rootNodeId]]
  while (stack.length > 0) {
    const [oldId, newId] = stack.pop()!
    out.set(oldId, newId)
    const a = before.nodes[oldId]!
    const b = after.nodes[newId]!
    if (a.children.length === 0 || b.children.length === 0) continue
    for (const [i, j] of alignChildren(keysOf(before, a.children), keysOf(after, b.children))) {
      const childOld = a.children[i]!
      const childNew = b.children[j]!
      if (before.nodes[childOld] && after.nodes[childNew]) stack.push([childOld, childNew])
    }
  }
  return out
}

export interface ReparseFollowInput {
  before: SiteDocument
  after: SiteDocument
  /** The PRE-reload `_nodeIdToPageIds` index — which page(s) each old id was on. */
  pagesOf: ReadonlyMap<string, readonly string[]>
  /** Pages whose tree was replaced by this reload; every other page kept its object. */
  touchedPageIds: ReadonlySet<string>
  /** `buildReparseNodeIdRemap(before, after)` — see this module's doc, step 2. */
  strictRemap: ReadonlyMap<string, string>
  /**
   * What an id that is on NO page (a Visual Component or layout tree node)
   * means after this reload. `patchPages` leaves those trees alone, so the id
   * is still exactly right (`'keep'`); `loadSite` resets `activeDocument`, so
   * it no longer names anything on screen (`'drop'`).
   */
  offPageIds: 'keep' | 'drop'
}

/**
 * Build the follower both reload paths map canvas state through. Lazy: a page
 * is aligned the first time an id on it is asked about, then cached.
 */
export function createReparseNodeFollower(input: ReparseFollowInput): NodeIdFollower {
  const { before, after, pagesOf, touchedPageIds, strictRemap } = input
  const beforePages = new Map(before.pages.map((page) => [page.id, page]))
  const afterPages = new Map(after.pages.map((page) => [page.id, page]))
  // A reload that changed the page SET (a project switch, a page create or
  // delete) is not provably a re-read of the same document: two projects can
  // both have `app/page.tsx`. There, only an element that is still at the same
  // address on the same page AND still looks the same is kept — never moved.
  const samePageSet =
    before.pages.length === after.pages.length && before.pages.every((page) => afterPages.has(page.id))
  const alignments = new Map<string, Map<string, string>>()

  const followOnPage = (oldId: string, pageId: string): string | null => {
    const beforePage = beforePages.get(pageId)
    const afterPage = afterPages.get(pageId)
    if (!beforePage || !afterPage) return null
    const oldNode = beforePage.nodes[oldId]
    if (!oldNode) return null
    if (!touchedPageIds.has(pageId) || beforePage === afterPage) {
      return afterPage.nodes[oldId] ? oldId : null
    }
    if (!samePageSet) {
      const same = afterPage.nodes[oldId]
      return same && shallowKey(same) === shallowKey(oldNode) ? oldId : null
    }
    let alignment = alignments.get(pageId)
    if (!alignment) {
      alignment = alignPageTrees(beforePage, afterPage)
      alignments.set(pageId, alignment)
    }
    const aligned = alignment.get(oldId)
    if (aligned !== undefined) return aligned
    const strict = strictRemap.get(oldId)
    const strictNode = strict === undefined ? undefined : afterPage.nodes[strict]
    if (strictNode && shallowKey(strictNode) === shallowKey(oldNode)) return strict!
    return null
  }

  return (oldId) => {
    const pageIds = pagesOf.get(oldId)
    if (!pageIds || pageIds.length === 0) return input.offPageIds === 'keep' ? oldId : null
    let answer: string | null = null
    for (const pageId of pageIds) {
      const followed = followOnPage(oldId, pageId)
      if (followed === null) return null
      if (answer !== null && answer !== followed) return null
      answer = followed
    }
    return answer
  }
}

// ── Holders outside the store ──────────────────────────────────────────────
//
// ERR-23. The canvas drag session keeps the ids it is dragging in a ref, not
// in the store, because it must commit React exactly twice per gesture
// (`useCanvasReorderDrag.ts`). A reparse mid-drag therefore could not reach it
// and the release committed against the pre-write ids — a silent no-op at
// best, the element that inherited the address at worst. Both reload paths
// publish the follower they mapped the store through, synchronously after the
// store has been written, so every holder re-addresses from the same answer.
// A listener must use the follower during the call and not keep it: it closes
// over both documents.

type ReparseFollowListener = (follow: NodeIdFollower) => void

const reparseFollowListeners = new Set<ReparseFollowListener>()

/** Hear about every reparse that re-addressed node ids. Returns the unsubscribe. */
export function subscribeReparseFollow(listener: ReparseFollowListener): () => void {
  reparseFollowListeners.add(listener)
  return () => {
    reparseFollowListeners.delete(listener)
  }
}

/** Called by `loadSite`/`patchPages` once the store holds the reparsed document. */
export function publishReparseFollow(follow: NodeIdFollower): void {
  for (const listener of [...reparseFollowListeners]) listener(follow)
}
