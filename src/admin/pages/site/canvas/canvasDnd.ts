import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'
import {
  getParent,
  previewStructuralMove,
  resolvePageTreeDropTarget,
  type PageTreeDropPosition,
  type PageTreeDropTarget,
} from '@core/page-tree'

interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type CanvasDropAxis = 'vertical' | 'horizontal'

export interface CanvasDropCandidate {
  nodeId: string
  depth: number
  rect: CanvasRect
  axis: CanvasDropAxis
  /**
   * G9 — true when this candidate's parent lays its children out in the
   * REVERSE of DOM child order along `axis` (`flex-direction: row-reverse` /
   * `column-reverse`, or a plain `row` flex container under `direction: rtl`
   * — visual-left is the logical END there). `getCanvasDropZone` flips
   * before/after when this is true, so the drop-zone band still names the
   * correct SIDE OF THE CHILD LIST regardless of which side it renders on
   * screen. Resolved by `resolveCanvasInsertionAxis` in `canvasDomGeometry.ts`.
   * Optional (defaults falsy) so existing test fixtures that don't care about
   * this axis's direction don't need updating.
   */
  reversed?: boolean
}

export interface CanvasDropTarget extends PageTreeDropTarget {
  rect: CanvasRect
  axis: CanvasDropAxis
}

export interface CanvasInsertionTarget {
  parentId: string
  index: number
  position: PageTreeDropPosition
  overId: string
  rect: CanvasRect
  axis: CanvasDropAxis
}

interface CanvasInvalidDropTarget {
  overId: string
  rect: CanvasRect
  axis: CanvasDropAxis
  /**
   * G5 — set when this position is structurally fine (a real candidate, a
   * real index) but the SOURCE WRITE `previewStructuralMove` would refuse —
   * e.g. dragging into a shared component's inlined markup. `undefined` for
   * an ordinary structural rejection (locked node, cycle, non-container),
   * which needs no further explanation than the red drop-invalid box.
   * Surfaced live, while the pointer is still down, instead of a post-hoc
   * toast after `pointerup` — see `previewStructuralMove`'s own doc for why
   * this is not a replacement for the store's own gate, only a preview of it.
   */
  refusalMessage?: string
}

export interface CanvasDropResolution {
  target: CanvasDropTarget | null
  invalid: CanvasInvalidDropTarget | null
}

interface ResolveCanvasDropTargetInput {
  tree: NodeTree<PageNode>
  draggedId: string
  draggedIds: string[]
  candidates: CanvasDropCandidate[]
  point: CanvasPoint
  canHaveChildren: (moduleId: string) => boolean
  /** Live canvas zoom (1 = 100%). See `getCanvasDropZone`. Defaults to 1. */
  zoom?: number
}

interface ResolveCanvasInsertionTargetInput {
  tree: NodeTree<PageNode>
  candidates: CanvasDropCandidate[]
  point: CanvasPoint
  canHaveChildren: (moduleId: string) => boolean
  /** Live canvas zoom (1 = 100%). See `getCanvasDropZone`. Defaults to 1. */
  zoom?: number
}

/**
 * Edge-band bounds, authored in SCREEN pixels — the physical hit-target size
 * a pointer needs, independent of zoom.
 *
 * `candidate.rect` / `point` live in FRAME-space (unscaled) coordinates —
 * already divided by the live canvas zoom, see `clientRectToViewportRect` /
 * `getViewportLocalPoint` in `canvasDomGeometry.ts`. A constant compared
 * directly against frame-space pixels is a screen-space quantity silently
 * treated as a board-space one: at 25% zoom, `8` frame-space px renders as
 * 2 SCREEN px — effectively unhittable, so the pointer almost never lands in
 * the before/after band and every drop resolved as `'inside'`. At 400% zoom
 * the same constant renders as 32 screen px, swallowing most of a leaf
 * node's `'inside'` region.
 *
 * `getCanvasDropZone` converts these SCREEN bounds into frame-space by
 * dividing by the live zoom before clamping, so the on-screen band size is
 * constant across zoom levels.
 */
const MIN_EDGE_HIT_ZONE_SCREEN_PX = 8
const MAX_EDGE_HIT_ZONE_SCREEN_PX = 20
const EDGE_ZONE_RATIO = 0.26

export function getCanvasDropZone(
  candidate: CanvasDropCandidate,
  point: CanvasPoint,
  /**
   * Live canvas zoom (1 = 100%). Defaults to 1 for callers that already
   * operate in a 1:1 frame-space/screen-space world (tests, and any future
   * non-zoomable surface reusing this resolver).
   */
  zoom: number = 1,
): PageTreeDropPosition {
  const { rect, axis, reversed } = candidate
  const size = axis === 'horizontal' ? rect.width : rect.height
  // Guard against 0/negative zoom (unmeasured layout, division by zero).
  const safeZoom = zoom > 0 ? zoom : 1
  const minEdge = MIN_EDGE_HIT_ZONE_SCREEN_PX / safeZoom
  const maxEdge = MAX_EDGE_HIT_ZONE_SCREEN_PX / safeZoom
  const edgeBand = Math.max(minEdge, Math.min(maxEdge, size * EDGE_ZONE_RATIO))
  // G9 — `before`/`after` name a position in DOM CHILD ORDER, not screen
  // position. When the parent renders children in the reverse of DOM order
  // along this axis (`row-reverse`/`column-reverse`, or a plain `row` flex
  // under `direction: rtl`), the SCREEN-space near edge is the DOM-order
  // "after" side — swap the labels so the caller's `resolvePageTreeDropTarget`
  // still lands the drop on the side the user actually pointed at.
  const nearLabel: PageTreeDropPosition = reversed ? 'after' : 'before'
  const farLabel: PageTreeDropPosition = reversed ? 'before' : 'after'

  if (axis === 'horizontal') {
    const offset = point.x - rect.left
    if (offset <= edgeBand) return nearLabel
    if (offset >= rect.width - edgeBand) return farLabel
    return 'inside'
  }

  const offset = point.y - rect.top
  if (offset <= edgeBand) return nearLabel
  if (offset >= rect.height - edgeBand) return farLabel
  return 'inside'
}

export function resolveCanvasDropTarget({
  tree,
  draggedId,
  draggedIds,
  candidates,
  point,
  canHaveChildren,
  zoom = 1,
}: ResolveCanvasDropTargetInput): CanvasDropResolution {
  const candidate = findCanvasDropCandidate(candidates, point)
  if (!candidate) return { target: null, invalid: null }

  const zone = getCanvasDropZone(candidate, point, zoom)
  const target = resolvePageTreeDropTarget({
    tree,
    draggedId,
    draggedIds,
    overId: candidate.nodeId,
    zone,
    canHaveChildren,
  })

  if (!target) {
    return {
      target: null,
      invalid: {
        overId: candidate.nodeId,
        rect: candidate.rect,
        axis: candidate.axis,
      },
    }
  }

  // G5 — the tree-shape check above only asks "does this position exist".
  // Ask the source-writeback question BEFORE returning a valid drop line:
  // half of all shared-component drags on a real imported project refuse
  // post-hoc (`STATE.md`'s `shared-component` finding) — this is what makes
  // the refusal visible while the pointer is still down instead of a toast
  // after release. The store's own gate (`nodeActions.ts`'s `moveNodes`)
  // remains the sole COMMIT-time authority; this is a preview, never a
  // replacement — see `previewStructuralMove`'s own doc.
  const preview = previewStructuralMove(tree, target.draggedIds, target.parentId, target.index)
  if (!preview.ok) {
    return {
      target: null,
      invalid: {
        overId: candidate.nodeId,
        rect: candidate.rect,
        axis: candidate.axis,
        refusalMessage: preview.refusal.message,
      },
    }
  }

  return {
    target: {
      ...target,
      rect: candidate.rect,
      axis: candidate.axis,
    },
    invalid: null,
  }
}

export function resolveCanvasInsertionTarget({
  tree,
  candidates,
  point,
  canHaveChildren,
  zoom = 1,
}: ResolveCanvasInsertionTargetInput): CanvasInsertionTarget | null {
  const candidate = findCanvasDropCandidate(candidates, point)
  if (!candidate) return null

  const zone = getCanvasDropZone(candidate, point, zoom)
  const target = resolvePageTreeInsertionTarget({
    tree,
    overId: candidate.nodeId,
    zone,
    canHaveChildren,
  })
  if (!target) return null

  return {
    ...target,
    rect: candidate.rect,
    axis: candidate.axis,
  }
}

interface ResolvePageTreeInsertionTargetInput {
  tree: NodeTree<PageNode>
  overId: string
  zone: PageTreeDropPosition
  canHaveChildren: (moduleId: string) => boolean
}

function resolvePageTreeInsertionTarget({
  tree,
  overId,
  zone,
  canHaveChildren,
}: ResolvePageTreeInsertionTargetInput): Omit<CanvasInsertionTarget, 'rect' | 'axis'> | null {
  const over = tree.nodes[overId]
  if (!over) return null

  if (overId === tree.rootNodeId) {
    const index = zone === 'before' ? 0 : tree.nodes[tree.rootNodeId]?.children.length ?? 0
    return {
      parentId: tree.rootNodeId,
      index,
      position: zone === 'before' ? 'before' : 'inside',
      overId,
    }
  }

  if (
    zone === 'inside' &&
    canHaveChildren(over.moduleId) &&
    (!over.locked || over.moduleId === 'base.slot-instance')
  ) {
    if (over.moduleId === 'base.visual-component-ref') {
      const slotInstanceChildId = over.children.find(
        (childId) => tree.nodes[childId]?.moduleId === 'base.slot-instance',
      )
      if (slotInstanceChildId) {
        const slot = tree.nodes[slotInstanceChildId]
        return {
          parentId: slotInstanceChildId,
          index: slot?.children.length ?? 0,
          position: 'inside',
          overId,
        }
      }
      return siblingInsertionTarget(tree, overId, 'after')
    }

    return {
      parentId: overId,
      index: over.children.length,
      position: 'inside',
      overId,
    }
  }

  return siblingInsertionTarget(tree, overId, zone === 'before' ? 'before' : 'after')
}

function siblingInsertionTarget(
  tree: NodeTree<PageNode>,
  overId: string,
  position: 'before' | 'after',
): Omit<CanvasInsertionTarget, 'rect' | 'axis'> | null {
  if (overId === tree.rootNodeId) return null
  const parent = getParent(tree, overId)
  if (!parent || parent.locked || parent.moduleId === 'base.visual-component-ref') {
    return null
  }

  const overIndex = parent.children.indexOf(overId)
  if (overIndex === -1) return null

  return {
    parentId: parent.id,
    index: position === 'before' ? overIndex : overIndex + 1,
    position,
    overId,
  }
}

function findCanvasDropCandidate(
  candidates: CanvasDropCandidate[],
  point: CanvasPoint,
): CanvasDropCandidate | null {
  const containing = candidates.filter((candidate) => containsPoint(candidate.rect, point))
  if (containing.length === 0) return null

  return containing.sort((a, b) => {
    const depthDiff = b.depth - a.depth
    if (depthDiff !== 0) return depthDiff
    return area(a.rect) - area(b.rect)
  })[0] ?? null
}

function containsPoint(rect: CanvasRect, point: CanvasPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  )
}

function area(rect: CanvasRect): number {
  return rect.width * rect.height
}
