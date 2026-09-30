/**
 * studioPasteWrites — ⌘V on a studio-imported tree (`store-13`, ERR-7,
 * ERR-8). Split out of `studioSourceWrites.ts` at the module-size ceiling: it
 * is the one writer that has to find its SOURCE on the board before it can
 * plan a write, which none of the others do.
 */
import { decodeSourceNodeId, describeStructuralRefusal, isSourceDerivedNodeId, planListRowCopyTo, type NodeTree, type PageNode } from '@core/page-tree'
import { canvasLayerIdFromRel, canvasLayerPageId } from '@core/studio-board'
import { commitStudioDuplicateTo } from '@site/studio/studioStructuralCommits'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { findUniqueLocation } from '@site/studio/sourceIdentity'
import { STRUCTURAL_REFUSAL_TITLE, planSourceDuplicateTo, planSourceInsert, presentStructuralRefusal } from './structuralSourceEdits'
import { writeListRowPlan } from './listRowSourceWrites'
import { canvasLayerRootNodeId } from '../canvasLayerGestures'
import type { SiteSliceHelpers } from './types'

/** Why a copied root has no source to copy from — see `livePasteSource`. */
type MissingPasteSource = 'not-source' | 'gone'

/** `<svg>`, `<h1>` … — what the user copied, in the words the canvas uses; `''` when the snapshot does not say. */
function copiedElementLabel(node: PageNode | undefined): string {
  // A bare `<svg>` stores `tag: ''` — its `tag` names only an authored WRAPPER.
  const tag = node?.moduleId === 'base.svg' ? node.props.tag || 'svg' : node?.props.tag
  return typeof tag === 'string' && /^[a-z][a-z0-9-]*$/i.test(tag) ? ` (<${tag}>)` : ''
}

/** The refusal sentence for a copied root that cannot be found in the code. */
export function missingPasteSourceMessage(missing: MissingPasteSource, copied: PageNode | undefined): string {
  const what = `What you copied${copiedElementLabel(copied)}`
  return missing === 'not-source'
    ? `${what} is drawn by code rather than written as an element in your files — a component's own markup or a generated row — so Studio has no source to copy. Copy the element that writes it instead.`
    : `${what} is not where it was in your project's code any more — its file changed after the copy — so Studio has no source to copy from, and pasting would put elements on the canvas that the files do not contain. Copy it again, then paste.`
}

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

    const sources: string[] = []
    for (const rootId of clipboard.rootNodeIds) {
      const copied = clipboard.nodes[rootId]
      const found = livePasteSource(rootId, copied?.sourceFingerprint)
      if ('nodeId' in found) {
        sources.push(found.nodeId)
        continue
      }
      // Always `actions: []` — always the toast, never the dialog: there is no
      // node left to offer a remedy against. Two different facts, two
      // sentences: an element that was never written in the code (a
      // component's internals, a generated row) versus one whose file changed
      // since the copy so that it can no longer be found.
      presentStructuralRefusal(
        STRUCTURAL_REFUSAL_TITLE.insert,
        describeStructuralRefusal({ refusal: { reason: 'insert', message: missingPasteSourceMessage(found.missing, copied) } }),
        { getState: get, set },
      )
      return true
    }

    // P5-G — a copied loose layer is the root its module returns. A root has
    // no siblings in its file, so the frame-to-frame transplant cannot read it
    // (`no-jsx-parent`); the free canvas's own write can: `canvas-layer-place`
    // with `copy`, the ⌥-drag of a layer into a frame. Each layer is its own
    // placement (and undo step), landing in clipboard order.
    const layerIds = sources.map(looseLayerOf)
    if (layerIds.some((layerId) => layerId !== null)) {
      const pageId = get().activePageId
      if (layerIds.some((layerId) => layerId === null) || !pageId) {
        presentStructuralRefusal(
          STRUCTURAL_REFUSAL_TITLE.insert,
          describeStructuralRefusal({
            refusal: {
              reason: 'insert',
              message: 'What you copied mixes loose layers from the board with elements from a page. Paste them separately: copy the loose layers on their own, then the page elements.',
            },
          }),
          { getState: get, set },
        )
        return true
      }
      layerIds.forEach((layerId, offset) => {
        get().placeCanvasLayer(layerId!, {
          pageId,
          parentId,
          index: index === undefined ? Number.MAX_SAFE_INTEGER : index + offset,
          copy: true,
        })
      })
      return true
    }

    // OD-8 — copied `.map` rows are pasted into their own list's array.
    const rowNodes = sources.map(nodeOnBoard).filter((node): node is PageNode => node !== undefined)
    const rows = planListRowCopyTo(tree, rowNodes, parentId, index ?? Number.MAX_SAFE_INTEGER)
    if (rows) {
      writeListRowPlan(rows, STRUCTURAL_REFUSAL_TITLE.insert, { get, set })
      return true
    }
    const plan = planSourceDuplicateTo(tree, sources, parentId, index ?? Number.MAX_SAFE_INTEGER, nodeOnBoard)
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

  /**
   * The node with this id anywhere on the board — the active tree first, then
   * any frame (`_nodeIdToPageIds`, O(1)), then a loose layer on the free
   * canvas (P5-G). A layer's element lives in `canvasLayerPages`, never in
   * `site.pages`, so without the last look a copied loose layer read as "not
   * in your project's code any more" although its file was right there.
   */
  const nodeOnBoard = (nodeId: string): PageNode | undefined => {
    const state = get()
    const active = readTree()?.nodes[nodeId]
    if (active) return active
    for (const pageId of state._nodeIdToPageIds.get(nodeId) ?? []) {
      const node = state.site?.pages.find((page) => page.id === pageId)?.nodes[nodeId]
      if (node) return node
    }
    const rel = decodeSourceNodeId(nodeId)?.rel
    const layerId = rel === undefined ? null : canvasLayerIdFromRel(rel)
    return layerId === null ? undefined : state.canvasLayerPages[canvasLayerPageId(layerId)]?.nodes[nodeId]
  }

  /** The loose layer whose ROOT `nodeId` is, or `null` for any other element. */
  const looseLayerOf = (nodeId: string): string | null => {
    const rel = decodeSourceNodeId(nodeId)?.rel
    const layerId = rel === undefined ? null : canvasLayerIdFromRel(rel)
    if (layerId === null) return null
    const layerPage = get().canvasLayerPages[canvasLayerPageId(layerId)]
    return layerPage && canvasLayerRootNodeId(layerPage) === nodeId ? layerId : null
  }

  /**
   * ERR-8 — the id the copied element has on the board NOW: at its copied id
   * when that still holds the same element, else re-found by its fingerprint
   * when exactly one element of its file matches. Otherwise WHY it cannot be
   * copied: it never had a place in the code (`not-source`), or it had one and
   * the file no longer has it where the copy said (`gone`).
   */
  const livePasteSource = (rootId: string, fingerprint: string | undefined): { nodeId: string } | { missing: MissingPasteSource } => {
    if (!isSourceDerivedNodeId(rootId)) return { missing: 'not-source' }
    const there = nodeOnBoard(rootId)
    if (there && (fingerprint === undefined || there.sourceFingerprint === undefined || there.sourceFingerprint === fingerprint)) {
      return { nodeId: rootId }
    }
    const rel = decodeSourceNodeId(rootId)?.rel
    const found = rel && fingerprint ? findUniqueLocation(rel, fingerprint) : null
    return found && nodeOnBoard(found) ? { nodeId: found } : { missing: 'gone' }
  }

  return writePasteToSource
}
