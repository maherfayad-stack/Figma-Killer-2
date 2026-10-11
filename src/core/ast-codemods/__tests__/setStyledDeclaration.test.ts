/**
 * setStyledDeclaration — W4-4 Phase B's write half, and G-5's ladder.
 *
 * A styled template is the one write target in Studio where "the value the
 * canvas shows" and "the value the file contains" routinely differ — an
 * interpolation resolves to `8px` on the board and is written as
 * `${SPACING.md}` on disk. It used to decline every such declaration by name;
 * now the interpolation is left exactly as written and the new value follows it
 * as an override. The cases that matter are therefore the exact bytes each rung
 * leaves behind, plus the few refusals that remain.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setStyledDeclaration } from '../setStyledDeclaration'
import { isStyledWritableValue } from '@core/css-codemods'
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
  // The component under test is always `Card`; a spliced mixin is declared first.
  const template = extracted.extraction.templates.find((t) => t.componentName === 'Card') ?? extracted.extraction.templates[0]
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

    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
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

    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
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
      atRule: 'media (min-width: 700px)',
    })

    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
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
      .toEqual({ ok: true, changed: false, landing: 'rule' })
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  test('a declaration written after an interpolated sibling still resolves its own offsets', () => {
    const { file, className, line, col } = fixture(
      `${IMPORT}export const Card = styled.div\`\n  color: \${(p) => p.tone};\n  padding: 8px;\n\``,
    )

    const result = setStyledDeclaration({
      file, line, col, className, selector: `.${className}`, property: 'padding', value: '16px',
    })

    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('padding: 16px;')
    expect(written).toContain('color: ${(p) => p.tone};')
  })
})

/** Runs a write against `source` and returns the result with the bytes it left. */
function write(
  source: string,
  edit: { property: string; value: string; selector?: (className: string) => string; atRule?: string },
): { result: ReturnType<typeof setStyledDeclaration>; text: string } {
  const { file, className, line, col } = fixture(source)
  const result = setStyledDeclaration({
    file,
    line,
    col,
    className,
    selector: edit.selector ? edit.selector(className) : `.${className}`,
    property: edit.property,
    value: edit.value,
    ...(edit.atRule ? { atRule: edit.atRule } : {}),
  })
  return { result, text: readFileSync(file, 'utf8') }
}

/**
 * G-5 — every shape setStyledDeclaration used to REFUSE is a rung now: the
 * winning declaration, else a new declaration at the end of the same block
 * (which wins among equals), else — the caller's rung — the element. One test
 * per former refusal reason, each pinning the exact bytes and the landing.
 */
describe('setStyledDeclaration — the ladder (G-5)', () => {
  test('interpolated-value: the interpolation is left alone and an override follows it', () => {
    const { result, text } = write(
      `${IMPORT}const SPACING = { md: '8px' }\nexport const Card = styled.div\`\n  padding: \${SPACING.md};\n\``,
      { property: 'padding', value: '16px' },
    )
    expect(result).toEqual({ ok: true, changed: true, landing: 'override' })
    expect(text).toBe(
      `${IMPORT}const SPACING = { md: '8px' }\nexport const Card = styled.div\`\n  padding: \${SPACING.md};\n  padding: 16px;\n\``,
    )
  })

  test('interpolated-value: a value only PARTLY written here gets an override too, never half a rewrite', () => {
    const { result, text } = write(
      `${IMPORT}const gap = '8px'\nexport const Card = styled.div\`\n  margin: \${gap} auto;\n\``,
      { property: 'margin', value: '0 auto' },
    )
    expect(result).toEqual({ ok: true, changed: true, landing: 'override' })
    expect(text).toBe(
      `${IMPORT}const gap = '8px'\nexport const Card = styled.div\`\n  margin: \${gap} auto;\n  margin: 0 auto;\n\``,
    )
  })

  test('declaration-not-in-template: a property that arrives through a spliced mixin is added to the template', () => {
    const source =
      "import styled, { css } from 'styled-components'\n" +
      'const centered = css`\n  display: flex;\n`\n' +
      'export const Card = styled.div`\n  ${centered}\n  color: red;\n`'
    const { result, text } = write(source, { property: 'display', value: 'grid' })
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(
      "import styled, { css } from 'styled-components'\n" +
        'const centered = css`\n  display: flex;\n`\n' +
        'export const Card = styled.div`\n  ${centered}\n  color: red;\n  display: grid;\n`',
    )
  })

  test('declaration-not-in-template: a property the template never declares is appended in the block, not refused', () => {
    const { result, text } = write(`${IMPORT}export const Card = styled.div\`\n  color: red;\n\``, {
      property: 'font-size',
      value: '12px',
    })
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(`${IMPORT}export const Card = styled.div\`\n  color: red;\n  font-size: 12px;\n\``)
  })

  test('declaration-not-in-template: appended inside a nested block, under that block\'s own indent', () => {
    const { result, text } = write(
      `${IMPORT}export const Card = styled.div\`\n  color: red;\n  &:hover {\n    color: blue;\n  }\n\``,
      { property: 'opacity', value: '0.5', selector: (c) => `.${c}:hover` },
    )
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(
      `${IMPORT}export const Card = styled.div\`\n  color: red;\n  &:hover {\n    color: blue;\n    opacity: 0.5;\n  }\n\``,
    )
  })

  test('declaration-not-in-template: a block that ends without a semicolon gets one before the new line', () => {
    const { result, text } = write(`${IMPORT}export const Card = styled.div\`\n  color: red\n\``, {
      property: 'margin',
      value: '0',
    })
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(`${IMPORT}export const Card = styled.div\`\n  color: red;\n  margin: 0;\n\``)
  })

  test('declaration-not-in-template: a one-line template stays one line', () => {
    const { result, text } = write(`${IMPORT}export const Card = styled.div\`color: red;\``, { property: 'margin', value: '0' })
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(`${IMPORT}export const Card = styled.div\`color: red; margin: 0;\``)
  })

  test('declaration-not-in-template: the block is a nested @media — the line goes inside it', () => {
    const { result, text } = write(
      `${IMPORT}export const Card = styled.div\`\n  width: 100%;\n  @media (min-width: 700px) {\n    width: 50%;\n  }\n\``,
      { property: 'height', value: '4px', atRule: 'media (min-width: 700px)' },
    )
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toContain('    width: 50%;\n    height: 4px;\n  }')
  })

  test('shorthand-override: the longhand is written after the shorthand, where it wins', () => {
    const { result, text } = write(`${IMPORT}export const Card = styled.div\`\n  padding-top: 4px;\n  padding: 8px;\n\``, {
      property: 'padding-top',
      value: '12px',
    })
    expect(result).toEqual({ ok: true, changed: true, landing: 'override' })
    expect(text).toBe(`${IMPORT}export const Card = styled.div\`\n  padding-top: 4px;\n  padding: 8px;\n  padding-top: 12px;\n\``)
  })

  test('important-override: a covering !important shorthand is rewritten in place with that one side changed', () => {
    const { result, text } = write(`${IMPORT}export const Card = styled.div\`\n  padding: 8px !important;\n\``, {
      property: 'padding-top',
      value: '12px',
    })
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(`${IMPORT}export const Card = styled.div\`\n  padding: 12px 8px 8px !important;\n\``)
  })

  test('important-override: a shorthand it cannot expand is beaten by an !important longhand', () => {
    const { result, text } = write(`${IMPORT}export const Card = styled.div\`\n  background: red !important;\n\``, {
      property: 'background-color',
      value: 'blue',
    })
    expect(result).toEqual({ ok: true, changed: true, landing: 'override' })
    expect(text).toBe(
      `${IMPORT}export const Card = styled.div\`\n  background: red !important;\n  background-color: blue !important;\n\``,
    )
  })

  test('important-override: an interpolated !important shorthand cannot be rewritten, so the longhand is appended', () => {
    const { result, text } = write(
      `${IMPORT}const pad = '8px'\nexport const Card = styled.div\`\n  padding: \${pad} !important;\n\``,
      { property: 'padding-top', value: '12px' },
    )
    expect(result).toEqual({ ok: true, changed: true, landing: 'override' })
    expect(text).toContain('  padding: ${pad} !important;\n  padding-top: 12px !important;\n')
  })

  test('duplicate-declaration: the LAST one — the one taking effect — is the one rewritten', () => {
    const { result, text } = write(`${IMPORT}export const Card = styled.div\`\n  color: red;\n  color: blue;\n\``, {
      property: 'color',
      value: 'green',
    })
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(`${IMPORT}export const Card = styled.div\`\n  color: red;\n  color: green;\n\``)
  })

  test('duplicate-selector: a second `&:hover` block — the later one wins, so it is the one written', () => {
    const { result, text } = write(
      `${IMPORT}export const Card = styled.div\`\n  &:hover { color: red; }\n  &:hover { color: blue; }\n\``,
      { property: 'color', value: 'green', selector: (c) => `.${c}:hover` },
    )
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(`${IMPORT}export const Card = styled.div\`\n  &:hover { color: red; }\n  &:hover { color: green; }\n\``)
  })

  test('an !important longhand is the winner over a later plain declaration of the same property', () => {
    const { result, text } = write(`${IMPORT}export const Card = styled.div\`\n  color: red !important;\n  color: blue;\n\``, {
      property: 'color',
      value: 'green',
    })
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe(`${IMPORT}export const Card = styled.div\`\n  color: green !important;\n  color: blue;\n\``)
  })

  test('a CRLF template gets a CRLF line, not a bare LF', () => {
    const crlf = "import styled from 'styled-components'\r\nexport const Card = styled.div`\r\n  color: red;\r\n`"
    const { result, text } = write(crlf, { property: 'margin', value: '0' })
    expect(result).toEqual({ ok: true, changed: true, landing: 'rule' })
    expect(text).toBe("import styled from 'styled-components'\r\nexport const Card = styled.div`\r\n  color: red;\r\n  margin: 0;\r\n`")
  })

  test('the appended line is idempotent: asking for the same override again changes nothing more', () => {
    const { file, className, line, col } = fixture(`${IMPORT}export const Card = styled.div\`\n  padding: 8px;\n\``)
    const params = { file, line, col, className, selector: `.${className}`, property: 'padding-top', value: '12px' }
    expect(setStyledDeclaration(params)).toMatchObject({ ok: true, landing: 'override' })
    const once = readFileSync(file, 'utf8')
    // The override now IS the winner, so a second identical write finds it and rewrites nothing.
    expect(setStyledDeclaration(params)).toEqual({ ok: true, changed: false, landing: 'rule' })
    expect(readFileSync(file, 'utf8')).toBe(once)
  })
})

describe('setStyledDeclaration — what still refuses, by name', () => {
  test('unwritable-value: a value that would end the declaration or the template', () => {
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

  test('isStyledWritableValue is the same test, asked up front', () => {
    expect(isStyledWritableValue('rebeccapurple')).toBe(true)
    expect(isStyledWritableValue('calc(100% - 8px)')).toBe(true)
    expect(isStyledWritableValue('url("a.png")')).toBe(true)
    for (const value of ['red; margin: 0', 'red`', '${danger}', 'red }', '"\\201C"', 'a\nb']) {
      expect(isStyledWritableValue(value)).toBe(false)
    }
  })

  test('declaration-not-in-template: a selector the template does not write at all', () => {
    const source = `${IMPORT}export const Card = styled.div\`\n  color: red;\n\``
    const { result, text } = write(source, { property: 'color', value: 'blue', selector: (c) => `.${c}:focus` })
    expect(result).toMatchObject({ ok: false, reason: 'declaration-not-in-template' })
    expect(text).toBe(source)
  })

  test('template-not-found: no styled template starts at the recorded location', () => {
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
