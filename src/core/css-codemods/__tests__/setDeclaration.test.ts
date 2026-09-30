/**
 * `setDeclaration` — one class declaration written where the cascade reads it,
 * in the unconditional rules or inside `@media`/`@container`/`@supports`.
 *
 * The first block pins the byte-preservation this whole tier exists for. The
 * second is P3-C's WB-16: the three shapes `analyzeDeclarationTarget` used to
 * REFUSE — a selector declared twice, a property twice in one block, a
 * shorthand after the longhand — each have a real line the canvas is showing,
 * and are writes now; the only refusal left is a covering `!important`. The
 * third is WB-31: `@container` and `@supports` are written exactly like
 * `@media`. Every expectation is the exact output text; the pricing-table
 * fixture shares nothing with the eSIM corpus.
 */
import { describe, expect, it } from 'bun:test'
import { setDeclaration, type DeclarationWriteResult } from '../setDeclaration'

/** The rewritten text of a write that must succeed. */
function written(result: DeclarationWriteResult): { css: string; changed: boolean } {
  if (!result.ok) throw new Error(`expected a write, got the refusal ${result.refusal.reason}`)
  return { css: result.css, changed: result.changed }
}

describe('setDeclaration — the ordinary write', () => {
  it('updates an existing declaration in place, preserving everything else byte-for-byte', () => {
    const css = '.card {\n  color: red;\n  padding: 8px;\n}\n'
    expect(written(setDeclaration(css, '.card', 'color', 'blue'))).toEqual({
      css: '.card {\n  color: blue;\n  padding: 8px;\n}\n',
      changed: true,
    })
  })

  it('is a no-op (changed: false, identical output) when the value already matches', () => {
    const css = '.card {\n  color: blue;\n}\n'
    expect(written(setDeclaration(css, '.card', 'color', 'blue'))).toEqual({ css, changed: false })
  })

  it('appends a new declaration at the end of an existing rule when the property is absent', () => {
    const css = '.card {\n  color: red;\n}\n'
    expect(written(setDeclaration(css, '.card', 'padding', '4px')).css).toBe('.card {\n  color: red;\n  padding: 4px;\n}\n')
  })

  it('creates the rule at the end of the file when the selector does not exist', () => {
    const css = '.other {\n  color: green;\n}\n'
    // The original file's own trailing newline is preserved after the new rule.
    expect(written(setDeclaration(css, '.card', 'color', 'blue')).css).toBe(
      '.other {\n  color: green;\n}\n\n.card {\n  color: blue;\n}\n',
    )
  })

  it('creates a fresh rule cleanly in an otherwise-empty file', () => {
    expect(written(setDeclaration('', '.card', 'color', 'blue')).css).toBe('.card {\n  color: blue;\n}')
  })

  it('matches the property case-insensitively (CSS property names are case-insensitive)', () => {
    const css = '.card {\n  Color: red;\n}\n'
    expect(written(setDeclaration(css, '.card', 'color', 'blue')).css).toBe('.card {\n  Color: blue;\n}\n')
  })

  it('does not match a compound selector list containing the target as a substring', () => {
    const css = '.card, .alt {\n  color: red;\n}\n'
    const next = written(setDeclaration(css, '.card', 'color', 'blue')).css
    // No exact match — a new `.card` rule is appended rather than touching the compound rule.
    expect(next).toContain('.card, .alt {\n  color: red;\n}')
    expect(next).toContain('.card {\n  color: blue;\n}')
  })

  it('preserves an unrelated comment in the file untouched', () => {
    const css = '/* header styles */\n.header {\n  color: black;\n}\n\n.card {\n  color: red;\n}\n'
    const next = written(setDeclaration(css, '.card', 'color', 'blue')).css
    expect(next).toContain('/* header styles */')
    expect(next).toContain('.card {\n  color: blue;\n}\n')
  })
})

describe('setDeclaration — the declaration the cascade reads (P3-C, WB-16)', () => {
  it('a selector declared twice: writes the LATER block, which is the one taking effect', () => {
    const css = '.price { color: red; }\n.price { color: blue; }\n'
    expect(written(setDeclaration(css, '.price', 'color', 'green')).css).toBe('.price { color: red; }\n.price { color: green; }\n')
  })

  it('a later block that does not set the property leaves the first block the target', () => {
    const css = '.price {\n  color: red;\n}\n.price {\n  margin: 0;\n}\n'
    expect(written(setDeclaration(css, '.price', 'color', 'blue')).css).toBe('.price {\n  color: blue;\n}\n.price {\n  margin: 0;\n}\n')
  })

  it('a property twice in one block: writes the last one', () => {
    const css = '.price {\n  color: red;\n  color: blue;\n}\n'
    expect(written(setDeclaration(css, '.price', 'color', 'green')).css).toBe('.price {\n  color: red;\n  color: green;\n}\n')
  })

  it('a covering shorthand after the longhand: the longhand goes right after the shorthand', () => {
    const css = '.price {\n  padding-top: 4px;\n  padding: 8px;\n}\n'
    expect(written(setDeclaration(css, '.price', 'padding-top', '12px')).css).toBe(
      '.price {\n  padding-top: 4px;\n  padding: 8px;\n  padding-top: 12px;\n}\n',
    )
  })

  it('a shorthand in a later block only: the longhand joins that block, after it', () => {
    const css = '.price {\n  padding-top: 4px;\n}\n.price {\n  padding: 8px;\n}\n'
    expect(written(setDeclaration(css, '.price', 'padding-top', '12px')).css).toBe(
      '.price {\n  padding-top: 4px;\n}\n.price {\n  padding: 8px;\n  padding-top: 12px;\n}\n',
    )
  })

  it('a shorthand BEFORE the longhand is not the winner — the longhand is rewritten in place', () => {
    const css = '.price {\n  padding: 8px;\n  padding-top: 4px;\n}\n'
    expect(written(setDeclaration(css, '.price', 'padding-top', '12px')).css).toBe('.price {\n  padding: 8px;\n  padding-top: 12px;\n}\n')
  })

  it('an !important longhand is the winner over a later plain shorthand', () => {
    const css = '.price {\n  padding-top: 4px !important;\n  padding: 8px;\n}\n'
    expect(written(setDeclaration(css, '.price', 'padding-top', '12px')).css).toBe(
      '.price {\n  padding-top: 12px !important;\n  padding: 8px;\n}\n',
    )
  })

  it('still refuses a covering !important shorthand — there is no honest single write', () => {
    const css = '.price {\n  padding-top: 4px;\n  padding: 8px !important;\n}\n'
    expect(setDeclaration(css, '.price', 'padding-top', '12px')).toMatchObject({
      ok: false,
      refusal: { reason: 'important-override' },
    })
  })

  it('an unparseable stylesheet refuses by its own name', () => {
    expect(setDeclaration('.price { color: red', '.price', 'color', 'blue')).toMatchObject({
      ok: false,
      refusal: { reason: 'css-syntax' },
    })
  })

  it('is a no-op, returning the same bytes, when the winning value is already there', () => {
    const css = '.price { color: red; }\n.price { color: blue; }\n'
    expect(setDeclaration(css, '.price', 'color', 'blue')).toEqual({ ok: true, css, changed: false })
  })
})

describe('setDeclaration — inside a conditional block (WB-31)', () => {
  it('updates a declaration inside an existing matching @media block', () => {
    const css = '@media (max-width: 860px) {\n  .card {\n    color: red;\n  }\n}\n'
    expect(written(setDeclaration(css, '.card', 'color', 'blue', { atRule: 'media (max-width: 860px)' })).css).toBe(
      '@media (max-width: 860px) {\n  .card {\n    color: blue;\n  }\n}\n',
    )
  })

  it('creates the rule inside an existing @media block when the rule is absent', () => {
    const css = '@media (max-width: 860px) {\n  .other {\n    color: green;\n  }\n}\n'
    const next = written(setDeclaration(css, '.card', 'color', 'blue', { atRule: 'media (max-width: 860px)' })).css
    expect(next).toContain('@media (max-width: 860px) {')
    expect(next).toContain('.card {\n    color: blue;\n  }')
  })

  it('creates a brand-new @media block at the end of the file when neither exists', () => {
    const css = '.card {\n  color: red;\n}\n'
    const next = written(setDeclaration(css, '.card', 'color', 'blue', { atRule: 'media (max-width: 860px)' })).css
    expect(next).toContain('.card {\n  color: red;\n}')
    expect(next).toContain('@media (max-width: 860px) {\n  .card {\n    color: blue;\n  }\n}')
  })

  it('does not confuse two different media queries', () => {
    const css = '@media (max-width: 400px) {\n  .card {\n    color: red;\n  }\n}\n'
    const next = written(setDeclaration(css, '.card', 'color', 'blue', { atRule: 'media (max-width: 860px)' })).css
    expect(next).toContain('@media (max-width: 400px) {\n  .card {\n    color: red;\n  }\n}')
    expect(next).toContain('@media (max-width: 860px) {')
  })

  it('writes into an existing @container block', () => {
    const css = '@container card (min-width: 400px) {\n  .price {\n    color: red;\n  }\n}\n'
    expect(written(setDeclaration(css, '.price', 'color', 'blue', { atRule: 'container card (min-width: 400px)' })).css).toBe(
      '@container card (min-width: 400px) {\n  .price {\n    color: blue;\n  }\n}\n',
    )
  })

  it('creates a missing @supports block at the end, leaving the unconditional rule alone', () => {
    const css = '.price {\n  color: red;\n}\n'
    expect(written(setDeclaration(css, '.price', 'display', 'grid', { atRule: 'supports (display: grid)' })).css).toBe(
      '.price {\n  color: red;\n}\n\n@supports (display: grid) {\n  .price {\n    display: grid;\n  }\n}\n',
    )
  })

  it('never reaches into a @media block with the same query spelled as @container', () => {
    const css = '@media (min-width: 400px) {\n  .price {\n    color: red;\n  }\n}\n'
    const next = written(setDeclaration(css, '.price', 'color', 'blue', { atRule: 'container (min-width: 400px)' })).css
    expect(next).toContain('@media (min-width: 400px) {\n  .price {\n    color: red;\n  }\n}')
    expect(next).toContain('@container (min-width: 400px) {\n  .price {\n    color: blue;\n  }\n}')
  })

  it('refuses a scope that is not one of the three at-rules', () => {
    expect(setDeclaration('.a {}', '.a', 'color', 'red', { atRule: 'layer base' })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid-at-rule' },
    })
  })
})
