import { isResolvedByInstanceDetach, type Page, type PageNode } from '@core/page-tree'
import {
  previewStructuralMove,
  resolvePageTreeDropTarget,
  type PageTreeDropPosition,
  type PageTreeDropTarget,
} from '@core/page-tree'
import { resolveTransplantDropOver } from '@site/canvas/canvasTransplantDrop'

type DomDropZone = PageTreeDropPosition

/**
 * A resolved Layers-panel drop. `foreignPageId` is set when the row under the
 * pointer belongs to ANOTHER page's tree: `parentId` / `index` / `overId` are
 * then positions in THAT page, and the drop is a transplant (the same store
 * action the canvas cross-frame drag commits), not a reparent.
 */
export type DomDropTarget = PageTreeDropTarget & { foreignPageId?: string }

/**
 * G5 — the outcome of resolving a tree-row drop when the position is
 * structurally valid (`resolveDomDropTarget` returned a target) but the
 * SOURCE WRITE `previewStructuralMove` would refuse it (shared component,
 * route chrome, …). Distinguishes "no valid position here at all" (`null`
 * from `resolveDomDropTarget`) from "this position exists, but the store's
 * own gate would still refuse it" — see `previewStructuralMove`'s own doc.
 */
export interface DomDropRefusal {
  overId: string
  message: string
}

interface DomDropRowRect {
  top: number
  bottom: number
  height: number
}

export interface DomDropRowMeta {
  nodeId: string
  /** The page whose tree this row belongs to, when it is not the dragged page's own. */
  pageId?: string
  rect: DomDropRowRect
}

interface ResolveDomDropTargetInput {
  page: Page
  /** The pivot id (the row the user grabbed). */
  draggedId: string
  /**
   * All ids being dragged. Optional — defaults to `[draggedId]` for
   * single-drag callers. Cycle, no-op, AND index-normalization checks all
   * consider every id in this list (G10 — normalization used to discount
   * only the pivot, landing a multi-drag group `n-1` slots too far right).
   */
  draggedIds?: string[]
  overId: string
  zone: DomDropZone
  canHaveChildren: (node: PageNode) => boolean
}

const MIN_EDGE_HIT_ZONE = 8
const MAX_EDGE_HIT_ZONE = 12
const EDGE_ZONE_RATIO = 0.3

export function getDomDropZone(rect: DomDropRowRect, pointerY: number): DomDropZone {
  const edgeBand = Math.max(
    MIN_EDGE_HIT_ZONE,
    Math.min(MAX_EDGE_HIT_ZONE, rect.height * EDGE_ZONE_RATIO),
  )
  const offset = pointerY - rect.top

  if (offset <= edgeBand) return 'before'
  if (offset >= rect.height - edgeBand) return 'after'
  return 'inside'
}

export function findDomDropRow(rows: DomDropRowMeta[], pointerY: number): DomDropRowMeta | null {
  for (const row of rows) {
    if (pointerY >= row.rect.top && pointerY <= row.rect.bottom) return row
  }
  return null
}

export function resolveDomDropTarget({
  page,
  draggedId,
  draggedIds: draggedIdsInput,
  overId,
  zone,
  canHaveChildren,
}: ResolveDomDropTargetInput): DomDropTarget | null {
  return resolvePageTreeDropTarget({
    tree: page,
    draggedId,
    draggedIds: draggedIdsInput,
    overId,
    zone,
    canHaveChildren,
  })
}

/**
 * G5 — asks whether a STRUCTURALLY VALID `target` (already resolved by
 * `resolveDomDropTarget`) would be refused by the source write-back gate.
 * Kept as a SEPARATE call rather than folded into `resolveDomDropTarget`
 * itself so a caller that only cares about tree shape (an ordinary CMS tree,
 * a test fixture with no source-derived ids) never pays for it — every real
 * call site in the editor calls both, in sequence, on every resolved target.
 * `null` means "would write fine" — includes the ordinary case of an
 * un-imported CMS tree, where `previewStructuralMove` always allows.
 */
export function previewDomDropRefusal(page: Page, target: DomDropTarget): DomDropRefusal | null {
  const preview = previewStructuralMove(page, target.draggedIds, target.parentId, target.index)
  // OD-7 — written to THIS instance of a shared component, not refused.
  if (preview.ok || isResolvedByInstanceDetach(preview.refusal.reason)) return null
  return { overId: target.overId, message: preview.refusal.message }
}

interface ResolveDomTransplantDropInput {
  originPage: Page
  destinationPage: Page
  draggedId: string
  draggedIds: string[]
  overId: string
  zone: DomDropZone
  canHaveChildren: (node: PageNode) => boolean
}

/**
 * A row of ANOTHER page's tree under the pointer: where in that page the
 * dragged layer(s) would land, and the store gate's verdict on it.
 *
 * Resolved by the canvas's own cross-frame resolver (`resolveTransplantDropOver`),
 * so the panel and the board cannot disagree about which container a drop on a
 * given element means, or about whether it is allowed. `refusal` is returned
 * ALONGSIDE the target rather than instead of it: the row shows the sentence
 * while the pointer is down, and a release on it re-issues the drop through
 * `transplantNodes`, which presents the refusal with its remedy.
 */
export function resolveDomTransplantDrop({
  originPage,
  destinationPage,
  draggedId,
  draggedIds,
  overId,
  zone,
  canHaveChildren,
}: ResolveDomTransplantDropInput): { target: DomDropTarget | null; refusal: DomDropRefusal | null } {
  const verdict = resolveTransplantDropOver({
    originTree: originPage,
    destinationTree: destinationPage,
    draggedIds,
    overId,
    zone,
    canHaveChildren,
    copy: false,
  })
  if (!verdict.target) return { target: null, refusal: null }
  const target: DomDropTarget = {
    draggedId,
    draggedIds,
    parentId: verdict.target.parentId,
    index: verdict.target.index,
    position: verdict.target.position,
    slot: 'default',
    overId: verdict.target.overId,
    foreignPageId: destinationPage.id,
  }
  const preview = verdict.preview
  return {
    target,
    refusal: preview && !preview.ok ? { overId, message: preview.refusal.message } : null,
  }
}
