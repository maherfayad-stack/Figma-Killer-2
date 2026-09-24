/**
 * canvasLayerGestures — the free canvas's four structural gestures (P5-G,
 * FC-3/FC-5): put an element on the empty board, place a loose layer into a
 * frame, lift an element out of a frame onto the board, delete loose layers.
 *
 * ## One gesture = one write = one history entry — holding both halves
 *
 * Every gesture changes the layer's MODULE (a `/save` batch) and its PLACEMENT
 * (`.studio/boards.json`). The placement half is applied HERE, before the
 * write is posted, so the layer is where the user put it the moment its module
 * is read back — and it is handed to the commit twice over:
 *
 *  - as `placements`, recorded on the gesture's structural history entry, so
 *    one ⌘Z takes back the module AND the placement (`structuralSourceHistory.ts`);
 *  - inside a `rollback`, which puts the placement back if the write does not
 *    land (ERR-6). Nothing is left on the board that the files do not say.
 *
 * While the write is on the wire the layer is marked pending, so the heal in
 * `canvasLayerSlice.ts` does not "fix" a placement whose module has not been
 * written yet (or a module whose placement has just gone).
 *
 * ## Queued, never refused, behind another structural write
 *
 * Same rule as `transplantActions.ts` (`store-14`): nothing here is optimistic
 * on the source side, so a second gesture fired before the first one's resync
 * would plan against stale ids. It is parked and re-planned once the first
 * has landed.
 */
import {
  canvasLayerPageId,
  findLayerPlacement,
  getActiveBoard,
  mintCanvasLayerId,
  nextLayerZ,
  type CanvasLayerPlacement,
  type CanvasLayerPlacementChange,
} from '@core/studio-board'
import {
  describeStructuralRefusal,
  previewStructuralLift,
  previewStructuralTransplant,
  type Page,
} from '@core/page-tree'
import {
  commitCanvasLayerCreate,
  commitCanvasLayerDelete,
  commitCanvasLayerLift,
  commitCanvasLayerPlace,
  type CanvasLayerElement,
} from '@site/studio/canvasLayerCommits'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { STRUCTURAL_REFUSAL_TITLE, presentStructuralRefusal } from './site/structuralSourceEdits'
import { mintPendingCommitId, type StructuralCommitRollback } from './site/structuralCommitRollback'
import { clearCanvasLayerPending, markCanvasLayerPending } from './canvasLayerPending'

type Set = Parameters<EditorStoreSliceCreator<EditorStore>>[0]
type Get = Parameters<EditorStoreSliceCreator<EditorStore>>[1]

/** Where a new loose layer goes: board-space top-left, and optionally a host width (a fill-width root). */
export interface CanvasLayerDrop {
  x: number
  y: number
  w?: number
}

/** Where a loose layer lands in a frame — the same shape a cross-frame drop resolves. */
export interface CanvasLayerFrameDrop {
  pageId: string
  parentId: string
  index: number
  copy: boolean
}

export interface CanvasLayerGestures {
  /** Put `element` on the active board's free canvas at `at`. Returns the new layer's id, or `null` with no active board. */
  createCanvasLayer: (element: CanvasLayerElement, at: CanvasLayerDrop) => string | null
  /** Drop a loose layer into a frame. */
  placeCanvasLayer: (layerId: string, destination: CanvasLayerFrameDrop) => void
  /** Drag an element out of `originPageId`'s frame onto the board at `at`. */
  liftNodeToCanvas: (nodeId: string, originPageId: string, at: CanvasLayerDrop, copy: boolean) => void
  /** Delete loose layers — their modules and their placements, as one gesture. */
  removeCanvasLayers: (layerIds: readonly string[]) => void
}

/** The element a layer module returns: the only child of its page's synthetic root. */
export function canvasLayerRootNodeId(page: Page): string | null {
  return page.nodes[page.rootNodeId]?.children[0] ?? null
}

/** A rollback that takes the placement half back if the write does not land. Idempotent with `settle`. */
function placementRollback(get: Get, changes: readonly CanvasLayerPlacementChange[]): StructuralCommitRollback {
  let done = false
  return {
    id: mintPendingCommitId(),
    settle: () => {
      done = true
    },
    rollback: () => {
      if (done) return
      done = true
      get().applyCanvasLayerPlacements(changes, 'before')
    },
  }
}

/**
 * Run one gesture: apply its placement half, mark its layers pending, post it,
 * and release the pending marks only once the whole commit — the write AND the
 * re-read that brings the module back — has finished. Releasing at `settle`
 * (the write landing) would leave a window where the board holds a placement
 * whose module the store has not read yet, and a heal in that window would
 * drop it.
 */
function runPlacementGesture(
  get: Get,
  changes: CanvasLayerPlacementChange[],
  layerIds: readonly string[],
  post: (rollback: StructuralCommitRollback) => Promise<void>,
): void {
  for (const id of layerIds) markCanvasLayerPending(id)
  get().applyCanvasLayerPlacements(changes, 'after')
  void post(placementRollback(get, changes)).finally(() => {
    for (const id of layerIds) clearCanvasLayerPending(id)
  })
}

/** The slot `nodeId` occupies in `page` — `transplantActions.ts`'s `originSlot`, for a lift's undo. */
function originSlot(page: Page, nodeId: string): { parentNodeId: string; index: number } {
  const parentNodeId = page.nodes[nodeId]?.parentId ?? page.rootNodeId
  const index = page.nodes[parentNodeId]?.children.indexOf(nodeId) ?? -1
  return { parentNodeId, index: index < 0 ? Number.MAX_SAFE_INTEGER : index }
}

function placementAt(get: Get, layerId: string, at: CanvasLayerDrop): { boardId: string; placement: CanvasLayerPlacement } | null {
  const state = get()
  const board = getActiveBoard(state.boards, state.activeBoardId)
  if (!board) return null
  return {
    boardId: board.id,
    placement: {
      id: layerId,
      x: Math.round(at.x),
      y: Math.round(at.y),
      ...(at.w !== undefined ? { w: Math.max(1, Math.round(at.w)) } : {}),
      z: nextLayerZ(board),
    },
  }
}

export function createCanvasLayerGestures(set: Set, get: Get): CanvasLayerGestures {
  const gestures: CanvasLayerGestures = {
    createCanvasLayer: (element, at) => {
      if (deferWhileStructuralCommitInFlight(() => void gestures.createCanvasLayer(element, at))) return null
      const layerId = mintCanvasLayerId()
      const target = placementAt(get, layerId, at)
      if (!target) return null
      const changes: CanvasLayerPlacementChange[] = [{ boardId: target.boardId, layerId, before: null, after: target.placement }]
      runPlacementGesture(get, changes, [layerId], (rollback) =>
        commitCanvasLayerCreate({ layerId, element, placements: changes, rollback }),
      )
      return layerId
    },

    placeCanvasLayer: (layerId, destination) => {
      if (deferWhileStructuralCommitInFlight(
        (relocate) => gestures.placeCanvasLayer(layerId, { ...destination, parentId: relocate(destination.parentId) }),
        [destination.parentId],
      )) return

      const state = get()
      const layerPage = state.canvasLayerPages[canvasLayerPageId(layerId)]
      const pageTree = state.site?.pages.find((page) => page.id === destination.pageId) ?? null
      const rootNodeId = layerPage ? canvasLayerRootNodeId(layerPage) : null
      if (!layerPage || !pageTree || !rootNodeId) return

      // The same two-tree rule a frame-to-frame move is gated by: the layer's
      // root leaving its module, the container it would land in.
      const preview = previewStructuralTransplant({
        originTree: layerPage,
        nodeIds: [rootNodeId],
        destinationTree: pageTree,
        newParentId: destination.parentId,
        newIndex: destination.index,
        copy: destination.copy,
      })
      if (!preview.ok) {
        const node = preview.nodeId === undefined ? undefined : (layerPage.nodes[preview.nodeId] ?? pageTree.nodes[preview.nodeId])
        presentStructuralRefusal(
          STRUCTURAL_REFUSAL_TITLE.transplant,
          describeStructuralRefusal({ refusal: preview.refusal, ...(node ? { node } : {}) }),
          { ...(node ? { nodeId: node.id } : {}), getState: get, set },
        )
        return
      }

      const current = findLayerPlacement(state.boards, layerId)
      // A move takes the layer off the board with the write; a copy leaves it.
      const changes: CanvasLayerPlacementChange[] =
        destination.copy || !current ? [] : [{ boardId: current.boardId, layerId, before: current.placement, after: null }]
      if (!destination.copy) get().clearCanvasLayerSelection()
      runPlacementGesture(get, changes, [layerId], (rollback) =>
        commitCanvasLayerPlace({
          layerId,
          rootNodeId,
          parentNodeId: preview.commit.destinationParentNodeId,
          anchorNodeId: preview.commit.anchorNodeId,
          position: preview.commit.position,
          copy: destination.copy,
          placements: changes,
          rollback,
        }),
      )
    },

    liftNodeToCanvas: (nodeId, originPageId, at, copy) => {
      if (deferWhileStructuralCommitInFlight(
        (relocate) => gestures.liftNodeToCanvas(relocate(nodeId), originPageId, at, copy),
        [nodeId],
      )) return

      const state = get()
      const originPage = state.site?.pages.find((page) => page.id === originPageId) ?? null
      if (!originPage) return
      const preview = previewStructuralLift(originPage, [nodeId], copy)
      if (!preview.ok) {
        const node = preview.nodeId === undefined ? undefined : originPage.nodes[preview.nodeId]
        presentStructuralRefusal(
          STRUCTURAL_REFUSAL_TITLE.transplant,
          describeStructuralRefusal({ refusal: preview.refusal, ...(node ? { node } : {}) }),
          { ...(node ? { nodeId: node.id } : {}), getState: get, set },
        )
        return
      }

      const layerId = mintCanvasLayerId()
      const target = placementAt(get, layerId, at)
      if (!target) return
      const changes: CanvasLayerPlacementChange[] = [{ boardId: target.boardId, layerId, before: null, after: target.placement }]
      runPlacementGesture(get, changes, [layerId], (rollback) =>
        commitCanvasLayerLift({
          layerId,
          nodeId: preview.nodeId,
          copy,
          origin: originSlot(originPage, preview.nodeId),
          placements: changes,
          rollback,
        }),
      )
    },

    removeCanvasLayers: (layerIds) => {
      if (layerIds.length === 0) return
      if (deferWhileStructuralCommitInFlight(() => gestures.removeCanvasLayers(layerIds))) return
      const state = get()
      const ids = layerIds.filter((id) => canvasLayerPageId(id) in state.canvasLayerPages)
      if (ids.length === 0) return
      const changes: CanvasLayerPlacementChange[] = []
      for (const id of ids) {
        const current = findLayerPlacement(state.boards, id)
        if (current) changes.push({ boardId: current.boardId, layerId: id, before: current.placement, after: null })
      }
      get().clearCanvasLayerSelection()
      runPlacementGesture(get, changes, ids, (rollback) => commitCanvasLayerDelete({ layerIds: ids, placements: changes, rollback }))
    },
  }
  return gestures
}
