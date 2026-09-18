/**
 * CanvasFileDropHint — the one element React owns for an OS file drag that is
 * over the empty board: an empty, click-through layer above the canvas.
 *
 * Exactly `CanvasDropIndicators`' arrangement, one tier out. React renders the
 * container and never gives it children; `canvasDragPainter.ts` creates and
 * positions the cursor chip inside it from `useCanvasFileDrop`'s single rAF,
 * so a `dragover` stream costs zero React commits.
 *
 * It exists because the per-frame drag layers cannot answer "you are not over
 * a frame". Those layers live inside `.viewport`, which is `overflow: hidden`
 * — a chip painted into one while the pointer is somewhere else on the board
 * would be clipped away exactly where it needed to be seen.
 */
import styles from './CanvasFileDropHint.module.css'

interface CanvasFileDropHintProps {
  /** Handed to `useCanvasFileDrop`, which paints through it. */
  layerRef: React.RefObject<HTMLDivElement | null>
}

export function CanvasFileDropHint({ layerRef }: CanvasFileDropHintProps) {
  return (
    <div
      ref={layerRef}
      className={styles.fileDropHint}
      // Stable attribute, not the hashed CSS Module class: this is how a test
      // (and the preview's own docs) name the layer.
      data-canvas-file-drop-layer="true"
      aria-hidden="true"
    />
  )
}
