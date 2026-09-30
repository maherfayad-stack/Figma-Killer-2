/**
 * P3-D / ERR-8 — ⌘Z after a CROSS-FRAME paste takes the copy back out.
 *
 * The paste is a `transplant` with `copy: true` into another page's file; its
 * undo deletes what the write created. A board re-read that lands the copy is
 * simulated, as the real reload does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import type { Page, PageNode } from '@core/page-tree'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { resetSourceIdentities } from '@site/studio/sourceIdentity'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import {
  CMS_SITE_RELOAD_EVENT,
  claimCmsSiteReloadRequests,
  latestCmsSiteReloadRequest,
  registerCmsSiteReloader,
} from '@admin/state/adminEvents'
import { applyStructuralWriteOutcome } from '@site/hooks/siteReloadApply'

const HOME = 'pages/Home.tsx'
const ABOUT = 'pages/About.tsx'
const HOME_MAIN = `${HOME}:4:5`
const D = `${HOME}:5:7`
const COPY = `${HOME}:6:7`
const ABOUT_MAIN = `${ABOUT}:3:5`
const H2 = `${ABOUT}:4:7`

function el(id: string, parentId: string | undefined, children: string[] = []): PageNode {
  return { id, moduleId: children.length > 0 ? 'base.container' : 'base.text', props: {}, breakpointOverrides: {}, children, classIds: [], ...(parentId ? { parentId } : {}) }
}
function pageOf(id: string, nodes: PageNode[]): Page {
  return makePage({ id, rootNodeId: `${id}:body`, nodes: Object.fromEntries(nodes.map((node) => [node.id, node])) })
}
const home = (withCopy: boolean): Page =>
  pageOf('home', [el('home:body', undefined, [HOME_MAIN]), el(HOME_MAIN, 'home:body', withCopy ? [D, COPY] : [D]), el(D, HOME_MAIN), ...(withCopy ? [el(COPY, HOME_MAIN)] : [])])
const about = (): Page => pageOf('about', [el('about:body', undefined, [ABOUT_MAIN]), el(ABOUT_MAIN, 'about:body', [H2]), el(H2, ABOUT_MAIN)])

const store = () => useEditorStore.getState()
let posted: Record<string, unknown>[][]
let realFetch: typeof globalThis.fetch
let unregister: () => void
let onReload: () => void
let boardHasCopy = true

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
      const copy = edits.some((edit) => edit.kind === 'transplant')
      boardHasCopy = copy
      return new Response(
        JSON.stringify({ ok: true, written: edits.length, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [ABOUT, HOME], createdNodeIds: copy ? [COPY] : [], removed: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  unregister = registerCmsSiteReloader()
  onReload = () => {
    const covers = latestCmsSiteReloadRequest()
    const active = store().activePageId
    store().loadSite(makeSite({ pages: [home(boardHasCopy), about()] }))
    if (active) store().setActivePage(active)
    const claimed = claimCmsSiteReloadRequests(covers)
    for (const outcome of claimed.structuralOutcomes) applyStructuralWriteOutcome(outcome)
    claimed.settle()
  }
  window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
  useEditorStore.setState({ site: null, activePageId: null, clipboardEntry: null, selectedNodeId: null, selectedNodeIds: [], _historyPast: [], _historyFuture: [], canUndo: false, canRedo: false })
  store().loadSite(makeSite({ pages: [home(false), about()] }))
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

function toasts(): Toast[] {
  let snapshot: Toast[] = []
  subscribeToasts((next) => { snapshot = next })()
  return snapshot
}

describe('ERR-8 — ⌘Z after a cross-frame paste', () => {
  // The paste's undo entry is pushed when its write's re-read lands. A ⌘Z
  // pressed while that write is still in flight used to find an EMPTY stack and
  // do nothing at all — no write, no toast (P1-F: undo never silently fails).
  it('a ⌘Z pressed while the paste is still being written undoes the paste once it lands', async () => {
    store().setActivePage('about')
    expect(store().copyNode(H2)).toBe(true)
    store().setActivePage('home')
    store().pasteNode(D, 'after')
    expect(isStructuralCommitInFlight()).toBe(true)
    store().undo()
    await settle()
    expect(posted[0]).toEqual([expect.objectContaining({ kind: 'transplant', nodeId: H2, copy: true })])
    expect(posted[1]).toEqual([{ kind: 'delete', nodeId: COPY }])
  })

  it('deletes the copy the paste made, in the file it landed in', async () => {
    store().setActivePage('about')
    expect(store().copyNode(H2)).toBe(true)
    store().setActivePage('home')
    store().pasteNode(D, 'after')
    await settle()
    expect(posted[0]).toEqual([expect.objectContaining({ kind: 'transplant', nodeId: H2, copy: true })])
    expect(store()._historyPast).toHaveLength(1)

    store().undo()
    await settle()
    expect(toasts().filter((toast) => toast.kind !== 'info')).toEqual([])
    expect(posted[1]).toEqual([{ kind: 'delete', nodeId: COPY }])
  })
})
