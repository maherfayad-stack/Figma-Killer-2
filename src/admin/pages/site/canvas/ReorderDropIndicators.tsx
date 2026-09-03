/**
 * ReorderDropIndicators — the drop line and the refusal box drawn while a
 * layer is being dragged to a new position.
 *
 * These stay in the BREAKPOINT VIEWPORT, not in the iframe overlay root the
 * rings moved to (WS-5.1): they appear only transiently during a drag, and the
 * transform-scaled coordinate path is already established for them through
 * `dropIndicatorStyle` / `rectStyle`. There was no drift problem here to solve.
 *
 * Split out of `BreakpointSelectionOverlay` when that file crossed the
 * module-size ceiling. It is a clean seam: this is pure presentation driven by
 * one resolved value, with no measurement, no refs and no lifecycle of its
 * own — everything that makes the overlay complicated stays in the overlay.
 */
import type { CanvasDropResolution } from './canvasDnd'
import { dropIndicatorStyle, rectStyle } from './canvasSelectionOverlayPositioning'
import styles from './BreakpointSelectionOverlay.module.css'

interface ReorderDropIndicatorsProps {
  target: CanvasDropResolution['target']
  invalid: CanvasDropResolution['invalid']
}

export function ReorderDropIndicators({ target, invalid }: ReorderDropIndicatorsProps) {
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
          // ordinary structural rejection (locked node, cycle) which carries no
          // message. `invalid.refusalMessage` holds the full sentence for a
          // FUTURE cursor-following label — not wired to a visible tooltip
          // here: this element is `pointer-events: none` (so a native `title`
          // would never fire) and a real label needs a small positioned
          // component that pass didn't build. The red box itself is what ships
          // today — previously this exact case (a structurally valid position
          // the write would still refuse) rendered a confident VALID drop line.
          data-refusal-reason={invalid.refusalMessage ? 'source-writeback' : undefined}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
