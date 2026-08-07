import type { Page } from '@core/page-tree'
import {
  previewStructuralMove,
  resolvePageTreeDropTarget,
  type PageTreeDropPosition,
  type PageTreeDropTarget,
} from '@core/page-tree'

type DomDropZone = PageTreeDropPosition

export type DomDropTarget = PageTreeDropTarget

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
  canHaveChildren: (moduleId: string) => boolean
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
  if (preview.ok) return null
  return { overId: target.overId, message: preview.refusal.message }
}
