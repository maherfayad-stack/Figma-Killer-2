/**
 * K6 — free movement that stays honest.
 *
 * The decision this file pins is the one the feel plan's §6 decision 6
 * deliberately narrowed: a gesture may write offsets inline, but only where
 * that declaration will actually do what the user pointed at. The three
 * cases are asserted independently, plus the RTL axis, the snapping, and
 * (P5-E, IX-21) which OFFSETS it writes — the ones the source anchors the
 * layer by — all against plain objects: no DOM, no layout, no browser.
 */
import { describe, expect, it } from 'bun:test'
import {
  clearFreeMovePreview,
  previewFreeMove,
  freeMoveStylePatch,
  planFreeMoveOffsets,
  planFreeMoveProperties,
  stepFreeMove,
  type FreeMoveElementBox,
  type FreeMoveMember,
  type FreeMovePlan,
  type FreeMoveStep,
  type FreeMoveStyleInput,
} from '@site/canvas/canvasFreeMove'
import { authoredOffsets, type NudgeOffsetProperty } from '@site/canvas/canvasNodeArrowMove'
import { isPositionedFreely } from '@core/studio-runtime'
import { SNAP_THRESHOLD_SCREEN_PX } from '@site/canvas/boardSnapping'

function style(overrides: Partial<FreeMoveStyleInput> = {}): FreeMoveStyleInput {
  return {
    position: 'static',
    direction: 'ltr',
    left: 'auto',
    right: 'auto',
    top: 'auto',
    bottom: 'auto',
    ...overrides,
  }
}

const NOTHING_AUTHORED: ReadonlySet<NudgeOffsetProperty> = new Set()
const BOX: FreeMoveElementBox = { offsetLeft: 40, offsetTop: 12, offsetWidth: 50, containerWidth: 300 }

describe('planFreeMoveProperties — when a coordinate write is honest', () => {
  it('an already-absolute element moves, and changes no position', () => {
    expect(planFreeMoveProperties(style({ position: 'absolute' }), 'static')).toEqual({ needsAbsolute: false })
  })

  it('a fixed element does not care what its parent is — the viewport contains it', () => {
    expect(planFreeMoveProperties(style({ position: 'fixed' }), 'static')).not.toBeNull()
  })

  it('a flow element inside a RELATIVE parent also writes position: absolute', () => {
    // Writing offsets alone on a static element does nothing at all, and a
    // declaration with no effect is the silent no-op this codebase refuses.
    expect(planFreeMoveProperties(style(), 'relative')).toEqual({ needsAbsolute: true })
  })

  it('REFUSES a flow element inside a STATIC parent', () => {
    // Absolutely positioning here hands the element to some other ancestor, or
    // to the viewport — not to the container the user dropped it in.
    expect(planFreeMoveProperties(style(), 'static')).toBeNull()
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

describe('planFreeMoveOffsets — where the drag starts from, and what it writes', () => {
  it('an element becoming absolute starts from where layout put it (left / top)', () => {
    // Otherwise an element positioned only by flow would jump to the
    // container's corner on the first pixel of the drag.
    expect(planFreeMoveOffsets(BOX, style(), NOTHING_AUTHORED, true)).toEqual({
      horizontal: [{ property: 'left', sign: 1, base: 40 }],
      vertical: [{ property: 'top', sign: 1, base: 12 }],
    })
  })

  it('under RTL it writes the LOGICAL inline start, measured from the right edge', () => {
    // 300 wide container, 50 wide element at offsetLeft 40 → 210 from the right.
    expect(planFreeMoveOffsets(BOX, style({ direction: 'rtl' }), NOTHING_AUTHORED, true).horizontal).toEqual([
      { property: 'insetInlineStart', sign: -1, base: 210 },
    ])
  })

  it('an already-positioned element with nothing authored moves left / top from their used values', () => {
    const plan = planFreeMoveOffsets(BOX, style({ position: 'absolute', left: '120px', top: '60px' }), NOTHING_AUTHORED, false)
    expect(plan.horizontal).toEqual([{ property: 'left', sign: 1, base: 120 }])
    expect(plan.vertical).toEqual([{ property: 'top', sign: 1, base: 60 }])
  })
})

/**
 * IX-21 — CONFIRMED (P2-C, P2-D): a free move always wrote `left` + `top`, so a
 * layer the source anchors with `right` / `bottom` gained a second, conflicting
 * inset — the next width change moved the wrong edge, or `width: auto`
 * stretched it. The move now writes the offsets the source AUTHORED.
 */
describe('IX-21 — a free move keeps the layer anchored the way its source anchors it', () => {
  function planFor(own: Partial<FreeMoveStyleInput>, inlineStyles: Record<string, string>): FreeMovePlan {
    const authored = authoredOffsets({ classIds: [], inlineStyles }, undefined)
    return {
      members: [{
        nodeId: 'n',
        element: {} as HTMLElement,
        offsets: planFreeMoveOffsets(BOX, style({ position: 'absolute', ...own }), authored, false),
        needsAbsolute: false,
      }],
      peers: [],
      snap: {},
      rect: { x: 100, y: 100, width: 50, height: 20 },
    }
  }

  it('a right-anchored layer moved right writes a SMALLER right, and no left', () => {
    const plan = planFor({ left: '226px', right: '24px', top: '10px' }, { right: '24px', top: '10px' })
    const patch = patchOf(plan, stepFreeMove(plan, 30, 0, 1))
    expect(patch).toEqual({ right: '-6px' })
    expect(patch).not.toHaveProperty('left')
  })

  it('a bottom-anchored layer moved down writes a smaller bottom, and no top', () => {
    const plan = planFor({ left: '10px', top: '150px', bottom: '40px' }, { left: '10px', bottom: '40px' })
    expect(patchOf(plan, stepFreeMove(plan, 0, 15, 1))).toEqual({ bottom: '25px' })
  })

  it('a stretched layer (left AND right) moves both, keeping its width', () => {
    const plan = planFor({ left: '20px', right: '30px', top: '0px' }, { left: '20px', right: '30px', top: '0px' })
    expect(patchOf(plan, stepFreeMove(plan, 5, 0, 1))).toEqual({ left: '25px', right: '25px' })
  })

  it('a left: 50% + translate(-50%) centring moves as left, from its USED px value', () => {
    // The translate stays authored; moving the used left by 10 moves the box by 10.
    const plan = planFor({ left: '150px', top: '0px' }, { left: '50%', transform: 'translateX(-50%)', top: '0px' })
    expect(patchOf(plan, stepFreeMove(plan, 10, 0, 1))).toEqual({ left: '160px' })
  })
})

interface PlanOverrides extends Partial<Omit<FreeMovePlan, 'members'>>, Partial<Omit<FreeMoveMember, 'nodeId'>> {}

/** A one-member plan, with the member's and the plan's fields overridable in one bag. */
function plan(overrides: PlanOverrides = {}): FreeMovePlan {
  const { element, offsets, needsAbsolute, ...rest } = overrides
  return {
    members: [{
      nodeId: 'n',
      element: element ?? ({} as HTMLElement),
      offsets: offsets ?? {
        horizontal: [{ property: 'left', sign: 1, base: 100 }],
        vertical: [{ property: 'top', sign: 1, base: 100 }],
      },
      needsAbsolute: needsAbsolute ?? false,
    }],
    peers: [],
    snap: {},
    rect: { x: 100, y: 100, width: 50, height: 20 },
    ...rest,
  }
}

/** The one member's patch — what a single-layer free move writes. */
function patchOf(p: FreeMovePlan, step: FreeMoveStep): Record<string, string> {
  return freeMoveStylePatch(p.members[0]!, step)
}

const RTL_OFFSETS: FreeMoveMember['offsets'] = {
  horizontal: [{ property: 'insetInlineStart', sign: -1, base: 100 }],
  vertical: [{ property: 'top', sign: 1, base: 100 }],
}

describe('stepFreeMove — the delta, the snap, and the guides', () => {
  it('applies the pointer delta when nothing is near enough to snap to', () => {
    const step = stepFreeMove(plan(), 30, -12, 1)
    expect(step.dx).toBe(30)
    expect(step.dy).toBe(-12)
    expect(step.guides).toEqual([])
  })

  it('snaps to a sibling edge and reports the guide to draw', () => {
    // The peer's left edge sits 2px past where the pointer put ours — inside
    // the threshold, so the element lands exactly on it.
    const peer = { x: 132, y: 400, width: 50, height: 20 }
    const step = stepFreeMove(plan({ peers: [peer] }), 30, 0, 1)
    expect(step.dx).toBe(32)
    expect(step.rect.x).toBe(132)
    expect(step.guides.some((guide) => guide.axis === 'x' && guide.position === 132)).toBe(true)
  })

  it('leaves an axis alone when the nearest peer edge is outside the threshold', () => {
    const peer = { x: 130 + SNAP_THRESHOLD_SCREEN_PX + 5, y: 400, width: 50, height: 20 }
    const step = stepFreeMove(plan({ peers: [peer] }), 30, 0, 1)
    expect(step.dx).toBe(30)
    expect(step.guides.filter((guide) => guide.axis === 'x')).toEqual([])
  })
})

describe('freeMoveStylePatch — what reaches the user\'s source', () => {
  it('writes only the offsets that moved for an element that is already positioned', () => {
    const p = plan()
    expect(patchOf(p, stepFreeMove(p, 30, 10, 1))).toEqual({ left: '130px', top: '110px' })
    expect(patchOf(p, stepFreeMove(p, 30, 0, 1))).toEqual({ left: '130px' })
  })

  it('writes position: absolute and BOTH offsets when the element was in flow', () => {
    const p = plan({ needsAbsolute: true })
    expect(patchOf(p, stepFreeMove(p, 0, 0, 1))).toEqual({
      position: 'absolute',
      left: '100px',
      top: '100px',
    })
  })

  it('reverses the horizontal delta for an RTL inline start, and keeps the logical name', () => {
    // A drag to visual-right DECREASES the distance from an RTL inline start.
    const p = plan({ offsets: RTL_OFFSETS })
    expect(patchOf(p, stepFreeMove(p, 20, 0, 1))).toEqual({ insetInlineStart: '80px' })
  })
})

/**
 * P2-C — the RTL offset reached the user's source as `'inset-inline-start'`,
 * a kebab key inside a JSX `style={{…}}` object, which React only reads in
 * camelCase (P2-D's finding, `canvas-23`). The source key and the CSSOM name
 * are two spellings of one property; each belongs on exactly one side.
 */
describe('free move writes a React style key to the source and a CSSOM name to the preview (P2-C)', () => {
  function recordingElement() {
    const set = new Map<string, string>()
    const style = {
      setProperty: (name: string, value: string) => void set.set(name, value),
      removeProperty: (name: string) => {
        set.delete(name)
        return ''
      },
    }
    return { element: { style } as unknown as HTMLElement, set }
  }

  it('every key of an RTL free-move patch is camelCase', () => {
    const p = plan({ offsets: RTL_OFFSETS })
    const patch = patchOf(p, stepFreeMove(p, 12, 3, 1))
    for (const key of Object.keys(patch)) expect(key).not.toContain('-')
    expect(patch).toEqual({ insetInlineStart: '88px', top: '103px' })
  })

  it('the preview sets and clears the CSSOM name, never the source key', () => {
    const { element, set } = recordingElement()
    const p = plan({ offsets: RTL_OFFSETS, element })
    previewFreeMove(p, stepFreeMove(p, 12, 3, 1))
    expect([...set.keys()].sort()).toEqual(['inset-inline-start', 'top'])
    clearFreeMovePreview(p)
    expect(set.size).toBe(0)
  })
})
