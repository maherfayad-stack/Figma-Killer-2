/**
 * canvasLayerSlice — the free canvas's editor state (P5-G, FC-3).
 *
 * A loose layer is two things, kept in two places on purpose (design §1.3):
 *
 *  - its CONTENT — a parsed `.studio/canvas/<id>.tsx`, held here in
 *    `canvasLayerPages` keyed by its `canvas:<id>` page id;
 *  - its PLACEMENT — board furniture in `.studio/boards.json`
 *    (`Board.layers`), held by `boardSlice` like frames and notes.
 *
 * ## Why the content is NOT in `site.pages`
 *
 * `site` is the `SiteDocument`: the page list, the frame picker, the prototype
 * panel, publish, the agent's `studio_list_pages` all read it. Keeping the
 * layers in a separate field is what makes "never part of a page, the live
 * preview or a publish" hold by construction rather than by a filter every
 * one of those readers would have to remember (design §6.1).
 * `selectCanvasPageFor` (`store.ts`) is the one reader that consults this map,
 * because it is what a `NodeRenderer` inside the free-canvas surface uses to
 * resolve its node.
 *
 * ## Selection
 *
 * `selectedCanvasLayerIds` is its own list, like `selectedFrameIds` and
 * `selectedAnnotations`: a loose layer is board furniture you move, place and
 * delete as a whole. Selecting one clears the other three; `clearAllSelections`
 * clears it (`boardAnnotationSliceActions.ts`). Editing a loose layer's CONTENT
 * with the inspector is FC-7's work and is not wired yet — see
 * `docs/features/free-canvas.md`.
 *
 * ## Heal
 *
 * The two halves are written by two different writes (a `/save` for the
 * module, the board autosave for the placement), so they can disagree after a
 * crash, a failed autosave or an outside edit. {@link healCanvasLayerPlacements}
 * reconciles silently whenever both halves are loaded: a placement whose module
 * is gone is dropped, and a module with no placement gets one on the active
 * board, beside the board's content. Nothing is shown as an error and no file
 * is ever deleted by a heal (design §3.4). A layer whose own gesture is still on
 * the wire is left alone (`canvasLayerPending.ts`).
 */
import type { Draft } from 'mutative'
import { getNodeDisplayName, type Page } from '@core/page-tree'
import { registry } from '@core/module-engine'
import {
  FRAME_HEADER_HEIGHT,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  applyPlacementChanges,
  boardLayers,
  getActiveBoard,
  moveLayerPlacements,
  removeLayerPlacements,
  renameLayerPlacement,
  reorderLayerPlacements,
  upsertBoard,
  upsertLayerPlacement,
  type Board,
  type BoardsFile,
  type CanvasLayerPlacementChange,
} from '@core/studio-board'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { commitBoardChange } from './boardHistory'
import { isCanvasLayerPending } from './canvasLayerPending'
import { createCanvasLayerGestures, type CanvasLayerGestures } from './canvasLayerGestures'

/** One loose layer as a load hands it over. */
export interface CanvasLayerContent {
  layerId: string
  pageId: string
  page: Page
}


interface CanvasLayerSlice extends CanvasLayerGestures {
  /** Parsed layer modules, keyed `canvas:<id>`. Never part of `site`. */
  canvasLayerPages: Record<string, Page>
  /** True once any load has delivered the layer list (possibly empty). */
  canvasLayersLoaded: boolean
  /** Loose layers selected on the board (layer ids). A fourth selection list — see the module doc. */
  selectedCanvasLayerIds: string[]
  /** Replace the layer content wholesale from a load (full or narrowed — both carry every layer). */
  setCanvasLayers: (layers: readonly CanvasLayerContent[]) => void
  selectCanvasLayer: (layerId: string, mode?: 'replace' | 'toggle') => void
  clearCanvasLayerSelection: () => void
  /** Move placements to absolute board positions as ONE undoable board entry (a drag, a nudge burst). */
  moveCanvasLayers: (moves: ReadonlyMap<string, { x: number; y: number }>, coalesceKey: string | null) => void
  /** Name a loose layer in the Layers panel; an empty name goes back to the element's own. One undoable board entry. */
  renameCanvasLayer: (layerId: string, name: string) => void
  /**
   * Move a loose layer to `toIndex` in paint order (0 = lowest) - the Layers
   * panel lists them top-down, so its row `i` of `n` is paint index `n - 1 - i`.
   * One undoable board entry.
   */
  reorderCanvasLayer: (layerId: string, toIndex: number) => void
  /**
   * Put placements to one side of a recorded change WITHOUT a history entry —
   * a canvas-layer gesture's own placement half (applied with its source write,
   * taken back with its rollback, replayed by its undo/redo).
   */
  applyCanvasLayerPlacements: (changes: readonly CanvasLayerPlacementChange[], side: 'before' | 'after') => void
  /** Reconcile placements with modules — see the module doc. A no-op until both halves have loaded. */
  healCanvasLayerPlacements: () => void
}

declare module '@site/store/types' {
  interface EditorStore extends CanvasLayerSlice {}
}


const EMPTY: string[] = []

export const createCanvasLayerSlice: EditorStoreSliceCreator<CanvasLayerSlice> = (set, get) => ({
  canvasLayerPages: {},
  canvasLayersLoaded: false,
  selectedCanvasLayerIds: EMPTY,
  ...createCanvasLayerGestures(set, get),

  setCanvasLayers: (layers) => {
    const next: Record<string, Page> = {}
    for (const layer of layers) next[layer.pageId] = layer.page
    set((state) => {
      state.canvasLayerPages = next as Draft<Record<string, Page>>
      state.canvasLayersLoaded = true
      // A layer that is gone cannot stay selected.
      if (state.selectedCanvasLayerIds.length > 0) {
        const kept = state.selectedCanvasLayerIds.filter((id) => `canvas:${id}` in next)
        if (kept.length !== state.selectedCanvasLayerIds.length) state.selectedCanvasLayerIds = kept
      }
    })
    get().healCanvasLayerPlacements()
  },

  selectCanvasLayer: (layerId, mode = 'replace') => {
    const state = get()
    const current = state.selectedCanvasLayerIds
    const next =
      mode === 'toggle'
        ? current.includes(layerId)
          ? current.filter((id) => id !== layerId)
          : [...current, layerId]
        : [layerId]
    // Mutually exclusive with the other three lists — one inspector at a time.
    if (state.selectedNodeIds.length > 0 || state.selectedNodeId !== null) state.clearSelection()
    if (state.selectedFrameIds.length > 0) state.clearFrameSelection()
    set((draft) => {
      if (draft.selectedAnnotations.length > 0) draft.selectedAnnotations = []
      draft.selectedCanvasLayerIds = next
    })
  },

  clearCanvasLayerSelection: () => {
    if (get().selectedCanvasLayerIds.length === 0) return
    set({ selectedCanvasLayerIds: EMPTY })
  },

  moveCanvasLayers: (moves, coalesceKey) => {
    const { boards } = get()
    let next: BoardsFile = boards
    for (const board of boards.boards) {
      const moved = moveLayerPlacements(board, moves)
      if (moved !== board) next = upsertBoard(next, moved)
    }
    if (next !== boards) commitBoardChange(set, get, coalesceKey, next)
  },

  renameCanvasLayer: (layerId, name) => {
    const { boards } = get()
    let next: BoardsFile = boards
    for (const board of boards.boards) {
      const renamed = renameLayerPlacement(board, layerId, name)
      if (renamed !== board) next = upsertBoard(next, renamed)
    }
    if (next !== boards) commitBoardChange(set, get, null, next)
  },

  reorderCanvasLayer: (layerId, toIndex) => {
    const { boards } = get()
    let next: BoardsFile = boards
    for (const board of boards.boards) {
      const reordered = reorderLayerPlacements(board, layerId, toIndex)
      if (reordered !== board) next = upsertBoard(next, reordered)
    }
    if (next !== boards) commitBoardChange(set, get, null, next)
  },

  applyCanvasLayerPlacements: (changes, side) => {
    const { boards } = get()
    const next = applyPlacementChanges(boards, changes, side)
    if (next === boards) return
    set((state) => {
      state.boards = next as Draft<BoardsFile>
      state.boardsDirty = true
    })
  },

  healCanvasLayerPlacements: () => {
    const state = get()
    if (!state.boardsLoaded || state.boardsLoadFailed || !state.canvasLayersLoaded) return
    const next = healPlacements(state.boards, state.activeBoardId, new Set(Object.keys(state.canvasLayerPages)))
    if (next === state.boards) return
    set((draft) => {
      draft.boards = next as Draft<BoardsFile>
      draft.boardsDirty = true
    })
  },
})

/**
 * What the Layers panel calls a loose layer: the name it was given, else its
 * root element's own name (`Button`, `div`), else `Layer`. A string, so a row
 * subscribing to it wakes only when its own label changes.
 */
export function canvasLayerDisplayName(
  state: Pick<EditorStore, 'canvasLayerPages' | 'boards'>,
  layerId: string,
): string {
  for (const board of state.boards.boards) {
    const named = boardLayers(board).find((layer) => layer.id === layerId)?.name
    if (named) return named
  }
  const page = state.canvasLayerPages[`canvas:${layerId}`]
  // A layer page is the synthetic body around its one element: name the element.
  const body = page?.nodes[page.rootNodeId]
  const root = body?.moduleId === 'base.body' ? page?.nodes[body.children[0] ?? ''] : body
  return root ? getNodeDisplayName(root, registry.get(root.moduleId), undefined) : 'Layer'
}

/** The heal itself, pure — see the module doc. */
export function healPlacements(
  boards: BoardsFile,
  activeBoardId: string | null,
  layerPageIds: ReadonlySet<string>,
): BoardsFile {
  let next = boards
  const placed = new Set<string>()
  for (const board of boards.boards) {
    const orphans = new Set<string>()
    for (const layer of boardLayers(board)) {
      placed.add(layer.id)
      if (!layerPageIds.has(`canvas:${layer.id}`) && !isCanvasLayerPending(layer.id)) orphans.add(layer.id)
    }
    if (orphans.size > 0) next = upsertBoard(next, removeLayerPlacements(board, orphans))
  }
  const unplaced = [...layerPageIds]
    .map((pageId) => pageId.slice('canvas:'.length))
    .filter((id) => !placed.has(id) && !isCanvasLayerPending(id))
  const active = getActiveBoard(next, activeBoardId)
  if (unplaced.length === 0 || !active) return next
  const slot = freeSlotBeside(active)
  let board: Board = active
  unplaced.forEach((id, index) => {
    board = upsertLayerPlacement(board, { id, x: slot.x, y: slot.y + index * 40 })
  })
  return upsertBoard(next, board)
}

/** The first spot to the right of everything on the board — where a found-again layer lands. */
function freeSlotBeside(board: Board): { x: number; y: number } {
  let right = 0
  let top = Number.POSITIVE_INFINITY
  for (const frame of board.frames) {
    right = Math.max(right, frame.x + (frame.width ?? FRAME_WIDTH))
    top = Math.min(top, frame.y)
  }
  for (const layer of boardLayers(board)) {
    right = Math.max(right, layer.x + (layer.w ?? 0) + 200)
    top = Math.min(top, layer.y)
  }
  return { x: right + 80, y: Number.isFinite(top) ? top + FRAME_HEADER_HEIGHT : FRAME_HEIGHT / 4 }
}
