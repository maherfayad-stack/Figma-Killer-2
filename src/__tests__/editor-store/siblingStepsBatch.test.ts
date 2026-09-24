/**
 * P2-C2 (OD-16) — a multi-selection moved among its siblings is ONE gesture:
 * one history entry, one `/save` request carrying every move, and one ⌘Z that
 * posts the inverse batch in one request too.
 *
 * Before P2-C2, ⌥↓ / ⌘] / the arrows with two layers selected did nothing at
 * all (`runMoveShortcut` returned on a multi-selection), and a multi-element
 * `moveNodes` is refused at the source gate as `multi-select`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import type { PageNode } from '@core/page-tree'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { stepSelectionAmongSiblings } from '@site/canvas/canvasNodeArrowMove'

const FILE = 'app/page.tsx'
const at = (line: number) => `${FILE}:${line}:5`
const ROOT = 'page-1:body'

function studioSite(childIds: string[]) {
  const nodes: Record<string, PageNode> = {
    [ROOT]: { id: ROOT, moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [...childIds], classIds: [] },
  }
  for (const id of childIds) {
    nodes[id] = { id, moduleId: 'base.text', props: { text: id }, breakpointOverrides: {}, children: [], classIds: [] }
  }
  return makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: ROOT, nodes })] })
}

const store = () => useEditorStore.getState()
const order = () => [...store().site!.pages[0]!.nodes[ROOT]!.children]

let postedEdits: Record<string, unknown>[][]
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  resetStructuralCommitQueue()
  postedEdits = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (url.includes('/studio/save')) {
      postedEdits.push(body.edits ?? [])
      return new Response(JSON.stringify({ ok: true, written: (body.edits ?? []).length, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [FILE] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
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
})

afterEach(() => {
  globalThis.fetch = realFetch
})

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 200 && isStructuralCommitInFlight(); i++) await new Promise((r) => setTimeout(r, 1))
}

const moves = (edits: Record<string, unknown>[]) => edits.filter((edit) => edit.kind === 'move')

describe('a multi-selection steps among its siblings as one gesture', () => {
  it('two separated layers step down together: one entry, one request with both moves', async () => {
    const [a, u, b, v] = [at(3), at(5), at(7), at(9)]
    store().loadSite(studioSite([a, u, b, v]))
    store().setActivePage('page-1')

    stepSelectionAmongSiblings([a, b], 1)
    expect(order()).toEqual([u, a, v, b])
    expect(store()._historyPast).toHaveLength(1)
    expect(store()._historyPast[0]!.structural?.gesture).toBe('siblings')
    await settle()
    expect(postedEdits).toHaveLength(1)
    expect(moves(postedEdits[0]!)).toHaveLength(2)
  })

  it('one ⌘Z posts the inverse batch in ONE request and restores the order', async () => {
    const [a, u, b, v] = [at(3), at(5), at(7), at(9)]
    store().loadSite(studioSite([a, u, b, v]))
    store().setActivePage('page-1')
    stepSelectionAmongSiblings([a, b], 1)
    await settle()

    store().undo()
    expect(order()).toEqual([a, u, b, v])
    await settle()
    expect(postedEdits).toHaveLength(2)
    expect(moves(postedEdits[1]!)).toHaveLength(2)
    expect(store()._historyPast).toHaveLength(0)
    expect(store()._historyFuture).toHaveLength(1)
  })

  it('a contiguous run is a single element move — the plain `move` entry every drag makes', async () => {
    const [a, b, c] = [at(3), at(5), at(7)]
    store().loadSite(studioSite([a, b, c]))
    store().setActivePage('page-1')

    stepSelectionAmongSiblings([a, b], 1)
    expect(order()).toEqual([c, a, b])
    expect(store()._historyPast[0]!.structural?.gesture).toBe('move')
    await settle()
    expect(postedEdits).toEqual([[expect.objectContaining({ kind: 'move', nodeId: c, anchorNodeId: a, position: 'before' })]])
  })

  it('a batch the source gate refuses moves nothing at all — never half', async () => {
    // `b` is placed by code (a parser `lockReason`): its own move refuses, so
    // `a`'s, which alone would be fine, must not happen either.
    const [a, u, b, v] = [at(3), at(5), at(7), at(9)]
    const site = studioSite([a, u, b, v])
    site.pages[0]!.nodes[b] = { ...site.pages[0]!.nodes[b]!, lockReason: 'rendered by a .map()' }
    store().loadSite(site)
    store().setActivePage('page-1')
    stepSelectionAmongSiblings([a, b], 1)
    await settle()
    expect(order()).toEqual([a, u, b, v])
    expect(store()._historyPast).toHaveLength(0)
    expect(postedEdits).toHaveLength(0)
  })
})
