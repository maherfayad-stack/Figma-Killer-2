/**
 * P5-G (FC-3) — a free-canvas gesture is ONE write, ONE history entry, and one
 * ⌘Z that takes back BOTH halves: the layer's module (source) and its
 * placement (`boards.json`).
 *
 * Driven the whole road with a stubbed network, as `structuralSourceUndo.test.ts`
 * does: a real store action, a real `/save`, a narrow `/reload-scope`, a
 * `/load` whose meta line carries the layers the write produced, then real
 * `undo()` / `redo()`. The placement half is asserted against the store's
 * `boards` at every step, because that is the half a patch-only undo would
 * silently leave behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base'
import type { Page } from '@core/page-tree'
import { boardLayers, findLayerPlacement } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { healPlacements } from '@site/store/slices/canvasLayerSlice'
import { markCanvasLayerPending, clearCanvasLayerPending } from '@site/store/slices/canvasLayerPending'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'
import { resetStructuralCommitQueue } from '../structuralCommitQueue'
import { setStudioLoadedDir } from '../studioWorkspaceDir'

const PAGE_ID = 'home'
const ROOT_ID = 'pages/Home.tsx:4:5'
const ROW_ID = 'pages/Home.tsx:5:7'
const BOARD_ID = 'b1'

const homePage = (): Page =>
  makePage({
    id: PAGE_ID,
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.container', children: [ROW_ID] }),
      [ROW_ID]: makeNode({ id: ROW_ID, moduleId: 'base.text', props: { text: 'row' } }),
    },
  })

/** A loose layer's parsed module, as `/load` would carry it. */
function layerContent(layerId: string): { layerId: string; pageId: string; page: Page } {
  const rootId = `.studio/canvas/${layerId}.tsx:6:6`
  const pageId = `canvas:${layerId}`
  return {
    layerId,
    pageId,
    page: makePage({
      id: pageId,
      rootNodeId: `${pageId}:body`,
      nodes: {
        [`${pageId}:body`]: makeNode({ id: `${pageId}:body`, moduleId: 'base.body', children: [rootId] }),
        [rootId]: makeNode({ id: rootId, moduleId: 'base.image', props: { src: '/cat.png', alt: 'cat' } }),
      },
    }),
  }
}

interface SaveAnswer {
  written?: number
  refusals?: { nodeId: string; kind: string; reason: string; message: string }[]
  createdNodeIds?: string[]
  removed?: { nodeId: string; text: string; wholeLine: boolean }[]
  /** What the re-read after this write reports. */
  layers?: { layerId: string; pageId: string; page: Page }[]
  pages?: Page[]
}

describe('free-canvas gestures', () => {
  let originalFetch: typeof globalThis.fetch
  let unregisterSave: (() => void) | null = null
  let patchListener: ((evt: Event) => void) | null = null
  let saveCalls: { edits: Record<string, unknown>[] }[] = []

  beforeEach(() => {
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    originalFetch = globalThis.fetch
    saveCalls = []
    unregisterSave = registerEditorSave(async () => {})
    setStudioLoadedDir('/tmp/studio-test')
    const store = useEditorStore.getState()
    store.loadSite(makeSite({ pages: [homePage()] }))
    store.setActivePage(PAGE_ID)
    store.loadBoards({ version: 1, boards: [{ id: BOARD_ID, name: 'Board 1', frames: [], notes: [], docs: [] }] })
    store.setCanvasLayers([])
    patchListener = (evt: Event) => applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
    window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
    if (patchListener) window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
    setStudioLoadedDir(null)
    resetStructuralCommitQueue()
    useEditorStore.getState().setCanvasLayers([])
    useEditorStore.getState().clearSite()
  })

  function stubFetch(scripted: SaveAnswer[]) {
    let call = 0
    let lastAnswer: SaveAnswer = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = (typeof input === 'string' ? input : input.toString()).split('?')[0]
      if (path === '/admin/api/studio/save') {
        saveCalls.push(init?.body ? JSON.parse(String(init.body)) : { edits: [] })
        lastAnswer = scripted[Math.min(call, scripted.length - 1)] ?? {}
        call += 1
        const written = lastAnswer.written ?? 1
        return new Response(
          JSON.stringify({
            ok: true,
            written,
            skipped: lastAnswer.refusals?.length ?? 0,
            shifted: true,
            sharedComponents: true,
            refusals: lastAnswer.refusals ?? [],
            touchedFiles: ['.studio/canvas/x.tsx'],
            createdNodeIds: lastAnswer.createdNodeIds ?? [],
            relocatedNodeIds: [],
            removed: lastAnswer.removed ?? [],
            prunedImports: [],
          }),
          { status: 200 },
        )
      }
      if (path === '/admin/api/studio/reload-scope') {
        return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: [PAGE_ID] }), { status: 200 })
      }
      if (path === '/admin/api/studio/load') {
        const pages = lastAnswer.pages ?? [homePage()]
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
            pageCount: pages.length,
            canvasLayers: lastAnswer.layers ?? [],
          },
          ...pages.map((p, index) => ({ kind: 'page', page: p, index })),
        ]
        return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as typeof fetch
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const placements = () => boardLayers(useEditorStore.getState().boards.boards[0]!)
  const lastEdits = () => saveCalls[saveCalls.length - 1]!.edits

  it('an image on the empty board: placed at once, written as a module, and one ⌘Z takes back both halves', async () => {
    // The re-read after each write carries what the files now hold: the
    // module after the create, nothing after the undo, the module after the
    // redo. The id is minted by the gesture, so those answers are filled in
    // the moment it exists — before the first write can be answered.
    const scripted: SaveAnswer[] = [{}, { layers: [] }, {}]
    stubFetch(scripted)
    const layerId = useEditorStore.getState().createCanvasLayer({ name: 'img', props: { src: '/cat.png', alt: 'cat' } }, { x: 100.4, y: 50 })
    expect(layerId).toMatch(/^cl[a-z0-9]{10}$/)
    scripted[0]!.layers = [layerContent(layerId!)]
    scripted[2]!.layers = [layerContent(layerId!)]
    // The placement is there before the write answers — the layer lands where it was dropped.
    expect(placements()).toEqual([{ id: layerId!, x: 100, y: 50, z: 1 }])
    await waitFor(() => saveCalls.length === 1)
    expect(lastEdits()).toEqual([
      { kind: 'canvas-layer-create', nodeId: `canvas-layer:${layerId}`, layerId, element: { name: 'img', props: { src: '/cat.png', alt: 'cat' } } },
    ])
    await waitFor(() => useEditorStore.getState().canUndo)
    // The module came back with the re-read, and the placement is exactly where it was dropped.
    expect(`canvas:${layerId}` in useEditorStore.getState().canvasLayerPages).toBe(true)
    expect(placements()).toEqual([{ id: layerId!, x: 100, y: 50, z: 1 }])

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([{ kind: 'canvas-layer-delete', nodeId: `canvas-layer:${layerId}`, layerId }])
    expect(placements()).toEqual([])

    await waitFor(() => useEditorStore.getState().canRedo)
    useEditorStore.getState().redo()
    await waitFor(() => saveCalls.length === 3)
    expect(lastEdits()[0]).toMatchObject({ kind: 'canvas-layer-create', layerId })
    expect(placements()).toEqual([{ id: layerId!, x: 100, y: 50, z: 1 }])
  })

  it('a refused create takes its placement back — nothing on the board the files do not say', async () => {
    stubFetch([{ written: 0, refusals: [{ nodeId: 'canvas-layer:x', kind: 'canvas-layer-create', reason: 'layer-exists', message: 'no' }] }])
    useEditorStore.getState().createCanvasLayer({ name: 'div' }, { x: 0, y: 0 })
    expect(placements()).toHaveLength(1)
    await waitFor(() => saveCalls.length === 1)
    await waitFor(() => placements().length === 0)
    expect(useEditorStore.getState().canUndo).toBe(false)
  })

  it('deleting a loose layer removes module and placement together, and ⌘Z restores the exact bytes and the spot', async () => {
    const layer = layerContent('cl0123456789')
    useEditorStore.getState().setCanvasLayers([layer])
    useEditorStore.getState().applyCanvasLayerPlacements(
      [{ boardId: BOARD_ID, layerId: 'cl0123456789', before: null, after: { id: 'cl0123456789', x: 10, y: 20 } }],
      'after',
    )
    stubFetch([
      { removed: [{ nodeId: 'canvas-layer:cl0123456789', text: 'MODULE BYTES', wholeLine: false }], layers: [] },
      { layers: [layer] },
    ])
    useEditorStore.getState().removeCanvasLayers(['cl0123456789'])
    expect(placements()).toEqual([])
    await waitFor(() => saveCalls.length === 1)
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([
      { kind: 'canvas-layer-restore', nodeId: 'canvas-layer:cl0123456789', layerId: 'cl0123456789', text: 'MODULE BYTES' },
    ])
    expect(findLayerPlacement(useEditorStore.getState().boards, 'cl0123456789')?.placement).toEqual({ id: 'cl0123456789', x: 10, y: 20 })
  })

  it('placing a loose layer into a frame writes it into the page, and ⌘Z puts the module and the placement back', async () => {
    const layer = layerContent('cl0123456789')
    useEditorStore.getState().setCanvasLayers([layer])
    useEditorStore.getState().applyCanvasLayerPlacements(
      [{ boardId: BOARD_ID, layerId: 'cl0123456789', before: null, after: { id: 'cl0123456789', x: 10, y: 20 } }],
      'after',
    )
    const placed = 'pages/Home.tsx:6:7'
    const pageAfter = makePage({
      id: PAGE_ID,
      rootNodeId: ROOT_ID,
      nodes: {
        [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.container', children: [ROW_ID, placed] }),
        [ROW_ID]: makeNode({ id: ROW_ID, moduleId: 'base.text', props: { text: 'row' } }),
        [placed]: makeNode({ id: placed, moduleId: 'base.image', props: { src: '/cat.png' } }),
      },
    })
    stubFetch([
      {
        createdNodeIds: [placed],
        removed: [{ nodeId: '.studio/canvas/cl0123456789.tsx:6:6', text: 'MODULE BYTES', wholeLine: false }],
        layers: [],
        pages: [pageAfter],
      },
      { layers: [layer], pages: [homePage()] },
    ])
    useEditorStore.getState().placeCanvasLayer('cl0123456789', { pageId: PAGE_ID, parentId: ROOT_ID, index: 1, copy: false })
    expect(placements()).toEqual([])
    await waitFor(() => saveCalls.length === 1)
    expect(lastEdits()).toEqual([
      {
        kind: 'canvas-layer-place',
        nodeId: '.studio/canvas/cl0123456789.tsx:6:6',
        layerId: 'cl0123456789',
        parentNodeId: ROOT_ID,
      },
    ])
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(lastEdits()).toEqual([
      { kind: 'delete', nodeId: placed },
      { kind: 'canvas-layer-restore', nodeId: 'canvas-layer:cl0123456789', layerId: 'cl0123456789', text: 'MODULE BYTES' },
    ])
    expect(findLayerPlacement(useEditorStore.getState().boards, 'cl0123456789')?.placement).toEqual({ id: 'cl0123456789', x: 10, y: 20 })
  })
})

describe('healPlacements', () => {
  const file = (layers: { id: string; x: number; y: number }[]) => ({
    version: 1 as const,
    boards: [{ id: BOARD_ID, name: 'B', frames: [{ id: 'f', pageId: 'home', x: 0, y: 0, width: 400 }], notes: [], docs: [], layers }],
  })

  it('drops a placement whose module is gone, and places a module that has none — silently', () => {
    const healed = healPlacements(file([{ id: 'clgone0000000'.slice(0, 12), x: 5, y: 5 }]), BOARD_ID, new Set(['canvas:clfound000000'.slice(0, 19)]))
    const layers = healed.boards[0]!.layers ?? []
    expect(layers.map((layer) => layer.id)).toEqual(['clfound00000'])
    // To the right of everything on the board.
    expect(layers[0]!.x).toBeGreaterThan(400)
  })

  it('leaves a layer whose own write is still on the wire alone', () => {
    markCanvasLayerPending('clpending000')
    try {
      const start = file([{ id: 'clpending000', x: 5, y: 5 }])
      expect(healPlacements(start, BOARD_ID, new Set())).toBe(start)
    } finally {
      clearCanvasLayerPending('clpending000')
    }
  })
})
