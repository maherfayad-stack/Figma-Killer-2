import { describe, expect, it } from 'bun:test'
import {
  anchorIsSmooth,
  createPathModel,
  cubicAt,
  insertAnchor,
  parsePathData,
  removeAnchor,
  toggleAnchorSmooth,
  type PathModel,
} from '@core/vector'

function model(d: string): PathModel {
  const parsed = parsePathData(d)
  if (!parsed.ok) throw new Error(parsed.error)
  return createPathModel(parsed.path)
}

/** Absolute on-curve points of a path, for "the shape did not move" checks. */
function anchors(d: string) {
  return model(d).segments.map((s) => ({ x: Number(s.to.x.toFixed(6)), y: Number(s.to.y.toFixed(6)) }))
}

describe('insertAnchor — an exact split, every other byte kept', () => {
  it('splits a relative line and leaves the rest of the source as written', () => {
    expect(insertAnchor(model('M4 4h16v16H4z'), 1, 0.5, 2)).toBe('M4 4 h8 h8v16H4z')
  })

  it('splits a cubic without changing the curve', () => {
    const d = 'M0 0C0 10 10 10 10 0L20 0'
    const out = insertAnchor(model(d), 1, 0.5, 3)!
    const m = model(out)
    expect(m.segments).toHaveLength(4)
    const mid = cubicAt([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }], 0.5)
    expect(m.segments[1]!.to).toEqual(mid)
    expect(out.endsWith('L20 0')).toBe(true)
  })

  it('splits the closing edge by adding a line before the Z', () => {
    expect(insertAnchor(model('M0 0L10 0L10 10Z'), 3, 0.5, 2)).toBe('M0 0L10 0L10 10 L5 5Z')
  })

  it('keeps a relative segment after the split landing where it did', () => {
    const d = 'm0 0 10 0 0 10'
    const out = insertAnchor(model(d), 1, 0.5, 2)!
    expect(anchors(out)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
  })

  it('refuses a move and an arc', () => {
    expect(insertAnchor(model('M0 0L1 1'), 0, 0.5, 2)).toBeNull()
    expect(insertAnchor(model('M0 0A5 5 0 0 1 10 0'), 1, 0.5, 2)).toBeNull()
  })
})

describe('removeAnchor', () => {
  it('joins two lines into one', () => {
    expect(removeAnchor(model('M0 0L5 0L10 0L10 10'), 1, 2)).toBe('M0 0 L10 0L10 10')
  })

  it('keeps two joined h segments an h', () => {
    expect(removeAnchor(model('M4 4 h8 h8v16H4z'), 1, 2)).toBe('M4 4 h16v16H4z')
  })

  it('drops the last point of an open path, and the point before a close', () => {
    expect(removeAnchor(model('M0 0L10 0L10 10'), 2, 2)).toBe('M0 0L10 0')
    expect(removeAnchor(model('M0 0L10 0L10 10L0 10Z'), 3, 2)).toBe('M0 0L10 0L10 10Z')
  })

  it('joins curves keeping the outer handles', () => {
    const out = removeAnchor(model('M0 0C0 5 5 10 10 10C15 10 20 5 20 0'), 1, 2)!
    expect(out).toBe('M0 0 C0 5 20 5 20 0')
  })

  it('moves the start to the next point when the first is removed', () => {
    expect(anchors(removeAnchor(model('M0 0L10 0L10 10'), 0, 2)!)).toEqual([{ x: 10, y: 0 }, { x: 10, y: 10 }])
  })

  it('refuses to leave a subpath with one point', () => {
    expect(removeAnchor(model('M0 0L10 0'), 1, 2)).toBeNull()
    expect(removeAnchor(model('M0 0L10 0'), 0, 2)).toBeNull()
  })
})

describe('toggleAnchorSmooth', () => {
  it('makes a corner smooth with collinear handles, and back to a corner', () => {
    const smooth = toggleAnchorSmooth(model('M0 0L10 10L20 0'), 1, 2)!
    const m = model(smooth)
    expect(anchorIsSmooth(m, 1)).toBe(true)
    const incoming = m.segments[1]!.c2!
    const outgoing = m.segments[2]!.c1!
    // Collinear through the anchor, along the chord (0,0)→(20,0).
    expect(incoming.y).toBeCloseTo(10, 6)
    expect(outgoing.y).toBeCloseTo(10, 6)
    expect(anchors(smooth)).toEqual(anchors('M0 0L10 10L20 0'))
    const corner = toggleAnchorSmooth(m, 1, 2)!
    expect(anchorIsSmooth(model(corner), 1)).toBe(false)
    expect(anchors(corner)).toEqual(anchors('M0 0L10 10L20 0'))
  })
})
