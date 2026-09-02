import type { PointerEventHandler, RefObject } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { useRulerCanvasPaint } from './useRulerCanvasPaint'
import styles from './CanvasRulers.module.css'

interface RulerVProps {
  /** The element whose height drives the ruler's on-screen length — `.canvas` itself. */
  lengthSourceRef: RefObject<HTMLElement | null>
  transformRef: RefObject<CanvasTransform>
  /** Board-space y that should read as ruler "0" — see `resolveRulerOriginBoard`. */
  originBoardY: number
  /** Drag-out-a-new-guide gesture start — undefined when guides aren't supported (no active board). */
  onPointerDown?: PointerEventHandler<HTMLElement>
}

/** Vertical ruler — left edge of `.canvas`, `<canvas>`-painted. See `rulerGeometry.ts` for the math. */
export function RulerV({ lengthSourceRef, transformRef, originBoardY, onPointerDown }: RulerVProps) {
  // The hook owns/creates this ref itself (not passed in) — see
  // useRulerCanvasPaint.ts's doc for why that matters to the React Compiler.
  const canvasElRef = useRulerCanvasPaint({
    axis: 'y',
    lengthSourceRef,
    transformRef,
    originBoard: originBoardY,
  })

  return (
    <canvas
      ref={canvasElRef}
      data-testid="canvas-ruler-v"
      className={styles.rulerV}
      onPointerDown={onPointerDown}
      aria-hidden="true"
    />
  )
}
