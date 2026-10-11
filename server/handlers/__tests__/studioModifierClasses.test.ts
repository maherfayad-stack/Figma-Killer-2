/**
 * A class that exists only as the second half of a compound rule is registered,
 * so the page's node keeps it and the panel reads its value. Registry-level
 * cases (a plain stylesheet, a CSS-Module compile with its `:global()` modifier,
 * a name two compounds claim, a name that has a rule of its own); the end-to-end
 * board load is in `studioClassOverrides.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { registerModifierClasses } from '../studioModifierClasses'

function ambient(selector: string, styles: Record<string, string>): StyleRule {
  return { id: `amb:${selector}`, name: selector, kind: 'ambient', selector, order: 0, styles, contextStyles: {}, createdAt: 1, updatedAt: 1 } as StyleRule
}

function classRule(name: string): StyleRule {
  return { id: `cls:${name}`, name, kind: 'class', selector: `.${name}`, order: 0, styles: {}, contextStyles: {}, createdAt: 1, updatedAt: 1 } as StyleRule
}

describe('registerModifierClasses', () => {
  it('registers the second class of a compound with the compound\'s declarations, mapped to the compound\'s own rule', () => {
    const rule = ambient('.card.card-home-2', { padding: '20px' })
    const styleRules: Record<string, StyleRule> = { [rule.id]: rule, 'cls:card': classRule('card') }
    const classIdsByName: Record<string, string> = { card: 'cls:card' }
    const sources: Record<string, { file: string; selector: string }> = { [rule.id]: { file: 'Card.css', selector: '.card.card-home-2' } }
    registerModifierClasses(styleRules, classIdsByName, sources)

    const id = classIdsByName['card-home-2']!
    expect(styleRules[id]).toMatchObject({ kind: 'class', name: 'card-home-2', selector: '.card-home-2', styles: { padding: '20px' } })
    expect(sources[id]).toEqual({ file: 'Card.css', selector: '.card.card-home-2' })
    // The ambient entry it came from is replaced, not duplicated.
    expect(styleRules[rule.id]).toBeUndefined()
    expect(sources[rule.id]).toBeUndefined()
  })

  it('a CSS-Module compile: the generated first class is not the modifier, the literal second one is', () => {
    const rule = ambient('.Card_card__a1b2c.card-home-2', { padding: '20px' })
    const styleRules: Record<string, StyleRule> = { [rule.id]: rule }
    const classIdsByName: Record<string, string> = {}
    const sources: Record<string, { file: string; selector: string }> = { [rule.id]: { file: 'Card.module.css', selector: '.card.card-home-2' } }
    registerModifierClasses(styleRules, classIdsByName, sources)
    expect(Object.keys(classIdsByName)).toEqual(['card-home-2'])
    expect(sources[classIdsByName['card-home-2']!]).toEqual({ file: 'Card.module.css', selector: '.card.card-home-2' })
  })

  it('leaves a name two compounds claim, a name with a rule of its own, and anything that is not two plain classes', () => {
    const styleRules: Record<string, StyleRule> = {}
    for (const selector of ['.btn.active', '.tab.active', '.a.owned', '.menu .open', '.x:hover.y', '.one.two.three', 'div.klass']) {
      const rule = ambient(selector, { color: 'red' })
      styleRules[rule.id] = rule
    }
    styleRules['cls:owned'] = classRule('owned')
    const classIdsByName: Record<string, string> = { owned: 'cls:owned' }
    const before = Object.keys(styleRules).sort()
    registerModifierClasses(styleRules, classIdsByName, {})
    expect(Object.keys(styleRules).sort()).toEqual(before)
    expect(classIdsByName).toEqual({ owned: 'cls:owned' })
  })
})
