/**
 * CommentPin — the numbered marker on the board.
 *
 * The number is the thread's `seq`, which is stable for the life of the
 * project and never reused, so "look at 3" means the same thing tomorrow and
 * in an agent's tool call.
 *
 * A resolved pin is drawn hollow rather than hidden: the filter decides
 * visibility, and when someone has deliberately switched to All or Resolved
 * they need to tell the two apart at a glance.
 */
import { useEditorStore } from '@site/store/store'
import { selectThreadAnchorConfidence } from '@site/store/slices/commentSelectors'
import type { CommentThread } from '@core/studio-comments'
import { cn } from '@ui/cn'
import styles from './CommentPin.module.css'

interface CommentPinProps {
  thread: CommentThread
  active: boolean
}

export function CommentPin({ thread, active }: CommentPinProps) {
  const setActiveCommentThread = useEditorStore((s) => s.setActiveCommentThread)
  const confidence = useEditorStore((s) => selectThreadAnchorConfidence(s, thread))
  const replies = thread.comments.length - 1
  const detached = confidence === 'detached'

  // The pin is a real button so it is tab-reachable and announces itself; the
  // accessible name carries what the marker can only imply — who started the
  // thread, how long it has grown, and whether its target still exists.
  const label = [
    `Comment ${thread.seq}`,
    `by ${thread.comments[0]?.author.displayName ?? 'Unknown'}`,
    replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : null,
    thread.resolved ? 'resolved' : null,
    detached ? 'element missing' : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <button
      type="button"
      className={cn(styles.pin, active && styles.active, thread.resolved && styles.resolved)}
      data-testid={`comment-pin-${thread.seq}`}
      data-confidence={confidence}
      aria-label={label}
      aria-expanded={active}
      onPointerDown={(event) => {
        // The canvas listens for pointerdown to place a new pin and to clear
        // selection. Stopping here is what makes clicking an existing pin open
        // it instead of dropping a second pin on top of it.
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        setActiveCommentThread(active ? null : thread.id)
      }}
    >
      <span className={styles.seq}>{thread.seq}</span>
      {replies > 0 ? <span className={styles.replies}>{replies}</span> : null}
      {detached ? <span className={styles.detached} aria-hidden="true" /> : null}
    </button>
  )
}
