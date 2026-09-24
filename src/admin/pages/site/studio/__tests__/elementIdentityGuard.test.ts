/**
 * P1-A — the element identity guard, client half (ERR-4, WB-1's recovery).
 *
 * ERR-4's probe, committed. A drag's move is still on the wire when the user
 * presses Delete on an element BELOW the one they moved. The delete used to
 * post at once with ids from before the move; once the move landed, the id it
 * named (`a.tsx:5:5`) was the element that had just MOVED there, and that is
 * what got deleted. Now the delete queues behind the move, captures who it was
 * pressed on, and — once the move's resync has renumbered the file — posts
 * against that element's NEW id, carrying its identity as `expect`.
 *
 * And the other half: a write the server refuses `element-moved` (the file
 * changed outside Studio) is recovered silently — re-read, re-found, re-posted
 * once — and only an element that cannot be found again says anything, once.
 *
 * Every test drives the real store with a stubbed network: `/save`, a narrow
 * `/reload-scope`, and a `/load` whose page is the file as re-read. The patch
 * listener IS `usePersistence`'s (`applySitePagesPatch`): hand the pages to the
 * store, record who each position names now, apply the structural outcome.
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
import { deferredStructuralGestureCount, isStructuralCommitInFlight, resetStructuralCommitQueue } from '../structuralCommitQueue'
import { noteBoardRead, resetSourceIdentities } from '../sourceIdentity'
import { setStudioLoadedDir } from '../studioWorkspaceDir'
import { fsCodemodAdapter } from '../fsCodemodAdapter'

const PAGE_ID = 'home'
const CONTAINER = 'a.tsx:2:3'
const FP = { container: 'ul#0000000f', x: 'li#0000000a', y: 'li#0000000b', t: 'li#0000000c', z: 'li#0000000d' }

/** The page with its children at lines 3, 4, 5, … in the order given. */
function pageWith(children: (keyof typeof FP)[]): Page {
  const ids = children.map((_, index) => `a.tsx:${index + 3}:5`)
  return makePage({
    id: PAGE_ID,
    rootNodeId: CONTAINER,
    nodes: {
      [CONTAINER]: makeNode({ id: CONTAINER, moduleId: 'base.container', children: ids, sourceFingerprint: FP.container }),
      ...Object.fromEntries(
        children.map((name, index) => [
          ids[index]!,
          makeNode({ id: ids[index]!, moduleId: 'base.text', props: { text: name }, sourceFingerprint: FP[name] }),
        ]),
      ),
    },
  })
}

interface SaveCall {
  edits: { kind: string; nodeId: string }[]
  expect?: Record<string, string>
}

describe('the element identity guard, on the board', () => {
  let originalFetch: typeof globalThis.fetch
  let unregisterSave: (() => void) | null = null
  let patchListener: ((evt: Event) => void) | null = null
  let unsubscribeToasts: (() => void) | null = null
  let toasts: readonly Toast[] = []
  let saveCalls: SaveCall[] = []

  beforeEach(() => {
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    resetSourceIdentities()
    originalFetch = globalThis.fetch
    saveCalls = []
    toasts = []
    // What the real autosave flush does before a structural commit posts: the
    // dirty marks it takes are the ones a later resync must not warn about.
    unregisterSave = registerEditorSave(async () => { useEditorStore.getState().takeDirtySaveSnapshot() })
    unsubscribeToasts = subscribeToasts((next) => { toasts = next })
    setStudioLoadedDir('/tmp/studio-test')

    const site = makeSite({ pages: [pageWith(['x', 'y', 't'])] })
    useEditorStore.getState().loadSite(site)
    useEditorStore.getState().setActivePage(PAGE_ID)
    noteBoardRead(site.pages, 'reset')

    // The real listener body (`siteReloadApply.ts`): hand the pages to the store,
    // record who each position names now, apply the outcome that rode this re-read.
    patchListener = (evt: Event) => applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
    window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
    unsubscribeToasts?.()
    if (patchListener) window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
    setStudioLoadedDir(null)
    resetStructuralCommitQueue()
    resetSourceIdentities()
    useEditorStore.getState().clearSite()
  })

  /**
   * `/save` answers each call with the next scripted response, the first one
   * only once `release()` is called (so a test can act while it is in flight);
   * `/load` streams whatever `disk.page` is at that moment.
   */
  function stubFetch(responses: Record<string, unknown>[], disk: { page: Page }, gated = false) {
    let release: () => void = () => {}
    const gate = gated ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve()
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const path = url.split('?')[0]
      if (path === '/admin/api/studio/save') {
        const index = saveCalls.length
        saveCalls.push(JSON.parse(String(init?.body)) as SaveCall)
        if (index === 0) await gate
        const response = responses[index] ?? { written: 1 }
        return new Response(
          JSON.stringify({ ok: true, written: 0, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: ['a.tsx'], ...response }),
          { status: 200 },
        )
      }
      if (path === '/admin/api/studio/reload-scope') {
        return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: [PAGE_ID] }), { status: 200 })
      }
      if (path === '/admin/api/studio/load') {
        const meta = {
          kind: 'meta', dir: '/tmp/studio-test', projectName: 'studio-test', componentSources: {}, styleRules: {},
          styleRuleSources: {}, styledStyleRuleSources: {}, conditions: [], vendorCss: '', authoredCss: '',
          trust: 'static', paletteHiddenModuleIds: [], pageCount: 1,
        }
        return new Response(`${JSON.stringify(meta)}\n${JSON.stringify({ kind: 'page', page: disk.page, index: 0 })}\n`, { status: 200 })
      }
      if (path === '/admin/api/studio/framework') {
        return new Response(JSON.stringify({ framework: null, fonts: null }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as typeof fetch
    return { release: () => release() }
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const children = () => useEditorStore.getState().site!.pages[0]!.nodes[CONTAINER]!.children
  const settled = () => !isStructuralCommitInFlight() && deferredStructuralGestureCount() === 0

  it('ERR-4 — a delete pressed while a move is in flight lands on the element it was pressed on', async () => {
    // After the move lands, the file reads y, t, x: `t` moved UP to line 4 and
    // `x` — the element just dragged — now sits at `t`'s old line 5.
    const disk = { page: pageWith(['y', 't', 'x']) }
    const { release } = stubFetch([{ written: 1, relocatedNodeIds: ['a.tsx:5:5'] }, { written: 1 }], disk, true)

    useEditorStore.getState().moveNodes(['a.tsx:3:5'], CONTAINER, 3)
    await waitFor(() => saveCalls.length === 1)
    expect(isStructuralCommitInFlight()).toBe(true)

    // Delete on `t`, pressed on the board the user is looking at: `a.tsx:5:5`.
    useEditorStore.getState().deleteNodes(['a.tsx:5:5'])
    // Nothing reached the network while the move is on the wire…
    expect(saveCalls).toHaveLength(1)
    expect(deferredStructuralGestureCount()).toBe(1)

    release()
    await waitFor(() => saveCalls.length === 2 && settled())

    // …and when it runs, it deletes `t` at its NEW line — never `x`, which is
    // what `a.tsx:5:5` names now — and says who it expects to find there.
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'delete', nodeId: 'a.tsx:4:5' }])
    expect(saveCalls[1]!.expect).toEqual({ 'a.tsx:4:5': FP.t })
    expect(toasts.filter((toast) => toast.kind === 'error' || toast.kind === 'warning')).toEqual([])
  })

  it('every structural commit carries the identity of each id it names', async () => {
    stubFetch([{ written: 1 }], { page: pageWith(['y', 't', 'x']) })
    useEditorStore.getState().moveNodes(['a.tsx:3:5'], CONTAINER, 3)
    await waitFor(() => saveCalls.length === 1 && settled())
    expect(saveCalls[0]!.edits[0]).toMatchObject({ kind: 'move', nodeId: 'a.tsx:3:5', anchorNodeId: 'a.tsx:5:5' })
    expect(saveCalls[0]!.expect).toEqual({ 'a.tsx:3:5': FP.x, 'a.tsx:5:5': FP.t })
  })

  it('WB-1 — an element-moved refusal is re-read, re-found and re-posted once, with nothing shown', async () => {
    // Someone inserted `z` above the list outside Studio: `t` is now at line 6.
    const disk = { page: pageWith(['z', 'x', 'y', 't']) }
    stubFetch(
      [
        {
          written: 0,
          skipped: 1,
          refusals: [{ nodeId: 'a.tsx:5:5', kind: 'delete', reason: 'element-moved', message: 'a.tsx changed…' }],
        },
        { written: 1 },
      ],
      disk,
    )

    useEditorStore.getState().deleteNode('a.tsx:5:5')
    await waitFor(() => saveCalls.length === 2 && settled())

    expect(saveCalls[1]!.edits).toEqual([{ kind: 'delete', nodeId: 'a.tsx:6:5' }])
    expect(saveCalls[1]!.expect).toEqual({ 'a.tsx:6:5': FP.t })
    expect(toasts.filter((toast) => toast.kind === 'error' || toast.kind === 'warning')).toEqual([])
  })

  it('says exactly one honest thing when the element cannot be found again, and writes nothing more', async () => {
    // `t` is gone from the file altogether.
    const disk = { page: pageWith(['z', 'x', 'y']) }
    stubFetch(
      [{ written: 0, skipped: 1, refusals: [{ nodeId: 'a.tsx:5:5', kind: 'delete', reason: 'element-moved', message: 'm' }] }],
      disk,
    )

    useEditorStore.getState().deleteNode('a.tsx:5:5')
    await waitFor(() => settled() && toasts.length > 0)

    expect(saveCalls).toHaveLength(1)
    const shown = toasts.filter((toast) => toast.kind === 'error' || toast.kind === 'warning')
    expect(shown).toHaveLength(1)
    expect(shown[0]!.kind).toBe('warning')
    expect(shown[0]!.body).toContain('a.tsx')
    // The board shows the file as it is, `t` gone and nothing else touched.
    expect(children()).toEqual(['a.tsx:3:5', 'a.tsx:4:5', 'a.tsx:5:5'])
  })

  it('WB-1 — a VALUE edit refused element-moved is re-found and written once, with nothing shown', async () => {
    // The autosave diff reads its baseline from the adapter's own load.
    const disk = { page: pageWith(['x', 'y', 't']) }
    stubFetch(
      [
        { written: 0, skipped: 1, refusals: [{ nodeId: 'a.tsx:5:5', kind: 'text', reason: 'element-moved', message: 'm' }] },
        { written: 1, shifted: false, fingerprints: [{ nodeId: 'a.tsx:6:5', fingerprint: 'li#000000ee' }] },
      ],
      disk,
    )
    const site = await fsCodemodAdapter.loadSite()
    noteBoardRead(site!.pages, 'reset')
    // Outside Studio, `z` lands above the list: `t` is at line 6 now.
    disk.page = pageWith(['z', 'x', 'y', 't'])

    const edited = structuredClone(site!)
    edited.pages[0]!.nodes['a.tsx:5:5']!.props = { text: 'renamed' }
    await fsCodemodAdapter.saveSite(edited)

    expect(saveCalls).toHaveLength(2)
    expect(saveCalls[0]!.expect).toEqual({ 'a.tsx:5:5': FP.t })
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'text', nodeId: 'a.tsx:6:5', text: 'renamed' }])
    expect(saveCalls[1]!.expect).toEqual({ 'a.tsx:6:5': FP.t })
    expect(toasts.filter((toast) => toast.kind === 'error' || toast.kind === 'warning')).toEqual([])
  })
})
