import { describe, expect, it } from 'bun:test'
import { setDeclaration, setDeclarationAtMedia } from '../setDeclaration'

describe('setDeclaration', () => {
  it('updates an existing declaration in place, preserving everything else byte-for-byte', () => {
    const css = '.card {\n  color: red;\n  padding: 8px;\n}\n'
    const { css: next, changed } = setDeclaration(css, '.card', 'color', 'blue')
    expect(changed).toBe(true)
    expect(next).toBe('.card {\n  color: blue;\n  padding: 8px;\n}\n')
  })

  it('is a no-op (changed: false, identical output) when the value already matches', () => {
    const css = '.card {\n  color: blue;\n}\n'
    const result = setDeclaration(css, '.card', 'color', 'blue')
    expect(result.changed).toBe(false)
    expect(result.css).toBe(css)
  })

  it('appends a new declaration at the end of an existing rule when the property is absent', () => {
    const css = '.card {\n  color: red;\n}\n'
    const { css: next, changed } = setDeclaration(css, '.card', 'padding', '4px')
    expect(changed).toBe(true)
    expect(next).toBe('.card {\n  color: red;\n  padding: 4px;\n}\n')
  })

  it('creates the rule at the end of the file when the selector does not exist', () => {
    const css = '.other {\n  color: green;\n}\n'
    const { css: next, changed } = setDeclaration(css, '.card', 'color', 'blue')
    expect(changed).toBe(true)
    // The original file's own trailing newline is preserved after the new rule.
    expect(next).toBe('.other {\n  color: green;\n}\n\n.card {\n  color: blue;\n}\n')
  })

  it('creates a fresh rule cleanly in an otherwise-empty file', () => {
    const { css: next, changed } = setDeclaration('', '.card', 'color', 'blue')
    expect(changed).toBe(true)
    expect(next).toBe('.card {\n  color: blue;\n}')
  })

  it('matches the property case-insensitively (CSS property names are case-insensitive)', () => {
    const css = '.card {\n  Color: red;\n}\n'
    const { css: next } = setDeclaration(css, '.card', 'color', 'blue')
    expect(next).toBe('.card {\n  Color: blue;\n}\n')
  })

  it('only matches the FIRST rule with an exact selector match, leaving a duplicate untouched', () => {
    const css = '.card {\n  color: red;\n}\n.card {\n  color: green;\n}\n'
    const { css: next } = setDeclaration(css, '.card', 'color', 'blue')
    expect(next).toBe('.card {\n  color: blue;\n}\n.card {\n  color: green;\n}\n')
  })

  it('does not match a compound selector list containing the target as a substring', () => {
    const css = '.card, .alt {\n  color: red;\n}\n'
    const { css: next, changed } = setDeclaration(css, '.card', 'color', 'blue')
    // No exact match — a new `.card` rule is appended rather than touching the compound rule.
    expect(changed).toBe(true)
    expect(next).toContain('.card, .alt {\n  color: red;\n}')
    expect(next).toContain('.card {\n  color: blue;\n}')
  })

  it('preserves an unrelated comment in the file untouched', () => {
    const css = '/* header styles */\n.header {\n  color: black;\n}\n\n.card {\n  color: red;\n}\n'
    const { css: next } = setDeclaration(css, '.card', 'color', 'blue')
    expect(next).toContain('/* header styles */')
    expect(next).toContain('.card {\n  color: blue;\n}\n')
  })
})

describe('setDeclarationAtMedia', () => {
  it('updates a declaration inside an existing matching @media block', () => {
    const css = '@media (max-width: 860px) {\n  .card {\n    color: red;\n  }\n}\n'
    const { css: next, changed } = setDeclarationAtMedia(css, '.card', '(max-width: 860px)', 'color', 'blue')
    expect(changed).toBe(true)
    expect(next).toBe('@media (max-width: 860px) {\n  .card {\n    color: blue;\n  }\n}\n')
  })

  it('creates the rule inside an existing @media block when the rule is absent', () => {
    const css = '@media (max-width: 860px) {\n  .other {\n    color: green;\n  }\n}\n'
    const { css: next, changed } = setDeclarationAtMedia(css, '.card', '(max-width: 860px)', 'color', 'blue')
    expect(changed).toBe(true)
    expect(next).toContain('@media (max-width: 860px) {')
    expect(next).toContain('.card {\n    color: blue;\n  }')
  })

  it('creates a brand-new @media block at the end of the file when neither exists', () => {
    const css = '.card {\n  color: red;\n}\n'
    const { css: next, changed } = setDeclarationAtMedia(css, '.card', '(max-width: 860px)', 'color', 'blue')
    expect(changed).toBe(true)
    expect(next).toContain('.card {\n  color: red;\n}')
    expect(next).toContain('@media (max-width: 860px) {\n  .card {\n    color: blue;\n  }\n}')
  })

  it('does not confuse two different media queries', () => {
    const css = '@media (max-width: 400px) {\n  .card {\n    color: red;\n  }\n}\n'
    const { css: next } = setDeclarationAtMedia(css, '.card', '(max-width: 860px)', 'color', 'blue')
    expect(next).toContain('@media (max-width: 400px) {\n  .card {\n    color: red;\n  }\n}')
    expect(next).toContain('@media (max-width: 860px) {')
  })
})
