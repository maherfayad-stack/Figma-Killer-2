/**
 * K6 — free movement that stays honest.
 *
 * The decision this file pins is the one the feel plan's §6 decision 6
 * deliberately narrowed: a gesture may write `left`/`top` inline, but only
 * where that declaration will actually do what the user pointed at. The three
 * cases are asserted independently, plus the RTL axis and the snapping, all
 * against plain objects — no DOM, no layout, no browser.
 */
import { describe, expect, it } from 'bun:test'
import {
  FREE_MOVE_SNAP_PX,
  freeMoveStylePatch,
  planFreeMoveProperties,
  readFreeMoveBase,
  stepFreeMove,
  type FreeMovePlan,
  type FreeMoveStyleInput,
} from '@site/canvas/canvasFreeMove'
import { isPositionedFreely } from '@core/studio-runtime'

function style(overrides: Partial<FreeMoveStyleInput> = {}): FreeMoveStyleInput {
  return {
    position: 'static',
    direction: 'ltr',
    left: 'auto',
    top: 'auto',
    insetInlineStart: 'auto',
    ...overrides,
  }
}

describe('planFreeMoveProperties — when a coordinate write is honest', () => {
  it('an already-absolute element writes left/top, and changes no position', () => {
    const plan = planFreeMoveProperties(style({ position: 'absolute', left: '10px', top: '4px' }), 'static')
    expect(plan).toEqual({ inlineProperty: 'left', inlineSign: 1, needsAbsolute: false })
  })

  it('a fixed element does not care what its parent is — the viewport contains it', () => {
    expect(planFreeMoveProperties(style({ position: 'fixed' }), 'static')).not.toBeNull()
  })

  it('a flow element inside a RELATIVE parent also writes position: absolute', () => {
    // Writing `left`/`top` alone on a static element does nothing at all, and
    // a declaration with no effect is the silent no-op this codebase refuses.
    const plan = planFreeMoveProperties(style(), 'relative')
    expect(plan).toEqual({ inlineProperty: 'left', inlineSign: 1, needsAbsolute: true })
  })

  it('REFUSES a flow element inside a STATIC parent', () => {
    // Absolutely positioning here hands the element to some other ancestor, or
    // to the viewport — not to the container the user dropped it in.
    expect(planFreeMoveProperties(style(), 'static')).toBeNull()
  })

  it('writes the LOGICAL property under direction: rtl, with the axis reversed', () => {
    const plan = planFreeMoveProperties(style({ direction: 'rtl' }), 'relative')
    expect(plan).toEqual({ inlineProperty: 'inset-inline-start', inlineSign: -1, needsAbsolute: true })
  })
})

describe('isPositionedFreely', () => {
  it('is true only for absolute and fixed', () => {
    expect(isPositionedFreely('absolute')).toBe(true)
    expect(isPositionedFreely('fixed')).toBe(true)
    expect(isPositionedFreely('relative')).toBe(false)
    expect(isPositionedFreely('sticky')).toBe(false)
    expect(isPositionedFreely('static')).toBe(false)
  })
})

describe('readFreeMoveBase — where the drag starts from', () => {
  const element = { offsetLeft: 40, offsetTop: 12 } as HTMLElement

  it('prefers the property the write will target, so a drag continues from the source', () => {
    expect(readFreeMoveBase(element, style({ left: '120px', top: '60px' }), 'left')).toEqual({
      baseInline: 120,
      baseTop: 60,
    })
  })

  it('falls back to the offset inside the containing block when the property is auto', () => {
    // Otherwise an element positioned only by flow would jump to the
    // container's corner on the first pixel of the drag.
    expect(readFreeMoveBase(element, style(), 'left')).toEqual({ baseInline: 40, baseTop: 12 })
  })

  it('reads the LOGICAL property when that is what the write targets', () => {
    const rtl = style({ direction: 'rtl', insetInlineStart: '30px', top: '5px' })
    expect(readFreeMoveBase(element, rtl, 'inset-inline-start')).toEqual({ baseInline: 30, baseTop: 5 })
  })
})

function plan(overrides: Partial<FreeMovePlan> = {}): FreeMovePlan {
  return {
    element: {} as HTMLElement,
    inlineProperty: 'left',
    inlineSign: 1,
    baseInline: 100,
    baseTop: 100,
    needsAbsolute: false,
    peers: [],
    rect: { x: 100, y: 100, width: 50, height: 20 },
    ...overrides,
  }
}

describe('stepFreeMove — the delta, the snap, and the guides', () => {
  it('applies the pointer delta when nothing is near enough to snap to', () => {
    const step = stepFreeMove(plan(), 30, -12)
    expect(step.inline).toBe(130)
    expect(step.top).toBe(88)
    expect(step.guides).toEqual([])
  })

  it('reverses the horizontal delta for an RTL inline start', () => {
    // A drag to visual-right DECREASES the distance from an RTL inline start.
    const step = stepFreeMove(plan({ inlineProperty: 'inset-inline-start', inlineSign: -1 }), 30, 0)
    expect(step.inline).toBe(70)
  })

  it('snaps to a sibling edge and reports the guide to draw', () => {
    // The peer's left edge sits 2px past where the pointer put ours — inside
    // the threshold, so the element lands exactly on it.
    const peer = { x: 132, y: 400, width: 50, height: 20 }
    const step = stepFreeMove(plan({ peers: [peer] }), 30, 0)
    expect(step.inline).toBe(132)
    expect(step.rect.x).toBe(132)
    expect(step.guides.some((guide) => guide.axis === 'x' && guide.position === 132)).toBe(true)
  })

  it('leaves an axis alone when the nearest peer edge is outside the threshold', () => {
    const peer = { x: 130 + FREE_MOVE_SNAP_PX + 5, y: 400, width: 50, height: 20 }
    const step = stepFreeMove(plan({ peers: [peer] }), 30, 0)
    expect(step.inline).toBe(130)
    expect(step.guides.filter((guide) => guide.axis === 'x')).toEqual([])
  })
})

describe('freeMoveStylePatch — what reaches the user\'s source', () => {
  it('writes only the two offsets for an element that is already positioned', () => {
    const p = plan()
    expect(freeMoveStylePatch(p, stepFreeMove(p, 30, 10))).toEqual({ left: '130px', top: '110px' })
  })

  it('writes position: absolute alongside them when the element was in flow', () => {
    const p = plan({ needsAbsolute: true })
    expect(freeMoveStylePatch(p, stepFreeMove(p, 0, 0))).toEqual({
      position: 'absolute',
      left: '100px',
      top: '100px',
    })
  })

  it('writes the logical property name in RTL, so an RTL author reads their own CSS back', () => {
    const p = plan({ inlineProperty: 'inset-inline-start', inlineSign: -1 })
    expect(freeMoveStylePatch(p, stepFreeMove(p, 20, 0))).toEqual({
      'inset-inline-start': '80px',
      top: '100px',
    })
  })
})
