/**
 * useCanvasSelectionKeyboard — the Escape/Enter precedence ladder (`select-01`).
 *
 * These tests pin the ORDER and the STAND-DOWN rules, which is all a DOM-less
 * environment can honestly check: happy-dom has no layout, no iframes with their
 * own event loop, and no real focus pipeline, so "does Escape reach the handler
 * when the user has clicked into the Properties panel" is a browser question and
 * lives in `tests/e2e/canvas-deselect.e2e.ts`. What IS checkable here is that the
 * handler is on `document` at all (a React `onKeyDown` could never see these
 * dispatches) and that each guard refuses for the right reason.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useCanvasSelectionKeyboard } from '@site/canvas/useCanvasSelectionKeyboard'

function mount() {
  return renderHook(() => useCanvasSelectionKeyboard(true, false))
}

/** A real keydown on `document` — the shape both the parent document and `IframeFrameSurface`'s bridge produce. */
function pressEscape(target: EventTarget = document): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  useEditorStore.setState({
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedFrameIds: [],
    enteredInstanceIds: [],
    activeInlineEdit: null,
    activeDocument: null,
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('useCanvasSelectionKeyboard — Escape', () => {
  it('clears a node selection', () => {
    mount()
    useEditorStore.setState({ selectedNodeId: 'n1', selectedNodeIds: ['n1'] })

    expect(pressEscape()).toBe(true)
    expect(useEditorStore.getState().selectedNodeId).toBeNull()
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
  })

  it('clears a board-frame selection', () => {
    mount()
    useEditorStore.setState({ selectedFrameIds: ['page-a', 'page-b'] })

    expect(pressEscape()).toBe(true)
    expect(useEditorStore.getState().selectedFrameIds).toEqual([])
  })

  it('steps OUT of an entered instance instead of clearing', () => {
    mount()
    useEditorStore.setState({
      selectedNodeId: 'child',
      selectedNodeIds: ['child'],
      enteredInstanceIds: ['instance-1'],
    })

    expect(pressEscape()).toBe(true)
    const state = useEditorStore.getState()
    expect(state.enteredInstanceIds).toEqual([])
    // The step-out re-selects the call site — it must NOT have cleared.
    expect(state.selectedNodeId).toBe('instance-1')
  })

  it('leaves Visual Component mode in the same press that clears', () => {
    mount()
    useEditorStore.setState({
      selectedNodeId: 'n1',
      selectedNodeIds: ['n1'],
      activeDocument: { kind: 'visualComponent', id: 'vc-1' },
    })

    expect(pressEscape()).toBe(true)
    expect(useEditorStore.getState().activeDocument).toBeNull()
    expect(useEditorStore.getState().selectedNodeId).toBeNull()
  })

  it('stands down when there is nothing to clear', () => {
    mount()
    expect(pressEscape()).toBe(false)
  })

  it('stands down while an inline text edit owns the keyboard', () => {
    mount()
    useEditorStore.setState({
      selectedNodeId: 'n1',
      selectedNodeIds: ['n1'],
      activeInlineEdit: { nodeId: 'n1', breakpointId: 'studio', prop: 'text', initialValue: '' },
    })

    expect(pressEscape()).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe('n1')
  })

  it('stands down while the user is typing in a field', () => {
    mount()
    useEditorStore.setState({ selectedNodeId: 'n1', selectedNodeIds: ['n1'] })
    const input = document.createElement('input')
    document.body.append(input)

    expect(pressEscape(input)).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe('n1')
  })

  it('stands down inside an overlay that owns Escape itself', () => {
    mount()
    useEditorStore.setState({ selectedNodeId: 'n1', selectedNodeIds: ['n1'] })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)

    expect(pressEscape(button)).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe('n1')
  })

  it('stands down when a more local handler already claimed the keystroke', () => {
    mount()
    useEditorStore.setState({ selectedNodeId: 'n1', selectedNodeIds: ['n1'] })
    const claim = (event: Event) => event.preventDefault()
    document.addEventListener('keydown', claim, true)

    pressEscape()
    document.removeEventListener('keydown', claim, true)
    expect(useEditorStore.getState().selectedNodeId).toBe('n1')
  })

  it('does not run at all on a read-only or live canvas', () => {
    renderHook(() => useCanvasSelectionKeyboard(true, true))
    useEditorStore.setState({ selectedNodeId: 'n1', selectedNodeIds: ['n1'] })

    expect(pressEscape()).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe('n1')
  })
})
