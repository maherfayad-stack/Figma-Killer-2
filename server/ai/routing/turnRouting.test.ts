/**
 * The routing table, asserted as a table.
 *
 * Two properties matter more than any individual row and are tested as
 * properties, not examples:
 *
 *   1. A pinned effort is returned verbatim for EVERY level, whatever the
 *      prompt looks like. This is the promise the feature is built on.
 *   2. Nothing is ever routed above the default. Auto-routing may only ever
 *      make a turn cheaper than it was before routing existed.
 */
import { describe, expect, it } from 'bun:test'
import { classifyTurn, resolveTurnRouting, type TurnEffort } from './turnRouting'

const NO_SIGNALS = { attachmentCount: 0, previousTurnWriteCount: 0 }

function shapeOf(prompt: string, overrides: Partial<typeof NO_SIGNALS> = {}): string {
  return classifyTurn({ prompt, ...NO_SIGNALS, ...overrides }).shape
}

describe('classifyTurn', () => {
  it('reads a short interrogative with nothing attached as a question', () => {
    expect(shapeOf('what does the studio prop do?')).toBe('question')
    expect(shapeOf('why is the header collapsing below 480px')).toBe('question')
    expect(shapeOf('Which file holds the button styles?')).toBe('question')
  })

  it('reads an imperative as build even when it ends in a question mark', () => {
    // Phrasing a request politely does not make it a lookup.
    expect(shapeOf('can you build the checkout screen?')).toBe('build')
    expect(shapeOf('could you add a dark mode toggle?')).toBe('build')
  })

  it('reads an adjustment to something that exists as a small edit', () => {
    expect(shapeOf('make the title bold')).toBe('build') // "make" is a build verb — see the escalation order
    expect(shapeOf('change the button colour to coral')).toBe('smallEdit')
    expect(shapeOf('move the logo left by 8px')).toBe('smallEdit')
  })

  it('treats an attached reference as build, however the prompt is phrased', () => {
    expect(shapeOf('what do you think?', { attachmentCount: 1 })).toBe('build')
  })

  it('treats a long prompt as a brief, not a question', () => {
    const long = `why ${'this screen needs a lot of context to explain properly '.repeat(8)}?`
    expect(long.length).toBeGreaterThan(320)
    expect(shapeOf(long)).toBe('build')
  })

  it('routes a vague follow-up up when the previous turn wrote files', () => {
    // "is that right?" after a build is a review of unread work, not a lookup.
    expect(shapeOf('is that right?', { previousTurnWriteCount: 3 })).toBe('smallEdit')
    // …and stays a question when nothing was written to review.
    expect(shapeOf('is that right?')).toBe('question')
  })

  it('routes an unclassifiable prompt up rather than down', () => {
    expect(shapeOf('the checkout flow')).toBe('build')
    expect(shapeOf('hmm')).toBe('build')
  })

  it('explains itself — every classification carries a reason', () => {
    for (const prompt of ['what is this?', 'change the padding', 'build a settings screen', 'hmm']) {
      expect(classifyTurn({ prompt, ...NO_SIGNALS }).reason.length).toBeGreaterThan(10)
    }
  })
})

describe('resolveTurnRouting', () => {
  it('returns an explicitly pinned effort verbatim, for every level and every prompt', () => {
    const levels: TurnEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
    for (const level of levels) {
      for (const prompt of ['what is this?', 'rebuild the whole onboarding flow from this design']) {
        const routed = resolveTurnRouting({
          requestedEffort: level,
          signals: { prompt, attachmentCount: 2, previousTurnWriteCount: 5 },
        })
        expect(routed.mode).toBe('pinned')
        expect(routed.effort).toBe(level)
        // A pinned turn was not classified, so it must not claim a shape.
        expect(routed.shape).toBeUndefined()
      }
    }
  })

  it('falls back to routing when the requested effort is not a real level', () => {
    const routed = resolveTurnRouting({
      requestedEffort: 'turbo',
      signals: { prompt: 'what is this?', ...NO_SIGNALS },
    })
    expect(routed.mode).toBe('auto')
    expect(routed.effort).toBe('low')
  })

  it('never routes above the previous unconditional default', () => {
    const prompts = [
      'what is this?',
      'change the padding',
      'build a settings screen from scratch with a full form',
      'hmm',
      '',
    ]
    for (const prompt of prompts) {
      const routed = resolveTurnRouting({
        requestedEffort: undefined,
        signals: { prompt, attachmentCount: 1, previousTurnWriteCount: 2 },
      })
      expect(['low', 'medium']).toContain(routed.effort)
    }
  })

  it('routes a question to low and everything else to the default', () => {
    expect(resolveTurnRouting({ requestedEffort: undefined, signals: { prompt: 'what does this class do?', ...NO_SIGNALS } }).effort).toBe('low')
    expect(resolveTurnRouting({ requestedEffort: undefined, signals: { prompt: 'build the cart screen', ...NO_SIGNALS } }).effort).toBe('medium')
    expect(resolveTurnRouting({ requestedEffort: undefined, signals: { prompt: 'change the padding to 12px', ...NO_SIGNALS } }).effort).toBe('medium')
  })
})
