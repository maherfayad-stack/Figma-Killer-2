/**
 * canvasLayerCommits — the free canvas's structural commits (P5-G, FC-3):
 * create, place, lift and delete a loose layer.
 *
 * Each is ONE `/save` batch through `commitStructural` — the same queue, the
 * same P1-A identity capture, the same ERR-6 retry and rollback, the same
 * narrow resync — carrying one of `studioCanvasLayerWriteback.ts`'s edit kinds.
 * What makes them different from every other structural commit is the second
 * half of the gesture: a loose layer's PLACEMENT lives in `.studio/boards.json`,
 * so each commit also carries the placement change it made
 * (`undo.placements`), and one ⌘Z takes back both.
 *
 * The store action that calls these (`canvasLayerSlice.ts`) has already put the
 * placement in place and hands over a `rollback` that takes it back if the
 * write does not land. Nothing here touches the store — the same one-way rule
 * `studioStructuralCommits.ts` follows, for the same import-cycle reason.
 *
 * P3-A — no commit announces a success: the layer appearing (or leaving) IS
 * the answer.
 */
import { canvasLayerEditNodeId, type CanvasLayerPlacementChange } from '@core/studio-board'
import type { StructuralCommitRollback } from '@site/store/slices/site/structuralCommitRollback'
import { commitStructural } from './studioStructuralCommits'
import type { InsertPropValue } from './studioSaveRequests'

/** A new layer's root element — `insert`'s element fields. */
export interface CanvasLayerElement {
  name: string
  importSpecifier?: string
  designSystemImport?: true
  props?: Record<string, InsertPropValue>
  children?: string
}

interface CanvasLayerCommitBase {
  layerId: string
  /** The placement half of the gesture, already applied — recorded for undo/redo. */
  placements: CanvasLayerPlacementChange[]
  rollback: StructuralCommitRollback
}

/** An element placed on the empty board — an image dropped there, for one. */
export async function commitCanvasLayerCreate(input: CanvasLayerCommitBase & { element: CanvasLayerElement }): Promise<void> {
  await commitStructural(
    [{ kind: 'canvas-layer-create', nodeId: canvasLayerEditNodeId(input.layerId), layerId: input.layerId, element: input.element }],
    'Could not put that on the canvas',
    {
      undo: { label: 'Add to canvas', template: { kind: 'canvas-layer-delete', layerId: input.layerId }, placements: input.placements },
      rollback: input.rollback,
    },
  )
}

/**
 * A loose layer dropped into a frame. A move takes the layer off the canvas
 * (its module is removed by the same write); a copy (Alt) leaves it.
 */
export async function commitCanvasLayerPlace(
  input: CanvasLayerCommitBase & {
    rootNodeId: string
    parentNodeId: string
    anchorNodeId: string | null
    position: 'before' | 'after'
    copy: boolean
  },
): Promise<void> {
  await commitStructural(
    [
      {
        kind: 'canvas-layer-place',
        nodeId: input.rootNodeId,
        layerId: input.layerId,
        parentNodeId: input.parentNodeId,
        ...(input.anchorNodeId ? { anchorNodeId: input.anchorNodeId, position: input.position } : {}),
        ...(input.copy ? { copy: true } : {}),
      },
    ],
    'Could not place that into the frame',
    {
      undo: {
        label: input.copy ? 'Copy into frame' : 'Place into frame',
        template: input.copy ? { kind: 'delete-created' } : { kind: 'canvas-layer-unplace', layerId: input.layerId },
        placements: input.placements,
      },
      rollback: input.rollback,
    },
  )
}

/**
 * An element dragged out of a frame onto the empty board. `origin` is where it
 * was written — the whole of a MOVE's undo, recorded as parent + index for
 * `commitStudioTransplant`'s reason (every sibling below it shifts up when it
 * leaves, so a sibling id captured now would be stale by ⌘Z).
 */
export async function commitCanvasLayerLift(
  input: CanvasLayerCommitBase & { nodeId: string; copy: boolean; origin: { parentNodeId: string; index: number } },
): Promise<void> {
  await commitStructural(
    [{ kind: 'canvas-layer-lift', nodeId: input.nodeId, layerId: input.layerId, ...(input.copy ? { copy: true } : {}) }],
    'Could not put that on the canvas',
    {
      undo: {
        label: input.copy ? 'Copy onto canvas' : 'Move onto canvas',
        template: input.copy
          ? { kind: 'canvas-layer-delete', layerId: input.layerId }
          : { kind: 'canvas-layer-lift-back', layerId: input.layerId, parentNodeId: input.origin.parentNodeId, index: input.origin.index },
        placements: input.placements,
      },
      rollback: input.rollback,
    },
  )
}

/** Loose layers deleted. Their bytes come back in the write's `removed`, which is what ⌘Z writes back. */
export async function commitCanvasLayerDelete(
  input: { layerIds: string[]; placements: CanvasLayerPlacementChange[]; rollback: StructuralCommitRollback },
): Promise<void> {
  if (input.layerIds.length === 0) return
  await commitStructural(
    input.layerIds.map((layerId) => ({ kind: 'canvas-layer-delete', nodeId: canvasLayerEditNodeId(layerId), layerId })),
    'Could not delete that from the canvas',
    {
      undo: {
        label: input.layerIds.length === 1 ? 'Delete from canvas' : `Delete ${input.layerIds.length} canvas layers`,
        template: { kind: 'canvas-layer-restore-removed', layerIds: [...input.layerIds] },
        placements: input.placements,
      },
      rollback: input.rollback,
    },
  )
}
