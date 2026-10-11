import { describe, expect, it } from 'bun:test'
import type { FrameGeometrySnapshot, NodeGeometry } from '@site/canvas/frameGeometry/frameGeometryTypes'
import { FrameGeometryIndex } from '@site/canvas/frameGeometry/frameGeometryIndex'

function node(nodeId: string, x: number, y: number, width: number, height: number, parent: number, extra: Partial<NodeGeometry> = {}): NodeGeometry {
  return { nodeId, rect: { x, y, width, height }, parent, clips: false, inert: false, transformed: false, paint: 0, ...extra }
}

function snapshot(nodes: NodeGeometry[], extra: Partial<FrameGeometrySnapshot> = {}): FrameGeometrySnapshot {
  return { origin: { x: 0, y: 0 }, nodes, truncated: false, ...extra }
}

/** body > page > [header, main > [card > label, aside], footer] */
function page(): FrameGeometrySnapshot {
  return snapshot([
    node('body', 0, 0, 400, 600, -1),
    node('page', 0, 0, 400, 600, 0),
    node('header', 0, 0, 400, 60, 1),
    node('main', 0, 60, 400, 440, 1),
    node('card', 20, 80, 200, 100, 3),
    node('label', 30, 90, 80, 20, 4),
    node('aside', 240, 80, 140, 300, 3),
    node('footer', 0, 500, 400, 100, 1),
  ])
}

describe('FrameGeometryIndex — hit testing', () => {
  const ids = (index: FrameGeometryIndex, x: number, y: number) => index.nodesAt({ x, y }).map((hit) => hit.nodeId)

  it('lists every node under a point, deepest first, ending at the page root', () => {
    const index = FrameGeometryIndex.fromSnapshot(page(), { x: 0, y: 0 })
    expect(ids(index, 40, 95)).toEqual(['label', 'card', 'main', 'page', 'body'])
    expect(ids(index, 300, 200)).toEqual(['aside', 'main', 'page', 'body'])
    expect(ids(index, 10, 10)).toEqual(['header', 'page', 'body'])
    expect(index.hitTest({ x: 40, y: 95 })?.nodeId).toBe('label')
  })

  it('is empty outside every box', () => {
    const index = FrameGeometryIndex.fromSnapshot(page(), { x: 0, y: 0 })
    expect(index.nodesAt({ x: 900, y: 900 })).toEqual([])
    expect(index.hitTest({ x: -5, y: 10 })).toBeNull()
  })

  it('is half-open like the browser: the left and top edges hit, the right and bottom edges do not', () => {
    const index = FrameGeometryIndex.fromSnapshot(snapshot([node('a', 10, 10, 20, 20, -1), node('b', 30, 10, 20, 20, -1)]), { x: 0, y: 0 })
    expect(ids(index, 10, 10)).toEqual(['a'])
    expect(ids(index, 29.999, 10)).toEqual(['a'])
    // The shared edge belongs to the node on its right, not to both.
    expect(ids(index, 30, 10)).toEqual(['b'])
    expect(ids(index, 30, 30)).toEqual([])
  })

  it('orders overlapping siblings by paint rank, then by document order', () => {
    const index = FrameGeometryIndex.fromSnapshot(
      snapshot([
        node('root', 0, 0, 100, 100, -1),
        node('first', 10, 10, 50, 50, 0),
        node('second', 10, 10, 50, 50, 0),
        node('raised', 10, 10, 50, 50, 0, { paint: 1 }),
        node('behind', 10, 10, 50, 50, 0, { paint: -1 }),
      ]),
      { x: 0, y: 0 },
    )
    expect(ids(index, 20, 20)).toEqual(['raised', 'second', 'first', 'behind', 'root'])
  })

  it('a stacking branch decides for all its descendants, not each node alone', () => {
    // `low` has a tall paint rank only on its CHILD; `high` branch wins because branches compare where they diverge.
    const index = FrameGeometryIndex.fromSnapshot(
      snapshot([
        node('root', 0, 0, 100, 100, -1),
        node('low', 0, 0, 100, 100, 0),
        node('lowChild', 0, 0, 100, 100, 1, { paint: 99 }),
        node('high', 0, 0, 100, 100, 0, { paint: 3 }),
        node('highChild', 0, 0, 100, 100, 3),
      ]),
      { x: 0, y: 0 },
    )
    expect(ids(index, 50, 50)).toEqual(['highChild', 'high', 'lowChild', 'low', 'root'])
  })

  it('skips pointer-events:none / visibility:hidden nodes but still reaches their hittable descendants', () => {
    const index = FrameGeometryIndex.fromSnapshot(
      snapshot([node('root', 0, 0, 100, 100, -1), node('veil', 0, 0, 100, 100, 0, { inert: true }), node('button', 10, 10, 30, 30, 1)]),
      { x: 0, y: 0 },
    )
    expect(ids(index, 5, 5)).toEqual(['root'])
    expect(ids(index, 20, 20)).toEqual(['button', 'root'])
  })

  it('a clipping ancestor hides the part of a descendant that sticks out of it', () => {
    const index = FrameGeometryIndex.fromSnapshot(
      snapshot([
        node('root', 0, 0, 300, 100, -1),
        node('scroller', 0, 0, 100, 100, 0, { clips: true }),
        node('wide', 0, 0, 300, 50, 1),
        node('free', 0, 60, 100, 40, 0),
      ]),
      { x: 0, y: 0 },
    )
    expect(ids(index, 50, 20)).toEqual(['wide', 'scroller', 'root'])
    // x=200 is inside `wide`'s box but outside `scroller`, which clips it.
    expect(ids(index, 200, 20)).toEqual(['root'])
  })

  it('does not clip through an ancestor that does not clip', () => {
    const index = FrameGeometryIndex.fromSnapshot(snapshot([node('root', 0, 0, 100, 100, -1), node('overflowing', 0, 0, 50, 50, 0), node('child', 0, 0, 300, 50, 1)]), { x: 0, y: 0 })
    expect(ids(index, 200, 20)).toEqual(['child'])
  })

  it('marks a hit approximate when the node or an ancestor is transformed, or the read was truncated', () => {
    const turned = FrameGeometryIndex.fromSnapshot(snapshot([node('spin', 0, 0, 100, 100, -1, { transformed: true }), node('inside', 10, 10, 20, 20, 0)]), { x: 0, y: 0 })
    expect(turned.nodesAt({ x: 15, y: 15 }).map((hit) => hit.approximate)).toEqual([true, true])
    const plain = FrameGeometryIndex.fromSnapshot(snapshot([node('a', 0, 0, 100, 100, -1)]), { x: 0, y: 0 })
    expect(plain.hitTest({ x: 5, y: 5 })?.approximate).toBe(false)
    const cut = FrameGeometryIndex.fromSnapshot(snapshot([node('a', 0, 0, 100, 100, -1)], { truncated: true }), { x: 0, y: 0 })
    expect(cut.truncated).toBe(true)
    expect(cut.hitTest({ x: 5, y: 5 })?.approximate).toBe(true)
  })
})

describe('FrameGeometryIndex — board space', () => {
  it('answers in board units: rects and hits are shifted by the frame origin and the body offset', () => {
    // The frame sits at board (1000, 500); its body is inset 8px inside the frame viewport.
    const index = FrameGeometryIndex.fromSnapshot(
      snapshot([node('page', 0, 0, 200, 100, -1), node('card', 10, 10, 50, 50, 0)], { origin: { x: 8, y: 0 } }),
      { x: 1000, y: 500 },
    )
    expect(index.rectOf('card')).toEqual({ x: 1018, y: 510, width: 50, height: 50 })
    expect(index.bounds()).toEqual({ x: 1008, y: 500, width: 200, height: 100 })
    expect(index.hitTest({ x: 1020, y: 520 })?.nodeId).toBe('card')
    expect(index.hitTest({ x: 1020, y: 520 })?.rect).toEqual({ x: 1018, y: 510, width: 50, height: 50 })
    // Frame-local (12, 12) is NOT on the card once the body inset is accounted for.
    expect(index.hitTest({ x: 1012, y: 512 })?.nodeId).toBe('page')
  })

  it('moving a frame is O(1) and does not rebuild: the same index answers at the new origin', () => {
    const index = FrameGeometryIndex.fromSnapshot(page(), { x: 0, y: 0 })
    expect(index.hitTest({ x: 40, y: 95 })?.nodeId).toBe('label')
    index.setOrigin({ x: 300, y: -200 })
    expect(index.hitTest({ x: 40, y: 95 })).toBeNull()
    expect(index.hitTest({ x: 340, y: -105 })?.nodeId).toBe('label')
    expect(index.rectOf('label')).toEqual({ x: 330, y: -110, width: 80, height: 20 })
    expect(index.origin).toEqual({ x: 300, y: -200 })
  })
})

describe('FrameGeometryIndex — other queries', () => {
  it('ancestorsOf walks listed parents nearest first', () => {
    const index = FrameGeometryIndex.fromSnapshot(page(), { x: 0, y: 0 })
    expect(index.ancestorsOf('label')).toEqual(['card', 'main', 'page', 'body'])
    expect(index.ancestorsOf('body')).toEqual([])
    expect(index.ancestorsOf('nope')).toEqual([])
  })

  it('nodesIn returns the nodes a rectangle overlaps in document order, and edge contact is not overlap', () => {
    const index = FrameGeometryIndex.fromSnapshot(page(), { x: 0, y: 0 })
    expect(index.nodesIn({ x: 30, y: 85, width: 10, height: 10 })).toEqual(['body', 'page', 'main', 'card', 'label'])
    // Touches `header`'s bottom edge (y = 60) and nothing above it.
    expect(index.nodesIn({ x: 450, y: 0, width: 10, height: 10 })).toEqual([])
    expect(index.nodesIn({ x: 0, y: 60, width: 5, height: 5 })).not.toContain('header')
  })

  it('has / rectOf / bounds on an empty frame', () => {
    const index = FrameGeometryIndex.fromSnapshot(snapshot([]), { x: 5, y: 5 })
    expect(index.nodeCount).toBe(0)
    expect(index.bounds()).toBeNull()
    expect(index.has('x')).toBe(false)
    expect(index.rectOf('x')).toBeNull()
    expect(index.nodesAt({ x: 0, y: 0 })).toEqual([])
  })

  it('a duplicate node id resolves to its first box', () => {
    const index = FrameGeometryIndex.fromSnapshot(snapshot([node('dup', 0, 0, 10, 10, -1), node('dup', 50, 50, 10, 10, -1)]), { x: 0, y: 0 })
    expect(index.rectOf('dup')).toEqual({ x: 0, y: 0, width: 10, height: 10 })
  })
})

describe('FrameGeometryIndex — a snapshot from another process is not trusted', () => {
  it('drops non-finite and negative rects and re-roots children past a dropped parent', () => {
    const index = FrameGeometryIndex.fromSnapshot(
      snapshot([node('root', 0, 0, 100, 100, -1), node('bad', Number.NaN, 0, 10, 10, 0), node('child', 10, 10, 20, 20, 1), node('neg', 0, 0, -5, 5, 0)]),
      { x: 0, y: 0 },
    )
    expect(index.nodeCount).toBe(2)
    expect(index.has('bad')).toBe(false)
    expect(index.has('neg')).toBe(false)
    expect(index.ancestorsOf('child')).toEqual(['root'])
  })

  it('treats a parent that is not an earlier entry as no parent instead of looping or reading out of range', () => {
    const index = FrameGeometryIndex.fromSnapshot(snapshot([node('a', 0, 0, 10, 10, 5), node('b', 0, 0, 10, 10, 1), node('c', 0, 0, 10, 10, -7)]), { x: 0, y: 0 })
    expect(index.ancestorsOf('a')).toEqual([])
    expect(index.ancestorsOf('b')).toEqual([])
    expect(index.ancestorsOf('c')).toEqual([])
    expect(index.nodesAt({ x: 5, y: 5 }).length).toBe(3)
  })

  it('survives a non-finite origin', () => {
    const index = FrameGeometryIndex.fromSnapshot(snapshot([node('a', 0, 0, 10, 10, -1)], { origin: { x: Number.NaN, y: Infinity } }), { x: 0, y: 0 })
    expect(index.hitTest({ x: 5, y: 5 })?.nodeId).toBe('a')
  })
})

describe('FrameGeometryIndex — speed', () => {
  it('builds a 3000-node frame and answers 10000 point queries well inside a frame budget', () => {
    const nodes: NodeGeometry[] = [node('root', 0, 0, 1200, 20000, -1)]
    for (let i = 1; i < 3000; i += 1) nodes.push(node(`n${i}`, (i * 37) % 1000, (i * 53) % 19000, 120, 60, Math.max(0, i - 1 - ((i * 7) % 5))))
    const start = performance.now()
    const index = FrameGeometryIndex.fromSnapshot(snapshot(nodes), { x: 0, y: 0 })
    const built = performance.now() - start
    const queryStart = performance.now()
    let found = 0
    for (let i = 0; i < 10000; i += 1) if (index.hitTest({ x: (i * 13) % 1200, y: (i * 31) % 20000 })) found += 1
    const queried = performance.now() - queryStart
    expect(found).toBeGreaterThan(0)
    // Generous: a CI box is slow; the real numbers are single-digit ms and ~1 ms.
    expect(built).toBeLessThan(150)
    expect(queried / 10000).toBeLessThan(0.2)
  })
})
