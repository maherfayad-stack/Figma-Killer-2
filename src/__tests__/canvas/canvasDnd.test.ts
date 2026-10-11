import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import {
  getCanvasDropZone,
  nearerSiblingSide,
  resolveCanvasInsertionTarget,
  resolveCanvasDropTarget,
  type CanvasDropCandidate,
} from '@admin/pages/site/canvas/canvasDnd'

function node(id: string, moduleId: string, children: string[] = [], locked = false): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
    locked,
  }
}

function page(nodes: Record<string, PageNode>, rootNodeId = 'root'): Page {
  reindexNodeParents(nodes)
  return {
    id: 'page',
    slug: 'index',
    title: 'Home',
    rootNodeId,
    nodes,
  }
}

function candidate(
  nodeId: string,
  depth: number,
  rect: { left: number; top: number; width: number; height: number },
  axis: 'vertical' | 'horizontal' = 'vertical',
): CanvasDropCandidate {
  return {
    nodeId,
    depth,
    axis,
    rect: {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
    },
  }
}

const canHaveChildren = (moduleId: string) =>
  moduleId === 'base.body' || moduleId === 'base.container'

describe('canvasDnd', () => {
  it('maps vertical and horizontal pointer bands to before inside and after zones', () => {
    const vertical = candidate('a', 1, { left: 0, top: 0, width: 100, height: 100 })
    const horizontal = candidate('b', 1, { left: 0, top: 0, width: 100, height: 100 }, 'horizontal')

    expect(getCanvasDropZone(vertical, { x: 50, y: 4 })).toBe('before')
    expect(getCanvasDropZone(vertical, { x: 50, y: 50 })).toBe('inside')
    expect(getCanvasDropZone(vertical, { x: 50, y: 96 })).toBe('after')
    expect(getCanvasDropZone(horizontal, { x: 4, y: 50 })).toBe('before')
    expect(getCanvasDropZone(horizontal, { x: 50, y: 50 })).toBe('inside')
    expect(getCanvasDropZone(horizontal, { x: 96, y: 50 })).toBe('after')
  })

  it('flips before/after when the candidate is reversed (G9 — row-reverse / column-reverse / RTL row)', () => {
    const reversedHorizontal = { ...candidate('c', 1, { left: 0, top: 0, width: 100, height: 100 }, 'horizontal'), reversed: true }
    const reversedVertical = { ...candidate('d', 1, { left: 0, top: 0, width: 100, height: 100 }), reversed: true }

    // Same physical points as the un-reversed case above — labels swap.
    expect(getCanvasDropZone(reversedHorizontal, { x: 4, y: 50 })).toBe('after')
    expect(getCanvasDropZone(reversedHorizontal, { x: 96, y: 50 })).toBe('before')
    expect(getCanvasDropZone(reversedHorizontal, { x: 50, y: 50 })).toBe('inside')
    expect(getCanvasDropZone(reversedVertical, { x: 50, y: 4 })).toBe('after')
    expect(getCanvasDropZone(reversedVertical, { x: 50, y: 96 })).toBe('before')
  })

  it('uses the deepest candidate under the pointer when resolving a drop', () => {
    const tree = page({
      root: node('root', 'base.body', ['outer', 'dragged']),
      outer: node('outer', 'base.container', ['inner']),
      inner: node('inner', 'base.container'),
      dragged: node('dragged', 'base.text'),
    })

    const result = resolveCanvasDropTarget({
      tree,
      draggedId: 'dragged',
      draggedIds: ['dragged'],
      candidates: [
        candidate('outer', 1, { left: 0, top: 0, width: 300, height: 300 }),
        candidate('inner', 2, { left: 20, top: 20, width: 80, height: 80 }),
      ],
      point: { x: 50, y: 50 },
      canHaveChildren,
    })

    expect(result.target?.parentId).toBe('inner')
    expect(result.target?.position).toBe('inside')
    expect(result.invalid).toBeNull()
  })

  it('returns invalid preview metadata when the pointed node cannot accept the resolved zone', () => {
    const tree = page({
      root: node('root', 'base.body', ['dragged', 'leaf']),
      dragged: node('dragged', 'base.text'),
      leaf: node('leaf', 'base.text'),
    })
    const overLeaf = candidate('leaf', 1, { left: 0, top: 0, width: 120, height: 120 })

    const result = resolveCanvasDropTarget({
      tree,
      draggedId: 'dragged',
      draggedIds: ['dragged'],
      candidates: [overLeaf],
      point: { x: 60, y: 60 },
      canHaveChildren,
    })

    expect(result.target).toBeNull()
    expect(result.invalid).toEqual({
      overId: 'leaf',
      rect: overLeaf.rect,
      axis: 'vertical',
    })
  })

  it('scales the edge-hit band by the live zoom (0.8 — collapsed drop-edge hit zones)', () => {
    // `candidate.rect` is frame-space (unscaled) — the same space at every
    // zoom level. The edge band is authored in SCREEN pixels
    // (`MIN_EDGE_HIT_ZONE_SCREEN_PX` / `MAX_EDGE_HIT_ZONE_SCREEN_PX` in
    // `canvasDnd.ts`) and must be divided by zoom before comparison, or the
    // on-screen band shrinks to nothing at low zoom and swallows the whole
    // node at high zoom.
    const rect = candidate('a', 1, { left: 0, top: 0, width: 100, height: 100 })

    // zoom omitted === 1 (100%) — unchanged baseline behaviour: the 26%-of-size
    // band (26) clamps down to the 20 (screen==frame-space at 1x) max, so a
    // point 25px from the top edge is NOT in the band.
    expect(getCanvasDropZone(rect, { x: 50, y: 25 })).toBe('inside')
    expect(getCanvasDropZone(rect, { x: 50, y: 25 }, 1)).toBe('inside')

    // zoom 0.25 (25%) — a real "surveying the whole board" zoom level. The
    // screen-space 8px minimum becomes 32 frame-space px (8 / 0.25), so the
    // SAME point 25px from the top edge now falls inside the band: it must
    // resolve 'before', not 'inside'. Before the fix this always fell to
    // 'inside' because the constant never scaled with zoom — this is
    // exactly the bug (STUDIO-FIGMA-PARITY-PLAN.md 0.8 / audit G16): at 25%
    // zoom essentially every drop resolved as 'inside'.
    expect(getCanvasDropZone(rect, { x: 50, y: 25 }, 0.25)).toBe('before')

    // zoom 4 (400%) — the screen-space 20px maximum becomes 5 frame-space px
    // (20 / 4), so a point 10px from the top edge — comfortably inside the
    // 1x/0.25x band — now falls OUTSIDE the (shrunk) band and resolves
    // 'inside'. Without the fix the band stayed a flat 20 frame-space px
    // (80 on-screen px), swallowing nearly all of a leaf node's 'inside'
    // region at high zoom.
    expect(getCanvasDropZone(rect, { x: 50, y: 10 }, 4)).toBe('inside')
    expect(getCanvasDropZone(rect, { x: 50, y: 10 }, 1)).toBe('before')

    // Non-positive zoom (unmeasured layout) must not divide-by-zero / NaN —
    // falls back to the zoom=1 band.
    expect(getCanvasDropZone(rect, { x: 50, y: 25 }, 0)).toBe('inside')
  })

  it('threads zoom through resolveCanvasDropTarget so a whole-drop resolution is zoom-correct at low zoom', () => {
    // `dragged` is a ROOT-level sibling of `container` (not inside it), so
    // resolving it 'inside' or 'before' the container is never a no-op —
    // isolates the zoom-band behaviour from `normalizeIndexAfterRemoval`'s
    // no-op short-circuit (`core/page-tree/dnd.ts`).
    const tree = page({
      root: node('root', 'base.body', ['container', 'dragged']),
      container: node('container', 'base.container', ['child']),
      child: node('child', 'base.text'),
      dragged: node('dragged', 'base.text'),
    })
    const overContainer = candidate('container', 1, { left: 0, top: 0, width: 300, height: 300 })

    // At zoom 1, 25px from the top edge resolves 'inside' the container.
    const atFullZoom = resolveCanvasDropTarget({
      tree,
      draggedId: 'dragged',
      draggedIds: ['dragged'],
      candidates: [overContainer],
      point: { x: 50, y: 25 },
      canHaveChildren,
      zoom: 1,
    })
    expect(atFullZoom.target?.position).toBe('inside')

    // At zoom 0.25, the same physical point is within the (now-wider,
    // frame-space) edge band and resolves 'before' the container instead.
    const atLowZoom = resolveCanvasDropTarget({
      tree,
      draggedId: 'dragged',
      draggedIds: ['dragged'],
      candidates: [overContainer],
      point: { x: 50, y: 25 },
      canHaveChildren,
      zoom: 0.25,
    })
    expect(atLowZoom.target?.position).toBe('before')
  })

  // OD-7 (P3-D) — a reorder inside a shared component is written to THIS
  // instance (detach, then move), so the preview shows a drop line. It used to
  // refuse `shared-component` here.
  it('shows a drop line for a reorder inside a shared component — it applies to this instance (OD-7)', () => {
    const inlinedA = 'pages/Home.tsx:10:4~ui/Card.tsx:2:4'
    const inlinedB = 'pages/Home.tsx:12:4~ui/Card.tsx:2:4'
    const tree = page({
      root: node('root', 'base.body', ['container']),
      container: node('container', 'base.container', [inlinedA, inlinedB]),
      [inlinedA]: node(inlinedA, 'base.text'),
      [inlinedB]: node(inlinedB, 'base.text'),
    })
    const overB = candidate(inlinedB, 1, { left: 0, top: 0, width: 100, height: 100 })
    const result = resolveCanvasDropTarget({
      tree,
      draggedId: inlinedA,
      draggedIds: [inlinedA],
      candidates: [overB],
      point: { x: 50, y: 96 },
      canHaveChildren,
    })
    expect(result.invalid).toBeNull()
    expect(result.target).not.toBeNull()
  })

  it('previews a source-writeback refusal WHILE the pointer is still down (G5) — a .map row', () => {
    // A `.map` row: a structurally VALID drop position (real container, real
    // index), but the WRITE would refuse — one piece of source renders every row.
    const rowA = 'pages/Home.tsx:10:4#0'
    const rowB = 'pages/Home.tsx:10:4#1'
    const tree = page({
      root: node('root', 'base.body', ['container']),
      container: node('container', 'base.container', [rowA, rowB]),
      [rowA]: node(rowA, 'base.text'),
      [rowB]: node(rowB, 'base.text'),
    })
    const overB = candidate(rowB, 1, { left: 0, top: 0, width: 100, height: 100 })

    const result = resolveCanvasDropTarget({
      tree,
      draggedId: rowA,
      draggedIds: [rowA],
      candidates: [overB],
      point: { x: 50, y: 96 },
      canHaveChildren,
    })

    expect(result.target).toBeNull()
    expect(result.invalid?.overId).toBe(rowB)
    expect(result.invalid?.constraint?.scope).toBe('gesture')
    expect(result.invalid?.constraint?.reason).toBe('list-row')
  })

  it('does not invent a refusal for an ordinary CMS (nanoid) node — refusal previews are studio-only', () => {
    const tree = page({
      root: node('root', 'base.body', ['a', 'b']),
      a: node('a', 'base.text'),
      b: node('b', 'base.text'),
    })
    const overB = candidate('b', 1, { left: 0, top: 0, width: 100, height: 100 })

    const result = resolveCanvasDropTarget({
      tree,
      draggedId: 'a',
      draggedIds: ['a'],
      candidates: [overB],
      point: { x: 50, y: 96 },
      canHaveChildren,
    })

    expect(result.target).not.toBeNull()
    expect(result.invalid).toBeNull()
  })

  it('resolves new module insertion into containers and after leaf nodes', () => {
    const tree = page({
      root: node('root', 'base.body', ['container', 'leaf']),
      container: node('container', 'base.container', ['child']),
      child: node('child', 'base.text'),
      leaf: node('leaf', 'base.text'),
    })

    const intoContainer = resolveCanvasInsertionTarget({
      tree,
      candidates: [
        candidate('container', 1, { left: 0, top: 0, width: 200, height: 120 }),
      ],
      point: { x: 100, y: 60 },
      canHaveChildren,
    })
    expect(intoContainer?.parentId).toBe('container')
    expect(intoContainer?.index).toBe(1)
    expect(intoContainer?.position).toBe('inside')

    const afterLeaf = resolveCanvasInsertionTarget({
      tree,
      candidates: [
        candidate('leaf', 1, { left: 0, top: 140, width: 200, height: 80 }),
      ],
      point: { x: 100, y: 180 },
      canHaveChildren,
    })
    expect(afterLeaf?.parentId).toBe('root')
    expect(afterLeaf?.index).toBe(2)
    expect(afterLeaf?.position).toBe('after')
  })

  describe('a press in a container empty space lands where the pointer is, not at the end', () => {
    const tree = page({
      root: node('root', 'base.body', ['main']),
      main: node('main', 'base.container', ['a', 'b', 'c']),
      a: node('a', 'base.text'),
      b: node('b', 'base.text'),
      c: node('c', 'base.text'),
    })
    const stack = [
      candidate('main', 1, { left: 0, top: 0, width: 200, height: 600 }),
      candidate('a', 2, { left: 0, top: 0, width: 200, height: 50 }),
      candidate('b', 2, { left: 0, top: 200, width: 200, height: 50 }),
      candidate('c', 2, { left: 0, top: 400, width: 200, height: 50 }),
    ]

    it('vertical flow: between the children inserts before the next child', () => {
      const target = resolveCanvasInsertionTarget({ tree, candidates: stack, point: { x: 100, y: 120 }, canHaveChildren })
      expect(target).toMatchObject({ parentId: 'main', index: 1, position: 'inside' })
    })

    it('below the last child still appends', () => {
      const target = resolveCanvasInsertionTarget({ tree, candidates: stack, point: { x: 100, y: 550 }, canHaveChildren })
      expect(target).toMatchObject({ parentId: 'main', index: 3 })
    })

    it('above the first child lands first', () => {
      const target = resolveCanvasInsertionTarget({
        tree,
        candidates: [candidate('main', 1, { left: 0, top: 0, width: 200, height: 600 }), ...stack.slice(1).map((c) => ({ ...c, rect: { ...c.rect, top: c.rect.top + 100, bottom: c.rect.bottom + 100 } }))],
        point: { x: 100, y: 40 },
        canHaveChildren,
      })
      expect(target).toMatchObject({ parentId: 'main', index: 0 })
    })

    it('horizontal flow compares x inside the pointer row, and reversed flow flips it', () => {
      const row = [
        candidate('main', 1, { left: 0, top: 0, width: 600, height: 100 }),
        candidate('a', 2, { left: 0, top: 0, width: 100, height: 50 }, 'horizontal'),
        candidate('b', 2, { left: 200, top: 0, width: 100, height: 50 }, 'horizontal'),
        candidate('c', 2, { left: 400, top: 0, width: 100, height: 50 }, 'horizontal'),
      ]
      expect(resolveCanvasInsertionTarget({ tree, candidates: row, point: { x: 320, y: 30 }, canHaveChildren })).toMatchObject({ index: 2 })
      const reversed = row.map((c, i) => (i === 0 ? c : { ...c, reversed: true }))
      expect(resolveCanvasInsertionTarget({ tree, candidates: reversed, point: { x: 320, y: 30 }, canHaveChildren })).toMatchObject({ index: 0 })
    })

    it('gives the drop line at the gap between the neighbours, not the container outline', () => {
      const target = resolveCanvasInsertionTarget({ tree, candidates: stack, point: { x: 100, y: 120 }, canHaveChildren })
      // a ends at 50, b starts at 200: the line sits at the middle of that space, across the container.
      expect(target?.gap).toEqual({
        axis: 'vertical',
        rect: { left: 0, right: 200, top: 125, bottom: 125, width: 200, height: 0 },
      })
    })

    it('the first slot is at the first child top and the append at the last child bottom', () => {
      const first = resolveCanvasInsertionTarget({
        tree,
        candidates: [candidate('main', 1, { left: 0, top: 0, width: 200, height: 600 }), ...stack.slice(1).map((c) => ({ ...c, rect: { ...c.rect, top: c.rect.top + 100, bottom: c.rect.bottom + 100 } }))],
        point: { x: 100, y: 40 },
        canHaveChildren,
      })
      expect(first?.gap?.rect).toMatchObject({ top: 100, height: 0 })
      const append = resolveCanvasInsertionTarget({ tree, candidates: stack, point: { x: 100, y: 550 }, canHaveChildren })
      expect(append?.gap?.rect).toMatchObject({ top: 450, height: 0 })
    })

    it('horizontal flow draws a vertical line down the row, between the neighbours', () => {
      const row = [
        candidate('main', 1, { left: 0, top: 0, width: 600, height: 100 }),
        candidate('a', 2, { left: 0, top: 0, width: 100, height: 50 }, 'horizontal'),
        candidate('b', 2, { left: 200, top: 10, width: 100, height: 50 }, 'horizontal'),
        candidate('c', 2, { left: 400, top: 0, width: 100, height: 50 }, 'horizontal'),
      ]
      const target = resolveCanvasInsertionTarget({ tree, candidates: row, point: { x: 320, y: 30 }, canHaveChildren })
      // index 2: between b (right edge 300) and c (left edge 400).
      expect(target?.gap).toMatchObject({ axis: 'horizontal', rect: { left: 350, right: 350, width: 0, top: 0, bottom: 60 } })
    })

    it('a drop beside a sibling keeps its own line and carries no gap', () => {
      const target = resolveCanvasInsertionTarget({ tree, candidates: stack, point: { x: 100, y: 5 }, canHaveChildren })
      expect(target?.gap).toBeUndefined()
    })

    it('with no child measured it keeps the append', () => {
      const target = resolveCanvasInsertionTarget({ tree, candidates: [stack[0]!], point: { x: 100, y: 120 }, canHaveChildren })
      expect(target).toMatchObject({ parentId: 'main', index: 3 })
    })
  })

  describe('a press on the middle of a leaf lands on the side it is nearer to (Label 2/3 off by one)', () => {
    const tree = page({
      root: node('root', 'base.body', ['main']),
      main: node('main', 'base.container', ['l1', 'l2', 'l3', 'l4']),
      l1: node('l1', 'base.text'),
      l2: node('l2', 'base.text'),
      l3: node('l3', 'base.text'),
      l4: node('l4', 'base.text'),
    })
    // Four 40px labels with a 10px gap: l3 spans y 100..140.
    const column = (axis: 'vertical' | 'horizontal', extra: Partial<CanvasDropCandidate> = {}) => {
      const at = (i: number) => (axis === 'vertical' ? { left: 0, top: i * 50, width: 200, height: 40 } : { left: i * 110, top: 0, width: 100, height: 40 })
      return [
        candidate('main', 1, { left: 0, top: 0, width: 440, height: 200 }),
        ...['l1', 'l2', 'l3', 'l4'].map((id, i) => ({ ...candidate(id, 2, at(i), axis), ...extra })),
      ]
    }

    it('the upper half of Label 3 (outside the edge band) lands BEFORE Label 3, not after it', () => {
      const target = resolveCanvasInsertionTarget({ tree, candidates: column('vertical'), point: { x: 100, y: 114 }, canHaveChildren })
      expect(target).toMatchObject({ parentId: 'main', index: 2, position: 'before', overId: 'l3' })
    })

    it('the lower half of Label 3 lands after it', () => {
      const target = resolveCanvasInsertionTarget({ tree, candidates: column('vertical'), point: { x: 100, y: 126 }, canHaveChildren })
      expect(target).toMatchObject({ parentId: 'main', index: 3, position: 'after', overId: 'l3' })
    })

    it('the exact middle goes after (the append convention)', () => {
      const target = resolveCanvasInsertionTarget({ tree, candidates: column('vertical'), point: { x: 100, y: 120 }, canHaveChildren })
      expect(target).toMatchObject({ index: 3, position: 'after' })
    })

    it('side by side: the left half of Label 3 is before, the right half after', () => {
      const row = column('horizontal')
      expect(resolveCanvasInsertionTarget({ tree, candidates: row, point: { x: 232, y: 20 }, canHaveChildren })).toMatchObject({ index: 2, position: 'before' })
      expect(resolveCanvasInsertionTarget({ tree, candidates: row, point: { x: 288, y: 20 }, canHaveChildren })).toMatchObject({ index: 3, position: 'after' })
    })

    it('a reversed flow flips the halves: the visually-near half is the later slot', () => {
      const row = column('horizontal', { reversed: true })
      const nearHalf = resolveCanvasInsertionTarget({ tree, candidates: row, point: { x: 232, y: 20 }, canHaveChildren })
      expect(nearHalf).toMatchObject({ index: 3, position: 'after', reversed: true })
      const farHalf = resolveCanvasInsertionTarget({ tree, candidates: row, point: { x: 288, y: 20 }, canHaveChildren })
      expect(farHalf).toMatchObject({ index: 2, position: 'before' })
    })

    it('the gap BETWEEN Label 2 and Label 3 (container space) is slot 2, with margins and without', () => {
      for (const gap of [0, 10, 36]) {
        const stack = [
          candidate('main', 1, { left: 0, top: 0, width: 200, height: 400 }),
          candidate('l1', 2, { left: 0, top: 0, width: 200, height: 40 }),
          candidate('l2', 2, { left: 0, top: 40 + gap, width: 200, height: 40 }),
          candidate('l3', 2, { left: 0, top: 80 + gap * 2, width: 200, height: 40 }),
          candidate('l4', 2, { left: 0, top: 120 + gap * 3, width: 200, height: 40 }),
        ]
        // The middle of the l2 | l3 gap (or, with no gap, the seam itself).
        const seam = 80 + gap * 1.5
        const target = resolveCanvasInsertionTarget({ tree, candidates: stack, point: { x: 100, y: seam }, canHaveChildren })
        expect(target?.index, `gap ${gap}`).toBe(2)
      }
    })

    it('nearerSiblingSide agrees with the target it feeds', () => {
      const [, , , l3] = column('vertical')
      expect(nearerSiblingSide(l3!, { x: 0, y: 101 })).toBe('before')
      expect(nearerSiblingSide(l3!, { x: 0, y: 139 })).toBe('after')
    })
  })
})
