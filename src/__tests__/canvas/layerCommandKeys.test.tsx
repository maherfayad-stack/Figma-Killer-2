/**
 * P5-E — the layer command keys, driven through the ONE editor dispatcher with
 * real `KeyboardEvent`s, the way the editor mounts them:
 *
 *   - ⌥A ⌥D ⌥W ⌥S ⌥H ⌥V align (IX-20): a positioned layer to its containing
 *     block, two positioned layers to EACH OTHER (P2-C2's missing case), a flow
 *     child through the inspector's own write target;
 *   - ⌘⇧] / ⌘⇧[ bring to front / send to back (IX-9);
 *   - ⇧A flex layout (IX-10);
 *   - ⌘⌥C / ⌘⌥V copy / paste style (IX-props) — one undo entry for N layers;
 *   - and the regression that made ⌘⌥V unsafe to bind: `layers.paste`
 *     matched it too, so one press pasted a LAYER and a style.
 *
 * The layout read goes through a registered frame adapter answering from a
 * table (happy-dom has no layout); what a browser renders is the e2e's job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import type { PageNode } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasLayerCommandKeys } from '@site/canvas/useCanvasLayerCommandKeys'
import { SelectionStyleCommandHost } from '@site/canvas/SelectionStyleCommandHost'
import { resetSelectionStyleCommands } from '@site/canvas/selectionStyleCommands'
import { resetStyleClipboard } from '@site/canvas/layerCommands'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter, NodeMeasurement, NodeRect } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { makeNode, makePage, makeSite } from '../fixtures'
// The module registry: ⇧A reads `canHaveChildren` to tell a container from a leaf.
import '@modules/base'

interface Row {
  style: Record<string, string>
  rect: NodeRect
}

function tableAdapter(table: Record<string, Row>): FrameDocumentAdapter {
  return {
    measure: async (refs: { nodeId: string }[]): Promise<NodeMeasurement[]> =>
      refs.map(({ nodeId }) =>
        table[nodeId]
          ? { nodeId, rect: table[nodeId]!.rect, computedStyle: table[nodeId]!.style }
          : { nodeId, rect: null, computedStyle: {} },
      ),
  } as unknown as FrameDocumentAdapter
}

const box = (x: number, y: number, width = 50, height = 20): NodeRect => ({ x, y, width, height })
const FLOW = { position: 'static', direction: 'ltr', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto' }

/**
 * root → [row, stage, stack]; row (flex row) → [a, b, c]; stage (relative) →
 * [abs, abs2] both absolute; stack (block) → [s1, s2] stacked vertically.
 */
function seed() {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['row', 'stage', 'stack'] }),
      row: makeNode({ id: 'row', moduleId: 'base.container', children: ['a', 'b', 'c'] }),
      a: makeNode({ id: 'a', moduleId: 'base.container', inlineStyles: { color: 'red', padding: '4px', width: '10px' } }),
      b: makeNode({ id: 'b', moduleId: 'base.container', inlineStyles: { margin: '2px' } }),
      c: makeNode({ id: 'c', moduleId: 'base.container' }),
      stage: makeNode({ id: 'stage', moduleId: 'base.container', children: ['abs', 'abs2'] }),
      abs: makeNode({ id: 'abs', moduleId: 'base.container', inlineStyles: { position: 'absolute', left: '100px', top: '40px' } }),
      abs2: makeNode({ id: 'abs2', moduleId: 'base.container', inlineStyles: { position: 'absolute', right: '30px', top: '90px' } }),
      stack: makeNode({ id: 'stack', moduleId: 'base.container', children: ['s1', 's2'] }),
      s1: makeNode({ id: 's1', moduleId: 'base.container' }),
      s2: makeNode({ id: 's2', moduleId: 'base.container' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedFrameIds: [],
    activeInlineEdit: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const TABLE: Record<string, Row> = {
  root: { style: { ...FLOW, display: 'block', 'flex-direction': 'row' }, rect: box(0, 0, 400, 400) },
  row: { style: { ...FLOW, display: 'flex', 'flex-direction': 'row' }, rect: box(0, 0, 400, 40) },
  a: { style: FLOW, rect: box(0, 0) },
  b: { style: FLOW, rect: box(60, 0) },
  c: { style: FLOW, rect: box(120, 0) },
  stage: { style: { ...FLOW, position: 'relative', display: 'block' }, rect: box(0, 50, 300, 200) },
  // `abs`: 100 from the left, 40 from the top, 150 from the right, 140 from the bottom.
  abs: { style: { position: 'absolute', direction: 'ltr', left: '100px', right: '150px', top: '40px', bottom: '140px' }, rect: box(100, 90) },
  // `abs2`: right-anchored, at x 220 in the frame.
  abs2: { style: { position: 'absolute', direction: 'ltr', left: '220px', right: '30px', top: '90px', bottom: '90px' }, rect: box(220, 140) },
  stack: { style: { ...FLOW, display: 'block' }, rect: box(0, 260, 300, 60) },
  s1: { style: FLOW, rect: box(0, 260, 300, 20) },
  s2: { style: FLOW, rect: box(0, 290, 300, 20) },
}

function select(...ids: string[]) {
  useEditorStore.setState({ selectedNodeId: ids.at(-1) ?? null, selectedNodeIds: ids } as Parameters<typeof useEditorStore.setState>[0])
}

function node(id: string): PageNode {
  return useEditorStore.getState().site!.pages[0]!.nodes[id]!
}

function historyLength(): number {
  return (useEditorStore.getState() as unknown as { _historyPast: unknown[] })._historyPast.length
}

function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.dispatchEvent(event)
  return event.defaultPrevented
}

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function Harness() {
  useEditorKeyDispatcher()
  useCanvasLayerCommandKeys(true, false)
  return <SelectionStyleCommandHost />
}

let frame: HTMLIFrameElement

beforeEach(() => {
  seed()
  resetSelectionStyleCommands()
  resetStyleClipboard()
  frame = document.createElement('iframe')
  document.body.appendChild(frame)
  registerFrameAdapter(frame, tableAdapter(TABLE), 'desktop')
})

afterEach(() => {
  cleanup()
  unregisterFrameAdapter(frame)
  document.body.innerHTML = ''
})

describe('⌥-letter align (IX-20)', () => {
  it('is matched on the physical key: ⌥A arrives as "å" on a Mac', () => {
    const binding = getKeybindingForCommand('layers.alignLeft')!
    expect(binding.match({ key: 'å', code: 'KeyA', altKey: true, metaKey: false, ctrlKey: false, shiftKey: false })).toBe(true)
    expect(binding.match({ key: 'a', code: 'KeyA', altKey: false, metaKey: false, ctrlKey: false, shiftKey: false })).toBe(false)
    expect(binding.match({ key: 'å', code: 'KeyA', altKey: true, metaKey: true, ctrlKey: false, shiftKey: false })).toBe(false)
  })

  it('⌥A on ONE positioned layer: its left becomes 0 in its containing block, one undo entry', async () => {
    render(<Harness />)
    select('abs')
    expect(press({ key: 'å', code: 'KeyA', altKey: true })).toBe(true)
    await settle()
    expect(node('abs').inlineStyles).toMatchObject({ left: '0px', top: '40px' })
    expect(historyLength()).toBe(1)
  })

  it('⌥D on a RIGHT-anchored layer moves `right` to 0 and never adds a `left` (IX-21)', async () => {
    render(<Harness />)
    select('abs2')
    press({ key: '∂', code: 'KeyD', altKey: true })
    await settle()
    expect(node('abs2').inlineStyles).toEqual({ position: 'absolute', right: '0px', top: '90px' })
  })

  it('two positioned layers align to EACH OTHER — the selection bounds (P2-C2 found it missing)', async () => {
    render(<Harness />)
    select('abs', 'abs2')
    press({ key: 'å', code: 'KeyA', altKey: true })
    await settle()
    // The bounds' left edge is abs's (frame x 100): abs stays, abs2 (x 220)
    // moves 120 left — through its authored `right`, which grows by 120.
    expect(node('abs').inlineStyles).toEqual({ position: 'absolute', left: '100px', top: '40px' })
    expect(node('abs2').inlineStyles).toEqual({ position: 'absolute', right: '150px', top: '90px' })
    expect(historyLength()).toBe(1)

    press({ key: '∑', code: 'KeyW', altKey: true })
    await settle()
    // Top edge of the bounds is abs's (y 90): abs2 (y 140) moves up 50.
    expect(node('abs2').inlineStyles?.top).toBe('40px')
  })

  it('⌥W on a flow child of a flex ROW writes align-self through the inspector’s write target', async () => {
    render(<Harness />)
    select('b')
    press({ key: '∑', code: 'KeyW', altKey: true })
    await settle()
    expect(node('b').inlineStyles).toMatchObject({ alignSelf: 'flex-start' })
  })
})

describe('bring to front / send to back (IX-9)', () => {
  it('⌘⇧] makes the layer the LAST child (it paints on top); ⌘⇧[ the first', async () => {
    render(<Harness />)
    select('a')
    expect(press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })).toBe(true)
    await settle()
    expect([...node('row').children]).toEqual(['b', 'c', 'a'])

    press({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true })
    await settle()
    expect([...node('row').children]).toEqual(['a', 'b', 'c'])
  })

  it('does not steal ⌘] (reorder by one, K4)', () => {
    expect(getKeybindingForCommand('layers.bringToFront')!.match({ key: ']', code: 'BracketRight', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false)
    expect(getKeybindingForCommand('layers.moveUp')!.match({ key: ']', code: 'BracketRight', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true)
  })
})

describe('⇧A flex layout (IX-10)', () => {
  it('a block container of STACKED children becomes a flex COLUMN', async () => {
    render(<Harness />)
    select('stack')
    expect(press({ key: 'A', code: 'KeyA', shiftKey: true })).toBe(true)
    await settle()
    expect(node('stack').inlineStyles).toMatchObject({ display: 'flex', flexDirection: 'column' })
  })
})

describe('copy / paste style (IX-props)', () => {
  it('REGRESSION: ⌘⌥V / Ctrl+Alt+V is paste STYLE, not paste layer', () => {
    const ctrlAltV = { key: 'v', code: 'KeyV', ctrlKey: true, altKey: true, metaKey: false, shiftKey: false }
    expect(getKeybindingForCommand('layers.paste')!.match(ctrlAltV)).toBe(false)
    expect(getKeybindingForCommand('layers.pasteStyle')!.match(ctrlAltV)).toBe(true)
    const ctrlAltC = { ...ctrlAltV, key: 'c', code: 'KeyC' }
    expect(getKeybindingForCommand('layers.copy')!.match(ctrlAltC)).toBe(false)
    expect(getKeybindingForCommand('layers.copyStyle')!.match(ctrlAltC)).toBe(true)
  })

  it('⌘⌥C then ⌘⌥V on two layers: they take the style (not the size), in ONE undo entry', async () => {
    render(<Harness />)
    select('a')
    press({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true })
    select('b', 'c')
    press({ key: '√', code: 'KeyV', metaKey: true, altKey: true })
    await settle()
    // b's own `margin` is replaced by the copy; a's width stays with a.
    expect(node('b').inlineStyles).toEqual({ color: 'red', padding: '4px' })
    expect(node('c').inlineStyles).toEqual({ color: 'red', padding: '4px' })
    expect(historyLength()).toBe(1)
    useEditorStore.getState().undo()
    expect(node('b').inlineStyles).toEqual({ margin: '2px' })
    expect(node('c').inlineStyles).toBeUndefined()
  })
})
