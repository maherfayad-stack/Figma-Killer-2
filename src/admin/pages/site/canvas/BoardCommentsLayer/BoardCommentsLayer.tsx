/**
 * BoardCommentsLayer — review pins and their thread popovers.
 *
 * Mounted LAST in `StudioBoardLayers`, so a pin stays clickable above frames,
 * notes, docs and guides. Self-gates on `selectHasActiveBoard`, like every
 * other board layer, so it is inert outside studio mode.
 *
 * POSITIONING — why a stored coordinate, not a live DOM rect
 * ──────────────────────────────────────────────────────────
 * A pin renders at `frame.x + anchor.dx, frame.y + anchor.dy` in BOARD
 * coordinates, and inherits pan/zoom for free by living inside
 * `CanvasTransformLayer`. It does NOT track the live rect of the element it
 * points at, and that is deliberate on three counts:
 *
 *   - It matches both references. Penpot pairs `position` with `frame-id`;
 *     Figma pins a comment to a point unless you explicitly attach it.
 *   - Tracking a rect means a rAF loop reading across an iframe boundary
 *     (`canvasOverlayGeometry.ts`) for every pin, every frame — and a whole
 *     family of "the frame had not loaded yet" ordering bugs.
 *   - It degrades honestly. When the anchored element is gone, a
 *     rect-tracking pin has nowhere to go; a coordinate-anchored one is still
 *     exactly where the reviewer put it, and only its BADGE changes.
 *
 * So the coordinate is where the comment IS, and `anchor.node` is what the
 * comment is ABOUT. The second can rot without moving the first — see
 * `@core/studio-comments`'s `anchorResolve.ts`.
 *
 * SIZE: pins counter-scale by `1 / var(--canvas-zoom)` in CSS, so they stay
 * legible and clickable at any zoom. Pure CSS rather than a subscription
 * because the store's `zoom` is committed 100 ms after the last gesture event
 * — see the custom property's own comment in `useCanvas.ts`.
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { matchesCommentFilter } from '@site/store/slices/commentSelectors'
import { CommentPin } from './CommentPin'
import { CommentThreadPopover } from './CommentThreadPopover'
import { DraftCommentPin } from './DraftCommentPin'
import { pinPosition } from './pinPosition'
import styles from './BoardCommentsLayer.module.css'

export function BoardCommentsLayer() {
  const board = useEditorStore(selectActiveBoard)
  const threads = useEditorStore((s) => s.comments.threads)
  const filter = useEditorStore((s) => s.commentFilter)
  const activeThreadId = useEditorStore((s) => s.activeThreadId)
  const draftPin = useEditorStore((s) => s.draftPin)

  if (!board) return null

  const visible = threads.filter(
    (thread) =>
      thread.boardId === board.id &&
      // The open thread stays on screen even when the filter would hide it —
      // resolving a thread from its own popover must not make the popover
      // disappear mid-gesture.
      (thread.id === activeThreadId || matchesCommentFilter(thread, filter)),
  )

  return (
    <div className={styles.layer} data-testid="board-comments-layer">
      {visible.map((thread) => {
        const { x, y } = pinPosition(thread.anchor, board.frames)
        return (
          <div key={thread.id} className={styles.anchored} style={{ left: `${x}px`, top: `${y}px` }}>
            <CommentPin thread={thread} active={thread.id === activeThreadId} />
            {thread.id === activeThreadId ? <CommentThreadPopover thread={thread} /> : null}
          </div>
        )
      })}

      {draftPin && draftPin.boardId === board.id ? (
        <DraftCommentPin draft={draftPin} frames={board.frames} />
      ) : null}
    </div>
  )
}
