/**
 * BoardCanvasLayerChrome — the selection and hover rings of the free canvas's
 * loose layers (P5-G), drawn ABOVE the frames.
 *
 * Rings are board furniture, not page content: they live in the board's
 * transform layer at the layer's placement and its MEASURED host size
 * (`canvasLayerGeometry.ts`), and counter-scale their border by the live zoom.
 * A layer's own document never gets a ring painted into it — the surface is
 * shared by every layer on the board, and it paints below the frames, where a
 * ring would be hidden exactly when a layer is under one.
 *
 * While a layer is dragged, `useCanvasLayerPointer` moves its ring with the
 * same `--ring-x/--ring-y` properties this renders, so the ring and the layer
 * travel together with no React commit.
 */
import { useSyncExternalStore, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardLayers } from '@site/store/slices/boardSelectors'
import { canvasLayerGeometryVersion, canvasLayerRects, subscribeCanvasLayerGeometry } from './canvasLayerGeometry'
import { getHoveredCanvasLayer, subscribeHoveredCanvasLayer } from './canvasLayerHover'
import styles from './BoardCanvasLayer.module.css'

export function BoardCanvasLayerChrome() {
  const layers = useEditorStore(selectActiveBoardLayers)
  const selected = useEditorStore(useShallow((s) => s.selectedCanvasLayerIds))
  const hovered = useSyncExternalStore(subscribeHoveredCanvasLayer, getHoveredCanvasLayer, getHoveredCanvasLayer)
  // Re-render when a host's measured size changes — the snapshot is a number.
  useSyncExternalStore(subscribeCanvasLayerGeometry, canvasLayerGeometryVersion, canvasLayerGeometryVersion)

  if (layers.length === 0 || (selected.length === 0 && hovered === null)) return null
  const shown = canvasLayerRects(layers).filter((rect) => selected.includes(rect.id) || rect.id === hovered)
  if (shown.length === 0) return null

  return (
    <div className={styles.chromeLayer} data-testid="board-canvas-layer-chrome">
      {shown.map((rect) => (
        <div
          key={rect.id}
          className={styles.ring}
          data-canvas-layer-ring={rect.id}
          data-hover={selected.includes(rect.id) ? undefined : ''}
          style={
            {
              '--ring-x': `${rect.x}px`,
              '--ring-y': `${rect.y}px`,
              '--ring-w': `${rect.width}px`,
              '--ring-h': `${rect.height}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}
