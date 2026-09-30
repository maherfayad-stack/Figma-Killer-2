/**
 * P3-D — structural gestures that used to REFUSE on a studio-imported board
 * now write, each as ONE gesture: one history entry and one `/save` request.
 *
 *  - ERR-7: a multi-selection drag and a multi-selection ⌥-drag were refused
 *    `multi-select`. They are now an ordered `/save` SEQUENCE
 *    (`studioEditSequence.ts`): each step written against the file the
 *    previous one left, all or nothing.
 *  - ERR-8: a paste of something copied in ANOTHER frame, or copied before an
 *    edit renumbered its file, was refused "not part of this page's code any
 *    more". It now finds the copied element where it is, and copies it from
 *    there (a transplant when the destination is another file).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import type { Page, PageNode } from '@core/page-tree'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { noteBoardRead, resetSourceIdentities } from '@site/studio/sourceIdentity'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'

const FILE = 'app/page.tsx'
const OTHER = 'app/other/page.tsx'
const at = (line: number, file = FILE) => `${file}:${line}:5`

/** A studio page: the synthetic root holds ONE real `<main>` (`<file>:2:3`), which holds `childIds`. */
function studioPage(id: string, file: string, childIds: string[], extra: Record<string, Partial<PageNode>> = {}): Page {
  const root = `${id}:body`
  const main = mainOf(file)
  const node = (nodeId: string, parentId: string | undefined, children: string[] = []): PageNode => ({
    id: nodeId,
    moduleId: children.length > 0 || nodeId === main ? 'base.container' : 'base.text',
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
    ...(parentId ? { parentId } : {}),
    ...(extra[nodeId] ?? {}),
  })
  const nodes: Record<string, PageNode> = { [root]: node(root, undefined, [main]), [main]: node(main, root, [...childIds]) }
  for (const childId of childIds) nodes[childId] = node(childId, main)
  return makePage({ id, rootNodeId: root, nodes })
}

const mainOf = (file: string) => `${file}:2:3`

const store = () => useEditorStore.getState()
const childrenOf = (pageId: string, file = FILE) => {
  const page = store().site!.pages.find((candidate) => candidate.id === pageId)!
  return [...page.nodes[mainOf(file)]!.children]
}

interface Posted {
  edits: Record<string, unknown>[]
  sequence: boolean
}
let posted: Posted[]
let realFetch: typeof globalThis.fetch

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
      posted.push({ edits: body.edits ?? [], sequence: body.sequence === true })
      return new Response(
        JSON.stringify({ ok: true, written: (body.edits ?? []).length, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [FILE] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch

  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    clipboardEntry: null,
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

function refusalToasts(): Toast[] {
  let snapshot: Toast[] = []
  subscribeToasts((toasts) => {
    snapshot = toasts
  })()
  return snapshot.filter((toast) => toast.kind === 'warning' || toast.kind === 'error')
}

describe('ERR-7 — a multi-selection drag is one gesture', () => {
  it('moves two separated layers as one ordered sequence, one entry, one request', async () => {
    const [a, u, b, v] = [at(3), at(5), at(7), at(9)]
    store().loadSite(makeSite({ pages: [studioPage('page-1', FILE, [a, u, b, v])] }))
    store().setActivePage('page-1')

    store().moveNodes([a, b], mainOf(FILE), 4)

    expect(childrenOf('page-1')).toEqual([u, v, a, b])
    expect(store()._historyPast).toHaveLength(1)
    expect(store()._historyPast[0]!.structural?.gesture).toBe('moves')
    await settle()
    expect(refusalToasts()).toEqual([])
    expect(posted).toHaveLength(1)
    expect(posted[0]!.sequence).toBe(true)
    // "a after v, then b after a" — the second step names what the first moved.
    expect(posted[0]!.edits).toEqual([
      expect.objectContaining({ kind: 'move', nodeId: a, anchorNodeId: v, position: 'after' }),
      expect.objectContaining({ kind: 'move', nodeId: b, anchorNodeId: a, position: 'after' }),
    ])
  })

  it('one ⌘Z takes the whole drag back in one request', async () => {
    const [a, u, b, v] = [at(3), at(5), at(7), at(9)]
    store().loadSite(makeSite({ pages: [studioPage('page-1', FILE, [a, u, b, v])] }))
    store().setActivePage('page-1')
    store().moveNodes([a, b], mainOf(FILE), 4)
    await settle()

    store().undo()
    expect(childrenOf('page-1')).toEqual([a, u, b, v])
    await settle()
    expect(posted).toHaveLength(2)
    expect(posted[1]!.sequence).toBe(true)
    expect(posted[1]!.edits).toHaveLength(2)
    expect(store()._historyPast).toHaveLength(0)
    expect(store()._historyFuture).toHaveLength(1)
  })

  it('an ⌥-drag of two layers between two others writes both copies after the one they follow', async () => {
    const [a, u, b, v] = [at(3), at(5), at(7), at(9)]
    store().loadSite(makeSite({ pages: [studioPage('page-1', FILE, [a, u, b, v])] }))
    store().setActivePage('page-1')

    store().duplicateNodesTo([a, b], mainOf(FILE), 2)
    await settle()
    expect(refusalToasts()).toEqual([])
    // Index 2 is after `u`: written last-first so the run reads a, b.
    expect(posted[0]!.edits).toEqual([
      expect.objectContaining({ kind: 'duplicate', nodeId: b, anchorNodeId: u, position: 'after' }),
      expect.objectContaining({ kind: 'duplicate', nodeId: a, anchorNodeId: u, position: 'after' }),
    ])
    expect(posted[0]!.sequence).toBe(true)
  })

  it('an ⌥-drag of two layers writes both copies as one sequence', async () => {
    const [a, u, b, v] = [at(3), at(5), at(7), at(9)]
    store().loadSite(makeSite({ pages: [studioPage('page-1', FILE, [a, u, b, v])] }))
    store().setActivePage('page-1')

    store().duplicateNodesTo([a, b], mainOf(FILE), 4)
    await settle()
    expect(refusalToasts()).toEqual([])
    expect(posted).toHaveLength(1)
    expect(posted[0]!.sequence).toBe(true)
    // Dropped at the end: both are appended, first-first, so they read a, b.
    expect(posted[0]!.edits).toEqual([
      { kind: 'duplicate', nodeId: a, parentNodeId: mainOf(FILE) },
      { kind: 'duplicate', nodeId: b, parentNodeId: mainOf(FILE) },
    ])
  })
})

describe('ERR-8 — a paste finds what it copied', () => {
  it('pastes an element copied in another frame, as a transplant copy into this file', async () => {
    const [a, u] = [at(3), at(5)]
    const remote = at(4, OTHER)
    store().loadSite(makeSite({ pages: [studioPage('page-1', FILE, [a, u]), studioPage('page-2', OTHER, [remote])] }))
    store().setActivePage('page-2')
    expect(store().copyNode(remote)).toBe(true)

    store().setActivePage('page-1')
    store().pasteNode(u, 'after')
    await settle()
    expect(refusalToasts()).toEqual([])
    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toEqual([{ kind: 'transplant', nodeId: remote, parentNodeId: mainOf(FILE), copy: true }])
  })

  it('pastes an element whose line an edit above it moved, found again by what it is', async () => {
    const [a, u] = [at(3), at(5)]
    const page = studioPage('page-1', FILE, [a, u], { [u]: { sourceFingerprint: 'p#u' }, [a]: { sourceFingerprint: 'p#a' } })
    store().loadSite(makeSite({ pages: [page] }))
    store().setActivePage('page-1')
    expect(store().copyNode(u)).toBe(true)

    // Something above `u` added a line: the board re-read the file and `u` is
    // now at line 6. The clipboard still says line 5.
    const moved = at(6)
    const shifted = studioPage('page-1', FILE, [a, moved], { [moved]: { sourceFingerprint: 'p#u' }, [a]: { sourceFingerprint: 'p#a' } })
    store().loadSite(makeSite({ pages: [shifted] }))
    store().setActivePage('page-1')
    noteBoardRead([shifted], 'reset')

    store().pasteNode(a, 'after')
    await settle()
    expect(refusalToasts()).toEqual([])
    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toEqual([expect.objectContaining({ kind: 'duplicate', nodeId: moved, anchorNodeId: a })])
  })
})
