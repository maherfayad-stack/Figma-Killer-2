/**
 * `store-14` — ⌘Z takes back a gesture that wrote the user's markup, in one
 * step, through the same writeback route the gesture used.
 *
 * Before this, the whole source-writing family — insert, duplicate, wrap,
 * group, ungroup, paste, cross-frame transplant, the `<img>` an OS file drop
 * becomes — mutated no tree, pushed no history entry, and left ⌘Z undoing
 * whatever came before it (`canvas-20`, landmine 10). The plan's "one gesture
 * is one undo step" was simply not met by the gestures that change the most.
 *
 * Every case here drives the whole road with a stubbed network, the same way
 * `createdNodeSelection.test.ts` does: a real store action, a real `/save`
 * carrying created/relocated ids, a narrow `/reload-scope`, a `/load` whose
 * fresh page is what the write actually produced, and then a real `undo()`.
 * Asserting on the plan alone would miss the two things most likely to break —
 * the entry never reaching the stack, and the inverse addressing an element
 * the board cannot resolve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base'
import { registry } from '@core/module-engine'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'
import { resetStructuralCommitQueue } from '../structuralCommitQueue'
import { setStudioLoadedDir } from '../studioWorkspaceDir'

const PAGE_ID = 'home'
const ROOT_ID = 'pages/Home.tsx:4:5'
const ROW_ID = 'pages/Home.tsx:5:7'
const SECOND_ID = 'pages/Home.tsx:6:7'
/** Where the codemod put whatever the gesture made. */
const MADE_ID = 'pages/Home.tsx:7:7'
/** A second container, elsewhere in the SAME file — `store-15`'s multi-parent delete/undo test. */
const OTHER_PARENT_ID = 'pages/Home.tsx:20:5'
const THIRD_ID = 'pages/Home.tsx:21:7'

interface SaveAnswer {
  createdNodeIds?: string[]
  relocatedNodeIds?: string[]
  removed?: { nodeId: string; text: string; wholeLine: boolean }[]
  prunedImports?: { file: string; declarations: string[] }[]
  pages?: Page[]
}

function page(nodes: Record<string, ReturnType<typeof makeNode>>, children: string[]): Page {
  return makePage({
    id: PAGE_ID,
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.container', children }),
      ...nodes,
    },
  })
}

const text = (id: string) => makeNode({ id, moduleId: 'base.text', props: { text: id } })

/** Two source-backed siblings — the board before any gesture. */
const pageBefore = (): Page => page({ [ROW_ID]: text(ROW_ID), [SECOND_ID]: text(SECOND_ID) }, [ROW_ID, SECOND_ID])

/** The same page with a third element the write made, at `MADE_ID`. */
const pageWithMade = (): Page =>
  page({ [ROW_ID]: text(ROW_ID), [SECOND_ID]: text(SECOND_ID), [MADE_ID]: text(MADE_ID) }, [ROW_ID, SECOND_ID, MADE_ID])

/** The page as a group leaves it: one container at `MADE_ID` holding both rows. */
const pageGrouped = (): Page =>
  page(
    {
      [MADE_ID]: makeNode({ id: MADE_ID, moduleId: 'base.container', children: [ROW_ID, SECOND_ID] }),
      [ROW_ID]: text(ROW_ID),
      [SECOND_ID]: text(SECOND_ID),
    },
    [MADE_ID],
  )

/** `pageBefore` with only `SECOND_ID` left — what deleting `ROW_ID` alone leaves. */
const pageWithoutRow = (): Page => page({ [SECOND_ID]: text(SECOND_ID) }, [SECOND_ID])

const otherParent = (children: string[]) => makeNode({ id: OTHER_PARENT_ID, moduleId: 'base.container', children })

/** Two siblings under `ROOT_ID`, one under `OTHER_PARENT_ID` — two parents, one file. */
const pageWithTwoParents = (): Page =>
  page(
    {
      [ROW_ID]: text(ROW_ID),
      [SECOND_ID]: text(SECOND_ID),
      [OTHER_PARENT_ID]: otherParent([THIRD_ID]),
      [THIRD_ID]: text(THIRD_ID),
    },
    [ROW_ID, SECOND_ID, OTHER_PARENT_ID],
  )

/** `pageWithTwoParents` with all three deleted. */
const pageWithTwoParentsEmptied = (): Page => page({ [OTHER_PARENT_ID]: otherParent([]) }, [OTHER_PARENT_ID])

describe('a structural source write is one undo step', () => {
  let originalFetch: typeof globalThis.fetch
  let unregisterSave: (() => void) | null = null
  let patchListener: ((evt: Event) => void) | null = null
  let saveCalls: { edits: { kind: string; nodeId: string; siblingNodeIds?: string[]; name?: string }[] }[] = []
  let answers: SaveAnswer[] = []

  beforeEach(() => {
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    originalFetch = globalThis.fetch
    saveCalls = []
    answers = []
    unregisterSave = registerEditorSave(async () => {})
    setStudioLoadedDir('/tmp/studio-test')

    useEditorStore.getState().loadSite(makeSite({ pages: [pageBefore()] }))
    useEditorStore.getState().setActivePage(PAGE_ID)
    useEditorStore.getState().selectNode(ROW_ID)

    // Exactly what `usePersistence` does with a narrow resync.
    patchListener = (evt: Event) => {
      applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
    }
    window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
    if (patchListener) window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
    setStudioLoadedDir(null)
    resetStructuralCommitQueue()
    useEditorStore.getState().clearSite()
  })

  /**
   * `/save` answers from `answers`, one per call, so a gesture and its undo
   * can report different results — which is the whole point: the undo's own
   * re-parse is what the redo after it has to address.
   */
  function stubFetch(scripted: SaveAnswer[]) {
    answers = scripted
    let call = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const path = url.split('?')[0]

      if (path === '/admin/api/studio/save') {
        saveCalls.push(init?.body ? JSON.parse(String(init.body)) : { edits: [] })
        const answer = answers[Math.min(call, answers.length - 1)] ?? {}
        call += 1
        return new Response(
          JSON.stringify({
            ok: true,
            written: 1,
            skipped: 0,
            shifted: true,
            sharedComponents: false,
            touchedFiles: ['pages/Home.tsx'],
            createdNodeIds: answer.createdNodeIds ?? [],
            relocatedNodeIds: answer.relocatedNodeIds ?? [],
            removed: answer.removed ?? [],
            prunedImports: answer.prunedImports ?? [],
          }),
          { status: 200 },
        )
      }
      if (path === '/admin/api/studio/reload-scope') {
        return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: [PAGE_ID] }), { status: 200 })
      }
      if (path === '/admin/api/studio/load') {
        const answer = answers[Math.min(call - 1, answers.length - 1)] ?? {}
        const pages = answer.pages ?? [pageWithMade()]
        const lines = [
          {
            kind: 'meta',
            dir: '/tmp/studio-test',
            projectName: 'studio-test',
            componentSources: {},
            styleRules: {},
            styleRuleSources: {},
            styledStyleRuleSources: {},
            conditions: [],
            vendorCss: '',
            authoredCss: '',
            trust: 'static',
            paletteHiddenModuleIds: [],
            pageList: pages.map(({ id, slug, title }) => ({ id, slug, title })),
          },
          ...pages.map((p, index) => ({ kind: 'page', page: p, index })),
        ]
        return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as typeof fetch
  }

  /** Polls a real timer: the commit chain's microtask depth is not something to assert on. */
  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const lastEdits = () => saveCalls[saveCalls.length - 1]!.edits

  /** Every toast on the bus right now. */
  function currentToasts(): Toast[] {
    let snapshot: Toast[] = []
    subscribeToasts((toasts) => {
      snapshot = toasts
    })()
    return snapshot
  }

  /**
   * `store-15` — whether the TOP entry's `inverse` has been filled in.
   * `delete`'s entry exists (and `canUndo` is already true) the instant the
   * eager tree mutation lands, well before its commit's `fill` reports what
   * it discarded — unlike every other gesture in this file, whose `canUndo`
   * only flips once the entry is pushed AFTER that answer is already known.
   * Callers that `undo()` a delete must wait for this, not just `canUndo`.
   */
  function hasResolvedInverse(): boolean {
    const past = useEditorStore.getState()._historyPast
    const entry = past[past.length - 1]
    return entry?.structural?.gesture === 'source' && entry.structural.source.inverse !== null
  }

  it('⌘D then ⌘Z deletes the copy, and is exactly one step', async () => {
    stubFetch([
      { createdNodeIds: [MADE_ID], pages: [pageWithMade()] },
      { pages: [pageBefore()] },
    ])

    useEditorStore.getState().duplicateNode(ROW_ID)
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([{ kind: 'delete', nodeId: MADE_ID }])

    await waitFor(() => useEditorStore.getState().site?.pages[0]?.nodes[MADE_ID] === undefined)
    // ONE step: the entry moved to the redo stack, and nothing else was undone.
    expect(useEditorStore.getState().canUndo).toBe(false)
    expect(useEditorStore.getState().canRedo).toBe(true)
  })

  it('⌘D in one frame, click another frame, ⌘Z: still deletes the copy (ERR-3)', async () => {
    // A second frame on the board: pressing on it activates its page.
    const other = makePage({
      id: 'other',
      rootNodeId: 'pages/Other.tsx:4:5',
      nodes: { 'pages/Other.tsx:4:5': makeNode({ id: 'pages/Other.tsx:4:5', moduleId: 'base.container' }) },
    })
    useEditorStore.getState().loadSite(makeSite({ pages: [pageBefore(), other] }))
    useEditorStore.getState().setActivePage(PAGE_ID)
    stubFetch([
      { createdNodeIds: [MADE_ID], pages: [pageWithMade()] },
      { pages: [pageBefore()] },
    ])

    useEditorStore.getState().duplicateNode(ROW_ID)
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().setActivePage('other')
    useEditorStore.getState().undo()
    // The old active-tree check called MADE_ID "missing", opened a modal
    // blaming the file, and left the entry on top of the stack.
    expect(useEditorStore.getState().structuralRefusalDialog).toBeNull()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([{ kind: 'delete', nodeId: MADE_ID }])
    expect(useEditorStore.getState().canRedo).toBe(true)
  })

  it('⌘⇧Z re-issues the gesture itself, and re-resolves what the NEXT ⌘Z has to delete', async () => {
    stubFetch([
      { createdNodeIds: [MADE_ID], pages: [pageWithMade()] },
      { pages: [pageBefore()] },
      // The redo re-made the element, and the re-parse put it somewhere else —
      // which is exactly why the entry's inverse cannot be frozen at gesture
      // time.
      { createdNodeIds: ['pages/Home.tsx:8:7'], pages: [page({ [ROW_ID]: text(ROW_ID), [SECOND_ID]: text(SECOND_ID), 'pages/Home.tsx:8:7': text('pages/Home.tsx:8:7') }, [ROW_ID, SECOND_ID, 'pages/Home.tsx:8:7'])] },
      { pages: [pageBefore()] },
    ])

    useEditorStore.getState().duplicateNode(ROW_ID)
    await waitFor(() => useEditorStore.getState().canUndo)
    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    await waitFor(() => useEditorStore.getState().canRedo)

    useEditorStore.getState().redo()
    await waitFor(() => saveCalls.length === 3)
    // The redo is the ORIGINAL gesture, not a synthesised one.
    expect(lastEdits()).toEqual([{ kind: 'duplicate', nodeId: ROW_ID }])
    await waitFor(() => useEditorStore.getState().site?.pages[0]?.nodes['pages/Home.tsx:8:7'] !== undefined)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 4)
    // Addressed at where the REDO put it, not where the first write did.
    expect(lastEdits()).toEqual([{ kind: 'delete', nodeId: 'pages/Home.tsx:8:7' }])
  })

  it('an insert from the library is undone by deleting what it added', async () => {
    stubFetch([
      { createdNodeIds: [MADE_ID], pages: [pageWithMade()] },
      { pages: [pageBefore()] },
    ])

    useEditorStore.getState().insertNode('base.container', {}, ROOT_ID)
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([{ kind: 'delete', nodeId: MADE_ID }])
  })

  it('⌘G is undone by dissolving the container it wrote, not by deleting the children', async () => {
    stubFetch([
      { createdNodeIds: [MADE_ID], pages: [pageGrouped()] },
      { relocatedNodeIds: [ROW_ID, SECOND_ID], pages: [pageBefore()] },
    ])

    useEditorStore.getState().selectMany([ROW_ID, SECOND_ID])
    useEditorStore.getState().groupNodes([ROW_ID, SECOND_ID], 'base.container', { tag: 'div' })
    await waitFor(() => useEditorStore.getState().canUndo)
    expect(lastEdits()[0]!.kind).toBe('group')

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([{ kind: 'ungroup', nodeId: MADE_ID }])
  })

  it('⌘⇧G is undone by writing the same container back around the children it released', async () => {
    stubFetch([
      { relocatedNodeIds: [ROW_ID, SECOND_ID], pages: [pageBefore()] },
      { createdNodeIds: [MADE_ID], pages: [pageGrouped()] },
    ])

    useEditorStore.getState().loadSite(makeSite({ pages: [pageGrouped()] }))
    useEditorStore.getState().setActivePage(PAGE_ID)
    useEditorStore.getState().ungroupNode(MADE_ID)
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    const [edit] = lastEdits()
    expect(edit!.kind).toBe('group')
    expect(edit!.nodeId).toBe(ROW_ID)
    expect(edit!.siblingNodeIds).toEqual([SECOND_ID])
    // The container is written back as the tag it was, from the module
    // registry — not as a hardcoded `div`.
    expect(edit!.name).toBe('div')
  })

  it('five queued ⌘D presses are five undo steps, not one', async () => {
    stubFetch([{ createdNodeIds: [MADE_ID], pages: [pageWithMade()] }])

    for (let i = 0; i < 5; i += 1) useEditorStore.getState().duplicateNode(ROW_ID)
    await waitFor(() => saveCalls.length === 5)
    await waitFor(() => useEditorStore.getState()._historyPast.length === 5)

    const past = useEditorStore.getState()._historyPast
    expect(past).toHaveLength(5)
    // Every one of them is its own source-structural step, and none of them
    // coalesced into a neighbour.
    for (const entry of past) {
      expect(entry.structural?.gesture).toBe('source')
      expect(entry.inverse).toEqual([])
    }
  })

  /**
   * The property `structuralUndoPlan.ts`'s LIFO note depends on, held up by
   * `historyNodeIdRemap.ts`: an entry recorded before a reparse renumbered the
   * file still addresses the element it was about, not whatever inherited that
   * line. Without the remap this undo would delete the wrong `<p>`.
   */
  it('follows its target through a reparse that renumbered the file', async () => {
    stubFetch([{ createdNodeIds: [MADE_ID], pages: [pageWithMade()] }])

    useEditorStore.getState().duplicateNode(ROW_ID)
    await waitFor(() => useEditorStore.getState().canUndo)

    // The same three elements, every one of them at a new address — what an
    // unrelated write above them does to this file.
    const moved = (id: string) => id.replace(/:(\d+):/, (_m, line: string) => `:${Number(line) + 10}:`)
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          page(
            {
              [moved(ROW_ID)]: text(moved(ROW_ID)),
              [moved(SECOND_ID)]: text(moved(SECOND_ID)),
              [moved(MADE_ID)]: text(moved(MADE_ID)),
            },
            [moved(ROW_ID), moved(SECOND_ID), moved(MADE_ID)],
          ),
        ],
      }),
    )
    expect(useEditorStore.getState().canUndo).toBe(true)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([{ kind: 'delete', nodeId: moved(MADE_ID) }])
  })

  it('skips what it cannot take back — one notice, no dialog, no write the server would refuse (ERR-28)', async () => {
    stubFetch([{ createdNodeIds: [MADE_ID], pages: [pageGrouped()] }])

    // A design-system container, registered here rather than pulled in from
    // `src/modules/alm/` (which has no importable barrel): what matters is the
    // `sourceImport`, which is what makes the wrapper a COMPONENT tag.
    registry.register({
      id: 'test.card',
      name: 'Card',
      category: 'layout',
      defaults: {},
      schema: [],
      render: () => null,
      sourceImport: { kind: 'design-system', name: 'Card' },
    } as never)

    useEditorStore.getState().selectMany([ROW_ID, SECOND_ID])
    // `unwrapJsxElement` refuses a COMPONENT wrapper by name, so there is no
    // ungroup to write back.
    useEditorStore.getState().groupNodes([ROW_ID, SECOND_ID], 'test.card', {})
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().structuralRefusalDialog).toBeNull()
    const notice = currentToasts().find((toast) => toast.title.startsWith('Skipped “Group”'))
    expect(notice?.kind).toBe('warning')
    expect(notice?.body).toContain('component')
    expect(saveCalls).toHaveLength(1)
    // The step is gone, not parked on top of the stack.
    expect(useEditorStore.getState()._historyPast).toHaveLength(0)
    registry.unregister('test.card')
  })

  it('skips — naming the file — when the inverse no longer resolves against the board (ERR-28)', async () => {
    stubFetch([
      // The write reported an id, but the page the resync brought back does
      // not contain it: the file is not what this entry was recorded against.
      { createdNodeIds: ['pages/Home.tsx:99:1'], pages: [pageWithMade()] },
    ])

    useEditorStore.getState().duplicateNode(ROW_ID)
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().structuralRefusalDialog).toBeNull()
    const notice = currentToasts().find((toast) => toast.title.startsWith('Skipped “Duplicate”'))
    expect(notice?.body).toContain('pages/Home.tsx')
    // Nothing was written, and the stack is not jammed on this step.
    expect(saveCalls).toHaveLength(1)
    expect(useEditorStore.getState().canUndo).toBe(false)
  })

  /**
   * `store-15` — delete is the one member of this family whose tree mutation
   * runs EAGERLY (same-tick optimistic removal), unlike every gesture above.
   * Its entry exists the moment `deleteNode` returns; what these two tests
   * pin is that it is still exactly ONE undo step, and that its inverse —
   * `reinsert-source` — only becomes postable once the delete's own commit
   * has reported what it discarded.
   */
  it('delete is undone by reinserting the element back where it was, and redone by deleting it again', async () => {
    stubFetch([
      // The delete's own commit — what it discarded, for the undo to restore.
      { removed: [{ nodeId: ROW_ID, text: '<Row />\n', wholeLine: true }], pages: [pageWithoutRow()] },
      // The undo's reinsert commit.
      { createdNodeIds: [ROW_ID], pages: [pageBefore()] },
      // The redo's delete commit.
      { removed: [{ nodeId: ROW_ID, text: '<Row />\n', wholeLine: true }], pages: [pageWithoutRow()] },
    ])

    useEditorStore.getState().deleteNode(ROW_ID)
    await waitFor(() => useEditorStore.getState().canUndo)
    await waitFor(() => saveCalls.length === 1)
    expect(lastEdits()).toEqual([{ kind: 'delete', nodeId: ROW_ID }])
    await waitFor(hasResolvedInverse)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([{ kind: 'reinsert-source', nodeId: ROOT_ID, index: 0, text: '<Row />\n' }])
    await waitFor(() => useEditorStore.getState().site?.pages[0]?.nodes[ROW_ID] !== undefined)
    // ONE step: the entry moved to the redo stack, and nothing else was undone.
    expect(useEditorStore.getState().canUndo).toBe(false)
    expect(useEditorStore.getState().canRedo).toBe(true)

    useEditorStore.getState().redo()
    await waitFor(() => saveCalls.length === 3)
    expect(lastEdits()).toEqual([{ kind: 'delete', nodeId: ROW_ID }])
  })

  /**
   * Two of the three deleted elements share `ROOT_ID`; the third belongs to
   * `OTHER_PARENT_ID`, a second container in the same file. The restore posts
   * one `reinsert-source` per element, and `ROOT_ID`'s own two stay in
   * ASCENDING index order relative to each other — the property
   * `resolveStructuralInverse`'s `reinsert-deleted` case exists to guarantee,
   * so the server's own bottom-to-top ordering (by each edit's PARENT
   * position) never has to guess which of two same-parent restores goes
   * first.
   */
  it('restores siblings under two different parents, each parent’s own children ascending', async () => {
    stubFetch([
      {
        removed: [
          { nodeId: ROW_ID, text: '<Row />\n', wholeLine: true },
          { nodeId: SECOND_ID, text: '<Second />\n', wholeLine: true },
          { nodeId: THIRD_ID, text: '<Third />\n', wholeLine: true },
        ],
        pages: [pageWithTwoParentsEmptied()],
      },
      { createdNodeIds: [ROW_ID, THIRD_ID, SECOND_ID], pages: [pageWithTwoParents()] },
    ])

    useEditorStore.getState().loadSite(makeSite({ pages: [pageWithTwoParents()] }))
    useEditorStore.getState().setActivePage(PAGE_ID)
    useEditorStore.getState().deleteNodes([ROW_ID, SECOND_ID, THIRD_ID])
    await waitFor(() => useEditorStore.getState().canUndo)
    await waitFor(() => saveCalls.length === 1)
    await waitFor(hasResolvedInverse)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([
      { kind: 'reinsert-source', nodeId: ROOT_ID, index: 0, text: '<Row />\n' },
      { kind: 'reinsert-source', nodeId: OTHER_PARENT_ID, index: 0, text: '<Third />\n' },
      { kind: 'reinsert-source', nodeId: ROOT_ID, index: 1, text: '<Second />\n' },
    ])
  })
})
