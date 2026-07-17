import type { LayoutAxis, Rect } from '@ccs/bridge';
import type { Box, Point } from './geometry.js';

/**
 * Pure geometry for the FP-4b context-aware drag-to-move REORDER branch
 * (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4 third bullet, D-EDIT
 * decision §0/§5). Everything here operates in IFRAME space (the same
 * space `@ccs/bridge`'s `report-rects`/`hit-test` rects already use) —
 * `edit-mode-layer.tsx` converts to/from screen space at its own boundary
 * via the existing `bridge-geometry.ts` helpers, exactly like every other
 * overlay box in this package. Zero tldraw dependency (§5.4).
 *
 * ## Drop-indicator feel (cited from the real Penpot clone,
 * `c:\Users\Admin\Documents\GitHub\penpot`, MPL-2.0)
 * `frontend/src/app/util/dom/dnd.cljs`'s `drop-side` (lines 131-145) computes
 * a hovered ROW's zone from the pointer's offset within that one row: top
 * 20% / bottom 20% / middle 60% when reparenting-into-a-container is legal
 * (`detect-center?`), or a plain 50/50 split when it isn't — NOT an exact
 * "thirds" split as `PENPOT-FIDELITY-SPEC.md` §5.4 summarizes it, though the
 * FEEL (top zone = insert before, bottom zone = insert after, middle zone =
 * reparent) is the same idea that summary is naming. Our on-canvas element
 * drag is a materially different interaction — a single continuous drag
 * over a whole flex/grid CONTAINER with N siblings, not a per-row hover
 * target — and D-EDIT's scope is reorder-within-the-current-parent only, no
 * drag-to-reparent-into-a-different-container (that's a separate,
 * out-of-scope gesture). So `computeReorderDropIndex` below uses the
 * standard "nearest sibling-gap by comparing the pointer's position to each
 * sibling's own center along the layout axis" algorithm (the common
 * sortable-list technique) rather than Penpot's per-row 20/60/20 split —
 * this is a disclosed ADAPTATION of the FEEL (one visible drop-indicator
 * LINE between two siblings, exactly matching the visual language of
 * Penpot's own drop indicator), not a byte-for-byte port of `drop-side`
 * (which doesn't apply to a continuous multi-sibling drag at all).
 */

export interface SiblingRect {
  uid: string;
  rect: Rect;
}

/** Which gap (0..siblings.length) the pointer is currently closest to,
 * along the layout's main axis. `siblings` must be DOM order and must
 * EXCLUDE the dragged uid itself (matching `move-node`'s own `index`
 * semantics — see `packages/ast-engine/src/apply-op.ts`'s
 * `applyMoveNodeOp`, which computes `siblingsExcludingTarget` the exact
 * same way before clamping/inserting). Compares the pointer's coordinate on
 * the axis to each sibling's CENTER (not its edges) — standard
 * nearest-gap-by-midpoint sortable-list technique. */
export function computeReorderDropIndex(axis: LayoutAxis, siblings: SiblingRect[], pointer: Point): number {
  const p = axis === 'row' ? pointer.x : pointer.y;
  for (let i = 0; i < siblings.length; i++) {
    const rect = siblings[i]!.rect;
    const center = axis === 'row' ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
    if (p < center) return i;
  }
  return siblings.length;
}

/** Thin, constant-thickness (iframe-space-independent of zoom — rendered
 * with a fixed screen-space border width, same convention `edit-mode-
 * layer.tsx`'s existing hover/selection overlays already use) line box at
 * the gap `dropIndex` represents, spanning the CROSS axis across the full
 * parent rect (a full-width line for a row-axis container, full-height for
 * a column-axis one) — the classic "drop indicator" look. `siblings` is the
 * same excluding-dragged, DOM-ordered list `computeReorderDropIndex` takes. */
export function dropIndicatorBox(
  axis: LayoutAxis,
  siblings: SiblingRect[],
  dropIndex: number,
  parentRect: Rect,
): Box {
  const THICKNESS = 4;
  let pos: number;

  if (siblings.length === 0) {
    pos = axis === 'row' ? parentRect.x + parentRect.width / 2 : parentRect.y + parentRect.height / 2;
  } else if (dropIndex <= 0) {
    const first = siblings[0]!.rect;
    pos = axis === 'row' ? first.x : first.y;
  } else if (dropIndex >= siblings.length) {
    const last = siblings[siblings.length - 1]!.rect;
    pos = axis === 'row' ? last.x + last.width : last.y + last.height;
  } else {
    const before = siblings[dropIndex - 1]!.rect;
    const after = siblings[dropIndex]!.rect;
    const beforeEnd = axis === 'row' ? before.x + before.width : before.y + before.height;
    const afterStart = axis === 'row' ? after.x : after.y;
    pos = (beforeEnd + afterStart) / 2;
  }

  if (axis === 'row') {
    return { x: pos - THICKNESS / 2, y: parentRect.y, w: THICKNESS, h: parentRect.height };
  }
  return { x: parentRect.x, y: pos - THICKNESS / 2, w: parentRect.width, h: THICKNESS };
}

/** Euclidean screen-space distance — used by the drag gesture's threshold
 * check (a small movement below threshold is still a plain SELECT click,
 * not a drag; see `edit-mode-layer.tsx`'s pointer handlers). */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Movement (screen px) a pointer-down on a selected element must travel
 * before it's treated as a drag rather than a click-to-select. A common
 * small-drag-tolerance value (e.g. HTML5 DnD implementations and most
 * sortable-list libraries use a similar few-pixel threshold) — no single
 * canonical Penpot number exists for this (its drag gestures are native
 * HTML5 DnD, whose OS-level drag-start threshold isn't a value this app can
 * read or replicate exactly), so this is a disclosed, reasonable choice. */
export const DRAG_THRESHOLD_PX = 4;
