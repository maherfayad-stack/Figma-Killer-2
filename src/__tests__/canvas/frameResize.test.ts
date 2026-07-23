/**
 * frameResize.ts — pure function unit tests.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/frameResize.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  resizeFrameRect,
  MIN_FRAME_SIZE,
  type FrameResizeRect,
} from '@site/canvas/BoardFramesLayer/frameResize'

const anchor: FrameResizeRect = { x: 100, y: 100, width: 1024, height: 800 }

describe('MIN_FRAME_SIZE', () => {
  it('is a sensible positive floor', () => {
    expect(MIN_FRAME_SIZE).toBeGreaterThan(0)
  })
})

describe('resizeFrameRect', () => {
  it('se handle grows width/height without moving x/y', () => {
    const result = resizeFrameRect(anchor, 'se', 50, 30)
    expect(result).toEqual({ x: 100, y: 100, width: 1074, height: 830 })
  })

  it('e handle grows only width', () => {
    const result = resizeFrameRect(anchor, 'e', 50, 30)
    expect(result).toEqual({ x: 100, y: 100, width: 1074, height: 800 })
  })

  it('s handle grows only height', () => {
    const result = resizeFrameRect(anchor, 's', 50, 30)
    expect(result).toEqual({ x: 100, y: 100, width: 1024, height: 830 })
  })

  it('nw handle shrinks toward the opposite corner, moving x and y', () => {
    const result = resizeFrameRect(anchor, 'nw', 50, 30)
    expect(result).toEqual({ x: 150, y: 130, width: 974, height: 770 })
  })

  it('n handle moves y and shrinks height, leaving width/x untouched', () => {
    const result = resizeFrameRect(anchor, 'n', 50, 30)
    expect(result).toEqual({ x: 100, y: 130, width: 1024, height: 770 })
  })

  it('w handle moves x and shrinks width, leaving height/y untouched', () => {
    const result = resizeFrameRect(anchor, 'w', 50, 30)
    expect(result).toEqual({ x: 150, y: 100, width: 974, height: 800 })
  })

  it('ne handle grows width and shrinks height while moving y', () => {
    const result = resizeFrameRect(anchor, 'ne', 50, 30)
    expect(result).toEqual({ x: 100, y: 130, width: 1074, height: 770 })
  })

  it('sw handle grows height and shrinks width while moving x', () => {
    const result = resizeFrameRect(anchor, 'sw', 50, 30)
    expect(result).toEqual({ x: 150, y: 100, width: 974, height: 830 })
  })

  it('clamps width to minSize when dragging se past it, without moving x/y', () => {
    const result = resizeFrameRect(anchor, 'se', -10_000, 0, MIN_FRAME_SIZE)
    expect(result).toEqual({ x: 100, y: 100, width: MIN_FRAME_SIZE, height: 800 })
  })

  it('clamps height to minSize when dragging s past it, without moving x/y', () => {
    const result = resizeFrameRect(anchor, 's', 0, -10_000, MIN_FRAME_SIZE)
    expect(result).toEqual({ x: 100, y: 100, width: 1024, height: MIN_FRAME_SIZE })
  })

  it('clamps width to minSize when dragging w (or nw) past it, re-anchoring x to the fixed opposite edge', () => {
    const result = resizeFrameRect(anchor, 'w', 10_000, 0, MIN_FRAME_SIZE)
    // The frame's right edge (anchor.x + anchor.width) must stay fixed.
    expect(result.width).toBe(MIN_FRAME_SIZE)
    expect(result.x + result.width).toBe(anchor.x + anchor.width)
  })

  it('clamps height to minSize when dragging n past it, re-anchoring y to the fixed opposite edge', () => {
    const result = resizeFrameRect(anchor, 'n', 0, 10_000, MIN_FRAME_SIZE)
    expect(result.height).toBe(MIN_FRAME_SIZE)
    expect(result.y + result.height).toBe(anchor.y + anchor.height)
  })

  it('defaults minSize to MIN_FRAME_SIZE when omitted', () => {
    const result = resizeFrameRect(anchor, 'se', -10_000, -10_000)
    expect(result.width).toBe(MIN_FRAME_SIZE)
    expect(result.height).toBe(MIN_FRAME_SIZE)
  })

  it('supports a custom minSize', () => {
    const result = resizeFrameRect(anchor, 'se', -10_000, -10_000, 50)
    expect(result.width).toBe(50)
    expect(result.height).toBe(50)
  })
})
