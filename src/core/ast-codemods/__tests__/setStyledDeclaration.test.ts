/**
 * setStyledDeclaration — W4-4 Phase B's write half.
 *
 * The cases that matter here are the REFUSALS. A styled template is the one
 * write target in Studio where "the value the canvas shows" and "the value the
 * file contains" routinely differ — an interpolation resolves to `8px` on the
 * board and is written as `${SPACING.md}` on disk — so the whole feature is
 * only honest if every such declaration declines by name instead of writing
 * bytes into the wrong place.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setStyledDeclaration } from '../setStyledDeclaration'
import { extractCssInJs } from '@core/page-parser'
import { Project } from 'ts-morph'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'styled-writeback-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Writes `source` to a file and asks Phase A's own extractor where the
 * template is and what class it registered — so every test targets exactly
 * what the running editor would target, rather than a hand-counted line/col
 * that could drift from the parser.
 */
function fixture(source: string): { file: string; className: string; line: number; col: number } {
  const file = join(dir, 'Card.tsx')
  writeFileSync(file, source, 'utf8')
  const project = new Project({ useInMemoryFileSystem: false })
  const sourceFile = project.addSourceFileAtPath(file)
  const extracted = extractCssInJs(sourceFile, 'Card.tsx')
  const template = extracted.extraction.templates[0]
  if (!template) throw new Error('fixture produced no template')
  return { file, className: template.className, line: template.loc.line, col: template.loc.col }
}

const IMPORT = "import styled from 'styled-components'\n"

describe('setStyledDeclaration — writes', () => {
  test('rewrites a literal value in place, leaving the rest of the template byte-identical', () => {
    const { file, className, line, col } = fixture(
      `${IMPORT}export const Card = styled.div\`\n  color: red;\n  padding: 8px;\n\``,
    )

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'color', value: 'rebeccapurple',
    })

    expect(result).toEqual({ ok: true, changed: true })
    expect(readFileSync(file, 'utf8')).toBe(
      `${IMPORT}export const Card = styled.div\`\n  color: rebeccapurple;\n  padding: 8px;\n\``,
    )
  })

  test('writes into a nested `&:hover` block, matched by its flattened selector', () => {
    const { file, className, line, col } = fixture(
      `${IMPORT}export const Card = styled.div\`\n  color: red;\n  &:hover {\n    color: blue;\n  }\n\``,
    )

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}:hover`, property: 'color', value: 'green',
    })

    expect(result).toEqual({ ok: true, changed: true })
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('color: red;')
    expect(written).toContain('color: green;')
  })

  test('writes inside a nested @media block when the caller names its query', () => {
    const { file, className, line, col } = fixture(
      `${IMPORT}export const Card = styled.div\`\n  width: 100%;\n  @media (min-width: 700px) {\n    width: 50%;\n  }\n\``,
    )

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'width', value: '33%',
      atMedia: '(min-width: 700px)',
    })

    expect(result).toEqual({ ok: true, changed: true })
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('width: 100%;')
    expect(written).toContain('width: 33%;')
  })

  test('an unconditional edit never lands inside a @media block that shares the property', () => {
    const { file, className, line, col } = fixture(
      `${IMPORT}export const Card = styled.div\`\n  width: 100%;\n  @media (min-width: 700px) {\n    width: 50%;\n  }\n\``,
    )

    setStyledDeclaration({ file, line, col, className, selector: `.${className}`, property: 'width', value: '80%' })

    const written = readFileSync(file, 'utf8')
    expect(written).toContain('width: 80%;')
    expect(written).toContain('width: 50%;')
  })

  test('an unchanged value reports `changed: false` and does not rewrite the file', () => {
    const source = `${IMPORT}export const Card = styled.div\`\n  color: red;\n\``
    const { file, className, line, col } = fixture(source)

    expect(setStyledDeclaration({ file, line, col, className, selector: `.${className}`, property: 'color', value: 'red' }))
      .toEqual({ ok: true, changed: false })
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('a declaration written after an interpolated sibling still resolves its own offsets', () => {
    const { file, className, line, col } = fixture(
      `${IMPORT}export const Card = styled.div\`\n  color: \${(p) => p.tone};\n  padding: 8px;\n\``,
    )

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'padding', value: '16px',
    })

    expect(result).toEqual({ ok: true, changed: true })
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('padding: 16px;')
    expect(written).toContain('color: ${(p) => p.tone};')
  })
})

describe('setStyledDeclaration — refusals', () => {
  test('refuses an interpolated value rather than writing over the interpolation', () => {
    const source = `${IMPORT}const SPACING = { md: '8px' }\nexport const Card = styled.div\`\n  padding: \${SPACING.md};\n\``
    const { file, className, line, col } = fixture(source)

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'padding', value: '16px',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('interpolated-value')
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('refuses a value only PARTLY written here', () => {
    const source = `${IMPORT}const gap = '8px'\nexport const Card = styled.div\`\n  margin: \${gap} auto;\n\``
    const { file, className, line, col } = fixture(source)

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'margin', value: '0 auto',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('interpolated-value')
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('refuses a declaration that arrives through a spliced mixin — its bytes are in another template', () => {
    const source =
      "import styled, { css } from 'styled-components'\n" +
      'const centered = css`\n  display: flex;\n`\n' +
      'export const Card = styled.div`\n  ${centered}\n  color: red;\n`'
    const file = join(dir, 'Card.tsx')
    writeFileSync(file, source, 'utf8')
    const project = new Project({ useInMemoryFileSystem: false })
    const extracted = extractCssInJs(project.addSourceFileAtPath(file), 'Card.tsx')
    const card = extracted.extraction.templates.find((t) => t.componentName === 'Card')!

    const result = setStyledDeclaration({
      file,
      line: card.loc.line,
      col: card.loc.col,
      className: card.className,
      selector: `.${card.className}`,
      property: 'display',
      value: 'grid',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('declaration-not-in-template')
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('forwards `analyzeDeclarationTarget`s shorthand verdict instead of writing an invisible edit', () => {
    const source = `${IMPORT}export const Card = styled.div\`\n  padding-top: 4px;\n  padding: 8px;\n\``
    const { file, className, line, col } = fixture(source)

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'padding-top', value: '12px',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('shorthand-override')
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('refuses a duplicate declaration under one selector', () => {
    const source = `${IMPORT}export const Card = styled.div\`\n  color: red;\n  color: blue;\n\``
    const { file, className, line, col } = fixture(source)

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'color', value: 'green',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('duplicate-declaration')
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('refuses a property the template does not declare — nothing is appended', () => {
    const source = `${IMPORT}export const Card = styled.div\`\n  color: red;\n\``
    const { file, className, line, col } = fixture(source)

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'font-size', value: '12px',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('declaration-not-in-template')
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('refuses a value that would end the declaration or the template', () => {
    const source = `${IMPORT}export const Card = styled.div\`\n  color: red;\n\``
    const { file, className, line, col } = fixture(source)

    for (const value of ['red; margin: 0', 'red`', '${danger}', 'red }']) {
      const result = setStyledDeclaration({ file, line, col, className, selector: `.${className}`, property: 'color', value })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a refusal')
      expect(result.reason).toBe('unwritable-value')
    }
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('refuses when no styled template starts at the recorded location', () => {
    const source = `${IMPORT}export const Card = styled.div\`\n  color: red;\n\``
    const { file, className } = fixture(source)

    const result = setStyledDeclaration({
      file, line: 1, col: 1, className, selector: `.${className}`, property: 'color', value: 'blue',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('template-not-found')
    expect(readFileSync(file, 'utf8')).toBe(source)
  })
})
