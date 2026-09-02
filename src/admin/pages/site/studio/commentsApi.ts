/**
 * commentsApi — client for `/admin/api/studio/comments`.
 *
 * Mirrors `boardsApi.ts`'s posture: only the HTTP envelope is validated with
 * TypeBox here, because `parseCommentsFile` from `@core/studio-comments` is
 * the real shape validator and duplicating `CommentsFileSchema` as a second
 * envelope field would be a parallel, driftable copy of it.
 *
 * ONE DIFFERENCE FROM `boardsApi`, AND IT IS THE IMPORTANT ONE: there is no
 * `saveComments(file)`. A write sends ONE `CommentOp` and the server returns
 * the merged file. The store then adopts that response wholesale rather than
 * keeping its own optimistic copy, which is what lets a reply typed here and
 * a reply typed in another session both survive — see `commentsStore.ts`'s
 * module doc for why comments are op-shaped where board geometry is not.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { parseCommentsFile, type CommentAnchor, type CommentsFile } from '@core/studio-comments'

const CommentsGetResponseSchema = Type.Object({
  dir: Type.String(),
  comments: Type.Unknown(),
})

const CommentsPostResponseSchema = Type.Object({
  ok: Type.Boolean(),
  changed: Type.Boolean(),
  comments: Type.Unknown(),
})

/**
 * The client-side op vocabulary. Deliberately NOT imported from the server's
 * `CommentOpSchema` — `server/` is not reachable from the browser bundle — but
 * every field name here is checked against it by that schema on arrival, so a
 * drift is a 400 at the boundary rather than a silent mis-write.
 */
export type CommentOp =
  | { kind: 'create-thread'; boardId: string; anchor: CommentAnchor; body: string }
  | { kind: 'reply'; threadId: string; body: string }
  | { kind: 'edit'; threadId: string; commentId: string; body: string }
  | { kind: 'delete-comment'; threadId: string; commentId: string }
  | { kind: 'set-resolved'; threadId: string; resolved: boolean }
  | { kind: 'move'; threadId: string; anchor: CommentAnchor }
  | { kind: 'delete-thread'; threadId: string }

/** Fetch and parse the comments file for `dir` (server default workspace when omitted). */
export async function fetchComments(dir?: string): Promise<CommentsFile> {
  const res = await apiRequest('/admin/api/studio/comments', {
    schema: CommentsGetResponseSchema,
    query: dir ? { dir } : undefined,
  })
  return parseCommentsFile(res.comments)
}

/**
 * Apply one operation and adopt the server's merged result.
 *
 * The returned file is the authority, not a confirmation — it may contain
 * another writer's comment that this client had never seen.
 */
export async function applyCommentOp(op: CommentOp, dir?: string): Promise<CommentsFile> {
  const res = await apiRequest('/admin/api/studio/comments', {
    method: 'POST',
    body: { dir, op },
    schema: CommentsPostResponseSchema,
  })
  return parseCommentsFile(res.comments)
}
