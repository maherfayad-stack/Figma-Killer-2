/**
 * The id-parity gate for Track L's Vite plugin: for every fixture below, the
 * id `parsePageFile` mints for a host element and the id `idStamp.ts` (the
 * Babel-based Vite transform) mints for the SAME source position must agree —
 * or, for the two documented mismatch shapes (an inlined call site, a `.map`
 * row), collapse to it once `toStampId` strips what a single-file Babel pass
 * could never have known about.
 *
 * Reuses three EXISTING fixtures rather than inventing a new corpus (per
 * `STATE.md`'s `live-03` design note) — the exact same source text as:
 *   - `genericRepoShapes.test.ts`'s `export default function` shape (plain
 *     host elements, no inlining, no loop — the strict baseline)
 *   - `inlineLocalComponents.test.ts`'s Icon fixture (a composite id)
 *   - `staticLoopExpansion.test.ts`'s Packages fixture (a `.map`-suffixed id)
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
import { toStampId } from '@core/studio-runtime'
import { stampHostElementIds, STUDIO_NODE_ID_ATTR } from '../../core/studio-runtime/idStamp'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-parity-'))
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

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

/** Every `data-node-id="…"` value `idStamp.ts` wrote into `code`. */
function stampedIds(code: string): Set<string> {
  const re = new RegExp(`${STUDIO_NODE_ID_ATTR}="([^"]+)"`, 'g')
  const ids = new Set<string>()
  for (const match of code.matchAll(re)) ids.add(match[1]!)
  return ids
}

describe('idParity — plain host elements (genericRepoShapes.test.ts shape)', () => {
  it("the parser's ids and the plugin's stamped ids are IDENTICAL sets — no inlining, no loop", () => {
    const source = ['export default function Plain() {', '  return <section><h2>Hello</h2></section>', '}', ''].join(
      '\n',
    )
    const relFile = 'pages/Plain.tsx'
    const file = write(relFile, source)

    const project = createWorkspaceProject(tmpDir)
    const nodes = Object.values(parsePageFile(file, tmpDir, project).nodes)
    const parserIds = new Set(nodes.filter((n) => n.kind === 'element').map((n) => n.id))
    expect(parserIds.size).toBe(2) // section, h2

    const result = stampHostElementIds(source, relFile)
    expect(result.changed).toBe(true)
    expect(stampedIds(result.code)).toEqual(parserIds)
  })
})

describe("idParity — an inlined call site (inlineLocalComponents.test.ts's Icon fixture)", () => {
  it("the composite id's TAIL, stripped, equals the plugin's stamp of the component's OWN file", () => {
    const iconRelFile = 'components/Icon.jsx'
    const iconSource = [
      'export default function Icon({ size = 24, className }) {',
      '  return <span className={className}>{size}</span>',
      '}',
      '',
    ].join('\n')
    write(iconRelFile, iconSource)

    const pageRelFile = 'pages/Home.jsx'
    const pageSource = [
      "import Icon from '../components/Icon'",
      'export default function Home() {',
      '  return <div><Icon size={16} className="ico" /></div>',
      '}',
      '',
    ].join('\n')
    const pageFile = write(pageRelFile, pageSource)

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)
    const expanded = inlineLocalComponents(parsed, sources, project, tmpDir)

    const span = Object.values(expanded.nodes).find((n: ParsedNode) => n.name === 'span')
    expect(span).toBeDefined()
    // A composite id — the call site prefixed onto the component's own location.
    expect(span!.id).toContain('~')

    const iconStamp = stampHostElementIds(iconSource, iconRelFile)
    expect(iconStamp.changed).toBe(true)
    const iconStampedIds = stampedIds(iconStamp.code)
    expect(iconStampedIds.size).toBe(1) // one host element (span) in Icon.jsx

    // The mismatch this fixture exists to prove: the parser's composite id is
    // NOT itself a stamp the plugin could ever produce (it only ever sees one
    // file at a time) — but its stamp-id form, after stripping the call-site
    // prefix, is EXACTLY what stamping Icon.jsx on its own produces.
    expect(iconStampedIds.has(span!.id)).toBe(false)
    expect(iconStampedIds).toEqual(new Set([toStampId(span!.id)]))

    // The page file's own host element (the <div>, not inlined) still matches directly.
    const div = Object.values(expanded.nodes).find((n: ParsedNode) => n.name === 'div')!
    const pageStampedIds = stampedIds(stampHostElementIds(pageSource, pageRelFile).code)
    expect(pageStampedIds.has(div.id)).toBe(true)
  })
})

describe("idParity — a `.map` row (staticLoopExpansion.test.ts's Packages fixture)", () => {
  it("every row's `#n`-suffixed id collapses, once stripped, to the ONE id the plugin stamps", () => {
    const relFile = 'pages/Packages.jsx'
    const source = [
      'const PACKAGES = [',
      '  { gb: 1, price: 20 },',
      '  { gb: 3, price: 45 },',
      '  { gb: 5, price: 70 },',
      ']',
      'export default function Packages() {',
      '  return (',
      '    <div className="list">',
      '      {PACKAGES.map((pkg) => (',
      '        <span key={pkg.gb} className="row" data-price={pkg.price}>{pkg.gb}</span>',
      '      ))}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = write(relFile, source)

    const project = createWorkspaceProject(tmpDir)
    const nodes = Object.values(parsePageFile(file, tmpDir, project, evalOptions()).nodes)

    const rows = nodes.filter((n) => n.name === 'span')
    expect(rows).toHaveLength(3)
    const rowStampIds = new Set(rows.map((row) => toStampId(row.id)))
    // All three rows share ONE source position — collapsing to it is the
    // whole point of `toStampId` stripping the `#n` suffix.
    expect(rowStampIds.size).toBe(1)

    const div = nodes.find((n) => n.name === 'div' && n.props.className === 'list')
    expect(div).toBeDefined()

    const pluginStampedIds = stampedIds(stampHostElementIds(source, relFile).code)
    // Babel sees ONE `<span>` in source (the `.map` callback's own JSX) and
    // ONE `<div>` — exactly two stamped ids, matching the collapsed row stamp
    // plus the non-repeated container.
    expect(pluginStampedIds).toEqual(new Set([...rowStampIds, div!.id]))
  })
})
