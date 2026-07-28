/**
 * Vite `?raw` text imports -> inline SVG on the canvas.
 *
 * `import icon from './x.svg?raw'` + `dangerouslySetInnerHTML={{__html: icon}}`
 * is how real repos ship every icon, and none of it used to reach the board:
 * the specifier can't match an extension test through the `?raw` query, and
 * ts-morph has no `SourceFile` for a `.svg`, so the identifier resolved to
 * nothing. Measured on the eSIM corpus: 42 of 62 icons rendered before this.
 *
 * Resolution lives in the §7 evaluator (`resolveRawTextImport`) rather than the
 * parser, so ONE mechanism covers every path the value travels — read directly,
 * aliased through a local const, or passed as a prop and substituted into a
 * component by `inlineLocalComponents`. That last case is the common one and is
 * covered here explicitly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type ParsedNode,
  type StaticEvalOptions,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-svg-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const SVG = '<svg viewBox="0 0 24 24"><path d="M1 1h4" /></svg>'

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

/** Parses + inlines like the real load pipeline, then returns every node. `opts` is explicit — passing `undefined` to a defaulted param would silently re-enable the evaluator. */
function loadNodes(pageRel: string, opts: StaticEvalOptions | undefined): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const parsed = parsePageFile(file, tmpDir, project, opts)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  const expanded = inlineLocalComponents(parsed, sources, project, tmpDir, opts ? { evalOptions: opts } : {})
  return Object.values(expanded.nodes)
}

const svgNodes = (nodes: ParsedNode[]): ParsedNode[] => nodes.filter((n) => typeof n.props.svg === 'string')

describe('?raw SVG imports', () => {
  it('resolves a ?raw import used directly in dangerouslySetInnerHTML', () => {
    write('assets/check.svg', SVG)
    write(
      'pages/Home.jsx',
      [
        "import checkSvg from '../assets/check.svg?raw'",
        'export default function Home() {',
        '  return <span className="icon" dangerouslySetInnerHTML={{ __html: checkSvg }} />',
        '}',
        '',
      ].join('\n'),
    )

    const svgs = svgNodes(loadNodes('pages/Home.jsx', evalOptions()))
    expect(svgs).toHaveLength(1)
    expect(svgs[0]!.props.svg).toBe(SVG)
    // The element keeps its own class — it sizes and colours the icon.
    expect(svgs[0]!.props.className).toBe('icon')
  })

  it('resolves through a component prop — the <Icon svg={...} /> shape', () => {
    write('assets/check.svg', SVG)
    write(
      'components/Icon.jsx',
      [
        'export default function Icon({ svg }) {',
        '  return <span className="ds-raw-icon" dangerouslySetInnerHTML={{ __html: svg }} />',
        '}',
        '',
      ].join('\n'),
    )
    write(
      'pages/Home.jsx',
      [
        "import Icon from '../components/Icon'",
        "import checkSvg from '../assets/check.svg?raw'",
        'export default function Home() {',
        '  return <div><Icon svg={checkSvg} /></div>',
        '}',
        '',
      ].join('\n'),
    )

    const svgs = svgNodes(loadNodes('pages/Home.jsx', evalOptions()))
    expect(svgs).toHaveLength(1)
    expect(svgs[0]!.props.svg).toBe(SVG)
  })

  it('leaves the markup unresolved when the evaluator is not enabled', () => {
    write('assets/check.svg', SVG)
    write(
      'pages/Home.jsx',
      [
        "import checkSvg from '../assets/check.svg?raw'",
        'export default function Home() {',
        '  return <span dangerouslySetInnerHTML={{ __html: checkSvg }} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(svgNodes(loadNodes('pages/Home.jsx', undefined))).toHaveLength(0)
  })

  it('refuses a ?raw file that resolves outside the workspace root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-raw-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.svg'), SVG, 'utf8')
      const escape = path.relative(path.join(tmpDir, 'pages'), path.join(outside, 'secret.svg')).split(path.sep).join('/')
      expect(escape.startsWith('..')).toBe(true)

      write(
        'pages/Home.jsx',
        [
          `import secret from '${escape}?raw'`,
          'export default function Home() {',
          '  return <span dangerouslySetInnerHTML={{ __html: secret }} />',
          '}',
          '',
        ].join('\n'),
      )

      expect(svgNodes(loadNodes('pages/Home.jsx', evalOptions()))).toHaveLength(0)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does not treat non-SVG raw HTML as an inline SVG', () => {
    // base.svg's contract is "an inline SVG"; arbitrary markup is not that.
    write('assets/snippet.html', '<div class="promo">Hello</div>')
    write(
      'pages/Home.jsx',
      [
        "import promo from '../assets/snippet.html?raw'",
        'export default function Home() {',
        '  return <span dangerouslySetInnerHTML={{ __html: promo }} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(svgNodes(loadNodes('pages/Home.jsx', evalOptions()))).toHaveLength(0)
  })

  it('sizes the icon: a `style={{ width: size }}` param reaches the element that renders the markup', () => {
    // Without this the raw SVG has no box and overflows whatever badge the
    // design wrapped it in — the visible symptom on the eSIM confirmation
    // screen, where a 24px check painted across the whole success block.
    write('assets/check.svg', SVG)
    write(
      'components/Icon.jsx',
      [
        'export default function Icon({ svg, size = 24 }) {',
        '  return (',
        '    <span',
        "      className=\"ds-raw-icon\"",
        '      style={{ display: \'inline-flex\', width: size, height: size }}',
        '      dangerouslySetInnerHTML={{ __html: svg }}',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    write(
      'pages/Home.jsx',
      [
        "import Icon from '../components/Icon'",
        "import checkSvg from '../assets/check.svg?raw'",
        'export default function Home() {',
        '  return <div><Icon svg={checkSvg} size={44} /></div>',
        '}',
        '',
      ].join('\n'),
    )

    const svgs = svgNodes(loadNodes('pages/Home.jsx', evalOptions()))
    expect(svgs).toHaveLength(1)
    expect(svgs[0]!.inlineStyles).toMatchObject({ display: 'inline-flex', width: 44, height: 44 })
  })

  it("resolves the conditional-class idiom so the call site's own class reaches the element", () => {
    // `['base', className].filter(Boolean).join(' ')` is how the corpus merges a
    // base class with an optional one. If it doesn't resolve, the element that
    // renders the icon has no class — and no rule sizing it.
    write('assets/check.svg', SVG)
    write(
      'components/Icon.jsx',
      [
        'export default function Icon({ svg, className }) {',
        "  return <span className={['ds-raw-icon', className].filter(Boolean).join(' ')} dangerouslySetInnerHTML={{ __html: svg }} />",
        '}',
        '',
      ].join('\n'),
    )
    write(
      'pages/Home.jsx',
      [
        "import Icon from '../components/Icon'",
        "import checkSvg from '../assets/check.svg?raw'",
        'export default function Home() {',
        '  return <div><Icon svg={checkSvg} className="bc-success__check-icon" /></div>',
        '}',
        '',
      ].join('\n'),
    )

    const svgs = svgNodes(loadNodes('pages/Home.jsx', evalOptions()))
    expect(svgs).toHaveLength(1)
    expect(svgs[0]!.props.className).toBe('ds-raw-icon bc-success__check-icon')
  })

  it('drops the falsy slot when the call site passes no class', () => {
    write('assets/check.svg', SVG)
    write(
      'components/Icon.jsx',
      [
        'export default function Icon({ svg, className }) {',
        "  return <span className={['ds-raw-icon', className].filter(Boolean).join(' ')} dangerouslySetInnerHTML={{ __html: svg }} />",
        '}',
        '',
      ].join('\n'),
    )
    write(
      'pages/Home.jsx',
      [
        "import Icon from '../components/Icon'",
        "import checkSvg from '../assets/check.svg?raw'",
        'export default function Home() {',
        '  return <div><Icon svg={checkSvg} /></div>',
        '}',
        '',
      ].join('\n'),
    )

    // `className` has no value at all here, so the expression stays unresolved
    // and the static-prefix fallback does not apply to a non-template shape —
    // no class is invented.
    const svgs = svgNodes(loadNodes('pages/Home.jsx', evalOptions()))
    expect(svgs).toHaveLength(1)
    expect(svgs[0]!.props.className).toBeUndefined()
  })

  it('falls back to the parameter default when the call site passes no value', () => {
    write('assets/check.svg', SVG)
    write(
      'components/Icon.jsx',
      [
        'export default function Icon({ svg, size = 24 }) {',
        '  return <span style={{ width: size }} dangerouslySetInnerHTML={{ __html: svg }} />',
        '}',
        '',
      ].join('\n'),
    )
    write(
      'pages/Home.jsx',
      [
        "import Icon from '../components/Icon'",
        "import checkSvg from '../assets/check.svg?raw'",
        'export default function Home() {',
        '  return <div><Icon svg={checkSvg} /></div>',
        '}',
        '',
      ].join('\n'),
    )

    const svgs = svgNodes(loadNodes('pages/Home.jsx', evalOptions()))
    expect(svgs).toHaveLength(1)
    expect(svgs[0]!.inlineStyles).toMatchObject({ width: 24 })
  })

  it('leaves the node alone when the __html expression cannot be resolved', () => {
    write(
      'pages/Home.jsx',
      [
        'export default function Home({ markup }) {',
        '  return <span dangerouslySetInnerHTML={{ __html: markup }} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(svgNodes(loadNodes('pages/Home.jsx', evalOptions()))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Installed-package specifiers
// ---------------------------------------------------------------------------

describe('?raw SVG imports from an installed package', () => {
  it('resolves a bare specifier through node_modules', () => {
    write('node_modules/@alm-design/design-system/src/icons/line-icons/headset.svg', SVG)
    write(
      'pages/Help.jsx',
      [
        "import headsetSvg from '@alm-design/design-system/src/icons/line-icons/headset.svg?raw'",
        'export default function Help() {',
        '  return <span dangerouslySetInnerHTML={{ __html: headsetSvg }} />',
        '}',
        '',
      ].join('\n'),
    )

    // A design system ships its icons inside its package; ~23 of the eSIM
    // corpus's icons are imported exactly like this.
    const span = loadNodes('pages/Help.jsx', evalOptions()).find((n) => n.name === 'span')
    expect(span?.props.svg).toBe(SVG)
  })

  it('walks up to a node_modules above the importing file, but not above the workspace root', () => {
    write('node_modules/pkg/icon.svg', SVG)
    write(
      'pages/deep/nested/Screen.jsx',
      [
        "import icon from 'pkg/icon.svg?raw'",
        'export default function Screen() {',
        '  return <span dangerouslySetInnerHTML={{ __html: icon }} />',
        '}',
        '',
      ].join('\n'),
    )

    const span = loadNodes('pages/deep/nested/Screen.jsx', evalOptions()).find((n) => n.name === 'span')
    expect(span?.props.svg).toBe(SVG)
  })

  it('refuses a symlink whose real target is outside the workspace', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-svg-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.svg'), SVG, 'utf8')
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true })
      fs.symlinkSync(path.join(outside, 'secret.svg'), path.join(tmpDir, 'node_modules', 'pkg', 'icon.svg'))
      write(
        'pages/Leak.jsx',
        [
          "import icon from 'pkg/icon.svg?raw'",
          'export default function Leak() {',
          '  return <span dangerouslySetInnerHTML={{ __html: icon }} />',
          '}',
          '',
        ].join('\n'),
      )

      // A workspace can arrive from /import-github, and git stores symlinks — so
      // a textual containment check would read any file the server user can.
      const span = loadNodes('pages/Leak.jsx', evalOptions()).find((n) => n.name === 'span')
      expect(span?.props.svg).toBeUndefined()
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never reads an absolute specifier', () => {
    write(
      'pages/Abs.jsx',
      [
        "import icon from '/etc/hosts.svg?raw'",
        'export default function Abs() {',
        '  return <span dangerouslySetInnerHTML={{ __html: icon }} />',
        '}',
        '',
      ].join('\n'),
    )

    const span = loadNodes('pages/Abs.jsx', evalOptions()).find((n) => n.name === 'span')
    expect(span?.props.svg).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Markup reached through a transform the evaluator cannot run
// ---------------------------------------------------------------------------

describe('?raw SVG through an unevaluatable transform', () => {
  it('falls back to the transform\'s input rather than rendering nothing', () => {
    write('assets/wallet.svg', SVG)
    write(
      'components/IllustrationIcon.jsx',
      [
        "const SUBSTITUTIONS = [['fill=\"#fff\"', 'fill=\"var(--bg)\"']]",
        'function applyTokens(raw) {',
        '  let out = raw',
        '  for (const [from, to] of SUBSTITUTIONS) out = out.replaceAll(from, to)',
        '  return out',
        '}',
        'export default function IllustrationIcon({ svg, size = 48 }) {',
        '  return <span style={{ width: size }} dangerouslySetInnerHTML={{ __html: applyTokens(svg) }} />',
        '}',
        '',
      ].join('\n'),
    )
    write(
      'pages/Home.jsx',
      [
        "import IllustrationIcon from '../components/IllustrationIcon'",
        "import walletSvg from '../assets/wallet.svg?raw'",
        'export default function Home() {',
        '  return <IllustrationIcon svg={walletSvg} size={24} />',
        '}',
        '',
      ].join('\n'),
    )

    // `applyTokens` loops over a substitution table, which the evaluator does
    // not execute — so the call is unresolved and the markup would otherwise be
    // dropped, leaving a blank 24px box. 9 homepage illustrations on the eSIM
    // corpus were exactly this.
    const span = loadNodes('pages/Home.jsx', evalOptions()).find((n) => n.name === 'span')
    expect(span?.props.svg).toBe(SVG)
    // Untransformed, and that is the honest cost: the source's own fills, not the
    // token-substituted ones the transform would have produced.
    expect(span?.props.svg).not.toContain('var(--bg)')
  })

  it('still resolves nothing when the transform\'s input is not SVG markup', () => {
    write(
      'pages/Text.jsx',
      [
        'const LABEL = "not markup"',
        'export default function Text() {',
        '  return <span dangerouslySetInnerHTML={{ __html: shout(LABEL) }} />',
        '}',
        '',
      ].join('\n'),
    )

    // The fallback recovers a transform's SVG input; it is not a licence to pour
    // arbitrary strings into `base.svg`.
    const span = loadNodes('pages/Text.jsx', evalOptions()).find((n) => n.name === 'span')
    expect(span?.props.svg).toBeUndefined()
  })
})
