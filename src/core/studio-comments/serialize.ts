/**
 * serialize — the read/write boundary for `.studio/comments.json`.
 *
 * Tolerant on read, strict on write, mirroring `@core/studio-board`'s
 * `serialize.ts`: a malformed thread is DROPPED, never thrown. This file is
 * hand-editable, lives in a git repo, and gets merged by humans — a single bad
 * entry from a botched conflict resolution must not take the whole review with
 * it, and must certainly not crash the editor on load.
 *
 * `nextSeq` is repaired rather than trusted. A file whose `nextSeq` sits at or
 * below a `seq` already in use — the classic result of two branches each
 * adding a thread and the merge keeping both — would otherwise hand out a
 * duplicate number, and `seq` is the name humans and agents use to refer to a
 * thread. Recomputing it as `max(seq) + 1` on read makes that self-healing.
 */
import type { NodeHint } from '@core/studio-anchor'
import { createCommentsFile, type Comment, type CommentAnchor, type CommentAuthor, type CommentThread, type CommentsFile } from './types'

export function serializeCommentsFile(file: CommentsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function coerceAuthor(raw: unknown): CommentAuthor {
  if (!isPlainObject(raw)) return { userId: '', displayName: 'Unknown', kind: 'user' }
  return {
    userId: str(raw.userId),
    // An empty display name would render as a blank byline. "Unknown" is the
    // honest rendering of an author snapshot that did not survive whatever
    // produced this file.
    displayName: str(raw.displayName) || 'Unknown',
    kind: raw.kind === 'agent' ? 'agent' : 'user',
  }
}

function coerceNodeHint(raw: unknown): NodeHint | null {
  if (!isPlainObject(raw)) return null
  const nodeId = str(raw.nodeId)
  if (nodeId.length === 0) return null
  const indexPath = Array.isArray(raw.indexPath)
    ? raw.indexPath.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    : []
  return {
    nodeId,
    indexPath,
    moduleId: str(raw.moduleId),
    textSnippet: str(raw.textSnippet),
  }
}

function coerceAnchor(raw: unknown): CommentAnchor {
  if (!isPlainObject(raw)) return { frameId: null, pageId: null, dx: 0, dy: 0, node: null }
  return {
    frameId: nullableStr(raw.frameId),
    pageId: nullableStr(raw.pageId),
    dx: num(raw.dx),
    dy: num(raw.dy),
    node: coerceNodeHint(raw.node),
  }
}

function coerceComment(raw: unknown): Comment | undefined {
  if (!isPlainObject(raw)) return undefined
  const id = str(raw.id)
  if (id.length === 0) return undefined
  const body = str(raw.body)
  // A bodyless comment is not a comment. Dropping it here is what lets
  // `coerceThread` below decide the whole thread is empty and drop that too.
  if (body.trim().length === 0) return undefined
  return {
    id,
    author: coerceAuthor(raw.author),
    body,
    createdAt: str(raw.createdAt),
    editedAt: nullableStr(raw.editedAt),
  }
}

function coerceThread(raw: unknown): CommentThread | undefined {
  if (!isPlainObject(raw)) return undefined
  const id = str(raw.id)
  if (id.length === 0) return undefined
  const comments = Array.isArray(raw.comments)
    ? raw.comments.map(coerceComment).filter((c): c is Comment => c !== undefined)
    : []
  // Enforces the invariant `CommentThreadSchema` deliberately does not encode:
  // a thread with no readable comments is a pin nobody can open, so it never
  // enters the system.
  if (comments.length === 0) return undefined
  return {
    id,
    seq: Math.max(1, Math.trunc(num(raw.seq, 1))),
    boardId: str(raw.boardId),
    anchor: coerceAnchor(raw.anchor),
    resolved: raw.resolved === true,
    createdAt: str(raw.createdAt),
    comments,
  }
}

export function parseCommentsFile(raw: unknown): CommentsFile {
  let value: unknown = raw

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return createCommentsFile()
    }
  }

  if (!isPlainObject(value)) return createCommentsFile()
  if (!Array.isArray(value.threads)) return createCommentsFile()

  const threads = value.threads
    .map(coerceThread)
    .filter((t): t is CommentThread => t !== undefined)

  // Repair rather than trust — see this module's doc. `max(seq) + 1` is also
  // correct for an empty file, where the reduce seeds at 0 and yields 1.
  const highestSeq = threads.reduce((max, thread) => Math.max(max, thread.seq), 0)
  const nextSeq = Math.max(num(value.nextSeq, 1), highestSeq + 1)

  return { version: 1, nextSeq, threads }
}
