import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import {
  getCanvasDropZone,
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

  it('previews a source-writeback refusal WHILE the pointer is still down (G5) — a shared-component reorder', () => {
    // Two shared-component (inlined) siblings under a plain container — a
    // structurally VALID drop position (real container, real index), but the
    // WRITE would refuse: an inlined node's markup lives in another file.
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
      // Bottom of the rect -> 'after' zone -> a real, non-no-op reorder target.
      point: { x: 50, y: 96 },
      canHaveChildren,
    })

    // The tree-shape resolver alone would have returned a valid target here
    // (real container, real index) — the refusal only appears once
    // `previewStructuralMove` is consulted.
    expect(result.target).toBeNull()
    expect(result.invalid?.overId).toBe(inlinedB)
    expect(result.invalid?.refusalMessage).toContain('shared component')
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
})
