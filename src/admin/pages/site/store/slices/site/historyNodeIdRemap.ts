/**
 * historyNodeIdRemap — re-addressing the undo stack after a structural write
 * renumbered the node ids it references.
 *
 * `store-08`. A studio-imported node's id IS its source location
 * (`rel:line:col`), so every structural write — a move, a delete, an insert —
 * shifts the ids of everything below it in the file. `historyPreservation.ts`
 * answered that with the only question it could answer alone ("does every id
 * a stored patch names still exist?") and wiped the whole stack when the
 * answer was no. Two consequences, both reported by users as "Ctrl+Z stopped
 * working":
 *
 *  1. One drag destroyed the undo history of every unrelated edit before it.
 *  2. Worse, when the shift PERMUTED line numbers rather than vacating them —
 *     three same-size siblings reordered, say — every old id still "existed",
 *     the check said safe, and undo replayed the patch against whichever
 *     element had inherited that address. A silent wrong-element edit.
 *
 * The correspondence `historyPreservation.ts`'s doc says this client does not
 * have is real for AST-level re-anchoring in general — but not for the one
 * case that matters here. A reparse triggered by the editor's OWN structural
 * write is a re-read of a tree the store already holds in its post-gesture
 * shape: the optimistic mutation and the source write describe the same
 * result, so the two trees are ISOMORPHIC. Walking them in parallel from each
 * page's root gives an exact old-id -> new-id correspondence with no AST
 * access at all.
 *
 * The walk is deliberately strict, because a wrong remap is worse than a wipe:
 * same `moduleId` and same child count at every node, or the page contributes
 * nothing and the old always-safe fallback applies. A project switch, an
 * agent-written page that genuinely changed shape, and a reload that dropped
 * or added elements all fail the walk and wipe exactly as before.
 *
 * Scope, matching `historyPreservation.ts`: PATH segments after a literal
 * `'nodes'` key, plus the node ids a structural history entry names. Node ids
 * embedded in a patch's VALUE (a `children` array, a re-added subtree) are not
 * rewritten — a structural entry's patches are never replayed (see
 * `undoRedoActions.ts`), and a value edit's patch values contain prop values,
 * not ids.
 */
import type { Patches } from 'mutative'
import type { NodeTree, PageNode, SiteDocument } from '@core/page-tree'
import type { HistoryEntry, StructuralHistory } from './types'

/**
 * Match `before` against `after` node-for-node from the root and record every
 * id that changed. Returns `false` the moment the shapes disagree, leaving
 * `out` for the caller to discard.
 */
function walkTreePair(
  before: NodeTree<PageNode>,
  after: NodeTree<PageNode>,
  beforeId: string,
  afterId: string,
  out: Map<string, string>,
): boolean {
  const a = before.nodes[beforeId]
  const b = after.nodes[afterId]
  if (!a || !b) return false
  if (a.moduleId !== b.moduleId) return false
  if (a.children.length !== b.children.length) return false
  if (beforeId !== afterId) out.set(beforeId, afterId)
  for (let i = 0; i < a.children.length; i++) {
    if (!walkTreePair(before, after, a.children[i]!, b.children[i]!, out)) return false
  }
  return true
}

/**
 * Old-id -> new-id for every node a reparse renamed, or an EMPTY map when no
 * page could be matched (in which case the caller keeps its existing
 * survivability fallback).
 *
 * Pages are paired by id; one whose shape changed simply contributes nothing.
 * A conflicting mapping for the same old id across two pages — possible for a
 * Next.js `layout.tsx` node, whose one id is composed into every route beneath
 * it — makes the whole remap ambiguous and returns empty: re-addressing half a
 * shared id would be the wrong-element bug again, in a new place.
 */
export function buildReparseNodeIdRemap(
  before: SiteDocument,
  after: SiteDocument,
): Map<string, string> {
  const remap = new Map<string, string>()
  const afterById = new Map(after.pages.map((page) => [page.id, page]))
  // The two documents must be the same document. A project switch, a page
  // create and a page delete all change the page SET and all go through a full
  // reload — none of them is a re-read of the tree the stack was recorded
  // against, and remapping across one would re-address history into a document
  // it never described. Cheap, decisive, and it fails closed.
  if (afterById.size !== before.pages.length) return remap
  for (const beforePage of before.pages) {
    const afterPage = afterById.get(beforePage.id)
    if (!afterPage) return new Map()
    const pageRemap = new Map<string, string>()
    if (!walkTreePair(beforePage, afterPage, beforePage.rootNodeId, afterPage.rootNodeId, pageRemap)) {
      continue
    }
    for (const [oldId, newId] of pageRemap) {
      const existing = remap.get(oldId)
      if (existing !== undefined && existing !== newId) return new Map()
      remap.set(oldId, newId)
    }
  }
  return remap
}

/** The node id `path` addresses at `i`, iff that position is a node key. */
function remapPath(path: Patches[number]['path'], remap: ReadonlyMap<string, string>): Patches[number]['path'] {
  let next: (string | number)[] | null = null
  for (let i = 1; i < path.length; i++) {
    if (path[i - 1] !== 'nodes' || typeof path[i] !== 'string') continue
    const replacement = remap.get(path[i] as string)
    if (replacement === undefined) continue
    next ??= [...(path as (string | number)[])]
    next[i] = replacement
  }
  return next ?? path
}

function remapStructural(
  structural: StructuralHistory,
  remap: ReadonlyMap<string, string>,
): StructuralHistory {
  if (structural.gesture !== 'move') return structural
  const step = (s: { nodeId: string; parentId: string; index: number }) => ({
    ...s,
    nodeId: remap.get(s.nodeId) ?? s.nodeId,
    parentId: remap.get(s.parentId) ?? s.parentId,
  })
  return { ...structural, undo: step(structural.undo), redo: step(structural.redo) }
}

/**
 * Rewrite every node id `entries` references through `remap`. Returns the same
 * array reference when nothing changed, so a reload that renamed nothing keeps
 * its "real keep, not a copy" property (see `loadSite`).
 */
export function remapHistoryEntries(
  entries: readonly HistoryEntry[],
  remap: ReadonlyMap<string, string>,
): HistoryEntry[] {
  if (remap.size === 0) return entries as HistoryEntry[]
  let changed = false
  const next = entries.map((entry) => {
    const forward = entry.forward.map((p) => {
      const path = remapPath(p.path, remap)
      return path === p.path ? p : { ...p, path }
    })
    const inverse = entry.inverse.map((p) => {
      const path = remapPath(p.path, remap)
      return path === p.path ? p : { ...p, path }
    })
    const structural = entry.structural ? remapStructural(entry.structural, remap) : undefined
    const structuralChanged = structural !== undefined && structural !== entry.structural
    const patchesChanged =
      forward.some((p, i) => p !== entry.forward[i]) || inverse.some((p, i) => p !== entry.inverse[i])
    if (!patchesChanged && !structuralChanged) return entry
    changed = true
    return {
      ...entry,
      forward,
      inverse,
      ...(structural ? { structural } : {}),
    }
  })
  return changed ? next : (entries as HistoryEntry[])
}
