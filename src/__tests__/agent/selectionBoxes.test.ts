/**
 * AI-9 — the selection's box is measured in the canvas frame that draws it,
 * body-relative, and a frame the admin page cannot read is skipped rather
 * than guessed at.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { measureSelectionBoxes } from '@site/agent/selectionBoxes'

const registered: HTMLIFrameElement[] = []

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect
}

/** A readable frame whose body sits at (10, 20) and holds the given node boxes (viewport space). */
function readableFrame(nodes: Record<string, DOMRect>): HTMLIFrameElement {
  const doc = document.implementation.createHTMLDocument('frame')
  doc.body.getBoundingClientRect = () => rect(10, 20, 393, 852)
  for (const [nodeId, box] of Object.entries(nodes)) {
    const el = doc.createElement('div')
    el.setAttribute('data-node-id', nodeId)
    el.getBoundingClientRect = () => box
    doc.body.appendChild(el)
  }
  const iframe = { contentDocument: doc } as unknown as HTMLIFrameElement
  Object.defineProperty(doc, 'defaultView', { value: window })
  registerFrameAdapter(iframe, {} as FrameDocumentAdapter, 'bp')
  registered.push(iframe)
  return iframe
}

function crossOriginFrame(): void {
  const iframe = {} as HTMLIFrameElement
  Object.defineProperty(iframe, 'contentDocument', { get: () => { throw new Error('SecurityError: cross-origin') } })
  registerFrameAdapter(iframe, {} as FrameDocumentAdapter, 'bp-live')
  registered.push(iframe)
}

afterEach(() => {
  for (const iframe of registered.splice(0)) unregisterFrameAdapter(iframe)
})

describe('measureSelectionBoxes', () => {
  it('measures each node body-relative in the frame that draws it, skipping a cross-origin frame', () => {
    crossOriginFrame()
    readableFrame({ 'pages/A.tsx:7:8': rect(34, 660, 345, 48) })
    const boxes = measureSelectionBoxes(['pages/A.tsx:7:8', 'pages/A.tsx:99:1'])
    expect(boxes.get('pages/A.tsx:7:8')).toEqual({ x: 24, y: 640, width: 345, height: 48 })
    // Drawn nowhere readable: no box, never an invented one.
    expect(boxes.has('pages/A.tsx:99:1')).toBe(false)
  })

  it('a selector the DOM rejects costs that node its box, never the message being sent', () => {
    readableFrame({ 'pages/A.tsx:1:1': rect(10, 20, 5, 5) })
    // happy-dom rejects the escaped quote a browser accepts; either way the
    // measurement must not throw, and the other node still gets its box.
    const boxes = measureSelectionBoxes(['pages/A"b.tsx:1:1', 'pages/A.tsx:1:1'])
    expect(boxes.get('pages/A.tsx:1:1')).toEqual({ x: 0, y: 0, width: 5, height: 5 })
  })
})
