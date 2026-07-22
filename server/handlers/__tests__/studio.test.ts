/**
 * studio.ts — unit tests for the pure pageId-derivation helper and the typed
 * studio-edit dispatch helper.
 *
 * `pageIdFromFileName` turns a page file's basename into the stable,
 * unique `pageId`/`slug` the multi-page `/admin/api/studio/load` scan uses
 * (Phase 1, Increment 1B — multi-frame board).
 *
 * `applyStudioEdit` is the pure dir+edit→codemod dispatch the POST
 * /admin/api/studio/save handler runs per edit (Phase 3, Slice B) — tested
 * directly against temp fixture files rather than through a full
 * Request/Response cycle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEdit, pageIdFromFileName } from '../studio'

describe('pageIdFromFileName', () => {
  it('lowercases a simple basename', () => {
    expect(pageIdFromFileName('Home.tsx')).toBe('home')
  })

  it('lowercases another simple basename', () => {
    expect(pageIdFromFileName('About.tsx')).toBe('about')
  })

  it('kebab-cases a multi-word PascalCase basename', () => {
    expect(pageIdFromFileName('MyPage.tsx')).toBe('my-page')
  })

  it('collapses non-alphanumeric separators to a single dash', () => {
    expect(pageIdFromFileName('Contact Us.tsx')).toBe('contact-us')
  })

  it('strips leading/trailing dashes produced by punctuation at the edges', () => {
    expect(pageIdFromFileName('_Home_.tsx')).toBe('home')
  })

  it('falls back to "page" for a basename with no alphanumeric characters', () => {
    expect(pageIdFromFileName('___.tsx')).toBe('page')
  })
})

describe('applyStudioEdit', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-handler-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeFixture(name: string, source: string): string {
    const filePath = path.join(tmpDir, name)
    fs.writeFileSync(filePath, source, 'utf8')
    return filePath
  }

  /** Locates the 1-based (line, col) of the char right after `<Tag` in `source`. */
  function locateTag(source: string, tag: string): { line: number; col: number } {
    const re = new RegExp(`<${tag}(?=[\\s/>])`)
    const match = re.exec(source)
    if (!match) throw new Error(`locateTag: "<${tag}" not found in fixture source`)
    const nameStart = match.index + 1 // char right after '<'
    const before = source.slice(0, nameStart)
    const lines = before.split('\n')
    return { line: lines.length, col: lines[lines.length - 1]!.length + 1 }
  }

  it('dispatches a kind: "prop" edit to setJsxProp', () => {
    const source = ['export default function App() {', '  return <Button label="Old" />', '}', ''].join('\n')
    const file = writeFixture('prop.tsx', source)
    const { line, col } = locateTag(source, 'Button')

    const result = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: `prop.tsx:${line}:${col}`, prop: 'label', value: 'New' })

    expect(result).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('label="New"')
  })

  it('dispatches a kind: "text" edit to setJsxText', () => {
    const source = ['export default function App() {', '  return <p>Hello</p>', '}', ''].join('\n')
    const file = writeFixture('text.tsx', source)
    const { line, col } = locateTag(source, 'p')

    const result = applyStudioEdit(tmpDir, { kind: 'text', nodeId: `text.tsx:${line}:${col}`, text: 'Bye' })

    expect(result).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('<p>{"Bye"}</p>')
  })

  it('dispatches a kind: "style" edit to setJsxStyle, merging into an existing style object', () => {
    const source = [
      'export default function App() {',
      '  return <div style={{ color: "red" }} />',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('style.tsx', source)
    const { line, col } = locateTag(source, 'div')

    const result = applyStudioEdit(tmpDir, {
      kind: 'style',
      nodeId: `style.tsx:${line}:${col}`,
      style: { color: 'blue', boxShadow: '0 0 1px' },
    })

    expect(result).toBe(true)
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('color: "blue"')
    expect(written).toContain('boxShadow: "0 0 1px"')
  })

  it('returns false (no throw) for a synthetic node id with no source location', () => {
    const result = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: 'home:body', prop: 'x', value: 'y' })
    expect(result).toBe(false)
  })

  it('propagates JsxTextTargetError for a mixed-content text target, leaving the file untouched', () => {
    const source = ['export default function App() {', '  return <div><span/>x</div>', '}', ''].join('\n')
    const file = writeFixture('mixed.tsx', source)
    const { line, col } = locateTag(source, 'div')

    expect(() =>
      applyStudioEdit(tmpDir, { kind: 'text', nodeId: `mixed.tsx:${line}:${col}`, text: 'Bye' }),
    ).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})
