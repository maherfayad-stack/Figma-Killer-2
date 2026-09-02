/**
 * A CSS Modules rule shows its LOCAL name to a human and its COMPILED name to
 * the browser. Pinned because the two are easy to confuse and the failure is
 * silent in both directions: showing the compiled name makes the panel
 * unreadable, and emitting the local one makes the CSS stop matching.
 */
import { describe, expect, it } from 'bun:test'
import { styleRuleDisplayName, styleRuleDisplaySelector, styleRuleSelector } from '../classNames'
import { parseStyleRule } from '../styleRule'
import type { StyleRule } from '../styleRule'

function rule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: 'imp-1',
    name: 'SignUp_socialBtn__a1b2c',
    kind: 'class',
    selector: '.SignUp_socialBtn__a1b2c',
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

describe('styleRuleDisplaySelector', () => {
  it('shows the local name for a CSS Modules rule', () => {
    const r = rule({ displayName: 'socialBtn' })
    expect(styleRuleDisplaySelector(r)).toBe('.socialBtn')
  })

  it('leaves the compiled selector alone — that is what the browser matches', () => {
    const r = rule({ displayName: 'socialBtn' })
    expect(styleRuleSelector(r)).toBe('.SignUp_socialBtn__a1b2c')
  })

  it('falls back to the real selector for a hand-authored rule', () => {
    expect(styleRuleDisplaySelector(rule({ name: 'card', selector: '.card' }))).toBe('.card')
  })

  it('never rewrites an ambient selector, even if a displayName somehow rode along', () => {
    const r = rule({ kind: 'ambient', selector: '.hero > h1', displayName: 'nonsense' })
    expect(styleRuleDisplaySelector(r)).toBe('.hero > h1')
  })
})

describe('styleRuleDisplayName', () => {
  it('prefers displayName and falls back to name', () => {
    expect(styleRuleDisplayName(rule({ displayName: 'socialBtn' }))).toBe('socialBtn')
    expect(styleRuleDisplayName(rule())).toBe('SignUp_socialBtn__a1b2c')
  })
})

describe('parseStyleRule', () => {
  it('carries displayName through, and drops an empty one', () => {
    expect(parseStyleRule({ ...rule(), displayName: 'socialBtn' })?.displayName).toBe('socialBtn')
    expect(parseStyleRule({ ...rule(), displayName: '' })?.displayName).toBeUndefined()
    expect(parseStyleRule(rule())?.displayName).toBeUndefined()
  })
})
