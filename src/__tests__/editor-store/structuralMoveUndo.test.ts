/**
 * "Ctrl+Z doesn't work on moving items in the canvas or in layers — it works
 * in values and other stuff."  (`store-08`)
 *
 * Two independent failures hide behind that one sentence, and this file pins
 * both.
 *
 * **1. The stack died — or, worse, aimed at the wrong element.** A structural
 * write shifts every `line:col` below it, so the reparse RENAMES node ids.
 * `historySurvivesReload` then either found a stored patch naming an id the
 * reload no longer has and wiped `_historyPast`/`_historyFuture` WHOLESALE
 * (one drag cost the undo history of every unrelated edit before it), or —
 * when the shift happened to reuse the same line numbers in a different order
 * — found every id still "present" and replayed the patch against whatever
 * element now sits at that address. `historyNodeIdRemap.ts` matches the
 * reparse against the pre-reload tree and re-addresses the stack instead.
 *
 * **2. A move's own undo was a lie waiting to happen.** Replaying the inverse
 * PATCH moves the node back in memory only; `saveSite` diffs values, never
 * structure (see `structuralSourceEdits.ts`'s header), so the `.tsx` keeps the
 * move and the next reparse snaps the canvas back. Undo of a move is now the
 * undo journal's `restore` (W2-2) — every file back byte for byte, which an
 * inverse move could not do (a blank line shifted, a block re-indented) —
 * posted to the user's source like a delete's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import type { PageNode } from '@core/page-tree'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'

const FILE = 'app/page.tsx'
/** A studio-imported id: `rel:line:col`. Moving markup renumbers these. */
const at = (line: number) => `${FILE}:${line}:5`
const ROOT = 'page-1:body'

function studioSite(childIds: string[]) {
  const nodes: Record<string, PageNode> = {
    [ROOT]: {
      id: ROOT,
      moduleId: 'base.body',
      props: {},
      breakpointOverrides: {},
      children: [...childIds],
      classIds: [],
    },
  }
  for (const id of childIds) {
    nodes[id] = {
      id,
      moduleId: 'base.text',
      props: { text: id },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    }
  }
  return makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: ROOT, nodes })] })
}

const store = () => useEditorStore.getState()

/** Every `/admin/api/studio/save` body this test saw, newest last. */
let postedEdits: Record<string, unknown>[][]
let realFetch: typeof globalThis.fetch
/** The undo-journal token the stubbed `/save` reports — `undefined` is a server that could not journal. */
let undoToken: string | undefined
const TOKEN = '0123456789abcdef0123456789abcdef'

beforeEach(() => {
  // ERR-4 — the in-flight flag and the queue are module state: a commit left
  // on the wire by one spec would park the next spec's gestures.
  resetStructuralCommitQueue()
  postedEdits = []
  undoToken = TOKEN
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (url.includes('/studio/save')) {
      postedEdits.push(body.edits ?? [])
      return new Response(JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [FILE], ...(undoToken ? { undoToken } : {}) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // Reload scope: answer "not provably narrow" so nothing else is fetched.
    return new Response(JSON.stringify({ ok: true, narrow: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
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

/**
 * Let the fire-and-forget structural commit reach the (stubbed) network and
 * finish. A structural gesture — and a structural ⌘Z/⌘⇧Z — made while one is
 * still in flight is QUEUED behind it (ERR-4), so a spec that means "the user
 * did this, then that" waits for the first to land, exactly as a person's
 * second keypress arrives after the first round trip.
 */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 200 && isStructuralCommitInFlight(); i++) await new Promise((r) => setTimeout(r, 1))
}

/**
 * The board's re-read after a move reports the write's undo-journal token on
 * the entry the move already pushed (`recordStructuralSourceWrite` `fill`).
 * These specs have no editor mounted to re-read, so they apply that step.
 */
function landJournalToken(): void {
  store().recordStructuralSourceWrite({
    kind: 'fill',
    outcome: { createdNodeIds: [], relocatedNodeIds: [], removed: [], undoToken: '0123456789abcdef0123456789abcdef', listArrays: [] },
  })
}

describe('a structural reparse renames node ids — history is re-addressed, not wiped', () => {
  it('re-points the stack at the new ids instead of wiping it', async () => {
    // `a` spans two lines, so dragging it to the end renumbers b and c to
    // addresses that never previously existed — the ordinary case.
    const a = at(3), b = at(6), c = at(8)
    store().loadSite(studioSite([a, b, c]))
    store().setActivePage('page-1')

    // An ordinary VALUE edit — the kind the user says "works".
    store().updateNodeProps(c, { text: 'edited' })
    expect(store()._historyPast.length).toBe(1)

    // The drag: the store moves the node optimistically and commits the write.
    store().moveNodes([a], ROOT, 3)
    expect(store()._historyPast.length).toBe(2)
    await settle()
    landJournalToken()

    // The write lands and the file is re-read: b -> 3, c -> 5, a -> 7. Same
    // shape, new addresses; `c`'s old id is simply gone.
    const b2 = at(3), c2 = at(5), a2 = at(7)
    const reparsed = studioSite([b2, c2, a2])
    reparsed.pages[0]!.nodes[c2]!.props = { text: 'edited' }
    store().loadSite(reparsed)

    expect(store().canUndo).toBe(true)
    expect(store()._historyPast.length).toBe(2)

    store().undo() // the move: the journal's restore, whatever the ids became
    // The restore is a write; the next ⌘Z queues behind it (P3-D).
    await settle()
    expect(postedEdits.at(-1)![0]).toMatchObject({ kind: 'restore', token: TOKEN })

    store().undo() // the value edit, at `c`'s NEW address
    expect(store().site!.pages[0]!.nodes[c2]!.props.text).toBe(c)
  })

  it('never replays a patch against whatever element inherited the address', async () => {
    // Three same-size siblings: moving the first to the end PERMUTES the line
    // numbers, so every old id still "exists" — pointing at a different
    // element. The pre-fix survivability check said "safe" and undo edited the
    // wrong node.
    const a = at(3), b = at(4), c = at(5)
    store().loadSite(studioSite([a, b, c]))
    store().setActivePage('page-1')
    store().updateNodeProps(c, { text: 'edited' })
    store().moveNodes([a], ROOT, 3)
    await settle()
    landJournalToken()

    // b -> 3, c -> 4, a -> 5.
    const reparsed = studioSite([at(3), at(4), at(5)])
    reparsed.pages[0]!.nodes[at(3)]!.props = { text: b }
    reparsed.pages[0]!.nodes[at(4)]!.props = { text: 'edited' }
    reparsed.pages[0]!.nodes[at(5)]!.props = { text: a }
    store().loadSite(reparsed)

    store().undo() // the move
    await settle() // the re-issued move is a write; the next ⌘Z queues behind it
    store().undo() // the value edit

    // `c` is now at line 4. Its edit must be reverted THERE, and the element
    // that inherited line 5 (`a`) must be untouched.
    expect(store().site!.pages[0]!.nodes[at(4)]!.props.text).toBe(c)
    expect(store().site!.pages[0]!.nodes[at(5)]!.props.text).toBe(a)
  })

  it('still wipes when the reparse is not a faithful re-read of the same tree', () => {
    const a = at(3), b = at(6)
    store().loadSite(studioSite([a, b]))
    store().setActivePage('page-1')
    store().updateNodeProps(b, { text: 'edited' })
    expect(store()._historyPast.length).toBe(1)

    // A page that gained nodes and moved every address: no honest 1:1
    // correspondence, so the always-safe fallback applies.
    store().loadSite(studioSite([at(20), at(21), at(22), at(23)]))
    expect(store()._historyPast.length).toBe(0)
    expect(store().canUndo).toBe(false)
  })
})

describe('undo of a move is the undo journal’s restore, written to source', () => {
  it('tags the move as a restore-journal source gesture', () => {
    const a = at(3), b = at(4), c = at(5)
    store().loadSite(studioSite([a, b, c]))
    store().setActivePage('page-1')

    store().moveNodes([a], ROOT, 3)
    expect(store().site!.pages[0]!.nodes[ROOT]!.children).toEqual([b, c, a])

    const entry = store()._historyPast[store()._historyPast.length - 1]!
    expect(entry.structural).toMatchObject({
      gesture: 'source',
      source: { label: 'Move', forward: [{ kind: 'move', nodeId: a }], inverseTemplate: { kind: 'restore-journal' }, inverse: null },
    })
  })

  it('posts a restore of the write’s token on undo and the move again on redo', async () => {
    const a = at(3), b = at(4), c = at(5)
    store().loadSite(studioSite([a, b, c]))
    store().setActivePage('page-1')

    store().moveNodes([a], ROOT, 3)
    await settle()
    landJournalToken()
    expect(postedEdits.length).toBe(1)
    expect(postedEdits[0]![0]).toMatchObject({ kind: 'move', nodeId: a })

    store().undo()
    await settle()
    // The undo is a WRITE, not a memory-only patch replay: without this the
    // canvas and the `.tsx` disagree until the next reparse silently wins.
    expect(postedEdits.length).toBe(2)
    expect(postedEdits[1]).toHaveLength(1)
    expect(postedEdits[1]![0]).toMatchObject({ kind: 'restore', token: TOKEN })

    store().redo()
    await settle()
    expect(postedEdits.length).toBe(3)
    expect(postedEdits[2]![0]).toMatchObject({ kind: 'move', nodeId: a })
  })

  it('consumes exactly one entry — the restore must not push its own', async () => {
    const a = at(3), b = at(4), c = at(5)
    store().loadSite(studioSite([a, b, c]))
    store().setActivePage('page-1')

    store().moveNodes([a], ROOT, 3)
    const pastAfterMove = store()._historyPast.length
    await settle()
    landJournalToken()

    store().undo()
    expect(store()._historyPast.length).toBe(pastAfterMove - 1)
    expect(store()._historyFuture.length).toBe(1)
    expect(store().canRedo).toBe(true)
    await settle()

    store().redo()
    expect(store()._historyPast.length).toBe(pastAfterMove)
    expect(store()._historyFuture.length).toBe(0)
  })

  it('keeps the rest of the redo chain when it re-issues a move', async () => {
    const a = at(3), b = at(4), c = at(5)
    store().loadSite(studioSite([a, b, c]))
    store().setActivePage('page-1')

    store().updateNodeProps(c, { text: 'one' })
    store().moveNodes([a], ROOT, 3)
    await settle()
    landJournalToken()
    store().updateNodeProps(b, { text: 'two' })
    store().undo()
    store().undo()
    await settle()
    store().undo()
    await settle()
    expect(store()._historyFuture.length).toBe(3)

    store().redo() // the first value edit
    store().redo() // the move — a structural re-issue, with a redo still queued
    await settle()
    // The re-issued gesture clears `_historyFuture` on its way through
    // `commitHistoryEntry`; the entry queued BEHIND this one must survive that.
    expect(store()._historyFuture.length).toBe(1)
    store().redo()
    expect(store().site!.pages[0]!.nodes[b]!.props.text).toBe('two')
    expect(store()._historyFuture.length).toBe(0)
  })

  it('does not swallow the entry before it', async () => {
    const a = at(3), b = at(4)
    store().loadSite(studioSite([a, b]))
    store().setActivePage('page-1')
    store().updateNodeProps(b, { text: 'edited' })
    store().moveNodes([a], ROOT, 2)
    await settle()
    landJournalToken()

    store().undo() // the move
    await settle()
    expect(postedEdits.at(-1)![0]).toMatchObject({ kind: 'restore' })
    store().undo() // the value edit
    expect(store().site!.pages[0]!.nodes[b]!.props.text).toBe(b)
  })

  it('a move the server could not journal is skipped by ⌘Z, not faked', async () => {
    undoToken = undefined
    const a = at(3), b = at(4)
    store().loadSite(studioSite([a, b]))
    store().setActivePage('page-1')
    store().moveNodes([a], ROOT, 2)
    await settle()
    const posted = postedEdits.length
    const pastBefore = store()._historyPast.length

    store().undo()
    await settle()
    expect(postedEdits.length).toBe(posted)
    expect(store()._historyPast.length).toBe(pastBefore - 1)
  })
})

describe('a source delete the server journaled no undo for is skipped by ⌘Z, never faked and never a jam', () => {
  // The save mock above answers without an `undoToken` — what the server
  // says when it could not record the write's pre-image (P3-F,
  // `undoJournal.ts`: an oversized or non-UTF-8 file). The entry keeps its
  // `restore-journal` template with no inverse, so ⌘Z has nothing it could
  // post and must skip it rather than resurrect the element on the canvas.
  it('keeps no inverse, and ⌘Z drops the entry instead of faking it or sticking on it', async () => {
    undoToken = undefined
    const a = at(3), b = at(4)
    store().loadSite(studioSite([a, b]))
    store().setActivePage('page-1')

    store().deleteNodes([a])
    expect(store().site!.pages[0]!.nodes[ROOT]!.children).toEqual([b])
    const entry = store()._historyPast[store()._historyPast.length - 1]!
    expect(entry.structural).toMatchObject({
      gesture: 'source',
      source: { label: 'Delete', inverseTemplate: { kind: 'restore-journal' }, inverse: null },
    })

    const pastBefore = store()._historyPast.length
    await settle()
    store().undo()
    // The canvas must NOT resurrect an element the user's source no longer has.
    expect(store().site!.pages[0]!.nodes[ROOT]!.children).toEqual([b])
    // ERR-2 stop-gap — the entry is SKIPPED, not left on top: before this,
    // every later ⌘Z hit the same refusal and nothing below it was reachable.
    expect(store()._historyPast.length).toBe(pastBefore - 1)
    expect(store()._historyFuture.length).toBe(0)
  })

  it('carries on to the step below in the same ⌘Z, so the edits before a delete stay undoable', async () => {
    undoToken = undefined
    const a = at(3), b = at(4)
    store().loadSite(studioSite([a, b]))
    store().setActivePage('page-1')
    store().updateNodeProps(b, { text: 'edited' })
    store().deleteNodes([a])
    await settle()

    store().undo()
    expect(store().site!.pages[0]!.nodes[ROOT]!.children).toEqual([b])
    expect(store().site!.pages[0]!.nodes[b]!.props.text).toBe(b)
    expect(store()._historyPast.length).toBe(0)
    expect(store().canRedo).toBe(true)
  })
})
