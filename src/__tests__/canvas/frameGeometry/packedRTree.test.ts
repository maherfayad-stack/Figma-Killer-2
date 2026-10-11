import { describe, expect, it } from 'bun:test'
import { PackedRTree } from '@site/canvas/frameGeometry/packedRTree'

/** A small deterministic generator, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function randomBoxes(count: number, seed: number): number[] {
  const next = random(seed)
  const boxes: number[] = []
  for (let i = 0; i < count; i += 1) {
    const x = next() * 1000
    const y = next() * 1000
    // Mix of tiny, medium and page-sized boxes, like a real frame.
    const scale = next() < 0.1 ? 600 : next() < 0.5 ? 120 : 20
    boxes.push(x, y, x + next() * scale, y + next() * scale)
  }
  return boxes
}

function bruteSearch(boxes: number[], minX: number, minY: number, maxX: number, maxY: number): number[] {
  const hits: number[] = []
  for (let i = 0; i < boxes.length / 4; i += 1) {
    if (boxes[i * 4 + 2]! < minX || boxes[i * 4]! > maxX || boxes[i * 4 + 3]! < minY || boxes[i * 4 + 1]! > maxY) continue
    hits.push(i)
  }
  return hits
}

function treeSearch(tree: PackedRTree, minX: number, minY: number, maxX: number, maxY: number): number[] {
  const hits: number[] = []
  tree.search(minX, minY, maxX, maxY, (i) => hits.push(i))
  return hits.sort((a, b) => a - b)
}

describe('PackedRTree', () => {
  it('an empty tree finds nothing', () => {
    const tree = new PackedRTree([])
    expect(tree.size).toBe(0)
    expect(treeSearch(tree, -1e9, -1e9, 1e9, 1e9)).toEqual([])
  })

  it('a single box is found by a point inside it and missed by one outside', () => {
    const tree = new PackedRTree([10, 10, 20, 20])
    const hits: number[] = []
    tree.searchPoint(15, 15, (i) => hits.push(i))
    expect(hits).toEqual([0])
    hits.length = 0
    tree.searchPoint(25, 15, (i) => hits.push(i))
    expect(hits).toEqual([])
  })

  it('edges are inclusive for the raw search', () => {
    const tree = new PackedRTree([10, 10, 20, 20])
    expect(treeSearch(tree, 20, 20, 30, 30)).toEqual([0])
    expect(treeSearch(tree, 20.001, 20.001, 30, 30)).toEqual([])
  })

  // Sizes straddle the node size (16), its square (256) and several tree heights.
  for (const count of [2, 15, 16, 17, 255, 256, 257, 1000, 4000]) {
    it(`matches a brute-force scan over ${count} random boxes, for points and rectangles`, () => {
      const boxes = randomBoxes(count, count)
      const tree = new PackedRTree(boxes)
      expect(tree.size).toBe(count)
      const next = random(count * 7)
      for (let query = 0; query < 60; query += 1) {
        const x = next() * 1100 - 50
        const y = next() * 1100 - 50
        expect(treeSearch(tree, x, y, x, y)).toEqual(bruteSearch(boxes, x, y, x, y))
        const w = next() * 300
        const h = next() * 300
        expect(treeSearch(tree, x, y, x + w, y + h)).toEqual(bruteSearch(boxes, x, y, x + w, y + h))
      }
    })
  }

  it('returns every item exactly once for a query that covers the whole space', () => {
    const boxes = randomBoxes(500, 3)
    const tree = new PackedRTree(boxes)
    expect(treeSearch(tree, -1e9, -1e9, 1e9, 1e9)).toEqual(Array.from({ length: 500 }, (_, i) => i))
  })

  it('handles identical and zero-size boxes', () => {
    const boxes: number[] = []
    for (let i = 0; i < 40; i += 1) boxes.push(5, 5, 5, 5)
    for (let i = 0; i < 40; i += 1) boxes.push(0, 0, 100, 100)
    const tree = new PackedRTree(boxes)
    expect(treeSearch(tree, 5, 5, 5, 5)).toEqual(Array.from({ length: 80 }, (_, i) => i))
    expect(treeSearch(tree, 50, 50, 50, 50)).toEqual(Array.from({ length: 40 }, (_, i) => 40 + i))
  })

  it('does not keep or mutate the array it was built from', () => {
    const boxes = randomBoxes(100, 9)
    const copy = [...boxes]
    const tree = new PackedRTree(boxes)
    boxes.fill(0)
    expect(treeSearch(tree, -1e9, -1e9, 1e9, 1e9)).toHaveLength(100)
    expect(copy).not.toEqual(boxes)
  })
})
