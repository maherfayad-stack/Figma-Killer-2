/**
 * `sec-17` — the one failure mode that destroys an editing session.
 *
 * A design frame's document is a portal the editor has a React root inside.
 * The browser's default for an uncancelled drop is to NAVIGATE the document
 * that received it, which tears that root out: drop a file and the frame is a
 * bare image, drop a link and the frame is an attacker-chosen page rendered
 * inside the editor's own chrome.
 *
 * D2 G15 cancelled that default for drags carrying FILES. It did not cancel it
 * for anything else — and `text/uri-list` (a link, a bookmark, an image
 * dragged out of another tab) is both the easiest drag to perform by accident
 * and the one with the worse outcome. These tests drive the non-file drag,
 * which is the case that was open.
 *
 * `DragEvent`/`DataTransfer` do not exist under happy-dom, so the drags are
 * built as plain cancelable `Event`s carrying a `dataTransfer` — the only
 * three members the relay reads are `types`, `clientX/Y` and `preventDefault`.
 */
import { describe, expect, it } from 'bun:test'
import { installFrameDragRelay } from '@site/canvas/canvasFrameDragRelay'

function frameDoc(): Document {
  return document.implementation.createHTMLDocument('frame')
}

/** A stand-in for the iframe ELEMENT in the parent document. */
function iframeElement(): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0 }) as DOMRect
  Object.defineProperty(iframe, 'clientWidth', { value: 400, configurable: true })
  Object.defineProperty(iframe, 'clientHeight', { value: 300, configurable: true })
  return iframe
}

function drag(type: 'dragover' | 'drop', types: readonly string[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types, files: [] } })
  Object.defineProperty(event, 'clientX', { value: 10 })
  Object.defineProperty(event, 'clientY', { value: 10 })
  return event
}

describe('installFrameDragRelay — the frame must never navigate', () => {
  it('cancels a dropped LINK inside the frame, so the browser does not load it there', () => {
    const doc = frameDoc()
    const teardown = installFrameDragRelay(doc, iframeElement())

    for (const type of ['dragover', 'drop'] as const) {
      const event = drag(type, ['text/uri-list', 'text/plain'])
      doc.body.dispatchEvent(event)
      expect({ type, defaultPrevented: event.defaultPrevented }).toEqual({ type, defaultPrevented: true })
    }

    teardown()
  })

  it('cancels a drag carrying nothing the board understands', () => {
    const doc = frameDoc()
    const teardown = installFrameDragRelay(doc, iframeElement())

    const event = drag('drop', [])
    doc.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    teardown()
  })

  it('does NOT relay a drag carrying neither files nor a link — cancelling is the whole answer', () => {
    const doc = frameDoc()
    const iframe = iframeElement()
    let relayed = 0
    iframe.addEventListener('drop', () => {
      relayed += 1
    })
    const teardown = installFrameDragRelay(doc, iframe)

    // Selected text dragged into a frame: plain text, no link.
    const event = drag('drop', ['text/plain', 'text/html'])
    doc.body.dispatchEvent(event)
    expect(relayed).toBe(0)
    expect(event.defaultPrevented).toBe(true)

    teardown()
  })

  it('P5-B3 (IMG-5) — relays a LINK drop to the board, still cancelled in the frame', () => {
    // The board's intake reads the link at drop and refuses anything that is
    // not an http(s) or data:image image, without a request
    // (`canvasDropIntake.ts`); the frame itself never navigates either way.
    withFakeDragEvent(() => {
      const doc = frameDoc()
      const iframe = iframeElement()
      let relayed = 0
      iframe.addEventListener('drop', () => {
        relayed += 1
      })
      const teardown = installFrameDragRelay(doc, iframe)

      const event = drag('drop', ['text/uri-list', 'text/html'])
      doc.body.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(relayed).toBe(1)

      teardown()
    })
  })

  it('stops cancelling once torn down', () => {
    const doc = frameDoc()
    installFrameDragRelay(doc, iframeElement())()

    const event = drag('drop', ['text/uri-list'])
    doc.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

/** happy-dom has no DragEvent; a MouseEvent carrying the transfer is the shape the relay builds. */
function withFakeDragEvent(run: () => void): void {
  const saved = (globalThis as { DragEvent?: unknown }).DragEvent
  class FakeDragEvent extends MouseEvent {
    readonly dataTransfer: unknown
    constructor(type: string, init: MouseEventInit & { dataTransfer?: unknown }) {
      super(type, init)
      this.dataTransfer = init.dataTransfer ?? null
    }
  }
  ;(globalThis as { DragEvent?: unknown }).DragEvent = FakeDragEvent
  try {
    run()
  } finally {
    ;(globalThis as { DragEvent?: unknown }).DragEvent = saved
  }
}

describe('installFrameDragRelay — the relayed file drag keeps its keys (P5-B)', () => {
  it('carries alt/shift/meta/ctrl across the iframe boundary, because they change what the drop means', () => {
    withFakeDragEvent(() => {
      const doc = frameDoc()
      const iframe = iframeElement()
      const seen: { alt: boolean; shift: boolean; meta: boolean; ctrl: boolean }[] = []
      iframe.addEventListener('drop', (event) => {
        const relayed = event as MouseEvent
        seen.push({ alt: relayed.altKey, shift: relayed.shiftKey, meta: relayed.metaKey, ctrl: relayed.ctrlKey })
      })
      const teardown = installFrameDragRelay(doc, iframe)

      const event = drag('drop', ['Files'])
      Object.defineProperty(event, 'altKey', { value: true })
      Object.defineProperty(event, 'shiftKey', { value: false })
      Object.defineProperty(event, 'metaKey', { value: true })
      Object.defineProperty(event, 'ctrlKey', { value: false })
      doc.body.dispatchEvent(event)

      expect(seen).toEqual([{ alt: true, shift: false, meta: true, ctrl: false }])
      teardown()
    })
  })
})
