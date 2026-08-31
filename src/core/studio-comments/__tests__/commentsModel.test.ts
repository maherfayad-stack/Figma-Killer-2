/**
 * The pure comment transforms, plus the file's read/write boundary.
 *
 * The `seq` assertions are the load-bearing ones: `seq` is the name a human
 * (and an agent's tool call) uses to refer to a thread, so it must be unique
 * for the life of the project, never reused, and self-healing after a git
 * merge puts two branches' threads in the same file.
 */
import { describe, it, expect } from 'bun:test'
import {
  addReply,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  findThread,
  moveThread,
  refreshThreadNodeId,
  setThreadResolved,
} from '../commentsModel'
import { parseCommentsFile, serializeCommentsFile } from '../serialize'
import { createCommentsFile, type CommentAnchor, type CommentAuthor, type CommentsFile } from '../types'

const NOW = '2026-08-31T09:00:00.000Z'
const LATER = '2026-08-31T10:00:00.000Z'

const maher: CommentAuthor = { userId: 'u1', displayName: 'Maher', kind: 'user' }
const agent: CommentAuthor = { userId: 'u1', displayName: 'Studio agent', kind: 'agent' }

const anchor: CommentAnchor = {
  frameId: 'f1',
  pageId: 'home',
  dx: 100,
  dy: 200,
  node: { nodeId: 'pages/Home.tsx:7:3', indexPath: [0, 0], moduleId: 'base.text', textSnippet: 'Hi' },
}

function seeded(bodies: string[] = ['first']): CommentsFile {
  let file = createCommentsFile()
  bodies.forEach((body, i) => {
    file = createThread(file, {
      id: `t${i + 1}`,
      commentId: `c${i + 1}`,
      boardId: 'b1',
      anchor,
      author: maher,
      body,
      now: NOW,
    })!
  })
  return file
}

describe('createThread', () => {
  it('creates a thread from its first comment and consumes a seq', () => {
    const file = seeded(['Use the display face here'])
    expect(file.threads).toHaveLength(1)
    expect(file.threads[0]?.seq).toBe(1)
    expect(file.threads[0]?.resolved).toBe(false)
    expect(file.threads[0]?.comments).toHaveLength(1)
    expect(file.threads[0]?.comments[0]?.body).toBe('Use the display face here')
    expect(file.nextSeq).toBe(2)
  })

  it('trims the body and refuses an empty one', () => {
    const file = createThread(createCommentsFile(), {
      id: 't1', commentId: 'c1', boardId: 'b1', anchor, author: maher, body: '  spaced  ', now: NOW,
    })!
    expect(file.threads[0]?.comments[0]?.body).toBe('spaced')

    // An abandoned draft must not become an unopenable pin.
    expect(createThread(createCommentsFile(), {
      id: 't2', commentId: 'c2', boardId: 'b1', anchor, author: maher, body: '   ', now: NOW,
    })).toBeNull()
  })
})

describe('addReply', () => {
  it('appends, and records the agent as the agent', () => {
    const file = addReply(seeded(), 't1', { id: 'c2', author: agent, body: 'Done — switched it.', now: LATER })!
    expect(file.threads[0]?.comments).toHaveLength(2)
    expect(file.threads[0]?.comments[1]?.author.kind).toBe('agent')
  })

  it('is a no-op for an empty body or an unknown thread', () => {
    expect(addReply(seeded(), 't1', { id: 'c2', author: maher, body: ' ', now: LATER })).toBeNull()
    expect(addReply(seeded(), 'nope', { id: 'c2', author: maher, body: 'hi', now: LATER })).toBeNull()
  })
})

describe('editComment', () => {
  it('rewrites the body and stamps editedAt', () => {
    const file = editComment(seeded(), 't1', 'c1', 'revised', LATER)!
    expect(file.threads[0]?.comments[0]?.body).toBe('revised')
    expect(file.threads[0]?.comments[0]?.editedAt).toBe(LATER)
  })

  it('is a no-op when nothing actually changed', () => {
    // Guards the dirty flag: an unchanged edit must not wake the autosave.
    expect(editComment(seeded(['same']), 't1', 'c1', 'same', LATER)).toBeNull()
    expect(editComment(seeded(), 't1', 'c1', '  ', LATER)).toBeNull()
    expect(editComment(seeded(), 't1', 'nope', 'x', LATER)).toBeNull()
  })
})

describe('deleteComment', () => {
  it('removes one comment of several', () => {
    const withReply = addReply(seeded(), 't1', { id: 'c2', author: maher, body: 'second', now: LATER })!
    const file = deleteComment(withReply, 't1', 'c1')!
    expect(file.threads[0]?.comments).toHaveLength(1)
    expect(file.threads[0]?.comments[0]?.id).toBe('c2')
  })

  it('deletes the whole thread when its LAST comment goes', () => {
    // Otherwise the board accumulates pins that cannot be opened or cleared.
    const file = deleteComment(seeded(), 't1', 'c1')!
    expect(file.threads).toHaveLength(0)
  })
})

describe('setThreadResolved', () => {
  it('resolves and reopens, keeping the thread number', () => {
    const resolved = setThreadResolved(seeded(), 't1', true)!
    expect(resolved.threads[0]?.resolved).toBe(true)
    expect(resolved.threads[0]?.seq).toBe(1)

    const reopened = setThreadResolved(resolved, 't1', false)!
    expect(reopened.threads[0]?.resolved).toBe(false)
    expect(reopened.threads[0]?.seq).toBe(1)
  })

  it('is a no-op when already in that state', () => {
    expect(setThreadResolved(seeded(), 't1', false)).toBeNull()
  })
})

describe('moveThread / refreshThreadNodeId', () => {
  it('repositions a pin', () => {
    const file = moveThread(seeded(), 't1', { ...anchor, dx: 5, dy: 6 })!
    expect(file.threads[0]?.anchor.dx).toBe(5)
  })

  it('rewrites a stale node id after a `moved` re-resolution', () => {
    const file = refreshThreadNodeId(seeded(), 't1', 'pages/Home.tsx:9:3')!
    expect(file.threads[0]?.anchor.node?.nodeId).toBe('pages/Home.tsx:9:3')
    // Everything else about the hint is preserved — only the id was stale.
    expect(file.threads[0]?.anchor.node?.textSnippet).toBe('Hi')
  })

  it('is a no-op for an unchanged id or a coordinate-only pin', () => {
    expect(refreshThreadNodeId(seeded(), 't1', 'pages/Home.tsx:7:3')).toBeNull()

    const pinOnly = createThread(createCommentsFile(), {
      id: 't9', commentId: 'c9', boardId: 'b1',
      anchor: { frameId: null, pageId: null, dx: 0, dy: 0, node: null },
      author: maher, body: 'floating', now: NOW,
    })!
    expect(refreshThreadNodeId(pinOnly, 't9', 'anything')).toBeNull()
  })
})

describe('deleteThread', () => {
  it('removes the thread but never rewinds nextSeq', () => {
    // Reusing a freed number would make "comment 2" ambiguous across a
    // conversation or an agent transcript.
    const two = seeded(['a', 'b'])
    expect(two.nextSeq).toBe(3)
    const file = deleteThread(two, 't2')!
    expect(file.threads).toHaveLength(1)
    expect(file.nextSeq).toBe(3)
  })

  it('is a no-op for an unknown id', () => {
    expect(deleteThread(seeded(), 'nope')).toBeNull()
  })
})

describe('serialize / parse', () => {
  it('round-trips', () => {
    const file = addReply(seeded(['a', 'b']), 't1', { id: 'c9', author: agent, body: 'reply', now: LATER })!
    expect(parseCommentsFile(serializeCommentsFile(file))).toEqual(file)
  })

  it('falls back to an empty file on anything unreadable', () => {
    const empty = createCommentsFile()
    expect(parseCommentsFile('not json')).toEqual(empty)
    expect(parseCommentsFile(null)).toEqual(empty)
    expect(parseCommentsFile({ version: 1 })).toEqual(empty)
  })

  it('drops a malformed thread instead of losing the whole review', () => {
    const parsed = parseCommentsFile({
      version: 1,
      nextSeq: 3,
      threads: [
        { id: '', comments: [] },                                    // no id
        { id: 't2', comments: [] },                                  // no comments
        { id: 't3', comments: [{ id: 'c3', body: '   ' }] },         // blank body
        { id: 't4', seq: 2, boardId: 'b1', comments: [{ id: 'c4', body: 'real' }] },
      ],
    })
    expect(parsed.threads.map((t) => t.id)).toEqual(['t4'])
  })

  it('repairs a nextSeq that a git merge left behind', () => {
    // Two branches each add a thread; the merge keeps both and one branch's
    // stale nextSeq. Handing out a duplicate `seq` would make thread numbers
    // ambiguous, so it is recomputed rather than trusted.
    const parsed = parseCommentsFile({
      version: 1,
      nextSeq: 2,
      threads: [
        { id: 't1', seq: 1, comments: [{ id: 'c1', body: 'a' }] },
        { id: 't2', seq: 7, comments: [{ id: 'c2', body: 'b' }] },
      ],
    })
    expect(parsed.nextSeq).toBe(8)
  })

  it('substitutes a readable byline for an author snapshot that did not survive', () => {
    const parsed = parseCommentsFile({
      version: 1, nextSeq: 2,
      threads: [{ id: 't1', seq: 1, comments: [{ id: 'c1', body: 'x', author: { userId: 'u9' } }] }],
    })
    expect(parsed.threads[0]?.comments[0]?.author.displayName).toBe('Unknown')
    expect(parsed.threads[0]?.comments[0]?.author.kind).toBe('user')
  })

  it('finds a thread by id', () => {
    expect(findThread(seeded(['a', 'b']), 't2')?.seq).toBe(2)
    expect(findThread(seeded(), 'nope')).toBeUndefined()
  })
})
