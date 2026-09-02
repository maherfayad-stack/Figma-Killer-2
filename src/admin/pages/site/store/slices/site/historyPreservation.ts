/**
 * historyPreservation — decides whether `_historyPast`/`_historyFuture` can
 * safely survive a `loadSite()` reload, or must be wiped.
 *
 * `STUDIO-FIGMA-PARITY-PLAN.md` 0.2 / audit E2: every structural edit
 * (move/delete/insert/detach/swap/image-replace) used to call `loadSite()`
 * unconditionally, which wipes `_historyPast`/`_historyFuture` wholesale —
 * destroying the ENTIRE undo stack for a single move, not just the moved
 * node's own transaction.
 *
 * Every stored `HistoryEntry` is a pair of Mutative JSON Patches, addressed
 * by PATH — and a patch that targets a page/VC node keys that path on the
 * node's OWN id (`['pages', i, 'nodes', nodeId, ...]` /
 * `['visualComponents', i, 'tree', 'nodes', nodeId, ...]`). A studio-imported
 * node's id IS its source location (`rel:line:col`), so a structural write
 * that shifts lines under a node invalidates every stored patch still naming
 * the OLD id — replaying it against the freshly reparsed tree would either
 * no-op (harmless: `add`/`remove` on an absent key) or, for a `replace`,
 * silently mint a stray phantom key at a path that no longer means anything
 * (not harmless).
 *
 * A TRUE position-based re-anchor — mapping a stale id to whatever the SAME
 * source element's id became after the shift — needs AST-level
 * correspondence data this client does not have; building that is Track
 * C2/C5 territory, explicitly out of Phase 0's scope (see
 * `STUDIO-FIGMA-PARITY-PLAN.md` 0.2's "do not attempt targeted per-file
 * re-parse").
 *
 * Instead, this module answers the narrower question that IS always safe to
 * answer without that machinery: does the incoming site still contain,
 * unchanged, every node id any stored patch references? When yes — the
 * common case, since a structural edit only shifts ids inside the file(s) it
 * touched, and every other node in the document is untouched by the reparse
 * — the whole stack replays correctly as-is and is kept. When no, the safe
 * fallback is exactly the historical (pre-fix) behavior: wipe.
 *
 * Scope note: this only tracks NODE ids (`'pages'|'nodes'` /
 * `'visualComponents'|'tree'|'nodes'` path shapes). A patch that references a
 * `styleRules` entry which itself gets pruned by the reparse (e.g. a
 * generated-class rule for a node the edit just deleted) is not separately
 * validated — a narrower edge case than the "whole undo stack always dies"
 * bug this exists to fix; the safe fallback (wipe) still applies whenever any
 * NODE id is unsafe, and an unsafe style-only edge case simply isn't
 * detected. A future track can extend this the same way for `styleRules`/
 * `visualComponents` membership if that gap needs closing too.
 */
import type { Patches } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import type { HistoryEntry } from './types'

/** Every node id addressable in `site` — pages AND Visual Component trees, the two surfaces `mutateActiveTree` can target. */
export function collectAllNodeIds(site: SiteDocument): Set<string> {
  const ids = new Set<string>()
  for (const page of site.pages) {
    for (const id of Object.keys(page.nodes)) ids.add(id)
  }
  for (const vc of site.visualComponents ?? []) {
    for (const id of Object.keys(vc.tree.nodes)) ids.add(id)
  }
  return ids
}

/** Node ids one patch's path addresses — the segment right after a literal `'nodes'` key, wherever it appears in the path. */
function referencedNodeIds(path: Patches[number]['path']): string[] {
  const ids: string[] = []
  for (let i = 0; i < path.length - 1; i++) {
    if (path[i] === 'nodes' && typeof path[i + 1] === 'string') ids.push(path[i + 1] as string)
  }
  return ids
}

/**
 * True iff every node id any patch in `entries` references — forward OR
 * inverse, so both undo and redo stay applicable — still exists in
 * `knownNodeIds`. An empty `entries` array is vacuously safe (nothing to
 * invalidate), which is exactly correct for a project's first load.
 */
export function historySurvivesReload(
  entries: readonly HistoryEntry[],
  knownNodeIds: ReadonlySet<string>,
): boolean {
  for (const entry of entries) {
    for (const patches of [entry.forward, entry.inverse]) {
      for (const patch of patches) {
        for (const id of referencedNodeIds(patch.path)) {
          if (!knownNodeIds.has(id)) return false
        }
      }
    }
  }
  return true
}
