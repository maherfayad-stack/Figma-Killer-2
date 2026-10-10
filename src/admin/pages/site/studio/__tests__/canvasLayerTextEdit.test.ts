/**
 * A text on the free canvas is editable in place (P5-G): the inline edit opens
 * on the layer's own node, writes NOTHING per keystroke (the layer's module is
 * not in the page tree), and posts ONE `text` edit to its
 * `.studio/canvas/<id>.tsx` when the session ends — with ONE undo entry that
 * writes the old text back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { startLayerTextEdit, whenLayerReady } from '@site/canvas/BoardCanvasLayer/canvasLayerTextEdit'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'
import { resetStructuralCommitQueue } from '../structuralCommitQueue'
import { setStudioLoadedDir } from '../studioWorkspaceDir'

const LAYER_ID = 'cl0123456789'
const PAGE_ID = `canvas:${LAYER_ID}`
const TEXT_ID = `.studio/canvas/${LAYER_ID}.tsx:6:6`

const HOME_ID = 'home'
const homePage = (): Page =>
  makePage({
    id: HOME_ID,
    rootNodeId: 'pages/Home.tsx:4:5',
    nodes: { 'pages/Home.tsx:4:5': makeNode({ id: 'pages/Home.tsx:4:5', moduleId: 'base.container', children: [] }) },
  })

function layerPage(text: string): Page {
  return makePage({
    id: PAGE_ID,
    rootNodeId: `${PAGE_ID}:body`,
    nodes: {
      [`${PAGE_ID}:body`]: makeNode({ id: `${PAGE_ID}:body`, moduleId: 'base.body', children: [TEXT_ID] }),
      [TEXT_ID]: makeNode({ id: TEXT_ID, moduleId: 'base.text', props: { text } }),
    },
  })
}

describe('a loose text layer edits in place', () => {
  let originalFetch: typeof globalThis.fetch
  let unregisterSave: (() => void) | null = null
  let saveCalls: { edits: Record<string, unknown>[] }[] = []
  let answerWritten = 1
  let lastText = 'Text'
  let patchListener: ((evt: Event) => void) | null = null

  beforeEach(() => {
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    originalFetch = globalThis.fetch
    saveCalls = []
    answerWritten = 1
    lastText = 'Text'
    unregisterSave = registerEditorSave(async () => {})
    patchListener = (evt: Event) => applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
    window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
    setStudioLoadedDir('/tmp/studio-test')
    const store = useEditorStore.getState()
    store.loadSite(makeSite({ pages: [homePage()] }))
    store.setActivePage(HOME_ID)
    store.loadBoards({ version: 1, boards: [{ id: 'b1', name: 'Board 1', frames: [], notes: [], docs: [] }] })
    store.setCanvasLayers([{ layerId: LAYER_ID, pageId: PAGE_ID, page: layerPage('Text') }])
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = (typeof input === 'string' ? input : input.toString()).split('?')[0]
      if (path === '/admin/api/studio/save') {
        const call: { edits: Record<string, unknown>[] } = init?.body ? JSON.parse(String(init.body)) : { edits: [] }
        saveCalls.push(call)
        const text = call.edits[0]?.text
        if (typeof text === 'string' && answerWritten > 0) lastText = text
        return new Response(
          JSON.stringify({
            ok: true,
            written: answerWritten,
            skipped: 0,
            shifted: true,
            sharedComponents: true,
            refusals:
              answerWritten === 0
                ? [{ nodeId: TEXT_ID, kind: 'text', reason: 'write-failed', message: 'no' }]
                : [],
            touchedFiles: [`.studio/canvas/${LAYER_ID}.tsx`],
            createdNodeIds: [],
            relocatedNodeIds: [],
            removed: [],
          }),
          { status: 200 },
        )
      }
      if (path === '/admin/api/studio/reload-scope') {
        return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: [HOME_ID] }), { status: 200 })
      }
      if (path === '/admin/api/studio/load') {
        const meta = {
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
          pageList: [{ id: HOME_ID, slug: '/', title: 'Home' }],
          // What the file holds after the write: the text the last edit set.
          canvasLayers: [{ layerId: LAYER_ID, pageId: PAGE_ID, page: layerPage(lastText) }],
        }
        const lines = [meta, { kind: 'page', page: homePage(), index: 0 }]
        return new Response(lines.map((line) => JSON.stringify(line)).join(String.fromCharCode(10)) + String.fromCharCode(10), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: false }), { status: 500 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
    if (patchListener) window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
    setStudioLoadedDir(null)
    resetStructuralCommitQueue()
    useEditorStore.setState({ activeInlineEdit: null } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.getState().setCanvasLayers([])
    useEditorStore.getState().clearSite()
  })

  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const textProp = () => useEditorStore.getState().canvasLayerPages[PAGE_ID]?.nodes[TEXT_ID]?.props.text

  it('opens a session on the layer root, keyed to the surface breakpoint and the layer page', () => {
    expect(startLayerTextEdit(LAYER_ID, undefined, { selectAll: true })).toBe(true)
    expect(useEditorStore.getState().activeInlineEdit).toMatchObject({
      nodeId: TEXT_ID,
      breakpointId: 'studio',
      frameId: PAGE_ID,
      prop: 'text',
      initialValue: 'Text',
      selectAll: true,
    })
  })

  it('does not open on a layer whose module is not text, or is not loaded', () => {
    expect(startLayerTextEdit('clmissing000')).toBe(false)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('writes nothing per keystroke, one text edit at the end, and one ⌘Z writes the old text back', async () => {
    startLayerTextEdit(LAYER_ID)
    useEditorStore.getState().applyInlineEditValue('Hel')
    useEditorStore.getState().applyInlineEditValue('Hello')
    expect(saveCalls).toHaveLength(0)
    expect(textProp()).toBe('Text')

    useEditorStore.getState().endInlineEdit()
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    // The new text shows at once, before the write is answered.
    expect(textProp()).toBe('Hello')
    await waitFor(() => saveCalls.length === 1)
    expect(saveCalls[0]!.edits).toEqual([{ kind: 'text', nodeId: TEXT_ID, text: 'Hello' }])
    await waitFor(() => useEditorStore.getState().canUndo)

    useEditorStore.getState().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'text', nodeId: TEXT_ID, text: 'Text' }])
  })

  it('an edit that changed nothing posts nothing', async () => {
    startLayerTextEdit(LAYER_ID)
    useEditorStore.getState().applyInlineEditValue('Text')
    useEditorStore.getState().endInlineEdit()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(saveCalls).toHaveLength(0)
  })

  it('Escape leaves the layer as it was', async () => {
    startLayerTextEdit(LAYER_ID)
    useEditorStore.getState().applyInlineEditValue('Nope')
    useEditorStore.getState().cancelInlineEdit()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(saveCalls).toHaveLength(0)
    expect(textProp()).toBe('Text')
  })

  it('a write that does not land puts the old text back', async () => {
    answerWritten = 0
    startLayerTextEdit(LAYER_ID)
    useEditorStore.getState().applyInlineEditValue('Lost')
    useEditorStore.getState().endInlineEdit()
    await waitFor(() => saveCalls.length >= 1)
    await waitFor(() => textProp() === 'Text')
    expect(useEditorStore.getState().canUndo).toBe(false)
  })

  it('a text drawn on the board opens as soon as its module has been read back', () => {
    useEditorStore.getState().setCanvasLayers([])
    whenLayerReady(LAYER_ID, () => startLayerTextEdit(LAYER_ID, undefined, { selectAll: true }))
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    useEditorStore.getState().setCanvasLayers([{ layerId: LAYER_ID, pageId: PAGE_ID, page: layerPage('Text') }])
    expect(useEditorStore.getState().activeInlineEdit).toMatchObject({ nodeId: TEXT_ID, frameId: PAGE_ID, selectAll: true })
  })
})
