import { describe, expect, it } from 'bun:test'
import {
  AGENT_TURN_ROUND_BUDGET,
  AGENT_TURN_ROUND_WARN_AT,
  formatTurnProgress,
  parseTurnStepReport,
} from './turnBudget'

describe('parseTurnStepReport', () => {
  it('reads "step 3/6"', () => {
    expect(parseTurnStepReport('step 3/6 — writing Home.tsx')).toEqual({ index: 3, total: 6 })
  })

  it('reads "Step 2 of 5" and is case-insensitive', () => {
    expect(parseTurnStepReport('Step 2 of 5: measuring')).toEqual({ index: 2, total: 5 })
  })

  it('takes the LAST report in a chunk', () => {
    expect(parseTurnStepReport('step 1/4 done. step 2/4 starting.')).toEqual({ index: 2, total: 4 })
  })

  it('ignores a bare fraction with no "step" in front of it', () => {
    expect(parseTurnStepReport('the hero is 3/6 of the frame')).toBeNull()
    expect(parseTurnStepReport('shipped 2024 of 3000 keys')).toBeNull()
  })

  it('rejects an impossible report rather than rendering progress past its end', () => {
    expect(parseTurnStepReport('step 7/3')).toBeNull()
    expect(parseTurnStepReport('step 0/3')).toBeNull()
  })

  it('returns null for text with no report at all', () => {
    expect(parseTurnStepReport('Wrote Home.tsx and its stylesheet.')).toBeNull()
  })
})

describe('formatTurnProgress', () => {
  it('prefers the model’s own reported plan', () => {
    expect(formatTurnProgress({ reported: { index: 3, total: 6 }, roundsStarted: 9, roundsDone: 8 }))
      .toBe('step 3 of 6')
  })

  it('falls back to the tool ledger when nothing was reported', () => {
    expect(formatTurnProgress({ reported: null, roundsStarted: 3, roundsDone: 2 }))
      .toBe('2 of 3 steps done')
  })

  it('says nothing at all before the first tool call', () => {
    expect(formatTurnProgress({ reported: null, roundsStarted: 0, roundsDone: 0 })).toBeNull()
  })

  it('singularises one step', () => {
    expect(formatTurnProgress({ reported: null, roundsStarted: 1, roundsDone: 0 }))
      .toBe('0 of 1 step done')
  })

  it('appends the round count against the budget only once the turn is near the ceiling', () => {
    const below = formatTurnProgress({ reported: null, roundsStarted: AGENT_TURN_ROUND_WARN_AT - 1, roundsDone: 1 })
    expect(below).not.toContain('rounds')

    const at = formatTurnProgress({ reported: { index: 2, total: 3 }, roundsStarted: AGENT_TURN_ROUND_WARN_AT, roundsDone: 1 })
    expect(at).toBe(`step 2 of 3 · ${AGENT_TURN_ROUND_WARN_AT}/${AGENT_TURN_ROUND_BUDGET} rounds`)
  })
})
