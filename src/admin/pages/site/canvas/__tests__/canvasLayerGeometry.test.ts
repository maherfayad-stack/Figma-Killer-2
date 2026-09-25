/**
 * P5-G — the free canvas's board geometry: the surface window, which layers
 * mount in it, the pointer hit test, and a client point in board units. Pure
 * arithmetic, so it is pinned here rather than left to the e2e.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  canvasLayerAtPoint,
  canvasLayerRects,
  canvasLayerWindow,
  clientToBoardPoint,
  forgetCanvasLayerSize,
  layerMeetsWindow,
  setCanvasLayerSize,
} from '../BoardCanvasLayer/canvasLayerGeometry'

afterEach(() => {
  for (const id of ['cla000000000', 'clb000000000', 'clc000000000']) forgetCanvasLayerSize(id)
})

describe('canvasLayerWindow', () => {
  it('covers the viewport plus the margin, in board units, snapped outward to the grid', () => {
    const area = canvasLayerWindow({ zoom: 1, panX: 0, panY: 0, width: 1000, height: 800 }, 600)
    expect(area).toEqual({ x: -1024, y: -1024, width: 3072, height: 2560 })
  })

  it('grows in board units as the view zooms out — the same screen margin covers more board', () => {
    const near = canvasLayerWindow({ zoom: 1, panX: 0, panY: 0, width: 1000, height: 800 }, 600)
    const far = canvasLayerWindow({ zoom: 0.25, panX: 0, panY: 0, width: 1000, height: 800 }, 600)
    expect(far.width).toBeGreaterThan(near.width * 2)
  })

  it('does not move for a small pan — a re-fit costs nothing until the grid is crossed', () => {
    const a = canvasLayerWindow({ zoom: 1, panX: 0, panY: 0, width: 1000, height: 800 }, 600)
    const b = canvasLayerWindow({ zoom: 1, panX: -40, panY: 30, width: 1000, height: 800 }, 600)
    expect(b).toEqual(a)
  })
})

describe('layer rects and hit testing', () => {
  it('only a measured, visible layer has a rect, and the topmost unlocked one is hit', () => {
    setCanvasLayerSize('cla000000000', { width: 100, height: 50 })
    setCanvasLayerSize('clb000000000', { width: 100, height: 50 })
    const rects = canvasLayerRects([
      { id: 'cla000000000', x: 0, y: 0 },
      { id: 'clb000000000', x: 50, y: 20 },
      { id: 'clc000000000', x: 0, y: 0 },
    ])
    expect(rects.map((rect) => rect.id)).toEqual(['cla000000000', 'clb000000000'])
    expect(canvasLayerAtPoint(rects, { x: 60, y: 30 }, new Set())?.id).toBe('clb000000000')
    expect(canvasLayerAtPoint(rects, { x: 60, y: 30 }, new Set(['clb000000000']))?.id).toBe('cla000000000')
    expect(canvasLayerAtPoint(rects, { x: 500, y: 500 }, new Set())).toBeNull()
  })

  it('a hidden layer is never hit', () => {
    setCanvasLayerSize('cla000000000', { width: 100, height: 50 })
    expect(canvasLayerRects([{ id: 'cla000000000', x: 0, y: 0, hidden: true }])).toEqual([])
  })

  it('mounts a layer that meets the window, and an unmeasured one generously', () => {
    const area = { x: 0, y: 0, width: 1000, height: 1000 }
    setCanvasLayerSize('cla000000000', { width: 100, height: 50 })
    expect(layerMeetsWindow({ id: 'cla000000000', x: 950, y: 10 }, area)).toBe(true)
    expect(layerMeetsWindow({ id: 'cla000000000', x: 1200, y: 10 }, area)).toBe(false)
    expect(layerMeetsWindow({ id: 'clc000000000', x: -1500, y: 10 }, area)).toBe(true)
  })
})

describe('clientToBoardPoint', () => {
  it('reads a client point against the board origin element, through the zoom', () => {
    expect(clientToBoardPoint({ x: 300, y: 200 }, { left: 100, top: 50 }, 0.5)).toEqual({ x: 400, y: 300 })
  })
})
