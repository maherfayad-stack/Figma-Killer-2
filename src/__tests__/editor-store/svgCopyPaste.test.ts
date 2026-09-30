/**
 * Owner report: an SVG "can't paste in any file" — a "What you copied is not in
 * your project's code any more" toast.
 *
 *   - ⌘C on a loose layer (a vector drawn with the pen on the empty board)
 *     copied nothing, so ⌘V pasted an EARLIER clipboard entry; now it copies
 *     the layer's root, and the paste finds it in `canvasLayerPages` and writes
 *     the free canvas's own `canvas-layer-place` with `copy` (the root of a
 *     module has no siblings, so the frame transplant cannot read it);
 *   - the refusal names what the copy WAS and which of two facts holds — never
 *     written in the code, or no longer where the copy said.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import type { Page, PageNode } from '@core/page-tree'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { resetSourceIdentities } from '@site/studio/sourceIdentity'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { missingPasteSourceMessage } from '@site/store/slices/site/studioPasteWrites'

const ABOUT = 'pages/About.tsx'
const ABOUT_MAIN = `${ABOUT}:3:5`
const H1 = `${ABOUT}:4:7`
const LAYER_ID = 'claaaaaaaaaa'
const LAYER_SVG = `.studio/canvas/${LAYER_ID}.tsx:6:5`

function el(id: string, parentId: string | undefined, children: string[] = [], extra: Partial<PageNode> = {}): PageNode {
  return {
    id,
    moduleId: children.length > 0 ? 'base.container' : 'base.text',
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
    ...(parentId ? { parentId } : {}),
    ...extra,
  }
}

const about = (): Page =>
  makePage({
    id: 'about',
    rootNodeId: 'about:body',
    nodes: Object.fromEntries(
      [el('about:body', undefined, [ABOUT_MAIN]), el(ABOUT_MAIN, 'about:body', [H1]), el(H1, ABOUT_MAIN, [], { props: { text: 'About', tag: 'h1' } })].map((n) => [n.id, n]),
    ),
  })

const layerPage = (): Page =>
  makePage({
    id: `canvas:${LAYER_ID}`,
    rootNodeId: `canvas:${LAYER_ID}:body`,
    nodes: {
      [`canvas:${LAYER_ID}:body`]: el(`canvas:${LAYER_ID}:body`, undefined, [LAYER_SVG]),
      [LAYER_SVG]: el(LAYER_SVG, `canvas:${LAYER_ID}:body`, [], {
        moduleId: 'base.svg',
        props: { svg: '<svg fill="none" stroke="currentColor"><path data-studio-svg-part="7:7" d="M0 0L1 1"/></svg>', tag: '' },
      }),
    },
  })

const store = () => useEditorStore.getState()
let posted: Record<string, unknown>[][]
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
      posted.push(body.edits ?? [])
      return new Response(
        JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [ABOUT], createdNodeIds: [], removed: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  useEditorStore.setState({ site: null, activePageId: null, clipboardEntry: null, selectedNodeId: null, selectedNodeIds: [], selectedCanvasLayerIds: [] })
  store().loadSite(makeSite({ pages: [about()] }))
  store().setCanvasLayers([{ layerId: LAYER_ID, pageId: `canvas:${LAYER_ID}`, page: layerPage() }])
  store().setActivePage('about')
})

afterEach(() => {
  globalThis.fetch = realFetch
})

async function settle() {
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 200 && isStructuralCommitInFlight(); i++) await new Promise((r) => setTimeout(r, 1))
  }
}

function toasts(): Toast[] {
  let snapshot: Toast[] = []
  subscribeToasts((next) => {
    snapshot = next
  })()
  return snapshot
}

describe('copying a loose layer', () => {
  it('⌘C copies the layer root, replacing whatever an earlier copy left', () => {
    expect(store().copyNode(H1)).toBe(true)
    expect(store().copyCanvasLayers([LAYER_ID])).toBe(true)
    expect(store().clipboardEntry?.rootNodeIds).toEqual([LAYER_SVG])
    expect(store().clipboardEntry?.nodes[LAYER_SVG]?.moduleId).toBe('base.svg')
  })

  it('an unknown layer copies nothing and leaves the clipboard alone', () => {
    expect(store().copyNode(H1)).toBe(true)
    expect(store().copyCanvasLayers(['clzzzzzzzzzz'])).toBe(false)
    expect(store().clipboardEntry?.rootNodeIds).toEqual([H1])
  })

  it('⌘V into a frame writes the free canvas’s own copy — canvas-layer-place with copy — never a toast', async () => {
    store().copyCanvasLayers([LAYER_ID])
    store().pasteNode(H1, 'after')
    await settle()
    expect(toasts().filter((toast) => toast.kind === 'warning')).toEqual([])
    expect(posted[0]).toEqual([
      expect.objectContaining({ kind: 'canvas-layer-place', nodeId: LAYER_SVG, layerId: LAYER_ID, parentNodeId: ABOUT_MAIN, copy: true }),
    ])
  })
})

describe('a paste with no source says which fact holds', () => {
  it('a copy whose file changed since: "not where it was", naming the element', () => {
    const stale = `${ABOUT}:40:7`
    useEditorStore.setState({
      clipboardEntry: {
        rootNodeIds: [stale],
        nodes: { [stale]: el(stale, ABOUT_MAIN, [], { props: { text: 'Gone', tag: 'h2' }, sourceFingerprint: 'h2#00000000' }) },
        classes: {},
        copiedAt: 1,
      },
    })
    store().pasteNode(H1, 'after')
    const warning = toasts().find((toast) => toast.kind === 'warning')
    expect(warning?.title).toBe('Cannot add this to imported code')
    expect(warning?.body).toBe(missingPasteSourceMessage('gone', { ...el(stale, ABOUT_MAIN), props: { tag: 'h2' } }))
    expect(warning?.body).toContain('What you copied (<h2>) is not where it was')
    expect(posted).toEqual([])
  })

  it('an element with no place in the code: "drawn by code", not "any more"', () => {
    expect(missingPasteSourceMessage('not-source', el('n1', undefined))).toContain('is not an element written in this project')
  })

  it('names a bare <svg> as an <svg>, though its `tag` is empty', () => {
    expect(missingPasteSourceMessage('gone', el('x', undefined, [], { moduleId: 'base.svg', props: { svg: '<svg/>', tag: '' } }))).toContain(
      'What you copied (<svg>)',
    )
  })
})
