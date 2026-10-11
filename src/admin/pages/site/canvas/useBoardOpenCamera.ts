/**
 * useBoardOpenCamera - where a board's camera is when it opens, and keeping
 * track of where the user leaves it.
 *
 * Opening a board used to leave the camera at the store default (50 %, pan 0),
 * which drops the frames bottom-left, partly off screen. Figma restores the
 * view you left; a file never opened fits its content. Same here:
 *
 *   1. a camera remembered for this project + board (`canvasCameraMemory.ts`)
 *      is restored as is;
 *   2. otherwise the board is fitted (`zoomToFit`, which leaves room for the
 *      docked Properties sidebar - `measureCanvasFitInsets`).
 *
 * It frames ONCE per board and never again: selecting must not re-frame
 * (`canvasFocusTarget.ts` has the history of every first selection moving every
 * frame). That is also why this is its own effect, keyed only on the board: the
 * page-keyed framing effect re-runs on every selection and would cancel a fit
 * that was still waiting for its frames. `startCanvasFraming` ends framing
 * however it ends - done, given up, or the user already moved the view - so a
 * pan or zoom of the user's own is never overwritten.
 *
 * After framing, every camera the canvas commits (the gestures already debounce
 * it to ~100 ms) is remembered for the next open.
 */
import { useEffect, useRef } from 'react'
import { useEditorStore } from '@site/store/store'
import { recallCamera, rememberCamera } from './canvasCameraMemory'
import { startCanvasFraming } from './canvasFocusTarget'

interface BoardOpenCameraOptions {
  /** Off in live view, where the design canvas is not mounted. */
  enabled: boolean
  zoomToFit: () => boolean
  applyCamera: (camera: { zoom: number; panX: number; panY: number }, animated: boolean) => void
}

export function useBoardOpenCamera({ enabled, zoomToFit, applyCamera }: BoardOpenCameraOptions): void {
  const activeBoardId = useEditorStore((s) => s.activeBoardId)
  const framedBoardRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !activeBoardId || framedBoardRef.current === activeBoardId) return
    const boardId = activeBoardId
    return startCanvasFraming({
      center: () => {
        const remembered = recallCamera(boardId)
        if (remembered) {
          applyCamera(remembered, false)
          return true
        }
        return zoomToFit()
      },
      readView: () => {
        const { zoom, panX, panY } = useEditorStore.getState()
        return `${zoom}:${panX}:${panY}`
      },
      settle: () => {
        framedBoardRef.current = boardId
      },
    })
  }, [enabled, activeBoardId, zoomToFit, applyCamera])

  useEffect(
    () =>
      useEditorStore.subscribe((state, previous) => {
        const boardId = state.activeBoardId
        if (!boardId || framedBoardRef.current !== boardId) return
        if (state.zoom === previous.zoom && state.panX === previous.panX && state.panY === previous.panY) return
        rememberCamera(boardId, { zoom: state.zoom, panX: state.panX, panY: state.panY })
      }),
    [],
  )
}
