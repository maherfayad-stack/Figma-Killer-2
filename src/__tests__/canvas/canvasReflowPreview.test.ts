/**
 * K6's reflow preview — which siblings make room for a drop, and how far.
 *
 * Two things are being pinned here, and the second matters more than the
 * first.
 *
 * 1. **The arithmetic**, against heterogeneous children. A uniform "everything
 *    moves by one row" would pass a fixture where every child is the same
 *    height and be wrong on every real page, so every fixture below has
 *    children of DIFFERENT sizes.
 * 2. **The silences.** The preview is an animation drawn over the user's own
 *    layout, so a case the packing model does not describe must produce
 *    nothing at all rather than a plausible-looking lie. A wrapped flex line,
 *    a child with no measured box, and a reversed container are the three, and
 *    each has a test that would fail the moment someone "improved" the model
 *    into guessing.
 */
import { describe, it, expect } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import type { CanvasDropCandidate } from '@site/canvas/canvasDnd'
import { resolveCanvasReflowShifts, REFLOW_SHIFT_LIMIT } from '@site/canvas/canvasReflowPreview'
import { makeNode, makePage } from '../fixtures'
import '@modules/base/index'

const ROOT = 'home:body'
const LIST = 'pages/Home.tsx:4:5'
const A = 'pages/Home.tsx:5:7'
const B = 'pages/Home.tsx:8:7'
const C = 'pages/Home.tsx:11:7'
const OTHER = 'pages/Home.tsx:20:5'
const OTHER_CHILD = 'pages/Home.tsx:21:7'

/** A vertical stack: 100px, 40px and 60px tall, with a 10px gap between each. */
function verticalTree(): NodeTree<PageNode> {
  return makePage({
    id: 'home',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', children: [LIST, OTHER] }),
      [LIST]: makeNode({ id: LIST, moduleId: 'base.container', children: [A, B, C], parentId: ROOT }),
      [A]: makeNode({ id: A, moduleId: 'base.text', parentId: LIST }),
      [B]: makeNode({ id: B, moduleId: 'base.text', parentId: LIST }),
      [C]: makeNode({ id: C, moduleId: 'base.text', parentId: LIST }),
      [OTHER]: makeNode({ id: OTHER, moduleId: 'base.container', children: [OTHER_CHILD], parentId: ROOT }),
      [OTHER_CHILD]: makeNode({ id: OTHER_CHILD, moduleId: 'base.text', parentId: OTHER }),
    },
  })
}

function candidate(
  nodeId: string,
  top: number,
  height: number,
  overrides: Partial<CanvasDropCandidate> = {},
): CanvasDropCandidate {
  return {
    nodeId,
    depth: 1,
    axis: 'vertical',
    rect: { left: 0, top, right: 300, bottom: top + height, width: 300, height },
    ...overrides,
  }
}

/** A: 0–100, B: 110–150, C: 160–220. Gap 10. */
function verticalCandidates(): CanvasDropCandidate[] {
  return [candidate(A, 0, 100), candidate(B, 110, 40), candidate(C, 160, 60)]
}

const BASE = {
  tree: verticalTree(),
  candidates: verticalCandidates(),
  parentId: LIST,
  draggedIds: [A],
  draggedExtent: 100,
  originParentId: LIST,
  copy: false,
}

describe('resolveCanvasReflowShifts — a reorder inside one container', () => {
  it('slides the siblings the dragged element passes, by ITS extent plus the gap', () => {
    // A (100 tall) leaves the top and lands between B and C: `moveNode`
    // removes it first, so index 1 names "after B" in [B, C].
    const shifts = resolveCanvasReflowShifts({ ...BASE, tree: verticalTree(), index: 1 })

    expect(shifts.map((shift) => shift.nodeId)).toEqual([B])
    // B closes the 110px hole A left (100 + 10) and moves to the top.
    expect(shifts[0]!.dy).toBeCloseTo(-110, 5)
    // C is exactly where it was: the hole above it closed and the placeholder
    // reopened the same amount.
    expect(shifts.some((shift) => shift.nodeId === C)).toBe(false)
  })

  it('moves nothing when the element is dropped back where it already is', () => {
    expect(resolveCanvasReflowShifts({ ...BASE, tree: verticalTree(), index: 0 })).toEqual([])
  })

  it('carries the sibling’s OWN extent, not the dragged one’s, into the pack', () => {
    // B (40 tall) moves to the top; C then starts at 40 + 10 = 50 instead of
    // 160. A uniform-stride model would have said 110 for both.
    const shifts = resolveCanvasReflowShifts({
      ...BASE,
      tree: verticalTree(),
      draggedIds: [B],
      draggedExtent: 40,
      index: 2,
    })
    const c = shifts.find((shift) => shift.nodeId === C)
    expect(c?.dy).toBeCloseTo(-50, 5)
  })
})

describe('resolveCanvasReflowShifts — Alt, and a second container', () => {
  it('opens room without closing any, because a copy leaves the original in place', () => {
    const shifts = resolveCanvasReflowShifts({ ...BASE, tree: verticalTree(), index: 1, copy: true })
    // Nothing is removed, so B and C both move down by the placeholder.
    expect(shifts.map((shift) => shift.nodeId).sort()).toEqual([B, C].sort())
    for (const shift of shifts) expect(shift.dy).toBeCloseTo(110, 5)
  })

  it('closes the ORIGIN list as well when the drop lands in another container', () => {
    const shifts = resolveCanvasReflowShifts({
      ...BASE,
      tree: verticalTree(),
      candidates: [...verticalCandidates(), candidate(OTHER_CHILD, 300, 50)],
      parentId: OTHER,
      index: 0,
      draggedIds: [A],
      draggedExtent: 100,
    })
    const byId = new Map(shifts.map((shift) => [shift.nodeId, shift]))
    // The destination opens up by the dragged extent alone: that container has
    // ONE child, so there is no spacing between two of them to observe, and
    // `packingGap` deliberately assumes none rather than inventing one.
    expect(byId.get(OTHER_CHILD)?.dy).toBeCloseTo(100, 5)
    // ...and the list A left closes behind it, by its own observed 10px gap.
    expect(byId.get(B)?.dy).toBeCloseTo(-110, 5)
    expect(byId.get(C)?.dy).toBeCloseTo(-110, 5)
  })

  it('never previews the ORIGIN list across frames — that layer is not the one being painted', () => {
    const shifts = resolveCanvasReflowShifts({
      ...BASE,
      tree: verticalTree(),
      candidates: [...verticalCandidates(), candidate(OTHER_CHILD, 300, 50)],
      parentId: OTHER,
      index: 0,
      originParentId: null,
    })
    expect(shifts.map((shift) => shift.nodeId)).toEqual([OTHER_CHILD])
  })
})

describe('resolveCanvasReflowShifts — a horizontal row', () => {
  it('shifts along x and leaves y alone', () => {
    const row = (nodeId: string, left: number, width: number): CanvasDropCandidate => ({
      nodeId,
      depth: 1,
      axis: 'horizontal',
      rect: { left, top: 0, right: left + width, bottom: 80, width, height: 80 },
    })
    const shifts = resolveCanvasReflowShifts({
      ...BASE,
      tree: verticalTree(),
      candidates: [row(A, 0, 50), row(B, 60, 30), row(C, 100, 70)],
      draggedIds: [C],
      draggedExtent: 70,
      index: 0,
    })
    const byId = new Map(shifts.map((shift) => [shift.nodeId, shift]))
    expect(byId.get(A)?.dx).toBeCloseTo(80, 5)
    expect(byId.get(A)?.dy).toBe(0)
    expect(byId.get(B)?.dx).toBeCloseTo(80, 5)
  })
})

describe('resolveCanvasReflowShifts — the three silences', () => {
  it('says nothing when a child has no measured box at all', () => {
    // B is a `display: contents` host / a fragment: no rect, so the pack has
    // no extent for it and every later sibling would be wrong.
    const shifts = resolveCanvasReflowShifts({
      ...BASE,
      tree: verticalTree(),
      candidates: [candidate(A, 0, 100), candidate(C, 160, 60)],
      index: 2,
    })
    expect(shifts).toEqual([])
  })

  it('says nothing about a WRAPPED line, where one axis is the wrong geometry', () => {
    // C wraps onto a second row: it starts ABOVE where B ends.
    const shifts = resolveCanvasReflowShifts({
      ...BASE,
      tree: verticalTree(),
      candidates: [candidate(A, 0, 100), candidate(B, 110, 40), candidate(C, 20, 60)],
      index: 2,
    })
    expect(shifts).toEqual([])
  })

  it('says nothing about a reversed container, where DOM order is not visual order', () => {
    const shifts = resolveCanvasReflowShifts({
      ...BASE,
      tree: verticalTree(),
      candidates: verticalCandidates().map((c) => ({ ...c, reversed: true })),
      index: 2,
    })
    expect(shifts).toEqual([])
  })

  it('never returns more boxes than the painter has pooled for it', () => {
    const many = Array.from({ length: 40 }, (_, i) => `pages/Home.tsx:${100 + i}:7`)
    const tree = makePage({
      id: 'home',
      rootNodeId: ROOT,
      nodes: {
        [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', children: [LIST] }),
        [LIST]: makeNode({ id: LIST, moduleId: 'base.container', children: many, parentId: ROOT }),
        ...Object.fromEntries(
          many.map((id) => [id, makeNode({ id, moduleId: 'base.text', parentId: LIST })]),
        ),
      },
    })
    const shifts = resolveCanvasReflowShifts({
      tree,
      candidates: many.map((id, i) => candidate(id, i * 30, 20)),
      parentId: LIST,
      index: 0,
      draggedIds: [],
      draggedExtent: 20,
      originParentId: null,
      copy: true,
    })
    expect(shifts.length).toBe(REFLOW_SHIFT_LIMIT)
  })
})
