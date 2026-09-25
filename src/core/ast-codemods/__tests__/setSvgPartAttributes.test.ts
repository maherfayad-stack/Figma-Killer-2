/**
 * `setSvgPartAttributes` — the `svg-attr` codemod (P5-D, SVG-4). Its guards
 * are server-side on purpose: the part location arrives from the client.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setSvgPartAttributes, type SetSvgPartAttributesParams } from '../index'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-part-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ICON = [
  'const D = "M0 0"',
  'export function Icon({ tone, rest }) {',
  '  return (',
  '    <div>',
  '      <svg viewBox="0 0 24 24" fill="none">',
  '        <g>',
  "          <path d='M4 4h16v16H4z' strokeWidth={2} />",
  '          <path d={D} fill={tone} />',
  '        </g>',
  '        <rect {...rest} width="4" />',
  '        {[1].map((i) => <circle key={i} r="1" />)}',
  '      </svg>',
  '      <path d="M9 9" />',
  '    </div>',
  '  )',
  '}',
  '',
]

function fixture(eol: '\n' | '\r\n' = '\n'): { file: string; source: string } {
  const source = ICON.join(eol)
  const file = path.join(tmpDir, `Icon${eol === '\r\n' ? 'Crlf' : ''}.tsx`)
  fs.writeFileSync(file, source, 'utf8')
  return { file, source: ICON.join('\n') }
}

function run(file: string, source: string, overrides: Partial<SetSvgPartAttributesParams>) {
  const host = locateTag(source, 'svg')
  return setSvgPartAttributes({
    file,
    ...host,
    part: locateTag(source, 'path'),
    partTag: 'path',
    set: {},
    ...overrides,
  })
}

describe('setSvgPartAttributes', () => {
  it('rewrites a path d in place, keeping its quote and every other byte', () => {
    const { file, source } = fixture()
    const result = run(file, source, { set: { d: 'M4 4h20v16H4z' } })
    expect(result).toEqual({ ok: true, changed: true })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toBe(source.replace("d='M4 4h16v16H4z'", "d='M4 4h20v16H4z'"))
  })

  it('sets several attributes and removes one as ONE write, keeping a number numeric', () => {
    const { file, source } = fixture()
    const result = run(file, source, { set: { strokeWidth: 3, stroke: 'currentColor' }, remove: ['d'] })
    expect(result).toEqual({ ok: true, changed: true })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<path strokeWidth={3} stroke="currentColor" />')
  })

  it('reports no change when the value is already there', () => {
    const { file, source } = fixture()
    expect(run(file, source, { set: { strokeWidth: 2 } })).toEqual({ ok: true, changed: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('writes the host svg itself with part null', () => {
    const { file, source } = fixture()
    expect(run(file, source, { part: null, partTag: 'svg', set: { fill: 'red' } })).toEqual({ ok: true, changed: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('<svg viewBox="0 0 24 24" fill="red">')
  })

  it('refuses an attribute that holds code, writing nothing', () => {
    const { file, source } = fixture()
    const result = run(file, source, { part: locateTag(source, 'path', 2), set: { strokeWidth: 1, d: 'M1 1' } })
    expect(result).toMatchObject({ ok: false, reason: 'svg-attr-expression' })
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
    expect(run(file, source, { part: locateTag(source, 'path', 2), set: {}, remove: ['fill'] })).toMatchObject({
      ok: false,
      reason: 'svg-attr-expression',
    })
  })

  it('refuses a part with a spread', () => {
    const { file, source } = fixture()
    expect(run(file, source, { part: locateTag(source, 'rect'), partTag: 'rect', set: { width: 5 } })).toMatchObject({
      ok: false,
      reason: 'spread-attribute',
    })
  })

  it('refuses a part outside the host, or behind an expression container', () => {
    const { file, source } = fixture()
    // The <path> after the </svg> is in the file, not in the graphic.
    expect(run(file, source, { part: locateTag(source, 'path', 3), set: { d: 'M0 0' } })).toMatchObject({
      ok: false,
      reason: 'svg-part-outside-host',
    })
    // A map row: every row would change, and the canvas never stamped it.
    expect(run(file, source, { part: locateTag(source, 'circle'), partTag: 'circle', set: { r: 2 } })).toMatchObject({
      ok: false,
      reason: 'svg-part-outside-host',
    })
    // The host's container is not an svg.
    expect(run(file, source, { part: null, partTag: 'div', set: { id: 'x' } } as never)).toMatchObject({ ok: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a part whose tag is not the one the caller read, or no element at all (element-moved)', () => {
    const { file, source } = fixture()
    expect(run(file, source, { partTag: 'circle', set: { d: 'M0 0' } })).toMatchObject({ ok: false, reason: 'element-moved' })
    expect(run(file, source, { part: { line: 7, col: 3 }, set: { d: 'M0 0' } })).toMatchObject({ ok: false, reason: 'element-moved' })
    expect(run(file, source, { part: { line: 999, col: 1 }, set: { d: 'M0 0' } })).toMatchObject({ ok: false, reason: 'element-moved' })
  })

  it('refuses the host when it is not an svg', () => {
    const { file, source } = fixture()
    const div = locateTag(source, 'div')
    expect(setSvgPartAttributes({ file, ...div, part: null, partTag: 'div', set: { id: 'x' } })).toMatchObject({
      ok: false,
      reason: 'svg-host',
    })
  })

  it('refuses handlers, remote references and non-fragment hrefs through the shared rule', () => {
    const { file, source } = fixture()
    for (const [set, reason] of [
      [{ onClick: 'alert(1)' }, 'svg-attr-name'],
      [{ dangerouslySetInnerHTML: 'x' }, 'svg-attr-name'],
      [{ style: 'fill:red' }, 'svg-attr-name'],
      [{ fill: 'url(https://evil.example/p)' }, 'svg-attr-value'],
      [{ href: 'javascript:alert(1)' }, 'svg-attr-value'],
    ] as const) {
      expect(run(file, source, { set })).toMatchObject({ ok: false, reason })
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('keeps a CRLF file CRLF', () => {
    const { file, source } = fixture('\r\n')
    expect(run(file, source, { set: { d: 'M1 1', fill: '#fff' } })).toEqual({ ok: true, changed: true })
    const written = fs.readFileSync(file, 'utf8')
    expect(written.replace(/\r\n/g, '\n')).toContain(`<path d='M1 1' strokeWidth={2} fill="#fff" />`)
    expect(written.split('\r\n').length).toBe(ICON.length)
    expect(written.replace(/\r\n/g, '')).not.toContain('\n')
  })
})
