/**
 * localizedFrameRendering.test.tsx — WS-10 §4.4 (Phase 4). The render-side
 * proof: a board frame whose OWN `axes.locale` differs from the board
 * default shows the LOCALE-VARIANT tree (`localizedPageSlice.ts`), while its
 * sibling frame of the SAME page (default locale) keeps showing `site.pages`
 * — for the exact SAME `data-node-id` (trap #2, same as the direction/scheme
 * variants Phase 2 proved). `localizedPages` is seeded directly (bypassing
 * the fetch — `ensureLocalizedPage`'s own contract is server-integration-
 * tested in `server/handlers/__tests__/localizedPage.test.ts`), so this test
 * isolates exactly the render-selection responsibility
 * `selectCanvasPageFor`'s `frameId` param owns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { createBoard, type BoardsFile } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

function renderCanvas() {
  return render(<DndContext><CanvasRoot /></DndContext>)
}

async function waitForFrameDocument(frameId: string): Promise<Document> {
  let doc: Document | null = null
  await waitFor(
    () => {
      const frameEl = document.querySelector(`[data-frame-id="${frameId}"]`)
      const iframe = frameEl?.querySelector('iframe') as HTMLIFrameElement | null
      doc = iframe?.contentDocument ?? null
      expect(doc?.body).toBeTruthy()
    },
    { timeout: 3000 },
  )
  return doc!
}

beforeEach(() => {
  cleanup()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ value: null }), { status: 200 })) as typeof fetch
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    // A PRECEDING file (`canvasFrameMounting.test.tsx`) leaves `canvasView`
    // at `'live'` from its own test case with no reset of its own — without
    // resetting it here too, `CanvasRoot` renders the single-frame LIVE
    // preview instead of `BoardFramesLayer`, and this test's `[data-frame-id]`
    // lookups time out against a DOM that was never going to have one.
    // `useEditorStore` is a module-level singleton shared across every test
    // FILE in one `bun test` process — see this file's `afterEach` for the
    // matching defensive reset on the way OUT.
    canvasView: 'design',
    // `INITIAL_ZOOM` (`canvas/math.ts`) is 0.5, NOT `RESET_ZOOM`'s 1 — a
    // preceding file's zoom/pan gesture test can leave the canvas at some
    // OTHER zoom, and at `zoom: 1` this test's SECOND frame (x=600, ~1024px
    // wide) falls outside `frameVirtualization.ts`'s viewport test under
    // happy-dom's default (smaller) window size, rendering an offscreen
    // PLACEHOLDER instead of a live `BreakpointFrame` — confirmed by direct
    // experiment: `zoom: 1` reproduces the failure deterministically,
    // `zoom: INITIAL_ZOOM` does not.
    zoom: 0.5,
    panX: 0,
    panY: 0,
    boards: { version: 1, boards: [] },
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    selectedFrameIds: [],
    frameDefaults: {},
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    hoveredFrameId: null,
    localizedPages: {},
    localizedPageStatus: {},
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  // Defensive: `useEditorStore` is a module-level singleton shared across
  // every test FILE in this same `bun test` process, and `activeBoardId`
  // being non-null makes `BoardFramesLayer` (not the single-frame CMS
  // canvas) the thing `CanvasRoot` renders. Leaving it set past this file
  // would make a LATER, alphabetically-later suite's canvas assertions
  // resolve against a leftover board instead of what it actually set up —
  // reset explicitly rather than relying on the next file's `beforeEach` to
  // happen to overwrite it.
  useEditorStore.setState({ activeBoardId: null, boards: { version: 1, boards: [] } })
})

describe('a locale-variant board frame renders its OWN (pageId, locale) tree', () => {
  it('shows the fetched Arabic text in the locale-variant frame, English in the default sibling — same node id', async () => {
    const enText = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'Hello' } })
    const enRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [enText.id] })
    const enPage = makePage({ id: 'home', rootNodeId: enRoot.id, nodes: { [enRoot.id]: enRoot, [enText.id]: enText } })

    // The Arabic variant `loadStudioPageInLocale` would have produced —
    // SAME node ids (`page-root`, `headline` — trap #2), different text.
    const arText = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'مرحبا' } })
    const arRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [arText.id] })
    const arPage = makePage({ id: 'home', rootNodeId: arRoot.id, nodes: { [arRoot.id]: arRoot, [arText.id]: arText } })

    useEditorStore.setState({
      site: makeSite({ pages: [enPage] }),
      activePageId: enPage.id,
      previewAxes: { direction: 'ltr', colorScheme: 'light' },
      localizedPages: { 'home::ar': arPage },
      localizedPageStatus: { 'home::ar': 'ready' },
    } as Parameters<typeof useEditorStore.setState>[0])

    const board = createBoard('board-1', 'Board 1')
    board.frames = [
      { id: 'frame-en', pageId: enPage.id, x: 0, y: 0 },
      { id: 'frame-ar', pageId: enPage.id, x: 600, y: 0, axes: { locale: 'ar' } },
    ]
    const file: BoardsFile = { version: 1, boards: [board] }
    useEditorStore.getState().loadBoards(file)
    useEditorStore.setState({ activeBoardId: board.id })

    renderCanvas()

    const enDoc = await waitForFrameDocument('frame-en')
    const arDoc = await waitForFrameDocument('frame-ar')

    const enNode = enDoc.querySelector('[data-node-id="headline"]') as HTMLElement
    const arNode = arDoc.querySelector('[data-node-id="headline"]') as HTMLElement
    expect(enNode).toBeTruthy()
    expect(arNode).toBeTruthy()

    // Same node id (trap #2), different rendered text — proving the AR
    // frame reads `localizedPages['home::ar']`, not `site.pages`.
    expect(enNode.textContent).toBe('Hello')
    expect(arNode.textContent).toBe('مرحبا')
  })

  it('falls back to the default tree while the locale-variant fetch is still in flight — never a blank frame', async () => {
    const enText = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'Hello' } })
    const enRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [enText.id] })
    const enPage = makePage({ id: 'home', rootNodeId: enRoot.id, nodes: { [enRoot.id]: enRoot, [enText.id]: enText } })

    useEditorStore.setState({
      site: makeSite({ pages: [enPage] }),
      activePageId: enPage.id,
      previewAxes: { direction: 'ltr', colorScheme: 'light' },
      // No `localizedPages` entry — status pinned to `'loading'` up front
      // (rather than left absent) so `BoardFramesLayer`'s fetch-trigger
      // effect hits `ensureLocalizedPage`'s own "already in flight" early
      // return SYNCHRONOUSLY and never actually calls the network mock.
      // A real, unresolved fetch left dangling past this test's `cleanup()`
      // would resolve later and mutate the (module-singleton) store from
      // whichever test happens to be running next — exactly the kind of
      // cross-file leak `canvas-08`/`canvas-09` warn every test author to
      // avoid.
      localizedPageStatus: { 'home::ar': 'loading' },
    } as Parameters<typeof useEditorStore.setState>[0])

    const board = createBoard('board-1', 'Board 1')
    board.frames = [
      { id: 'frame-ar', pageId: enPage.id, x: 0, y: 0, axes: { locale: 'ar' } },
    ]
    useEditorStore.getState().loadBoards({ version: 1, boards: [board] })
    useEditorStore.setState({ activeBoardId: board.id })

    renderCanvas()

    const arDoc = await waitForFrameDocument('frame-ar')
    const node = arDoc.querySelector('[data-node-id="headline"]') as HTMLElement
    expect(node).toBeTruthy()
    expect(node.textContent).toBe('Hello') // default tree, not blank
  })
})
