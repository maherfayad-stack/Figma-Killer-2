/**
 * CanvasDropIndicators — the one element React owns for an in-flight element
 * drag: an empty, click-through layer over the breakpoint viewport.
 *
 * Everything drawn inside it — the valid drop line, the refused-position box,
 * the reason that position is refused, and the drag ghost — is created and
 * positioned imperatively by `canvasDragPainter.ts`, from the drag session's
 * single rAF. React never gives this element children, so nothing React owns
 * can be overwritten and nothing the painter writes can be discarded by a
 * commit. Same division of labour as the selector-affinity pool
 * (`syncSelectorHighlightRings`), for the same reason.
 *
 * It used to be a component with props (`target`, `invalid`) fed by a
 * `useState` the drag hook wrote on every raw `pointermove` — one React
 * commit of the whole selection overlay per pointer event. S2 moved the
 * painting to the DOM; this file is what is left, and what is left is
 * load-bearing:
 *
 *  - **It renders in the PARENT document's overlay layer, never inside a
 *    frame's iframe.** Canvas DOM is the DOM React renders for the user's own
 *    markup; an extra element in there breaks their `%` height chains and
 *    their `>` / `+` / `:nth-child` selectors. The overlay layer is already
 *    transform-scaled with the canvas, which is why the candidate rects can
 *    be written into it unconverted.
 *  - **The reason arrives while the pointer is still down.** A refused drop
 *    used to show only a red box, with the sentence explaining it arriving as
 *    a toast after `pointerup` — by which time the user has let go and moved
 *    on. `previewStructuralMove` computes the verdict mid-gesture and
 *    `explainGestureConstraint` translates it; the painter renders that
 *    translation at the moment the user is looking at the thing it is about.
 */
import styles from './BreakpointSelectionOverlay.module.css'

interface CanvasDropIndicatorsProps {
  /** Handed to `useCanvasReorderDrag`, which paints through it. */
  layerRef: React.RefObject<HTMLDivElement | null>
}

export function CanvasDropIndicators({ layerRef }: CanvasDropIndicatorsProps) {
  return (
    <div
      ref={layerRef}
      className={styles.overlayLayer}
      // Stable attribute, not the hashed CSS Module class: this is how a
      // test (and the painter's own docs) name the layer.
      data-canvas-drag-layer="true"
      aria-hidden="true"
    />
  )
}
