/**
 * The in-frame marquee's trigger (IX-16, OD-6) and the inline-edit hand-off.
 *
 *   - a press on the frame's BACKGROUND that travels sweeps a marquee. The
 *     background is the page `<body>` OR the screen element itself (the page
 *     component's own root, the root's only child) — in a real project nearly
 *     every pixel of an empty frame is the screen, so triggering only on the
 *     synthetic body made the marquee unreachable;
 *   - a press on a layer inside the screen is never a marquee (it is a move);
 *   - a press OUTSIDE an inline text edit ends that edit and is then an
 *     ordinary press: the drag right after a double-click edit used to be
 *     eaten by "an edit is active", because the blur that ends it arrives
 *     after the press was judged.
 *
 * Layout is the e2e's; here the candidates have no boxes, so what is asserted
 * is that the gesture STARTS (its chrome appears) and what the edit does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useInFrameMarquee } from '@site/canvas/useInFrameMarquee'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

let overlayRoot: HTMLElement

function seed() {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'body',
    nodes: {
      body: makeNode({ id: 'body', moduleId: 'base.body', children: ['screen'] }),
      screen: makeNode({ id: 'screen', moduleId: 'base.container', children: ['card', 'title'] }),
      card: makeNode({ id: 'card', moduleId: 'base.container' }),
      title: makeNode({ id: 'title', moduleId: 'base.text', props: { text: 'Hello', tag: 'p' } }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    activeInlineEdit: null,
    canvasTool: 'move',
  } as Parameters<typeof useEditorStore.setState>[0])

  document.body.innerHTML = `
    <div data-node-id="body">
      <div data-node-id="screen">
        <div data-node-id="card"></div>
        <p data-node-id="title" contenteditable="plaintext-only">Hello</p>
      </div>
      <div id="overlay"></div>
    </div>`
  overlayRoot = document.getElementById('overlay')!
}

function pointer(type: string, target: Element, init: { clientX: number; clientY: number }) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...init }))
}

function sweep(target: Element) {
  pointer('pointerdown', target, { clientX: 10, clientY: 10 })
  pointer('pointermove', document.body, { clientX: 80, clientY: 80 })
}

beforeEach(seed)
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  useEditorStore.setState({ activeInlineEdit: null } as Parameters<typeof useEditorStore.setState>[0])
})

describe('useInFrameMarquee trigger', () => {
  it('a travelling press on the screen element itself starts a marquee', () => {
    renderHook(() => useInFrameMarquee({ enabled: true, frameDocument: document, chromeRoot: overlayRoot, frameId: null }))
    sweep(document.querySelector('[data-node-id="screen"]')!)
    expect(overlayRoot.querySelector('[data-canvas-in-frame-marquee]')).not.toBeNull()
  })

  it('a travelling press on the page body starts a marquee', () => {
    renderHook(() => useInFrameMarquee({ enabled: true, frameDocument: document, chromeRoot: overlayRoot, frameId: null }))
    sweep(document.querySelector('[data-node-id="body"]')!)
    expect(overlayRoot.querySelector('[data-canvas-in-frame-marquee]')).not.toBeNull()
  })

  it('a press on a layer inside the screen is a move, never a marquee', () => {
    renderHook(() => useInFrameMarquee({ enabled: true, frameDocument: document, chromeRoot: overlayRoot, frameId: null }))
    sweep(document.querySelector('[data-node-id="card"]')!)
    expect(overlayRoot.querySelector('[data-canvas-in-frame-marquee]')).toBeNull()
  })
})

describe('a press while an inline text edit is open', () => {
  function startEdit() {
    expect(useEditorStore.getState().startInlineEdit('title', 'desktop')).toBe(true)
  }

  it('outside the editor: the edit ends and the press carries on as a marquee', () => {
    renderHook(() => useInFrameMarquee({ enabled: true, frameDocument: document, chromeRoot: overlayRoot, frameId: null }))
    startEdit()
    sweep(document.querySelector('[data-node-id="screen"]')!)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(overlayRoot.querySelector('[data-canvas-in-frame-marquee]')).not.toBeNull()
  })

  it('inside the editor: the edit stays open and nothing sweeps (the press selects text)', () => {
    renderHook(() => useInFrameMarquee({ enabled: true, frameDocument: document, chromeRoot: overlayRoot, frameId: null }))
    startEdit()
    sweep(document.querySelector('[data-node-id="title"]')!)
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
    expect(overlayRoot.querySelector('[data-canvas-in-frame-marquee]')).toBeNull()
  })
})
