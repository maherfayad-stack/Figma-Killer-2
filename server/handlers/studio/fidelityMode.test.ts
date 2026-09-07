/**
 * W9-2 — the precedence chain and the threshold table.
 *
 * These are the two things every other consumer trusts without re-deriving:
 * `chat.ts` and `stopGateCheck.ts` both call the resolver, and `compare.ts`
 * and the system prompt's mode blocks both read the table. A drift in either
 * would show up as "the agent was told one bar and graded against another",
 * which is exactly the failure the modes exist to end.
 */
import { describe, expect, it } from 'bun:test'
import {
  FIDELITY_MODES,
  FIDELITY_THRESHOLDS,
  asFidelityMode,
  resolveFidelityMode,
  scaledMaxRegionPixels,
} from './fidelityMode'

describe('resolveFidelityMode precedence', () => {
  it('a tool argument outranks every other tier', () => {
    expect(resolveFidelityMode({
      toolArg: 'creative',
      reference: 'strict',
      turn: 'strict',
      project: 'strict',
      referenceArmed: true,
    })).toEqual({ mode: 'creative', source: 'tool-arg' })
  })

  it("a reference's own mode outranks the turn and the project", () => {
    expect(resolveFidelityMode({
      reference: 'strict',
      turn: 'creative',
      project: 'creative',
      referenceArmed: true,
    })).toEqual({ mode: 'strict', source: 'reference' })
  })

  it('the per-turn value outranks the persisted project default', () => {
    expect(resolveFidelityMode({ turn: 'creative', project: 'strict', referenceArmed: true }))
      .toEqual({ mode: 'creative', source: 'turn' })
  })

  it('the project default answers when the turn carries nothing', () => {
    expect(resolveFidelityMode({ project: 'strict', referenceArmed: false }))
      .toEqual({ mode: 'strict', source: 'project' })
  })

  it('derives balanced when a reference is armed and creative when none is', () => {
    expect(resolveFidelityMode({ referenceArmed: true })).toEqual({ mode: 'balanced', source: 'derived' })
    expect(resolveFidelityMode({ referenceArmed: false })).toEqual({ mode: 'creative', source: 'derived' })
    expect(resolveFidelityMode({})).toEqual({ mode: 'creative', source: 'derived' })
  })

  it('never derives strict — escalation is always somebody\'s explicit gesture', () => {
    for (const referenceArmed of [true, false]) {
      expect(resolveFidelityMode({ referenceArmed }).mode).not.toBe('strict')
    }
  })

  it('skips an absent tier rather than treating it as a choice', () => {
    // The reference tier is empty (this reference declared no mode), so the
    // turn answers — not the derived value, and not silently `balanced`.
    expect(resolveFidelityMode({ reference: undefined, turn: 'strict', referenceArmed: true }))
      .toEqual({ mode: 'strict', source: 'turn' })
  })
})

describe('asFidelityMode', () => {
  it('accepts exactly the three modes', () => {
    for (const mode of FIDELITY_MODES) expect(asFidelityMode(mode)).toBe(mode)
  })

  it('rejects anything else a hand-edited meta.json could hold', () => {
    for (const bad of ['STRICT', 'exact', '', null, undefined, 3, {}]) {
      expect(asFidelityMode(bad)).toBeUndefined()
    }
  })
})

describe('FIDELITY_THRESHOLDS', () => {
  it('holds a row for every mode', () => {
    for (const mode of FIDELITY_MODES) expect(FIDELITY_THRESHOLDS[mode]).toBeDefined()
  })

  it('carries the specced balanced and strict numbers', () => {
    expect(FIDELITY_THRESHOLDS.balanced.passScore).toBe(92)
    expect(FIDELITY_THRESHOLDS.balanced.maxRegionCoverage).toBe(6)
    expect(FIDELITY_THRESHOLDS.strict.passScore).toBe(99)
    expect(FIDELITY_THRESHOLDS.strict.maxRegionCoverage).toBe(0.5)
  })

  it('tightens monotonically from creative to strict', () => {
    expect(FIDELITY_THRESHOLDS.creative.passScore).toBeLessThan(FIDELITY_THRESHOLDS.balanced.passScore)
    expect(FIDELITY_THRESHOLDS.balanced.passScore).toBeLessThan(FIDELITY_THRESHOLDS.strict.passScore)
    expect(FIDELITY_THRESHOLDS.creative.maxRegionCoverage).toBeGreaterThan(FIDELITY_THRESHOLDS.balanced.maxRegionCoverage)
    expect(FIDELITY_THRESHOLDS.balanced.maxRegionCoverage).toBeGreaterThan(FIDELITY_THRESHOLDS.strict.maxRegionCoverage)
  })

  it('applies the absolute area floor only in strict', () => {
    expect(FIDELITY_THRESHOLDS.creative.maxRegionPixels).toBeNull()
    expect(FIDELITY_THRESHOLDS.balanced.maxRegionPixels).toBeNull()
    expect(FIDELITY_THRESHOLDS.strict.maxRegionPixels).toBe(400)
  })
})

describe('scaledMaxRegionPixels', () => {
  it('is the 1x floor at 1x', () => {
    expect(scaledMaxRegionPixels(FIDELITY_THRESHOLDS.strict, 1)).toBe(400)
  })

  it('scales with the SQUARE of the linear scale — area, not length', () => {
    // A 20x20 CSS-px icon is 400px² at 1x and 1600px² in a 2x comparison.
    // Scaling linearly would give 800 and fail every retina export.
    expect(scaledMaxRegionPixels(FIDELITY_THRESHOLDS.strict, 2)).toBe(1600)
    expect(scaledMaxRegionPixels(FIDELITY_THRESHOLDS.strict, 3)).toBe(3600)
  })

  it('is null for a mode that has no floor', () => {
    expect(scaledMaxRegionPixels(FIDELITY_THRESHOLDS.balanced, 2)).toBeNull()
  })

  it('drops the floor rather than guessing 1x when the scale is unknown', () => {
    // An unknown scale means the board frame has no authored width. Applying
    // a 1x floor to a 3x diff would fail every region on the page.
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(scaledMaxRegionPixels(FIDELITY_THRESHOLDS.strict, bad)).toBeNull()
    }
  })
})
