/**
 * PA-1 — absolute offsets are measured against the REAL containing block.
 *
 * The inputs are the rects a browser reports (border-box, client space), so
 * the arithmetic is checked without a layout engine.
 */
import { describe, expect, it } from 'bun:test'
import {
  containingBlockOffsets,
  establishesContainingBlock,
  type ContainingBlockBox,
} from '@core/studio-runtime'

const PLAIN = { position: 'static', transform: 'none', perspective: 'none', filter: 'none', contain: 'none', willChange: 'auto' }

function block(overrides: Partial<ContainingBlockBox> = {}): ContainingBlockBox {
  return {
    rect: { left: 100, top: 200, width: 400, height: 300 },
    borderLeft: 0,
    borderTop: 0,
    borderRight: 0,
    borderBottom: 0,
    scale: 1,
    scrollLeft: 0,
    scrollTop: 0,
    ...overrides,
  }
}

describe('containingBlockOffsets', () => {
  const placed = { left: 150, top: 230, width: 50, height: 40 }

  it('measures from the block origin and reports all four insets', () => {
    expect(containingBlockOffsets(placed, block())).toEqual({ left: 50, top: 30, right: 300, bottom: 230 })
  })

  it('measures from the PADDING box: the border is not part of the offset', () => {
    expect(containingBlockOffsets(placed, block({ borderLeft: 10, borderTop: 4, borderRight: 10, borderBottom: 4 }))).toEqual({
      left: 40,
      top: 26,
      right: 290,
      bottom: 226,
    })
  })

  it('adds the block scroll offset: an absolute child scrolls with its content', () => {
    expect(containingBlockOffsets(placed, block({ scrollTop: 25 })).top).toBe(55)
  })

  it.each([0.5, 1, 2])('divides a %p scale out so the result is CSS px', (scale) => {
    // A block laid out 400x300 and rendered at `scale`; the box sits 50x30 CSS px in.
    const rendered = { left: 100 + 50 * scale, top: 200 + 30 * scale, width: 50 * scale, height: 40 * scale }
    const scaled = block({ scale, rect: { left: 100, top: 200, width: 400 * scale, height: 300 * scale } })
    expect(containingBlockOffsets(rendered, scaled)).toEqual({ left: 50, top: 30, right: 300, bottom: 230 })
  })

  it('never returns -0', () => {
    expect(Object.is(containingBlockOffsets({ left: 100, top: 200, width: 0, height: 0 }, block()).left, 0)).toBe(true)
  })
})

describe('the left:-421px class: offsetLeft against the wrong box', () => {
  // test4 SignUp -> SMS: the TabBar is absolute. A static, transformed wrapper
  // (the screen shell, shifted 421px left inside the stage) is its containing
  // block, but `offsetParent` skips it and answers the positioned stage
  // further up. The old math used `offsetLeft` against that stage.
  const stage = { left: 0, top: 0 }
  const wrapper = { left: stage.left - 421, top: 0, width: 390, height: 844 }
  const tabBar = { left: wrapper.left, top: 780, width: 390, height: 64 }

  it('the old stage-relative math yields the -421px', () => {
    expect(tabBar.left - stage.left).toBe(-421)
  })

  it('the containing-block math yields the offset inside the wrapper that really contains it', () => {
    const offsets = containingBlockOffsets(tabBar, block({ rect: wrapper }))
    expect(offsets.left).toBe(0)
    expect(offsets.top).toBe(780)
  })
})

describe('establishesContainingBlock', () => {
  it('a plain static box does not', () => {
    expect(establishesContainingBlock(PLAIN)).toBe(false)
  })

  it.each([
    ['position', { position: 'relative' }],
    ['transform', { transform: 'matrix(1, 0, 0, 1, -421, 0)' }],
    ['perspective', { perspective: '100px' }],
    ['filter', { filter: 'blur(1px)' }],
    ['contain', { contain: 'layout paint' }],
    ['will-change', { willChange: 'transform' }],
  ])('%s does', (_name, overrides) => {
    expect(establishesContainingBlock({ ...PLAIN, ...overrides })).toBe(true)
  })
})
