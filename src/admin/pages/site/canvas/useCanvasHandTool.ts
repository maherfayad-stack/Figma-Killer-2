/**
 * useCanvasHandTool — mirrors `K4`'s latched hand tool (`H`) onto the shared
 * space-pan flag.
 *
 * Twelve lines, and all of the hand tool. The pan gesture, the cursor, the
 * `pointer-events: none` on every frame, the marquee stand-down and the
 * reorder-drag stand-down are ALL already keyed off
 * `isCanvasSpacePanActive(document)` because holding Space needed exactly the
 * same things. So the tool does not get a pan implementation of its own — it
 * becomes a third source on that one flag (`canvasPanInput.ts`), and the
 * canvas cannot end up with two disagreeing ideas of whether it is panning.
 *
 * The cleanup is not ceremony: unmounting the canvas (a route change, a switch
 * to live mode) with the tool armed would otherwise leave a `<html>` dataset
 * flag behind that nothing is left to clear, and the next canvas would mount
 * already panning.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { setCanvasSpacePanActive } from './canvasPanInput'

export function useCanvasHandTool(): void {
  const handToolArmed = useEditorStore((s) => s.canvasTool === 'hand')

  useEffect(() => {
    setCanvasSpacePanActive(document, 'handTool', handToolArmed)
    return () => setCanvasSpacePanActive(document, 'handTool', false)
  }, [handToolArmed])
}
