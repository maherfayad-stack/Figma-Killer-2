/**
 * P3-D, OD-7 — a structural gesture on markup inside a SHARED component
 * applies to THIS instance only: the call site is detached, the gesture is
 * replayed on the markup that replaced it, and one ⌘Z undoes both. No dialog.
 *
 * Before P3-D a Delete on an element inside `<Card/>` was refused
 * `shared-component` and opened the refusal dialog (WB-14): nothing was
 * written.
 *
 * The server is a stand-in: each `/save` answers the way the real batch does
 * for that kind (what it created, the bytes it removed), and each re-read the
 * write triggers hands the board the page as the file now reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import type { Page, PageNode } from '@core/page-tree'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { resetSourceIdentities } from '@site/studio/sourceIdentity'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import {
  CMS_SITE_RELOAD_EVENT,
  claimCmsSiteReloadRequests,
  latestCmsSiteReloadRequest,
  registerCmsSiteReloader,
} from '@admin/state/adminEvents'
import { applyStructuralWriteOutcome } from '@site/hooks/siteReloadApply'

const FILE = 'app/page.tsx'
const MAIN = `${FILE}:2:3`
const CALL_SITE = `${FILE}:5:5`
const X = `${FILE}:6:5`
const inCard = (line: number) => `${CALL_SITE}~ui/Card.tsx:${line}:10`
const CARD_ROOT = inCard(2)
const TITLE = inCard(3)
const BODY = inCard(4)

function el(id: string, parentId: string | undefined, children: string[] = [], extra: Partial<PageNode> = {}): PageNode {
  return {
    id,
    moduleId: children.length > 0 ? 'base.container' : 'base.text',
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
    ...(parentId ? { parentId } : {}),
    ...extra,
  }
}

function pageOf(nodes: PageNode[]): Page {
  return makePage({ id: 'page-1', rootNodeId: 'page-1:body', nodes: Object.fromEntries(nodes.map((node) => [node.id, node])) })
}

/** `<main>` → `<Card/>` (whose own markup is inlined under it) and `<p>`. */
const shared = (): Page => pageOf([
  el('page-1:body', undefined, [MAIN]),
  el(MAIN, 'page-1:body', [CALL_SITE, X]),
  el(CALL_SITE, MAIN, [CARD_ROOT], { label: 'Card' }),
  el(CARD_ROOT, CALL_SITE, [TITLE, BODY], { fromComponent: 'Card' }),
  el(TITLE, CARD_ROOT, [], { fromComponent: 'Card' }),
  el(BODY, CARD_ROOT, [], { fromComponent: 'Card' }),
  el(X, MAIN),
])

/** The same page once the call site is detached: Card's markup, written in place. */
const DETACHED_ROOT = `${FILE}:5:5`
const DETACHED_TITLE = `${FILE}:6:7`
const DETACHED_BODY = `${FILE}:7:7`
const detached = (): Page => pageOf([
  el('page-1:body', undefined, [MAIN]),
  el(MAIN, 'page-1:body', [DETACHED_ROOT, `${FILE}:9:5`]),
  el(DETACHED_ROOT, MAIN, [DETACHED_TITLE, DETACHED_BODY]),
  el(DETACHED_TITLE, DETACHED_ROOT),
  el(DETACHED_BODY, DETACHED_ROOT),
  el(`${FILE}:9:5`, MAIN),
])

const store = () => useEditorStore.getState()

let posted: Record<string, unknown>[][]
let realFetch: typeof globalThis.fetch
let unregister: () => void
let onReload: () => void

beforeEach(() => {
  resetStructuralCommitQueue()
  resetSourceIdentities()
  __resetToastBusForTests()
  posted = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (url.includes('/studio/save')) {
      const edits: Record<string, unknown>[] = body.edits ?? []
      posted.push(edits)
      const detach = edits.find((edit) => edit.kind === 'detach')
      const deletes = edits.filter((edit) => edit.kind === 'delete')
      return new Response(
        JSON.stringify({
          ok: true,
          written: edits.length,
          skipped: 0,
          shifted: true,
          sharedComponents: false,
          touchedFiles: [FILE],
          createdNodeIds: detach ? [DETACHED_ROOT] : [],
          removed: [
            ...(detach ? [{ nodeId: CALL_SITE, text: '      <Card />\n', wholeLine: true }] : []),
            ...deletes.map((edit) => ({ nodeId: edit.nodeId, text: '        <h2>Title</h2>\n', wholeLine: true })),
          ],
          prunedImports: detach ? [{ file: FILE, declarations: ["import { Card } from '../ui/Card'"] }] : [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch

  // A stand-in for the mounted editor's reload: the board reads the detached
  // page, then applies what the write that asked for the re-read reported.
  unregister = registerCmsSiteReloader()
  onReload = () => {
    const covers = latestCmsSiteReloadRequest()
    store().loadSite(makeSite({ pages: [detached()] }))
    store().setActivePage('page-1')
    const claimed = claimCmsSiteReloadRequests(covers)
    for (const outcome of claimed.structuralOutcomes) applyStructuralWriteOutcome(outcome)
    claimed.settle()
  }
  window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)

  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    structuralRefusalDialog: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  })
  store().loadSite(makeSite({ pages: [shared()] }))
  store().setActivePage('page-1')
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

describe('OD-7 — a gesture inside a shared component applies to this instance only', () => {
  it('Delete detaches the call site, then deletes the element it pointed at — no dialog', async () => {
    store().deleteNode(TITLE)
    await settle()

    expect(store().structuralRefusalDialog).toBeNull()
    expect(posted[0]).toEqual([{ kind: 'detach', nodeId: CALL_SITE }])
    // The title, followed into the detached markup by its place in the tree.
    expect(posted[1]).toEqual([{ kind: 'delete', nodeId: DETACHED_TITLE }])
    expect(posted).toHaveLength(2)
    // Two entries, linked: one keystroke takes both back.
    expect(store()._historyPast).toHaveLength(2)
    expect(store()._historyPast[0]!.linkedToNext).toBe(true)
  })

  it('one ⌘Z undoes the delete AND puts <Card/> back with its import', async () => {
    store().deleteNode(TITLE)
    await settle()

    store().undo()
    await settle()

    expect(posted).toHaveLength(4)
    expect(posted[2]).toEqual([expect.objectContaining({ kind: 'reinsert-source', nodeId: DETACHED_ROOT, index: 0 })])
    expect(posted[3]).toEqual([
      { kind: 'delete', nodeId: DETACHED_ROOT },
      {
        kind: 'reinsert-source',
        nodeId: MAIN,
        index: 0,
        text: '      <Card />\n',
        imports: ["import { Card } from '../ui/Card'"],
      },
    ])
    expect(store()._historyPast).toHaveLength(0)
    expect(store()._historyFuture).toHaveLength(2)
  })

  it('a move inside the instance is followed the same way — the element AND its parent', async () => {
    store().moveNodes([BODY], CARD_ROOT, 0)
    await settle()

    expect(store().structuralRefusalDialog).toBeNull()
    expect(posted[0]).toEqual([{ kind: 'detach', nodeId: CALL_SITE }])
    expect(posted[1]).toEqual([
      expect.objectContaining({ kind: 'move', nodeId: DETACHED_BODY, anchorNodeId: DETACHED_TITLE, position: 'before' }),
    ])
  })
})
