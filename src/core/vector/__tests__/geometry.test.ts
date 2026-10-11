/**
 * Property tests for the curve maths: split keeps the curve, bounds agree with
 * brute force, nearest point agrees with brute force, arcs land on their
 * ellipse, and a freehand circle fits in a handful of cubics.
 */
import { describe, expect, it } from 'bun:test'
import {
  arcToCubics,
  cubicAt,
  cubicBounds,
  decimalsForScale,
  distance,
  fitCubics,
  flattenCubic,
  formatPathNumber,
  nearestOnCubic,
  quadAt,
  quadBounds,
  quadToCubic,
  simplifyDouglasPeucker,
  simplifyRadial,
  splitCubic,
  splitQuad,
  type Cubic,
  type Point,
  type Quad,
} from '@core/vector'

/** A deterministic pseudo-random sequence, so a property failure reproduces. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const random = seeded(7)
const point = (): Point => ({ x: random() * 200 - 100, y: random() * 200 - 100 })
const cubics: Cubic[] = Array.from({ length: 40 }, () => [point(), point(), point(), point()])

describe('split', () => {
  it('traces exactly the original cubic on both sides of t', () => {
    let worst = 0
    for (const cubic of cubics) {
      for (const t of [0.1, 0.37, 0.5, 0.83]) {
        const [left, right] = splitCubic(cubic, t)
        for (let i = 0; i <= 50; i += 1) {
          const u = i / 50
          const expected = cubicAt(cubic, u)
          const actual = u <= t ? cubicAt(left, u / t) : cubicAt(right, (u - t) / (1 - t))
          worst = Math.max(worst, distance(expected, actual))
        }
      }
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('does the same for a quadratic, and degree elevation is exact', () => {
    const quad: Quad = [{ x: 0, y: 0 }, { x: 50, y: 90 }, { x: 100, y: 0 }]
    const [left, right] = splitQuad(quad, 0.4)
    const cubic = quadToCubic(quad)
    for (let i = 0; i <= 20; i += 1) {
      const u = i / 20
      const expected = quadAt(quad, u)
      const actual = u <= 0.4 ? quadAt(left, u / 0.4) : quadAt(right, (u - 0.4) / 0.6)
      expect(distance(expected, actual)).toBeLessThan(1e-9)
      expect(distance(expected, cubicAt(cubic, u))).toBeLessThan(1e-9)
    }
  })
})

describe('bounds', () => {
  it('contains every sampled point and is no larger than the sampled extremes', () => {
    for (const cubic of cubics) {
      const box = cubicBounds(cubic)
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i <= 10_000; i += 1) {
        const p = cubicAt(cubic, i / 10_000)
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
      }
      expect(box.minX).toBeLessThanOrEqual(minX + 1e-9)
      expect(box.maxX).toBeGreaterThanOrEqual(maxX - 1e-9)
      expect(minX - box.minX).toBeLessThan(1e-3)
      expect(box.maxX - maxX).toBeLessThan(1e-3)
      expect(minY - box.minY).toBeLessThan(1e-3)
      expect(box.maxY - maxY).toBeLessThan(1e-3)
    }
  })

  it('finds a quadratic extremum inside the endpoints', () => {
    expect(quadBounds([{ x: 0, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 0 }])).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 })
  })
})

describe('nearestOnCubic', () => {
  it('agrees with a brute-force search to within a hundredth of a unit', () => {
    for (const cubic of cubics.slice(0, 15)) {
      for (let k = 0; k < 5; k += 1) {
        const target = point()
        let brute = Infinity
        for (let i = 0; i <= 20_000; i += 1) brute = Math.min(brute, distance(cubicAt(cubic, i / 20_000), target))
        expect(nearestOnCubic(cubic, target).distance).toBeLessThan(brute + 1e-2)
      }
    }
  })
})

describe('flattenCubic', () => {
  it('keeps every chord within the tolerance of the curve', () => {
    const cubic = cubics[0]!
    const points = flattenCubic(cubic, 0.25)
    expect(points[0]).toEqual(cubic[0])
    expect(points[points.length - 1]).toEqual(cubic[3])
    for (let i = 0; i <= 200; i += 1) {
      const p = cubicAt(cubic, i / 200)
      const nearest = Math.min(...points.slice(1).map((q, j) => {
        const a = points[j]!
        const dx = q.x - a.x
        const dy = q.y - a.y
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
        return distance(p, { x: a.x + dx * t, y: a.y + dy * t })
      }))
      expect(nearest).toBeLessThan(0.5)
    }
  })
})

describe('arcToCubics', () => {
  it('ends exactly at the endpoints and stays on the circle', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 20, y: 0 }
    const pieces = arcToCubics(from, { rx: 10, ry: 10, rotation: 0, largeArc: false, sweep: true }, to)
    expect(pieces.length).toBe(2)
    expect(pieces[0]![0]).toEqual(from)
    expect(pieces[pieces.length - 1]![3]).toEqual(to)
    for (const piece of pieces) {
      for (let i = 0; i <= 10; i += 1) {
        expect(Math.abs(distance(cubicAt(piece, i / 10), { x: 10, y: 0 }) - 10)).toBeLessThan(0.01)
      }
    }
  })

  it('scales up radii too small to reach, draws a line for a zero radius, and nothing for coincident ends', () => {
    const scaled = arcToCubics({ x: 0, y: 0 }, { rx: 1, ry: 1, rotation: 0, largeArc: false, sweep: false }, { x: 10, y: 0 })
    expect(scaled[scaled.length - 1]![3]).toEqual({ x: 10, y: 0 })
    for (const piece of scaled) expect(Math.abs(distance(cubicAt(piece, 0.5), { x: 5, y: 0 }) - 5)).toBeLessThan(0.01)
    expect(arcToCubics({ x: 0, y: 0 }, { rx: 0, ry: 5, rotation: 0, largeArc: false, sweep: false }, { x: 3, y: 4 })).toHaveLength(1)
    expect(arcToCubics({ x: 1, y: 1 }, { rx: 5, ry: 5, rotation: 0, largeArc: true, sweep: true }, { x: 1, y: 1 })).toEqual([])
  })
})

describe('simplify + fitCubics', () => {
  const circle: Point[] = Array.from({ length: 400 }, (_, i) => {
    const angle = (i / 399) * Math.PI * 2
    return { x: 100 + 100 * Math.cos(angle), y: 100 + 100 * Math.sin(angle) }
  })

  it('fits a traced circle in at most 12 cubics within 1.5 px', () => {
    const kept = simplifyDouglasPeucker(simplifyRadial(circle, 0.5), 0.6)
    const fitted = fitCubics(kept, 1.5)
    expect(fitted.length).toBeGreaterThan(0)
    expect(fitted.length).toBeLessThanOrEqual(12)
    for (const p of circle) {
      const nearest = Math.min(...fitted.map((cubic) => nearestOnCubic(cubic, p).distance))
      expect(nearest).toBeLessThan(1.5)
    }
  })

  it('does the same for a jittery hand-drawn circle', () => {
    const jitter = seeded(3)
    const scribble = circle.map((p) => ({ x: p.x + (jitter() - 0.5) * 0.6, y: p.y + (jitter() - 0.5) * 0.6 }))
    const fitted = fitCubics(simplifyDouglasPeucker(simplifyRadial(scribble, 0.5), 0.6), 1.5)
    expect(fitted.length).toBeLessThanOrEqual(12)
  })

  it('returns nothing for fewer than two distinct points', () => {
    expect(fitCubics([{ x: 1, y: 1 }, { x: 1, y: 1 }], 1)).toEqual([])
  })
})

describe('precision', () => {
  it.each([
    [1, 0, 1],
    [0.5, 0, 2],
    [0.1, 0, 2],
    [10, 0, 0],
    [0.001, 0, 3],
    [10, 4, 4],
    [Number.NaN, 0, 3],
  ])('%p user units per px, source %p decimals → %p', (units, source, expected) => {
    expect(decimalsForScale(units, source)).toBe(expected)
  })

  it.each([
    [1.5, 2, '1.5'],
    [0.25, 1, '0.3'],
    [-0.0001, 2, '0'],
    [12, 3, '12'],
    [0.5, 3, '0.5'],
  ])('formats %p at %p decimals as %p', (value, decimals, expected) => {
    expect(formatPathNumber(value, decimals)).toBe(expected)
  })
})
