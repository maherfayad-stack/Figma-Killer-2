import type { PointerEventHandler, RefObject } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { useRulerCanvasPaint } from './useRulerCanvasPaint'
import styles from './CanvasRulers.module.css'

interface RulerHProps {
  /** The element whose width drives the ruler's on-screen length — `.canvas` itself. */
  lengthSourceRef: RefObject<HTMLElement | null>
  transformRef: RefObject<CanvasTransform>
  /** Board-space x that should read as ruler "0" — see `resolveRulerOriginBoard`. */
  originBoardX: number
  /** Drag-out-a-new-guide gesture start — undefined when guides aren't supported (no active board). */
  onPointerDown?: PointerEventHandler<HTMLElement>
}

/** Horizontal ruler — top edge of `.canvas`, `<canvas>`-painted. See `rulerGeometry.ts` for the math. */
export function RulerH({ lengthSourceRef, transformRef, originBoardX, onPointerDown }: RulerHProps) {
  // The hook owns/creates this ref itself (not passed in) — see
  // useRulerCanvasPaint.ts's doc for why that matters to the React Compiler.
  const canvasElRef = useRulerCanvasPaint({
    axis: 'x',
    lengthSourceRef,
    transformRef,
    originBoard: originBoardX,
  })

  return (
    <canvas
      ref={canvasElRef}
      data-testid="canvas-ruler-h"
      className={styles.rulerH}
      onPointerDown={onPointerDown}
      aria-hidden="true"
    />
  )
}
