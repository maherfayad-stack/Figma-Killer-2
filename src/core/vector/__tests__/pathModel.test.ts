/**
 * `pathModel` — an edit rewrites the segments it changed and keeps every other
 * byte of the user's `d`.
 */
import { describe, expect, it } from 'bun:test'
import {
  anchorSegmentIndices,
  createPathModel,
  moveAnchor,
  moveHandle,
  parsePathData,
  serializePathModel,
  type PathModel,
} from '@core/vector'

function model(d: string): PathModel {
  const result = parsePathData(d)
  if (!result.ok) throw new Error(result.error)
  return createPathModel(result.path)
}

describe('createPathModel', () => {
  it('resolves relative, H/V and close to absolute geometry', () => {
    const m = model('m10 10 h5 v5 H10 z m1 1 l1 1')
    expect(m.segments.map((s) => [s.kind, s.to.x, s.to.y])).toEqual([
      ['move', 10, 10], ['line', 15, 10], ['line', 15, 15], ['line', 10, 15], ['close', 10, 10], ['move', 11, 11], ['line', 12, 12],
    ])
  })

  it('reflects the previous handle for S and T, and uses the current point otherwise', () => {
    const m = model('M0 0 C0 10 10 10 10 0 S20 -10 20 0 M0 0 S5 5 10 0 Q5 5 10 0 T20 0')
    expect(m.segments[2]!.c1).toEqual({ x: 10, y: -10 })
    expect(m.segments[4]!.c1).toEqual({ x: 0, y: 0 })
    expect(m.segments[6]!.c1).toEqual({ x: 15, y: -5 })
  })

  it('lists every on-curve point as an anchor and skips close', () => {
    expect(anchorSegmentIndices(model('M0 0 L1 1 L2 0 Z'))).toEqual([0, 1, 2])
  })
})

describe('serializePathModel', () => {
  it('gives back the source byte-for-byte when nothing moved', () => {
    const d = ' M4 4h16v16H4z m1,1 c1 1 2 2 3 3s1 1 2 2 '
    expect(serializePathModel(model(d))).toEqual({ d, changed: [] })
  })

  it('re-emits exactly two segments when an anchor moves in a relative path', () => {
    const out = serializePathModel(moveAnchor(model('m10 10 l10 0 l0 10 l-10 0 z'), 1, { x: 1, y: 1 }))
    expect(out.changed).toEqual([1, 2])
    expect(out.d).toBe('m10 10 l11 1 l-1 9 l-10 0 z')
  })

  it('re-emits only the moved segment in an absolute path of lines', () => {
    const out = serializePathModel(moveAnchor(model('M10 10 L20 10 L20 20 L10 20 Z'), 2, { x: 2, y: 0 }))
    expect(out.changed).toEqual([2])
    expect(out.d).toBe('M10 10 L20 10 L22 20 L10 20 Z')
  })

  it('turns H/V into L only when the orthogonal coordinate changed, leaving the next anchor where it was', () => {
    // The V after the moved anchor keeps its END where it was, so it is no
    // longer vertical and has to become a line.
    expect(serializePathModel(moveAnchor(model('M0 0H10V10'), 1, { x: 3, y: 0 })).d).toBe('M0 0H13L10 10')
    expect(serializePathModel(moveAnchor(model('M0 0H10V10'), 1, { x: 0, y: 2 })).d).toBe('M0 0L10 2V10')
  })

  it('gives an implicit repeat its letter when the command before it changed', () => {
    // `s… 5 5 10 0` is an implicit second `s`. Once the first `s` has to become
    // a `c`, a bare `5 5 10 0` would be read as the first half of a `c`.
    const out = serializePathModel(moveHandle(model('M0 0 c0 5 5 5 5 0 s5 -5 10 0 5 5 10 0'), 2, 'c1', { x: 1, y: 0 }))
    expect(out.changed).toEqual([2, 3])
    expect(out.d).toBe('M0 0 c0 5 5 5 5 0 c1 -5 5 -5 10 0 s5 5 10 0')
    const reparsed = model(out.d)
    expect(reparsed.segments.map((s) => s.to)).toEqual(model('M0 0 c0 5 5 5 5 0 s5 -5 10 0 5 5 10 0').segments.map((s) => s.to))
  })

  it('keeps an implicit repeat implicit while its command is unchanged', () => {
    expect(serializePathModel(moveAnchor(model('M0 0 10 0 10 10'), 1, { x: 1, y: 0 })).d).toBe('M0 0 11 0 10 10')
  })

  it('keeps S while the anchor and both its handles move together', () => {
    const out = serializePathModel(moveAnchor(model('M0 0 C0 10 10 10 10 0 S20 -10 20 0'), 1, { x: 1, y: 1 }))
    expect(out.d).toBe('M0 0 C0 10 11 11 11 1 S20 -10 20 0')
  })

  it('turns S into C once its reflected handle no longer reflects', () => {
    const out = serializePathModel(moveHandle(model('M0 0 C0 10 10 10 10 0 S20 -10 20 0'), 2, 'c1', { x: 1, y: 0 }))
    expect(out.changed).toEqual([2])
    expect(out.d).toBe('M0 0 C0 10 10 10 10 0 C11 -10 20 -10 20 0')
  })

  it('carries a close with a moved subpath start and rewrites the relative move after it', () => {
    const out = serializePathModel(moveAnchor(model('M0 0 L10 0 L10 10 z m5 5'), 0, { x: 1, y: 0 }))
    expect(out.d).toBe('M1 0 L10 0 L10 10 z m4 5')
  })

  it('keeps an arc an arc, moving only its endpoint', () => {
    expect(serializePathModel(moveAnchor(model('M0 0 a5 5 0 01 10 0'), 1, { x: 2, y: 0 })).d).toBe('M0 0 a5 5 0 0 1 12 0')
  })

  it('never writes fewer decimals than the source segment used, and honours the requested precision', () => {
    const moved = moveAnchor(model('M0 0 L1.25 1'), 1, { x: 0.3333333, y: 0 })
    expect(serializePathModel(moved, { decimals: 1 }).d).toBe('M0 0 L1.58 1')
    expect(serializePathModel(moved, { decimals: 3 }).d).toBe('M0 0 L1.583 1')
  })

  it('keeps the source comma style for a rewritten segment', () => {
    expect(serializePathModel(moveAnchor(model('M0,0 C1,1 2,2 3,3'), 1, { x: 1, y: 0 })).d).toBe('M0,0 C1,1 3,2 4,3')
  })
})
