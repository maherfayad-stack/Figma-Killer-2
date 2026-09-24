/**
 * BoardCanvasLayer — the free canvas (P5-G, OD-14): loose layers on the empty
 * board, around the frames.
 *
 * Owner's words (2026-09-23): "a free canvas that I can drag an element /
 * component or an image in, and it's not part of the pages, and it's still
 * there, just not part of the live preview." A loose layer is a module Studio
 * owns (`.studio/canvas/<id>.tsx`) plus a placement on the board; see
 * `docs/features/free-canvas.md` for the whole model.
 *
 * Mounted FIRST in `StudioBoardLayers`, so its surface paints below the frames
 * and the annotation layers (OD-FC-2); `BoardCanvasLayerChrome` mounts after
 * the frames and draws the rings above them. This component owns:
 *
 *  - which loose layers are near the viewport (`canvasLayerWindow`, re-fit on
 *    the store's settled pan/zoom — the signal `BoardFramesLayer` virtualises
 *    on — never per pan tick);
 *  - the one surface document they render in (`CanvasLayerSurface`), mounted
 *    only while at least one layer is in the window;
 *  - the pointer gestures, which read the board, not the surface
 *    (`useCanvasLayerPointer`).
 *
 * Its `.layer` div sits at board (0, 0) inside the transform layer and carries
 * `data-studio-board-origin`: anything that has to turn a client point into a
 * board point (the pointer hook, an OS file dropped on the empty board) reads
 * that element's client rect, which already includes the pan and the
 * transform layer's own offset.
 */
import { useContext, useEffect, useRef, useState } from 'react'
import { canvasLayerPageId, layerPaintOrder } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard, selectActiveBoardLayers, selectHasActiveBoard } from '@site/store/slices/boardSelectors'
import { CanvasViewportActionsContext } from '../CanvasContexts'
import { FRAME_VIEWPORT_MARGIN } from '../BoardFramesLayer/frameVirtualization'
import { canvasLayerWindow, layerMeetsWindow } from './canvasLayerGeometry'
import { CanvasLayerSurface } from './CanvasLayerSurface'
import { useCanvasLayerPointer } from './useCanvasLayerPointer'
import { useCanvasLayerKeyboard } from './useCanvasLayerKeyboard'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import styles from './BoardCanvasLayer.module.css'

export function BoardCanvasLayer() {
  const hasActiveBoard = useEditorStore(selectHasActiveBoard)
  const boardId = useEditorStore((s) => selectActiveBoard(s)?.id ?? null)
  const layers = useEditorStore(selectActiveBoardLayers)
  const pages = useEditorStore((s) => s.canvasLayerPages)
  const zoom = useEditorStore((s) => s.zoom)
  const panX = useEditorStore((s) => s.panX)
  const panY = useEditorStore((s) => s.panY)

  const viewportActions = useContext(CanvasViewportActionsContext)
  const [viewportSize, setViewportSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const root = viewportActions?.canvasRootRef.current
    if (!root) return
    const syncSize = () => setViewportSize({ width: root.clientWidth, height: root.clientHeight })
    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(root)
    return () => observer.disconnect()
  }, [viewportActions])

  // A read-only session sees the free canvas and touches nothing on it.
  const editable = useEditorPermissions().canEditStructure
  useCanvasLayerKeyboard(editable)

  const originRef = useRef<HTMLDivElement | null>(null)
  const surfaceElementRef = useRef<HTMLDivElement | null>(null)
  const surfaceDocumentRef = useRef<Document | null>(null)
  useCanvasLayerPointer({
    enabled: editable,
    canvasRootRef: viewportActions?.canvasRootRef,
    transformRef: viewportActions?.transformRef,
    surfaceDocumentRef,
    surfaceElementRef,
    boardOriginRef: originRef,
  })

  // Clicking a node, a frame or a note makes one of the other three selection
  // lists non-empty; a loose-layer selection left standing beside it would
  // show two rings for one intent. Subscribed, not selected: nothing renders
  // from it, and it must not re-render this layer.
  useEffect(
    () =>
      useEditorStore.subscribe((state) => {
        if (state.selectedCanvasLayerIds.length === 0) return
        if (state.selectedNodeIds.length > 0 || state.selectedFrameIds.length > 0 || state.selectedAnnotations.length > 0) {
          state.clearCanvasLayerSelection()
        }
      }),
    [],
  )

  if (!hasActiveBoard || !boardId) return null

  const area = canvasLayerWindow({ zoom, panX, panY, width: viewportSize.width, height: viewportSize.height }, FRAME_VIEWPORT_MARGIN)
  const visible = layerPaintOrder(layers).filter(
    (layer) => !layer.hidden && canvasLayerPageId(layer.id) in pages && layerMeetsWindow(layer, area),
  )

  return (
    <div ref={originRef} className={styles.layer} data-studio-board-origin="" data-testid="board-canvas-layer">
      {visible.length > 0 ? (
        <CanvasLayerSurface
          boardId={boardId}
          area={area}
          layers={visible}
          pages={pages}
          surfaceElementRef={surfaceElementRef}
          surfaceDocumentRef={surfaceDocumentRef}
        />
      ) : null}
    </div>
  )
}
