/**
 * P2-B "selection and keyboard hands" — the keys, driven through the ONE
 * dispatcher exactly as the editor mounts it (`useEditorKeyDispatcher` plus
 * the real scope hooks), with real `KeyboardEvent`s on real targets.
 *
 * happy-dom has no layout and no real focus pipeline, so what a browser does
 * with focus inside an iframe is `tests/e2e/selection-keyboard-hands.e2e.ts`'s
 * question. What IS checkable here: who claims which key, on which target,
 * and what the store looks like afterwards.
 *
 *   - ERR-21 — a read-only / non-text `<input>` no longer swallows Delete.
 *   - ERR-11 — focus leaving the window lowers the Space-pan flags, and a Space
 *     released in a frame lowers the flag its clone raised in the parent.
 *   - IX-2   — ⇧-click toggles on the canvas.
 *   - IX-3   — Tab / ⇧Tab cycle siblings, on the canvas only.
 *   - IX-4   — ⌘A selects siblings, climbs, and hands over to the frames.
 *   - IX-11  — V puts every tool away.
 *   - IX-15  — the zoom keys work with focus in a panel, and ⇧1 matches the
 *              physical key.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { createBoard, createBoardsFile, upsertFrame } from '@core/studio-board'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasSelectionKeyboard } from '@site/canvas/useCanvasSelectionKeyboard'
import { useCanvasNodeShortcuts } from '@site/canvas/useCanvasNodeShortcuts'
import { useBoardSelectAllShortcut } from '@site/canvas/useBoardSelectAllShortcut'
import { useCanvasToolShortcuts } from '@site/canvas/useCanvasToolShortcuts'
import { useCanvasNodeInteraction } from '@site/canvas/useCanvasNodeInteraction'
import { useCanvasViewportKeys } from '@site/hooks/useCanvasViewportKeys'
import { isCanvasSpacePanActive, setCanvasSpacePanActive } from '@site/canvas/canvasPanInput'
import { isTextInputTarget } from '@site/canvas/editorKeyGuards'
import { relayFrameKeyDown, relayFrameKeyUp, relayFrameBlur, type FrameKeyInit } from '@site/canvas/canvasFrameKeyRelay'
import { makeNode, makePage, makeSite } from '../fixtures'

const deleteRequests: string[] = []
const viewportCalls: string[] = []

function mount() {
  return renderHook(() => {
    useEditorKeyDispatcher()
    useCanvasSelectionKeyboard(true, false, () => {})
    useCanvasNodeShortcuts({ editable: true, isLive: false, requestDeleteNode: (id) => deleteRequests.push(id) })
    useBoardSelectAllShortcut(true, false)
    useCanvasToolShortcuts(true, false)
    useCanvasViewportKeys({
      enabled: true,
      canvasRootRef: { current: null },
      resetCanvasView: () => viewportCalls.push('reset'),
      zoomToFit: () => viewportCalls.push('fit'),
      zoomToSelection: () => viewportCalls.push('selection'),
    })
  })
}

/** A keydown raised on `target`, bubbling to the dispatcher on `document`. Returns whether it was claimed (`defaultPrevented`). */
function press(target: EventTarget, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

/** The canvas root and a panel, as the editor lays them out — the only thing `isCanvasKeyboardSurface` reads. */
function layout() {
  const canvas = document.createElement('div')
  canvas.setAttribute('data-studio-canvas-root', 'true')
  canvas.tabIndex = 0
  const iframe = document.createElement('iframe')
  canvas.appendChild(iframe)
  const panel = document.createElement('aside')
  const panelButton = document.createElement('button')
  panel.appendChild(panelButton)
  document.body.append(canvas, panel)
  return { canvas, iframe, panelButton }
}

/**
 * root → [header, main]; main → [a, b, c]. `seedBoard` adds a board with two
 * frames, so ⌘A has somewhere to hand over to at the root.
 */
function seed() {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['header', 'main'] }),
      header: makeNode({ id: 'header', moduleId: 'base.container' }),
      main: makeNode({ id: 'main', moduleId: 'base.container', children: ['a', 'b', 'c'] }),
      a: makeNode({ id: 'a', moduleId: 'base.text' }),
      b: makeNode({ id: 'b', moduleId: 'base.text' }),
      c: makeNode({ id: 'c', moduleId: 'base.text' }),
    },
  })
  useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: 'page-1' })
}

function seedBoard() {
  let board = createBoard('board-1', 'Board')
  board = upsertFrame(board, { id: 'f-1', pageId: 'page-1', x: 0, y: 0 })
  board = upsertFrame(board, { id: 'f-2', pageId: 'page-2', x: 500, y: 0 })
  const page = useEditorStore.getState().site?.pages[0]
  useEditorStore.setState({
    boards: { ...createBoardsFile(), boards: [board] },
    activeBoardId: 'board-1',
    // What `loadSite` builds: which pages carry each node id. Board-mode
    // selection resolves through it (`resolveSelectableNode`).
    _nodeIdToPageIds: new Map(Object.keys(page?.nodes ?? {}).map((id) => [id, ['page-1']])),
  } as Parameters<typeof useEditorStore.setState>[0])
}

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    selectedFrameIds: [],
    enteredInstanceIds: [],
    activeInlineEdit: null,
    canvasTool: 'move',
    commentToolActive: false,
    zoom: 1,
    panX: 0,
    panY: 0,
    boards: createBoardsFile(),
    activeBoardId: null,
    _nodeIdToPageIds: new Map(),
  } as Parameters<typeof useEditorStore.setState>[0])
}

const originalHasFocus = document.hasFocus.bind(document)

beforeEach(() => {
  resetStore()
  deleteRequests.length = 0
  viewportCalls.length = 0
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  document.hasFocus = originalHasFocus
  setCanvasSpacePanActive(document, 'parentDocument', false)
  setCanvasSpacePanActive(document, 'iframe', false)
})

afterAll(resetStore)

const state = () => useEditorStore.getState()

// ---------------------------------------------------------------------------

describe('ERR-21 — only a field you can type into owns the keystroke', () => {
  it('classifies inputs by whether text can be entered', () => {
    const text = document.createElement('input')
    const readOnly = document.createElement('input')
    readOnly.readOnly = true
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    const range = document.createElement('input')
    range.type = 'range'
    const textarea = document.createElement('textarea')
    const readOnlyArea = document.createElement('textarea')
    readOnlyArea.readOnly = true

    expect(isTextInputTarget(text)).toBe(true)
    expect(isTextInputTarget(textarea)).toBe(true)
    expect(isTextInputTarget(readOnly)).toBe(false)
    expect(isTextInputTarget(checkbox)).toBe(false)
    expect(isTextInputTarget(range)).toBe(false)
    expect(isTextInputTarget(readOnlyArea)).toBe(false)
  })

  it('Delete reaches the selection while the Select trigger (a read-only input) has focus', () => {
    mount()
    seed()
    state().selectNode('a')
    // `Select`'s trigger: `<input role="combobox" readOnly>`.
    const trigger = document.createElement('input')
    trigger.readOnly = true
    trigger.setAttribute('role', 'combobox')
    document.body.appendChild(trigger)

    expect(press(trigger, { key: 'Delete' })).toBe(true)
    expect(deleteRequests).toEqual(['a'])
  })

  it('Delete still types into a real text field', () => {
    mount()
    seed()
    state().selectNode('a')
    const field = document.createElement('input')
    document.body.appendChild(field)

    expect(press(field, { key: 'Delete' })).toBe(false)
    expect(deleteRequests).toEqual([])
  })
})

describe('ERR-11 — a held Space never outlives the key', () => {
  it('focus leaving the window lowers the pan flag', async () => {
    mount()
    press(document.body, { key: ' ', code: 'Space' })
    expect(isCanvasSpacePanActive(document)).toBe(true)

    document.hasFocus = () => false
    window.dispatchEvent(new Event('blur'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(isCanvasSpacePanActive(document)).toBe(false)
  })

  it('focus moving INTO a frame is not a release', async () => {
    mount()
    press(document.body, { key: ' ', code: 'Space' })

    document.hasFocus = () => true
    window.dispatchEvent(new Event('blur'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(isCanvasSpacePanActive(document)).toBe(true)
  })

  it('a Space released inside a frame lowers the flag its forwarded press raised in the parent', () => {
    mount()
    const space: FrameKeyInit = { key: ' ', code: 'Space', location: 0, repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
    relayFrameKeyDown(document, space, { userGesture: true })
    expect(isCanvasSpacePanActive(document)).toBe(true)

    relayFrameKeyUp(document, space)
    expect(isCanvasSpacePanActive(document)).toBe(false)
  })

  it('a frame losing focus to another application releases the pan', async () => {
    mount()
    const space: FrameKeyInit = { key: ' ', code: 'Space', location: 0, repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
    relayFrameKeyDown(document, space, { userGesture: true })

    document.hasFocus = () => false
    relayFrameBlur(document)
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(isCanvasSpacePanActive(document)).toBe(false)
  })

  it('never puts the hand tool away — that latch is a choice, not a held key', async () => {
    mount()
    setCanvasSpacePanActive(document, 'handTool', true)
    document.hasFocus = () => false
    window.dispatchEvent(new Event('blur'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(isCanvasSpacePanActive(document)).toBe(true)
    setCanvasSpacePanActive(document, 'handTool', false)
  })

  it('a focused checkbox keeps Space', () => {
    mount()
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    document.body.appendChild(checkbox)

    expect(press(checkbox, { key: ' ', code: 'Space' })).toBe(false)
    expect(isCanvasSpacePanActive(document)).toBe(false)
  })
})

describe('IX-2 — ⇧-click toggles on the canvas', () => {
  function interaction() {
    return renderHook(() =>
      useCanvasNodeInteraction({
        editable: true,
        isLive: false,
        canEditContent: true,
        playMode: false,
        canvasPage: null,
        overlayPage: null,
        activeBreakpointId: 'bp',
        preserveSelectionWhenActivatingBreakpoint: false,
        openContextMenu: () => {},
      }),
    ).result
  }
  const SHIFT = { shiftKey: true, metaKey: false, ctrlKey: false }
  const META = { shiftKey: false, metaKey: true, ctrlKey: false }
  const NONE = { shiftKey: false, metaKey: false, ctrlKey: false }

  it('adds a node with ⇧, and removes it again with ⇧ — no tree range in between', () => {
    seed()
    const result = interaction()
    result.current.onFrameNodeClick('a', NONE, 'bp')
    result.current.onFrameNodeClick('c', SHIFT, 'bp')
    // A range from `a` to `c` would have swept `b` in.
    expect(state().selectedNodeIds).toEqual(['a', 'c'])

    result.current.onFrameNodeClick('a', SHIFT, 'bp')
    expect(state().selectedNodeIds).toEqual(['c'])
  })

  it('⌘-click is the same toggle', () => {
    seed()
    const result = interaction()
    result.current.onFrameNodeClick('a', NONE, 'bp')
    result.current.onFrameNodeClick('b', META, 'bp')
    expect(state().selectedNodeIds).toEqual(['a', 'b'])
  })
})

describe('IX-3 — Tab / ⇧Tab cycle siblings, on the canvas only', () => {
  it('Tab and ⇧Tab move the selection with focus on the canvas', () => {
    mount()
    seed()
    const { canvas } = layout()
    state().selectNode('a')

    expect(press(canvas, { key: 'Tab' })).toBe(true)
    expect(state().selectedNodeIds).toEqual(['b'])
    expect(press(canvas, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(state().selectedNodeIds).toEqual(['a'])
  })

  it('a Tab forwarded out of a frame (a clone on document, the frame focused) moves it too', () => {
    mount()
    seed()
    const { iframe } = layout()
    iframe.focus()
    state().selectNode('a')

    const claimed = relayFrameKeyDown(document, { key: 'Tab', code: 'Tab', location: 0, repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, { userGesture: true })
    expect(claimed).toBe(true)
    expect(state().selectedNodeIds).toEqual(['b'])
  })

  it('stands down inside a panel, where Tab walks the fields', () => {
    mount()
    seed()
    const { panelButton } = layout()
    state().selectNode('a')

    expect(press(panelButton, { key: 'Tab' })).toBe(false)
    expect(state().selectedNodeIds).toEqual(['a'])
  })

  it('stands down with nothing selected', () => {
    mount()
    seed()
    const { canvas } = layout()
    expect(press(canvas, { key: 'Tab' })).toBe(false)
  })
})

describe('IX-4 — ⌘A with a node selected', () => {
  it('selects the siblings, then climbs, then hands the root over to every frame', () => {
    mount()
    seed()
    seedBoard()
    state().selectNode('b')

    expect(press(document.body, { key: 'a', ctrlKey: true })).toBe(true)
    expect(new Set(state().selectedNodeIds)).toEqual(new Set(['a', 'b', 'c']))

    press(document.body, { key: 'a', ctrlKey: true })
    expect(state().selectedNodeIds).toEqual(['header', 'main'])

    press(document.body, { key: 'a', ctrlKey: true })
    expect(state().selectedNodeIds).toEqual(['root'])

    press(document.body, { key: 'a', ctrlKey: true })
    expect(state().selectedNodeIds).toEqual([])
    expect(state().selectedFrameIds).toEqual(['page-1', 'page-2'])
  })

  it('claims ⌘A from a panel too, so the browser never selects the chrome', () => {
    mount()
    seed()
    const { panelButton } = layout()
    state().selectNode('b')
    expect(press(panelButton, { key: 'a', metaKey: true })).toBe(true)
  })
})

describe('IX-11 — V is the way home', () => {
  it('puts the hand tool away and disarms the comment tool', () => {
    mount()
    useEditorStore.setState({ canvasTool: 'hand', commentToolActive: true })

    expect(press(document.body, { key: 'v' })).toBe(true)
    expect(state().canvasTool).toBe('move')
    expect(state().commentToolActive).toBe(false)
  })

  it('leaves ⌘V to paste', () => {
    mount()
    useEditorStore.setState({ canvasTool: 'hand' })
    press(document.body, { key: 'v', metaKey: true })
    expect(state().canvasTool).toBe('hand')
  })
})

describe('IX-15 — the zoom keys are on the dispatcher', () => {
  it('+ and − zoom with focus in a panel, which a canvas onKeyDown never heard', () => {
    mount()
    const { panelButton } = layout()
    const before = state().zoom

    expect(press(panelButton, { key: '=' })).toBe(true)
    expect(state().zoom).toBeGreaterThan(before)
    expect(press(panelButton, { key: '_', shiftKey: true })).toBe(true)
    expect(state().zoom).toBe(before)
  })

  it('⇧1 fits, matched on the physical key (a US keyboard reports "!")', () => {
    mount()
    expect(press(document.body, { key: '!', code: 'Digit1', shiftKey: true })).toBe(true)
    expect(press(document.body, { key: '@', code: 'Digit2', shiftKey: true })).toBe(true)
    expect(press(document.body, { key: ')', code: 'Digit0', shiftKey: true })).toBe(true)
    expect(press(document.body, { key: '0', code: 'Digit0', ctrlKey: true })).toBe(true)
    expect(viewportCalls).toEqual(['fit', 'selection', 'reset', 'reset'])
  })

  it('stand down while an inline text edit owns the keyboard', () => {
    mount()
    useEditorStore.setState({ activeInlineEdit: { nodeId: 'a', breakpointId: 'bp', prop: 'text', initialValue: '' } } as Parameters<typeof useEditorStore.setState>[0])
    const before = state().zoom
    expect(press(document.body, { key: '-' })).toBe(false)
    expect(state().zoom).toBe(before)
  })

  it('stand down in a text field', () => {
    mount()
    const field = document.createElement('input')
    document.body.appendChild(field)
    expect(press(field, { key: '-' })).toBe(false)
  })
})
