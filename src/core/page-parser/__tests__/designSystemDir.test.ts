/**
 * designSystemDir — the `design-system` source kind, end to end through the
 * parser: classification, the black-box guarantee, and the two things that
 * must NEVER happen to a Studio-written folder sitting in a user's repo (its
 * CSS entering the editable registry, its components being offered as the
 * project's own).
 *
 * ## Deliberately not the eSIM corpus
 *
 * Every generality bug this module has ever had came from a suite grown on one
 * repo (`genericRepoShapes.test.ts`'s own header says so), and "the design
 * system" is the single easiest place to encode one repo's habits. So the
 * fixtures here are a **plain-JS marketing site** — `.jsx` files, a default
 * export, a `src/design-system/` folder of the user's OWN hand-written
 * components that must keep behaving like ordinary local components, and
 * component names (`Banner`, `Pill`) that appear nowhere in the eSIM corpus or
 * in Studio's own manifest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { collectEntryStylesheets, collectPageStylesheets } from '../../studio-sync/collectPageStylesheets'
import { createWorkspaceProject, resolveComponentSources } from '../componentSources'
import {
  PROJECT_DESIGN_SYSTEM_DIR,
  designSystemImportSpecifier,
  isDesignSystemPath,
} from '../designSystemDir'
import { inlineLocalComponents } from '../inlineLocalComponents'
import { parsePageFile } from '../parsePageFile'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-source-kind-'))
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

/**
 * Studio's own copy of the design system, as `designSystemFiles.ts` writes it:
 * an `index.js` barrel re-exporting `components/<Name>`, each component with a
 * sibling `.css`, and a token stylesheet the barrel itself imports.
 */
function writeDesignSystemFolder(): void {
  write(
    `${PROJECT_DESIGN_SYSTEM_DIR}/index.js`,
    [
      "import './tokens/tokens.css'",
      "export { Banner } from './components/Banner'",
      "export { Pill } from './components/Pill'",
      '',
    ].join('\n'),
  )
  write(`${PROJECT_DESIGN_SYSTEM_DIR}/tokens/tokens.css`, ':root { --ds-ink: #101010; }\n')
  write(
    `${PROJECT_DESIGN_SYSTEM_DIR}/components/Banner.jsx`,
    [
      "import './Banner.css'",
      'export function Banner({ headline }) {',
      '  return <aside className="ds-banner"><strong>{headline}</strong></aside>',
      '}',
      '',
    ].join('\n'),
  )
  write(`${PROJECT_DESIGN_SYSTEM_DIR}/components/Banner.css`, '.ds-banner { padding: 12px; }\n')
  write(
    `${PROJECT_DESIGN_SYSTEM_DIR}/components/Pill.jsx`,
    ['export function Pill({ label }) {', '  return <span className="ds-pill">{label}</span>', '}', ''].join('\n'),
  )
  write(`${PROJECT_DESIGN_SYSTEM_DIR}/components/Pill.css`, '.ds-pill { border-radius: 999px; }\n')
}

function sourcesFor(pageFile: string) {
  const project = createWorkspaceProject(tmpDir)
  const parsed = parsePageFile(pageFile, tmpDir, project)
  return { project, parsed, sources: resolveComponentSources(project, pageFile, tmpDir, parsed) }
}

function nodeIdNamed(nodes: Record<string, { name: string; id: string }>, name: string): string {
  const node = Object.values(nodes).find((n) => n.name === name)
  if (!node) throw new Error(`no parsed node named "${name}"`)
  return node.id
}

describe('isDesignSystemPath', () => {
  it('matches the folder and anything under it', () => {
    expect(isDesignSystemPath('design-system')).toBe(true)
    expect(isDesignSystemPath('design-system/index.js')).toBe(true)
    expect(isDesignSystemPath('design-system/components/Banner.css')).toBe(true)
  })

  it("does NOT match a user's own folder of the same name deeper in the tree", () => {
    // Root-anchored: `src/design-system/` is the user's, stays local, stays
    // inlinable. Only the folder Studio writes at the project root is Studio's.
    expect(isDesignSystemPath('src/design-system/Button.jsx')).toBe(false)
    expect(isDesignSystemPath('packages/design-system/index.ts')).toBe(false)
    expect(isDesignSystemPath('design-systems/legacy.css')).toBe(false)
    expect(isDesignSystemPath('pages/Home.jsx')).toBe(false)
  })
})

describe('designSystemImportSpecifier', () => {
  it('climbs exactly as far as the importing file sits', () => {
    expect(designSystemImportSpecifier('pages/Home.tsx')).toBe('../design-system')
    expect(designSystemImportSpecifier('pages/account/Settings.tsx')).toBe('../../design-system')
    expect(designSystemImportSpecifier('src/app/routes/deep/Page.jsx')).toBe('../../../../design-system')
  })

  it('writes an explicitly-relative specifier for a file at the project root', () => {
    // Never `design-system` bare — that reads as a package specifier.
    expect(designSystemImportSpecifier('App.jsx')).toBe('./design-system')
  })
})

describe('resolveComponentSources — the design-system kind', () => {
  it('classifies a barrel import as design-system, carrying the export name', () => {
    writeDesignSystemFolder()
    const pageFile = write(
      'pages/Landing.jsx',
      [
        "import { Banner } from '../design-system'",
        'export default function Landing() {',
        '  return <Banner headline="Spring sale" />',
        '}',
        '',
      ].join('\n'),
    )

    const { parsed, sources } = sourcesFor(pageFile)
    expect(sources[nodeIdNamed(parsed.nodes, 'Banner')]).toEqual({ kind: 'design-system', name: 'Banner' })
  })

  it('carries the EXPORT name through an alias, not the local binding', () => {
    writeDesignSystemFolder()
    const pageFile = write(
      'pages/Landing.jsx',
      [
        "import { Pill as Tag } from '../design-system'",
        'export default function Landing() {',
        '  return <Tag label="New" />',
        '}',
        '',
      ].join('\n'),
    )

    const { parsed, sources } = sourcesFor(pageFile)
    // `alm.Pill`, never `alm.Tag` — the module id is minted from this name.
    expect(sources[nodeIdNamed(parsed.nodes, 'Tag')]).toEqual({ kind: 'design-system', name: 'Pill' })
  })

  it('classifies a DEEP import of a component file, not only the barrel', () => {
    writeDesignSystemFolder()
    const pageFile = write(
      'pages/Landing.jsx',
      [
        "import { Banner } from '../design-system/components/Banner'",
        'export default function Landing() {',
        '  return <Banner headline="Deep" />',
        '}',
        '',
      ].join('\n'),
    )

    const { parsed, sources } = sourcesFor(pageFile)
    expect(sources[nodeIdNamed(parsed.nodes, 'Banner')]).toEqual({ kind: 'design-system', name: 'Banner' })
  })

  it('resolves a member-access tag off a namespace import to the member, not the namespace', () => {
    writeDesignSystemFolder()
    const pageFile = write(
      'pages/Landing.jsx',
      [
        "import * as DS from '../design-system'",
        'export default function Landing() {',
        '  return <DS.Pill label="New" />',
        '}',
        '',
      ].join('\n'),
    )

    const { parsed, sources } = sourcesFor(pageFile)
    expect(sources[nodeIdNamed(parsed.nodes, 'DS.Pill')]).toEqual({ kind: 'design-system', name: 'Pill' })
  })

  it("leaves a user's own src/design-system/ component LOCAL", () => {
    // The refusal this rule must not over-reach into: a hand-written folder
    // that happens to share the name is the user's code, and inlining it is
    // exactly what they want.
    write('src/design-system/Hero.jsx', 'export function Hero() { return <h1 className="hero">Hi</h1> }\n')
    const pageFile = write(
      'pages/Landing.jsx',
      [
        "import { Hero } from '../src/design-system/Hero'",
        'export default function Landing() {',
        '  return <Hero />',
        '}',
        '',
      ].join('\n'),
    )

    const { parsed, sources } = sourcesFor(pageFile)
    expect(sources[nodeIdNamed(parsed.nodes, 'Hero')]).toEqual({ kind: 'local', file: 'src/design-system/Hero.jsx' })
  })
})

describe('inlineLocalComponents — the black box', () => {
  it('never expands a design-system component, even though its source is right there', () => {
    writeDesignSystemFolder()
    const pageFile = write(
      'pages/Landing.jsx',
      [
        "import { Banner } from '../design-system'",
        "import { Hero } from '../components/Hero'",
        'export default function Landing() {',
        '  return (',
        '    <main>',
        '      <Hero />',
        '      <Banner headline="Spring sale" />',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    write('components/Hero.jsx', 'export function Hero() { return <h1 className="hero">Hi</h1> }\n')

    const { project, parsed, sources } = sourcesFor(pageFile)
    const expanded = inlineLocalComponents(parsed, sources, project, tmpDir)
    const names = Object.values(expanded.nodes).map((n) => n.name)

    // The LOCAL component expanded into its own markup…
    expect(names).toContain('h1')
    // …and the design-system one stayed exactly one opaque call site, with its
    // call-site props intact.
    expect(names.filter((n) => n === 'Banner')).toHaveLength(1)
    expect(names).not.toContain('aside')
    const banner = Object.values(expanded.nodes).find((n) => n.name === 'Banner')!
    expect(banner.props.headline).toBe('Spring sale')
  })
})

describe('stylesheet collection — the folder\'s CSS never becomes editable', () => {
  it('collects the page\'s own stylesheet but never the design system\'s', () => {
    writeDesignSystemFolder()
    write('pages/Landing.css', '.landing { color: red; }\n')
    const pageFile = write(
      'pages/Landing.jsx',
      [
        "import './Landing.css'",
        "import '../design-system/components/Banner.css'",
        "import { Banner } from '../design-system'",
        'export default function Landing() {',
        '  return <Banner headline="Spring sale" />',
        '}',
        '',
      ].join('\n'),
    )

    const { project, parsed } = sourcesFor(pageFile)
    const sheets = collectPageStylesheets(parsed, 'pages/Landing.jsx', project, tmpDir)
    expect(sheets.map((s) => s.relPath)).toEqual(['pages/Landing.css'])
  })

  it('does not follow the entry graph into the design-system folder', () => {
    // The real shape: the prototype shell (and a user's own App) imports the
    // folder's barrel, whose `index.js` imports every token + component
    // stylesheet. Following that edge would drop ~400 rules the user cannot
    // edit into `site.styleRules` — the canvas already injects Studio's own
    // copy of the same CSS as a read-only vendor layer.
    writeDesignSystemFolder()
    write('src/index.css', 'body { margin: 0; }\n')
    write(
      'src/main.jsx',
      ["import './index.css'", "import { Banner } from '../design-system'", 'export default Banner', ''].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const sheets = collectEntryStylesheets(project, tmpDir)
    expect(sheets.map((s) => s.relPath)).toEqual(['src/index.css'])
  })
})
