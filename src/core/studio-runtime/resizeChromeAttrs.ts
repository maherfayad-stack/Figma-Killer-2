/**
 * resizeChromeAttrs — the names the parent's resize chrome (handles, rotation
 * zones, the W x H badge) is marked with, and the one helper both hosts of a
 * resize share.
 *
 * Since SB-4 the handles are parent-document elements beside the frame's
 * iframe (`CanvasResizeHandles`) for a same-origin frame and a cross-origin one
 * alike; the frame's runtime owns only the drag's geometry
 * (`resizeSession.ts`). The attribute names stay here, in the shared package,
 * because the parent's chrome and the e2e specs read them from one place.
 */

/** The attribute the handle frame element carries. */
export const RESIZE_FRAME_ATTR = 'data-canvas-resize-frame'
/** The attribute each handle carries, naming the direction it drags. */
export const RESIZE_HANDLE_ATTR = 'data-canvas-resize-handle'
/**
 * P5-F / IX-25 — the four rotation zones just outside the corners, naming the
 * corner each sits by. Portal frames only (`CanvasResizeHandles`).
 */
export const ROTATE_HANDLE_ATTR = 'data-canvas-rotate-handle'
/** The corners a rotation zone sits outside of. */
export const ROTATE_CORNERS = ['nw', 'ne', 'se', 'sw'] as const
/** On the frame for exactly the length of a rotation; the chrome swaps the cursor under it. */
export const ROTATE_ACTIVE_ATTR = 'data-canvas-rotating'
/** On the frame for exactly the length of a drag; the chrome shows the size badge under it. */
export const RESIZE_ACTIVE_ATTR = 'data-canvas-resizing'
/** The W×H badge inside the frame (IX-18). */
export const RESIZE_SIZE_BADGE_ATTR = 'data-canvas-size-badge'

/**
 * Write the W×H badge's text: the MEASURED border box, in frame px, rounded —
 * what the user sees, which under `content-box` is more than the `width` the
 * drag writes. Skips the write when the text is unchanged (a same-value
 * `textContent` write still replaces the text node).
 */
export function writeSizeBadge(badge: HTMLElement, width: number, height: number): void {
  const label = `${Math.round(width)} × ${Math.round(height)}`
  if (badge.textContent !== label) badge.textContent = label
}
