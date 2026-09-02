/**
 * commentsModel — every mutation of a `CommentsFile`, as pure transforms.
 *
 * Two conventions, both inherited from `@core/studio-board` on purpose:
 *
 *  1. **Ids and timestamps are PARAMETERS, never generated here.** `createBoard`
 *     takes its own id for the same reason: it keeps the model free of ambient
 *     dependencies (`nanoid`, `Date.now`), which makes every transform below
 *     trivially testable and lets the SERVER be the one that decides a
 *     comment's authorship and clock — which it must be, since a
 *     browser-supplied author is a forgery (see `commentsStore.ts`).
 *
 *  2. **`null` means "nothing to do".** Mirrors `boardAnnotationActions.ts`.
 *     A store action that gets `null` back skips its `set()` entirely rather
 *     than flipping the dirty flag and waking an autosave for a write that
 *     changed nothing.
 *
 * Sibling arrays are reused by reference wherever a transform does not touch
 * them, so narrow selectors over `threads` stay referentially stable — the
 * same discipline `boardsModel.ts`'s doc calls out as load-bearing for the
 * per-collection selectors.
 */
import type {
  Comment,
  CommentAnchor,
  CommentAuthor,
  CommentThread,
  CommentsFile,
} from './types'

export interface NewThreadInput {
  /** Thread id — caller-generated. */
  id: string
  /** Id for the thread's FIRST comment. A thread is created by its first comment. */
  commentId: string
  boardId: string
  anchor: CommentAnchor
  author: CommentAuthor
  body: string
  /** ISO-8601. */
  now: string
}

export interface NewReplyInput {
  id: string
  author: CommentAuthor
  body: string
  /** ISO-8601. */
  now: string
}

export function findThread(file: CommentsFile, threadId: string): CommentThread | undefined {
  return file.threads.find((thread) => thread.id === threadId)
}

/**
 * Append a thread and consume the next `seq`.
 *
 * An empty body is refused rather than stored: Figma discards an abandoned
 * draft, and a thread whose only comment is blank would be an unresolvable,
 * uneditable pin (`deleteComment` removes the thread with its last comment, so
 * such a pin could not even be cleared through the normal path).
 */
export function createThread(file: CommentsFile, input: NewThreadInput): CommentsFile | null {
  const body = input.body.trim()
  if (body.length === 0) return null

  const comment: Comment = {
    id: input.commentId,
    author: input.author,
    body,
    createdAt: input.now,
    editedAt: null,
  }
  const thread: CommentThread = {
    id: input.id,
    seq: file.nextSeq,
    boardId: input.boardId,
    anchor: input.anchor,
    resolved: false,
    createdAt: input.now,
    comments: [comment],
  }
  return { ...file, nextSeq: file.nextSeq + 1, threads: [...file.threads, thread] }
}

export function addReply(
  file: CommentsFile,
  threadId: string,
  input: NewReplyInput,
): CommentsFile | null {
  const body = input.body.trim()
  if (body.length === 0) return null
  const thread = findThread(file, threadId)
  if (!thread) return null

  const comment: Comment = {
    id: input.id,
    author: input.author,
    body,
    createdAt: input.now,
    editedAt: null,
  }
  return replaceThread(file, threadId, { ...thread, comments: [...thread.comments, comment] })
}

/**
 * Edit a comment's body in place.
 *
 * Ownership is NOT checked here — this is a pure data transform with no notion
 * of a current user. The caller that has one enforces it: `commentsStore.ts`
 * rejects an edit whose target `author.userId` is not the session's, which is
 * the only place the check can be trusted anyway.
 */
export function editComment(
  file: CommentsFile,
  threadId: string,
  commentId: string,
  body: string,
  now: string,
): CommentsFile | null {
  const trimmed = body.trim()
  if (trimmed.length === 0) return null
  const thread = findThread(file, threadId)
  if (!thread) return null
  const existing = thread.comments.find((comment) => comment.id === commentId)
  if (!existing || existing.body === trimmed) return null

  const comments = thread.comments.map((comment) =>
    comment.id === commentId ? { ...comment, body: trimmed, editedAt: now } : comment,
  )
  return replaceThread(file, threadId, { ...thread, comments })
}

/**
 * Delete one comment. Deleting a thread's LAST comment deletes the thread —
 * a pin with no comments is an unopenable marker, and leaving one behind is
 * how a board accumulates ghosts.
 */
export function deleteComment(
  file: CommentsFile,
  threadId: string,
  commentId: string,
): CommentsFile | null {
  const thread = findThread(file, threadId)
  if (!thread) return null
  const comments = thread.comments.filter((comment) => comment.id !== commentId)
  if (comments.length === thread.comments.length) return null
  if (comments.length === 0) return deleteThread(file, threadId)
  return replaceThread(file, threadId, { ...thread, comments })
}

/** Resolve or reopen. `seq` is untouched — a reopened thread keeps its number. */
export function setThreadResolved(
  file: CommentsFile,
  threadId: string,
  resolved: boolean,
): CommentsFile | null {
  const thread = findThread(file, threadId)
  if (!thread || thread.resolved === resolved) return null
  return replaceThread(file, threadId, { ...thread, resolved })
}

/** Reposition a pin (dragged to a new spot, possibly onto a different node). */
export function moveThread(
  file: CommentsFile,
  threadId: string,
  anchor: CommentAnchor,
): CommentsFile | null {
  const thread = findThread(file, threadId)
  if (!thread) return null
  return replaceThread(file, threadId, { ...thread, anchor })
}

/**
 * Rewrite a thread's stored node hint after a `moved` re-resolution, so the
 * next load hits the `exact` path instead of re-walking the index path. Purely
 * an optimisation of the same answer — never call it for `drifted`, which
 * would launder a real content change into a silent match.
 */
export function refreshThreadNodeId(
  file: CommentsFile,
  threadId: string,
  nodeId: string,
): CommentsFile | null {
  const thread = findThread(file, threadId)
  if (!thread?.anchor.node) return null
  if (thread.anchor.node.nodeId === nodeId) return null
  const anchor: CommentAnchor = {
    ...thread.anchor,
    node: { ...thread.anchor.node, nodeId },
  }
  return replaceThread(file, threadId, { ...thread, anchor })
}

export function deleteThread(file: CommentsFile, threadId: string): CommentsFile | null {
  const threads = file.threads.filter((thread) => thread.id !== threadId)
  if (threads.length === file.threads.length) return null
  // `nextSeq` is deliberately NOT rewound. Reusing a freed number would make
  // "comment 3" ambiguous across a conversation or an agent transcript.
  return { ...file, threads }
}

function replaceThread(
  file: CommentsFile,
  threadId: string,
  next: CommentThread,
): CommentsFile {
  return {
    ...file,
    threads: file.threads.map((thread) => (thread.id === threadId ? next : thread)),
  }
}
