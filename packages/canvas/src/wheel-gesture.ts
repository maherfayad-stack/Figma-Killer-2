/**
 * FP-1 (playbook §5.9 / `.orchestrator/FEATURE-PARITY-PLAN.md` FP-1):
 * shift+wheel horizontal-pan gap fix.
 *
 * tldraw@5.2.4's own wheel dispatch (`@tldraw/editor` `Editor.ts`,
 * `dispatch()`'s `case 'wheel'` → `case 'pan'`) passes the wheel event's
 * `delta.x`/`delta.y` straight through to the camera with no shift-driven
 * axis swap of its own — verified by reading that source directly (no
 * `shiftKey` branch anywhere in its wheel/pan handling).
 *
 * Real Penpot (`../penpot/frontend/src/app/main/ui/workspace/viewport/
 * actions.cljs`, `schedule-scroll!`) hits the exact same gap and documents
 * why it hand-rolls a remap:
 *
 * > "macOS sends delta-x automatically, so on other platforms we remap
 * > shift+scroll-y to horizontal panning."
 *
 * i.e. on macOS, a shift-held wheel/trackpad gesture is already reported by
 * the OS/browser as a horizontal `deltaX` before JS ever sees it; on
 * Windows/Linux with a plain mouse wheel it is not — the browser still
 * reports the motion on `deltaY`, and shift is just a modifier flag on the
 * event. Without this remap, `Shift+wheel` over the canvas would pan
 * VERTICALLY (same as a plain wheel) on Windows/Linux instead of
 * horizontally.
 *
 * Only the axis needs remapping — callers own deciding WHEN to apply it
 * (skip when a zoom modifier is held, or when `deltaX` is already non-zero
 * i.e. the platform already gave us a real horizontal delta).
 */
export function shiftPanDelta(deltaX: number, deltaY: number): { x: number; y: number } {
  return deltaX !== 0 ? { x: deltaX, y: 0 } : { x: deltaY, y: 0 };
}
