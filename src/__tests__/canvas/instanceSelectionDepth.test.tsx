/**
 * P2-B — a click on a component instance selects the INSTANCE (Figma), in a
 * portal frame and a live (bridge) frame alike, and a double-click opens one
 * level at a time. Plus the bridge frame's keyboard, which rides the same
 * relay as a portal frame's (`canvasFrameKeyRelay.ts`).
 *
 * Found by P2-G while measuring the inspector: "a canvas click on a component
 * instance selects the element inside the instance". Two causes, both here:
 *
 *   1. A live frame's forwarded click went straight to selection — the
 *      instance boundary `NodeRenderer` applies to a portal frame was never
 *      consulted, and the runtime stamps the component's own markup.
 *   2. `findEnclosingInstance` returned the NEAREST closed instance, so with a
 *      Button instance inside a Card instance the first click selected the
 *      button, and a double-click opened the button while the card stayed
 *      closed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { CanvasSelectionContext } from '@site/canvas/CanvasContexts'
import type { FrameDocumentAdapter, FrameRuntimeEvent } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { useBridgeFrameInteraction } from '@site/canvas/BoardFramesLayer/useBridgeFrameInteraction'
import { findEnclosingInstance, resolveInstanceEntry } from '@site/canvas/canvasSelectionUtils'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'

/**
 * root → card (instance) → [title, button (instance) → [label]]
 *      → loose
 */
function cardPage() {
  return makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['card', 'loose'] }),
      card: makeNode({ id: 'card', moduleId: 'studio.instance', children: ['title', 'button'] }),
      title: makeNode({ id: 'title', moduleId: 'base.text' }),
      button: makeNode({ id: 'button', moduleId: 'studio.instance', children: ['label'] }),
      label: makeNode({ id: 'label', moduleId: 'base.text' }),
      loose: makeNode({ id: 'loose', moduleId: 'base.text' }),
    },
  })
}

describe('findEnclosingInstance — the OUTERMOST closed instance', () => {
  const page = cardPage()

  it('a click deep inside nested instances lands on the outer one', () => {
    expect(findEnclosingInstance(page, 'label', [])).toBe('card')
    expect(findEnclosingInstance(page, 'title', [])).toBe('card')
  })

  it('once the outer one is entered, the next closed one down', () => {
    expect(findEnclosingInstance(page, 'label', ['card'])).toBe('button')
    expect(findEnclosingInstance(page, 'title', ['card'])).toBeNull()
    expect(findEnclosingInstance(page, 'label', ['card', 'button'])).toBeNull()
  })

  it('nothing outside an instance', () => {
    expect(findEnclosingInstance(page, 'loose', [])).toBeNull()
  })
})

describe('resolveInstanceEntry — a double-click opens one level', () => {
  const page = cardPage()

  it('opens the card and selects the button whole', () => {
    expect(resolveInstanceEntry(page, 'label', [])).toEqual({ enter: 'card', select: 'button' })
  })

  it('then opens the button and selects the exact node', () => {
    expect(resolveInstanceEntry(page, 'label', ['card'])).toEqual({ enter: 'button', select: 'label' })
  })

  it('means nothing outside a closed instance', () => {
    expect(resolveInstanceEntry(page, 'label', ['card', 'button'])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The live (bridge) frame
// ---------------------------------------------------------------------------

type Handler = (event: FrameRuntimeEvent) => void

function makeFakeAdapter() {
  const handlers = new Map<string, Set<Handler>>()
  const replies: Array<[string, boolean]> = []
  const adapter = {
    on: (type: string, handler: Handler) => {
      let set = handlers.get(type)
      if (!set) {
        set = new Set()
        handlers.set(type, set)
      }
      set.add(handler)
      return () => set?.delete(handler)
    },
    startTextEdit: (nodeId: string, allowed: boolean) => replies.push([nodeId, allowed]),
  } as unknown as FrameDocumentAdapter
  const emit = (event: FrameRuntimeEvent) => handlers.get(event.type)?.forEach((h) => h(event))
  return { adapter, emit, replies }
}

function Harness({ adapter }: { adapter: FrameDocumentAdapter }) {
  useBridgeFrameInteraction(adapter, { breakpointId: 'bp', frameId: 'frame-1', pageId: 'page-1', isActive: true, onActivate: () => {} })
  return null
}

const MODS = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
const MOUSE = { button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', screenX: 0, screenY: 0 }

function mountBridge() {
  const clicks: string[] = []
  const hovers: Array<string | null> = []
  const value = {
    onNodeClick: () => {},
    onFrameNodeClick: (nodeId: string) => clicks.push(nodeId),
    onNodeHover: (nodeId: string | null) => hovers.push(nodeId),
    onNodeContextMenu: () => {},
    onNodeDoubleClick: () => {},
    onNodePointerDown: () => {},
    onNodePointerUp: () => {},
  }
  const fake = makeFakeAdapter()
  render(
    <CanvasSelectionContext.Provider value={value}>
      <Harness adapter={fake.adapter} />
    </CanvasSelectionContext.Provider>,
  )
  return { ...fake, clicks, hovers }
}

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    enteredInstanceIds: [],
    selectedNodeId: null,
    selectedNodeIds: [],
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  resetStore()
  useEditorStore.setState({ site: makeSite({ pages: [cardPage()] }), activePageId: 'page-1' })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

afterAll(resetStore)

describe('a live frame applies the instance boundary', () => {
  it('a click inside the card selects the card, and a hover rings it', () => {
    const { emit, clicks, hovers } = mountBridge()
    emit({ type: 'pointer', phase: 'move', nodeId: 'label', rect: null, clientX: 0, clientY: 0, modifiers: MODS, ...MOUSE })
    emit({ type: 'pointer', phase: 'click', nodeId: 'label', rect: null, clientX: 0, clientY: 0, modifiers: MODS, ...MOUSE })
    expect(hovers).toEqual(['card'])
    expect(clicks).toEqual(['card'])
  })

  it('a node outside any instance is selected as itself', () => {
    const { emit, clicks } = mountBridge()
    emit({ type: 'pointer', phase: 'click', nodeId: 'loose', rect: null, clientX: 0, clientY: 0, modifiers: MODS, ...MOUSE })
    expect(clicks).toEqual(['loose'])
  })

  it('a double-click opens the card, selects the button whole, and refuses the text edit', () => {
    const { emit, clicks, replies } = mountBridge()
    emit({ type: 'text:editStart', nodeId: 'label' })
    expect(useEditorStore.getState().enteredInstanceIds).toEqual(['card'])
    expect(clicks).toEqual(['button'])
    expect(replies).toEqual([['label', false]])
  })
})

describe('a live frame forwards its keyboard to the one dispatcher', () => {
  it('a key message becomes a keydown on the parent document', () => {
    const { emit } = mountBridge()
    const seen: KeyboardEvent[] = []
    const listener = (event: KeyboardEvent) => seen.push(event)
    document.addEventListener('keydown', listener)
    emit({ type: 'key', phase: 'down', key: 'Delete', code: 'Delete', location: 0, repeat: false, modifiers: { ...MODS, metaKey: true } })
    document.removeEventListener('keydown', listener)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.key).toBe('Delete')
    expect(seen[0]?.metaKey).toBe(true)
  })
})
