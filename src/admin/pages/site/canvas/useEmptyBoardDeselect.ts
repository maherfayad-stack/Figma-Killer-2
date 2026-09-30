/**
 * useEmptyBoardDeselect — a CLICK on the empty board deselects everything.
 *
 * "Click" is decided on release, from the press that started it, like every
 * other click-vs-drag decision on the canvas (`canvasPressTarget.ts`,
 * `canvasNodeGestureLatch.ts`): the browser raises a `click` after ANY
 * press-and-release on the same element, including a Space-drag pan across the
 * empty board. The deselect used to be a plain `onClick` on the canvas root,
 * so panning the board to reach the next thing threw the selection away —
 * measured in `press-drag-depth.e2e.ts`.
 *
 * So a release deselects only when:
 *  - it lands on the empty board itself (`isEmptyBoardTarget` — the canvas
 *    root, or the transform layer where it has a size; the ONE empty-board
 *    test, shared with the drop paths);
 *  - its press was a plain primary press, not the start of a pan (Space held,
 *    the hand tool, the middle button — `shouldStartCanvasPointerPan`);
 *  - the pointer stayed within {@link CLICK_SLOP_PX} of the press, in screen
 *    px, so the rule is the same at every zoom. A marquee that travelled is the
 *    marquee's (`useMarqueeSelection`), and it already swallows its own click.
 *
 * "Everything" is what Escape clears (`clearAllSelections`: nodes, frames,
 * annotations, loose layers, entered instances) plus vector edit mode, which
 * the selection alone does not end. An inline text edit ends on its own: the
 * press blurred it.
 *
 * A click on a frame's own page background is NOT this: it lands inside the
 * frame's iframe and selects the page root, the frame's existing model.
 */
import { useEffect, useEffectEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { isEmptyBoardTarget } from './BoardCanvasLayer/canvasLayerGeometry'
import { exitVectorEdit } from './BoardVectorLayer/vectorEditState'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'

/** Screen px a press may travel and still be a click. Under the 4 px every canvas drag activates at. */
const CLICK_SLOP_PX = 3

interface EmptyBoardDeselectOptions {
  canvasRootRef: React.RefObject<HTMLElement | null>
  /** False in live view, which has no board. */
  enabled: boolean
  /** Runs before the deselect — closing chrome anchored to the old selection (the layer menu). */
  onDeselect: () => void
}

export function useEmptyBoardDeselect({ canvasRootRef, enabled, onDeselect }: EmptyBoardDeselectOptions): void {
  const beforeDeselect = useEffectEvent(() => onDeselect())

  useEffect(() => {
    const root = canvasRootRef.current
    if (!enabled || !root) return
    let press: { x: number; y: number; pan: boolean } | null = null

    const onPointerDown = (event: PointerEvent) => {
      press = {
        x: event.clientX,
        y: event.clientY,
        pan: event.button !== 0 || shouldStartCanvasPointerPan(event, { spaceHeld: isCanvasSpacePanActive(document) }),
      }
    }

    const onClick = (event: MouseEvent) => {
      const started = press
      press = null
      if (!isEmptyBoardTarget(event.target)) return
      if (!started || started.pan) return
      if (Math.hypot(event.clientX - started.x, event.clientY - started.y) > CLICK_SLOP_PX) return
      beforeDeselect()
      useEditorStore.getState().clearAllSelections()
      exitVectorEdit()
    }

    // Capture: the press is recorded before any gesture below claims it.
    root.addEventListener('pointerdown', onPointerDown, true)
    root.addEventListener('click', onClick)
    return () => {
      root.removeEventListener('pointerdown', onPointerDown, true)
      root.removeEventListener('click', onClick)
    }
  }, [canvasRootRef, enabled])
}
