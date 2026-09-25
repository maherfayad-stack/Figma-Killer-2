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
import { stripSvgPartStamps } from '@core/vector'

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

describe('assetOrigin (WS-8.3) — the import specifier behind a resolved image', () => {
  /** 1-based line/col of `needle`'s first character, mirroring how the parser locates a literal. */
  function locate(source: string, needle: string): { line: number; col: number } {
    const index = source.indexOf(needle)
    if (index < 0) throw new Error(`fixture does not contain ${needle}`)
    const before = source.slice(0, index)
    const line = before.split('\n').length
    const col = index - (before.lastIndexOf('\n') + 1) + 1
    return { line, col }
  }

  beforeEach(() => {
    write('media/one.png', '')
    write('media/two.jpg', '')
  })

  it('points at the import specifier, not the JSX attribute', () => {
    const source = [
      "import heroImg from '../media/one.png'",
      'export default function Hero() {',
      '  return <img src={heroImg} alt="Hero" />',
      '}',
      '',
    ].join('\n')
    write('pages/Hero.jsx', source)

    const image = images(parse('pages/Hero.jsx'))[0]!
    expect(image.props.src).toBe(`${STUDIO_ASSET_SENTINEL}media/one.png`)
    const expected = locate(source, "'../media/one.png'")
    expect(image.assetOrigin).toMatchObject({ rel: 'pages/Hero.jsx', line: expected.line, col: expected.col })
  })

  it('resolves through an alias to the ORIGINAL import statement', () => {
    const source = [
      "import one from '../media/one.png'",
      'export default function Alias() {',
      '  const hero = one',
      '  return <img src={hero} />',
      '}',
      '',
    ].join('\n')
    write('pages/Alias.jsx', source)

    const image = images(parse('pages/Alias.jsx'))[0]!
    const expected = locate(source, "'../media/one.png'")
    expect(image.assetOrigin).toMatchObject({ rel: 'pages/Alias.jsx', line: expected.line, col: expected.col })
  })

  it('is absent for a literal src (nothing to redirect an import at)', () => {
    write(
      'pages/Literal.jsx',
      ['export default function Literal() { return <img src="/img/hero.png" /> }', ''].join('\n'),
    )

    expect(images(parse('pages/Literal.jsx'))[0]?.assetOrigin).toBeUndefined()
  })

  it('is absent when the image import does not resolve (missing file)', () => {
    write(
      'pages/Missing.jsx',
      [
        "import gone from '../media/gone.png'",
        'export default function Missing() { return <img src={gone} /> }',
        '',
      ].join('\n'),
    )

    expect(images(parse('pages/Missing.jsx'))[0]?.assetOrigin).toBeUndefined()
  })

  it('gives two nodes sharing one import the SAME origin (shared-asset case)', () => {
    const source = [
      "import one from '../media/one.png'",
      'export default function Twice() {',
      '  return (',
      '    <div>',
      '      <img src={one} alt="a" />',
      '      <img src={one} alt="b" />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    write('pages/Twice.jsx', source)

    const [first, second] = images(parse('pages/Twice.jsx'))
    expect(first?.assetOrigin).toBeDefined()
    expect(first?.assetOrigin).toEqual(second?.assetOrigin)
  })
})

describe('an inline <svg> written as JSX', () => {
  // These cases are about the graphic; the part stamps have their own block below.
  const svgOf = (page: ParsedPage): string | undefined => {
    const node = Object.values(page.nodes).find((n) => n.name === 'svg')
    return typeof node?.props.svg === 'string' ? stripSvgPartStamps(node.props.svg) : undefined
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

  it('writes React aliases of namespaced and lowercase attributes as the markup names a browser reads', () => {
    // `xlinkHref` is React's spelling of `xlink:href`, not of `xlink-href`;
    // the parse used to dash every capital, so a sprite's `<use>` pointed at
    // nothing on the canvas. The name table is now the one `@core/vector`
    // shares with the SVG importer, so markup → JSX → markup is an identity.
    write(
      'pages/Sprite.jsx',
      [
        'export default function Sprite() {',
        '  return (',
        '    <svg xmlnsXlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8" tabIndex={-1}>',
        '      <use xlinkHref="#dot" /><text xmlSpace="preserve">a</text>',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    expect(svgOf(parse('pages/Sprite.jsx'))).toBe(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8" tabindex="-1">'
      + '<use xlink:href="#dot"/><text xml:space="preserve">a</text></svg>',
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

describe('SVG-3: an inline <svg> stamps each inner element with where it is written', () => {
  const svgNode = (page: ParsedPage): ParsedNode => {
    const node = Object.values(page.nodes).find((n) => n.name === 'svg')
    if (!node) throw new Error('no svg node')
    return node
  }
  const markupOf = (page: ParsedPage): string => String(svgNode(page).props.svg)

  it('stamps every element below the root with its own tag-name line:col, and never the root', () => {
    write(
      'pages/Parts.jsx',
      [
        'export default function Parts() {',
        '  return (',
        '    <svg viewBox="0 0 24 24">',
        '      <g>',
        '        <path d="M4 4h16" />',
        '      </g>',
        '      <circle cx="4" r="2" />',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const page = parse('pages/Parts.jsx')
    // The host keeps its own id; the stamps are in the SAME file, same convention (column of the tag name).
    expect(svgNode(page).loc).toMatchObject({ line: 3, col: 6 })
    expect(markupOf(page)).toBe(
      '<svg viewBox="0 0 24 24">'
      + '<g data-studio-svg-part="4:8"><path data-studio-svg-part="5:10" d="M4 4h16"/></g>'
      + '<circle data-studio-svg-part="7:8" cx="4" r="2"/></svg>',
    )
  })

  it('lists attributes that came from code, so the canvas never offers to overwrite them', () => {
    write(
      'pages/Coded.jsx',
      [
        'const D = "M0 0h8"',
        'export default function Coded({ tone }) {',
        '  return (',
        '    <svg viewBox="0 0 8 8">',
        '      <path d={D} fill={tone} strokeWidth={2} opacity={-1} stroke={"red"} />',
        '      <rect {...rest} width="4" />',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const markup = markupOf(parse('pages/Coded.jsx'))
    // `{2}`, `{-1}` and `{"red"}` are literals a write may replace; `{D}` and `{tone}` are bindings.
    expect(markup).toContain('<path data-studio-svg-part="5:8" data-studio-svg-code="d,fill" d="M0 0h8"')
    // A spread can override anything on the element, so none of it is known to be literal.
    expect(markup).toContain('<rect data-studio-svg-part="6:8" data-studio-svg-code="*" width="4"/>')
  })

  it('keeps a stamp on the element it names when the sanitiser drops a sibling (no index to drift)', () => {
    write(
      'pages/Dropped.jsx',
      [
        'export default function Dropped() {',
        '  return (',
        '    <svg viewBox="0 0 8 8">',
        '      <foreignObject><div /></foreignObject>',
        '      <path d="M1 1h6" />',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const markup = markupOf(parse('pages/Dropped.jsx'))
    // Whatever removes the foreignObject later, the path still says where IT is.
    expect(markup).toContain('<path data-studio-svg-part="5:8" d="M1 1h6"/>')
  })

  it('drops an authored copy of a stamp rather than emitting two', () => {
    write(
      'pages/Forged.jsx',
      [
        'export default function Forged() {',
        '  return <svg viewBox="0 0 8 8"><path data-studio-svg-part="1:1" d="M0 0" /></svg>',
        '}',
        '',
      ].join('\n'),
    )

    const markup = markupOf(parse('pages/Forged.jsx'))
    expect(markup).toBe('<svg viewBox="0 0 8 8"><path data-studio-svg-part="2:34" d="M0 0"/></svg>')
  })

  it('does not count stamp bytes against the 64 KB markup cap', () => {
    // 2,800 tiny paths: ~55 KB of graphic, plus ~90 KB of stamps. Without
    // excluding the stamps this graphic would lock as "SVG built in code".
    const paths = Array.from({ length: 2800 }, (_, i) => `      <path d="M${i % 97} 1h2" />`)
    write(
      'pages/Big.jsx',
      ['export default function Big() {', '  return (', '    <svg viewBox="0 0 99 9">', ...paths, '    </svg>', '  )', '}', ''].join('\n'),
    )

    const node = svgNode(parse('pages/Big.jsx'))
    const markup = String(node.props.svg)
    expect(stripSvgPartStamps(markup).length).toBeLessThan(64 * 1024)
    expect(markup.length).toBeGreaterThan(64 * 1024)
    expect(node.locked).toBe(false)
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
