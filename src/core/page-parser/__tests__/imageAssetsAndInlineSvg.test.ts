/**
 * The two ways a real screen shows a picture, both of which imported as nothing:
 *
 *  1. An IMAGE IMPORT reached through a data structure. `<img src={esimChip}/>`
 *     — a bare identifier — was the only shape that worked, and it is close to
 *     the rarest: the eSIM corpus reaches every one of its images as
 *     `deal.image` off a const array, as `SLIDE_IMAGES[i]`, or as a prop handed
 *     to a child component. Resolution now runs through §7's evaluator, so every
 *     shape the evaluator already understands works here too.
 *
 *  2. An INLINE `<svg>` written as JSX elements. The markup used to be the JSX
 *     source text, copied verbatim and thrown away entirely if it contained a
 *     single `{` — so every progress ring, every hand-rolled icon with a
 *     computed attribute, rendered as an empty box.
 *
 * Fixtures deliberately avoid the eSIM corpus's own idioms (see
 * `genericRepoShapes.test.ts` for why).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  parsePageFile,
  STUDIO_ASSET_SENTINEL,
  type ParsedNode,
  type ParsedPage,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-svg-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function parse(pageRel: string): ParsedPage {
  return parsePageFile(path.join(tmpDir, ...pageRel.split('/')), tmpDir, undefined, {
    pageBudget: createPageEvalBudget(),
    workspaceRoot: tmpDir,
  })
}

const images = (page: ParsedPage): ParsedNode[] =>
  Object.values(page.nodes).filter((n) => n.name === 'img')

const srcs = (page: ParsedPage): unknown[] => images(page).map((n) => n.props.src)

describe('an imported image', () => {
  beforeEach(() => {
    write('media/one.png', '')
    write('media/two.jpg', '')
  })

  it('resolves when read off a const array of objects', () => {
    write(
      'pages/Deals.jsx',
      [
        "import one from '../media/one.png'",
        "import two from '../media/two.jpg'",
        'const DEALS = [{ id: 1, image: one }, { id: 2, image: two }]',
        'export default function Deals() {',
        '  return <div>{DEALS.map((deal) => <img key={deal.id} src={deal.image} />)}</div>',
        '}',
        '',
      ].join('\n'),
    )

    expect(srcs(parse('pages/Deals.jsx'))).toEqual([
      `${STUDIO_ASSET_SENTINEL}media/one.png`,
      `${STUDIO_ASSET_SENTINEL}media/two.jpg`,
    ])
  })

  it('resolves through a constant array index', () => {
    write(
      'pages/Slide.jsx',
      [
        "import one from '../media/one.png'",
        "import two from '../media/two.jpg'",
        'const SLIDES = [one, two]',
        'export default function Slide() {',
        '  return <img src={SLIDES[1]} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(srcs(parse('pages/Slide.jsx'))).toEqual([`${STUDIO_ASSET_SENTINEL}media/two.jpg`])
  })

  it('resolves through a local alias', () => {
    write(
      'pages/Alias.jsx',
      [
        "import one from '../media/one.png'",
        'export default function Alias() {',
        '  const hero = one',
        '  return <img src={hero} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(srcs(parse('pages/Alias.jsx'))).toEqual([`${STUDIO_ASSET_SENTINEL}media/one.png`])
  })

  it('is not resolved when the file does not exist', () => {
    write(
      'pages/Missing.jsx',
      [
        "import gone from '../media/gone.png'",
        'export default function Missing() { return <img src={gone} /> }',
        '',
      ].join('\n'),
    )

    // A path nothing can serve is worse than no path: the canvas would show a
    // broken image instead of an empty one.
    expect(srcs(parse('pages/Missing.jsx'))).toEqual([undefined])
  })

  it('never resolves a specifier that climbs out of the workspace', () => {
    fs.writeFileSync(path.join(path.dirname(tmpDir), 'outside.png'), '', 'utf8')
    write(
      'pages/Escape.jsx',
      [
        "import outside from '../../outside.png'",
        'export default function Escape() { return <img src={outside} /> }',
        '',
      ].join('\n'),
    )

    expect(srcs(parse('pages/Escape.jsx'))).toEqual([undefined])
    fs.rmSync(path.join(path.dirname(tmpDir), 'outside.png'), { force: true })
  })
})

describe('an inline <svg> written as JSX', () => {
  const svgOf = (page: ParsedPage): string | undefined => {
    const node = Object.values(page.nodes).find((n) => n.name === 'svg')
    return typeof node?.props.svg === 'string' ? node.props.svg : undefined
  }

  it('converts React attribute names to real markup attribute names', () => {
    write(
      'pages/Icon.jsx',
      [
        'export default function Icon() {',
        '  return (',
        '    <svg className="icon" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round">',
        '      <path d="M4 12h16" fillRule="evenodd" />',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // `className` is not a class attribute and `strokeWidth` is not an
    // attribute at all — copying the JSX text shipped both verbatim. `viewBox`
    // is one of the SVG attributes that really is camelCase, and stays.
    expect(svgOf(parse('pages/Icon.jsx'))).toBe(
      '<svg class="icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round">'
      + '<path d="M4 12h16" fill-rule="evenodd"/></svg>',
    )
  })

  it('resolves computed geometry, including Math constants', () => {
    write(
      'pages/Ring.jsx',
      [
        'const RADIUS = 10',
        'const CIRCUMFERENCE = 2 * Math.PI * RADIUS',
        'export default function Ring() {',
        '  return <svg viewBox="0 0 24 24"><circle r={RADIUS} strokeDasharray={CIRCUMFERENCE} /></svg>',
        '}',
        '',
      ].join('\n'),
    )

    const markup = svgOf(parse('pages/Ring.jsx'))
    expect(markup).toContain('r="10"')
    expect(markup).toContain(`stroke-dasharray="${2 * Math.PI * 10}"`)
  })

  it('serialises a style object and drops event handlers', () => {
    write(
      'pages/Styled.jsx',
      [
        'export default function Styled() {',
        '  return <svg viewBox="0 0 8 8" style={{ transformOrigin: "center", opacity: 1 }} onClick={() => {}} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(svgOf(parse('pages/Styled.jsx'))).toBe(
      '<svg viewBox="0 0 8 8" style="transform-origin: center; opacity: 1"></svg>',
    )
  })

  it('escapes text content rather than emitting it raw', () => {
    write(
      'pages/Text.jsx',
      [
        'export default function Text() {',
        '  return <svg viewBox="0 0 8 8"><text>a &lt; b &amp; c</text></svg>',
        '}',
        '',
      ].join('\n'),
    )

    const markup = svgOf(parse('pages/Text.jsx'))
    expect(markup).toContain('<text>a &lt; b &amp; c</text>')
  })

  it('does not turn the SVG interior into page-tree nodes', () => {
    write(
      'pages/Deep.jsx',
      [
        'export default function Deep() {',
        '  return <svg viewBox="0 0 8 8"><g><circle r={1} /></g></svg>',
        '}',
        '',
      ].join('\n'),
    )

    const page = parse('pages/Deep.jsx')
    expect(Object.values(page.nodes).map((n) => n.name)).toEqual(['svg'])
  })
})

describe('Tier A operators', () => {
  const textOf = (page: ParsedPage): (string | undefined)[] =>
    Object.values(page.nodes).map((n) => n.text)

  it('does arithmetic, string concatenation, and Math constants', () => {
    write(
      'pages/Sums.jsx',
      [
        'const RATE = 1.5',
        'const NIGHTS = 4',
        'export default function Sums() {',
        '  return (',
        '    <div>',
        '      <p>{RATE * NIGHTS}</p>',
        '      <p>{"SAR " + RATE * NIGHTS}</p>',
        '      <p>{Math.round(Math.PI * 100) / 100}</p>',
        '      <p>{NIGHTS - 1}</p>',
        '      <p>{2 ** 5}</p>',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    expect(textOf(parse('pages/Sums.jsx')).filter(Boolean)).toEqual(['6', 'SAR 6', '3.14', '3', '32'])
  })

  it('returns an OPERAND for value-position ||, &&, and ??', () => {
    write(
      'pages/Fallbacks.jsx',
      [
        "const title = ''",
        'const count = 0',
        'const missing = null',
        'export default function Fallbacks() {',
        '  return (',
        '    <div>',
        "      <p>{title || 'Untitled'}</p>",
        '      <p>{count ?? 7}</p>',
        "      <p>{missing ?? 'fallback'}</p>",
        "      <p>{'set' && 'both truthy'}</p>",
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // `count` is 0 — falsy but not nullish, so `??` keeps it where `||` would not.
    expect(textOf(parse('pages/Fallbacks.jsx')).filter((t) => t !== undefined))
      .toEqual(['Untitled', '0', 'fallback', 'both truthy'])
  })

  it('resolves a negative number literal', () => {
    write(
      'pages/Neg.jsx',
      ['export default function Neg() { return <div style={{ marginTop: -4 }}>x</div> }', ''].join('\n'),
    )

    const div = Object.values(parse('pages/Neg.jsx').nodes).find((n) => n.name === 'div')
    expect(div?.inlineStyles?.marginTop).toBe(-4)
  })

  it('declines a division by zero rather than emitting Infinity', () => {
    write(
      'pages/Div.jsx',
      ['const n = 0', 'export default function Div() { return <p>{10 / n}</p> }', ''].join('\n'),
    )

    expect(Object.values(parse('pages/Div.jsx').nodes)[0]?.text).toBeUndefined()
  })
})
