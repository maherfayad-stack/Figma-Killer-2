/**
 * The op layer — the boundary where a request's INTENT becomes a write.
 *
 * The ownership assertions are the point of this file. `commentsModel.ts` is
 * deliberately ownership-blind (it is a pure transform with no notion of a
 * current user), so if these checks are wrong there is nothing behind them:
 * any authenticated account could rewrite or delete anybody's comment.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommentsFile, type CommentAnchor, type CommentsFile } from '@core/studio-comments'
import {
  applyCommentOp,
  authorFromSession,
  commentsFilePath,
  readCommentsFile,
  writeCommentsFile,
} from '../commentsStore'

const NOW = '2026-08-31T09:00:00.000Z'
const maher = authorFromSession({ id: 'u1', displayName: 'Maher' })
const sam = authorFromSession({ id: 'u2', displayName: 'Sam' })
const agent = authorFromSession({ id: 'u1', displayName: 'Studio agent' }, 'agent')

const anchor: CommentAnchor = { frameId: 'f1', pageId: 'home', dx: 10, dy: 20, node: null }

function withThread(author = maher): CommentsFile {
  const result = applyCommentOp(
    createCommentsFile(),
    { kind: 'create-thread', boardId: 'b1', anchor, body: 'Needs the display face' },
    author,
    NOW,
  )
  if (!result.ok) throw new Error('fixture failed')
  return result.file
}

describe('authorFromSession', () => {
  it('snapshots the display name so the file survives a clone', () => {
    expect(maher).toEqual({ userId: 'u1', displayName: 'Maher', kind: 'user' })
  })

  it('defaults to a user, and marks an agent only when told to', () => {
    expect(maher.kind).toBe('user')
    expect(agent.kind).toBe('agent')
  })

  it('substitutes a readable byline for a blank display name', () => {
    expect(authorFromSession({ id: 'u3', displayName: '' }).displayName).toBe('Unknown')
  })
})

describe('applyCommentOp', () => {
  it('creates a thread with a server-minted id and timestamp', () => {
    const file = withThread()
    expect(file.threads).toHaveLength(1)
    const thread = file.threads[0]!
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(thread.comments[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(thread.comments[0]?.createdAt).toBe(NOW)
    expect(thread.comments[0]?.author).toEqual(maher)
  })

  it('reports an empty body as a no-op success, not an error', () => {
    const result = applyCommentOp(
      createCommentsFile(),
      { kind: 'create-thread', boardId: 'b1', anchor, body: '   ' },
      maher,
      NOW,
    )
    expect(result).toMatchObject({ ok: true, changed: false })
  })

  it('404s an op against a thread that is not there', () => {
    const result = applyCommentOp(createCommentsFile(), { kind: 'reply', threadId: 'nope', body: 'hi' }, maher, NOW)
    expect(result).toMatchObject({ ok: false, status: 404 })
  })

  it('lets anyone reply, and records an agent reply as the agent', () => {
    const file = withThread()
    const threadId = file.threads[0]!.id
    const bySam = applyCommentOp(file, { kind: 'reply', threadId, body: 'agreed' }, sam, NOW)
    expect(bySam).toMatchObject({ ok: true, changed: true })

    const byAgent = applyCommentOp(file, { kind: 'reply', threadId, body: 'fixed' }, agent, NOW)
    if (!byAgent.ok) throw new Error('expected ok')
    expect(byAgent.file.threads[0]?.comments[1]?.author.kind).toBe('agent')
  })
})

describe('ownership', () => {
  it('refuses to edit someone else’s comment', () => {
    const file = withThread()
    const threadId = file.threads[0]!.id
    const commentId = file.threads[0]!.comments[0]!.id
    expect(applyCommentOp(file, { kind: 'edit', threadId, commentId, body: 'hijacked' }, sam, NOW))
      .toMatchObject({ ok: false, status: 403 })
    expect(applyCommentOp(file, { kind: 'edit', threadId, commentId, body: 'revised' }, maher, NOW))
      .toMatchObject({ ok: true, changed: true })
  })

  it('refuses to delete someone else’s comment', () => {
    const file = withThread()
    const threadId = file.threads[0]!.id
    const commentId = file.threads[0]!.comments[0]!.id
    expect(applyCommentOp(file, { kind: 'delete-comment', threadId, commentId }, sam, NOW))
      .toMatchObject({ ok: false, status: 403 })
  })

  it('refuses to delete a thread someone else started', () => {
    const file = withThread()
    const threadId = file.threads[0]!.id
    expect(applyCommentOp(file, { kind: 'delete-thread', threadId }, sam, NOW))
      .toMatchObject({ ok: false, status: 403 })
    expect(applyCommentOp(file, { kind: 'delete-thread', threadId }, maher, NOW))
      .toMatchObject({ ok: true, changed: true })
  })

  it('lets ANYONE resolve — deliberately not ownership-gated', () => {
    // Gating resolve to the author leaves threads open forever once the
    // author moves on. It is reversible and the thread keeps its number.
    const file = withThread()
    const threadId = file.threads[0]!.id
    const result = applyCommentOp(file, { kind: 'set-resolved', threadId, resolved: true }, sam, NOW)
    if (!result.ok) throw new Error('expected ok')
    expect(result.file.threads[0]?.resolved).toBe(true)
    expect(result.file.threads[0]?.seq).toBe(1)
  })

  it('reports resolving an already-resolved thread as a no-op', () => {
    const file = withThread()
    const threadId = file.threads[0]!.id
    expect(applyCommentOp(file, { kind: 'set-resolved', threadId, resolved: false }, sam, NOW))
      .toMatchObject({ ok: true, changed: false })
  })
})

describe('concurrent writers merge instead of clobbering', () => {
  it('keeps both replies when two authors write against the same base', () => {
    // The whole reason this endpoint is op-shaped rather than whole-file. Under
    // `/boards`-style semantics the second POST would carry its own full copy
    // of the file and silently drop the first reply.
    const base = withThread()
    const threadId = base.threads[0]!.id

    const first = applyCommentOp(base, { kind: 'reply', threadId, body: 'from Maher' }, maher, NOW)
    if (!first.ok) throw new Error('expected ok')
    // Sam's request arrives next and is applied to what is ON DISK now — the
    // result of the first — not to the copy Sam's browser last saw.
    const second = applyCommentOp(first.file, { kind: 'reply', threadId, body: 'from Sam' }, sam, NOW)
    if (!second.ok) throw new Error('expected ok')

    expect(second.file.threads[0]?.comments.map((c) => c.body))
      .toEqual(['Needs the display face', 'from Maher', 'from Sam'])
  })
})

describe('disk round-trip', () => {
  it('writes to .studio/comments.json and reads back what it wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-comments-'))
    try {
      // A project with no comments yet reads as an empty file, not a throw.
      expect(existsSync(commentsFilePath(dir))).toBe(false)
      expect(readCommentsFile(dir)).toEqual(createCommentsFile())

      const file = withThread()
      writeCommentsFile(dir, file)
      expect(commentsFilePath(dir)).toBe(join(dir, '.studio', 'comments.json'))
      expect(readCommentsFile(dir)).toEqual(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
