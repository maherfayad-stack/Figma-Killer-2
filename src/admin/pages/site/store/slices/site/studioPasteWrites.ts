/**
 * studioPasteWrites — ⌘V on a studio-imported tree (`store-13`, ERR-7,
 * ERR-8). Split out of `studioSourceWrites.ts` at the module-size ceiling: it
 * is the one writer that has to find its SOURCE on the board before it can
 * plan a write, which none of the others do.
 */
import { decodeSourceNodeId, describeStructuralRefusal, isSourceDerivedNodeId, type NodeTree, type PageNode } from '@core/page-tree'
import { commitStudioDuplicateTo } from '@site/studio/studioStructuralCommits'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { findUniqueLocation } from '@site/studio/sourceIdentity'
import { STRUCTURAL_REFUSAL_TITLE, planSourceDuplicateTo, planSourceInsert, presentStructuralRefusal } from './structuralSourceEdits'
import type { SiteSliceHelpers } from './types'

/** What a paste needs from the clipboard: its roots, and the snapshot that records who each one was (`sourceFingerprint`). */
export interface PasteSource {
  rootNodeIds: readonly string[]
  nodes: Readonly<Record<string, PageNode>>
}

/**
 * `store-13` — ⌘V. `writePasteToSource` is true when the caller must stop:
 * the paste was written to source, or refused out loud. `false` only for an
 * ordinary CMS tree, which takes the clipboard-snapshot path unchanged.
 */
export function createStudioPasteWrite(
  helpers: SiteSliceHelpers,
  readTree: () => NodeTree<PageNode> | null,
): (clipboard: PasteSource, parentId: string, index?: number) => boolean {
  const { get, set } = helpers

  /**
   * `store-13` — ⌘V on a studio-imported tree is a SOURCE write, for the same
   * reason every other gesture in this module is.
   *
   * Paste was the one structural gesture that never asked. It restored the
   * clipboard SNAPSHOT — a set of nodes carrying nanoid ids — straight into
   * the tree, and `saveSite` diffs values only, so nothing about the new
   * elements ever reached the `.tsx`. The honest write is a DUPLICATE-TO: the
   * clipboard's roots are elements that exist in this project's code, and
   * their own source text is copied into the destination container — which is
   * also how a pasted element ends up selected after the resync.
   *
   * ERR-8 — WHERE the copied element is now is resolved at paste time, not
   * assumed to be where it was copied from:
   *
   *  - in this frame, or in ANOTHER frame of the board (`_nodeIdToPageIds`):
   *    copied from there — a container in a different file makes the copy a
   *    transplant, which carries the imports it needs (ERR-16);
   *  - no longer at its copied id because an edit renumbered its file: found
   *    again by its fingerprint, when exactly one element in that file
   *    matches (`findUniqueLocation`).
   *
   * ERR-7 — several roots land as one run, in clipboard order, as one write
   * and one undo entry (`commitStudioDuplicateTo`).
   *
   * What it will NOT do is fall back to the snapshot path on a studio tree.
   * A root that cannot be found on the board any more has no source text to
   * copy, and restoring the snapshot anyway is the orphan this function
   * exists to stop. That refuses, by name.
   */
  const writePasteToSource = (
    clipboard: PasteSource,
    parentId: string,
    index?: number,
  ): boolean => {
    if (clipboard.rootNodeIds.length === 0) return false
    const tree = readTree()
    if (!tree) return false

    // Is this a studio-imported tree at all? `planSourceInsert` answers with
    // `commit: null` for an ordinary CMS container, and that is the ONLY
    // outcome that may take the snapshot path.
    const container = planSourceInsert(tree, parentId, index)
    if (container.ok && !container.commit) return false

    // `store-14` — a paste is as much a real write as a duplicate is, and two
    // in flight would plan against the same unshifted source. Queued, not
    // refused: ⌘V held down pastes N times.
    if (
      deferWhileStructuralCommitInFlight((relocate) => {
        writePasteToSource(clipboard, relocate(parentId), index)
      }, [parentId])
    ) {
      return true
    }

    if (!container.ok) {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, container.constraint, {
        nodeId: container.nodeId,
        retry: (mapId) => { writePasteToSource(clipboard, mapId(parentId), index) },
        getState: get,
        set,
      })
      return true
    }

    const sources = clipboard.rootNodeIds.map((rootId) => livePasteSource(rootId, clipboard.nodes[rootId]?.sourceFingerprint))
    if (sources.some((source) => source === null)) {
      // Always `actions: []` — always the toast, never the dialog: there is no
      // node left to offer a remedy against.
      presentStructuralRefusal(
        STRUCTURAL_REFUSAL_TITLE.insert,
        describeStructuralRefusal({
          refusal: {
            reason: 'insert',
            message:
              'What you copied is not in your project’s code any more, so Studio has no source to copy from — pasting it would put elements on the canvas that the files do not contain. Copy it again and paste it.',
          },
        }),
        { getState: get, set },
      )
      return true
    }

    const plan = planSourceDuplicateTo(tree, sources as string[], parentId, index ?? Number.MAX_SAFE_INTEGER, nodeOnBoard)
    if (!plan.ok) {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
        nodeId: plan.nodeId,
        getState: get,
        set,
      })
      return true
    }
    // `commit: null` here would mean "not a source-derived tree", which the
    // container check above already ruled out.
    if (plan.commit) void commitStudioDuplicateTo(plan.commit)
    return true
  }

  /** The node with this id on ANY frame of the board — the active tree first, then `_nodeIdToPageIds` (O(1)). */
  const nodeOnBoard = (nodeId: string): PageNode | undefined => {
    const state = get()
    const active = readTree()?.nodes[nodeId]
    if (active) return active
    for (const pageId of state._nodeIdToPageIds.get(nodeId) ?? []) {
      const node = state.site?.pages.find((page) => page.id === pageId)?.nodes[nodeId]
      if (node) return node
    }
    return undefined
  }

  /**
   * ERR-8 — the id the copied element has on the board NOW, or `null`: at its
   * copied id when that still holds the same element, else re-found by its
   * fingerprint when exactly one element of its file matches.
   */
  const livePasteSource = (rootId: string, fingerprint: string | undefined): string | null => {
    if (!isSourceDerivedNodeId(rootId)) return null
    const there = nodeOnBoard(rootId)
    if (there && (fingerprint === undefined || there.sourceFingerprint === undefined || there.sourceFingerprint === fingerprint)) {
      return rootId
    }
    const rel = decodeSourceNodeId(rootId)?.rel
    const found = rel && fingerprint ? findUniqueLocation(rel, fingerprint) : null
    return found && nodeOnBoard(found) ? found : null
  }

  return writePasteToSource
}
