/**
 * CommentThreadPopover — one open conversation, anchored to its pin.
 *
 * Layout follows the Framer/Sketch shape from the reference pass: a compact
 * header carrying the thread number and Resolve, the comments in order, then a
 * one-line reply row. Per-comment and per-thread actions live behind a ⋯ menu
 * (`CommentKebab`) rather than as inline buttons — see that file. Like the pin,
 * the popover counter-scales by `1 / var(--canvas-zoom)` so it is the same
 * readable size at 20% and 200%.
 *
 * Side selection (below-right, flipping to below-left near the canvas edge)
 * is `usePopoverFlip`, shared with the draft popover so a comment does not
 * jump sides the moment it is submitted.
 *
 * DISMISS
 * ───────
 * A pointer down anywhere outside closes the thread, including inside the
 * preview iframes — `useOutsidePointerDismiss` handles the cross-document
 * detail. Two things count as "inside" beyond the popover itself:
 *
 *   - An open kebab menu, which portals to `document.body` and is therefore
 *     NOT a DOM descendant of the popover. Without `menuOpen` here, opening ⋯
 *     and clicking Delete would dismiss the thread on mousedown and the click
 *     would land on whatever the menu was covering.
 *   - Nothing else. In particular a click on the pin is deliberately outside:
 *     the pin's own handler re-opens the thread it just closed, which is what
 *     makes the pin a toggle.
 *
 * The stale-anchor notice is the one piece with no analogue in Figma or
 * Penpot, and the reason it exists is in `anchorResolve.ts`: our node ids are
 * source positions, so the element a comment names can be edited or deleted
 * out from under it. When that happens the thread says so, in the same words
 * the agent uses when it refuses to act — one explanation, one vocabulary.
 */
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectThreadAnchorConfidence } from '@site/store/slices/commentSelectors'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { explainAnchorRefusal, type CommentThread } from '@core/studio-comments'
import { Button } from '@ui/components/Button'
import { ContextMenuItem } from '@ui/components/ContextMenu'
import { useOutsidePointerDismiss } from '@ui/lib/useOutsidePointerDismiss'
import { cn } from '@ui/cn'
import {
  deleteCommentById,
  deleteThreadById,
  editCommentBody,
  replyToThread,
  setThreadResolvedById,
} from '@site/studio/commentActions'
import { CommentComposer } from './CommentComposer'
import { CommentKebab } from './CommentKebab'
import { usePopoverFlip } from './usePopoverFlip'
import styles from './CommentThreadPopover.module.css'

/** `2026-08-31T09:12:04Z` → `31 Aug, 09:12`. Absolute, not "3 hours ago". */
function formatStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface CommentThreadPopoverProps {
  thread: CommentThread
}

export function CommentThreadPopover({ thread }: CommentThreadPopoverProps) {
  const currentUser = useAuthenticatedAdminUser()
  const setActiveCommentThread = useEditorStore((s) => s.setActiveCommentThread)
  const confidence = useEditorStore((s) => selectThreadAnchorConfidence(s, thread))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const { ref: popoverRef, flipped } = usePopoverFlip()

  useOutsidePointerDismiss({
    onDismiss: () => setActiveCommentThread(null),
    ignore: [popoverRef],
    // An open kebab portals outside this subtree — see the module doc.
    enabled: !menuOpen,
  })

  const staleNotice = explainAnchorRefusal(confidence)
  const startedByMe = thread.comments[0]?.author.userId === currentUser.id

  return (
    <div
      ref={popoverRef}
      className={cn(styles.popover, flipped && styles.popoverFlipped)}
      role="dialog"
      aria-label={`Comment ${thread.seq}`}
      data-testid={`comment-thread-${thread.seq}`}
      // Every pointer event inside the thread is for the thread. Without this
      // the canvas beneath treats a click on the reply box as "deselect and
      // maybe place a new pin".
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <header className={styles.header}>
        <span className={styles.seq}>#{thread.seq}</span>
        {thread.resolved ? <span className={styles.resolvedTag}>Resolved</span> : null}
        <span className={styles.spacer} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void setThreadResolvedById(thread.id, !thread.resolved)}
        >
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </Button>
        {startedByMe ? (
          <CommentKebab ariaLabel={`Thread ${thread.seq} actions`} onOpenChange={setMenuOpen}>
            {(close) => (
              <ContextMenuItem
                danger
                onClick={() => {
                  close()
                  void deleteThreadById(thread.id)
                }}
              >
                Delete thread
              </ContextMenuItem>
            )}
          </CommentKebab>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close comment"
          onClick={() => setActiveCommentThread(null)}
        >
          ✕
        </Button>
      </header>

      {staleNotice ? (
        <p className={styles.stale} role="status">
          {staleNotice}
        </p>
      ) : null}

      <ol className={styles.comments}>
        {thread.comments.map((comment) => {
          const mine = comment.author.userId === currentUser.id && comment.author.kind === 'user'
          return (
            <li key={comment.id} className={styles.comment}>
              <div className={styles.byline}>
                <span className={cn(styles.author, comment.author.kind === 'agent' && styles.agent)}>
                  {comment.author.displayName}
                </span>
                {comment.author.kind === 'agent' ? <span className={styles.agentTag}>AI</span> : null}
                <time className={styles.stamp} dateTime={comment.createdAt}>
                  {formatStamp(comment.createdAt)}
                </time>
                {comment.editedAt ? <span className={styles.stamp}>edited</span> : null}
                {mine && editingId !== comment.id ? (
                  <>
                    <span className={styles.spacer} />
                    <CommentKebab
                      ariaLabel="Comment actions"
                      onOpenChange={setMenuOpen}
                    >
                      {(close) => (
                        <>
                          <ContextMenuItem
                            onClick={() => {
                              close()
                              setEditingId(comment.id)
                            }}
                          >
                            Edit
                          </ContextMenuItem>
                          <ContextMenuItem
                            danger
                            onClick={() => {
                              close()
                              void deleteCommentById(thread.id, comment.id)
                            }}
                          >
                            Delete
                          </ContextMenuItem>
                        </>
                      )}
                    </CommentKebab>
                  </>
                ) : null}
              </div>

              {editingId === comment.id ? (
                <CommentComposer
                  autoFocus
                  placeholder="Edit comment"
                  submitLabel="Save"
                  initialValue={comment.body}
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (body) => {
                    await editCommentBody(thread.id, comment.id, body)
                    setEditingId(null)
                  }}
                />
              ) : (
                <p className={styles.body}>{comment.body}</p>
              )}
            </li>
          )
        })}
      </ol>

      <CommentComposer
        layout="inline"
        placeholder={thread.resolved ? 'Reopen and comment…' : 'Reply…'}
        submitLabel="Reply"
        onSubmit={(body) => replyToThread(thread.id, body)}
      />
    </div>
  )
}
