/**
 * DraftCommentPin — a pin that has been placed but not yet said anything.
 *
 * It exists only in `commentsSlice.draftPin` and has no `seq`, because `seq`
 * is consumed server-side when the thread is actually created — handing one
 * out optimistically would burn a number on every abandoned draft and leave
 * permanent gaps in the sequence people use to refer to threads.
 *
 * Cancelling discards it entirely. That is why an empty body is refused all
 * the way down in `commentsModel.createThread`: an empty thread would be an
 * unopenable, undeletable marker, and this is the surface that would produce
 * them by the dozen.
 */
import { useEditorStore } from '@site/store/store'
import type { DraftPin } from '@site/store/slices/commentsSlice'
import { submitDraftThread } from '@site/studio/commentActions'
import { CommentComposer } from './CommentComposer'
import { cn } from '@ui/cn'
import { pinPosition, type PinFrame } from './pinPosition'
import { usePopoverFlip } from './usePopoverFlip'
import styles from './BoardCommentsLayer.module.css'
import pinStyles from './CommentPin.module.css'
import popoverStyles from './CommentThreadPopover.module.css'

interface DraftCommentPinProps {
  draft: DraftPin
  frames: readonly PinFrame[]
}

export function DraftCommentPin({ draft, frames }: DraftCommentPinProps) {
  const cancelDraftPin = useEditorStore((s) => s.cancelDraftPin)
  // Same flip as the committed thread's popover, or submitting a comment near
  // the right edge would make it jump from one side of the pin to the other.
  const { ref: popoverRef, flipped } = usePopoverFlip()
  // Shared with the committed-thread path, so a draft pin cannot land anywhere
  // other than where its committed twin will appear.
  const { x, y } = pinPosition(draft.anchor, frames)

  return (
    <div className={styles.anchored} style={{ left: `${x}px`, top: `${y}px` }}>
      <span className={`${pinStyles.pin} ${pinStyles.draft}`} data-testid="comment-pin-draft" />
      <div
        ref={popoverRef}
        className={cn(popoverStyles.popover, flipped && popoverStyles.popoverFlipped)}
        role="dialog"
        aria-label="New comment"
        data-testid="comment-draft-popover"
        // See `CommentThreadPopover` for why there is no `onPointerDown`
        // stopPropagation here — it blinds `@use-gesture`'s tap detection and
        // kills every click inside the popover.
        onClick={(event) => event.stopPropagation()}
      >
        <CommentComposer
          autoFocus
          placeholder="Add a comment"
          submitLabel="Comment"
          onCancel={cancelDraftPin}
          onSubmit={(body) => submitDraftThread(draft.boardId, draft.anchor, body)}
        />
      </div>
    </div>
  )
}
