/**
 * `store-13` — a structural gesture on a studio-imported board ends with the
 * board pointing at what it just made.
 *
 * This is the half `keys-01`'s K7 could not ship. ⌘D selects the copy on an
 * in-memory (CMS) tree by reading the id `duplicateNode` returns; on a
 * source-backed project that action returns `''`, because the copy does not
 * exist until the codemod has written it and the board has re-read the file.
 * So the answer travels a different road — the save route reports
 * `createdNodeIds`, `commitStructural` parks them in
 * `pendingStructuralOutcome.ts`, and the resync's own listener claims them.
 *
 * Every test here drives that whole road with a stubbed network: a real
 * `duplicateNode`/`insertNode` call on a real store, a `/save` response
 * carrying created ids, a narrow `/reload-scope`, and a `/load` whose fresh
 * page actually contains the created node. Asserting on the box alone would
 * miss the two things most likely to break — the handoff happening a beat too
 * late, and the ids not matching what the parser minted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base'
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
const ROW_ID = 'pages/Home.tsx:5:7'
const CONTAINER_ID = 'pages/Home.tsx:4:5'
/** Where the codemod put the copy — one line below the original, same column. */
const COPY_ID = 'pages/Home.tsx:6:7'

/** The board as the user sees it before the gesture. */
function studioPage(): Page {
  return makePage({
    id: PAGE_ID,
    rootNodeId: CONTAINER_ID,
    nodes: {
      [CONTAINER_ID]: makeNode({ id: CONTAINER_ID, moduleId: 'base.container', children: [ROW_ID] }),
      [ROW_ID]: makeNode({ id: ROW_ID, moduleId: 'base.text', props: { text: 'Row' } }),
    },
  })
}

/** The same page as the re-parse returns it: the copy is now a real node. */
function studioPageAfterCopy(): Page {
  return makePage({
    id: PAGE_ID,
    rootNodeId: CONTAINER_ID,
    nodes: {
      [CONTAINER_ID]: makeNode({ id: CONTAINER_ID, moduleId: 'base.container', children: [ROW_ID, COPY_ID] }),
      [ROW_ID]: makeNode({ id: ROW_ID, moduleId: 'base.text', props: { text: 'Row' } }),
      [COPY_ID]: makeNode({ id: COPY_ID, moduleId: 'base.text', props: { text: 'Row' } }),
    },
  })
}

describe('a structural source write selects what it created', () => {
  let originalFetch: typeof globalThis.fetch
  let unregisterSave: (() => void) | null = null
  let patchListener: ((evt: Event) => void) | null = null
  let saveCalls: unknown[] = []

  beforeEach(() => {
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    originalFetch = globalThis.fetch
    saveCalls = []
    unregisterSave = registerEditorSave(async () => {})
    setStudioLoadedDir('/tmp/studio-test')

    useEditorStore.getState().loadSite(makeSite({ pages: [studioPage()] }))
    useEditorStore.getState().setActivePage(PAGE_ID)
    useEditorStore.getState().selectNode(ROW_ID)

    // Exactly what `usePersistence` does with a narrow resync: hand the fresh
    // pages to the store, then claim whatever the write created.
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

  /** `/save` answers with `createdNodeIds`; `/reload-scope` narrows; `/load` streams the re-parsed page. */
  function stubFetch(options: { createdNodeIds?: string[]; pages?: Page[] } = {}) {
    const pages = options.pages ?? [studioPageAfterCopy()]
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const path = url.split('?')[0]

      if (path === '/admin/api/studio/save') {
        saveCalls.push(init?.body ? JSON.parse(String(init.body)) : undefined)
        return new Response(
          JSON.stringify({
            ok: true,
            written: 1,
            skipped: 0,
            shifted: true,
            sharedComponents: false,
            touchedFiles: ['pages/Home.tsx'],
            ...(options.createdNodeIds === undefined ? {} : { createdNodeIds: options.createdNodeIds }),
          }),
          { status: 200 },
        )
      }
      if (path === '/admin/api/studio/reload-scope') {
        return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: [PAGE_ID] }), { status: 200 })
      }
      if (path === '/admin/api/studio/load') {
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
          ...pages.map((page, index) => ({ kind: 'page', page, index })),
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

  it('⌘D leaves the COPY selected once the resync lands, not the original', async () => {
    stubFetch({ createdNodeIds: [COPY_ID] })

    expect(useEditorStore.getState().duplicateNode(ROW_ID)).toBe('')
    expect(useEditorStore.getState().selectedNodeId).toBe(ROW_ID)

    await waitFor(() => useEditorStore.getState().selectedNodeId === COPY_ID)
    expect(useEditorStore.getState().selectedNodeIds).toEqual([COPY_ID])
    // One gesture, one write.
    expect(saveCalls).toHaveLength(1)
  })

  it('leaves the selection alone when the server reported no created ids', async () => {
    // An older server build, or a write whose position could not be confirmed.
    stubFetch({})

    useEditorStore.getState().duplicateNode(ROW_ID)

    await waitFor(() => useEditorStore.getState().site?.pages[0]?.nodes[COPY_ID] !== undefined)
    expect(useEditorStore.getState().selectedNodeId).toBe(ROW_ID)
  })

  it('selects nothing when the created id did not come back in the re-parsed page', async () => {
    // The write landed and reported an id, but the resync returned a page that
    // does not contain it — selecting it anyway would point the inspector at a
    // node the store cannot resolve.
    stubFetch({ createdNodeIds: ['pages/Home.tsx:99:1'], pages: [studioPageAfterCopy()] })

    useEditorStore.getState().duplicateNode(ROW_ID)

    await waitFor(() => useEditorStore.getState().site?.pages[0]?.nodes[COPY_ID] !== undefined)
    expect(useEditorStore.getState().selectedNodeId).toBe(ROW_ID)
  })

  it('an insert from the library selects the element it added', async () => {
    stubFetch({ createdNodeIds: [COPY_ID] })

    expect(useEditorStore.getState().insertNode('base.container', {}, CONTAINER_ID)).toBe('')

    await waitFor(() => useEditorStore.getState().selectedNodeId === COPY_ID)
    expect(saveCalls).toHaveLength(1)
    expect((saveCalls[0] as { edits: { kind: string }[] }).edits[0]!.kind).toBe('insert')
  })

  it('⌘V writes the paste to source and selects the copy — it never mints an orphan', async () => {
    stubFetch({ createdNodeIds: [COPY_ID] })

    expect(useEditorStore.getState().copyNode(ROW_ID)).toBe(true)
    expect(useEditorStore.getState().pasteNode(CONTAINER_ID)).toBeNull()

    await waitFor(() => useEditorStore.getState().selectedNodeId === COPY_ID)
    const posted = saveCalls[0] as { edits: { kind: string; nodeId: string }[] }
    expect(posted.edits[0]!.kind).toBe('duplicate')
    expect(posted.edits[0]!.nodeId).toBe(ROW_ID)
    // The pasted subtree is the one the codemod wrote, so the tree holds no
    // nanoid twin the next parse would delete.
    const nodes = useEditorStore.getState().site!.pages[0]!.nodes
    expect(Object.keys(nodes).sort()).toEqual([CONTAINER_ID, COPY_ID, ROW_ID].sort())
  })

  it('refuses a paste whose source is not in this file, rather than minting an orphan', async () => {
    stubFetch({ createdNodeIds: [COPY_ID] })
    let toasts: readonly Toast[] = []
    const unsubscribe = subscribeToasts((next) => { toasts = next })

    // A clipboard entry from somewhere else: a CMS project, another page, or a
    // session before this file changed. Its root is not an element in the code
    // here, so there is no source text for `duplicateJsxElement` to copy.
    useEditorStore.setState({
      clipboardEntry: {
        rootNodeIds: ['nanoid-from-elsewhere'],
        nodes: { 'nanoid-from-elsewhere': makeNode({ id: 'nanoid-from-elsewhere', moduleId: 'base.text' }) },
        classes: {},
        copiedAt: Date.now(),
      },
    })

    try {
      expect(useEditorStore.getState().pasteNode(CONTAINER_ID)).toBeNull()
      // Nothing was written, and — the point — nothing was minted either.
      expect(saveCalls).toHaveLength(0)
      expect(Object.keys(useEditorStore.getState().site!.pages[0]!.nodes).sort()).toEqual(
        [CONTAINER_ID, ROW_ID].sort(),
      )
      // And it said so.
      await waitFor(() => toasts.length > 0)
      expect(toasts[0]!.body).toContain('not part of this page')
    } finally {
      unsubscribe()
    }
  })
})
