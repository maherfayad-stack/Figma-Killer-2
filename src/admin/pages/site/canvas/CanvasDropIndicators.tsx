/**
 * CanvasDropIndicators — everything a reorder drag paints inside the
 * breakpoint viewport: the valid drop line, the refused-position box, and the
 * REASON the position is refused.
 *
 * Split out of `BreakpointSelectionOverlay.tsx` (which sits at the module-size
 * ceiling) because it is one self-contained question — "what does an in-flight
 * drag look like" — with one input, `useCanvasReorderDrag`'s resolution.
 *
 * Two properties are load-bearing:
 *
 *  - **It renders in the PARENT document's overlay layer, never inside a
 *    frame's iframe.** Canvas DOM is the DOM React renders for the user's own
 *    markup; an extra element in there breaks their `%` height chains and
 *    `>` / `+` / `:nth-child` selectors. The overlay layer is already
 *    transform-scaled with the canvas, which is why the rects can be written
 *    straight into it (`dropIndicatorStyle` / `rectStyle`).
 *  - **The reason arrives while the pointer is still down.** A refused drop
 *    used to show only a red box, with the sentence explaining it arriving as
 *    a toast after `pointerup` — by which time the user has let go and moved
 *    on. `previewStructuralMove` already computed the verdict mid-gesture and
 *    `explainGestureConstraint` was written to translate it; this is what
 *    finally renders that translation, at the moment the user is looking at
 *    the thing it is about.
 */
import type { CanvasDropResolution } from './canvasDnd'
import { dropIndicatorStyle, rectStyle } from './canvasSelectionOverlayPositioning'
import styles from './BreakpointSelectionOverlay.module.css'

export function CanvasDropIndicators({ target, invalid }: CanvasDropResolution) {
  return (
    <div className={styles.overlayLayer}>
      {target && (
        <div
          className={styles.dropIndicator}
          data-position={target.position}
          data-axis={target.axis}
          style={dropIndicatorStyle(target)}
          aria-hidden="true"
        />
      )}

      {invalid && (
        <div
          className={styles.invalidDropIndicator}
          style={rectStyle(invalid.rect)}
          data-axis={invalid.axis}
          // G5 — present when this box means "this position would refuse the
          // source write" (a real drop target the store's own gate would still
          // reject — shared component, route chrome, …), distinct from an
          // ordinary structural rejection (locked node, cycle) which carries
          // no constraint at all.
          data-refusal-reason={invalid.constraint ? 'source-writeback' : undefined}
          aria-hidden="true"
        />
      )}

      {/* The chip counter-scales by `1 / --canvas-zoom` for the same reason
          comment pins do: the sentence has to stay readable at 25% zoom. */}
      {invalid?.constraint && (
        <div
          className={styles.dropRefusalChip}
          style={rectStyle(invalid.rect)}
          data-testid="canvas-drop-refusal"
          data-refusal-reason={invalid.constraint.reason}
          aria-hidden="true"
        >
          <span className={styles.dropRefusalChipLabel}>{invalid.constraint.explanation}</span>
        </div>
      )}
    </div>
  )
}
