/**
 * `style-03` — the removal half of the CSS write-back.
 *
 * Clearing a declaration in the inspector used to reach no code path at all:
 * the diff only iterated the properties a rule has NOW, so a removed one
 * produced no edit, no toast, and came straight back on the next reload. These
 * pin the primitive that fixes it, and — as much as the success cases — the
 * byte-preservation the whole `@core/css-codemods` tier exists for.
 */
import { describe, expect, it } from 'bun:test'
import { removeDeclaration } from '../removeDeclaration'
import { analyzeDeclarationTarget } from '../analyzeDeclarationTarget'

describe('removeDeclaration', () => {
  it('removes one declaration and leaves every other byte alone', () => {
    const css = '.card {\n  color: red;\n  /* keep me */\n  padding: 4px;\n}\n\n.other {\n  color: blue;\n}\n'

    const result = removeDeclaration(css, '.card', 'color')

    expect(result.changed).toBe(true)
    expect(result.css).toBe('.card {\n  /* keep me */\n  padding: 4px;\n}\n\n.other {\n  color: blue;\n}\n')
  })

  it('is a no-op when the property is already absent (idempotent re-send)', () => {
    const css = '.card {\n  color: red;\n}\n'
    const result = removeDeclaration(css, '.card', 'padding')
    expect(result.changed).toBe(false)
    expect(result.css).toBe(css)
  })

  it('is a no-op when the selector has no rule at all', () => {
    const css = '.card {\n  color: red;\n}\n'
    expect(removeDeclaration(css, '.ghost', 'color').changed).toBe(false)
  })

  it('matches the property case-insensitively, the way CSS does', () => {
    const css = '.card {\n  Color: red;\n}\n'
    expect(removeDeclaration(css, '.card', 'color').changed).toBe(true)
  })

  it('drops a rule left with nothing in it — `.card {}` is dead text', () => {
    const css = '.a {\n  color: red;\n}\n\n.card {\n  color: red;\n}\n'
    const result = removeDeclaration(css, '.card', 'color')
    expect(result.css).not.toContain('.card')
    expect(result.css).toContain('.a')
  })

  it('keeps a rule that still holds a comment — the user wrote that', () => {
    const css = '.card {\n  /* why */\n  color: red;\n}\n'
    const result = removeDeclaration(css, '.card', 'color')
    expect(result.css).toContain('.card')
    expect(result.css).toContain('/* why */')
  })

  describe('inside an @media block', () => {
    const css = '.card {\n  color: red;\n}\n\n@media (max-width: 768px) {\n  .card {\n    color: blue;\n    padding: 2px;\n  }\n}\n'

    it('removes the nested declaration, not the top-level one of the same name', () => {
      const result = removeDeclaration(css, '.card', 'color', { atMedia: '(max-width: 768px)' })
      expect(result.changed).toBe(true)
      expect(result.css).toContain('.card {\n  color: red;\n}')
      expect(result.css).toContain('padding: 2px')
      expect(result.css).not.toContain('color: blue')
    })

    it('removes the @media block once its last rule is empty', () => {
      const single = '@media print {\n  .card {\n    color: blue;\n  }\n}\n'
      const result = removeDeclaration(single, '.card', 'color', { atMedia: 'print' })
      expect(result.css.trim()).toBe('')
    })

    it('is a no-op when no block matches that query', () => {
      expect(removeDeclaration(css, '.card', 'color', { atMedia: '(min-width: 900px)' }).changed).toBe(false)
    })

    // Without `atMedia` a nested rule is not the target: the caller asked
    // about the UNCONDITIONAL cascade.
    it('never reaches into a media block when no query is given', () => {
      const nestedOnly = '@media print {\n  .card {\n    color: blue;\n  }\n}\n'
      expect(removeDeclaration(nestedOnly, '.card', 'color').changed).toBe(false)
    })
  })
})

describe('analyzeDeclarationTarget — the same gate guards a removal', () => {
  it('refuses to remove the first of two duplicate blocks — the second would still win', () => {
    const css = '.card {\n  color: red;\n}\n\n.card {\n  color: blue;\n}\n'
    const analysis = analyzeDeclarationTarget(css, '.card', 'color')
    expect(analysis.ok).toBe(false)
    if (!analysis.ok) expect(analysis.refusal.reason).toBe('duplicate-selector')
  })

  it('scopes the analysis to the @media block the write will land in', () => {
    // Two `.card` blocks at the TOP level, both setting `color`, would refuse —
    // but the write is going inside `@media print`, where there is only one.
    const css =
      '.card {\n  color: red;\n}\n\n.card {\n  color: green;\n}\n\n@media print {\n  .card {\n    color: blue;\n  }\n}\n'
    expect(analyzeDeclarationTarget(css, '.card', 'color', { atMedia: 'print' }).ok).toBe(true)
    expect(analyzeDeclarationTarget(css, '.card', 'color').ok).toBe(false)
  })

  it('catches a duplicate INSIDE the media block, which is the whole point of scoping it', () => {
    const css =
      '@media print {\n  .card {\n    color: red;\n  }\n}\n\n@media print {\n  .card {\n    color: blue;\n  }\n}\n'
    const analysis = analyzeDeclarationTarget(css, '.card', 'color', { atMedia: 'print' })
    expect(analysis.ok).toBe(false)
    if (!analysis.ok) expect(analysis.refusal.reason).toBe('duplicate-selector')
  })

  it('allows a write into a media block that does not exist yet', () => {
    expect(analyzeDeclarationTarget('.card {\n  color: red;\n}\n', '.card', 'color', { atMedia: 'print' }).ok).toBe(true)
  })
})
