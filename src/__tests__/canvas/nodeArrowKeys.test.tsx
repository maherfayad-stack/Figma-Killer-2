/**
 * P2-C "arrow keys" (IX-1): with a layer selected, an arrow key moves it.
 *
 *   - an absolute / fixed layer NUDGES its offsets by 1 px, 10 with ⇧;
 *   - a layout child REORDERS one place along its parent's axis;
 *   - a held key is ONE undo entry and ONE source write, closed on keyup;
 *   - the offsets written are the ones the source authored — a right-anchored
 *     layer moves `right`, never gains a `left` (P2-D's finding, `canvas-23`).
 *
 * Driven through the ONE dispatcher exactly as the editor mounts it, with real
 * `KeyboardEvent`s. The layout read goes through a registered frame adapter,
 * as in the editor; here the adapter answers from a table, because happy-dom
 * has no layout. What a real browser renders is
 * `tests/e2e/node-arrow-keys.e2e.ts`'s question.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import type { PageNode, StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasNodeShortcuts } from '@site/canvas/useCanvasNodeShortcuts'
import { useCanvasNodeArrowKeys } from '@site/canvas/useCanvasNodeArrowKeys'
import { dispatchEditorKeyUp } from '@site/canvas/editorKeyDispatcher'
import {
  authoredOffsets,
  nudgeStylePatch,
  planNudge,
  reorderStep,
  type ArrowTargetStyle,
} from '@site/canvas/canvasNodeArrowMove'
import {
  registerFrameAdapter,
  unregisterFrameAdapter,
} from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter, NodeMeasurement } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { EDITOR_SAVE_REQUEST_EVENT } from '@admin/state/adminEvents'
import { makeNode, makePage, makeSite } from '../fixtures'

// ---------------------------------------------------------------------------
// The rules, pure
// ---------------------------------------------------------------------------

function ownStyle(overrides: Partial<ArrowTargetStyle> = {}): ArrowTargetStyle {
  return { position: 'absolute', direction: 'ltr', left: '100px', right: '180px', top: '40px', bottom: '60px', ...overrides }
}

function rule(id: string, styles: Record<string, string>): StyleRule {
  return { id, styles, contextStyles: {} } as unknown as StyleRule
}

describe('which offsets a nudge writes', () => {
  it('with nothing authored: left and top, from the computed values', () => {
    const plan = planNudge(ownStyle(), new Set())
    expect(nudgeStylePatch(plan, 1, 0)).toEqual({ left: '101px' })
    expect(nudgeStylePatch(plan, 0, 10)).toEqual({ top: '50px' })
  })

  it('a RIGHT-anchored layer moves `right` and never gains a `left` (canvas-23)', () => {
    const authored = authoredOffsets({ classIds: [], inlineStyles: { position: 'absolute', right: '180px', bottom: '60px' } }, {})
    const plan = planNudge(ownStyle(), authored)
    // Visual right SHRINKS the distance from the right edge.
    expect(nudgeStylePatch(plan, 1, -1)).toEqual({ right: '179px', bottom: '61px' })
  })

  it('a stretched layer (left AND right) moves both, so it keeps its width', () => {
    const authored = authoredOffsets({ classIds: [], inlineStyles: { left: '100px', right: '180px' } }, {})
    expect(nudgeStylePatch(planNudge(ownStyle(), authored), 10, 0)).toEqual({ left: '110px', right: '170px' })
  })

  it('reads the class rules under the inline styles, and `inset` sets every side', () => {
    const rules = { c1: rule('c1', { right: '10px' }), c2: rule('c2', { inset: '0' }) }
    expect([...authoredOffsets({ classIds: ['c1'], inlineStyles: undefined }, rules)]).toEqual(['right'])
    // An inline `auto` cancels the class's side.
    expect([...authoredOffsets({ classIds: ['c1'], inlineStyles: { right: 'auto' } }, rules)]).toEqual([])
    expect(new Set(authoredOffsets({ classIds: ['c2'], inlineStyles: undefined }, rules))).toEqual(
      new Set(['left', 'right', 'top', 'bottom']),
    )
  })

  it('`inset` counts only the sides it does not leave `auto` — a stretched banner moves, never grows', () => {
    // test4's SMS `.banner`: `inset: 124px 0 auto 0`. Writing a `bottom` would
    // stretch it to the page's bottom edge instead of moving it.
    const rules = { banner: rule('banner', { position: 'absolute', inset: '124px 0 auto 0' }) }
    const authored = authoredOffsets({ classIds: ['banner'], inlineStyles: undefined }, rules)
    expect(new Set(authored)).toEqual(new Set(['top', 'right', 'left']))
    const plan = planNudge(ownStyle({ left: '0px', right: '0px', top: '124px' }), authored)
    expect(nudgeStylePatch(plan, 0, 1)).toEqual({ top: '125px' })
    expect(nudgeStylePatch(plan, 10, 0)).toEqual({ left: '10px', right: '-10px' })
    // Two values: vertical pair, horizontal pair; a space inside calc() does not split.
    expect(new Set(authoredOffsets({ classIds: [], inlineStyles: { inset: 'calc(10px + 2px) auto' } }, {}))).toEqual(
      new Set(['top', 'bottom']),
    )
  })

  it('RTL: the logical inline start, reversed, read through the right edge', () => {
    const plan = planNudge(ownStyle({ direction: 'rtl' }), new Set())
    // `insetInlineStart` IS `right` under RTL: visual right shrinks it.
    expect(nudgeStylePatch(plan, 1, 0)).toEqual({ insetInlineStart: '179px' })
  })
})

describe('which way a reorder goes', () => {
  it('moves along the axis, reversed for *-reverse, and not at all across it', () => {
    expect(reorderStep({ axis: 'vertical', reversed: false }, { dx: 0, dy: 1 })).toBe(1)
    expect(reorderStep({ axis: 'vertical', reversed: false }, { dx: 0, dy: -3 })).toBe(-1)
    expect(reorderStep({ axis: 'vertical', reversed: false }, { dx: 1, dy: 0 })).toBeNull()
    expect(reorderStep({ axis: 'horizontal', reversed: false }, { dx: 1, dy: 0 })).toBe(1)
    expect(reorderStep({ axis: 'horizontal', reversed: true }, { dx: 1, dy: 0 })).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// Through the dispatcher
// ---------------------------------------------------------------------------

const ROW = { display: 'flex', 'flex-direction': 'row', 'grid-auto-flow': 'row', direction: 'ltr' }
const COLUMN = { display: 'block', 'flex-direction': 'row', 'grid-auto-flow': 'row', direction: 'ltr' }
const ABSOLUTE = { position: 'absolute', direction: 'ltr', left: '100px', right: '180px', top: '40px', bottom: '60px' }
const STATIC = { position: 'static', direction: 'ltr', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto' }

/** Answers `measure` from a table — the computed style each node id has. */
function tableAdapter(table: Record<string, Record<string, string>>): FrameDocumentAdapter {
  return {
    measure: async (refs: { nodeId: string }[]): Promise<NodeMeasurement[]> =>
      refs.map(({ nodeId }) =>
        table[nodeId]
          ? { nodeId, rect: { x: 0, y: 0, width: 10, height: 10 }, computedStyle: table[nodeId] }
          : { nodeId, rect: null, computedStyle: {} },
      ),
  } as unknown as FrameDocumentAdapter
}

/**
 * root (column) → [row, stage]; row (flex row) → [a, b, c];
 * stage → [abs, right] where both are absolute.
 */
function seed(overrides: { abs?: Partial<PageNode>; right?: Partial<PageNode> } = {}) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['row', 'stage'] }),
      row: makeNode({ id: 'row', moduleId: 'base.container', children: ['a', 'b', 'c'] }),
      a: makeNode({ id: 'a', moduleId: 'base.container' }),
      b: makeNode({ id: 'b', moduleId: 'base.container' }),
      c: makeNode({ id: 'c', moduleId: 'base.container' }),
      stage: makeNode({ id: 'stage', moduleId: 'base.container', children: ['abs', 'right'] }),
      abs: makeNode({ id: 'abs', moduleId: 'base.container', inlineStyles: { position: 'absolute', left: '100px', top: '40px' }, ...overrides.abs }),
      right: makeNode({ id: 'right', moduleId: 'base.container', inlineStyles: { position: 'absolute', right: '180px', top: '40px' }, ...overrides.right }),
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
    previewNodeStyles: null,
    hasUnsavedChanges: false,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function select(id: string) {
  useEditorStore.setState({ selectedNodeId: id, selectedNodeIds: [id] } as Parameters<typeof useEditorStore.setState>[0])
}

function node(id: string): PageNode {
  return useEditorStore.getState().site!.pages[0]!.nodes[id]!
}

function childOrder(parentId: string): string[] {
  return [...node(parentId).children]
}

function historyLength(): number {
  return (useEditorStore.getState() as unknown as { _historyPast: unknown[] })._historyPast.length
}

function press(target: EventTarget, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

function release(target: EventTarget, key: string) {
  target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key }))
}

/** Lets the layout read (a promise, even in a portal frame) land. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

let frame: HTMLIFrameElement
let saveRequests = 0
const countSave = () => {
  saveRequests += 1
}

function mount() {
  return renderHook(() => {
    useEditorKeyDispatcher()
    useCanvasNodeShortcuts({ editable: true, isLive: false, requestDeleteNode: () => {} })
    useCanvasNodeArrowKeys(true, false)
  })
}

beforeEach(() => {
  seed()
  frame = document.createElement('iframe')
  document.body.appendChild(frame)
  registerFrameAdapter(
    frame,
    tableAdapter({ root: COLUMN, row: ROW, a: STATIC, b: STATIC, c: STATIC, stage: { ...COLUMN, position: 'relative' }, abs: ABSOLUTE, right: ABSOLUTE }),
    'desktop',
  )
  saveRequests = 0
  window.addEventListener(EDITOR_SAVE_REQUEST_EVENT, countSave)
})

afterEach(() => {
  cleanup()
  unregisterFrameAdapter(frame)
  window.removeEventListener(EDITOR_SAVE_REQUEST_EVENT, countSave)
  document.body.innerHTML = ''
})

describe('an absolute layer nudges (IX-1)', () => {
  it('a held arrow previews every repeat, then writes ONCE on keyup: one undo entry, one save', async () => {
    mount()
    select('abs')
    expect(press(document, { key: 'ArrowRight' })).toBe(true)
    await settle()
    for (let i = 0; i < 4; i++) press(document, { key: 'ArrowRight', repeat: true })

    // Mid-hold: the canvas shows the move, the document does not have it yet.
    expect(useEditorStore.getState().previewNodeStyles?.styles).toEqual({ left: '105px' })
    expect(node('abs').inlineStyles?.left).toBe('100px')
    expect(historyLength()).toBe(0)
    expect(saveRequests).toBe(0)

    release(document, 'ArrowRight')
    expect(node('abs').inlineStyles?.left).toBe('105px')
    expect(useEditorStore.getState().previewNodeStyles).toBeNull()
    expect(historyLength()).toBe(1)
    expect(saveRequests).toBe(1)

    useEditorStore.getState().undo()
    expect(node('abs').inlineStyles?.left).toBe('100px')
  })

  it('⇧ steps 10; ↑ moves `top` up', async () => {
    mount()
    select('abs')
    press(document, { key: 'ArrowUp', shiftKey: true })
    await settle()
    release(document, 'ArrowUp')
    expect(node('abs').inlineStyles?.top).toBe('30px')
    expect(node('abs').inlineStyles?.left).toBe('100px')
  })

  it('letting go of ⇧ mid-hold does not end it; the arrow release does', async () => {
    mount()
    select('abs')
    press(document, { key: 'ArrowRight', shiftKey: true })
    await settle()
    release(document, 'Shift')
    press(document, { key: 'ArrowRight', repeat: true })
    expect(historyLength()).toBe(0)
    release(document, 'ArrowRight')
    expect(node('abs').inlineStyles?.left).toBe('111px')
    expect(historyLength()).toBe(1)
  })

  it('a right-anchored layer keeps its anchor — no `left` reaches the source (canvas-23)', async () => {
    mount()
    select('right')
    press(document, { key: 'ArrowRight' })
    await settle()
    release(document, 'ArrowRight')
    expect(node('right').inlineStyles).toEqual({ position: 'absolute', right: '179px', top: '40px' })
  })

  it('focus leaving the window commits the hold where it was last shown', async () => {
    mount()
    select('abs')
    press(document, { key: 'ArrowDown' })
    await settle()
    press(document, { key: 'ArrowDown', repeat: true })
    dispatchEditorKeyUp(null)
    expect(node('abs').inlineStyles?.top).toBe('42px')
    expect(historyLength()).toBe(1)
  })

  it('a key released before the layout read lands still writes once', async () => {
    mount()
    select('abs')
    press(document, { key: 'ArrowLeft' })
    release(document, 'ArrowLeft')
    await settle()
    expect(node('abs').inlineStyles?.left).toBe('99px')
    expect(historyLength()).toBe(1)
    expect(useEditorStore.getState().previewNodeStyles).toBeNull()
  })
})

describe('a layout child reorders (IX-1)', () => {
  it('→ in a row moves it one place later; a held key is one move', async () => {
    mount()
    select('a')
    press(document, { key: 'ArrowRight' })
    await settle()
    for (let i = 0; i < 5; i++) press(document, { key: 'ArrowRight', repeat: true })
    await settle()
    release(document, 'ArrowRight')
    expect(childOrder('row')).toEqual(['b', 'a', 'c'])
    expect(historyLength()).toBe(1)
  })

  it('← moves it back; a cross-axis arrow is claimed and moves nothing', async () => {
    mount()
    select('b')
    press(document, { key: 'ArrowLeft' })
    await settle()
    release(document, 'ArrowLeft')
    expect(childOrder('row')).toEqual(['b', 'a', 'c'])

    expect(press(document, { key: 'ArrowDown' })).toBe(true)
    await settle()
    release(document, 'ArrowDown')
    expect(childOrder('row')).toEqual(['b', 'a', 'c'])
  })

  it('↓ in a block column moves it one place later', async () => {
    mount()
    select('row')
    press(document, { key: 'ArrowDown' })
    await settle()
    release(document, 'ArrowDown')
    expect(childOrder('root')).toEqual(['stage', 'row'])
  })
})

describe('the arrows stand down where they belong to something else', () => {
  it('in a text field, in a panel, and with nothing selected', async () => {
    mount()
    select('abs')
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(press(input, { key: 'ArrowRight' })).toBe(false)

    const panelButton = document.createElement('button')
    document.body.appendChild(panelButton)
    expect(press(panelButton, { key: 'ArrowRight' })).toBe(false)

    useEditorStore.setState({ selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
    expect(press(document, { key: 'ArrowRight' })).toBe(false)
    await settle()
    expect(node('abs').inlineStyles?.left).toBe('100px')
    expect(historyLength()).toBe(0)
  })

  it('⌥↑ stays the ⌥ reorder, not a nudge', async () => {
    mount()
    select('b')
    press(document, { key: 'ArrowUp', altKey: true })
    await settle()
    expect(childOrder('row')).toEqual(['b', 'a', 'c'])
  })

  it('a code-valued offset refuses instead of writing', async () => {
    seed({ abs: { codeProps: ['style:left'] } })
    mount()
    select('abs')
    press(document, { key: 'ArrowRight' })
    await settle()
    // No preview either: nothing on screen may claim the layer moved.
    expect(useEditorStore.getState().previewNodeStyles).toBeNull()
    release(document, 'ArrowRight')
    expect(node('abs').inlineStyles?.left).toBe('100px')
    expect(historyLength()).toBe(0)
  })
})
