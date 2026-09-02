import { describe, expect, it } from 'bun:test'
import { insertRule } from '../insertRule'

describe('insertRule', () => {
  it('appends a brand-new rule at the end of the file, preserving everything before it byte-for-byte', () => {
    const css = '.card {\n  color: red;\n}\n'
    const { css: next, changed } = insertRule(css, '.new-class', { color: 'blue', padding: '8px' })
    expect(changed).toBe(true)
    // The original file's own trailing newline is preserved after the new rule.
    expect(next).toBe('.card {\n  color: red;\n}\n\n.new-class {\n  color: blue;\n  padding: 8px;\n}\n')
  })

  it('creates a clean rule in an otherwise-empty file', () => {
    const { css: next, changed } = insertRule('', '.new-class', { color: 'blue' })
    expect(changed).toBe(true)
    expect(next).toBe('.new-class {\n  color: blue;\n}')
  })

  it('preserves declaration order as supplied', () => {
    const { css: next } = insertRule('', '.card', { display: 'flex', gap: '8px', color: 'red' })
    expect(next).toBe('.card {\n  display: flex;\n  gap: 8px;\n  color: red;\n}')
  })

  it('preserves an unrelated comment and untouched rule verbatim', () => {
    const css = '/* header styles */\n.header {\n  color: black;\n}\n'
    const { css: next } = insertRule(css, '.card', { color: 'red' })
    expect(next).toContain('/* header styles */\n.header {\n  color: black;\n}\n')
    expect(next).toContain('.card {\n  color: red;\n}')
  })

  it('merges into an EXISTING exact-selector rule instead of creating a duplicate block (one honest target)', () => {
    const css = '.card {\n  color: red;\n}\n'
    const { css: next, changed } = insertRule(css, '.card', { padding: '8px' })
    expect(changed).toBe(true)
    // Exactly one `.card` block in the output — declaration appended to the
    // existing rule, not a second shadowing block.
    expect(next).toBe('.card {\n  color: red;\n  padding: 8px;\n}\n')
    expect(next.match(/\.card\s*{/g)).toHaveLength(1)
  })

  it('is a no-op (changed: false, identical output) when every declaration already matches the existing rule', () => {
    const css = '.card {\n  color: red;\n  padding: 8px;\n}\n'
    const result = insertRule(css, '.card', { color: 'red', padding: '8px' })
    expect(result.changed).toBe(false)
    expect(result.css).toBe(css)
  })

  it('only matches the FIRST rule with an exact selector, converging declarations onto it and leaving a duplicate block untouched', () => {
    const css = '.card {\n  color: red;\n}\n.card {\n  color: green;\n}\n'
    const { css: next } = insertRule(css, '.card', { padding: '8px' })
    expect(next).toBe('.card {\n  color: red;\n  padding: 8px;\n}\n.card {\n  color: green;\n}\n')
  })

  it('does not match a compound selector list containing the target as a substring', () => {
    const css = '.card, .alt {\n  color: red;\n}\n'
    const { css: next, changed } = insertRule(css, '.card', { color: 'blue' })
    expect(changed).toBe(true)
    expect(next).toContain('.card, .alt {\n  color: red;\n}')
    expect(next).toContain('.card {\n  color: blue;\n}')
  })
})

describe('insertRule — atMedia', () => {
  it('creates a brand-new @media block at the end of the file when neither it nor the rule exists', () => {
    const css = '.card {\n  color: red;\n}\n'
    const { css: next, changed } = insertRule(css, '.card', { color: 'blue' }, { atMedia: '(max-width: 860px)' })
    expect(changed).toBe(true)
    expect(next).toContain('.card {\n  color: red;\n}')
    expect(next).toContain('@media (max-width: 860px) {\n  .card {\n    color: blue;\n  }\n}')
  })

  it('creates the rule inside an existing matching @media block when the rule is absent there', () => {
    const css = '@media (max-width: 860px) {\n  .other {\n    color: green;\n  }\n}\n'
    const { css: next, changed } = insertRule(css, '.card', { color: 'blue' }, { atMedia: '(max-width: 860px)' })
    expect(changed).toBe(true)
    expect(next).toContain('@media (max-width: 860px) {')
    expect(next).toContain('.other {\n    color: green;\n  }')
    expect(next).toContain('.card {\n    color: blue;\n  }')
  })

  it('merges into an existing rule already inside the matching @media block', () => {
    const css = '@media (max-width: 860px) {\n  .card {\n    color: red;\n  }\n}\n'
    const { css: next, changed } = insertRule(css, '.card', { padding: '8px' }, { atMedia: '(max-width: 860px)' })
    expect(changed).toBe(true)
    expect(next).toBe('@media (max-width: 860px) {\n  .card {\n    color: red;\n    padding: 8px;\n  }\n}\n')
  })

  it('does not confuse two different media queries', () => {
    const css = '@media (max-width: 400px) {\n  .card {\n    color: red;\n  }\n}\n'
    const { css: next } = insertRule(css, '.card', { color: 'blue' }, { atMedia: '(max-width: 860px)' })
    expect(next).toContain('@media (max-width: 400px) {\n  .card {\n    color: red;\n  }\n}')
    expect(next).toContain('@media (max-width: 860px) {')
  })
})
