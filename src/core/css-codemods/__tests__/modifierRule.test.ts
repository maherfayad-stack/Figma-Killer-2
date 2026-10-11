/**
 * G-2b — the stylesheet half of a per-instance class override: a modifier rule
 * one class more specific than the base, written next to it, and taken away
 * again byte for byte. The fixtures are a plain stylesheet, a CRLF one, a CSS
 * Module and a base that only exists inside a media block.
 */
import { describe, expect, it } from 'bun:test'
import {
  classNamesInStylesheet,
  modifierSelector,
  parseModifierSelector,
  readRuleDeclarations,
  removeModifierDeclarations,
  ruleExists,
  setModifierDeclarations,
  singleClassName,
} from '..'

const CARD = '.card {\n  padding: 8px;\n  gap: 4px;\n}\n\n.card__title {\n  color: red;\n}\n'

function written(result: ReturnType<typeof setModifierDeclarations>): { css: string; created: boolean; changed: boolean } {
  if (!result.ok) throw new Error(`expected a write, got the refusal ${result.refusal.reason}`)
  return { css: result.css, created: result.created, changed: result.changed }
}

describe('modifierSelector / parseModifierSelector', () => {
  it('builds a compound selector for a plain stylesheet and :global() for a CSS Module', () => {
    expect(modifierSelector('.card', 'card-home-2', 'plain')).toBe('.card.card-home-2')
    expect(modifierSelector('.card', 'card-home-2', 'module')).toBe('.card:global(.card-home-2)')
  })

  it('reads both spellings back, and nothing else', () => {
    expect(parseModifierSelector('.card.card-home-2')).toEqual({ base: '.card', token: 'card-home-2' })
    expect(parseModifierSelector('.card:global(.card-home-2)')).toEqual({ base: '.card', token: 'card-home-2' })
    expect(parseModifierSelector('.card:hover')).toBeNull()
    expect(parseModifierSelector('.card .title')).toBeNull()
    expect(parseModifierSelector('.a.b.c')).toBeNull()
    expect(parseModifierSelector('div.card')).toBeNull()
  })

  it('accepts only one plain class as a base', () => {
    expect(singleClassName('.card')).toBe('card')
    expect(singleClassName('.card.wide')).toBeNull()
    expect(singleClassName('.card:hover')).toBeNull()
  })
})

describe('setModifierDeclarations', () => {
  it('writes the modifier right after the base rule and touches nothing else', () => {
    const result = written(setModifierDeclarations(CARD, '.card', '.card.card-home-2', { padding: '20px' }))
    expect(result).toEqual({
      css: '.card {\n  padding: 8px;\n  gap: 4px;\n}\n\n.card.card-home-2 {\n  padding: 20px;\n}\n\n.card__title {\n  color: red;\n}\n',
      created: true,
      changed: true,
    })
  })

  it('a second edit of the same instance converges on the one modifier rule', () => {
    const first = written(setModifierDeclarations(CARD, '.card', '.card.card-home-2', { padding: '20px' })).css
    const second = written(setModifierDeclarations(first, '.card', '.card.card-home-2', { padding: '24px', gap: '12px' }))
    expect(second.created).toBe(false)
    expect(second.css).toBe('.card {\n  padding: 8px;\n  gap: 4px;\n}\n\n.card.card-home-2 {\n  padding: 24px;\n  gap: 12px;\n}\n\n.card__title {\n  color: red;\n}\n')
  })

  it('is a no-op when the modifier already says it', () => {
    const first = written(setModifierDeclarations(CARD, '.card', '.card.card-home-2', { padding: '20px' })).css
    expect(written(setModifierDeclarations(first, '.card', '.card.card-home-2', { padding: '20px' }))).toEqual({ css: first, created: false, changed: false })
  })

  it('writes a CSS Module modifier with :global()', () => {
    const result = written(setModifierDeclarations(CARD, '.card', '.card:global(.card-home-2)', { padding: '20px' }))
    expect(result.css).toContain('.card:global(.card-home-2) {\n  padding: 20px;\n}')
  })

  it('appends at the end of the file when the base is not written in the stylesheet', () => {
    const css = '.other {\n  margin: 0;\n}\n'
    expect(written(setModifierDeclarations(css, '.card', '.card.card-home-2', { padding: '20px' })).css).toBe(
      '.other {\n  margin: 0;\n}\n\n.card.card-home-2 {\n  padding: 20px;\n}\n',
    )
  })

  it('writes inside the same media block as the base, indented with it', () => {
    const css = '.card {\n  padding: 8px;\n}\n\n@media (max-width: 600px) {\n  .card {\n    padding: 4px;\n  }\n}\n'
    const result = written(setModifierDeclarations(css, '.card', '.card.card-home-2', { padding: '2px' }, { atRule: 'media (max-width: 600px)' }))
    expect(result.css).toBe(
      '.card {\n  padding: 8px;\n}\n\n@media (max-width: 600px) {\n  .card {\n    padding: 4px;\n  }\n\n  .card.card-home-2 {\n    padding: 2px;\n  }\n}\n',
    )
  })

  it('creates the media block at the end of the file when it does not exist', () => {
    const result = written(setModifierDeclarations(CARD, '.card', '.card.card-home-2', { padding: '2px' }, { atRule: 'media (max-width: 600px)' }))
    expect(result.css.startsWith(CARD)).toBe(true)
    expect(result.css).toContain('@media (max-width: 600px) {\n  .card.card-home-2 {\n    padding: 2px;\n  }\n}')
  })

  it('keeps a CRLF stylesheet CRLF', () => {
    const crlf = CARD.replace(/\n/g, '\r\n')
    const { css } = written(setModifierDeclarations(crlf, '.card', '.card.card-home-2', { padding: '20px' }))
    expect(css.replace(/\r\n/g, '')).not.toContain('\n')
    expect(css).toContain('.card.card-home-2 {\r\n  padding: 20px;\r\n}')
  })

  it('refuses a stylesheet that does not parse, by name', () => {
    const result = setModifierDeclarations('.card { padding: ', '.card', '.card.x', { padding: '1px' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('css-syntax')
  })
})

describe('removeModifierDeclarations / readRuleDeclarations / ruleExists', () => {
  it('removes a property, and the rule once it is empty, restoring the original bytes', () => {
    const withModifier = written(setModifierDeclarations(CARD, '.card', '.card.card-home-2', { padding: '20px' })).css
    const result = removeModifierDeclarations(withModifier, '.card.card-home-2', ['padding'])
    expect(result.ok && result.css).toBe(CARD)
  })

  it('keeps the rule while other declarations remain', () => {
    const withModifier = written(setModifierDeclarations(CARD, '.card', '.card.card-home-2', { padding: '20px', gap: '12px' })).css
    const result = removeModifierDeclarations(withModifier, '.card.card-home-2', ['padding'])
    expect(result.ok && result.css).toContain('.card.card-home-2 {\n  gap: 12px;\n}')
  })

  it('reads the declarations a rule carries and whether a rule exists', () => {
    const withModifier = written(setModifierDeclarations(CARD, '.card', '.card.card-home-2', { padding: '20px' })).css
    expect(readRuleDeclarations(withModifier, '.card.card-home-2')).toEqual({ padding: '20px' })
    expect(ruleExists(withModifier, '.card.card-home-2')).toBe(true)
    expect(ruleExists(CARD, '.card.card-home-2')).toBe(false)
  })

  it('lists every class name a stylesheet mentions, comments excluded', () => {
    expect(classNamesInStylesheet('/* .ghost */ .card.wide:hover { } @media (min-width: 1px) { .x-1 { } }')).toEqual(new Set(['card', 'wide', 'x-1']))
  })
})
