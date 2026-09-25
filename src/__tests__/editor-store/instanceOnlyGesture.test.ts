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
import { noteBoardRead, resetSourceIdentities } from '@site/studio/sourceIdentity'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import {
  CMS_SITE_RELOAD_EVENT,
  claimCmsSiteReloadRequests,
  latestCmsSiteReloadRequest,
  registerCmsSiteReloader,
  requestCmsSiteReload,
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

/**
 * Item 3 — the detach ADDED an import above the call site: everything moved
 * down a line, and `app/page.tsx:5:5` is now a different element (the old
 * "whatever sits at the call site" lookup re-issued the gesture there).
 */
const SHIFTED_ROOT = `${FILE}:6:5`
const SHIFTED_TITLE = `${FILE}:7:7`
const shiftedDetached = (): Page => pageOf([
  el('page-1:body', undefined, [MAIN]),
  el(MAIN, 'page-1:body', [`${FILE}:5:5`, SHIFTED_ROOT, `${FILE}:10:5`]),
  // Something else now sits at the call site's old line.
  el(`${FILE}:5:5`, MAIN, [`${FILE}:5:9`]),
  el(`${FILE}:5:9`, `${FILE}:5:5`),
  el(SHIFTED_ROOT, MAIN, [SHIFTED_TITLE, `${FILE}:8:7`]),
  el(SHIFTED_TITLE, SHIFTED_ROOT),
  el(`${FILE}:8:7`, SHIFTED_ROOT),
  el(`${FILE}:10:5`, MAIN),
])

/** Item 2 — the detach refused; the call site now uses `Card2`, a copy made for it alone. */
const COPY_CALL_SITE = `${FILE}:6:5`
const inCopy = (line: number) => `${COPY_CALL_SITE}~ui/Card2.tsx:${line}:10`
const copied = (): Page => pageOf([
  el('page-1:body', undefined, [MAIN]),
  el(MAIN, 'page-1:body', [COPY_CALL_SITE, `${FILE}:7:5`]),
  el(COPY_CALL_SITE, MAIN, [inCopy(2)], { label: 'Card2' }),
  el(inCopy(2), COPY_CALL_SITE, [inCopy(3), inCopy(4)], { fromComponent: 'Card2' }),
  el(inCopy(3), inCopy(2), [], { fromComponent: 'Card2' }),
  el(inCopy(4), inCopy(2), [], { fromComponent: 'Card2' }),
  el(`${FILE}:7:5`, MAIN),
])

let scenario: 'detach' | 'shifted' | 'copy' = 'detach'

const store = () => useEditorStore.getState()

let posted: Record<string, unknown>[][]
let realFetch: typeof globalThis.fetch
let unregister: () => void
let onReload: () => void

let extracted = false
let holdDeletes = false
let releaseDeletes: () => void = () => {}
let deleteGate: Promise<void> = Promise.resolve()

beforeEach(() => {
  scenario = 'detach'
  extracted = false
  holdDeletes = false
  deleteGate = new Promise<void>((resolve) => { releaseDeletes = resolve })
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
      if (holdDeletes && edits.some((edit) => edit.kind === 'delete')) await deleteGate
      const detach = edits.find((edit) => edit.kind === 'detach')
      const deletes = edits.filter((edit) => edit.kind === 'delete')
      if (detach && scenario === 'copy') {
        return new Response(
          JSON.stringify({ ok: true, written: 0, skipped: 1, shifted: false, sharedComponents: true, touchedFiles: [FILE], refusals: [{ nodeId: CALL_SITE, kind: 'detach', reason: 'uses-hooks', message: 'Card uses useState.' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          ok: true,
          written: edits.length,
          skipped: 0,
          shifted: true,
          sharedComponents: false,
          touchedFiles: [FILE],
          createdNodeIds: detach ? [scenario === 'shifted' ? SHIFTED_ROOT : DETACHED_ROOT] : [],
          removed: [
            ...(detach ? [{ nodeId: CALL_SITE, text: '      <Card />\n', wholeLine: true }] : []),
            ...deletes.map((edit) => ({ nodeId: edit.nodeId, text: '        <h2>Title</h2>\n', wholeLine: true })),
          ],
          prunedImports: detach ? [{ file: FILE, declarations: ["import { Card } from '../ui/Card'"] }] : [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/extract-component')) {
      extracted = true
      queueMicrotask(() => requestCmsSiteReload())
      return new Response(JSON.stringify({ ok: true, newFile: 'ui/Card2.tsx', newComponentName: 'Card2' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch

  // A stand-in for the mounted editor's reload: the board reads the detached
  // page, then applies what the write that asked for the re-read reported.
  unregister = registerCmsSiteReloader()
  onReload = () => {
    const covers = latestCmsSiteReloadRequest()
    const next = scenario === 'shifted' ? shiftedDetached() : scenario === 'copy' ? (extracted ? copied() : shared()) : detached()
    store().loadSite(makeSite({ pages: [next] }))
    store().setActivePage('page-1')
    noteBoardRead([next], 'reset')
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

  // P3-D item 3 — the detach added an import, so the call site's old line
  // now holds something else. The gesture follows the id the detach
  // REPORTED, never "whatever sits at the call site now".
  it('follows the detach’s reported id when an added import shifted the call site', async () => {
    scenario = 'shifted'
    store().deleteNode(TITLE)
    await settle()
    expect(posted[1]).toEqual([{ kind: 'delete', nodeId: SHIFTED_TITLE }])
  })

  // P3-D item 2 — the detach refuses (a hook): a component copy for this
  // call site, the gesture written into the copy, no dialog, one ⌘Z.
  it('falls back to a component copy when the detach refuses — no dialog, one ⌘Z', async () => {
    scenario = 'copy'
    store().deleteNode(TITLE)
    await settle()

    expect(store().structuralRefusalDialog).toBeNull()
    expect(extracted).toBe(true)
    // Written into Card2.tsx, the copy only this call site uses.
    expect(posted.at(-1)).toEqual([{ kind: 'delete', nodeId: inCopy(3) }])
    expect(store()._historyPast).toHaveLength(2)
    expect(store()._historyPast[0]!.linkedToNext).toBe(true)

    const before = posted.length
    store().undo()
    await settle()
    // The delete is taken back, then the call site points at Card again.
    expect(posted[before]).toEqual([expect.objectContaining({ kind: 'reinsert-source' })])
    expect(posted[before + 1]).toEqual([
      { kind: 'swap', nodeId: COPY_CALL_SITE, newComponentName: 'Card', newComponentSource: 'local', newComponentFile: 'ui/Card.tsx' },
    ])
  })

  // A ⌘Z pressed while the REPLAYED gesture is still being written waits for
  // it and then runs at once — the link must already be there, or only the
  // gesture is undone and the detached markup stays.
  it('one ⌘Z pressed while the replayed delete is still in flight undoes both', async () => {
    holdDeletes = true
    store().deleteNode(TITLE)
    for (let i = 0; i < 400 && posted.length < 2; i++) await new Promise((r) => setTimeout(r, 1))
    expect(posted[1]).toEqual([{ kind: 'delete', nodeId: DETACHED_TITLE }])
    store().undo()
    releaseDeletes()
    await settle()
    expect(posted[2]).toEqual([expect.objectContaining({ kind: 'reinsert-source', nodeId: DETACHED_ROOT })])
    expect(posted[3]).toEqual([
      { kind: 'delete', nodeId: DETACHED_ROOT },
      expect.objectContaining({ kind: 'reinsert-source', nodeId: MAIN, text: '      <Card />' + String.fromCharCode(10) }),
    ])
  })
})
