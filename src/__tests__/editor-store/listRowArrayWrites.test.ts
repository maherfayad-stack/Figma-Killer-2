/**
 * OD-8 — a `.map` row's reorder, delete and duplicate write the ARRAY the
 * `.map` iterates: one `list-item` write, one undo entry, and ⌘Z posts the
 * inverse write. A simulated file (the array's element texts) stands in for
 * disk; each landed write re-reads the board from it, as the real reload does.
 *
 * Also the refusal that stays: a row whose array is imported posts nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import type { ListItemOp, ListRowSource, Page, PageNode } from '@core/page-tree'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { resetSourceIdentities } from '@site/studio/sourceIdentity'
import { resetListRowRemaps } from '@site/studio/listRowRemap'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import {
  CMS_SITE_RELOAD_EVENT,
  claimCmsSiteReloadRequests,
  latestCmsSiteReloadRequest,
  registerCmsSiteReloader,
} from '@admin/state/adminEvents'
import { applyStructuralWriteOutcome } from '@site/hooks/siteReloadApply'

const FILE = 'src/Board.tsx'
const ARRAY = `${FILE}:2:17`
const MAIN = `${FILE}:8:5`
const TPL = `${FILE}:10:9`
const ROW = (k: number) => `${TPL}#${k}`
const START = [`'todo'`, `'doing'`, `'done'`]

let items: string[]
let arraySource: 'here' | 'imported'
let posted: Record<string, unknown>[][]

function el(id: string, parentId: string | undefined, children: string[] = [], listRow?: ListRowSource): PageNode {
  return {
    id,
    moduleId: children.length > 0 ? 'base.container' : 'base.text',
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
    ...(parentId ? { parentId } : {}),
    ...(listRow ? { listRow } : {}),
  }
}

/** The board as the parser would read the simulated file. */
function board(): Page {
  const rows = items.map((_, k) => ROW(k))
  const stamp = (k: number): ListRowSource =>
    arraySource === 'here'
      ? { kind: 'array', array: ARRAY, index: k, length: items.length, key: { kind: 'none' }, source: 'LANES' }
      : { kind: 'refused', reason: 'imported', source: 'LANES' }
  const nodes = [el('board:body', undefined, [MAIN]), el(MAIN, 'board:body', rows), ...rows.map((id, k) => el(id, MAIN, [], stamp(k)))]
  return makePage({ id: 'board', rootNodeId: 'board:body', nodes: Object.fromEntries(nodes.map((node) => [node.id, node])) })
}

/** `editListItems`, on element texts. */
function apply(op: ListItemOp): string[] {
  switch (op.kind) {
    case 'reorder':
      items = op.order.map((k) => items[k]!)
      return []
    case 'remove': {
      const removed = op.indices.map((k) => items[k]!)
      items = items.filter((_, k) => !op.indices.includes(k))
      return removed
    }
    case 'copy':
      items = [...items.slice(0, op.at), ...op.from.map((k) => items[k]!), ...items.slice(op.at)]
      return []
    case 'insert':
      op.at.forEach((at, k) => items.splice(at, 0, op.texts[k]!))
      return []
  }
}

const store = () => useEditorStore.getState()
let realFetch: typeof globalThis.fetch
let unregister: () => void
let onReload: () => void

beforeEach(() => {
  resetStructuralCommitQueue()
  resetSourceIdentities()
  resetListRowRemaps()
  __resetToastBusForTests()
  items = [...START]
  arraySource = 'here'
  posted = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (url.includes('/studio/save')) {
      const edits: Record<string, unknown>[] = body.edits ?? []
      posted.push(edits)
      const removed: { nodeId: string; text: string; wholeLine: boolean }[] = []
      for (const edit of edits) {
        if (edit.kind !== 'list-item' || edit.length !== items.length) continue
        for (const text of apply(edit.op as ListItemOp)) removed.push({ nodeId: String(edit.nodeId), text, wholeLine: false })
      }
      return new Response(
        JSON.stringify({ ok: true, written: edits.length, skipped: 0, shifted: true, sharedComponents: true, touchedFiles: [FILE], createdNodeIds: [], relocatedNodeIds: [], removed, prunedImports: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  unregister = registerCmsSiteReloader()
  onReload = () => {
    const covers = latestCmsSiteReloadRequest()
    store().loadSite(makeSite({ pages: [board()] }))
    store().setActivePage('board')
    const claimed = claimCmsSiteReloadRequests(covers)
    for (const outcome of claimed.structuralOutcomes) applyStructuralWriteOutcome(outcome)
    claimed.settle()
  }
  window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
  useEditorStore.setState({ site: null, activePageId: null, selectedNodeId: null, selectedNodeIds: [], _historyPast: [], _historyFuture: [], canUndo: false, canRedo: false })
  store().loadSite(makeSite({ pages: [board()] }))
  store().setActivePage('board')
})

afterEach(() => {
  globalThis.fetch = realFetch
  window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
  unregister()
})

async function settle() {
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 200 && isStructuralCommitInFlight(); i++) await new Promise((r) => setTimeout(r, 1))
  }
}

describe('OD-8 — a row gesture writes the array, and one ⌘Z takes it back', () => {
  it('reorder: one list-item write, the moved row selected, one undo entry, ⌘Z posts the inverse', async () => {
    store().moveNode(ROW(0), MAIN, 2)
    await settle()
    expect(posted).toEqual([[{ kind: 'list-item', nodeId: ARRAY, length: 3, op: { kind: 'reorder', order: [1, 2, 0] } }]])
    expect(items).toEqual([`'doing'`, `'done'`, `'todo'`])
    expect(store().selectedNodeId).toBe(ROW(2))
    expect(store()._historyPast).toHaveLength(1)

    store().undo()
    await settle()
    expect(posted[1]).toEqual([{ kind: 'list-item', nodeId: ARRAY, length: 3, op: { kind: 'reorder', order: [2, 0, 1] } }])
    expect(items).toEqual(START)
    expect(store()._historyPast).toHaveLength(0)

    store().redo()
    await settle()
    expect(items).toEqual([`'doing'`, `'done'`, `'todo'`])
  })

  it('delete: the element goes from the array, and ⌘Z writes its own text back at its index', async () => {
    store().deleteNode(ROW(1))
    await settle()
    expect(posted[0]).toEqual([{ kind: 'list-item', nodeId: ARRAY, length: 3, op: { kind: 'remove', indices: [1] } }])
    expect(items).toEqual([`'todo'`, `'done'`])
    expect(store()._historyPast).toHaveLength(1)

    store().undo()
    await settle()
    expect(posted[1]).toEqual([{ kind: 'list-item', nodeId: ARRAY, length: 2, op: { kind: 'insert', at: [1], texts: [`'doing'`] } }])
    expect(items).toEqual(START)
  })

  it('duplicate: a copy after the row, selected, and ⌘Z removes exactly the copy', async () => {
    store().duplicateNode(ROW(0))
    await settle()
    expect(posted[0]).toEqual([{ kind: 'list-item', nodeId: ARRAY, length: 3, op: { kind: 'copy', from: [0], at: 1 } }])
    expect(items).toEqual([`'todo'`, `'todo'`, `'doing'`, `'done'`])
    expect(store().selectedNodeId).toBe(ROW(1))

    store().undo()
    await settle()
    expect(posted[1]).toEqual([{ kind: 'list-item', nodeId: ARRAY, length: 4, op: { kind: 'remove', indices: [1] } }])
    expect(items).toEqual(START)
  })

  it('two quick moves: the second, queued behind the first, moves the row the user meant', async () => {
    store().moveNode(ROW(0), MAIN, 1) // todo ↓ one
    store().moveNode(ROW(0), MAIN, 2) // pressed again at once: still "the todo row", now at index 1
    await settle()
    expect(items).toEqual([`'doing'`, `'done'`, `'todo'`])
    expect(posted[1]).toEqual([{ kind: 'list-item', nodeId: ARRAY, length: 3, op: { kind: 'reorder', order: [0, 2, 1] } }])
  })

  it('a row whose array is imported posts nothing and says why', async () => {
    arraySource = 'imported'
    store().loadSite(makeSite({ pages: [board()] }))
    store().setActivePage('board')
    store().moveNode(ROW(0), MAIN, 2)
    store().deleteNode(ROW(0))
    await settle()
    expect(posted).toEqual([])
    expect(items).toEqual(START)
    expect(store().structuralRefusalDialog?.constraint.explanation).toContain('LANES is imported from another file')
  })
})
