/**
 * The agent's comment loop, with the anchor gate as the centrepiece.
 *
 * The `stale-anchor` tests are the reason this file exists. Every other
 * assertion here protects ergonomics; those protect the user's source code
 * from an agent that edits the wrong element and then reports success.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommentsFile, type CommentAnchor } from '@core/studio-comments'
import { applyCommentOp, authorFromSession, readCommentsFile, writeCommentsFile } from '../../../../handlers/studio/commentsStore'
import { studioCommentMcpTools } from './commentTools'

const listTool = studioCommentMcpTools.find((t) => t.name === 'studio_list_comments')!
const replyTool = studioCommentMcpTools.find((t) => t.name === 'studio_reply_comment')!
const resolveTool = studioCommentMcpTools.find((t) => t.name === 'studio_resolve_comment')!

let dir: string

/**
 * A project with one real page, so `loadStudioPages` has something to parse
 * and the anchor resolver has a live tree to resolve against. The comment
 * below is anchored to a node id that does NOT exist in it — which is exactly
 * the stale case the gate has to catch.
 */
function seedProject(pageSource: string): void {
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'pages', 'Home.tsx'), pageSource)
  mkdirSync(join(dir, '.studio'), { recursive: true })
}

function seedThread(anchor: CommentAnchor, body = 'Use the display face here'): void {
  const result = applyCommentOp(
    createCommentsFile(),
    { kind: 'create-thread', boardId: 'b1', anchor, body },
    authorFromSession({ id: 'u1', displayName: 'Maher' }),
    '2026-08-31T09:00:00.000Z',
  )
  if (!result.ok) throw new Error('fixture failed')
  writeCommentsFile(dir, result.file)
}

function ctx() {
  return {
    userId: 'u1',
    capabilities: [],
    conversationId: 'c1',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
    db: undefined,
  } as never
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-comment-tools-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const STALE_ANCHOR: CommentAnchor = {
  frameId: 'f1',
  pageId: 'home',
  dx: 10,
  dy: 20,
  node: {
    nodeId: 'pages/Home.tsx:999:9',
    indexPath: [42],
    moduleId: 'base.text',
    textSnippet: 'Long gone',
  },
}

const COORDINATE_ONLY_ANCHOR: CommentAnchor = {
  frameId: null,
  pageId: null,
  dx: 10,
  dy: 20,
  node: null,
}

describe('studio_list_comments', () => {
  it('returns open threads by default, with their pin numbers', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(COORDINATE_ONLY_ANCHOR, 'Make this bolder')

    const out = (await listTool.handler({ dir, resolveAnchors: false }, ctx())) as {
      ok: boolean
      threads: Array<{ seq: number; resolved: boolean; comments: Array<{ body: string }> }>
    }

    expect(out.ok).toBe(true)
    expect(out.threads).toHaveLength(1)
    expect(out.threads[0]?.seq).toBe(1)
    expect(out.threads[0]?.resolved).toBe(false)
    expect(out.threads[0]?.comments[0]?.body).toBe('Make this bolder')
  })

  it('omits anchorConfidence entirely when the caller opts out of the parse', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(STALE_ANCHOR)

    const out = (await listTool.handler({ dir, resolveAnchors: false }, ctx())) as {
      threads: Array<Record<string, unknown>>
    }
    // Absent, not `null` and not a guess — a confidence the tool did not
    // compute must not look like one it did.
    expect(out.threads[0]).not.toHaveProperty('anchorConfidence')
    expect(out.threads[0]).not.toHaveProperty('agentActionable')
  })

  it('marks a thread whose element is gone as not actionable', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(STALE_ANCHOR)

    const out = (await listTool.handler({ dir }, ctx())) as {
      threads: Array<{ anchorConfidence: string; agentActionable: boolean; nodeText: string | null }>
    }
    expect(out.threads[0]?.anchorConfidence).toBe('detached')
    expect(out.threads[0]?.agentActionable).toBe(false)
    // The words survive even when the id does not — often enough for the agent
    // to find the element by hand.
    expect(out.threads[0]?.nodeText).toBe('Long gone')
  })

  it('filters by status', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(COORDINATE_ONLY_ANCHOR)

    const resolved = (await resolveTool.handler({ dir, seq: 1 }, ctx())) as { ok: boolean }
    expect(resolved.ok).toBe(true)

    const open = (await listTool.handler({ dir, status: 'open', resolveAnchors: false }, ctx())) as { threads: unknown[] }
    const done = (await listTool.handler({ dir, status: 'resolved', resolveAnchors: false }, ctx())) as { threads: unknown[] }
    const all = (await listTool.handler({ dir, status: 'all', resolveAnchors: false }, ctx())) as { threads: unknown[] }

    expect(open.threads).toHaveLength(0)
    expect(done.threads).toHaveLength(1)
    expect(all.threads).toHaveLength(1)
  })
})

describe('studio_reply_comment', () => {
  it('posts as the agent, so a reviewer can tell what was machine-written', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(COORDINATE_ONLY_ANCHOR)

    const out = (await replyTool.handler({ dir, seq: 1, body: 'Switched to the display face.' }, ctx())) as {
      ok: boolean
      commentCount: number
    }
    expect(out).toMatchObject({ ok: true, commentCount: 2 })

    const file = readCommentsFile(dir)
    expect(file.threads[0]?.comments[1]?.author.kind).toBe('agent')
    expect(file.threads[0]?.comments[1]?.author.displayName).toBe('Studio agent')
  })

  it('names the seqs that do exist when given one that does not', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(COORDINATE_ONLY_ANCHOR)

    const out = (await replyTool.handler({ dir, seq: 7, body: 'hello' }, ctx())) as {
      ok: boolean
      code: string
      availableSeqs: number[]
    }
    expect(out).toMatchObject({ ok: false, code: 'no-such-thread' })
    expect(out.availableSeqs).toEqual([1])
  })
})

describe('studio_resolve_comment — the anchor gate', () => {
  it('REFUSES to resolve a thread whose element no longer exists', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(STALE_ANCHOR)

    const out = (await resolveTool.handler(
      { dir, seq: 1, reply: 'Done — made it bolder.' },
      ctx(),
    )) as { ok: boolean; code: string; anchorConfidence: string }

    expect(out).toMatchObject({ ok: false, code: 'stale-anchor', anchorConfidence: 'detached' })

    const file = readCommentsFile(dir)
    // Left OPEN for a human. This is the whole point: the agent cannot have
    // addressed a comment about an element that is not there.
    expect(file.threads[0]?.resolved).toBe(false)
  })

  it('posts the refusal INTO the thread, not just into the tool result', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(STALE_ANCHOR)

    await resolveTool.handler({ dir, seq: 1, reply: 'I changed the heading.' }, ctx())

    const file = readCommentsFile(dir)
    const last = file.threads[0]?.comments.at(-1)
    // The user never sees a tool result. If the refusal only lived there, the
    // thread would look silently ignored.
    expect(last?.author.kind).toBe('agent')
    expect(last?.body).toContain('I changed the heading.')
    expect(last?.body).toContain('no longer exists')
  })

  it('resolves normally when there was never an element to go stale', async () => {
    // A coordinate-only pin resolves `detached`, which would deadlock it —
    // except the gate only runs for threads that HAVE a node hint. This test
    // pins that distinction; without it, every free-floating comment on the
    // board would be permanently unresolvable by the agent.
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(COORDINATE_ONLY_ANCHOR)

    const out = (await resolveTool.handler({ dir, seq: 1 }, ctx())) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(readCommentsFile(dir).threads[0]?.resolved).toBe(true)
  })

  it('never gates REOPENING — a stale anchor is a reason to leave a thread open', async () => {
    seedProject('export default function Home() { return <div>Hi</div> }')
    seedThread(STALE_ANCHOR)

    // Resolve it out of band (a human can, through the HTTP route).
    const file = readCommentsFile(dir)
    const applied = applyCommentOp(
      file,
      { kind: 'set-resolved', threadId: file.threads[0]!.id, resolved: true },
      authorFromSession({ id: 'u1', displayName: 'Maher' }),
      '2026-08-31T10:00:00.000Z',
    )
    if (!applied.ok) throw new Error('fixture failed')
    writeCommentsFile(dir, applied.file)

    const out = (await resolveTool.handler({ dir, seq: 1, resolved: false }, ctx())) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(readCommentsFile(dir).threads[0]?.resolved).toBe(false)
  })
})
