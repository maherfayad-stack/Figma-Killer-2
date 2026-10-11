/**
 * canvasPressSelect — the layer a PRESS selects, on the way down.
 *
 * Every design tool selects on mousedown: the ring is on the layer by the time
 * the button is still held, and a press that turns into a drag moves what it
 * just selected. Selection here used to wait for the `click` — pointerdown
 * (the old selection cleared when the press crossed into another frame's
 * page), then ~a release later the new layer — so the ring and the inspector
 * arrived a whole press-and-release after the finger landed, behind a long
 * task that only started at release.
 *
 * What a press selects is exactly what its click would
 * (`resolveCanvasPressTarget`, the one depth rule), so the click that follows
 * re-selects the same layer: a no-op, not a second selection. What the press
 * leaves to the click:
 *
 *  - ⇧ — a toggle is decided on release, like Figma's;
 *  - a press inside the current selection — it keeps the whole selection (a
 *    multi-selection must survive being grabbed), and a click without a drag
 *    narrows it on release;
 *  - the frame's own background (`null`) — that press is the in-frame
 *    marquee's, and a click there lets go of everything.
 */
import type { EditorStore } from '@site/store/types'
import { selectCanvasPageFor } from '@site/store/store'
import { canvasPressContext, resolveCanvasPressTarget } from './canvasPressTarget'
import { canvasPressBecameDrag } from './canvasNodeGestureLatch'
import { isCanvasEditorControlTarget, isClosestCanvasNodeTarget } from './canvasEventTargets'

interface PressInput {
  button: number
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  target: EventTarget | null
  currentTarget: EventTarget | null
}

/** The selection half of {@link resolvePressSelection}, free of the DOM: which layer, by the one depth rule. */
export function pressSelectionTarget(
  state: EditorStore,
  contextPageId: string | null,
  frameId: string | null,
  hitId: string,
  press: Pick<PressInput, 'button' | 'shiftKey' | 'metaKey' | 'ctrlKey'>,
): string | null {
  if (press.button !== 0 || press.shiftKey) return null
  const page = selectCanvasPageFor(state, contextPageId, frameId)
  if (!page) return null
  const context = canvasPressContext(state, frameId)
  const target = resolveCanvasPressTarget(page, hitId, context, { deep: press.metaKey || press.ctrlKey })
  if (target === null || context.selectedIds.includes(target)) return null
  return target
}

/**
 * The layer to select NOW for a press on `hitId`, or `null` when the click
 * decides. Only the node the pointer is actually on answers (every ancestor's
 * capture handler sees the same press), and never a press that already became
 * a pan or a drag of something else.
 */
export function resolvePressSelection(
  state: EditorStore,
  contextPageId: string | null,
  frameId: string | null,
  hitId: string,
  press: PressInput,
): string | null {
  if (canvasPressBecameDrag()) return null
  if (!isClosestCanvasNodeTarget(press.target, press.currentTarget) || isCanvasEditorControlTarget(press.target, press.currentTarget)) return null
  return pressSelectionTarget(state, contextPageId, frameId, hitId, press)
}
