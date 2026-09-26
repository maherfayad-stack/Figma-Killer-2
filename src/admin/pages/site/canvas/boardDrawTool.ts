/**
 * boardDrawTool — the B tool's board half (P5-F, IX-13): a press or a drag on
 * the EMPTY board asks which page the new frame should show, and the frame
 * lands where it was drawn.
 *
 * Penpot arms `:frame` on B and a drag on the canvas makes a root board
 * (`drawing/common.cljs:82-96`). In Studio a board frame IS a page file, so
 * the drag cannot finish on its own: it opens the add-page picker at the
 * pointer (`BoardDrawPagePicker`), and the author's pick — a new page, or one
 * already on disk — lands at the drawn rect. A new page is one server call
 * (`createStudioPage` with a `placement`: the page files AND the
 * `boards.json` frame, in one locked write); an existing page is one
 * `addFrame` with the same placement.
 *
 * Inside a frame B is the F tool (a container where the pointer lands), which
 * is why its draw spec is the frame's (`canvasDrawTool.ts`).
 *
 * ## The size
 *
 * A click places a frame of the board's default size at the press point. A
 * drag gives the drawn size, floored at `MIN_FRAME_SIZE` — and a drawn width
 * within {@link PRESET_SNAP_UNITS} of a device preset becomes that preset's
 * width exactly, so a roughly-phone-wide drag is a phone-wide frame.
 */
import { DEVICE_PRESETS, MIN_FRAME_SIZE, type BoardFramePlacement } from '@core/studio-board'
import type { DrawRect } from './canvasDrawTool'

/** How close (board units) a drawn width must come to a device preset's to become it. */
export const PRESET_SNAP_UNITS = 8

/** The nearest device-preset width within {@link PRESET_SNAP_UNITS}, or the width itself. */
export function snapFrameWidthToPreset(width: number): number {
  let best: number | null = null
  for (const preset of DEVICE_PRESETS) {
    const distance = Math.abs(preset.width - width)
    if (distance > PRESET_SNAP_UNITS) continue
    if (best === null || distance < Math.abs(best - width)) best = preset.width
  }
  return best ?? width
}

/** Where a board-tool draw puts the new frame. `rect` is in board units. */
export function boardDrawPlacement(rect: DrawRect, dragged: boolean): BoardFramePlacement {
  const x = Math.round(rect.x)
  const y = Math.round(rect.y)
  if (!dragged) return { x, y }
  return {
    x,
    y,
    width: Math.max(MIN_FRAME_SIZE, snapFrameWidthToPreset(Math.round(rect.width))),
    height: Math.max(MIN_FRAME_SIZE, Math.round(rect.height)),
  }
}
