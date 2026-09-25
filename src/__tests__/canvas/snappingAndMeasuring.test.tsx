/**
 * P2-E — snapping and measuring (IX-5a, IX-5b, IX-24, IX-19).
 *
 *   - IX-5a  snap thresholds were fixed in rect units (6 frame px for a free
 *            move, 8 board units for furniture): 24 screen px of pull at 400%,
 *            1.5 px at 25%. They are screen px ÷ zoom now.
 *   - IX-5b  a free move snapped to its siblings only; the parent's edges and
 *            centre are peers too.
 *   - IX-24  a before/after drop line never said WHICH container it lands in;
 *            the parent is outlined.
 *   - IX-19  Alt with nothing hovered measured nothing; it measures the
 *            selection against its parent.
 *
 * IX-6e (resize snapping) is pinned in `elementResizeDrag.test.tsx`, beside
 * the rest of the resize hook. happy-dom has no layout: every rect here is
 * stubbed, and the computed-layout half of each claim is
 * `tests/e2e/snapping-and-measuring.e2e.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { createBoard } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { resolveFreeMove, stepFreeMove, type FreeMovePlan } from '@site/canvas/canvasFreeMove'
import { DEFAULT_SNAP_PREFERENCES } from '@site/canvas/snapPreferences'
import { useAnnotationInteraction } from '@site/canvas/useAnnotationInteraction'
import { useCanvasReorderDrag } from '@site/canvas/useCanvasReorderDrag'
import { paintCanvasDrag } from '@site/canvas/canvasDragPainter'
import { dropParentOutlineRect } from '@site/canvas/canvasDropParentOutline'
import { resolveMeasureTarget } from '@site/canvas/canvasMeasureGeometry'
import { MeasureLayer } from '@site/canvas/MeasureLayer'
import {
  flowStartAnchored,
  resizeSnapEdges,
  snapResizeDelta,
  type FlowLayoutInput,
} from '@site/canvas/elementResizeSnap'
import {
  registerFrameAdapter,
  unregisterFrameAdapter,
} from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter, NodeMeasurement } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect
}

// ---------------------------------------------------------------------------
// IX-5a — screen-px thresholds
// ---------------------------------------------------------------------------

function freePlan(overrides: Partial<Omit<FreeMovePlan, 'members'>> = {}): FreeMovePlan {
  return {
    members: [{
      nodeId: 'n',
      element: {} as HTMLElement,
      offsets: {
        horizontal: [{ property: 'left', sign: 1, base: 100 }],
        vertical: [{ property: 'top', sign: 1, base: 100 }],
      },
      needsAbsolute: false,
    }],
    peers: [],
    snap: {},
    rect: { x: 100, y: 100, width: 50, height: 20 },
    ...overrides,
  }
}

/** The `left` a step lands on — the plan's first horizontal offset moved by the snapped delta. */
function leftAt(plan: FreeMovePlan, step: { dx: number }): number {
  const [term] = plan.members[0]!.offsets.horizontal
  return term!.base + term!.sign * step.dx
}

describe('IX-5a — a free move pulls by the same SCREEN distance at every zoom', () => {
  // The moved rect's left edge lands at 130; a sibling's left edge sits 10
  // frame px further on (y far away, so only the x axis can snap).
  const peer = { x: 140, y: 900, width: 50, height: 20 }

  it('at 50%, a peer 10 frame px (5 screen px) away snaps', () => {
    const plan = freePlan({ peers: [peer] })
    const step = stepFreeMove(plan, 30, 0, 0.5)
    expect(leftAt(plan, step)).toBe(140)
    expect(step.guides.some((guide) => guide.axis === 'x' && guide.position === 140)).toBe(true)
  })

  it('at 100%, the same 10 px is too far', () => {
    const plan = freePlan({ peers: [peer] })
    const step = stepFreeMove(plan, 30, 0, 1)
    expect(leftAt(plan, step)).toBe(130)
    expect(step.guides).toEqual([])
  })

  it('at 200%, a peer 5 frame px (10 screen px) away does NOT snap', () => {
    const near = { x: 135, y: 900, width: 50, height: 20 }
    const plan = freePlan({ peers: [near] })
    const step = stepFreeMove(plan, 30, 0, 2)
    expect(leftAt(plan, step)).toBe(130)
  })
})

describe('IX-5a — board furniture pulls by screen px too', () => {
  function seedBoard(zoom: number) {
    const board = createBoard('b1', 'Board')
    board.frames.push({ id: 'f1', pageId: 'p1', x: 112, y: 1000, width: 400, height: 300 })
    useEditorStore.setState({
      boards: { version: 1, boards: [board] },
      activeBoardId: 'b1',
      zoom,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  function dragNoteTo(clientX: number) {
    const moves: Array<[number, number]> = []
    const { result } = renderHook(() =>
      useAnnotationInteraction({
        ref: { kind: 'note', id: 'n1' },
        rect: { x: 0, y: 0, w: 100, h: 60 },
        onMove: (x, y) => moves.push([x, y]),
      }),
    )
    const target = { setPointerCapture: () => {} }
    act(() => {
      result.current.startMove({ pointerId: 1, clientX: 0, clientY: 0, currentTarget: target } as never)
      result.current.onMovePointerMove({ pointerId: 1, clientX, clientY: 0 } as never)
    })
    return moves.at(-1)
  }

  it('at 50%, a note 12 board units from a frame edge (6 screen px) snaps to it', () => {
    seedBoard(0.5)
    // 50 screen px at 50% = 100 board units: the note's left edge lands at
    // 100, twelve short of the frame's left edge at 112.
    expect(dragNoteTo(50)).toEqual([112, 0])
  })

  it('at 100%, the same 12 units is 12 screen px — too far', () => {
    seedBoard(1)
    expect(dragNoteTo(100)).toEqual([100, 0])
  })
})

// ---------------------------------------------------------------------------
// IX-5b — the parent is a snap peer
// ---------------------------------------------------------------------------

describe('IX-5b — a free move snaps to its parent padding and content box', () => {
  function seedFreeMove() {
    const page = makePage({
      id: 'home',
      rootNodeId: 'stage',
      nodes: {
        stage: makeNode({ id: 'stage', moduleId: 'base.container', children: ['abs'] }),
        abs: makeNode({ id: 'abs', moduleId: 'base.container', parentId: 'stage' }),
      },
    })
    const stage = document.createElement('div')
    stage.setAttribute('data-node-id', 'stage')
    stage.setAttribute('style', 'position: relative; padding: 20px')
    const abs = document.createElement('div')
    abs.setAttribute('data-node-id', 'abs')
    abs.setAttribute('style', 'position: absolute; left: 50px; top: 30px')
    stage.appendChild(abs)
    document.body.appendChild(stage)
    const resolution = resolveFreeMove({
      doc: document,
      tree: page,
      nodeIds: ['abs'],
      candidates: [
        { nodeId: 'stage', depth: 0, axis: 'vertical', rect: { left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 } },
        { nodeId: 'abs', depth: 1, axis: 'vertical', rect: { left: 50, top: 30, right: 100, bottom: 50, width: 50, height: 20 } },
      ],
      modifierHeld: false,
      guideLines: [],
      preferences: DEFAULT_SNAP_PREFERENCES,
    })
    if (!resolution?.ok) throw new Error('expected a free move')
    return resolution.plan
  }

  it('the parent contributes its padding box and its content box', () => {
    expect(seedFreeMove().peers).toEqual([
      { x: 0, y: 0, width: 300, height: 200 },
      { x: 20, y: 20, width: 260, height: 160 },
    ])
  })

  it('dragged near the content edge, it lands flush with the content: left 20px', () => {
    // -27 puts the left edge at 23, three px from the content edge.
    const plan = seedFreeMove()
    expect(leftAt(plan, stepFreeMove(plan, -27, 0, 1))).toBe(20)
  })

  it('dragged near the padding edge, it lands at left 0', () => {
    const plan = seedFreeMove()
    expect(leftAt(plan, stepFreeMove(plan, -47, 0, 1))).toBe(0)
  })

  it('centred in the parent: the parent centre is a peer', () => {
    // Centre of the moved rect at 75 + 72 = 147; the parent centre is 150.
    const step = stepFreeMove(seedFreeMove(), 72, 0, 1)
    expect(step.rect.x + step.rect.width / 2).toBe(150)
  })
})

// ---------------------------------------------------------------------------
// IX-6e — the pure rules (the hook-level cases are in elementResizeDrag.test)
// ---------------------------------------------------------------------------

function layout(overrides: Partial<FlowLayoutInput> = {}): FlowLayoutInput {
  return {
    parentDisplay: 'block',
    flexDirection: 'row',
    justifyContent: 'normal',
    alignItems: 'normal',
    justifyItems: 'normal',
    alignSelf: 'auto',
    justifySelf: 'auto',
    direction: 'ltr',
    ...overrides,
  }
}

describe('IX-6e — which edge a resize may snap', () => {
  it('block flow keeps the start edge; a centred flex item does not', () => {
    expect(flowStartAnchored('x', layout())).toBe(true)
    expect(flowStartAnchored('x', layout({ parentDisplay: 'flex', justifyContent: 'center' }))).toBe(false)
    expect(flowStartAnchored('y', layout({ parentDisplay: 'flex', alignItems: 'center' }))).toBe(false)
    expect(flowStartAnchored('y', layout({ parentDisplay: 'flex', alignItems: 'center', alignSelf: 'flex-start' }))).toBe(true)
    expect(flowStartAnchored('x', layout({ parentDisplay: 'flex', flexDirection: 'row-reverse' }))).toBe(false)
    expect(flowStartAnchored('x', layout({ direction: 'rtl' }))).toBe(false)
  })

  it('a flow element snaps its E/S edges only; a positioned one every edge; ⌥ none', () => {
    const plain = { proportional: false, fromCenter: false }
    const anchored = { x: true, y: true }
    expect(resizeSnapEdges('se', plain, false, anchored)).toEqual({ x: 'end', y: 'end' })
    expect(resizeSnapEdges('nw', plain, false, anchored)).toEqual({ x: null, y: null })
    expect(resizeSnapEdges('nw', plain, true, anchored)).toEqual({ x: 'start', y: 'start' })
    expect(resizeSnapEdges('e', { proportional: false, fromCenter: true }, true, anchored)).toEqual({ x: null, y: null })
    expect(resizeSnapEdges('se', { proportional: true, fromCenter: false }, true, anchored)).toEqual({ x: null, y: null })
    expect(resizeSnapEdges('e', { proportional: true, fromCenter: false }, true, anchored)).toEqual({ x: 'end', y: null })
  })

  it('snaps the pointer so the edge lands on the peer, and draws the guide there', () => {
    const step = snapResizeDelta(
      { x: 'end', y: null },
      { x: 0, y: 0, width: 100, height: 40 },
      17,
      5,
      [{ x: 0, y: 200, width: 120, height: 10 }],
      8,
    )
    expect(step.dx).toBe(20)
    expect(step.dy).toBe(5)
    expect(step.guides).toEqual([{ axis: 'x', position: 120, start: 0, end: 210 }])
  })
})

// ---------------------------------------------------------------------------
// IX-24 — the drop target's parent is outlined
// ---------------------------------------------------------------------------

describe('IX-24 — a before/after drop outlines the container it lands in', () => {
  const candidates = [
    { nodeId: 'row', depth: 1, axis: 'horizontal' as const, rect: { left: 10, top: 10, right: 310, bottom: 60, width: 300, height: 50 } },
  ]

  it('names the parent rect for before/after, nothing for inside', () => {
    expect(dropParentOutlineRect({ parentId: 'row', position: 'after' }, candidates)).toEqual(candidates[0]!.rect)
    expect(dropParentOutlineRect({ parentId: 'row', position: 'inside' }, candidates)).toBeNull()
    expect(dropParentOutlineRect({ parentId: 'gone', position: 'before' }, candidates)).toBeNull()
  })

  it('the painter shows the outline for a parent and hides it without one', () => {
    const layer = document.createElement('div')
    document.body.appendChild(layer)
    paintCanvasDrag(layer, { target: null, invalid: null, ghost: null, parent: candidates[0]!.rect })
    const outline = layer.querySelector<HTMLElement>('[data-canvas-drop-parent]')!
    expect(outline.style.display).toBe('')
    expect(outline.style.getPropertyValue('--canvas-drop-w')).toBe('300px')
    paintCanvasDrag(layer, { target: null, invalid: null, ghost: null, parent: null })
    expect(outline.style.display).toBe('none')
  })

  it('a real reorder drag outlines the drop target parent', async () => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'home',
            slug: 'index',
            rootNodeId: 'root',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.container', children: ['a', 'b'] }),
              a: makeNode({ id: 'a', moduleId: 'base.text', props: { text: 'A' }, parentId: 'root' }),
              b: makeNode({ id: 'b', moduleId: 'base.text', props: { text: 'B' }, parentId: 'root' }),
            },
          }),
        ],
      }),
    )
    useEditorStore.setState({ selectedNodeId: 'a', selectedNodeIds: ['a'] })
    const viewport = document.createElement('div')
    viewport.getBoundingClientRect = () => rectOf(0, 0, 1000, 800)
    const root = document.createElement('div')
    root.setAttribute('data-node-id', 'root')
    root.getBoundingClientRect = () => rectOf(0, 0, 1000, 400)
    for (const [id, top] of [['a', 0], ['b', 100]] as const) {
      const child = document.createElement('div')
      child.setAttribute('data-node-id', id)
      child.getBoundingClientRect = () => rectOf(0, top, 1000, 100)
      root.appendChild(child)
    }
    viewport.appendChild(root)
    document.body.appendChild(viewport)

    const { result } = renderHook(() =>
      useCanvasReorderDrag({
        viewportRef: { current: viewport },
        canvasRootRef: { current: viewport },
        iframeElement: null,
        overlayRoot: null,
        selectedNodeIds: ['a'],
        enabled: true,
        bodyDragEnabled: false,
        panBy: () => {},
      }),
    )
    const layer = document.createElement('div')
    document.body.appendChild(layer)
    result.current.dropLayerRef.current = layer

    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.assign(event, { clientX: x, clientY: y, pointerId: 1, button: 0 })
      window.dispatchEvent(event)
    }
    act(() => {
      result.current.handlePointerDown({
        button: 0,
        pointerId: 1,
        clientX: 500,
        clientY: 50,
        currentTarget: viewport,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.PointerEvent<HTMLElement>)
    })
    // Into the lower half of `b`: an AFTER drop, inside `root`.
    act(() => pointer('pointermove', 500, 190))
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    expect(layer.querySelector('[data-position="after"]')).not.toBeNull()
    const outline = layer.querySelector<HTMLElement>('[data-canvas-drop-parent]')
    expect(outline?.style.display).toBe('')
    expect(outline?.style.getPropertyValue('--canvas-drop-h')).toBe('400px')
    act(() => pointer('pointerup', 500, 190))
  })
})

// ---------------------------------------------------------------------------
// IX-19 — Alt with nothing hovered measures to the parent
// ---------------------------------------------------------------------------

describe('IX-19 — what Alt measures against', () => {
  const parents: Record<string, string | null> = { root: null, card: 'root', a: 'card', b: 'card', c: 'root' }
  const parentOf = (id: string) => parents[id] ?? null

  it('a hovered node outside the selection, as before', () => {
    expect(resolveMeasureTarget({ selectedNodeIds: ['a'], hoveredNodeId: 'c', hoverSeenDuringHold: true, parentOf })).toBe('c')
  })

  it('nothing hovered → the selection parent; several → the nearest shared ancestor', () => {
    expect(resolveMeasureTarget({ selectedNodeIds: ['a'], hoveredNodeId: null, hoverSeenDuringHold: false, parentOf })).toBe('card')
    expect(resolveMeasureTarget({ selectedNodeIds: ['a', 'b'], hoveredNodeId: null, hoverSeenDuringHold: false, parentOf })).toBe('card')
    expect(resolveMeasureTarget({ selectedNodeIds: ['a', 'c'], hoveredNodeId: null, hoverSeenDuringHold: false, parentOf })).toBe('root')
    expect(resolveMeasureTarget({ selectedNodeIds: ['root'], hoveredNodeId: null, hoverSeenDuringHold: false, parentOf })).toBeNull()
  })

  it('the selection itself hovered stays the tree ladder; so does "a node was hovered this hold"', () => {
    expect(resolveMeasureTarget({ selectedNodeIds: ['a'], hoveredNodeId: 'a', hoverSeenDuringHold: true, parentOf })).toBeNull()
    expect(resolveMeasureTarget({ selectedNodeIds: ['a'], hoveredNodeId: null, hoverSeenDuringHold: true, parentOf })).toBeNull()
  })
})

describe('IX-19 — the MeasureLayer draws selection → parent with nothing hovered', () => {
  let iframe: HTMLIFrameElement
  let measured: string[][]

  beforeEach(() => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'home',
            slug: 'index',
            rootNodeId: 'root',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.container', children: ['card'] }),
              card: makeNode({ id: 'card', moduleId: 'base.container', parentId: 'root', children: ['a'] }),
              a: makeNode({ id: 'a', moduleId: 'base.text', props: { text: 'A' }, parentId: 'card' }),
            },
          }),
        ],
      }),
    )
    useEditorStore.setState({ activePageId: 'home', activeInlineEdit: null } as Parameters<typeof useEditorStore.setState>[0])
    iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    measured = []
    const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
      card: { x: 0, y: 0, width: 400, height: 200 },
      a: { x: 40, y: 30, width: 100, height: 20 },
    }
    registerFrameAdapter(
      iframe,
      {
        measure: async (refs: { nodeId: string }[]): Promise<NodeMeasurement[]> => {
          measured.push(refs.map((ref) => ref.nodeId))
          return refs.map(({ nodeId }) => ({ nodeId, rect: rects[nodeId] ?? null, computedStyle: {} }))
        },
      } as unknown as FrameDocumentAdapter,
      'desktop',
    )
  })

  afterEach(() => {
    unregisterFrameAdapter(iframe)
  })

  function mountLayer(hoveredNodeId: string | null) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const props = {
      iframeElement: iframe,
      overlayRoot: null,
      portalTarget: target,
      portalMode: 'scoped' as const,
      canvasRoot: null,
      selectedNodeIds: ['a'],
      enabled: true,
    }
    const view = render(<MeasureLayer {...props} hoveredNodeId={hoveredNodeId} />)
    return { target, rerender: (hovered: string | null) => view.rerender(<MeasureLayer {...props} hoveredNodeId={hovered} />) }
  }

  async function holdAltAndSettle() {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true }))
    })
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      })
    }
  }

  it('measures the selection against its parent, with the four insets as pills', async () => {
    const { target } = mountLayer(null)
    await holdAltAndSettle()
    expect(measured.at(-1)).toEqual(['a', 'card'])
    const labels = [...target.querySelectorAll<HTMLElement>('[data-measure-kind="distance"]')]
      .filter((label) => label.style.display !== 'none')
      .map((label) => `${label.getAttribute('data-side')}:${label.textContent}`)
    expect(labels.sort()).toEqual(['bottom:150', 'left:40', 'right:260', 'top:30'])
  })

  it('once a node was hovered in the hold, leaving the frame does not switch to the parent', async () => {
    const { target, rerender } = mountLayer('a')
    await holdAltAndSettle()
    rerender(null)
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    expect(target.querySelector('[data-canvas-measure-line]')).toBeNull()
  })
})
