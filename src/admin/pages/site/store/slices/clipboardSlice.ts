/**
 * Clipboard slice — copy/cut/paste for layer subtrees.
 *
 * The clipboard is editor-wide and owns the `studio-clipboard-v1` localStorage
 * key. Every read/write goes through this slice. The persisted shape is
 * validated via TypeBox (`ClipboardPayloadSchema`) on load; corruption
 * silently resolves to "no clipboard" rather than throwing.
 *
 * Multi-root payloads (Task #multi-select):
 * - The persisted payload now stores `rootNodeIds: string[]`. A single-node
 *   copy is `[id]`; a multi-select copy preserves selection order.
 * - Paste places every root in document order under the resolved location;
 *   class restoration / scoped-class remapping logic is shared between roots
 *   in one transaction.
 *
 * Paste placement is "smart": if the right-clicked target accepts children,
 * the subtree is pasted as the last child of the target; otherwise it is
 * pasted as the next sibling under the target's parent. The page root is
 * always treated as a container.
 *
 * Capture and restore (including the class paste rules) are implemented by
 * the shared snapshot engine in `@site/store/subtreeSnapshot` — the same
 * engine saved layouts use, so paste and layout insertion cannot drift.
 */

import type { StyleRule, Page, PageNode } from '@core/page-tree'
import { getParent } from '@core/page-tree'
import { firstOutletId, treeHasOutlet } from '@core/templates'
import { pushToast } from '@ui/components/Toast'
import {
  collectReferencedClasses,
  collectSubtreeNodes,
  insertSnapshotSubtrees,
} from '@site/store/subtreeSnapshot'
import {
  CLIPBOARD_VERSION,
  type ClipboardPayload,
  clearClipboardPayload,
  readClipboardPayload,
  writeClipboardPayload,
} from '@site/store/clipboard/clipboardStorage'
import { resolveInsertLocation, resolveSiblingAfterLocation } from '@site/store/insertLocation'
import type { EditorStoreSliceCreator } from '@site/store/types'
import { buildSiteHelpers, resolveActiveTreeTarget } from './site/helpers'
import { createStudioPasteWrite } from './site/studioPasteWrites'

/** Where a paste lands relative to its target. See `pasteNode`. */
export type PastePlacement = 'auto' | 'after'

/**
 * In-memory snapshot of the latest copy/cut. Mirrors the persisted payload
 * but is also kept reactively on the store so menus / shortcuts can react
 * to clipboard changes without polling localStorage.
 *
 * `rootNodeIds` is ordered: a multi-select copy preserves selection order,
 * a single-node copy is a 1-length array.
 */
interface ClipboardEntry {
  rootNodeIds: string[]
  nodes: Record<string, PageNode>
  classes: Record<string, StyleRule>
  copiedAt: number
}

interface ClipboardSlice {
  /** Latest copied / cut subtree(s). Null when the clipboard is empty. */
  clipboardEntry: ClipboardEntry | null

  /** Capture a node's subtree into the clipboard (in memory + localStorage). */
  copyNode: (nodeId: string) => boolean
  /** Capture a multi-selection of subtrees as one ordered clipboard payload. */
  copyNodes: (nodeIds: string[]) => boolean
  /**
   * Copy a node's subtree, then delete it from the active page.
   * Returns true if a copy + delete actually happened.
   */
  cutNode: (nodeId: string) => boolean
  /** Multi-cut: copy then delete every id in one undo step. */
  cutNodes: (nodeIds: string[]) => boolean
  /**
   * Paste the clipboard subtree(s) relative to `targetNodeId`.
   *
   * `placement` answers "relative HOW", and the two callers genuinely differ:
   *
   * - `'auto'` — the right-click / palette answer. If the target accepts
   *   children the subtree is appended INSIDE it; otherwise it lands as the
   *   next sibling. "Paste here" on a container means into the container.
   * - `'after'` — the ⌘V answer (`K7`). The keystroke is about a SELECTION,
   *   and a user watching a selected box expects the pasted copy to appear
   *   beside it, not swallowed by it and scrolled out of view at the bottom of
   *   its child list.
   *
   * For multi-root payloads, every root is placed consecutively in selection
   * order at the resolved location (single undo step). Returns the new root
   * node IDs (in selection order), or null if paste was a no-op.
   */
  pasteNode: (targetNodeId: string, placement?: PastePlacement) => string[] | null

  /** Clear the clipboard from memory + localStorage. */
  clearClipboard: () => void
}

declare module '@site/store/types' {
  // Surface this slice's fields on the combined EditorStore type.
  interface EditorStore extends ClipboardSlice {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the active Page document on the store, ignoring VC mode. */
function getActivePage(state: {
  site: { pages: Page[] } | null
  activePageId: string | null
}): Page | null {
  if (!state.site || !state.activePageId) return null
  return state.site.pages.find((p) => p.id === state.activePageId) ?? null
}

/**
 * Reduce a multi-selection to its top-level set (drop ids whose ancestor is
 * also in the selection — those would be copied with the ancestor anyway).
 *
 * Returned ids preserve input order.
 */
function topLevelOnly(page: Page, ids: string[]): string[] {
  const idSet = new Set(ids)
  const result: string[] = []
  for (const id of ids) {
    let ancestor = getParent(page, id)
    let dominated = false
    while (ancestor) {
      if (idSet.has(ancestor.id)) {
        dominated = true
        break
      }
      ancestor = getParent(page, ancestor.id)
    }
    if (!dominated) result.push(id)
  }
  return result
}

// ---------------------------------------------------------------------------
// Slice implementation
// ---------------------------------------------------------------------------

export const createClipboardSlice: EditorStoreSliceCreator<ClipboardSlice> = (
  set,
  get,
) => {
  const helpers = buildSiteHelpers(set, get)
  const { mutateSiteState } = helpers
  // `store-13` — the same source-write gate `nodeActions.ts` builds, for the
  // one structural gesture that never consulted it. A second instance is free:
  // `createStudioSourceWrites` holds no state of its own, it only closes over
  // the helpers and a read-only view of the active tree.
  const writePasteToSource = createStudioPasteWrite(helpers, () => resolveActiveTreeTarget(get())?.tree ?? null)

  // Hydrate the in-memory entry from localStorage at slice creation. The
  // store is built once per session, so this runs at editor mount only.
  const persisted = readClipboardPayload()
  const initialEntry: ClipboardEntry | null = persisted
    ? {
        rootNodeIds: persisted.rootNodeIds,
        nodes: persisted.nodes,
        classes: persisted.classes,
        copiedAt: persisted.copiedAt,
      }
    : null

  function persistEntry(entry: ClipboardEntry): void {
    const payload: ClipboardPayload = {
      version: CLIPBOARD_VERSION,
      rootNodeIds: entry.rootNodeIds,
      nodes: entry.nodes,
      classes: entry.classes,
      copiedAt: entry.copiedAt,
    }
    writeClipboardPayload(payload)
  }

  /** Shared implementation for `copyNode` / `copyNodes`. */
  function copyImpl(nodeIds: string[]): boolean {
    const state = get()
    const page = getActivePage(state)
    if (!page) return false
    if (nodeIds.length === 0) return false

    // Refuse to include the page root — duplicating "the entire page body" has
    // no meaningful target placement and matches existing root-guard policy.
    const filtered = nodeIds.filter((id) => id !== page.rootNodeId)
    if (filtered.length === 0) return false

    const tops = topLevelOnly(page, filtered)
    const subtrees = collectSubtreeNodes(page, tops)
    if (!subtrees) return false

    const siteClasses = state.site?.styleRules ?? {}
    const classes = collectReferencedClasses(subtrees.nodes, siteClasses)
    const entry: ClipboardEntry = {
      rootNodeIds: subtrees.rootNodeIds,
      nodes: subtrees.nodes,
      classes,
      copiedAt: Date.now(),
    }
    set({ clipboardEntry: entry })
    persistEntry(entry)
    return true
  }

  return {
    clipboardEntry: initialEntry,

    copyNode: (nodeId) => copyImpl([nodeId]),

    copyNodes: (nodeIds) => copyImpl(nodeIds),

    cutNode: (nodeId) => {
      const state = get()
      const page = getActivePage(state)
      if (!page) return false
      if (page.rootNodeId === nodeId) return false

      // Copy first; if copy fails (orphan node), don't delete.
      if (!state.copyNode(nodeId)) return false
      // Reuse the existing deleteNode action so undo history + selection
      // behave identically to a manual delete.
      get().deleteNode(nodeId)
      return true
    },

    cutNodes: (nodeIds) => {
      const state = get()
      const page = getActivePage(state)
      if (!page) return false
      if (nodeIds.length === 0) return false
      if (!state.copyNodes(nodeIds)) return false
      // Single undo step for the whole multi-cut. `deleteNodes` orders by
      // depth-DESC and skips redundant ids, matching the copy semantics.
      get().deleteNodes(nodeIds)
      return true
    },

    pasteNode: (targetNodeId, placement = 'auto') => {
      const state = get()
      const entry = state.clipboardEntry
      if (!entry || entry.rootNodeIds.length === 0) return null

      const page = getActivePage(state)
      if (!page) return null
      const location = placement === 'after'
        ? resolveSiblingAfterLocation(page, targetNodeId)
        : resolveInsertLocation(page, targetNodeId)
      if (!location) return null

      // One-outlet-per-document invariant: a copied payload can carry a
      // base.outlet (e.g. a whole template section). Pasting it into a
      // document that already has an outlet would mint a second, dead one —
      // same guard as the store's insertNode / duplicateNode chokepoints.
      if (firstOutletId(entry.nodes) !== null && treeHasOutlet(page)) {
        pushToast({
          kind: 'warning',
          title: 'Only one content outlet',
          body: 'The copied nodes include a content outlet and this document already has one.',
          location: 'site-editor',
        })
        return null
      }

      if (!state.site) return null

      // `store-13` — on a studio-imported tree the paste is a SOURCE write (or
      // a refusal), never a snapshot restore: nodes minted from the clipboard
      // carry nanoid ids that no codemod can write back, and the next parse
      // deletes them without a word. Returns true for both of its outcomes;
      // either way nothing is minted here, and the copy that DOES land is
      // selected by the commit's own resync
      // (`pendingCreatedSelection.ts`) rather than at the bottom of this
      // function.
      if (writePasteToSource(entry, location.parentId, location.index)) return null

      // Commit history once; the entire paste — restored classes + every
      // pasted subtree — is a single undo step. The class plan (scoped clone,
      // framework name-match, regular reuse/import) lives in the shared
      // snapshot engine.
      const newRootIds: string[] = []
      mutateSiteState((draft, site) => {
        const draftPage = site.pages.find((p) => p.id === draft.activePageId)
        if (!draftPage) return false

        newRootIds.push(...insertSnapshotSubtrees(
          draftPage,
          site,
          { rootNodeIds: entry.rootNodeIds, nodes: entry.nodes, classes: entry.classes },
          location,
        ))

        return newRootIds.length > 0
      })

      if (newRootIds.length === 0) return null
      // `K7` — the paste IS the new selection, and the inspector follows it.
      // (The studio-imported path returned above; its copy is selected once
      // the source write's resync lands — see `writePasteToSource`.)
      // A pasted node that leaves the ORIGINAL selected is a node the user has
      // to go hunt for in the layer tree before they can style it, and the
      // first thing anyone does after ⌘V is adjust what they just pasted.
      // Selecting here (not at each call site) means the right-click paste,
      // the DOM-panel paste and ⌘V all agree.
      if (newRootIds.length === 1) get().selectNode(newRootIds[0]!)
      else get().selectMany(newRootIds)
      return newRootIds
    },

    clearClipboard: () => {
      set({ clipboardEntry: null })
      clearClipboardPayload()
    },
  }
}
