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
  isAutoLayout,
  nudgeStylePatch,
  planFlowNudge,
  planNudge,
  reanchorsAbsoluteDescendant,
  reorderStep,
  resolveArrowSelectionMove,
  type ArrowParentLayout,
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

describe('a flow layer nudges through `position: relative` (canvas-48)', () => {
  const flow = (overrides: Partial<ArrowTargetStyle> = {}) =>
    ownStyle({ position: 'static', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto', ...overrides })

  it('a static layer is promoted, and moves from zero on the arrow axis only', () => {
    const plan = planFlowNudge(flow(), new Set())
    expect(nudgeStylePatch(plan, 0, -1)).toEqual({ position: 'relative', top: '-1px' })
    expect(nudgeStylePatch(plan, 10, 0)).toEqual({ position: 'relative', left: '10px' })
    // No move, no write — not even the promotion.
    expect(nudgeStylePatch(plan, 0, 0)).toEqual({})
  })

  it('an offset `static` ignored is pinned to 0 so the promotion cannot wake it', () => {
    // `left: 40px` on a static element does nothing today; `relative` would apply it.
    const authored = authoredOffsets({ classIds: [], inlineStyles: { left: '40px', bottom: '8px' } }, {})
    const plan = planFlowNudge(flow({ left: '40px', bottom: '8px' }), authored)
    expect(nudgeStylePatch(plan, 0, 1)).toEqual({ position: 'relative', left: '0px', top: '1px' })
    expect(nudgeStylePatch(plan, 1, 0)).toEqual({ position: 'relative', left: '1px', top: '0px' })
  })

  it('RTL: the inline start, which visual right shrinks', () => {
    expect(nudgeStylePatch(planFlowNudge(flow({ direction: 'rtl' }), new Set()), 1, 0)).toEqual({
      position: 'relative',
      insetInlineStart: '-1px',
    })
  })

  it('an already relative layer moves its authored offsets from their used values, and is not re-promoted', () => {
    const authored = authoredOffsets({ classIds: [], inlineStyles: { position: 'relative', top: '5px' } }, {})
    const plan = planFlowNudge(flow({ position: 'relative', top: '5px', left: '0px' }), authored)
    expect(nudgeStylePatch(plan, 0, 1)).toEqual({ top: '6px' })
    expect(nudgeStylePatch(plan, -1, 0)).toEqual({ left: '-1px' })
  })
})

describe('which parent reorders instead of nudging', () => {
  it('flex and grid, inline or not, are auto-layout; block, inline and flow-root are not', () => {
    for (const display of ['flex', 'inline-flex', 'grid', 'inline-grid']) expect(isAutoLayout(layout({ display }))).toBe(true)
    for (const display of ['block', 'inline', 'flow-root', 'table-cell', 'list-item']) expect(isAutoLayout(layout({ display }))).toBe(false)
    expect(isAutoLayout(null)).toBe(false)
  })

  it('classifies a selection: auto-layout children reorder, other flow layers nudge, sticky / box-less refuse', () => {
    const tree = makePage({
      id: 'p',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['row', 'para', 'stuck'] }),
        row: makeNode({ id: 'row', moduleId: 'base.container', children: ['cell'] }),
        cell: makeNode({ id: 'cell', moduleId: 'base.container' }),
        para: makeNode({ id: 'para', moduleId: 'base.container' }),
        stuck: makeNode({ id: 'stuck', moduleId: 'base.container' }),
      },
    })
    const staticOwn = ownStyle({ position: 'static' })
    const measured = (entries: [string, Partial<{ own: ArrowTargetStyle; layout: ArrowParentLayout | null; boxed: boolean }>][]) =>
      new Map(entries.map(([id, m]) => [id, { own: staticOwn, layout: layout(), boxed: true, ...m }] as const))

    const reorder = resolveArrowSelectionMove(tree, measured([['cell', { layout: layout({ display: 'flex' }) }]]), undefined)
    expect(reorder?.kind).toBe('reorder')

    const nudge = resolveArrowSelectionMove(tree, measured([['para', {}]]), undefined)
    expect(nudge?.kind).toBe('nudge')
    if (nudge?.kind === 'nudge') expect(nudgeStylePatch(nudge.plans.get('para')!, 0, 1)).toEqual({ position: 'relative', top: '1px' })

    // Mixed: the flow nudge wins, the flex child stays put.
    const mixed = resolveArrowSelectionMove(tree, measured([['cell', { layout: layout({ display: 'grid' }) }], ['para', {}]]), undefined)
    expect(mixed?.kind === 'nudge' && [...mixed.plans.keys()]).toEqual(['para'])

    expect(resolveArrowSelectionMove(tree, measured([['stuck', { own: ownStyle({ position: 'sticky' }) }]]), undefined)).toEqual({
      kind: 'refuse',
      nodeId: 'stuck',
      reason: 'sticky',
    })
    expect(resolveArrowSelectionMove(tree, measured([['para', { boxed: false }]]), undefined)).toEqual({
      kind: 'refuse',
      nodeId: 'para',
      reason: 'unboxed',
    })
    // The page root has nowhere to move.
    const root = resolveArrowSelectionMove(tree, measured([['root', {}]]), undefined)
    expect(root?.kind === 'reorder' && root.layouts.size).toBe(0)
  })

  it('promotion re-anchors an absolute descendant only through static layers', () => {
    const tree = makePage({
      id: 'p',
      rootNodeId: 'wrap',
      nodes: {
        wrap: makeNode({ id: 'wrap', moduleId: 'base.container', children: ['mid'] }),
        mid: makeNode({ id: 'mid', moduleId: 'base.container', children: ['pin'] }),
        pin: makeNode({ id: 'pin', moduleId: 'base.container' }),
      },
    })
    const positions = (table: Record<string, string>) => (id: string) => table[id]
    expect(reanchorsAbsoluteDescendant(tree, 'wrap', positions({ mid: 'static', pin: 'absolute' }))).toBe(true)
    // A positioned layer in between is already the pin's containing block.
    expect(reanchorsAbsoluteDescendant(tree, 'wrap', positions({ mid: 'relative', pin: 'absolute' }))).toBe(false)
    // An unmeasured (box-less) layer is walked through.
    expect(reanchorsAbsoluteDescendant(tree, 'wrap', positions({ pin: 'absolute' }))).toBe(true)
    expect(reanchorsAbsoluteDescendant(tree, 'wrap', positions({ pin: 'fixed' }))).toBe(false)
  })
})

function layout(overrides: Partial<ArrowParentLayout> = {}): ArrowParentLayout {
  return { display: 'block', flexDirection: 'row', gridAutoFlow: 'row', direction: 'ltr', gridColumns: 1, gridRows: 1, ...overrides }
}

describe('which way a reorder goes', () => {
  it('moves along the axis, reversed for *-reverse, and not at all across it', () => {
    expect(reorderStep(layout(), { dx: 0, dy: 1 })).toBe(1)
    expect(reorderStep(layout(), { dx: 0, dy: -3 })).toBe(-1)
    expect(reorderStep(layout(), { dx: 1, dy: 0 })).toBeNull()
    expect(reorderStep(layout({ display: 'flex' }), { dx: 1, dy: 0 })).toBe(1)
    expect(reorderStep(layout({ display: 'flex', flexDirection: 'row-reverse' }), { dx: 1, dy: 0 })).toBe(-1)
  })

  it('a flex column: ↓ is later, ↑ earlier, reversed for column-reverse; ← / → do nothing', () => {
    const column = layout({ display: 'flex', flexDirection: 'column' })
    expect(reorderStep(column, { dx: 0, dy: 1 })).toBe(1)
    expect(reorderStep(column, { dx: 0, dy: -10 })).toBe(-1)
    expect(reorderStep(column, { dx: 1, dy: 0 })).toBeNull()
    expect(reorderStep(layout({ display: 'flex', flexDirection: 'column-reverse' }), { dx: 0, dy: 1 })).toBe(-1)
    // RTL mirrors the inline axis only: a column is unaffected.
    expect(reorderStep({ ...column, direction: 'rtl' }, { dx: 0, dy: 1 })).toBe(1)
  })

  it('an RTL row: → is visually later, which is one place EARLIER; row-reverse under RTL flips back', () => {
    expect(reorderStep(layout({ display: 'flex', direction: 'rtl' }), { dx: 1, dy: 0 })).toBe(-1)
    expect(reorderStep(layout({ display: 'inline-flex', direction: 'rtl' }), { dx: -1, dy: 0 })).toBe(1)
    expect(reorderStep(layout({ display: 'flex', flexDirection: 'row-reverse', direction: 'rtl' }), { dx: 1, dy: 0 })).toBe(1)
    expect(reorderStep(layout({ display: 'flex', direction: 'rtl' }), { dx: 0, dy: 1 })).toBeNull()
  })

  it('a grid: ←/→ step one cell, ↑/↓ a whole row of the resolved column count (P2-C2)', () => {
    const grid = layout({ display: 'grid', gridColumns: 3, gridRows: 2 })
    expect(reorderStep(grid, { dx: 1, dy: 0 })).toBe(1)
    expect(reorderStep(grid, { dx: -10, dy: 0 })).toBe(-1)
    expect(reorderStep(grid, { dx: 0, dy: 1 })).toBe(3)
    expect(reorderStep(grid, { dx: 0, dy: -1 })).toBe(-3)
    // Column flow swaps the axes; RTL mirrors ← / →.
    expect(reorderStep({ ...grid, gridAutoFlow: 'column' }, { dx: 1, dy: 0 })).toBe(2)
    expect(reorderStep({ ...grid, gridAutoFlow: 'column' }, { dx: 0, dy: 1 })).toBe(1)
    expect(reorderStep({ ...grid, direction: 'rtl' }, { dx: 1, dy: 0 })).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// Through the dispatcher
// ---------------------------------------------------------------------------

const ROW = { display: 'flex', 'flex-direction': 'row', 'grid-auto-flow': 'row', direction: 'ltr' }
const COLUMN = { display: 'block', 'flex-direction': 'row', 'grid-auto-flow': 'row', direction: 'ltr' }
const ABSOLUTE = { position: 'absolute', direction: 'ltr', left: '100px', right: '180px', top: '40px', bottom: '60px' }
const GRID = { display: 'grid', 'flex-direction': 'row', 'grid-auto-flow': 'row', 'grid-template-columns': '80px 80px 80px', 'grid-template-rows': '40px 40px', direction: 'ltr', position: 'static' }
const GRID_CELLS = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5']
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
 * stage → [abs, right] where both are absolute; grid (3 columns) → g0 … g5.
 */
function seed(overrides: { abs?: Partial<PageNode>; right?: Partial<PageNode> } = {}) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['row', 'stage', 'grid', 'wrap', 'stuck'] }),
      wrap: makeNode({ id: 'wrap', moduleId: 'base.container', children: ['pin'] }),
      pin: makeNode({ id: 'pin', moduleId: 'base.container' }),
      stuck: makeNode({ id: 'stuck', moduleId: 'base.container' }),
      grid: makeNode({ id: 'grid', moduleId: 'base.container', children: GRID_CELLS }),
      ...Object.fromEntries(GRID_CELLS.map((id) => [id, makeNode({ id, moduleId: 'base.container' })])),
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
    tableAdapter({
      root: COLUMN, row: ROW, a: STATIC, b: STATIC, c: STATIC, stage: { ...COLUMN, position: 'relative' }, abs: ABSOLUTE, right: ABSOLUTE,
      grid: GRID, ...Object.fromEntries(GRID_CELLS.map((id) => [id, STATIC])),
      wrap: { ...COLUMN, ...STATIC }, pin: ABSOLUTE, stuck: { ...STATIC, position: 'sticky' },
    }),
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
    expect(useEditorStore.getState().previewNodeStyles?.stylesByNode).toEqual({ abs: { left: '105px' } })
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

})

const ROOT_ORDER = ['row', 'stage', 'grid', 'wrap', 'stuck']

describe('a flow layer outside flex / grid nudges by a pixel (canvas-48)', () => {
  it('↑ in a block parent: previewed, then ONE write of `position: relative` + `top`, one entry, one save; the order stays', async () => {
    mount()
    select('row')
    press(document, { key: 'ArrowUp' })
    await settle()
    press(document, { key: 'ArrowUp', repeat: true })
    expect(useEditorStore.getState().previewNodeStyles?.stylesByNode).toEqual({ row: { position: 'relative', top: '-2px' } })
    expect(historyLength()).toBe(0)
    release(document, 'ArrowUp')
    expect(node('row').inlineStyles).toMatchObject({ position: 'relative', top: '-2px' })
    expect(childOrder('root')).toEqual(ROOT_ORDER)
    expect(historyLength()).toBe(1)
    expect(saveRequests).toBe(1)
    useEditorStore.getState().undo()
    expect(node('row').inlineStyles?.position).toBeUndefined()
    expect(node('row').inlineStyles?.top).toBeUndefined()
  })

  it('⇧→ steps 10 on the inline axis', async () => {
    mount()
    select('row')
    press(document, { key: 'ArrowRight', shiftKey: true })
    await settle()
    release(document, 'ArrowRight')
    expect(node('row').inlineStyles).toMatchObject({ position: 'relative', left: '10px' })
  })

  it('an already relative layer moves its own offsets and is not re-promoted', async () => {
    mount()
    select('stage')
    press(document, { key: 'ArrowDown' })
    await settle()
    release(document, 'ArrowDown')
    // The table's `stage` resolves no `top`, so it moves from 0.
    expect(node('stage').inlineStyles).toEqual({ top: '1px' })
  })

  it('refuses when the promotion would shift an absolute descendant anchored above it', async () => {
    mount()
    select('wrap')
    press(document, { key: 'ArrowDown' })
    await settle()
    release(document, 'ArrowDown')
    await settle()
    expect(node('wrap').inlineStyles).toBeUndefined()
    expect(useEditorStore.getState().previewNodeStyles).toBeNull()
    expect(historyLength()).toBe(0)
  })

  it('refuses a sticky layer — its offsets are thresholds, not a position', async () => {
    mount()
    select('stuck')
    expect(press(document, { key: 'ArrowDown' })).toBe(true)
    await settle()
    release(document, 'ArrowDown')
    expect(node('stuck').inlineStyles).toBeUndefined()
    expect(childOrder('root')).toEqual(ROOT_ORDER)
    expect(historyLength()).toBe(0)
  })
})

function selectMany(...ids: string[]) {
  useEditorStore.setState({ selectedNodeId: ids.at(-1)!, selectedNodeIds: ids } as Parameters<typeof useEditorStore.setState>[0])
}

describe('a multi-selection moves as one gesture (P2-C2, OD-16)', () => {
  it('two absolute layers nudge by the same delta: one preview per layer, ONE entry, ONE save', async () => {
    mount()
    selectMany('abs', 'right')
    press(document, { key: 'ArrowRight' })
    await settle()
    press(document, { key: 'ArrowRight', repeat: true })
    expect(useEditorStore.getState().previewNodeStyles?.stylesByNode).toEqual({
      abs: { left: '102px' },
      right: { right: '178px' },
    })
    expect(historyLength()).toBe(0)
    release(document, 'ArrowRight')
    expect(node('abs').inlineStyles?.left).toBe('102px')
    expect(node('right').inlineStyles?.right).toBe('178px')
    expect(historyLength()).toBe(1)
    expect(saveRequests).toBe(1)
    useEditorStore.getState().undo()
    expect(node('abs').inlineStyles?.left).toBe('100px')
    expect(node('right').inlineStyles?.right).toBe('180px')
  })

  it('a mixed selection nudges its absolute layers and leaves the flow child where its row puts it', async () => {
    mount()
    selectMany('abs', 'a')
    press(document, { key: 'ArrowDown' })
    await settle()
    release(document, 'ArrowDown')
    expect(node('abs').inlineStyles?.top).toBe('41px')
    expect(childOrder('row')).toEqual(['a', 'b', 'c'])
    expect(historyLength()).toBe(1)
  })

  it('flow siblings reorder together along their row, keeping their order', async () => {
    mount()
    selectMany('a', 'b')
    press(document, { key: 'ArrowRight' })
    await settle()
    release(document, 'ArrowRight')
    expect(childOrder('row')).toEqual(['c', 'a', 'b'])
    expect(historyLength()).toBe(1)
  })

  it('a layer inside a selected layer rides with it — nothing moves twice', async () => {
    mount()
    selectMany('row', 'b')
    press(document, { key: 'ArrowDown' })
    await settle()
    release(document, 'ArrowDown')
    expect(node('row').inlineStyles).toMatchObject({ position: 'relative', top: '1px' })
    expect(node('b').inlineStyles).toBeUndefined()
    expect(childOrder('row')).toEqual(['a', 'b', 'c'])
  })

  it('⌥↓ steps the whole selection one place in its order', async () => {
    mount()
    selectMany('a', 'b')
    press(document, { key: 'ArrowDown', altKey: true })
    await settle()
    expect(childOrder('row')).toEqual(['c', 'a', 'b'])
  })
})

describe('a grid item moves a whole row on ↑ / ↓ (P2-C2)', () => {
  it('↓ moves it by the resolved column count; ← / → still step one cell', async () => {
    mount()
    select('g1')
    press(document, { key: 'ArrowDown' })
    await settle()
    release(document, 'ArrowDown')
    expect(childOrder('grid')).toEqual(['g0', 'g2', 'g3', 'g4', 'g1', 'g5'])

    press(document, { key: 'ArrowRight' })
    await settle()
    release(document, 'ArrowRight')
    expect(childOrder('grid')).toEqual(['g0', 'g2', 'g3', 'g4', 'g5', 'g1'])
    expect(historyLength()).toBe(2)
  })

  it('↓ on the last row does not move it', async () => {
    mount()
    select('g4')
    press(document, { key: 'ArrowDown' })
    await settle()
    release(document, 'ArrowDown')
    expect(childOrder('grid')).toEqual(GRID_CELLS)
    expect(historyLength()).toBe(0)
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
