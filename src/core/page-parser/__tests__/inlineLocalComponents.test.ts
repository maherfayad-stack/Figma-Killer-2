/**
 * inlineLocalComponents — unit tests, staged per §2.7 of
 * STUDIO-ESIM-IMPORT-PLAN.md (2a literal props → 2b recursion/caps/cycles →
 * 2c `{children}` → 2d locking fidelity), plus the §2.8 cross-cutting list
 * (unique composite ids, cycle termination, cap degrade, syntax-error target,
 * package components untouched).
 *
 * Uses real temp fixture trees (same convention as `componentSources.test.ts`)
 * because module resolution depends on real filesystem paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parsePageFile } from '../parsePageFile'
import { createWorkspaceProject, resolveComponentSources } from '../componentSources'
import { inlineLocalComponents, INLINE_ID_SEPARATOR } from '../inlineLocalComponents'
import type { ParsedNode, ParsedPage } from '../types'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-local-components-'))
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

function byName(nodes: Record<string, ParsedNode>, name: string): ParsedNode {
  const node = Object.values(nodes).find((n) => n.name === name)
  if (!node) throw new Error(`no parsed node named "${name}" (have: ${Object.values(nodes).map((n) => n.name).join(', ')})`)
  return node
}

/** Full pipeline: parse the page, classify sources, inline. */
function load(pageFile: string): { parsed: ParsedPage; expanded: ParsedPage } {
  const project = createWorkspaceProject(tmpDir)
  const parsed = parsePageFile(pageFile, tmpDir, project)
  const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)
  const expanded = inlineLocalComponents(parsed, sources, project, tmpDir)
  return { parsed, expanded }
}

describe('inlineLocalComponents — 2a: literal props, no recursion', () => {
  it('inlines Icon (span + dangerouslySetInnerHTML-shaped raw content, tagged with its component)', () => {
    write(
      'components/Icon.jsx',
      [
        "export default function Icon({ size = 24, className }) {",
        '  return <span className={className}>{size}</span>',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import Icon from '../components/Icon'",
        'export default function Home() {',
        '  return <div><Icon size={16} className="ico" /></div>',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)

    // The call site keeps its OWN literal props (size, className) and becomes an editable container.
    const callSite = Object.values(expanded.nodes).find((n) => n.props.size === 16)
    expect(callSite).toBeDefined()
    expect(callSite!.kind).toBe('element')
    expect(callSite!.locked).toBeFalsy()
    expect(callSite!.children.length).toBe(1)

    // Its child is the inlined <span>, locked, with the literal size (16) substituted for `{size}`.
    const span = expanded.nodes[callSite!.children[0]!]!
    expect(span.name).toBe('span')
    expect(span.locked).toBeFalsy()
    expect(span.fromComponent).toBe('Icon')
    expect(span.text).toBe('16')
    expect(span.props.className).toBe('ico')
  })

  it('inlines SectionTitle: {title} text substitution and a conditional actionLabel button', () => {
    write(
      'components/SectionTitle.jsx',
      [
        "export default function SectionTitle({ title, actionLabel, onAction }) {",
        '  return (',
        '    <div className="section-title">',
        '      <p className="section-title__text">{title}</p>',
        '      {actionLabel && <button type="button" onClick={onAction}>{actionLabel}</button>}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import SectionTitle from '../components/SectionTitle'",
        'export default function Home() {',
        '  return <SectionTitle title="My Plans" actionLabel="See all" />',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)

    const p = byName(expanded.nodes, 'p')
    expect(p.text).toBe('My Plans')
    expect(p.locked).toBeFalsy()
    expect(p.fromComponent).toBe('SectionTitle')

    // The button is rendered from a `&&` logical expression inside SectionTitle's
    // own file — already locked for THAT (dynamic) reason by `parseJsxTree`,
    // and then re-tagged as inlined on top, same as every other node in this subtree.
    const button = byName(expanded.nodes, 'button')
    expect(button.locked).toBe(true)
  })

  it('inlines Price: literal value substituted into a template-literal className\'s static prefix', () => {
    write(
      'components/Price.jsx',
      [
        "export default function Price({ value, strikethrough = false }) {",
        '  return (',
        '    <span className="price">',
        '      <span className={`price__value${strikethrough ? \' price__value--strike\' : \'\'}`}>{value}</span>',
        '    </span>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import Price from '../components/Price'",
        'export default function Home() {',
        '  return <Price value="12 SAR" />',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)

    const inner = Object.values(expanded.nodes).find((n) => n.text === '12 SAR')
    expect(inner).toBeDefined()
    expect(inner!.props.className).toBe('price__value')
    expect(inner!.locked).toBeFalsy()
  })

  it('inlines ProgressSignal: a non-destructured-literal label stays unresolved (no crash, no guess)', () => {
    write(
      'components/ProgressSignal.jsx',
      [
        "export default function ProgressSignal({ step, label }) {",
        '  return (',
        '    <div className="esim-progress">',
        '      <span>{step}</span>',
        '      {label && <span className="esim-progress__label">{label}</span>}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import ProgressSignal from '../components/ProgressSignal'",
        'export default function Home() {',
        '  return <ProgressSignal step={2} label="Step 2 of 4" />',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)
    const stepSpan = Object.values(expanded.nodes).find((n) => n.text === '2')
    expect(stepSpan).toBeDefined()
    const labelSpan = Object.values(expanded.nodes).find((n) => n.text === 'Step 2 of 4')
    expect(labelSpan).toBeDefined()
  })

  it('inlines DataRing: svg raw-capture and structural children stay present, not dropped', () => {
    write(
      'components/DataRing.jsx',
      [
        "export default function DataRing({ percent }) {",
        '  return (',
        '    <div className="data-ring">',
        '      <svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" /></svg>',
        '      <span>{percent}</span>',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import DataRing from '../components/DataRing'",
        'export default function Home() {',
        '  return <DataRing percent={42} />',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)
    const svg = byName(expanded.nodes, 'svg')
    expect(svg.props.svg).toContain('<circle')
    // This fixture's <svg> is fully static (markup captured), so it carries no
    // lock of its own — and inlining no longer adds one.
    expect(svg.locked).toBeFalsy()
    const percentSpan = Object.values(expanded.nodes).find((n) => n.text === '42')
    expect(percentSpan).toBeDefined()
  })

  it('inlines StaticScreenshotScreen: an img src literal-forwarded through a destructured prop', () => {
    write(
      'components/StaticScreenshotScreen.jsx',
      [
        "export default function StaticScreenshotScreen({ src, alt }) {",
        '  return <div><img src={src} alt={alt} /></div>',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import StaticScreenshotScreen from '../components/StaticScreenshotScreen'",
        'export default function Home() {',
        '  return <StaticScreenshotScreen src="/shot.png" alt="Screenshot" />',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)
    const img = byName(expanded.nodes, 'img')
    expect(img.props.src).toBe('/shot.png')
    expect(img.props.alt).toBe('Screenshot')
    expect(img.locked).toBeFalsy()
  })

  it('inlines a same-file, NON-EXPORTED helper component (e.g. BookingDetailsScreen\'s private row components)', () => {
    // `export` only matters for a CROSS-FILE import to succeed — a private
    // helper function declared and used within the SAME file needs no
    // `export` at all, and real corpus code (BookingDetailsScreen.jsx's
    // `BookingReferenceRow`) relies on exactly that.
    const pageFile = write(
      'pages/Home.jsx',
      [
        'function Row({ label, value }) {',
        '  return <div className="row"><span>{label}</span><span>{value}</span></div>',
        '}',
        'export default function Home() {',
        '  return <Row label="ID" value="123" />',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)
    const spans = Object.values(expanded.nodes).filter((n) => n.name === 'span')
    expect(spans.map((s) => s.text).sort()).toEqual(['123', 'ID'])
    for (const span of spans) {
      expect(span.locked).toBeFalsy()
      expect(span.fromComponent).toBe('Row')
    }
  })

  it('package (non-local) components are left completely untouched', () => {
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import { Button } from '@alm-design/design-system'",
        'export default function Home() {',
        '  return <Button label="Save" />',
        '}',
        '',
      ].join('\n'),
    )

    const { parsed, expanded } = load(pageFile)
    const originalButton = byName(parsed.nodes, 'Button')
    const expandedButton = byName(expanded.nodes, 'Button')
    expect(expandedButton).toEqual(originalButton)
  })
})

describe('inlineLocalComponents — 2b: recursion + cycle guard + maxDepth/maxNodes caps', () => {
  it('recurses through a 2-level local chain (SheetShell → SheetHeader + StatusBar shape)', () => {
    write(
      'components/StatusBar.jsx',
      "export default function StatusBar({ className }) {\n  return <div className={className}>clock</div>\n}\n",
    )
    write(
      'components/SheetHeader.jsx',
      "export default function SheetHeader({ title }) {\n  return <p>{title}</p>\n}\n",
    )
    write(
      'components/SheetShell.jsx',
      [
        "import StatusBar from './StatusBar'",
        "import SheetHeader from './SheetHeader'",
        'export default function SheetShell({ title }) {',
        '  return (',
        '    <div className="sheet-shell">',
        '      <StatusBar className="status" />',
        '      <SheetHeader title={title} />',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import SheetShell from '../components/SheetShell'",
        'export default function Home() {',
        '  return <SheetShell title="Confirm booking" />',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)

    const p = byName(expanded.nodes, 'p')
    expect(p.text).toBe('Confirm booking')
    expect(p.fromComponent).toBe('SheetHeader')

    const statusBarDiv = Object.values(expanded.nodes).find((n) => n.text === 'clock')
    expect(statusBarDiv).toBeDefined()
    expect(statusBarDiv!.fromComponent).toBe('StatusBar')
    // A composite id encodes BOTH hops: the SheetShell call site, then the StatusBar call site nested inside it.
    expect(statusBarDiv!.id.split(INLINE_ID_SEPARATOR).length).toBeGreaterThanOrEqual(3)
  })

  it('gives every instance of the same component a unique composite id', () => {
    write('components/Icon.jsx', "export default function Icon({ size }) {\n  return <span>{size}</span>\n}\n")
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import Icon from '../components/Icon'",
        'export default function Home() {',
        '  return (',
        '    <div>',
        '      <Icon size={1} />',
        '      <Icon size={2} />',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)
    const spans = Object.values(expanded.nodes).filter((n) => n.name === 'span')
    expect(spans.length).toBe(2)
    expect(spans[0]!.id).not.toBe(spans[1]!.id)
    expect(new Set(spans.map((s) => s.id)).size).toBe(2)
  })

  it('terminates a cycle (A imports B, B imports A) leaving an opaque node, never hangs', () => {
    write(
      'components/A.jsx',
      ["import B from './B'", 'export default function A() {', '  return <div><B /></div>', '}', ''].join('\n'),
    )
    write(
      'components/B.jsx',
      ["import A from './A'", 'export default function B() {', '  return <div><A /></div>', '}', ''].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      ["import A from '../components/A'", 'export default function Home() {', '  return <A />', '}', ''].join('\n'),
    )

    const { expanded } = load(pageFile)
    // Should terminate at all (this test would hang/timeout if it didn't).
    expect(Object.keys(expanded.nodes).length).toBeGreaterThan(0)
    // Somewhere down the chain, a component node is left un-inlined (opaque) rather than looping forever.
    const stillComponent = Object.values(expanded.nodes).some((n) => n.kind === 'component')
    expect(stillComponent).toBe(true)
  })

  it('maxDepth caps a deep chain, degrading the over-depth call site to an opaque node', () => {
    // Five-level chain: Home -> L1 -> L2 -> L3 -> L4 -> L5
    const levels = ['L1', 'L2', 'L3', 'L4', 'L5']
    for (let i = 0; i < levels.length; i++) {
      const name = levels[i]!
      const next = levels[i + 1]
      write(
        `components/${name}.jsx`,
        next
          ? [`import ${next} from './${next}'`, `export default function ${name}() {`, `  return <div><${next} /></div>`, '}', ''].join('\n')
          : `export default function ${name}() {\n  return <div>leaf</div>\n}\n`,
      )
    }
    const pageFile = write(
      'pages/Home.jsx',
      ["import L1 from '../components/L1'", 'export default function Home() {', '  return <L1 />', '}', ''].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)
    const expanded = inlineLocalComponents(parsed, sources, project, tmpDir, { maxDepth: 2 })

    // Never throws, never an empty page — degrades to an opaque `kind:'component'` node once depth 2 is hit.
    expect(Object.keys(expanded.nodes).length).toBeGreaterThan(0)
    const stillComponent = Object.values(expanded.nodes).some((n) => n.kind === 'component')
    expect(stillComponent).toBe(true)
    // Never got as deep as the leaf div's "leaf" text.
    const leaf = Object.values(expanded.nodes).some((n) => n.text === 'leaf')
    expect(leaf).toBe(false)
  })

  it('maxNodes caps total node production, degrading rather than failing', () => {
    write('components/Icon.jsx', "export default function Icon() {\n  return <div><span>a</span><span>b</span><span>c</span></div>\n}\n")
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import Icon from '../components/Icon'",
        'export default function Home() {',
        '  return (',
        '    <div>',
        '      <Icon />',
        '      <Icon />',
        '      <Icon />',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)
    const startCount = Object.keys(parsed.nodes).length
    // Cap so low that at most one Icon's worth of nodes (~4) can be added.
    const expanded = inlineLocalComponents(parsed, sources, project, tmpDir, { maxNodes: startCount + 4 })

    expect(Object.keys(expanded.nodes).length).toBeGreaterThan(0)
    const stillComponent = Object.values(expanded.nodes).some((n) => n.kind === 'component')
    expect(stillComponent).toBe(true) // at least one Icon call site never got expanded
  })
})

describe('inlineLocalComponents — 2c: {children} passthrough', () => {
  it('splices the call site\'s own (real, unprefixed, editable) children into a {children} slot', () => {
    write(
      'components/SheetShell.jsx',
      [
        'export default function SheetShell({ title, children }) {',
        '  return (',
        '    <div className="sheet-shell">',
        '      <p>{title}</p>',
        '      <div className="sheet-shell__panel">{children}</div>',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/BookingDetailsScreen.jsx',
      [
        "import SheetShell from '../components/SheetShell'",
        'export default function BookingDetailsScreen() {',
        '  return (',
        '    <SheetShell title="Confirm">',
        '      <p className="body-text">Your booking details</p>',
        '    </SheetShell>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const { parsed, expanded } = load(pageFile)

    // The real body-text <p> keeps its ORIGINAL id (unprefixed) — it's page-native content.
    const originalBody = byName(parsed.nodes, 'p') // BookingDetailsScreen's own <p>, not SheetHeader's
    const bodyInExpanded = expanded.nodes[originalBody.id]
    expect(bodyInExpanded).toBeDefined()
    expect(bodyInExpanded!.text).toBe('Your booking details')
    // It stays fully editable — {children} splicing never locks the caller's own content.
    expect(bodyInExpanded!.locked).toBeFalsy()

    // It's now referenced as a child of the (locked) panel div inside SheetShell's inlined subtree.
    const panel = Object.values(expanded.nodes).find((n) => n.props.className === 'sheet-shell__panel')
    expect(panel).toBeDefined()
    expect(panel!.locked).toBeFalsy()
    expect(panel!.children).toContain(originalBody.id)
  })
})

describe('inlineLocalComponents — 2d: locking fidelity on variant branching / .map / computed className', () => {
  it('renders something structural for a component with .map, ternary, and a dynamic className (EsimStatusBanner shape) — never crashes, never empty', () => {
    write(
      'components/EsimStatusBanner.jsx',
      [
        "export default function EsimStatusBanner({ variant, items }) {",
        '  return (',
        '    <div className={`banner banner--${variant}`}>',
        '      {variant === \'success\' ? <span>OK</span> : <span>Warn</span>}',
        '      <ul>',
        '        {items.map((item) => (',
        '          <li key={item.id}>{item.label}</li>',
        '        ))}',
        '      </ul>',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import EsimStatusBanner from '../components/EsimStatusBanner'",
        'export default function Home() {',
        "  return <EsimStatusBanner variant=\"success\" items={[]} />",
        '}',
        '',
      ].join('\n'),
    )

    const { expanded } = load(pageFile)

    expect(Object.keys(expanded.nodes).length).toBeGreaterThan(0)
    const banner = Object.values(expanded.nodes).find((n) => n.name === 'div' && n.props.className === 'banner banner--')
    expect(banner).toBeDefined() // static prefix of the template literal kept
    // Editable: its writeback target is EsimStatusBanner's own source line.
    // `fromComponent` is what warns the user that the edit lands on every
    // instance of the component.
    expect(banner!.locked).toBeFalsy()
    expect(banner!.fromComponent).toBe('EsimStatusBanner')

    // Both ternary branches are structurally PRESENT (not dropped) — same
    // "degrade, don't drop" convention `parseJsxTree` already applies to a
    // dynamic-rendering surface; their own `text` stays unset because they
    // were ALREADY locked for that (pre-existing, unrelated to inlining)
    // reason, same as any other locked node in the parser.
    const spans = Object.values(expanded.nodes).filter((n) => n.name === 'span')
    expect(spans.length).toBe(2)
    for (const span of spans) {
      // These KEEP a lock — they sit in a ternary, so there is no single
      // source position an edit could write to. That is the only thing
      // `locked` means now; inlining on its own no longer locks anything.
      expect(span.locked).toBe(true)
      expect(span.lockReason).toBe('dynamic — rendered in code')
      expect(span.fromComponent).toBe('EsimStatusBanner')
    }

    // The `.map()`-rendered <li> is present too, locked, never crashing on
    // the loop shape (`.map()` expansion itself stays banned/out of scope —
    // §7.7 — only ONE structural `<li>` node is produced, mirroring
    // `parseJsxTree`'s existing `.map` handling).
    const li = Object.values(expanded.nodes).find((n) => n.name === 'li')
    expect(li).toBeDefined()
    expect(li!.locked).toBe(true)
  })
})

describe('inlineLocalComponents — cross-cutting (§2.8)', () => {
  it('never throws and yields the unmodified input page when the target file has a syntax error', () => {
    write('components/Broken.jsx', 'export default function Broken( {\n  return <div>>>>\n')
    const pageFile = write(
      'pages/Home.jsx',
      [
        "import Broken from '../components/Broken'",
        'export default function Home() {',
        '  return <Broken />',
        '}',
        '',
      ].join('\n'),
    )

    const { parsed, expanded } = load(pageFile)
    expect(expanded).toEqual(parsed)
  })

  it('never throws on a workspace project (defensive top-level contract)', () => {
    const pageFile = write(
      'pages/Home.jsx',
      'export default function Home() {\n  return <div>hi</div>\n}\n',
    )
    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)
    expect(() => inlineLocalComponents(parsed, sources, project, tmpDir)).not.toThrow()
  })
})
