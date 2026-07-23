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
 * Purely decorative: `pointer-events: none` on every line, so guides never
 * intercept the drag they're illustrating.
 */
import type { CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectBoardSnapGuides } from '@site/store/slices/boardSlice'
import styles from './BoardGuidesLayer.module.css'

export function BoardGuidesLayer() {
  const guides = useEditorStore(selectBoardSnapGuides)

  if (guides.length === 0) return null

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
    </div>
  )
}
