/**
 * `patchPages` — the store side of the agent-write live-reload path
 * (`docs/agent-refs/editor-store.md`'s "Merge: reload only touched pages"
 * contract).
 *
 * Covers:
 *   - upsert an existing page by id, in place
 *   - append a brand-new page id (`studio_create_page`)
 *   - drop a page named in `removedPageIds`, its board frame, and any
 *     dangling `selectedFrameIds`/`activePageId` reference
 *   - selection survives when the selected node id still resolves after the
 *     patch, and is dropped cleanly (no dangling id) when it does not
 *   - a page with local (unsaved) edits that gets overwritten surfaces a
 *     toast — the "merge" policy's explicit data-loss case
 *   - THE GATE: patching never marks the store dirty — the write -> reload ->
 *     re-dirty -> autosave -> write loop `fsCodemodAdapter.test.ts` protects
 *     against, applied to this new path.
 *   - Track C5 — patching leaves undo history untouched UNLESS the patch
 *     would leave a stored entry pointing at a node id that no longer
 *     resolves (the same `historySurvivesReload` predicate `loadSite` uses,
 *     0.2's fix) — in which case it wipes, exactly like a full reload would.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import type { StyleRule } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import { subscribeToasts, __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import '@modules/base/index'

function freshStore() {
  __resetToastBusForTests()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedFrameIds: [],
    hasUnsavedChanges: false,
    boardsDirty: false,
    boardsPendingExplicitRemoval: false,
    // Reset history too — every other test file's `freshStore` does this.
    // Without it, a PRIOR test's `_historyPast`/`_historyFuture` entries can
    // leak into this file's `loadSite(twoPageSite())` calls: `loadSite`
    // (0.2's history-preservation fix — `historyPreservation.ts`) only wipes
    // history when it can't prove every referenced node id still resolves,
    // and this fixture's synthetic ids (`root`, `hero`, `about-root`) are
    // common enough across fixtures to coincidentally "prove safe" a
    // leftover entry from an unrelated test/site. Explicitly starting clean
    // is what every sibling `freshStore` already does; this file just hadn't
    // needed it while `loadSite` unconditionally wiped history for everyone.
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

function twoPageSite() {
  return makeSite({
    pages: [
      makePage({
        id: 'home',
        slug: 'index',
        title: 'Home',
        rootNodeId: 'root',
        nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: ['hero'] }), hero: makeNode({ id: 'hero', moduleId: 'base.text', props: { text: 'Hi' } }) },
      }),
      makePage({ id: 'about', slug: 'about', title: 'About', rootNodeId: 'about-root', nodes: { 'about-root': makeNode({ id: 'about-root', moduleId: 'base.body' }) } }),
    ],
  })
}

describe('patchPages — upsert', () => {
  it('replaces an existing page in place, preserving its position', () => {
    useEditorStore.getState().loadSite(twoPageSite())

    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (edited)', rootNodeId: 'root2', nodes: { root2: makeNode({ id: 'root2', moduleId: 'base.body' }) } })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    const { site } = useEditorStore.getState()
    expect(site!.pages.map((p) => p.id)).toEqual(['home', 'about'])
    expect(site!.pages[0]!.title).toBe('Home (edited)')
    expect(site!.pages[0]!.rootNodeId).toBe('root2')
  })

  it('appends a brand-new page id (studio_create_page) rather than merging it in', () => {
    useEditorStore.getState().loadSite(twoPageSite())

    const newPage = makePage({ id: 'contact', slug: 'contact', title: 'Contact' })
    useEditorStore.getState().patchPages({ pages: [newPage] })

    const { site } = useEditorStore.getState()
    expect(site!.pages.map((p) => p.id)).toEqual(['home', 'about', 'contact'])
  })

  it('is a no-op when there is nothing to patch', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    const before = useEditorStore.getState().site

    useEditorStore.getState().patchPages({ pages: [] })

    expect(useEditorStore.getState().site).toBe(before)
  })
})

/**
 * The project-wide registries a targeted reload recomputes. A freshly-parsed
 * page's `classIds` name rules from the registry computed WITH it; applying
 * the page and keeping the PREVIOUS registry resolves those nodes to no class
 * name at all (`NodeRenderer`'s `getCanvasNodeClassName`), which renders as an
 * unstyled, collapsed page that only a manual refresh fixes.
 */
describe('patchPages — project-wide registries', () => {
  const rule = (name: string): StyleRule => ({
    id: name, name, kind: 'class', selector: `.${name}`, order: 0, styles: {}, contextStyles: {}, createdAt: 0, updatedAt: 0,
  })

  it('replaces styleRules and conditions wholesale when the reload carried them', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.setState((s) => ({ site: { ...s.site!, styleRules: { stale: rule('stale') } } }))

    const fresh = makePage({ id: 'home', slug: 'index', title: 'Home' })
    useEditorStore.getState().patchPages({
      pages: [fresh],
      styleRules: { fresh: rule('fresh') },
      conditions: [],
    })

    const { site } = useEditorStore.getState()
    // Wholesale, not merged: the server recomputes the registry from disk, so
    // a merge would resurrect a rule the edit deleted.
    expect(Object.keys(site!.styleRules)).toEqual(['fresh'])
  })

  it('keeps the current registry when the caller had nothing fresher', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.setState((s) => ({ site: { ...s.site!, styleRules: { kept: rule('kept') } } }))

    useEditorStore.getState().patchPages({ pages: [makePage({ id: 'home', slug: 'index', title: 'Home' })] })

    expect(Object.keys(useEditorStore.getState().site!.styleRules)).toEqual(['kept'])
  })
})

describe('patchPages — removal', () => {
  it('drops a page named in removedPageIds', () => {
    useEditorStore.getState().loadSite(twoPageSite())

    useEditorStore.getState().patchPages({ pages: [], removedPageIds: ['about'] })

    const { site } = useEditorStore.getState()
    expect(site!.pages.map((p) => p.id)).toEqual(['home'])
  })

  it('falls back activePageId when the currently-open page is removed', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().openPageInCanvas('about')
    expect(useEditorStore.getState().activePageId).toBe('about')

    useEditorStore.getState().patchPages({ pages: [], removedPageIds: ['about'] })

    expect(useEditorStore.getState().activePageId).toBe('home')
  })

  it('leaves activePageId untouched when a DIFFERENT page is removed', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().openPageInCanvas('home')

    useEditorStore.getState().patchPages({ pages: [], removedPageIds: ['about'] })

    expect(useEditorStore.getState().activePageId).toBe('home')
  })

  it('drops the board frame and page-id-keyed frame selection for a removed page', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().loadBoards({ version: 1, boards: [] }) // seeds a default board
    useEditorStore.getState().addFrame('home')
    useEditorStore.getState().addFrame('about')
    useEditorStore.getState().selectFrame('about')
    useEditorStore.getState().markBoardsClean()

    useEditorStore.getState().patchPages({ pages: [], removedPageIds: ['about'] })

    const board = useEditorStore.getState().boards.boards[0]!
    expect(board.frames.map((f) => f.pageId)).toEqual(['home'])
    expect(useEditorStore.getState().selectedFrameIds).toEqual([])
    expect(useEditorStore.getState().boardsDirty).toBe(true)
    expect(useEditorStore.getState().boardsPendingExplicitRemoval).toBe(true)
  })

  it('does not touch boards at all when the removed page had no frame', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().loadBoards({ version: 1, boards: [] })
    useEditorStore.getState().addFrame('home')
    useEditorStore.getState().markBoardsClean()
    const boardsBefore = useEditorStore.getState().boards

    useEditorStore.getState().patchPages({ pages: [], removedPageIds: ['about'] })

    expect(useEditorStore.getState().boards).toBe(boardsBefore)
    expect(useEditorStore.getState().boardsDirty).toBe(false)
  })
})

describe('patchPages — selection', () => {
  it('keeps the selection when the selected node id still exists after the patch', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().selectNode('hero')

    // Re-parsed page keeps `hero` at the same id (no line shift).
    const freshHome = makePage({
      id: 'home',
      slug: 'index',
      title: 'Home',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['hero'] }),
        hero: makeNode({ id: 'hero', moduleId: 'base.text', props: { text: 'Hi, edited' } }),
      },
    })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState().selectedNodeId).toBe('hero')
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['hero'])
  })

  it('drops the selection cleanly (no dangling id) when an insert/delete shifted the node id', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().selectNode('hero')

    // Re-parsed page no longer has `hero` — an edit above it shifted every
    // `relFile:line:col` id below (the `shifted` contract, staleness.ts).
    const freshHome = makePage({
      id: 'home',
      slug: 'index',
      title: 'Home',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['hero-shifted'] }),
        'hero-shifted': makeNode({ id: 'hero-shifted', moduleId: 'base.text', props: { text: 'Hi' } }),
      },
    })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState().selectedNodeId).toBeNull()
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
  })

  it('leaves the selection alone when the selected node is on an untouched page', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().openPageInCanvas('about')
    useEditorStore.getState().selectNode('about-root')

    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (edited)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState().selectedNodeId).toBe('about-root')
  })
})

describe('patchPages — local edits lost', () => {
  it('toasts when a page with unsaved edits is overwritten by the incoming patch', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().openPageInCanvas('home')
    // A real store mutation — populates `_dirtySave.pageIds` for 'home'.
    useEditorStore.getState().updateNodeProps('hero', { text: 'User-typed edit' })
    expect(useEditorStore.getState()._dirtySave.pageIds.has('home')).toBe(true)

    const toasts: { kind: string; title: string }[] = []
    const unsubscribe = subscribeToasts((list) => {
      toasts.length = 0
      toasts.push(...list.map((t) => ({ kind: t.kind, title: t.title })))
    })

    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (from disk)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })
    unsubscribe()

    expect(toasts.some((t) => t.kind === 'warning' && t.title === 'Local edits overwritten')).toBe(true)
  })

  it('does NOT toast when the overwritten page had no unsaved edits', () => {
    useEditorStore.getState().loadSite(twoPageSite())

    const toasts: { kind: string; title: string }[] = []
    const unsubscribe = subscribeToasts((list) => {
      toasts.length = 0
      toasts.push(...list.map((t) => ({ kind: t.kind, title: t.title })))
    })

    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (from disk)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })
    unsubscribe()

    expect(toasts.some((t) => t.title === 'Local edits overwritten')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// THE GATE — write-loop safety
// ---------------------------------------------------------------------------

describe('patchPages — never marks the store dirty (write-loop gate)', () => {
  it('does not flip hasUnsavedChanges', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(false)

    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (from disk)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState().hasUnsavedChanges).toBe(false)
  })

  it('does not push an undo history entry', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    const pastLength = useEditorStore.getState()._historyPast.length
    expect(useEditorStore.getState().canUndo).toBe(false)

    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (from disk)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState()._historyPast.length).toBe(pastLength)
    expect(useEditorStore.getState().canUndo).toBe(false)
  })

  it('does not disturb hasUnsavedChanges=true left by a REAL, unrelated user edit on another page', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().openPageInCanvas('about')
    useEditorStore.getState().updateNodeProps('about-root', { tag: 'section' })
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(true)

    // An agent patches an UNRELATED page ('home') — the user's real pending
    // edit on 'about' must still autosave normally afterward.
    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (from disk)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState().hasUnsavedChanges).toBe(true)
  })

  it('still marks boardsDirty for a REAL board-frame cleanup — that is a genuine, confirmed change, not a re-dirty of stale state', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().loadBoards({ version: 1, boards: [] })
    useEditorStore.getState().addFrame('about')
    useEditorStore.getState().markBoardsClean()

    useEditorStore.getState().patchPages({ pages: [], removedPageIds: ['about'] })

    // This IS supposed to autosave boards.json — the page is genuinely gone.
    expect(useEditorStore.getState().boardsDirty).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Track C5 — history survives a patch on the SAME honest condition
// `loadSite` uses (`historyPreservation.ts`), reused rather than duplicated.
// ---------------------------------------------------------------------------

describe('patchPages — history (Track C5)', () => {
  it('keeps _historyPast/_historyFuture (same array references) when the patch does not touch any referenced node id', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().openPageInCanvas('about')
    // A real undo-able edit on 'about-root' — the page this patch will NOT touch.
    useEditorStore.getState().updateNodeProps('about-root', { tag: 'section' })
    const pastBefore = useEditorStore.getState()._historyPast
    expect(pastBefore.length).toBeGreaterThan(0)
    expect(useEditorStore.getState().canUndo).toBe(true)

    // Patches ONLY 'home' — 'about-root' (what the history entry references)
    // is untouched and still resolves.
    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (from disk)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState()._historyPast).toBe(pastBefore)
    expect(useEditorStore.getState().canUndo).toBe(true)
  })

  it('wipes _historyPast/_historyFuture when the patch removes a node id a stored entry references', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().openPageInCanvas('home')
    // A real undo-able edit on 'hero' — the exact node the incoming patch is about to shift away.
    useEditorStore.getState().updateNodeProps('hero', { text: 'User edit' })
    expect(useEditorStore.getState()._historyPast.length).toBeGreaterThan(0)
    expect(useEditorStore.getState().canUndo).toBe(true)

    // Re-parsed 'home' no longer has 'hero' — same shape a shifted move/
    // delete/insert produces (struct-01's `shifted` contract).
    const freshHome = makePage({
      id: 'home',
      slug: 'index',
      title: 'Home',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['hero-shifted'] }),
        'hero-shifted': makeNode({ id: 'hero-shifted', moduleId: 'base.text', props: { text: 'Hi' } }),
      },
    })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState()._historyPast).toEqual([])
    expect(useEditorStore.getState()._historyFuture).toEqual([])
    expect(useEditorStore.getState().canUndo).toBe(false)
  })

  it('always ends an open coalescing burst, whether or not history survives the patch', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    useEditorStore.getState().openPageInCanvas('about')
    useEditorStore.getState().updateNodeProps('about-root', { tag: 'section' }) // opens a burst
    expect(useEditorStore.getState()._historyCoalesceKey).not.toBeNull()

    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (from disk)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState()._historyCoalesceKey).toBeNull()
  })

  it('is a safe no-op when history is already empty', () => {
    useEditorStore.getState().loadSite(twoPageSite())
    expect(useEditorStore.getState()._historyPast).toEqual([])

    const freshHome = makePage({ id: 'home', slug: 'index', title: 'Home (from disk)' })
    useEditorStore.getState().patchPages({ pages: [freshHome] })

    expect(useEditorStore.getState()._historyPast).toEqual([])
    expect(useEditorStore.getState().canUndo).toBe(false)
  })
})
