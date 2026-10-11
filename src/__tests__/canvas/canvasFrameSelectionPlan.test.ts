/**
 * PA-6 — Frame selection's plan: the frame's style and each member's rebased
 * offsets, or the named reason there is no honest frame.
 */
import { describe, expect, it } from 'bun:test'
import {
  planFrameSelection,
  type FrameMemberFacts,
  type FrameParentFacts,
} from '@site/canvas/canvasFrameSelectionPlan'

const parent = (overrides: Partial<FrameParentFacts> = {}): FrameParentFacts => ({
  box: {
    rect: { left: 100, top: 50, width: 600, height: 400 },
    borderLeft: 0,
    borderTop: 0,
    borderRight: 0,
    borderBottom: 0,
    scale: 1,
    scrollLeft: 0,
    scrollTop: 0,
  },
  containsAbsolute: true,
  direction: 'ltr',
  display: 'block',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  columnGap: 'normal',
  rowGap: 'normal',
  alignItems: 'normal',
  justifyContent: 'normal',
  ...overrides,
})

/** An absolute layer at (`left`, `top`) in the parent's padding box, authored with `left` / `top`. */
const placed = (nodeId: string, left: number, top: number, width: number, height: number): FrameMemberFacts => ({
  nodeId,
  rect: { left: 100 + left, top: 50 + top, width, height },
  style: { position: 'absolute', direction: 'ltr', left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' },
  flexGrow: '0',
  authored: new Set(['left', 'top']),
  expressive: new Set(),
})

const flowed = (nodeId: string, overrides: Partial<FrameMemberFacts> = {}): FrameMemberFacts => ({
  nodeId,
  rect: { left: 100, top: 50, width: 100, height: 40 },
  style: { position: 'static', direction: 'ltr', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto' },
  flexGrow: '0',
  authored: new Set(),
  expressive: new Set(),
  ...overrides,
})

describe('planFrameSelection — placed layers', () => {
  it('sizes the frame to the union and rebases every member so it keeps its place', () => {
    const plan = planFrameSelection([placed('a', 40, 30, 100, 20), placed('b', 200, 120, 60, 50)], parent())
    expect(plan).toEqual({
      ok: true,
      wrapperStyle: { position: 'absolute', left: '40px', top: '30px', width: '220px', height: '140px' },
      memberStyles: [
        { left: '0px', top: '0px' },
        { left: '160px', top: '90px' },
      ],
    })
  })

  it('a right-anchored layer stays right-anchored: its right loses the frame right inset', () => {
    const right: FrameMemberFacts = {
      ...placed('b', 500, 90, 80, 30),
      style: { position: 'absolute', direction: 'ltr', left: '500px', top: '90px', right: '20px', bottom: 'auto' },
      authored: new Set(['right', 'top']),
    }
    const plan = planFrameSelection([placed('a', 40, 30, 100, 20), right], parent())
    expect(plan).toMatchObject({
      ok: true,
      // union: left 40 .. right 580 (parent 600 wide) so the frame's right inset is 20.
      wrapperStyle: { position: 'absolute', left: '40px', top: '30px', width: '540px', height: '90px' },
      memberStyles: [{ left: '0px', top: '0px' }, { right: '0px', top: '60px' }],
    })
  })

  it('measures from the padding box: a border moves nothing the frame does not account for', () => {
    const bordered = parent({ box: { ...parent().box, borderLeft: 4, borderTop: 4 } })
    const plan = planFrameSelection([placed('a', 40, 30, 100, 20)], bordered)
    // The member is 40px from the BORDER edge; the padding box starts 4px in.
    expect(plan).toMatchObject({ ok: true, wrapperStyle: { left: '36px', top: '26px' } })
  })

  it('writes the logical inline start, from the right edge, under RTL', () => {
    const member: FrameMemberFacts = {
      ...placed('a', 100, 10, 50, 20),
      style: { position: 'absolute', direction: 'rtl', left: '100px', top: '10px', right: '450px', bottom: 'auto' },
      authored: new Set(['insetInlineStart', 'top']),
    }
    const plan = planFrameSelection([member], parent({ direction: 'rtl' }))
    expect(plan).toMatchObject({ ok: true, wrapperStyle: { position: 'absolute', insetInlineStart: '450px', top: '10px' } })
    if (plan.ok) expect(plan.memberStyles[0]).toEqual({ insetInlineStart: '0px', top: '0px' })
  })

  it('refuses a layer positioned by a percentage, so it does not freeze', () => {
    const centred: FrameMemberFacts = { ...placed('a', 300, 10, 50, 20), expressive: new Set(['left']) }
    const plan = planFrameSelection([centred], parent())
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toContain('percentage')
  })

  it('refuses when the container is not the layers’ containing block', () => {
    const plan = planFrameSelection([placed('a', 1, 1, 10, 10)], parent({ containsAbsolute: false }))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toContain('position: relative')
  })

  it('refuses a fixed layer', () => {
    const fixed: FrameMemberFacts = { ...placed('a', 1, 1, 10, 10), style: { ...placed('a', 1, 1, 10, 10).style, position: 'fixed' } }
    expect(planFrameSelection([fixed], parent()).ok).toBe(false)
  })

  it('refuses a mix of placed and flowing layers', () => {
    const plan = planFrameSelection([placed('a', 1, 1, 10, 10), flowed('b')], parent())
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toContain('mix')
  })
})

describe('planFrameSelection — flowing layers', () => {
  it('in block flow the frame is a bare container and nothing is frozen into pixels', () => {
    expect(planFrameSelection([flowed('a'), flowed('b')], parent())).toEqual({
      ok: true,
      wrapperStyle: {},
      memberStyles: [{}, {}],
    })
  })

  it('in a flex parent the frame carries the parent’s layout so the layers keep running the same way', () => {
    const plan = planFrameSelection(
      [flowed('a'), flowed('b')],
      parent({ display: 'flex', flexDirection: 'column', rowGap: '12px', columnGap: '12px', alignItems: 'center' }),
    )
    expect(plan).toMatchObject({
      ok: true,
      wrapperStyle: { display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' },
    })
  })

  it('a row parent writes no direction, and differing gaps stay separate', () => {
    const plan = planFrameSelection([flowed('a')], parent({ display: 'flex', rowGap: '4px', columnGap: '16px' }))
    expect(plan).toMatchObject({ ok: true, wrapperStyle: { display: 'flex', rowGap: '4px', columnGap: '16px' } })
    if (plan.ok) expect(plan.wrapperStyle).not.toHaveProperty('flexDirection')
  })

  it('refuses grid cells', () => {
    expect(planFrameSelection([flowed('a')], parent({ display: 'grid' })).ok).toBe(false)
  })

  it('refuses a parent that spaces its items, which a shrink-wrapped frame cannot keep', () => {
    const plan = planFrameSelection([flowed('a')], parent({ display: 'flex', justifyContent: 'space-between' }))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toContain('justify-content')
  })

  it('refuses a layer that grows to fill its container', () => {
    const plan = planFrameSelection([flowed('a', { flexGrow: '1' })], parent({ display: 'flex' }))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toContain('flex-grow')
  })

  it('refuses an empty selection', () => {
    expect(planFrameSelection([], parent()).ok).toBe(false)
  })
})
