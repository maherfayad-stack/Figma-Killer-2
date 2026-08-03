/**
 * projectGuide — gates for what Studio writes into a user's project, and (just
 * as important) what it refuses to overwrite.
 *
 * Exercised against real temp directories, never the real `claude` binary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateStudioProjectGuide } from './projectGuide'
import { buildDesignSystemGuide, renderComponentReference, renderIconReference } from './designSystemGuide'

function write(root: string, relPath: string, contents: string): void {
  const full = join(root, ...relPath.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

function read(root: string, relPath: string): string {
  return readFileSync(join(root, ...relPath.split('/')), 'utf8')
}

describe('generateStudioProjectGuide', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-guide-'))
    write(dir, 'package.json', JSON.stringify({ name: 'p', dependencies: {} }))
    write(dir, 'pages/Home.tsx', 'export default function Home() {\n  return <main />\n}\n')
    write(dir, 'pages/Home.module.css', '.page { display: flex; }\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes CLAUDE.md at the project root, where the CLI loads it from cwd for free', () => {
    const result = generateStudioProjectGuide(dir)
    expect(result.written).toContain('CLAUDE.md')
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true)
  })

  it('names this project\'s real conventions, not generic advice', () => {
    generateStudioProjectGuide(dir)
    const guide = read(dir, 'CLAUDE.md')
    expect(guide).toContain('pages/')
    expect(guide).toContain('.tsx')
    // The behaviours the guide exists to change.
    expect(guide).toContain('studio_screenshot')
    expect(guide).toContain('Do not ask before building')
  })

  it('makes a measured pass the definition of done when a design must be matched', () => {
    // Looking is not enough: a screen with overlapping text and speck-sized
    // icons was screenshotted, looked at, and reported as done.
    generateStudioProjectGuide(dir)
    const guide = read(dir, 'CLAUDE.md')
    expect(guide).toContain('studio_compare')
    expect(guide).toContain('`pass: true`')
  })

  it('tells the agent to name an asset it cannot obtain rather than draw one', () => {
    generateStudioProjectGuide(dir)
    const guide = read(dir, 'CLAUDE.md')
    expect(guide).toContain('cannot invent an icon')
    expect(guide).toContain('placeholder')
  })

  it('generates no subagent definitions — the roster is gone, not renamed', () => {
    generateStudioProjectGuide(dir)
    expect(existsSync(join(dir, '.claude', 'agents'))).toBe(false)
  })

  it('never overwrites a CLAUDE.md the user has made their own', () => {
    generateStudioProjectGuide(dir)
    const mine = '# My own house rules\n'
    writeFileSync(join(dir, 'CLAUDE.md'), mine, 'utf8')

    const second = generateStudioProjectGuide(dir)
    expect(second.skipped).toContain('CLAUDE.md')
    expect(second.written).not.toContain('CLAUDE.md')
    expect(read(dir, 'CLAUDE.md')).toBe(mine)
  })

  it('takes the fast path when nothing changed — the warm turn must be nearly free', () => {
    expect(generateStudioProjectGuide(dir).written.length).toBeGreaterThan(0)
    const second = generateStudioProjectGuide(dir)
    expect(second.written).toEqual([])
    expect(second.skipped).toEqual([])
  })

  it('heals a project that has no design system at all, not just newly created ones', () => {
    // Seeding at project creation only ever helps projects created after the
    // seed existed. Every older project — and any project whose contents were
    // cleared — stayed permanently empty: no `componentPackages`, so
    // `design-system-components.md` never generated, while `CLAUDE.md` told
    // the agent to read it. Observed exactly that way, twice.
    rmSync(join(dir, 'package.json'))
    expect(existsSync(join(dir, 'package.json'))).toBe(false)

    const result = generateStudioProjectGuide(dir)

    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(result.written).toContain('.claude/design-system-components.md')
    expect(read(dir, '.claude/design-system-components.md')).toContain("from '@alm-design/design-system'")
  })

  it('leaves a project that has its own package.json alone', () => {
    // A project carrying its own manifest has stated its dependencies. Copying
    // a package it does not declare would be Studio deciding one for the user.
    const mine = '{"name":"mine","dependencies":{}}'
    writeFileSync(join(dir, 'package.json'), mine, 'utf8')

    generateStudioProjectGuide(dir)

    expect(read(dir, 'package.json')).toBe(mine)
    expect(existsSync(join(dir, 'node_modules'))).toBe(false)
  })

  it('degrades to no guide rather than throwing when the project cannot be probed', () => {
    const missing = join(dir, 'does-not-exist')
    expect(() => generateStudioProjectGuide(missing)).not.toThrow()
  })
})

describe('buildDesignSystemGuide', () => {
  let pkgDir: string

  beforeEach(() => {
    pkgDir = mkdtempSync(join(tmpdir(), 'studio-ds-'))
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@scope/ds', exports: { '.': './dist/index.js', './dist/index.css': './dist/index.css' } }),
      'utf8',
    )
    writeFileSync(
      join(pkgDir, 'CLAUDE.md'),
      [
        '# DS',
        '',
        '## Installation & import',
        '',
        '```js',
        "import { Button } from 'design-system'",
        '```',
        '',
        '## Components',
        '',
        '### Button',
        '',
        '```jsx',
        '<Button variant="primary" label="Label" />',
        '```',
        '',
        '- Text is set via the `label` prop',
        '',
        '### Chip',
        '',
        '```jsx',
        '<Chip label="Label" selected={false} />',
        '```',
        '',
        '## Conventions',
        '',
        '### NotAComponent',
        '',
        'This heading sits outside the Components section and must not be harvested.',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(pkgDir, 'design.md'),
      ['# DS intent', '', '## Component Decision Map', '', '| I want to… | Use |', '|---|---|', '| Trigger an action | `Button` |', '', '## Button', '', 'Buttons trigger actions.'].join('\n'),
      'utf8',
    )
  })

  afterEach(() => {
    rmSync(pkgDir, { recursive: true, force: true })
  })

  it('harvests only the components under the Components heading', () => {
    const guide = buildDesignSystemGuide(pkgDir, '@scope/ds')!
    expect(guide.components.map((c) => c.name)).toEqual(['Button', 'Chip'])
  })

  it('carries each component\'s real props block and its intent line', () => {
    const button = buildDesignSystemGuide(pkgDir, '@scope/ds')!.components[0]!
    expect(button.props).toContain('variant="primary"')
    expect(button.summary).toBe('Buttons trigger actions.')
  })

  it('keeps the decision map, which is what answers "which component"', () => {
    expect(buildDesignSystemGuide(pkgDir, '@scope/ds')!.decisionMap).toContain('`Button`')
  })

  it('teaches the INSTALLED package name, never the specifier the package documents for itself', () => {
    // The real ALM package's own CLAUDE.md says `from 'design-system'` — the
    // name it uses in its own monorepo, not the name it publishes under.
    // Embedding that verbatim would hand the agent an import that resolves to
    // nothing and breaks the user's build.
    const contract = buildDesignSystemGuide(pkgDir, '@scope/ds')!.importContract!
    expect(contract).toContain("from '@scope/ds'")
    expect(contract).not.toContain("from 'design-system'")
  })

  it('emits the stylesheet import only because the package actually exports one', () => {
    expect(buildDesignSystemGuide(pkgDir, '@scope/ds')!.importContract).toContain("import '@scope/ds/dist/index.css'")

    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@scope/ds', exports: { '.': './dist/index.js' } }), 'utf8')
    expect(buildDesignSystemGuide(pkgDir, '@scope/ds')!.importContract).not.toContain('.css')
  })

  it('contributes nothing at all for a package that ships no docs', () => {
    const bare = mkdtempSync(join(tmpdir(), 'studio-ds-bare-'))
    try {
      expect(buildDesignSystemGuide(bare, '@scope/bare')).toBeUndefined()
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('reads the icon components the package actually re-exports by name', () => {
    // The bug this closes: the guide said "the package ships a real icon set;
    // import from it" and named no export and no path. Unfollowable, so the
    // agent hand-drew SVG path data for `ChevronLeft`/`ChevronDown` — both of
    // which the package exports as `ChevronLeftIcon`/`ChevronDownIcon`.
    mkdirSync(join(pkgDir, 'src', 'icons'), { recursive: true })
    writeFileSync(
      join(pkgDir, 'src', 'index.js'),
      [
        "export { Button } from './components/Button'",
        'export {',
        '  ChevronLeftIcon,',
        '  ChevronDownIcon,',
        "} from './icons/LineIcons'",
      ].join('\n'),
      'utf8',
    )

    const icons = buildDesignSystemGuide(pkgDir, '@scope/ds')!.icons!
    expect(icons.components).toEqual(['ChevronDownIcon', 'ChevronLeftIcon'])
    // `Button` is a component re-export, not an icon one — the block filter
    // must not sweep it in.
    expect(icons.components).not.toContain('Button')
  })

  it('catalogs the raw SVGs by directory', () => {
    mkdirSync(join(pkgDir, 'src', 'icons', 'line-icons'), { recursive: true })
    writeFileSync(join(pkgDir, 'src', 'icons', 'line-icons', 'airplaneTilt.svg'), '<svg/>', 'utf8')
    writeFileSync(join(pkgDir, 'src', 'icons', 'line-icons', 'calendar.svg'), '<svg/>', 'utf8')
    writeFileSync(join(pkgDir, 'src', 'icons', 'line-icons', 'notes.txt'), 'ignored', 'utf8')

    const catalogs = buildDesignSystemGuide(pkgDir, '@scope/ds')!.icons!.catalogs
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.path).toBe('src/icons/line-icons')
    expect(catalogs[0]!.names).toEqual(['airplaneTilt', 'calendar'])
  })

  it('renders an icon reference that forbids hand-drawing and gives the exact import', () => {
    mkdirSync(join(pkgDir, 'src', 'icons', 'line-icons'), { recursive: true })
    writeFileSync(join(pkgDir, 'src', 'icons', 'line-icons', 'airplaneTilt.svg'), '<svg/>', 'utf8')
    writeFileSync(join(pkgDir, 'src', 'index.js'), "export {\n  ChevronLeftIcon,\n} from './icons/LineIcons'", 'utf8')

    const rendered = renderIconReference(buildDesignSystemGuide(pkgDir, '@scope/ds')!)!
    expect(rendered).toContain('Never hand-draw an SVG path')
    expect(rendered).toContain("import { ChevronLeftIcon } from '@scope/ds'")
    expect(rendered).toContain("from '@scope/ds/src/icons/line-icons/airplaneTilt.svg'")
  })

  it('contributes no icon section for a package that ships none', () => {
    // A design system with no icons must produce no icon reference, rather
    // than an empty one that reads as "there are no icons here".
    expect(buildDesignSystemGuide(pkgDir, '@scope/ds')!.icons).toBeUndefined()
    expect(renderIconReference(buildDesignSystemGuide(pkgDir, '@scope/ds')!)).toBeUndefined()
  })

  it('renders a reference that tells the agent to import rather than re-implement', () => {
    const rendered = renderComponentReference(buildDesignSystemGuide(pkgDir, '@scope/ds')!)
    expect(rendered).toContain('### Button')
    expect(rendered).toContain('do not re-implement it')
  })
})
