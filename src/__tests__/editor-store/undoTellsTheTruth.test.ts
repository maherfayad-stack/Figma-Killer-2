/**
 * P1-F "Undo tells the truth" — the store half (ERR-3, ERR-2 stop-gap, ERR-6).
 *
 * Each case drives a real store action against a stubbed `/save`, the same way
 * `structuralMoveUndo.test.ts` does, and asserts on what the user would see:
 * the tree, the undo stack, what was posted, and how many toasts said so.
 *
 *  - ERR-3: undo of a move made in frame A, pressed after clicking frame B,
 *    re-issues the move on A instead of "Nothing to undo here".
 *  - ERR-6: a move or delete the server refuses is taken back through its own
 *    inverse patches and its entry leaves the stack; one that cannot reach the
 *    server is retried first (one idempotency key across attempts) and only
 *    then taken back; an undo whose re-issued write is refused is skipped, and
 *    one that never reached the server goes back on the stack.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import type { PageNode } from '@core/page-tree'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { setUnreachableRetrySleepForTests } from '@core/http'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'

const FILE_A = 'app/a.tsx'
const FILE_B = 'app/b.tsx'
const ROOT_A = 'page-a:body'
const ROOT_B = 'page-b:body'
const a = (line: number) => `${FILE_A}:${line}:5`
const b = (line: number) => `${FILE_B}:${line}:5`

function page(id: string, root: string, childIds: string[]) {
  const nodes: Record<string, PageNode> = {
    [root]: { id: root, moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [...childIds], classIds: [] },
  }
  for (const nodeId of childIds) {
    nodes[nodeId] = { id: nodeId, moduleId: 'base.text', props: { text: nodeId }, breakpointOverrides: {}, children: [], classIds: [] }
  }
  return makePage({ id, rootNodeId: root, nodes })
}

/** Page A holds three siblings, page B two — a two-frame board. */
function board() {
  return makeSite({ pages: [page('page-a', ROOT_A, [a(3), a(4), a(5)]), page('page-b', ROOT_B, [b(3), b(4)])] })
}

const store = () => useEditorStore.getState()
const childrenOf = (pageIndex: number, root: string) => store().site!.pages[pageIndex]!.nodes[root]!.children

type SaveReply =
  | { kind: 'written' }
  | { kind: 'refused'; nodeId: string; message: string }
  | { kind: 'unreachable' }

interface Posted {
  edits: Record<string, unknown>[]
  idempotencyKey: string | undefined
}

let posted: Posted[]
let replies: SaveReply[]
let realFetch: typeof globalThis.fetch
let toasts: Toast[]
let unsubscribeToasts: () => void

function reply(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  resetStructuralCommitQueue()
  __resetToastBusForTests()
  setUnreachableRetrySleepForTests(async () => {})
  toasts = []
  unsubscribeToasts = subscribeToasts((next) => {
    toasts = next
  })
  posted = []
  replies = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.includes('/studio/save')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      const headers = (init?.headers ?? {}) as Record<string, string>
      posted.push({ edits: body.edits ?? [], idempotencyKey: headers['X-Studio-Idempotency-Key'] })
      const next = replies.length > 1 ? replies.shift()! : (replies[0] ?? { kind: 'written' })
      if (next.kind === 'unreachable') throw new TypeError('Failed to fetch')
      if (next.kind === 'refused') {
        return reply({
          ok: true,
          written: 0,
          skipped: 1,
          shifted: false,
          sharedComponents: false,
          touchedFiles: [],
          refusals: [{ kind: String(body.edits?.[0]?.kind ?? 'move'), nodeId: next.nodeId, reason: 'has-behaviour', message: next.message }],
        })
      }
      return reply({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [FILE_A] })
    }
    // Reload scope: "not provably narrow" — with no editor mounted, the full
    // reload request settles at once and nothing is re-read.
    return reply({ ok: true, narrow: false })
  }) as typeof globalThis.fetch

  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  })
  store().loadSite(board())
  store().setActivePage('page-a')
})

afterEach(() => {
  globalThis.fetch = realFetch
  setUnreachableRetrySleepForTests(null)
  unsubscribeToasts()
  resetStructuralCommitQueue()
})

/** Let the fire-and-forget commit (and anything queued behind it) finish. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 400 && isStructuralCommitInFlight(); i++) await new Promise((r) => setTimeout(r, 1))
  await new Promise((r) => setTimeout(r, 0))
}

const errorToasts = () => toasts.filter((toast) => toast.kind === 'error')

describe('ERR-3 — structural undo finds the page that owns the element', () => {
  it('undoes a move made in frame A after the user clicked into frame B', async () => {
    store().moveNodes([a(3)], ROOT_A, 3)
    expect(childrenOf(0, ROOT_A)).toEqual([a(4), a(5), a(3)])
    await settle()
    const pastAfterMove = store()._historyPast.length

    // Pressing on a frame activates its page — the normal flow.
    store().setActivePage('page-b')
    store().undo()

    expect(childrenOf(0, ROOT_A)).toEqual([a(3), a(4), a(5)])
    expect(store()._historyPast.length).toBe(pastAfterMove - 1)
    expect(store()._historyFuture.length).toBe(1)
    // Silently taken to the page the undo changed, the way Figma does it.
    expect(store().activePageId).toBe('page-a')
    await settle()
    expect(posted.at(-1)!.edits[0]).toMatchObject({ kind: 'move', nodeId: a(3) })
    expect(toasts.filter((toast) => toast.title === 'Nothing to undo here')).toHaveLength(0)
  })

  it('redoes it from the other frame too', async () => {
    store().moveNodes([a(3)], ROOT_A, 3)
    await settle()
    store().undo()
    await settle()

    store().setActivePage('page-b')
    store().redo()
    expect(childrenOf(0, ROOT_A)).toEqual([a(4), a(5), a(3)])
    expect(store()._historyFuture.length).toBe(0)
  })
})

describe('ERR-6 — a move or delete that does not land is taken back', () => {
  it('a refused move puts the element back, drops its entry, and says so once', async () => {
    replies = [{ kind: 'refused', nodeId: a(3), message: 'That element has behaviour attached.' }]
    store().updateNodeProps(a(5), { text: 'kept' })
    store().moveNodes([a(3)], ROOT_A, 3)
    expect(childrenOf(0, ROOT_A)).toEqual([a(4), a(5), a(3)])
    expect(store()._historyPast.length).toBe(2)

    await settle()
    expect(childrenOf(0, ROOT_A)).toEqual([a(3), a(4), a(5)])
    // The entry is gone — ⌘Z must not "undo" a move that never happened by
    // really moving something on disk. The value edit before it survives.
    expect(store()._historyPast.length).toBe(1)
    expect(store()._historyPast[0]!.structural).toBeUndefined()
    expect(errorToasts()).toHaveLength(1)
    expect(errorToasts()[0]!.body).toContain('behaviour')

    store().undo()
    expect(store().site!.pages[0]!.nodes[a(5)]!.props.text).toBe(a(5))
    expect(posted).toHaveLength(1)
  })

  it('a refused delete puts the elements back and drops its entry', async () => {
    replies = [{ kind: 'refused', nodeId: a(4), message: 'Refused.' }]
    store().deleteNodes([a(4), a(5)])
    expect(childrenOf(0, ROOT_A)).toEqual([a(3)])

    await settle()
    expect(childrenOf(0, ROOT_A)).toEqual([a(3), a(4), a(5)])
    expect(store().site!.pages[0]!.nodes[a(5)]).toBeDefined()
    expect(store()._nodeIdToPageIds.get(a(5))).toEqual(['page-a'])
    expect(store()._historyPast.length).toBe(0)
    expect(errorToasts()).toHaveLength(1)
    expect(errorToasts()[0]!.body).toBe('Refused.')
  })

  it('an unreachable server is retried with ONE idempotency key, and a later success keeps the move', async () => {
    replies = [{ kind: 'unreachable' }, { kind: 'unreachable' }, { kind: 'written' }]
    store().moveNodes([a(3)], ROOT_A, 3)
    await settle()

    expect(posted).toHaveLength(3)
    const keys = new Set(posted.map((post) => post.idempotencyKey))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toBeString()
    expect(childrenOf(0, ROOT_A)).toEqual([a(4), a(5), a(3)])
    expect(store()._historyPast.length).toBe(1)
    expect(store()._historyPast[0]!.pendingCommit).toBeUndefined()
    expect(errorToasts()).toHaveLength(0)
  })

  it('a server that never answers is rolled back once the retries run out', async () => {
    replies = [{ kind: 'unreachable' }]
    store().moveNodes([a(3)], ROOT_A, 3)
    await settle()

    expect(posted).toHaveLength(4) // the first attempt and three retries
    expect(childrenOf(0, ROOT_A)).toEqual([a(3), a(4), a(5)])
    expect(store()._historyPast.length).toBe(0)
    expect(errorToasts()).toHaveLength(1)
  })

  it('does not replay the inverse over a page a re-read already replaced', async () => {
    replies = [{ kind: 'refused', nodeId: a(3), message: 'Refused.' }]
    store().moveNodes([a(3)], ROOT_A, 3)
    // A re-read lands while the write is on the wire: an agent added a line
    // at the top of the file, so disk renumbered every element on the page.
    const shifted = [a(4), a(5), a(6)]
    store().loadSite(makeSite({ pages: [page('page-a', ROOT_A, shifted), page('page-b', ROOT_B, [b(3), b(4)])] }))
    await settle()

    // The page says what disk says. Replaying the stale inverse over it would
    // have pointed the root at ids the re-read no longer has.
    expect(childrenOf(0, ROOT_A)).toEqual(shifted)
    for (const id of childrenOf(0, ROOT_A)) expect(store().site!.pages[0]!.nodes[id]).toBeDefined()
  })
})

describe('ERR-6 — an undo whose re-issued write does not land', () => {
  it('is skipped when the server refuses it: the tree stays as disk has it, and the stack moves on', async () => {
    store().moveNodes([a(3)], ROOT_A, 3)
    await settle()
    replies = [{ kind: 'refused', nodeId: a(3), message: 'Refused.' }]

    store().undo()
    expect(childrenOf(0, ROOT_A)).toEqual([a(3), a(4), a(5)])
    await settle()

    // Disk still has the move, so the board does too — and the entry is gone
    // from BOTH stacks: a redo would re-post a move that is already there.
    expect(childrenOf(0, ROOT_A)).toEqual([a(4), a(5), a(3)])
    expect(store()._historyPast.length).toBe(0)
    expect(store()._historyFuture.length).toBe(0)
    expect(errorToasts()).toHaveLength(1)
  })

  it('goes back on the stack when the server never answered, so the next ⌘Z can try again', async () => {
    store().moveNodes([a(3)], ROOT_A, 3)
    await settle()
    replies = [{ kind: 'unreachable' }]

    store().undo()
    await settle()

    expect(childrenOf(0, ROOT_A)).toEqual([a(4), a(5), a(3)])
    expect(store()._historyPast.length).toBe(1)
    expect(store()._historyPast[0]!.structural?.gesture).toBe('move')
    expect(store()._historyPast[0]!.pendingCommit).toBeUndefined()
    expect(store()._historyFuture.length).toBe(0)

    replies = [{ kind: 'written' }]
    store().undo()
    expect(childrenOf(0, ROOT_A)).toEqual([a(3), a(4), a(5)])
    await settle()
    expect(store()._historyFuture.length).toBe(1)
  })
})
