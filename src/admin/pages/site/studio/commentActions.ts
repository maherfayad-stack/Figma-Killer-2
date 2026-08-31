/**
 * commentActions — the round trip between a UI gesture and the comments file.
 *
 * Each function here posts ONE op, adopts the server's merged result into the
 * store, and toasts on failure. They live outside `commentsSlice.ts` because
 * that slice is a pure state container with no HTTP — the same split
 * `boardSlice`'s doc prescribes for `frameDefaults`.
 *
 * FAILURE POSTURE: a failed write leaves store state exactly as it was and
 * raises a toast. There is deliberately no optimistic insert-then-roll-back.
 * A comment that appears, then vanishes a moment later, is worse than one that
 * takes 40 ms to appear — the author cannot tell whether it was sent, and the
 * whole value of a review thread is that what you can see is what everybody
 * else can see.
 */
import { useEditorStore } from '@site/store/store'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { CommentAnchor } from '@core/studio-comments'
import { applyCommentOp, fetchComments, type CommentOp } from './commentsApi'

async function run(op: CommentOp, failureTitle: string): Promise<boolean> {
  try {
    const file = await applyCommentOp(op, getStudioWorkspaceDir())
    useEditorStore.getState().adoptComments(file)
    return true
  } catch (err) {
    console.error('[commentActions] comment operation failed:', err)
    pushToast({
      kind: 'error',
      title: failureTitle,
      body: getErrorMessage(err, 'Unknown error writing comments'),
    })
    return false
  }
}

/** Re-read the whole file — after a load, a project switch, or an agent push. */
export async function reloadComments(): Promise<void> {
  try {
    const file = await fetchComments(getStudioWorkspaceDir())
    useEditorStore.getState().loadComments(file)
  } catch (err) {
    console.error('[commentActions] failed to load comments:', err)
    useEditorStore.getState().markCommentsLoadFailed()
    pushToast({
      kind: 'error',
      title: 'Failed to load comments',
      body: getErrorMessage(err, 'Unknown error loading studio comments'),
    })
  }
}

/**
 * Commit the draft pin as a real thread. Clears the draft on success and
 * opens the thread that was just created, so the author lands in the
 * conversation they started rather than back on an empty canvas.
 */
export async function submitDraftThread(
  boardId: string,
  anchor: CommentAnchor,
  body: string,
): Promise<void> {
  const before = new Set(useEditorStore.getState().comments.threads.map((t) => t.id))
  const ok = await run({ kind: 'create-thread', boardId, anchor, body }, 'Failed to post comment')
  if (!ok) return
  const state = useEditorStore.getState()
  state.cancelDraftPin()
  const created = state.comments.threads.find((thread) => !before.has(thread.id))
  if (created) state.setActiveCommentThread(created.id)
}

export async function replyToThread(threadId: string, body: string): Promise<void> {
  await run({ kind: 'reply', threadId, body }, 'Failed to post reply')
}

export async function editCommentBody(
  threadId: string,
  commentId: string,
  body: string,
): Promise<void> {
  await run({ kind: 'edit', threadId, commentId, body }, 'Failed to edit comment')
}

export async function deleteCommentById(threadId: string, commentId: string): Promise<void> {
  await run({ kind: 'delete-comment', threadId, commentId }, 'Failed to delete comment')
}

/**
 * Resolve or reopen. Resolving closes the popover — the thread is done, and
 * leaving it open invites a reply to a conversation that was just ended.
 * Reopening keeps it open, because reopening is the start of saying more.
 */
export async function setThreadResolvedById(threadId: string, resolved: boolean): Promise<void> {
  const ok = await run(
    { kind: 'set-resolved', threadId, resolved },
    resolved ? 'Failed to resolve comment' : 'Failed to reopen comment',
  )
  if (ok && resolved) useEditorStore.getState().setActiveCommentThread(null)
}

export async function moveThreadPin(threadId: string, anchor: CommentAnchor): Promise<void> {
  await run({ kind: 'move', threadId, anchor }, 'Failed to move comment')
}

export async function deleteThreadById(threadId: string): Promise<void> {
  const ok = await run({ kind: 'delete-thread', threadId }, 'Failed to delete thread')
  if (ok) useEditorStore.getState().setActiveCommentThread(null)
}
