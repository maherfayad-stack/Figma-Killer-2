/**
 * P5-D — the pure arithmetic behind vector edit mode and the pen: affine maps
 * between a part and the board (through a viewBox scale AND a nested
 * transform), anchors/handles of a model, hit testing, the O(1) overlay paths,
 * and the path the pen writes.
 */
import { describe, expect, it } from 'bun:test'
import { createPathModel, moveAnchor, parsePathData, serializePathModel } from '@core/vector'
import {
  anchorHandles,
  applyAffine,
  applyLinear,
  composeAffine,
  constrainTo45,
  invertAffine,
  modelAnchors,
  nearestPointIndex,
  squaresPathData,
  translation,
  type Affine,
} from '@site/canvas/BoardVectorLayer/vectorGeometry'
import { penPathData, penSvgElement, withDraggedHandle } from '@site/canvas/BoardVectorLayer/penPath'
import { inverseSvgPartEdit } from '@site/studio/svgPartCommits'

function model(d: string) {
  const parsed = parsePathData(d)
  if (!parsed.ok) throw new Error(parsed.error)
  return createPathModel(parsed.path)
}

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9)
  expect(a.y).toBeCloseTo(b.y, 9)
}

describe('part ⇄ board mapping', () => {
  // A 24-unit viewBox drawn at 48 px (scale 2), inside `<g transform="translate(3 4) rotate(90)">`,
  // in a frame whose content origin sits at board (100, 200).
  const rotate90: Affine = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 }
  const group = composeAffine(rotate90, translation(3, 4))
  const viewBox: Affine = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }
  const ctm = composeAffine(group, viewBox)
  const toBoard = composeAffine(ctm, translation(100, 200))

  it('maps a local point through every level and back', () => {
    const local = { x: 5, y: 1 }
    // rotate → (-1, 5); translate → (2, 9); viewBox ×2 → (4, 18); frame → (104, 218)
    close(applyAffine(toBoard, local), { x: 104, y: 218 })
    close(applyAffine(invertAffine(toBoard)!, { x: 104, y: 218 }), local)
  })

  it('maps a board DELTA into local units without the translation', () => {
    const toLocal = invertAffine(toBoard)!
    // 2 board px right is 1 local unit, rotated: local -y.
    close(applyLinear(toLocal, { x: 2, y: 0 }), { x: 0, y: -1 })
  })

  it('refuses a singular map', () => {
    expect(invertAffine({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 1 })).toBeNull()
  })
})

describe('anchors, handles, hit testing', () => {
  it('lists one anchor per on-curve point and the handles either side of one', () => {
    const m = model('M0 0C10 0 20 10 20 20S30 40 40 40')
    expect(modelAnchors(m, 0).map((a) => a.segment)).toEqual([0, 1, 2])
    const handles = anchorHandles(m, 0, 1)
    expect(handles.map((h) => [h.segment, h.handle])).toEqual([[1, 'c2'], [2, 'c1']])
    close(handles[0]!.local, { x: 20, y: 10 })
    close(handles[1]!.local, { x: 20, y: 30 }) // the S's reflected handle
  })

  it('finds the nearest point within the radius, or nothing', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10.5, y: 0.5 }]
    expect(nearestPointIndex(points, { x: 10.4, y: 0.4 }, 2)).toBe(2)
    expect(nearestPointIndex(points, { x: 50, y: 50 }, 2)).toBe(-1)
  })

  it('draws every anchor as ONE path, however many there are', () => {
    const points = Array.from({ length: 2000 }, (_, i) => ({ x: i, y: i % 7 }))
    const d = squaresPathData(points, 4)
    expect(d.match(/M/g)?.length).toBe(2000)
    expect(d.startsWith('M-4 -4h8v8h-8z')).toBe(true)
  })

  it('constrains a drag to 45°', () => {
    close(constrainTo45({ x: 10, y: 1 }), { x: 10, y: 0 })
    const diag = constrainTo45({ x: 10, y: 9 })
    expect(diag.x).toBeCloseTo(diag.y, 9)
  })

  it('a drag of one anchor on a 2,000-anchor path re-emits only its two segments, byte for byte elsewhere', () => {
    const d = `M0 0${Array.from({ length: 1999 }, (_, i) => `l${(i % 5) + 1} ${(i % 3) - 1}`).join('')}`
    const start = model(d)
    const moved = serializePathModel(moveAnchor(start, 1000, { x: 3, y: -2 }), { decimals: 2 })
    expect(moved.changed).toEqual([1000, 1001])
    expect(moved.d.length - d.length).toBeLessThan(8)
  })
})

describe('the pen', () => {
  it('writes corners as lines and a dragged point as a symmetric curve', () => {
    const smooth = withDraggedHandle({ point: { x: 50, y: 0 } }, { x: 60, y: 10 }, false)
    expect(smooth.in).toEqual({ x: 40, y: -10 })
    expect(penPathData([{ point: { x: 0, y: 0 } }, smooth, { point: { x: 100, y: 0 } }], false)).toBe(
      'M0 0C0 0 40 -10 50 0C60 10 100 0 100 0',
    )
    expect(penPathData([{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }, { point: { x: 10, y: 10 } }], true)).toBe(
      'M0 0L10 0L10 10L0 0Z',
    )
  })

  it('⌥ keeps the incoming handle where it was', () => {
    const broken = withDraggedHandle({ point: { x: 50, y: 0 }, in: { x: 45, y: 5 } }, { x: 60, y: 10 }, true)
    expect(broken.in).toEqual({ x: 45, y: 5 })
  })

  it('becomes an svg sized to the ink plus the stroke, with D5 defaults and the path moved to its origin', () => {
    const element = penSvgElement([{ point: { x: 10.2, y: 20 } }, { point: { x: 40, y: 50.6 } }], false)!
    expect(element.origin).toEqual({ x: 9, y: 19 })
    expect(element.props).toEqual({
      width: 32,
      height: 33,
      viewBox: '0 0 32 33',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })
    expect(element.d).toBe('M1.2 1L31 31.6')
    // One point is not a path: nothing is written.
    expect(penSvgElement([{ point: { x: 0, y: 0 } }], false)).toBeNull()
  })
})

describe('svg-attr undo', () => {
  it('puts back what was there and removes what was not', () => {
    const inverse = inverseSvgPartEdit({
      hostNodeId: 'src/Icon.tsx:3:6',
      part: '5:8',
      partTag: 'path',
      set: { d: 'M1 1', fill: 'red' },
      remove: ['stroke'],
      previous: { d: 'M0 0', fill: undefined, stroke: 'blue' },
    })
    expect(inverse).toEqual({
      kind: 'svg-attr',
      nodeId: 'src/Icon.tsx:3:6',
      part: '5:8',
      partTag: 'path',
      set: { d: 'M0 0', stroke: 'blue' },
      remove: ['fill'],
    })
  })
})
