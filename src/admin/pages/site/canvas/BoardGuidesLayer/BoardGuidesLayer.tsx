/**
 * BoardGuidesLayer — renders the active drag's alignment guide lines
 * (Phase 6B snap-to-peer), mounted last inside `CanvasTransformLayer` so it
 * paints above frames/notes/docs and inherits the canvas pan/zoom transform.
 *
 * Reads the transient `boardSnapGuides` store field — populated by whichever
 * furniture view (`BoardFrameView`, `StickyNoteView`, `DocBlockView`) is
 * currently being dragged, via `computeSnap` (`../boardSnapping`), and
 * cleared on pointer-up/cancel. Renders nothing outside an active drag.
 *
 * P5-F / IX-5d — the same drag's equal-spacing pills (`boardSnapSpacings`)
 * render here too: a hairline across each equal gap and a counter-scaled pill
 * with its length, the board-space twin of what `canvasDragPainter` draws for
 * an element inside a frame. One number format for both (`formatSpacing`).
 *
 * Purely decorative: `pointer-events: none` on every line, so guides never
 * intercept the drag they're illustrating.
 */
import type { CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectBoardSnapGuides, selectBoardSnapSpacings } from '@site/store/slices/boardSelectors'
import { formatSpacing } from '@core/studio-runtime'
import styles from './BoardGuidesLayer.module.css'

export function BoardGuidesLayer() {
  const guides = useEditorStore(selectBoardSnapGuides)
  const spacings = useEditorStore(selectBoardSnapSpacings)

  if (guides.length === 0 && spacings.length === 0) return null

  return (
    <div className={styles.layer} data-testid="board-guides-layer" aria-hidden="true">
      {guides.map((guide, index) => (
        <div
          key={`${guide.axis}-${index}`}
          className={styles.line}
          data-axis={guide.axis}
          style={{
            '--guide-position': `${guide.position}px`,
            '--guide-start': `${guide.start}px`,
            '--guide-length': `${guide.end - guide.start}px`,
          } as CSSProperties}
        />
      ))}
      {spacings.map((spacing, index) => (
        <div
          key={`spacing-${spacing.axis}-${index}`}
          className={styles.spacing}
          data-axis={spacing.axis}
          data-testid="board-snap-spacing"
          style={{
            '--spacing-from': `${spacing.from}px`,
            '--spacing-at': `${spacing.at}px`,
            '--spacing-length': `${spacing.to - spacing.from}px`,
          } as CSSProperties}
        >
          <span className={styles.spacingPill}>{formatSpacing(spacing.value)}</span>
        </div>
      ))}
    </div>
  )
}
