/**
 * canvasLayerDropPreview — what a loose layer dragged over a FRAME would do on
 * release (P5-G, FC-5 G8), resolved while the pointer is still down.
 *
 * It is the OS-file drop's question (`canvasFileDragPreview.ts`) with a
 * different payload: which frame is under the pointer, which container and
 * index in it, and is that a place the layer's root can be written. The frame
 * half reuses the element drag's own board machinery (`resolveForeignFrameDrop`
 * — one rect per frame per gesture, candidates measured once on entry), and
 * the verdict is `previewStructuralTransplant`, the SAME rule the store's
 * `placeCanvasLayer` gates the write on — so the line painted and the write
 * made cannot disagree.
 *
 * READ phase only: it measures and decides, and returns the paint. The caller
 * writes it (`canvasDragPainter.ts`) after every read of the frame is done.
 */
import { previewStructuralTransplant, type NodeTree, type PageNode } from '@core/page-tree'
import { resolveCanvasInsertionTarget } from '../canvasDnd'
import { refreshBoardDropSurfaces, resolveForeignFrameDrop, type BoardDropSurfaces, type ForeignFrameDrop } from '../canvasDragBoard'
import type { CanvasDragPaint } from '../canvasDragPainter'
import { indexLocalPoint, type ClientPoint } from '../canvasDragSession'
import { canHaveChildren } from '../canvasFileDrop'
import type { CanvasTransform } from '../math'

/** Where the layer would land, when it can. */
export interface CanvasLayerFrameTarget {
  pageId: string
  parentId: string
  index: number
}

export interface CanvasLayerDropState {
  board: BoardDropSurfaces
  frame: ForeignFrameDrop | null
}

export interface CanvasLayerDropResolution {
  /** The frame layer to paint into, or `null` over the empty board. */
  layer: HTMLElement | null
  paint: CanvasDragPaint | null
  /** A drop the store will take, or `null` (over the board, or a refused position). */
  target: CanvasLayerFrameTarget | null
}

export function resolveCanvasLayerDrop(
  state: CanvasLayerDropState,
  env: {
    point: ClientPoint
    transform: CanvasTransform | null
    readPage: (pageId: string) => NodeTree<PageNode> | null
    /** The dragged layer's own tree and root — the origin half of the verdict. */
    layerTree: NodeTree<PageNode>
    rootNodeId: string
    copy: boolean
  },
): CanvasLayerDropResolution {
  state.board = refreshBoardDropSurfaces(state.board, env.transform)
  const frame = resolveForeignFrameDrop(state.board, env.point, null, state.frame, env.transform, env.readPage)
  state.frame = frame
  if (!frame) return { layer: null, paint: null, target: null }

  const point = indexLocalPoint(frame.index, env.point)
  const target = resolveCanvasInsertionTarget({
    tree: frame.tree,
    candidates: frame.index.candidates,
    point,
    zoom: frame.index.scale,
    canHaveChildren,
  })
  const verdict = target
    ? previewStructuralTransplant({
        originTree: env.layerTree,
        nodeIds: [env.rootNodeId],
        destinationTree: frame.tree,
        newParentId: target.parentId,
        newIndex: target.index,
        copy: env.copy,
      })
    : null
  const refusal = !target ? 'Nothing here can hold it' : verdict && !verdict.ok ? verdict.refusal.message : null

  return {
    layer: frame.surface.dropLayer(),
    paint: {
      target: refusal || !target ? null : { rect: target.rect, axis: target.axis, position: target.position },
      invalid: refusal && target ? { overId: target.overId, rect: target.rect, axis: target.axis } : null,
      ghost: {
        point,
        label: refusal ? shortRefusal(refusal) : env.copy ? 'Copy into frame' : 'Place into frame',
        duplicating: env.copy,
        ...(refusal ? { refusing: true } : {}),
      },
    },
    target: refusal || !target ? null : { pageId: frame.pageId, parentId: target.parentId, index: target.index },
  }
}

/** A chip is read at a glance next to a moving pointer: the refusal's first clause only. */
function shortRefusal(message: string): string {
  const clause = message.split(/[.:—]/)[0]?.trim() ?? message
  return clause.length > 60 ? `${clause.slice(0, 57)}…` : clause
}
