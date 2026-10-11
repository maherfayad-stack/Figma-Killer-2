/**
 * annotationPlacement — a new sticky note / doc lands where the user is
 * looking (the audit found it at a fixed board coordinate, off-screen and
 * stacked), and edit mode is requested exactly once per id.
 */
import { describe, it, expect } from 'bun:test'
import {
  centredAnnotationPosition,
  clearAnnotationEditRequest,
  hasAnnotationEditRequest,
  requestAnnotationEdit,
} from '@site/canvas/annotationPlacement'
import { CANVAS_TRANSFORM_LAYER_OFFSET_PX } from '@site/canvas/CanvasRulers/rulerGeometry'

const base = { zoom: 1, panX: 0, panY: 0, viewportWidth: 1000, viewportHeight: 800, width: 180, height: 120, existing: [] }

describe('centredAnnotationPosition', () => {
  it('centres the annotation in the viewport, accounting for the transform layer offset', () => {
    const { x, y } = centredAnnotationPosition(base)
    expect(x).toBe(Math.round(500 - CANVAS_TRANSFORM_LAYER_OFFSET_PX - 90))
    expect(y).toBe(Math.round(400 - CANVAS_TRANSFORM_LAYER_OFFSET_PX - 60))
  })

  it('follows pan and zoom, so a panned-away board still gets the note on screen', () => {
    const { x, y } = centredAnnotationPosition({ ...base, zoom: 0.5, panX: -4000, panY: -6000 })
    // screen centre (500, 400) → board ((500 + 4000 - 80) / 0.5, (400 + 6000 - 80) / 0.5)
    expect(x).toBe(Math.round((500 + 4000 - 80) / 0.5 - 90))
    expect(y).toBe(Math.round((400 + 6000 - 80) / 0.5 - 60))
  })

  it('steps diagonally past annotations already on that spot', () => {
    const first = centredAnnotationPosition(base)
    const second = centredAnnotationPosition({ ...base, existing: [first] })
    const third = centredAnnotationPosition({ ...base, existing: [first, second] })
    expect(second).toEqual({ x: first.x + 24, y: first.y + 24 })
    expect(third).toEqual({ x: first.x + 48, y: first.y + 48 })
  })

  it('a bigger doc created after a sticky does not cover it, whatever their top-lefts', () => {
    const sticky = { ...centredAnnotationPosition(base), w: 180, h: 120 }
    const doc = centredAnnotationPosition({ ...base, width: 360, height: 400, existing: [sticky] })
    const overlaps = doc.x < sticky.x + sticky.w && sticky.x < doc.x + 360 && doc.y < sticky.y + sticky.h && sticky.y < doc.y + 400
    expect(overlaps).toBe(false)
    // …and a third lands clear of both.
    const docBox = { ...doc, w: 360, h: 400 }
    const third = centredAnnotationPosition({ ...base, existing: [sticky, docBox] })
    for (const r of [sticky, docBox]) {
      expect(third.x < r.x + r.w && r.x < third.x + 180 && third.y < r.y + r.h && r.y < third.y + 120).toBe(false)
    }
  })
})

describe('annotation edit request', () => {
  it('is visible to the mounting view until it clears it, and only for that id', () => {
    requestAnnotationEdit('a')
    expect(hasAnnotationEditRequest('a')).toBe(true)
    expect(hasAnnotationEditRequest('b')).toBe(false)
    clearAnnotationEditRequest('b')
    expect(hasAnnotationEditRequest('a')).toBe(true)
    clearAnnotationEditRequest('a')
    expect(hasAnnotationEditRequest('a')).toBe(false)
  })
})
