/**
 * P5-A — ⌘C / ⌘V driven by the browser's clipboard EVENTS
 * (`canvasClipboardBridge.ts`, `canvasPaste.ts`, `useCanvasClipboardBridge.ts`).
 *
 * The regression this bundle exists for: ⌘V's keydown called
 * `preventDefault()`, which cancels the paste itself, so no `paste` event
 * ever fired and an image or SVG on the OS clipboard could not be read. The
 * keydown now only ARMS the paste; the event that follows carries the data
 * and one decision picks layers / SVG / image. When no event comes (Safari,
 * a cross-origin frame) a fallback reads the async Clipboard API.
 *
 * The store actions each branch ends in are replaced by recorders here: what
 * THOSE do (the asset landing, the insert, P3-D's source paste) has its own
 * tests. These pin which one ⌘V reaches, with what.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import type { SubtreeInsertRequest } from '@site/store/slices/site/imageDropShapes'
import { isPlatformMac } from '@admin/spotlight/keybindings'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasNodeShortcuts } from '@site/canvas/useCanvasNodeShortcuts'
import { useCanvasClipboardBridge } from '@site/canvas/useCanvasClipboardBridge'
import { armCanvasPaste, installCanvasClipboardBridge } from '@site/canvas/canvasClipboardBridge'
import { relayFrameKeyDown, type FrameKeyInit } from '@site/canvas/canvasFrameKeyRelay'
import { STUDIO_NODES_MIME, studioMarkerHtml } from '@site/canvas/canvasClipboardData'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const MAIN = 'main'
const A = 'a'
const B = 'b'

type Store = ReturnType<typeof useEditorStore.getState>
const calls = {
  pasteNode: [] as Parameters<Store['pasteNode']>[],
  dropImagesIntoPage: [] as Parameters<Store['dropImagesIntoPage']>[],
  insertJsxSubtreeIntoPage: [] as SubtreeInsertRequest[],
}
let originals: Pick<Store, 'pasteNode' | 'dropImagesIntoPage' | 'insertJsxSubtreeIntoPage'>
let toasts: Toast[] = []
let unsubscribeToasts: () => void
const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const realClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem

function seed(): void {
  const page = makePage({
    id: 'home',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [MAIN] }),
      [MAIN]: makeNode({ id: MAIN, moduleId: 'base.container', parentId: 'root', children: [A, B] }),
      [A]: makeNode({ id: A, moduleId: 'base.container', parentId: MAIN }),
      [B]: makeNode({ id: B, moduleId: 'base.container', parentId: MAIN }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'home',
    activeDocument: null,
    selectedNodeId: A,
    selectedNodeIds: [A],
    activeInlineEdit: null,
    clipboardEntry: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function Harness() {
  useEditorKeyDispatcher()
  useCanvasNodeShortcuts({ editable: true, isLive: false, requestDeleteNode: () => {} })
  useCanvasClipboardBridge({ editable: true, isLive: false })
  return null
}

const mod = isPlatformMac() ? { metaKey: true } : { ctrlKey: true }

/**
 * Marks a hand-built event as the browser's own. happy-dom lets a test define
 * `isTrusted`; a browser does not (it is unforgeable), which is exactly the
 * property the bridge leans on (review #270, N1/N2).
 */
function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, 'isTrusted', { value: true })
  return event
}

/** A real keystroke on the editor's own document. */
function press(key: 'c' | 'v', target: EventTarget = document.body): KeyboardEvent {
  const event = trusted(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...mod }))
  target.dispatchEvent(event)
  return event
}

const V_KEY: FrameKeyInit = { key: 'v', code: 'KeyV', location: 0, repeat: false, ctrlKey: !isPlatformMac(), shiftKey: false, altKey: false, metaKey: isPlatformMac() }

/** A `DataTransfer` stand-in: what the reader touches, and a `setData` recorder for copy. */
function dataTransfer(data: Record<string, string> = {}, files: File[] = []): DataTransfer {
  return {
    getData: (type: string) => data[type] ?? '',
    setData: (type: string, value: string) => {
      data[type] = value
    },
    files,
  } as unknown as DataTransfer
}

function clipboardEvent(type: 'paste' | 'copy', data: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: data })
  return event
}

function paste(data: Record<string, string>, files: File[] = [], target: EventTarget = document.body): Event {
  const event = trusted(clipboardEvent('paste', dataTransfer(data, files)))
  target.dispatchEvent(event)
  return event
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function stubAsyncClipboard(clipboard: Partial<Clipboard>): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
}

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' })
const COPIED_AT = 1_727_000_000_000

beforeEach(() => {
  seed()
  const state = useEditorStore.getState()
  originals = {
    pasteNode: state.pasteNode,
    dropImagesIntoPage: state.dropImagesIntoPage,
    insertJsxSubtreeIntoPage: state.insertJsxSubtreeIntoPage,
  }
  calls.pasteNode = []
  calls.dropImagesIntoPage = []
  calls.insertJsxSubtreeIntoPage = []
  useEditorStore.setState({
    pasteNode: (...args: Parameters<Store['pasteNode']>) => {
      calls.pasteNode.push(args)
      return null
    },
    dropImagesIntoPage: (...args: Parameters<Store['dropImagesIntoPage']>) => {
      calls.dropImagesIntoPage.push(args)
    },
    insertJsxSubtreeIntoPage: (request: SubtreeInsertRequest) => {
      calls.insertJsxSubtreeIntoPage.push(request)
    },
  } as Parameters<typeof useEditorStore.setState>[0])
  __resetToastBusForTests()
  toasts = []
  unsubscribeToasts = subscribeToasts((next) => {
    toasts = [...next]
  })
  // No async clipboard unless a test provides one: the fallback reads "unreadable".
  stubAsyncClipboard({})
  render(<Harness />)
})

afterEach(async () => {
  cleanup()
  await settle()
  unsubscribeToasts()
  useEditorStore.setState(originals as Parameters<typeof useEditorStore.setState>[0])
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
  ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = realClipboardItem
})

describe('⌘V — armed by the keydown, answered by the paste event', () => {
  it('REGRESSION: the keydown is NOT cancelled (that cancelled the paste event itself) and pastes nothing on its own', () => {
    const keydown = press('v')
    expect(keydown.defaultPrevented).toBe(false)
    expect(calls.pasteNode).toEqual([])
  })

  it('a clipboard carrying this editor’s marker pastes the copied layers beside the selection — once', async () => {
    useEditorStore.setState({ clipboardEntry: { rootNodeIds: [B], nodes: {}, classes: {}, copiedAt: COPIED_AT } } as Parameters<typeof useEditorStore.setState>[0])
    press('v')
    const event = paste({ [STUDIO_NODES_MIME]: String(COPIED_AT), 'text/plain': '' }, [png()])
    expect(event.defaultPrevented).toBe(true)
    await settle()
    // The paste event answered it; the keydown fallback must not paste a second time.
    expect(calls.pasteNode).toEqual([[A, 'after']])
    expect(calls.dropImagesIntoPage).toEqual([])
  })

  it('an image with no marker lands through the file drop’s own insert, after the selection', () => {
    useEditorStore.setState({ clipboardEntry: { rootNodeIds: [B], nodes: {}, classes: {}, copiedAt: COPIED_AT } } as Parameters<typeof useEditorStore.setState>[0])
    const image = png()
    press('v')
    paste({}, [image])
    expect(calls.pasteNode).toEqual([])
    expect(calls.dropImagesIntoPage).toHaveLength(1)
    const [drop] = calls.dropImagesIntoPage[0]!
    expect({ pageId: drop.pageId, parentId: drop.parentId, index: drop.index, files: drop.files, absolute: drop.absolute }).toEqual({
      pageId: 'home',
      parentId: MAIN,
      index: 1,
      files: [image],
      absolute: null,
    })
  })

  it('with nothing selected, an image goes to the end of the active frame’s root', () => {
    useEditorStore.setState({ selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
    paste({}, [png()])
    const [drop] = calls.dropImagesIntoPage[0]!
    expect([drop.parentId, drop.index]).toEqual(['root', 1])
  })

  it('a paste raised in a FRAME document reaches the same bridge', () => {
    const frameDoc = document.implementation.createHTMLDocument('frame')
    const uninstall = installCanvasClipboardBridge(frameDoc)
    try {
      paste({}, [png()], frameDoc.body)
      expect(calls.dropImagesIntoPage).toHaveLength(1)
    } finally {
      uninstall()
    }
  })
})

describe('⌘V of SVG text — sanitised, then ONE subtree insert', () => {
  it('writes the converted subtree beside the selection, with nothing executable in it', async () => {
    paste({
      'text/plain':
        // The <script> goes LAST: happy-dom's HTML parser swallows whatever
        // follows one inside <svg>, where a browser does not.
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)"><path d="M0 0h24v24H0z" onclick="alert(3)" fill="#f00"/><script>alert(2)</script></svg>',
    })
    await settle()
    expect(calls.insertJsxSubtreeIntoPage).toHaveLength(1)
    const request = calls.insertJsxSubtreeIntoPage[0]!
    expect([request.pageId, request.parentId, request.index, request.undoLabel]).toEqual(['home', MAIN, 1, 'Paste SVG'])
    expect(request.node.name).toBe('svg')
    expect(request.node.props?.viewBox).toBe('0 0 24 24')
    const written = JSON.stringify(request.node)
    expect(written).toContain('M0 0h24v24H0z')
    expect(written).not.toMatch(/script|onload|onclick|alert/i)
  })

  it('a remote reference never reaches the source (P5-D part 1’s sanitizer drops it before conversion)', async () => {
    paste({ 'text/plain': '<svg viewBox="0 0 1 1"><rect width="1" height="1" fill="url(https://tracker.example/x.svg#p)" style="background:url(//tracker.example/b)"/></svg>' })
    await settle()
    expect(calls.insertJsxSubtreeIntoPage).toHaveLength(1)
    expect(JSON.stringify(calls.insertJsxSubtreeIntoPage[0]!.node)).not.toContain('tracker')
  })

  it('markup that is not a usable SVG refuses with a sentence, and writes nothing anywhere', async () => {
    // Shaped like an svg document, but sanitises to no svg element at all.
    paste({ 'text/plain': '<svg/><p>not an svg</p><svg/>' })
    await settle()
    expect(calls.insertJsxSubtreeIntoPage).toEqual([])
    expect(calls.dropImagesIntoPage).toEqual([])
    expect(toasts.map((toast) => toast.title)).toContain('Cannot paste that SVG')
  })

  it('N4 — an oversized SVG FILE goes to the file route without being read', async () => {
    let read = false
    class UnreadFile extends File {
      override text(): Promise<string> {
        read = true
        return super.text()
      }
    }
    const big = new UnreadFile(['<svg>' + ' '.repeat(70 * 1024) + '</svg>'], 'huge.svg', { type: 'image/svg+xml' })
    paste({}, [big])
    await settle()
    expect(read).toBe(false)
    expect(calls.dropImagesIntoPage[0]![0].files).toEqual([big])
  })

  it('an SVG too large to inline lands as an image FILE through the drop path instead', async () => {
    const parts = Array.from({ length: 300 }, (_, i) => `<rect x="${i}" width="1" height="1"/>`).join('')
    paste({ 'text/plain': `<svg viewBox="0 0 300 1">${parts}</svg>` })
    await settle()
    expect(calls.insertJsxSubtreeIntoPage).toEqual([])
    expect(calls.dropImagesIntoPage).toHaveLength(1)
    const [file] = calls.dropImagesIntoPage[0]![0].files
    expect([file!.name, file!.type]).toEqual(['pasted.svg', 'image/svg+xml'])
    expect(toasts.map((toast) => toast.title)).toContain('Large SVG added as an image')
  })
})

describe('when no paste event comes (Safari, a cross-origin frame)', () => {
  it('the keydown fallback reads the async Clipboard API', async () => {
    stubAsyncClipboard({
      read: async () => [{ types: ['image/png'], getType: async () => new Blob([new Uint8Array([0x89])], { type: 'image/png' }) }] as unknown as ClipboardItems,
    })
    press('v')
    await settle()
    expect(calls.dropImagesIntoPage).toHaveLength(1)
    expect(calls.dropImagesIntoPage[0]![0].files[0]!.type).toBe('image/png')
  })

  it('an unreadable clipboard falls back to the copied layers — what ⌘V did before', async () => {
    useEditorStore.setState({ clipboardEntry: { rootNodeIds: [B], nodes: {}, classes: {}, copiedAt: COPIED_AT } } as Parameters<typeof useEditorStore.setState>[0])
    stubAsyncClipboard({
      read: async () => {
        throw new DOMException('denied', 'NotAllowedError')
      },
    })
    press('v')
    await settle()
    expect(calls.pasteNode).toEqual([[A, 'after']])
  })
})

describe('only a real keystroke may read the OS clipboard (review #270)', () => {
  let reads = 0
  beforeEach(() => {
    reads = 0
    stubAsyncClipboard({
      read: async () => {
        reads += 1
        return [{ types: ['image/png'], getType: async () => new Blob([new Uint8Array([0x89])], { type: 'image/png' }) }] as unknown as ClipboardItems
      },
    })
    useEditorStore.setState({ clipboardEntry: { rootNodeIds: [B], nodes: {}, classes: {}, copiedAt: COPIED_AT } } as Parameters<typeof useEditorStore.setState>[0])
  })

  it('N1 — a ⌘V `key` message a Tier 2 frame posted (forgeable by project code) never reads the clipboard; it pastes the copied layers', async () => {
    relayFrameKeyDown(document, V_KEY, { userGesture: false })
    await settle()
    expect(reads).toBe(0)
    expect(calls.dropImagesIntoPage).toEqual([])
    expect(calls.pasteNode).toEqual([[A, 'after']])
  })

  it('a synthetic keydown on the editor document is not a gesture either', async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', bubbles: true, cancelable: true, ...mod }))
    await settle()
    expect(reads).toBe(0)
    expect(calls.pasteNode).toEqual([[A, 'after']])
  })

  it('a portal frame’s REAL keystroke, relayed, may take the fallback read', async () => {
    relayFrameKeyDown(document, V_KEY, { userGesture: true })
    await settle()
    expect(reads).toBe(1)
    expect(calls.dropImagesIntoPage).toHaveLength(1)
  })

  it('N2 — a script-dispatched paste event is ignored', () => {
    const event = clipboardEvent('paste', dataTransfer({}, [png()]))
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(calls.dropImagesIntoPage).toEqual([])
  })

  it('N3 — with no canvas mounted, an armed paste never reads the clipboard', async () => {
    cleanup()
    armCanvasPaste()
    await settle()
    expect(reads).toBe(0)
  })
})

describe('pastes that are not the canvas’s', () => {
  it('a paste into a text field is the field’s', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      const event = paste({}, [png()], input)
      expect(event.defaultPrevented).toBe(false)
      expect(calls.dropImagesIntoPage).toEqual([])
    } finally {
      input.remove()
    }
  })

  it('during an inline text edit, the paste is the edit’s', () => {
    useEditorStore.setState({ activeInlineEdit: { nodeId: A } } as unknown as Parameters<typeof useEditorStore.setState>[0])
    const event = paste({}, [png()])
    expect(event.defaultPrevented).toBe(false)
    expect(calls.dropImagesIntoPage).toEqual([])
  })
})

describe('⌘C — the copy writes the Studio marker onto the OS clipboard', () => {
  it('lets the keystroke through, and the copy event it raises carries the entry’s copiedAt', () => {
    const keydown = press('c')
    expect(keydown.defaultPrevented).toBe(false)
    const entry = useEditorStore.getState().clipboardEntry
    expect(entry?.rootNodeIds).toEqual([A])

    const written: Record<string, string> = {}
    const copy = clipboardEvent('copy', dataTransfer(written))
    document.body.dispatchEvent(copy)
    expect(copy.defaultPrevented).toBe(true)
    expect(written[STUDIO_NODES_MIME]).toBe(String(entry!.copiedAt))
    expect(written['text/html']).toBe(studioMarkerHtml(entry!.copiedAt))
  })

  it('a copy with no clipboard event (a context menu, the palette) writes the marker through the async API', async () => {
    const writes: unknown[] = []
    class FakeClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem
    stubAsyncClipboard({
      write: async (items: ClipboardItems) => {
        writes.push(...items)
      },
    })
    useEditorStore.getState().copyNode(A)
    await settle()
    const entry = useEditorStore.getState().clipboardEntry!
    expect(writes).toHaveLength(1)
    const html = await (writes[0] as FakeClipboardItem).items['text/html']!.text()
    expect(html).toBe(studioMarkerHtml(entry.copiedAt))
  })
})
