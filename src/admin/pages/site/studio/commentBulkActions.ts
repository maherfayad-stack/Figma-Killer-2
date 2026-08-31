/**
 * commentBulkActions — the two actions that operate on the panel's working set.
 *
 * Split from `commentActions.ts` because they are a different shape: those are
 * one gesture → one op → adopt the result, while these fan a selection out and
 * have to decide what a PARTIAL success means.
 *
 * DELETE IS SEQUENTIAL, AND STOPS COUNTING RATHER THAN STOPPING
 * ────────────────────────────────────────────────────────────
 * Each delete is its own request and the server returns the whole merged file
 * each time, so firing them in parallel would have N responses racing to be
 * the last writer of local state — the surviving one being whichever landed
 * last, not whichever is newest. Sequential means the final adopt is the file
 * that saw every delete. A failure mid-run does NOT abort: the remaining
 * threads were chosen by the user too, and stopping would leave the selection
 * half-applied with no way to tell which half. The toast reports the tally.
 *
 * "SEND TO AI" SENDS, IT DOES NOT PREFILL
 * ───────────────────────────────────────
 * The composer's draft is local component state, so there is nothing to
 * prefill from here without lifting it into the store for one caller. Sending
 * outright is also the more honest reading of the button: the user picked the
 * threads and pressed a button named "Send", and the agent's own transcript
 * then shows exactly what was sent — which a silently-populated text box does
 * not.
 *
 * The agent gets each thread's `#seq`, page, anchored element and full
 * conversation, plus the standing instruction to resolve what it fixes. That
 * mirrors what `studio_resolve_comment` does for a single thread, so the agent
 * meets the same anchor gate either way — see `commentTools.ts`.
 */
import { useEditorStore } from '@site/store/store'
import { pushToast } from '@ui/components/Toast'
import type { CommentThread } from '@core/studio-comments'
import { deleteThreadById } from './commentActions'

/**
 * Delete every thread in `threadIds`. Returns the number actually deleted;
 * callers use it only to decide whether to clear the selection.
 */
export async function deleteThreadsById(threadIds: readonly string[]): Promise<number> {
  let deleted = 0
  for (const threadId of threadIds) {
    // `deleteThreadById` toasts its own failure, so a run of failures produces
    // a run of toasts — which is right: each one names a thread the user asked
    // to delete and did not get.
    const before = useEditorStore.getState().comments.threads.length
    await deleteThreadById(threadId)
    if (useEditorStore.getState().comments.threads.length < before) deleted += 1
  }
  useEditorStore.getState().clearSelectedThreads()
  return deleted
}

/** One thread, rendered for the agent. */
function formatThread(thread: CommentThread): string {
  const lines = [
    `### Comment #${thread.seq}${thread.resolved ? ' (resolved)' : ''}`,
    thread.anchor.pageId ? `- Page: ${thread.anchor.pageId}` : null,
    thread.anchor.node
      ? `- Element: ${thread.anchor.node.moduleId} at ${thread.anchor.node.nodeId}`
      : '- Not anchored to an element (free-floating pin on the board)',
    '',
    ...thread.comments.map(
      (comment) => `${comment.author.displayName}: ${comment.body}`,
    ),
  ]
  return lines.filter((line) => line !== null).join('\n')
}

/**
 * Open the AI assistant and hand it the selected threads as one message.
 * Returns false when there is nothing to send.
 */
export async function sendThreadsToAgent(threads: readonly CommentThread[]): Promise<boolean> {
  if (threads.length === 0) return false

  const store = useEditorStore.getState()
  const body = [
    threads.length === 1
      ? 'Please address this review comment.'
      : `Please address these ${threads.length} review comments.`,
    '',
    'For each one: make the change in the source, reply in the thread saying what',
    'you did, and resolve it. If a comment’s anchor no longer resolves, do not',
    'guess — reply explaining why you cannot act on it and leave it open.',
    '',
    ...threads.map(formatThread),
  ].join('\n')

  store.openAgent()
  const { accepted } = await store.sendAgentMessage([{ kind: 'text', text: body }])
  if (!accepted) {
    pushToast({
      kind: 'error',
      title: 'Could not send to the assistant',
      body: 'The assistant did not accept the message. Check that a model is selected.',
    })
    return false
  }
  store.clearSelectedThreads()
  return true
}
