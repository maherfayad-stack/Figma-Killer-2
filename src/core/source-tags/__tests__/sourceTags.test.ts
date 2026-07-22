import { describe, it, expect } from 'bun:test'
import path from 'node:path'
import { transformSync } from '@babel/core'
import babelPluginSourceTags from '../babelPluginSourceTags'
import { parseSourceTag } from '../parseSourceTag'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ROOT = path.resolve('/project/src')
const FILENAME = path.join(ROOT, 'Fixture.tsx')

// Line/col reference (1-based line, 1-based col pointing at the char after `<`):
//   line 1: "const Fixture = () => ("
//   line 2: "  <div className=\"outer\">"        -> 'd' of div at col 4
//   line 3: "    <span>Hello</span>"              -> 's' of span at col 6
//   line 4: "  </div>"
//   line 5: ")"
const FIXTURE = [
  'const Fixture = () => (',
  '  <div className="outer">',
  '    <span>Hello</span>',
  '  </div>',
  ')',
  '',
].join('\n')

function transform(code: string, root: string = ROOT) {
  const result = transformSync(code, {
    filename: FILENAME,
    presets: ['@babel/preset-typescript'],
    plugins: [[babelPluginSourceTags, { root }]],
    configFile: false,
    babelrc: false,
  })
  if (!result || !result.code) {
    throw new Error('transformSync produced no output')
  }
  return result.code
}

// ─── Plugin: injects attributes ────────────────────────────────────────────

describe('babelPluginSourceTags', () => {
  it('injects data-src-file and data-src-loc on nested JSX elements at the correct position', () => {
    const output = transform(FIXTURE)

    // div (outer) — line 2, col 4
    expect(output).toContain('data-src-file="Fixture.tsx"')
    expect(output).toMatch(/<div className="outer" data-src-file="Fixture\.tsx" data-src-loc="2:4">/)

    // span (inner) — line 3, col 6
    expect(output).toMatch(/<span data-src-file="Fixture\.tsx" data-src-loc="3:6">/)
  })

  it('relativizes the file path against the root option using POSIX separators', () => {
    const nestedRoot = path.join(ROOT, 'nested', 'deeper')
    const nestedFilename = path.join(nestedRoot, '..', '..', 'Fixture.tsx')
    const output = transformSync(FIXTURE, {
      filename: path.resolve(nestedFilename),
      presets: ['@babel/preset-typescript'],
      plugins: [[babelPluginSourceTags, { root: ROOT }]],
      configFile: false,
      babelrc: false,
    })?.code

    expect(output).toContain('data-src-file="Fixture.tsx"')
    expect(output).not.toContain('\\\\')
  })

  it('defaults root to process.cwd() when no root option is given', () => {
    const filename = path.join(process.cwd(), 'Somewhere.tsx')
    const output = transformSync(FIXTURE.replace('Fixture', 'Somewhere'), {
      filename,
      presets: ['@babel/preset-typescript'],
      plugins: [[babelPluginSourceTags, {}]],
      configFile: false,
      babelrc: false,
    })?.code

    expect(output).toContain('data-src-file="Somewhere.tsx"')
  })

  it('leaves an already-tagged element unchanged (idempotent across repeated transforms)', () => {
    const firstPass = transform(FIXTURE)
    const secondPass = transform(firstPass)

    expect(secondPass).toBe(firstPass)

    // Exactly one data-src-file per original element (2 elements: div, span).
    const fileAttrCount = (secondPass.match(/data-src-file=/g) ?? []).length
    const locAttrCount = (secondPass.match(/data-src-loc=/g) ?? []).length
    expect(fileAttrCount).toBe(2)
    expect(locAttrCount).toBe(2)
  })

  it('skips JSXFragment nodes but still tags real elements nested inside them', () => {
    const fixtureWithFragment = [
      'const Fixture = () => (',
      '  <>',
      '    <p>Hi</p>',
      '  </>',
      ')',
      '',
    ].join('\n')

    const output = transform(fixtureWithFragment)

    // Fragment shorthand syntax is preserved (no attributes possible on <>/</>).
    expect(output).toMatch(/<>[\s\S]*<\/>/)
    // The real element inside still gets tagged.
    expect(output).toMatch(/<p data-src-file="Fixture\.tsx" data-src-loc="3:6">Hi<\/p>/)
  })

  it('does not tag anything when state.filename is missing', () => {
    const result = transformSync(FIXTURE, {
      // no filename
      presets: ['@babel/preset-typescript'],
      plugins: [[babelPluginSourceTags, { root: ROOT }]],
      configFile: false,
      babelrc: false,
      sourceType: 'module',
    })
    expect(result?.code).not.toContain('data-src-file')
  })
})

// ─── parseSourceTag: round-trips the injected attributes ───────────────────

describe('parseSourceTag', () => {
  function fakeElement(attrs: Record<string, string | null>) {
    return {
      getAttribute(name: string) {
        return attrs[name] ?? null
      },
    }
  }

  it('recovers { file, line, col } from a tagged element', () => {
    const el = fakeElement({
      'data-src-file': 'Fixture.tsx',
      'data-src-loc': '3:6',
    })

    expect(parseSourceTag(el)).toEqual({ file: 'Fixture.tsx', line: 3, col: 6 })
  })

  it('round-trips values actually produced by the plugin', () => {
    const output = transform(FIXTURE)
    const locMatch = /data-src-loc="(\d+:\d+)"/.exec(output)
    const fileMatch = /data-src-file="([^"]+)"/.exec(output)
    expect(locMatch).not.toBeNull()
    expect(fileMatch).not.toBeNull()

    const el = fakeElement({
      'data-src-file': fileMatch![1],
      'data-src-loc': locMatch![1],
    })
    const parsed = parseSourceTag(el)
    expect(parsed).not.toBeNull()
    expect(parsed!.file).toBe('Fixture.tsx')
    expect(parsed!.line).toBe(2)
    expect(parsed!.col).toBe(4)
  })

  it('returns null when data-src-file is missing', () => {
    const el = fakeElement({ 'data-src-loc': '3:6' })
    expect(parseSourceTag(el)).toBeNull()
  })

  it('returns null when data-src-loc is missing', () => {
    const el = fakeElement({ 'data-src-file': 'Fixture.tsx' })
    expect(parseSourceTag(el)).toBeNull()
  })

  it('returns null when data-src-loc is malformed', () => {
    const el = fakeElement({ 'data-src-file': 'Fixture.tsx', 'data-src-loc': 'nope' })
    expect(parseSourceTag(el)).toBeNull()
  })
})
