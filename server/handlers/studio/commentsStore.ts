/**
 * commentsStore — the server side of `<dir>/.studio/comments.json`.
 *
 * Two things live here that could not live in `@core/studio-comments`:
 * **who** wrote a comment, and **when**. Both are the server's to decide, and
 * for one hard reason — a browser-supplied author is a forgery. Any
 * authenticated account could otherwise POST a comment signed as the project
 * owner, or signed as the agent, which is worse: an agent byline is the thing
 * a reviewer trusts to mean "this was machine-written". So `authorFromSession`
 * is the ONLY way a `CommentAuthor` is ever constructed on a request path, and
 * the request body has no author field at all to ignore.
 *
 * WHY OPERATIONS, NOT WHOLE-FILE WRITES
 * ─────────────────────────────────────
 * `/admin/api/studio/boards` POSTs the entire `BoardsFile` and lets the last
 * writer win. That is correct THERE: board geometry has exactly one writer —
 * the person dragging — so a lost update needs two people dragging the same
 * board in the same second.
 *
 * Comments are multi-writer by definition. That is the feature. A reviewer
 * commenting while the designer replies, or the agent replying while either of
 * them types, is the NORMAL case, and under whole-file semantics one of those
 * writes silently disappears. So a request carries one intent (`CommentOp`),
 * the server applies it to the file it just read, and concurrent writers
 * merge instead of clobbering. It is barely more code than the boards route
 * and it removes the entire class.
 *
 * (This is still read-modify-write within one process, not a transaction. Two
 * requests interleaving between `readCommentsFile` and `writeCommentsFile`
 * could still lose one. Bun serves these handlers on a single thread and each
 * op is a few microseconds of pure array work, so the window is not reachable
 * in practice — but it is a window, and if comments ever move off the local
 * filesystem this is the line that needs a lock.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  CommentAnchorSchema,
  addReply,
  createCommentsFile,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  findThread,
  moveThread,
  parseCommentsFile,
  serializeCommentsFile,
  setThreadResolved,
  type CommentAuthor,
  type CommentsFile,
} from '@core/studio-comments'

export function commentsFilePath(dir: string): string {
  return join(dir, '.studio', 'comments.json')
}

export function readCommentsFile(dir: string): CommentsFile {
  const file = commentsFilePath(dir)
  return existsSync(file) ? parseCommentsFile(readFileSync(file, 'utf8')) : createCommentsFile()
}

export function writeCommentsFile(dir: string, file: CommentsFile): void {
  const path = commentsFilePath(dir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeCommentsFile(file))
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Note what is ABSENT from every variant: `author`, `id`, and any timestamp.
 * A caller states an intent; identity and clock are stamped server-side.
 */
export const CommentOpSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('create-thread'),
    boardId: Type.String(),
    anchor: CommentAnchorSchema,
    body: Type.String(),
  }),
  Type.Object({ kind: Type.Literal('reply'), threadId: Type.String(), body: Type.String() }),
  Type.Object({
    kind: Type.Literal('edit'),
    threadId: Type.String(),
    commentId: Type.String(),
    body: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('delete-comment'),
    threadId: Type.String(),
    commentId: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('set-resolved'),
    threadId: Type.String(),
    resolved: Type.Boolean(),
  }),
  Type.Object({ kind: Type.Literal('move'), threadId: Type.String(), anchor: CommentAnchorSchema }),
  Type.Object({ kind: Type.Literal('delete-thread'), threadId: Type.String() }),
])
export type CommentOp = Static<typeof CommentOpSchema>

export type CommentOpResult =
  | { ok: true; file: CommentsFile; changed: boolean }
  | { ok: false; status: 403 | 404; error: string }

/**
 * Build the author for a write, from the session's own user record.
 *
 * `displayName` is COPIED IN rather than referenced, so the file still names
 * its authors after a clone onto a machine whose `users` table has never heard
 * of these ids. That redundancy is the point of storing threads on disk.
 */
export function authorFromSession(
  user: { id: string; displayName: string },
  kind: CommentAuthor['kind'] = 'user',
): CommentAuthor {
  return { userId: user.id, displayName: user.displayName || 'Unknown', kind }
}

/**
 * Apply one operation. Pure with respect to the filesystem — the caller reads,
 * applies, and writes, which is what makes this testable without a temp dir.
 *
 * `changed: false` is a SUCCESS, not an error: the model's transforms return
 * `null` for a write that would change nothing (resolving an already-resolved
 * thread, an edit to identical text), and the caller skips the disk write
 * rather than rewriting a byte-identical file.
 */
export function applyCommentOp(
  file: CommentsFile,
  op: CommentOp,
  author: CommentAuthor,
  now: string,
): CommentOpResult {
  const unchanged = { ok: true as const, file, changed: false }

  switch (op.kind) {
    case 'create-thread': {
      const next = createThread(file, {
        id: randomUUID(),
        commentId: randomUUID(),
        boardId: op.boardId,
        anchor: op.anchor,
        author,
        body: op.body,
        now,
      })
      return next ? { ok: true, file: next, changed: true } : unchanged
    }

    case 'reply': {
      if (!findThread(file, op.threadId)) return notFound(op.threadId)
      const next = addReply(file, op.threadId, { id: randomUUID(), author, body: op.body, now })
      return next ? { ok: true, file: next, changed: true } : unchanged
    }

    case 'edit': {
      const thread = findThread(file, op.threadId)
      if (!thread) return notFound(op.threadId)
      const comment = thread.comments.find((c) => c.id === op.commentId)
      if (!comment) return notFound(op.commentId)
      // Ownership is enforced HERE and nowhere else — `editComment` is a pure
      // transform with no notion of a current user, and the browser's own
      // check is a UI affordance, not a boundary.
      if (comment.author.userId !== author.userId) {
        return { ok: false, status: 403, error: 'You can only edit your own comments' }
      }
      const next = editComment(file, op.threadId, op.commentId, op.body, now)
      return next ? { ok: true, file: next, changed: true } : unchanged
    }

    case 'delete-comment': {
      const thread = findThread(file, op.threadId)
      if (!thread) return notFound(op.threadId)
      const comment = thread.comments.find((c) => c.id === op.commentId)
      if (!comment) return notFound(op.commentId)
      if (comment.author.userId !== author.userId) {
        return { ok: false, status: 403, error: 'You can only delete your own comments' }
      }
      const next = deleteComment(file, op.threadId, op.commentId)
      return next ? { ok: true, file: next, changed: true } : unchanged
    }

    case 'set-resolved': {
      // Deliberately NOT ownership-gated. Resolving is the reviewer's signal
      // that a conversation is finished, and in Figma anyone in the file can
      // do it — gating it to the author would leave threads open forever
      // whenever the author moves on. Nothing is lost: resolve is reversible
      // and the thread keeps its number.
      if (!findThread(file, op.threadId)) return notFound(op.threadId)
      const next = setThreadResolved(file, op.threadId, op.resolved)
      return next ? { ok: true, file: next, changed: true } : unchanged
    }

    case 'move': {
      if (!findThread(file, op.threadId)) return notFound(op.threadId)
      const next = moveThread(file, op.threadId, op.anchor)
      return next ? { ok: true, file: next, changed: true } : unchanged
    }

    case 'delete-thread': {
      const thread = findThread(file, op.threadId)
      if (!thread) return notFound(op.threadId)
      // The thread belongs to whoever started it — its first comment's author.
      const owner = thread.comments[0]?.author.userId
      if (owner !== author.userId) {
        return { ok: false, status: 403, error: 'You can only delete threads you started' }
      }
      const next = deleteThread(file, op.threadId)
      return next ? { ok: true, file: next, changed: true } : unchanged
    }
  }
}

function notFound(id: string): CommentOpResult {
  return { ok: false, status: 404, error: `No such comment or thread: ${id}` }
}
