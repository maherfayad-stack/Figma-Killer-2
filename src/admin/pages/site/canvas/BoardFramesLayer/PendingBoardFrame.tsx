/**
 * PendingBoardFrame — a board frame whose page is still on its way (P6-B).
 *
 * A project opens with the pages that have arrived; the rest follow over the
 * same `/load` stream (`streamedLoadSlice.ts`). Until its page lands, a frame
 * would otherwise simply not render (`resolveFramesWithPages` drops a frame
 * with no page), and the board would fill in as a set of frames popping into
 * empty space. This holds the frame's place and size instead: same position,
 * same box, the page's title in the header, and a quiet body. It is inert — no
 * drag, no menu, no iframe — and is replaced by the real `BoardFrameView` the
 * moment the page arrives, keyed by the same frame id.
 *
 * Carries `data-page-id` like a real frame, plus `data-page-pending`, so a
 * probe that counts frames can tell the two apart.
 */
import type { CSSProperties } from 'react'
import styles from './BoardFramesLayer.module.css'

interface PendingBoardFrameProps {
  pageId: string
  frameId: string
  title: string
  x: number
  y: number
  width: number
  height: number
}

export function PendingBoardFrame({ pageId, frameId, title, x, y, width, height }: PendingBoardFrameProps) {
  return (
    <div
      className={styles.frame}
      data-page-id={pageId}
      data-frame-id={frameId}
      data-page-pending="true"
      aria-busy="true"
      style={{ '--frame-x': `${x}px`, '--frame-y': `${y}px` } as CSSProperties}
    >
      <div className={styles.pendingHeader}>
        <span className={styles.title}>{title}</span>
      </div>
      <div
        className={styles.frameBody}
        data-testid="board-frame-pending"
        style={{ '--frame-w': `${width}px`, '--frame-h': `${height}px` } as CSSProperties}
      >
        <div className={styles.pendingBody} />
      </div>
    </div>
  )
}
