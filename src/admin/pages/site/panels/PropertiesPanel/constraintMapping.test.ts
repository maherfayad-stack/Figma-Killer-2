/**
 * Unit tests for `constraintMapping` — the pure model behind the constraints
 * crosshair. Every rule here is a claim about the USER'S CSS, so each one is
 * pinned: which properties a mode writes, which it clears, and which
 * collisions refuse instead of overwriting somebody's value.
 */
import { describe, it, expect } from 'bun:test'
import {
  AXIS_PROPERTIES,
  constraintRefusal,
  parseTranslateAxes,
  planConstraintChange,
  nextModeForEdgeToggle,
  readConstraintMode,
  resolvePositionedContext,
  serializeTranslateAxes,
  type ConstraintContext,
} from './constraintMapping'

function ctx(partial: Partial<ConstraintContext> = {}): ConstraintContext {
  return {
    stored: partial.stored ?? {},
    current: partial.current ?? {},
    geometry: partial.geometry ?? null,
  }
}

const GEOMETRY = { startPx: 40, endPx: 60, containerPx: 400 }

describe('resolvePositionedContext', () => {
  it('accepts fixed without asking about the parent — the viewport is the containing block', () => {
    expect(resolvePositionedContext({ position: 'fixed', parentIsContainingBlock: false })).toEqual({ ok: true })
  })

  it('accepts absolute inside a positioned parent', () => {
    expect(resolvePositionedContext({ position: 'absolute', parentIsContainingBlock: true })).toEqual({ ok: true })
  })

  it('refuses absolute when the parent is not the containing block, and names the fix', () => {
    const result = resolvePositionedContext({ position: 'absolute', parentIsContainingBlock: false })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('position: relative')
  })

  it('refuses rather than guesses when no frame can verify the containing block', () => {
    const result = resolvePositionedContext({ position: 'absolute', parentIsContainingBlock: null })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain("Can't verify")
  })

  it.each(['static', 'relative', 'sticky', null])('refuses normal flow (%s)', (position) => {
    const result = resolvePositionedContext({ position, parentIsContainingBlock: true })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('absolute')
  })
})

describe('translate value model', () => {
  it('reads the identity for unset, empty, and none', () => {
    expect(parseTranslateAxes(undefined)).toEqual({ x: '0', y: '0' })
    expect(parseTranslateAxes('')).toEqual({ x: '0', y: '0' })
    expect(parseTranslateAxes('none')).toEqual({ x: '0', y: '0' })
  })

  it('treats a single component as X, with Y at zero', () => {
    expect(parseTranslateAxes('-50%')).toEqual({ x: '-50%', y: '0' })
  })

  it('reads both components', () => {
    expect(parseTranslateAxes('-50% -50%')).toEqual({ x: '-50%', y: '-50%' })
  })

  it('refuses a 3D translate and anything containing a function call', () => {
    expect(parseTranslateAxes('1px 2px 3px')).toBeNull()
    expect(parseTranslateAxes('calc(100% - 4px) 0')).toBeNull()
    expect(parseTranslateAxes('var(--nudge)')).toBeNull()
  })

  it('collapses to undefined at the identity so no no-op declaration is left behind', () => {
    expect(serializeTranslateAxes({ x: '0', y: '0px' })).toBeUndefined()
    expect(serializeTranslateAxes({ x: '-50%', y: '0' })).toBe('-50%')
    expect(serializeTranslateAxes({ x: '-50%', y: '-50%' })).toBe('-50% -50%')
  })
})

describe('readConstraintMode', () => {
  it('is null when the bag declares neither inset', () => {
    expect(readConstraintMode('x', ctx({ current: { left: '10px' } }))).toBeNull()
  })

  it('reads a single start inset as start, and a single end inset as end', () => {
    expect(readConstraintMode('x', ctx({ stored: { left: '12px' } }))).toBe('start')
    expect(readConstraintMode('y', ctx({ stored: { bottom: '12px' } }))).toBe('end')
  })

  it('reads both insets as stretch', () => {
    expect(readConstraintMode('x', ctx({ stored: { left: '12px', right: '12px' } }))).toBe('stretch')
  })

  it('reads two percentage insets as scale, not stretch', () => {
    expect(readConstraintMode('x', ctx({ stored: { left: '10%', right: '25%' } }))).toBe('scale')
  })

  it('reads 50% plus our own pull-back as centre, on either axis', () => {
    expect(readConstraintMode('x', ctx({ stored: { left: '50%', translate: '-50%' } }))).toBe('center')
    expect(readConstraintMode('y', ctx({ stored: { top: '50%', translate: '0 -50%' } }))).toBe('center')
  })

  it('does not call 50% alone centre — without the pull-back the box is not centred', () => {
    expect(readConstraintMode('x', ctx({ stored: { left: '50%' } }))).toBe('start')
  })

  it('sees a pull-back the element inherits from a losing rule', () => {
    expect(readConstraintMode('x', ctx({ stored: { left: '50%' }, current: { translate: '-50%' } }))).toBe('center')
  })
})

describe('planConstraintChange — start / end', () => {
  it('start writes the measured inset and clears the opposite edge', () => {
    const plan = planConstraintChange('x', 'start', ctx({ stored: { right: '5px' }, geometry: GEOMETRY }))
    expect(plan).toEqual({ ok: true, patch: { left: '40px', right: null } })
  })

  it('end anchors to the measured far edge so the box does not move', () => {
    const plan = planConstraintChange('x', 'end', ctx({ stored: { left: '40px' }, geometry: GEOMETRY }))
    expect(plan).toEqual({ ok: true, patch: { left: null, right: '60px' } })
  })

  it('falls back to the declared value, then to 0px, when nothing is measurable', () => {
    expect(planConstraintChange('y', 'start', ctx({ stored: { top: '2rem' } }))).toEqual({
      ok: true,
      patch: { top: '2rem', bottom: null },
    })
    expect(planConstraintChange('y', 'start', ctx())).toEqual({ ok: true, patch: { top: '0px', bottom: null } })
  })

  it('leaves width alone — only the two-edge modes may clear it', () => {
    const plan = planConstraintChange('x', 'start', ctx({ stored: { width: '120px' }, geometry: GEOMETRY }))
    if (!plan.ok) throw new Error('expected a patch')
    expect(AXIS_PROPERTIES.x.size in plan.patch).toBe(false)
  })
})

describe('planConstraintChange — stretch', () => {
  it('sets both insets and clears the size on that axis', () => {
    const plan = planConstraintChange('x', 'stretch', ctx({ stored: { width: '120px' }, geometry: GEOMETRY }))
    expect(plan).toEqual({ ok: true, patch: { left: '40px', right: '60px', width: null } })
  })

  it('clears height, not width, on the Y axis', () => {
    const plan = planConstraintChange('y', 'stretch', ctx({ geometry: { startPx: 8, endPx: 8, containerPx: 100 } }))
    expect(plan).toEqual({ ok: true, patch: { top: '8px', bottom: '8px', height: null } })
  })
})

describe('planConstraintChange — scale', () => {
  it('converts both used insets to percentages of the containing block', () => {
    const plan = planConstraintChange('x', 'scale', ctx({ geometry: GEOMETRY }))
    expect(plan).toEqual({ ok: true, patch: { left: '10%', right: '15%', width: null } })
  })

  it('refuses by name when no frame is rendering the node', () => {
    const plan = planConstraintChange('x', 'scale', ctx())
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected a refusal')
    expect(plan.reason).toContain('no live frame')
  })

  it('refuses a zero-width container instead of dividing by it', () => {
    const plan = planConstraintChange('x', 'scale', ctx({ geometry: { startPx: 0, endPx: 0, containerPx: 0 } }))
    expect(plan.ok).toBe(false)
  })
})

describe('planConstraintChange — centre', () => {
  it('writes 50% plus the pull-back and clears the opposite edge', () => {
    const plan = planConstraintChange('x', 'center', ctx({ stored: { right: '5px' }, geometry: GEOMETRY }))
    expect(plan).toEqual({ ok: true, patch: { left: '50%', right: null, translate: '-50%' } })
  })

  it('centres Y without disturbing an existing X pull-back', () => {
    const plan = planConstraintChange('y', 'center', ctx({ stored: { translate: '-50%' } }))
    expect(plan).toEqual({ ok: true, patch: { top: '50%', bottom: null, translate: '-50% -50%' } })
  })

  it('refuses when transform already carries a translate function', () => {
    const plan = planConstraintChange('x', 'center', ctx({ stored: { transform: 'translateX(-50%) rotate(3deg)' } }))
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected a refusal')
    expect(plan.reason).toContain('transform')
  })

  it('refuses when this axis of translate already holds somebody else’s value', () => {
    const plan = planConstraintChange('x', 'center', ctx({ stored: { translate: '10px' } }))
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected a refusal')
    expect(plan.reason).toContain('10px')
  })

  it('allows centring X when only the Y component is taken', () => {
    const plan = planConstraintChange('x', 'center', ctx({ stored: { translate: '0 12px' } }))
    expect(plan).toEqual({ ok: true, patch: { left: '50%', right: null, translate: '-50% 12px' } })
  })

  it('refuses a translate it cannot split, rather than mis-parsing it', () => {
    const plan = planConstraintChange('y', 'center', ctx({ stored: { translate: 'var(--nudge)' } }))
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected a refusal')
    expect(plan.reason).toContain('var(--nudge)')
  })
})

describe('leaving centre releases the pull-back this control wrote', () => {
  it('clears translate entirely when nothing else was riding on it', () => {
    const plan = planConstraintChange(
      'x',
      'start',
      ctx({ stored: { left: '50%', translate: '-50%' }, geometry: GEOMETRY }),
    )
    expect(plan).toEqual({ ok: true, patch: { translate: null, left: '40px', right: null } })
  })

  it('keeps the other axis when only one was centred', () => {
    const plan = planConstraintChange(
      'x',
      'start',
      ctx({ stored: { left: '50%', top: '50%', translate: '-50% -50%' }, geometry: GEOMETRY }),
    )
    expect(plan).toEqual({ ok: true, patch: { translate: '0 -50%', left: '40px', right: null } })
  })

  it('does not drag an unrelated translate clear into a plain anchor edit', () => {
    const plan = planConstraintChange('x', 'start', ctx({ geometry: GEOMETRY }))
    if (!plan.ok) throw new Error('expected a patch')
    expect('translate' in plan.patch).toBe(false)
  })
})

describe('constraintRefusal', () => {
  it('leaves the plain inset modes available with no geometry and no translate', () => {
    for (const mode of ['start', 'end', 'stretch'] as const) {
      expect(constraintRefusal('x', mode, ctx())).toBeNull()
    }
  })

  it('allows centring when the pull-back is already ours', () => {
    const centred = ctx({ stored: { left: '50%' }, current: { translate: '-50%' } })
    expect(constraintRefusal('x', 'center', centred)).toBeNull()
  })

  it('leaves a translate it cannot split untouched instead of refusing an inset mode', () => {
    // Unsplittable means it is not ours (read-back never calls it centred),
    // so anchoring left simply does not touch it.
    const unsplittable = ctx({ stored: { left: '50%', translate: 'calc(-50% + 2px)' }, geometry: GEOMETRY })
    expect(constraintRefusal('x', 'start', unsplittable)).toBeNull()
    const plan = planConstraintChange('x', 'start', unsplittable)
    if (!plan.ok) throw new Error('expected a patch')
    expect('translate' in plan.patch).toBe(false)
  })
})

describe('nextModeForEdgeToggle', () => {
  it('pins an edge when the axis has no constraint yet', () => {
    expect(nextModeForEdgeToggle(null, 'start')).toBe('start')
    expect(nextModeForEdgeToggle(null, 'end')).toBe('end')
  })

  it('pairs the second pin into stretch', () => {
    expect(nextModeForEdgeToggle('start', 'end')).toBe('stretch')
    expect(nextModeForEdgeToggle('end', 'start')).toBe('stretch')
  })

  it('un-pinning one half of stretch leaves the other half', () => {
    expect(nextModeForEdgeToggle('stretch', 'start')).toBe('end')
    expect(nextModeForEdgeToggle('stretch', 'end')).toBe('start')
  })

  it('un-pinning the only pin falls to scale, as Figma does', () => {
    expect(nextModeForEdgeToggle('start', 'start')).toBe('scale')
    expect(nextModeForEdgeToggle('end', 'end')).toBe('scale')
  })

  it('any edge replaces centring — an axis cannot be centred and anchored at once', () => {
    expect(nextModeForEdgeToggle('center', 'start')).toBe('start')
    expect(nextModeForEdgeToggle('scale', 'end')).toBe('end')
  })
})
