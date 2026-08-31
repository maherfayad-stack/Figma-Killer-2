import { afterEach, describe, expect, it } from 'bun:test'
import {
  escapeCssAttributeValue,
  findRenderedCanvasNodeElement,
  RenderedCanvasNodeCache,
} from '@site/canvas/canvasNodeLookup'

afterEach(() => {
  document.body.innerHTML = ''
})

/** Append an iframe whose body is tagged as a canvas breakpoint frame. */
function addCanvasFrame(html: string, breakpointId = 'bp-desktop'): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const frameDoc = frame.contentDocument
  if (!frameDoc) throw new Error('Test iframe did not create a contentDocument')
  frameDoc.body.setAttribute('data-breakpoint-id', breakpointId)
  frameDoc.body.innerHTML = html
  return frame
}

describe('findRenderedCanvasNodeElement', () => {
  it('resolves the node inside a canvas breakpoint frame', () => {
    addCanvasFrame('<h1 data-node-id="title" class="title"></h1>')

    const el = findRenderedCanvasNodeElement('title')

    expect(el).not.toBeNull()
    expect(el?.tagName).toBe('H1')
    expect(el?.ownerDocument.body.getAttribute('data-breakpoint-id')).toBe('bp-desktop')
  })

  it('never resolves admin-document elements carrying the same data-node-id', () => {
    // The DOM panel's tree rows, the Import-HTML preview rows, and the
    // selection/hover overlay rings all render `data-node-id` into the ADMIN
    // document. None of them are the rendered node.
    const treeRow = document.createElement('div')
    treeRow.setAttribute('data-node-id', 'title')
    document.body.appendChild(treeRow)

    expect(findRenderedCanvasNodeElement('title')).toBeNull()

    addCanvasFrame('<h1 data-node-id="title"></h1>')
    const el = findRenderedCanvasNodeElement('title')
    expect(el?.tagName).toBe('H1')
    expect(el).not.toBe(treeRow)
  })

  it('ignores iframes that are not canvas breakpoint frames', () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const frameDoc = frame.contentDocument
    if (!frameDoc) throw new Error('Test iframe did not create a contentDocument')
    // No data-breakpoint-id on the body — e.g. a plugin or preview iframe.
    frameDoc.body.innerHTML = '<div data-node-id="title"></div>'

    expect(findRenderedCanvasNodeElement('title')).toBeNull()
  })

  it('returns null when the node is rendered nowhere', () => {
    addCanvasFrame('<h1 data-node-id="other"></h1>')
    expect(findRenderedCanvasNodeElement('title')).toBeNull()
  })

  it('escapes quotes and backslashes in the node id', () => {
    expect(escapeCssAttributeValue('a"b\\c')).toBe('a\\"b\\\\c')
    // Must not throw on a hostile id.
    expect(findRenderedCanvasNodeElement('a"b\\c')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// RenderedCanvasNodeCache — perf-01
//
// The properties/inspect panels re-run this lookup once per KEYSTROKE that
// edits the selected node's style (`useInspectComputedStyle.ts`). Before this
// cache, every one of those renders redid the FULL scan `findRenderedCanvasNodes`
// does: `document.querySelectorAll('iframe')` over the admin document, then a
// cross-document `querySelector` inside EACH breakpoint frame's own page. These
// tests spy on the frame document's `querySelector` to prove that inner,
// per-frame scan collapses to one call while the resolved element stays
// connected, and self-heals the moment it doesn't.
// ---------------------------------------------------------------------------

/** Wraps `frameDoc.querySelector` with a call counter, in place. */
function spyOnQuerySelector(frameDoc: Document): () => number {
  let queries = 0
  const original = frameDoc.querySelector.bind(frameDoc)
  frameDoc.querySelector = ((selector: string) => {
    queries++
    return original(selector)
  }) as typeof frameDoc.querySelector
  return () => queries
}

describe('RenderedCanvasNodeCache', () => {
  it('queries the frame document once per node while the element stays connected', () => {
    const frame = addCanvasFrame('<h1 data-node-id="title"></h1>')
    const queries = spyOnQuerySelector(frame.contentDocument!)
    const cache = new RenderedCanvasNodeCache()

    // 20 "keystrokes" worth of re-renders for the same node.
    for (let i = 0; i < 20; i++) {
      const rendered = cache.resolve('title')
      expect(rendered).toHaveLength(1)
      expect(rendered[0]!.element.tagName).toBe('H1')
    }

    expect(queries()).toBe(1)
  })

  it('self-heals when the cached element is unmounted (a real re-render, not an attribute tweak)', () => {
    const frame = addCanvasFrame('<h1 data-node-id="title"></h1>')
    const cache = new RenderedCanvasNodeCache()

    const first = cache.resolve('title')[0]!.element
    expect(first.tagName).toBe('H1')
    expect(first.isConnected).toBe(true)

    // The canvas app re-renders the node as a different element — the old
    // one is now detached, which is exactly what `.isConnected` catches.
    frame.contentDocument!.body.innerHTML = '<span data-node-id="title"></span>'

    const second = cache.resolve('title')[0]!.element
    expect(second.tagName).toBe('SPAN')
    expect(second).not.toBe(first)
  })

  it('re-scans when a breakpoint frame is opened or closed', () => {
    addCanvasFrame('<h1 data-node-id="title"></h1>', 'bp-desktop')
    const cache = new RenderedCanvasNodeCache()
    expect(cache.resolve('title')).toHaveLength(1)

    // A second breakpoint preview opens, also rendering the same node.
    addCanvasFrame('<h1 data-node-id="title"></h1>', 'bp-tablet')
    expect(cache.resolve('title')).toHaveLength(2)
  })

  it('retainOnly evicts everything except the given node ids without breaking future lookups', () => {
    addCanvasFrame('<h1 data-node-id="a"></h1><h2 data-node-id="b"></h2>')
    const cache = new RenderedCanvasNodeCache()
    cache.resolve('a')
    cache.resolve('b')

    cache.retainOnly(new Set(['a']))

    // 'b' was evicted, not corrupted — resolving it still works (a fresh
    // scan, not a stale miss).
    expect(cache.resolve('b')).toHaveLength(1)
    expect(cache.resolve('a')).toHaveLength(1)
  })

  it('returns an empty list, not a stale cached one, once the node renders nowhere', () => {
    const frame = addCanvasFrame('<h1 data-node-id="title"></h1>')
    const cache = new RenderedCanvasNodeCache()
    expect(cache.resolve('title')).toHaveLength(1)

    frame.contentDocument!.body.innerHTML = ''
    expect(cache.resolve('title')).toHaveLength(0)
  })
})
