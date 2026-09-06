/**
 * Pure-function tests for the two halves of Layers-tree windowing:
 * `layerRows.ts` (tree -> flat row list) and `rowWindow.ts` (row list + scroll
 * geometry -> mounted slice). Neither touches React, the store, or the DOM.
 */
import { describe, it, expect } from 'bun:test'
import {
  computeRowSpans,
  findLayerRowIndex,
  flattenLayerRows,
  subtreeRowRange,
} from '@site/panels/DomPanel/layerRows'
import { computeRowWindow } from '@site/panels/DomPanel/rowWindow'

type Tree = Record<string, { children: string[] }>

const TREE: Tree = {
  body: { children: ['a', 'b'] },
  a: { children: ['a1', 'a2'] },
  a1: { children: ['a1x'] },
  a1x: { children: [] },
  a2: { children: [] },
  b: { children: ['b1'] },
  b1: { children: [] },
}

const NONE: ReadonlySet<string> = new Set<string>()

describe('flattenLayerRows', () => {
  it('walks only expanded branches', () => {
    const rows = flattenLayerRows(TREE, ['body'], NONE, 'body')
    expect(rows.map((r) => r.nodeId)).toEqual(['body', 'a', 'b'])
  })

  it('forces the always-expanded node open regardless of the expansion set', () => {
    const rows = flattenLayerRows(TREE, ['body'], NONE, 'body')
    expect(rows[0].expanded).toBe(true)
    // …and does not force it when it is not the designated root (VC mode,
    // where the body is hidden and its children are the roots).
    expect(flattenLayerRows(TREE, ['body'], NONE, null)).toHaveLength(1)
  })

  it('is O(visible rows): a fully collapsed 40k-node tree flattens to one row', () => {
    const wide: Tree = { body: { children: [] } }
    for (let i = 0; i < 40_000; i += 1) {
      const id = `n${i}`
      wide.body.children.push(id)
      wide[id] = { children: [] }
    }
    // Root collapsed (not the always-expanded node) — one row, no walk.
    expect(flattenLayerRows(wide, ['body'], NONE, null)).toHaveLength(1)
  })

  it('records depth, sibling position and set size for the flat-DOM ARIA contract', () => {
    const rows = flattenLayerRows(TREE, ['body'], new Set(['a']), 'body')
    expect(rows.map((r) => [r.nodeId, r.depth, r.posInSet, r.setSize])).toEqual([
      ['body', 0, 1, 1],
      ['a', 1, 1, 2],
      ['a1', 2, 1, 2],
      ['a2', 2, 2, 2],
      ['b', 1, 2, 2],
    ])
  })

  it('reports the end of each row\'s visible subtree', () => {
    const rows = flattenLayerRows(TREE, ['body'], new Set(['a', 'a1']), 'body')
    // body a a1 a1x a2 b
    expect(rows.map((r) => r.nodeId)).toEqual(['body', 'a', 'a1', 'a1x', 'a2', 'b'])
    expect(rows[0].subtreeEnd).toBe(6) // body owns everything
    expect(rows[1].subtreeEnd).toBe(5) // a owns a1, a1x, a2
    expect(rows[2].subtreeEnd).toBe(4) // a1 owns a1x
    expect(rows[5].subtreeEnd).toBe(6) // b is a leaf here (collapsed)
  })

  it('renders multiple roots (Visual Component mode hides the structural body)', () => {
    const rows = flattenLayerRows(TREE, ['a', 'b'], NONE, null)
    expect(rows.map((r) => r.nodeId)).toEqual(['a', 'b'])
    expect(rows.map((r) => r.depth)).toEqual([0, 0])
  })

  it('survives a cyclic tree instead of recursing forever', () => {
    const cyclic: Tree = {
      a: { children: ['b'] },
      b: { children: ['a'] },
    }
    const rows = flattenLayerRows(cyclic, ['a'], new Set(['a', 'b']), null)
    expect(rows.map((r) => r.nodeId)).toEqual(['a', 'b'])
  })

  it('skips ids with no node (a stale child pointer mid-edit)', () => {
    const rows = flattenLayerRows(TREE, ['body', 'ghost'], NONE, 'body')
    expect(rows.map((r) => r.nodeId)).toEqual(['body', 'a', 'b'])
  })
})

describe('findLayerRowIndex / subtreeRowRange', () => {
  const rows = flattenLayerRows(TREE, ['body'], new Set(['a', 'a1']), 'body')

  it('finds a visible row and reports -1 for a collapsed one', () => {
    expect(findLayerRowIndex(rows, 'a1x')).toBe(3)
    expect(findLayerRowIndex(rows, 'b1')).toBe(-1)
  })

  it('returns the row span a node covers, for drag-source dimming', () => {
    expect(subtreeRowRange(rows, 'a')).toEqual({ start: 1, end: 5 })
    expect(subtreeRowRange(rows, 'b1')).toBeNull()
  })
})

describe('computeRowSpans', () => {
  const rows = flattenLayerRows(TREE, ['body'], new Set(['a', 'a1']), 'body')

  it('marks first/middle/last of a multi-row span', () => {
    const spans = computeRowSpans(rows, (row) => row.nodeId === 'a')
    expect(spans).toEqual([undefined, 'start', 'middle', 'middle', 'end', undefined])
  })

  it('marks a one-row span as single so it keeps all four corners', () => {
    const spans = computeRowSpans(rows, (row) => row.nodeId === 'b')
    expect(spans[5]).toBe('single')
  })

  it('lets a nested span win over the one containing it', () => {
    const spans = computeRowSpans(rows, (row) => row.nodeId === 'a' || row.nodeId === 'a1')
    // a1 covers rows 2-3 and is applied after a, so those two read as their own span.
    expect(spans[2]).toBe('start')
    expect(spans[3]).toBe('end')
  })
})

describe('computeRowWindow', () => {
  const base = { rowCount: 1000, rowHeight: 28, viewportHeight: 560, overscan: 8 }

  it('mounts the viewport plus overscan at the top of the list', () => {
    const w = computeRowWindow({ ...base, scrollOffset: 0 })
    expect(w.start).toBe(0)
    expect(w.end).toBe(29) // ceil(560/28)=20, +1 partial, +8 overscan
    expect(w.padTopPx).toBe(0)
    expect(w.padBottomPx).toBe((1000 - 29) * 28)
  })

  it('keeps total height constant as the window moves', () => {
    for (const scrollOffset of [0, 280, 5_000, 27_000]) {
      const w = computeRowWindow({ ...base, scrollOffset })
      const mounted = (w.end - w.start) * base.rowHeight
      expect(w.padTopPx + mounted + w.padBottomPx).toBe(1000 * 28)
    }
  })

  it('mounts nothing when the list has scrolled entirely above the viewport', () => {
    const w = computeRowWindow({ ...base, scrollOffset: 1000 * 28 + 5_000 })
    expect(w.end - w.start).toBe(0)
    expect(w.padTopPx + w.padBottomPx).toBe(1000 * 28)
  })

  it('mounts nothing when the list still sits entirely below the viewport', () => {
    const w = computeRowWindow({ ...base, scrollOffset: -50_000 })
    expect(w.end - w.start).toBe(0)
    expect(w.padTopPx).toBe(0)
    expect(w.padBottomPx).toBe(1000 * 28)
  })

  it('mounts EVERYTHING when the row height cannot be measured', () => {
    const w = computeRowWindow({ ...base, rowHeight: 0, scrollOffset: 0 })
    expect(w).toEqual({ start: 0, end: 1000, padTopPx: 0, padBottomPx: 0 })
  })

  it('mounts EVERYTHING when there is no scroll viewport', () => {
    const w = computeRowWindow({ ...base, viewportHeight: 0, scrollOffset: 0 })
    expect(w).toEqual({ start: 0, end: 1000, padTopPx: 0, padBottomPx: 0 })
  })

  it('handles an empty list', () => {
    const w = computeRowWindow({ ...base, rowCount: 0, scrollOffset: 0 })
    expect(w).toEqual({ start: 0, end: 0, padTopPx: 0, padBottomPx: 0 })
  })

  it('never returns end < start', () => {
    for (const scrollOffset of [-1e6, -1, 0, 1, 1e6]) {
      const w = computeRowWindow({ ...base, scrollOffset })
      expect(w.end).toBeGreaterThanOrEqual(w.start)
    }
  })
})
