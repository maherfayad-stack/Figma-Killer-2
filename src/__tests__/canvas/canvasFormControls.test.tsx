import { beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { waitForCanvasElement, waitForCanvasNodeInFrame } from './iframeCanvasQuery'
import '@modules/base'

function renderCanvas() {
  return render(<DndContext><CanvasRoot /></DndContext>)
}

beforeEach(() => {
  cleanup()
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    activePageId: null,
    activeBreakpointId: 'desktop',
    canvasView: 'design',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    hasUnsavedChanges: false,
  })
})

describe('canvas form controls', () => {
  it('prevents native form-control activation while preserving canvas node selection', async () => {
    const site = useEditorStore.getState().createSite('Form Controls')
    const page = site.pages[0]!
    const formId = useEditorStore.getState().insertNode('base.form', {
      mode: 'cms',
      formId: 'contact',
      targetTableId: '',
    }, page.rootNodeId)
    const inputId = useEditorStore.getState().insertNode('base.input', {
      inputType: 'email',
      name: 'email',
      id: 'email',
      autocomplete: 'email',
    }, formId)
    const selectId = useEditorStore.getState().insertNode('base.select', {
      name: 'plan',
      id: 'plan',
    }, formId)
    const submitId = useEditorStore.getState().insertNode('base.submit', {
      label: 'Send',
      formId: '',
    }, formId)

    renderCanvas()

    const form = await waitForCanvasNodeInFrame<HTMLFormElement>('desktop', formId)
    const input = await waitForCanvasNodeInFrame<HTMLInputElement>('desktop', inputId)
    const select = await waitForCanvasNodeInFrame<HTMLSelectElement>('desktop', selectId)
    const submit = await waitForCanvasNodeInFrame<HTMLButtonElement>('desktop', submitId)
    let submitted = false
    form.addEventListener('submit', (event) => {
      submitted = true
      event.preventDefault()
    })

    let inputMouseDown = true
    await act(async () => {
      inputMouseDown = fireEvent.mouseDown(input)
    })
    expect(inputMouseDown).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe(inputId)

    let selectMouseDown = true
    await act(async () => {
      selectMouseDown = fireEvent.pointerDown(select)
    })
    expect(selectMouseDown).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe(selectId)

    await act(async () => {
      fireEvent.click(select!)
    })
    expect(useEditorStore.getState().selectedNodeId).toBe(selectId)

    await act(async () => {
      fireEvent.click(input!)
    })
    expect(useEditorStore.getState().selectedNodeId).toBe(inputId)

    let submitMouseDown = true
    await act(async () => {
      submitMouseDown = fireEvent.mouseDown(submit)
      fireEvent.click(submit)
    })
    expect(submitMouseDown).toBe(false)
    expect(submitted).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe(submitId)
  })

  /**
   * One press-and-release is ONE activation, however many events the browser
   * raises for it.
   *
   * A suppressed control activates its node on `pointerdown` (the press has to
   * be cancelled before the browser focuses the field or opens a picker), and
   * the `click` that ends the same gesture used to activate it a second time.
   * That was invisible while activation only meant "select this node" — the
   * same node twice looks like once — and became a real bug the moment the
   * prototype player made a click mean "follow this link": every link authored
   * on a button fired twice, pushing the same screen onto the stack twice, so
   * one press forward took two presses of Back to undo.
   */
  it('activates a node once per press, not once per event it raises', async () => {
    const site = useEditorStore.getState().createSite('One Activation')
    const page = site.pages[0]!
    const buttonId = useEditorStore.getState().insertNode('base.submit', {
      label: 'Send',
      formId: '',
    }, page.rootNodeId)

    // Count activations at the store action every click path ends in, swapped
    // in BEFORE the render that closes over it. Selection is idempotent, so
    // counting the CALLS is the only way to see a double.
    const realSelectNode = useEditorStore.getState().selectNode
    let activations = 0
    useEditorStore.setState({
      selectNode: ((...args: Parameters<typeof realSelectNode>) => {
        activations += 1
        return realSelectNode(...args)
      }) as typeof realSelectNode,
    })

    renderCanvas()
    const button = await waitForCanvasNodeInFrame<HTMLButtonElement>('desktop', buttonId)

    await act(async () => {
      fireEvent.pointerDown(button)
      fireEvent.mouseDown(button)
      fireEvent.mouseUp(button)
      fireEvent.click(button)
    })

    useEditorStore.setState({ selectNode: realSelectNode })
    expect(activations).toBe(1)
    expect(useEditorStore.getState().selectedNodeId).toBe(buttonId)
  })

  /**
   * A live frame is the page as a visitor gets it, so its controls have to
   * work. Suppression is a DESIGN-frame rule — clicking a `<select>` on an
   * editing surface means "select this node", not "open the picker" — and
   * applying it to live frames is what left every input in live mode
   * unfocusable and untypeable.
   */
  it('leaves an authored control alone in a live frame', async () => {
    const site = useEditorStore.getState().createSite('Live Controls')
    const page = site.pages[0]!
    const inputId = useEditorStore.getState().insertNode('base.input', {
      inputType: 'text',
      name: 'q',
      id: 'q',
      autocomplete: 'off',
    }, page.rootNodeId)
    useEditorStore.setState({ canvasView: 'live' })

    renderCanvas()
    const input = await waitForCanvasElement<HTMLInputElement>(`[data-node-id="${inputId}"]`)

    let pressAllowed = false
    await act(async () => {
      // `fireEvent` returns false when a handler cancelled the event — which is
      // exactly what stops the browser focusing the field.
      pressAllowed = fireEvent.pointerDown(input)
    })
    expect(pressAllowed).toBe(true)
  })
})
