/**
 * `style-03` — the removal half of the CSS write-back.
 *
 * Clearing a declaration in the inspector used to reach no code path at all:
 * the diff only iterated the properties a rule has NOW, so a removed one
 * produced no edit, no toast, and came straight back on the next reload. These
 * pin the primitive that fixes it, and — as much as the success cases — the
 * byte-preservation the whole `@core/css-codemods` tier exists for.
 *
 * P3-C (WB-16): a removal clears EVERY declaration of the property the scope's
 * matching rules carry, so the class really stops setting it. Removing only
 * the first of two left the second in effect, which is why `unset` refused on
 * a duplicate before.
 */
import { describe, expect, it } from 'bun:test'
import { removeDeclaration } from '../removeDeclaration'
import { analyzeDeclarationTarget } from '../analyzeDeclarationTarget'
import type { DeclarationWriteResult } from '../setDeclaration'

/** The rewritten text of a removal that must succeed. */
function removed(result: DeclarationWriteResult): { css: string; changed: boolean } {
  if (!result.ok) throw new Error(`expected a removal, got the refusal ${result.refusal.reason}`)
  return { css: result.css, changed: result.changed }
}

describe('removeDeclaration', () => {
  it('removes one declaration and leaves every other byte alone', () => {
    const css = '.card {\n  color: red;\n  /* keep me */\n  padding: 4px;\n}\n\n.other {\n  color: blue;\n}\n'
    expect(removed(removeDeclaration(css, '.card', 'color'))).toEqual({
      css: '.card {\n  /* keep me */\n  padding: 4px;\n}\n\n.other {\n  color: blue;\n}\n',
      changed: true,
    })
  })

  it('is a no-op when the property is already absent (idempotent re-send)', () => {
    const css = '.card {\n  color: red;\n}\n'
    expect(removed(removeDeclaration(css, '.card', 'padding'))).toEqual({ css, changed: false })
  })

  it('is a no-op when the selector has no rule at all', () => {
    const css = '.card {\n  color: red;\n}\n'
    expect(removed(removeDeclaration(css, '.ghost', 'color')).changed).toBe(false)
  })

  it('matches the property case-insensitively, the way CSS does', () => {
    const css = '.card {\n  Color: red;\n}\n'
    expect(removed(removeDeclaration(css, '.card', 'color')).changed).toBe(true)
  })

  it('drops a rule left with nothing in it — `.card {}` is dead text', () => {
    const css = '.a {\n  color: red;\n}\n\n.card {\n  color: red;\n}\n'
    const { css: next } = removed(removeDeclaration(css, '.card', 'color'))
    expect(next).not.toContain('.card')
    expect(next).toContain('.a')
  })

  it('keeps a rule that still holds a comment — the user wrote that', () => {
    const css = '.card {\n  /* why */\n  color: red;\n}\n'
    const { css: next } = removed(removeDeclaration(css, '.card', 'color'))
    expect(next).toContain('.card')
    expect(next).toContain('/* why */')
  })

  it('an unparseable stylesheet refuses by its own name', () => {
    expect(removeDeclaration('.card { color: red', '.card', 'color')).toMatchObject({
      ok: false,
      refusal: { reason: 'css-syntax' },
    })
  })

  describe('inside a conditional block', () => {
    const css = '.card {\n  color: red;\n}\n\n@media (max-width: 768px) {\n  .card {\n    color: blue;\n    padding: 2px;\n  }\n}\n'

    it('removes the nested declaration, not the top-level one of the same name', () => {
      const { css: next, changed } = removed(removeDeclaration(css, '.card', 'color', { atRule: 'media (max-width: 768px)' }))
      expect(changed).toBe(true)
      expect(next).toContain('.card {\n  color: red;\n}')
      expect(next).toContain('padding: 2px')
      expect(next).not.toContain('color: blue')
    })

    it('removes the block once its last rule is empty', () => {
      const single = '@media print {\n  .card {\n    color: blue;\n  }\n}\n'
      expect(removed(removeDeclaration(single, '.card', 'color', { atRule: 'media print' })).css.trim()).toBe('')
    })

    it('reaches a @supports block the same way (WB-31)', () => {
      const supports = '@supports (display: grid) {\n  .card {\n    display: grid;\n    color: red;\n  }\n}\n'
      expect(removed(removeDeclaration(supports, '.card', 'display', { atRule: 'supports (display: grid)' })).css).toBe(
        '@supports (display: grid) {\n  .card {\n    color: red;\n  }\n}\n',
      )
    })

    it('is a no-op when no block matches that query', () => {
      expect(removed(removeDeclaration(css, '.card', 'color', { atRule: 'media (min-width: 900px)' })).changed).toBe(false)
    })

    // Without `atRule` a nested rule is not the target: the caller asked about
    // the UNCONDITIONAL cascade.
    it('never reaches into a conditional block when no scope is given', () => {
      const nestedOnly = '@media print {\n  .card {\n    color: blue;\n  }\n}\n'
      expect(removed(removeDeclaration(nestedOnly, '.card', 'color')).changed).toBe(false)
    })
  })
})

describe('removeDeclaration — every declaration of it, so the class stops setting it (P3-C, WB-16)', () => {
  it('removes the property from BOTH duplicate blocks (it used to refuse: the second would still win)', () => {
    const css = '.card {\n  color: red;\n}\n\n.card {\n  color: blue;\n  margin: 0;\n}\n'
    expect(removed(removeDeclaration(css, '.card', 'color')).css).toBe('.card {\n  margin: 0;\n}\n')
  })

  it('removes both declarations when the property is set twice in one block', () => {
    const css = '.card {\n  color: red;\n  color: blue;\n  margin: 0;\n}\n'
    expect(removed(removeDeclaration(css, '.card', 'color')).css).toBe('.card {\n  margin: 0;\n}\n')
  })

  it('leaves a covering shorthand alone — clearing padding-top is not clearing padding', () => {
    const css = '.card {\n  padding-top: 4px;\n  padding: 8px;\n}\n'
    expect(removed(removeDeclaration(css, '.card', 'padding-top')).css).toBe('.card {\n  padding: 8px;\n}\n')
  })
})

describe('analyzeDeclarationTarget — still the gate for a styled template, scoped by atRule', () => {
  it('refuses the first of two duplicate blocks — the second would still win', () => {
    const css = '.card {\n  color: red;\n}\n\n.card {\n  color: blue;\n}\n'
    const analysis = analyzeDeclarationTarget(css, '.card', 'color')
    expect(analysis.ok).toBe(false)
    if (!analysis.ok) expect(analysis.refusal.reason).toBe('duplicate-selector')
  })

  it('scopes the analysis to the block the write will land in', () => {
    // Two `.card` blocks at the TOP level, both setting `color`, would refuse —
    // but the write is going inside `@media print`, where there is only one.
    const css =
      '.card {\n  color: red;\n}\n\n.card {\n  color: green;\n}\n\n@media print {\n  .card {\n    color: blue;\n  }\n}\n'
    expect(analyzeDeclarationTarget(css, '.card', 'color', { atRule: 'media print' }).ok).toBe(true)
    expect(analyzeDeclarationTarget(css, '.card', 'color').ok).toBe(false)
  })

  it('catches a duplicate INSIDE the block, which is the whole point of scoping it', () => {
    const css =
      '@media print {\n  .card {\n    color: red;\n  }\n}\n\n@media print {\n  .card {\n    color: blue;\n  }\n}\n'
    const analysis = analyzeDeclarationTarget(css, '.card', 'color', { atRule: 'media print' })
    expect(analysis.ok).toBe(false)
    if (!analysis.ok) expect(analysis.refusal.reason).toBe('duplicate-selector')
  })

  it('allows a write into a block that does not exist yet', () => {
    expect(analyzeDeclarationTarget('.card {\n  color: red;\n}\n', '.card', 'color', { atRule: 'media print' }).ok).toBe(true)
  })
})
