import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'
import {
  explainGestureConstraint,
  getParent,
  isResolvedByInstanceDetach,
  previewStructuralMove,
  previewStructuralTransplant,
  resolvePageTreeDropTarget,
  type EditConstraint,
  type PageTreeDropPosition,
  type PageTreeDropTarget,
  type StructuralTransplantPreview,
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

/**
 * The three fields the drop LINE is drawn from — everything
 * `canvasDragPainter` may read of a resolved target, and nothing more.
 *
 * Deliberately narrower than either resolution type that satisfies it: a
 * same-frame `CanvasDropTarget` carries `draggedIds`/`parentId` for the
 * commit, a cross-frame `CanvasTransplantTarget` carries a position in a
 * different tree entirely, and neither is anything a painter should be able
 * to reach. It lives HERE rather than beside the painter because the geometry
 * module reads it too, and the painter importing that module makes the other
 * direction a cycle.
 */
export interface CanvasDragPaintTarget {
  rect: CanvasRect
  axis: CanvasDropAxis
  position: PageTreeDropPosition
}

export interface CanvasInsertionTarget {
  parentId: string
  index: number
  position: PageTreeDropPosition
  overId: string
  rect: CanvasRect
  axis: CanvasDropAxis
  /** The candidate's flow runs against child order (`row-reverse`, rtl): `before` is its visually-far edge. */
  reversed?: boolean
  /**
   * Set when the drop lands in a flow container's own space at a child index
   * (`position: 'inside'` over the container itself): the line where the
   * element will sit among its children, in the same space as `rect`. The
   * painter draws THIS instead of outlining the whole container.
   */
  gap?: { rect: CanvasRect; axis: CanvasDropAxis }
}

export interface CanvasInvalidDropTarget {
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
   *
   * The full `EditConstraint` (`explainGestureConstraint`, the translation
   * this preview verdict was built for), not just its sentence: the overlay
   * renders the sentence beside the cursor, and the same object is what a
   * post-drop surface would need to offer the way forward.
   */
  constraint?: EditConstraint
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

/**
 * Where a cross-frame drop would land, in the DESTINATION tree's own terms.
 * Structurally identical to {@link CanvasInsertionTarget} because the question
 * is the same one — see `resolveCanvasTransplantTarget` — and named separately
 * because a reader tracing a DRAG should not have to know that.
 */
export interface CanvasTransplantTarget {
  parentId: string
  index: number
  position: PageTreeDropPosition
  overId: string
  rect: CanvasRect
  axis: CanvasDropAxis
}

export interface CanvasTransplantResolution {
  target: CanvasTransplantTarget | null
  invalid: CanvasInvalidDropTarget | null
}

interface ResolveCanvasTransplantTargetInput {
  /** The tree the dragged element is written in. */
  originTree: NodeTree<PageNode>
  /** The tree the pointer is currently over — a DIFFERENT page. */
  destinationTree: NodeTree<PageNode>
  /** The dragged selection, in the origin tree's terms. */
  draggedIds: readonly string[]
  candidates: CanvasDropCandidate[]
  point: CanvasPoint
  canHaveChildren: (moduleId: string) => boolean
  /** Alt held: the drop copies across frames instead of moving. */
  copy: boolean
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
  // OD-7 — a move inside a shared component is written to THIS instance
  // (detach, then move) — a drop line, not a refusal.
  if (!preview.ok && !isResolvedByInstanceDetach(preview.refusal.reason)) {
    // The refusal is about the DRAGGED element, not the candidate under the
    // pointer — that is whose source position the explanation names and whose
    // `rel:line:col` a jump would open.
    const dragged = tree.nodes[target.draggedIds[0] ?? draggedId] ?? { id: draggedId }
    const constraint = explainGestureConstraint(preview, dragged)
    return {
      target: null,
      invalid: {
        overId: candidate.nodeId,
        rect: candidate.rect,
        axis: candidate.axis,
        ...(constraint ? { constraint } : {}),
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

/**
 * D2 G3 — where a drag that crossed into ANOTHER frame would land, and
 * whether it would be refused.
 *
 * **Resolution is an INSERT's question, not a move's.** The dragged element is
 * not in this tree at all, so `resolvePageTreeDropTarget`'s cycle and
 * self-drop guards have nothing to check and its `draggedIds` have no meaning
 * here. What the destination is being asked is exactly what the picker asks —
 * "which container, and where among its children" — which is
 * `resolveCanvasInsertionTarget`, already built for that question.
 *
 * **The verdict is `previewStructuralTransplant`'s**, and it is asked WHILE
 * THE POINTER IS STILL DOWN for the reason `resolveCanvasDropTarget` documents
 * for its own preview: a refusal that only arrives as a toast after release
 * reaches the user once they have let go and moved on. The store's own gate
 * (`transplantNodes`) remains the sole commit-time authority; this is a
 * preview of it, never a replacement.
 */
export function resolveCanvasTransplantTarget({
  originTree,
  destinationTree,
  draggedIds,
  candidates,
  point,
  canHaveChildren,
  copy,
  zoom = 1,
}: ResolveCanvasTransplantTargetInput): CanvasTransplantResolution {
  const candidate = findCanvasDropCandidate(candidates, point)
  if (!candidate) return { target: null, invalid: null }

  const zone = getCanvasDropZone(candidate, point, zoom)
  const verdict = resolveTransplantDropOver({
    originTree,
    destinationTree,
    draggedIds,
    overId: candidate.nodeId,
    zone,
    canHaveChildren,
    copy,
  })
  if (!verdict.target) {
    return { target: null, invalid: { overId: candidate.nodeId, rect: candidate.rect, axis: candidate.axis } }
  }
  if (verdict.preview && !verdict.preview.ok) {
    const preview = verdict.preview
    // The refusal names one end of the gesture; the chip is rendered beside
    // the pointer either way, so the node it is dressed against is whichever
    // `previewStructuralTransplant` says it is about.
    const about =
      (preview.nodeId === undefined
        ? undefined
        : (originTree.nodes[preview.nodeId] ?? destinationTree.nodes[preview.nodeId])) ??
      originTree.nodes[draggedIds[0] ?? ''] ?? { id: draggedIds[0] ?? '' }
    const constraint = explainGestureConstraint(preview, about)
    return {
      target: null,
      invalid: {
        overId: candidate.nodeId,
        rect: candidate.rect,
        axis: candidate.axis,
        ...(constraint ? { constraint } : {}),
      },
    }
  }

  return { target: { ...verdict.target, rect: candidate.rect, axis: candidate.axis }, invalid: null }
}

interface ResolveTransplantDropOverInput {
  originTree: NodeTree<PageNode>
  destinationTree: NodeTree<PageNode>
  draggedIds: readonly string[]
  /** The destination node the pointer is over. */
  overId: string
  zone: PageTreeDropPosition
  canHaveChildren: (moduleId: string) => boolean
  copy: boolean
}

/**
 * The ONE cross-page drop question, asked by the canvas (pointer over a frame)
 * and by the Layers panel (pointer over another page's row): given the node
 * under the pointer and the zone of it, which container and index in the
 * DESTINATION tree, and would `transplantNodes` accept it?
 *
 * `target` is `null` when the destination has no valid position there at all;
 * `preview` is the store gate's own verdict for a position that exists, and a
 * refusal in it carries the sentence both surfaces show while the pointer is
 * down. Geometry (rects, axis) is deliberately not part of this: it is the
 * canvas's.
 */
export function resolveTransplantDropOver({
  originTree,
  destinationTree,
  draggedIds,
  overId,
  zone,
  canHaveChildren,
  copy,
}: ResolveTransplantDropOverInput): {
  target: Omit<CanvasInsertionTarget, 'rect' | 'axis'> | null
  preview: StructuralTransplantPreview | null
} {
  const target = resolvePageTreeInsertionTarget({
    tree: destinationTree,
    overId,
    zone,
    canHaveChildren,
  })
  if (!target) return { target: null, preview: null }
  const preview = previewStructuralTransplant({
    originTree,
    nodeIds: draggedIds,
    destinationTree,
    newParentId: target.parentId,
    newIndex: target.index,
    copy,
  })
  return { target, preview }
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
    nearerSide: nearerSiblingSide(candidate, point),
    canHaveChildren,
  })
  if (!target) return null

  // A press in a container's own empty space lands among its children where
  // the pointer is, not always at the end (Figma's auto-layout insert).
  const index =
    target.position === 'inside' && target.overId === target.parentId
      ? nearestFlowIndex(tree, target.parentId, candidates, point)
      : target.index

  const gap =
    target.position === 'inside' && target.overId === target.parentId && index !== null
      ? flowGapLine(tree, target.parentId, candidates, index, candidate)
      : null

  return {
    ...target,
    index: index ?? target.index,
    rect: candidate.rect,
    axis: candidate.axis,
    ...(candidate.reversed ? { reversed: true } : {}),
    ...(gap ? { gap } : {}),
  }
}

/**
 * The insertion line for child index `index` of a flow container: across the
 * container for stacked children, down the row for side-by-side ones, centred
 * in the space between the neighbours it falls between (or at the edge of the
 * only neighbour for the first and last slots). `null` when no neighbour was
 * measured — there is no gap to point at, and the container outline stays.
 */
function flowGapLine(
  tree: NodeTree<PageNode>,
  containerId: string,
  candidates: readonly CanvasDropCandidate[],
  index: number,
  container: CanvasDropCandidate,
): { rect: CanvasRect; axis: CanvasDropAxis } | null {
  const children = tree.nodes[containerId]?.children ?? []
  const byId = new Map(candidates.map((candidate) => [candidate.nodeId, candidate]))
  const before = index > 0 ? byId.get(children[index - 1]!) : undefined
  const after = byId.get(children[index] ?? '')
  const neighbours = [before, after].filter((candidate): candidate is CanvasDropCandidate => candidate !== undefined)
  const axis = neighbours[0]?.axis
  if (!axis) return null
  const reversed = neighbours[0]?.reversed === true
  // Visual order along the axis: a reversed flow puts the later child first.
  const [first, second] = reversed ? [after, before] : [before, after]
  const edge = (candidate: CanvasDropCandidate | undefined, side: 'start' | 'end'): number | null => {
    if (!candidate) return null
    const { rect } = candidate
    if (axis === 'vertical') return side === 'start' ? rect.top : rect.bottom
    return side === 'start' ? rect.left : rect.right
  }
  const lead = edge(first, 'end')
  const trail = edge(second, 'start')
  const at = lead !== null && trail !== null ? (lead + trail) / 2 : (lead ?? trail)
  if (at === null) return null

  if (axis === 'vertical') {
    const { left, right } = container.rect
    return { axis, rect: { left, right, top: at, bottom: at, width: right - left, height: 0 } }
  }
  const top = Math.min(...neighbours.map((candidate) => candidate.rect.top))
  const bottom = Math.max(...neighbours.map((candidate) => candidate.rect.bottom))
  return { axis, rect: { left: at, right: at, top, bottom, width: 0, height: bottom - top } }
}

/**
 * The child index a point inside a flow container nearest belongs at: before
 * the first child that comes AFTER the point in reading order, else the end.
 * `null` when none of the container's children were measured (nothing to
 * compare against — the caller keeps the append).
 *
 * Vertical flow compares centre-y. Horizontal flow compares rows first (a
 * child wholly above the point is earlier; wholly below it is later) so a
 * wrapped row resolves in its own row, then centre-x. A reversed flow
 * (`row-reverse`, rtl) counts a child as later when it sits visually before the
 * point.
 */
export function nearestFlowIndex(
  tree: NodeTree<PageNode>,
  containerId: string,
  candidates: readonly CanvasDropCandidate[],
  point: CanvasPoint,
): number | null {
  const children = tree.nodes[containerId]?.children
  if (!children || children.length === 0) return null
  const byId = new Map(candidates.map((candidate) => [candidate.nodeId, candidate]))
  let measured = false
  for (let index = 0; index < children.length; index += 1) {
    const candidate = byId.get(children[index]!)
    if (!candidate) continue
    measured = true
    const { rect, axis, reversed } = candidate
    const centreX = rect.left + rect.width / 2
    const centreY = rect.top + rect.height / 2
    let after: boolean
    if (axis === 'vertical') {
      after = reversed ? centreY < point.y : centreY > point.y
    } else if (rect.bottom < point.y) {
      after = false
    } else if (rect.top > point.y) {
      after = true
    } else {
      after = reversed ? centreX < point.x : centreX > point.x
    }
    if (after) return index
  }
  return measured ? children.length : null
}

/**
 * Which side of `candidate` the point is nearer to, in child-list order: the
 * answer for a press in the MIDDLE of an element that cannot hold the new one
 * (a Label, an image, a locked box). The edge bands of `getCanvasDropZone`
 * only cover the outer ~26 % of the box; the rest is `inside`, which has no
 * meaning for a leaf. Resolving that remainder as a fixed `after` put a drop
 * on the upper half of Label 3 AFTER Label 3 - one slot past where the drop
 * line and the pointer were. A tie goes to `after`, the side the append
 * convention already uses.
 */
export function nearerSiblingSide(candidate: CanvasDropCandidate, point: CanvasPoint): 'before' | 'after' {
  const { rect, axis, reversed } = candidate
  const offset = axis === 'horizontal' ? point.x - rect.left : point.y - rect.top
  const size = axis === 'horizontal' ? rect.width : rect.height
  const inNearHalf = offset < size / 2
  if (!inNearHalf) return reversed ? 'before' : 'after'
  return reversed ? 'after' : 'before'
}

interface ResolvePageTreeInsertionTargetInput {
  tree: NodeTree<PageNode>
  overId: string
  zone: PageTreeDropPosition
  /**
   * Where a drop lands beside `overId` when `zone` is `inside` but `overId`
   * cannot take it. A caller with pointer geometry passes the nearer side; a
   * Layers-panel row has none and keeps the append convention (`after`).
   */
  nearerSide?: 'before' | 'after'
  canHaveChildren: (moduleId: string) => boolean
}

function resolvePageTreeInsertionTarget({
  tree,
  overId,
  zone,
  nearerSide = 'after',
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
      return siblingInsertionTarget(tree, overId, nearerSide)
    }

    return {
      parentId: overId,
      index: over.children.length,
      position: 'inside',
      overId,
    }
  }

  return siblingInsertionTarget(tree, overId, zone === 'inside' ? nearerSide : zone)
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
