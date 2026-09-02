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

  describe('.claude/settings.local.json — the Stop-hook write-verification gate', () => {
    it('wires a PostToolUse(Write|Edit) hook and a Stop hook, invoked as [bun, <absolute script path>]', () => {
      const result = generateStudioProjectGuide(dir)
      expect(result.written).toContain('.claude/settings.local.json')

      const settings = JSON.parse(read(dir, '.claude/settings.local.json')) as {
        hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>; Stop: Array<{ hooks: Array<{ command: string }> }> }
      }
      const postToolUse = settings.hooks.PostToolUse[0]!
      expect(postToolUse.matcher).toBe('Write|Edit')
      expect(postToolUse.hooks[0]!.command).toContain(process.execPath)
      expect(postToolUse.hooks[0]!.command).toContain('recordToolWrite.ts')

      const stop = settings.hooks.Stop[0]!
      expect(stop.hooks[0]!.command).toContain(process.execPath)
      expect(stop.hooks[0]!.command).toContain('stopGateCheck.ts')
    })

    it('never overwrites a hand-edited settings.local.json — same never-clobber manifest as CLAUDE.md', () => {
      generateStudioProjectGuide(dir)
      write(dir, '.claude/settings.local.json', JSON.stringify({ hooks: { UserPromptSubmit: [] } }, null, 2))

      const result = generateStudioProjectGuide(dir)
      expect(result.skipped).toContain('.claude/settings.local.json')
      expect(read(dir, '.claude/settings.local.json')).toContain('UserPromptSubmit')
    })
  })

  describe('legacy artefact sweep', () => {
    it('deletes guides a previous generator version wrote and this one does not', () => {
      // The CLI loads EVERY file under `.claude/` from its cwd, so leaving
      // these on disk did not make them inert — `figma.md` kept walking the
      // agent through a six-step Figma node-id workflow and handing off to
      // `screen-builder`, a subagent deleted a version ago.
      write(dir, '.claude/figma.md', '# Figma asset workflow\n')
      write(dir, '.claude/studio-tools.md', '# Studio tools\n')
      write(dir, '.claude/agents/screen-builder.md', '# screen-builder\n')

      const result = generateStudioProjectGuide(dir)

      expect(result.pruned).toContain('.claude/figma.md')
      expect(result.pruned).toContain('.claude/agents/screen-builder.md')
      expect(existsSync(join(dir, '.claude/figma.md'))).toBe(false)
      expect(existsSync(join(dir, '.claude/studio-tools.md'))).toBe(false)
      expect(existsSync(join(dir, '.claude/agents/screen-builder.md'))).toBe(false)
    })

    it('leaves the files this generator DOES own alone', () => {
      write(dir, '.claude/figma.md', '# Figma asset workflow\n')
      const result = generateStudioProjectGuide(dir)

      expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true)
      expect(result.written).toContain('CLAUDE.md')
      // The sweep must not reach the manifest that records it, either.
      expect(existsSync(join(dir, '.claude/.studio-generated.json'))).toBe(true)
    })

    it('reports only artefacts that were actually there', () => {
      // `rmSync(force:true)` does not throw for a missing path, so without an
      // existence check every project would claim to have swept all 18.
      write(dir, '.claude/figma.md', '# Figma asset workflow\n')
      const result = generateStudioProjectGuide(dir)
      expect(result.pruned).toEqual(['.claude/figma.md'])
    })

    it('sweeps once, then never again — a file the user later creates is theirs', () => {
      write(dir, '.claude/figma.md', '# Figma asset workflow\n')
      expect(generateStudioProjectGuide(dir).pruned).toEqual(['.claude/figma.md'])

      // The user deliberately writes their own, later.
      write(dir, '.claude/figma.md', '# MY notes about our Figma setup\n')
      const second = generateStudioProjectGuide(dir)

      expect(second.pruned).toEqual([])
      expect(read(dir, '.claude/figma.md')).toBe('# MY notes about our Figma setup\n')
    })

    it('sweeps a project that was already generated by an older version', () => {
      // The real upgrade path, and the one that matters: every existing
      // project has a guide already written, a warm manifest, and the
      // orphans sitting on disk. Simulated by stripping the sweep record the
      // way an older manifest would not have had it. A sweep placed behind
      // the fast path would never run for any of them.
      generateStudioProjectGuide(dir)
      const manifestPath = join(dir, '.claude/.studio-generated.json')
      const older = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      delete older.prunedLegacyArtefacts
      writeFileSync(manifestPath, JSON.stringify(older))

      write(dir, '.claude/figma.md', '# Figma asset workflow\n')

      const result = generateStudioProjectGuide(dir)
      expect(result.pruned).toEqual(['.claude/figma.md'])
      expect(existsSync(join(dir, '.claude/figma.md'))).toBe(false)
    })

    it('does not poison the next project — the empty manifest is not shared state', () => {
      // `readManifest` returns a fresh object per call because the prune
      // MUTATES what it returns. When it returned one shared constant, the
      // first project swept in a process wrote "already swept" into the value
      // every later project received, and nothing on disk explained why they
      // were skipped.
      write(dir, '.claude/figma.md', '# Figma asset workflow\n')
      expect(generateStudioProjectGuide(dir).pruned).toEqual(['.claude/figma.md'])

      const second = mkdtempSync(join(tmpdir(), 'studio-guide-2nd-'))
      try {
        write(second, 'package.json', JSON.stringify({ name: 'p2', dependencies: {} }))
        write(second, 'pages/Home.tsx', 'export default function Home() {\n  return <main />\n}\n')
        write(second, '.claude/figma.md', '# Figma asset workflow\n')
        expect(generateStudioProjectGuide(second).pruned).toEqual(['.claude/figma.md'])
      } finally {
        rmSync(second, { recursive: true, force: true })
      }
    })
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
    expect(rendered).toContain("from '@scope/ds/src/icons/line-icons/airplaneTilt.svg?raw'")
  })

  it('teaches the ?raw form and never the packaged-URL form, which cannot render', () => {
    // The regression this file exists to prevent, in the one place it was
    // actually caused: a packaged asset URL does not resolve
    // (`resolveImageAssetImport` passes `allowBare: false`), so the node
    // reaches the canvas as a `base.image` with no `src` and draws the "No
    // image selected" placeholder. Printing that snippet for every packaged
    // SVG is what taught the agent the icon set was unusable and sent it back
    // to hand-drawing paths. See `renderIconReference`'s own header.
    mkdirSync(join(pkgDir, 'src', 'icons', 'line-icons'), { recursive: true })
    writeFileSync(join(pkgDir, 'src', 'icons', 'line-icons', 'airplaneTilt.svg'), '<svg/>', 'utf8')

    const rendered = renderIconReference(buildDesignSystemGuide(pkgDir, '@scope/ds')!)!
    expect(rendered).toContain('?raw')

    // The render EXAMPLE — the line the agent copies — inlines the markup.
    // (Prose elsewhere names `<img src={…}>` on purpose, to say don't.)
    const renderExamples = rendered.split('\n').filter((l) => l.includes('then render it:'))
    expect(renderExamples).not.toBeEmpty()
    for (const line of renderExamples) {
      expect(line).toContain('dangerouslySetInnerHTML')
      expect(line).not.toContain('<img')
    }

    // And every catalog import carries the suffix — not just the first one.
    const importLines = rendered.split('\n').filter((l) => l.startsWith('import ') && l.includes('/src/icons/'))
    expect(importLines).not.toBeEmpty()
    for (const line of importLines) expect(line).toContain('.svg?raw')
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

/**
 * Track A5 — the generated guide is no longer hardcoded to
 * `@alm-design/design-system`. Every one of these installs a REAL,
 * non-ALM-named package under `node_modules` and asserts on the actual
 * generated content, not on `resolveDesignSystemGuide` in isolation — the
 * consumer (`generateStudioProjectGuide` -> `CLAUDE.md` +
 * `.claude/design-system-components.md`) is what an agent actually reads.
 */
describe('generateStudioProjectGuide — design-system knowledge for a non-ALM package', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-guide-a5-'))
    write(dir, 'pages/Home.tsx', 'export default function Home() {\n  return <main />\n}\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds a real "Use X" section and prop reference from a typed package with NO agent docs', () => {
    // Satisfies BOTH `detectComponentPackages`' declaration tier (a PascalCase
    // export whose type mentions `JSX.Element`) and `buildPackageManifest`'s
    // own `.d.ts` extraction — a stand-in for MUI/Chakra/Mantine/shadcn: real
    // types, no `CLAUDE.md`/`design.md` written for an agent.
    write(
      dir,
      'package.json',
      JSON.stringify({ name: 'p', dependencies: { 'js-ui-kit': '1.0.0' } }),
    )
    write(
      dir,
      'node_modules/js-ui-kit/package.json',
      JSON.stringify({ name: 'js-ui-kit', types: 'index.d.ts' }),
    )
    write(
      dir,
      'node_modules/js-ui-kit/index.d.ts',
      [
        'export interface ButtonProps {',
        "  variant?: 'primary' | 'ghost' | 'danger';",
        '  label: string;',
        '}',
        'export declare function Button(props: ButtonProps): JSX.Element;',
      ].join('\n'),
    )

    const result = generateStudioProjectGuide(dir)
    expect(result.written).toContain('.claude/design-system-components.md')

    const guide = read(dir, 'CLAUDE.md')
    expect(guide).toContain('## Use `js-ui-kit` — always')
    // No decision map exists for a bare `.d.ts` — the catalog fallback must
    // degrade to a plain name list, never invent an intent-level mapping.
    expect(guide).toContain('### What exists')
    expect(guide).not.toContain('### Which component')
    // The runtime catalog is queryable even though this file is generated
    // once per turn — the explicit A5 ask.
    expect(guide).toContain('studio_list_components')
    expect(guide).toContain('studio_find_component')

    const components = read(dir, '.claude/design-system-components.md')
    expect(components).toContain('### Button')
    // The real enum, extracted from the real union type — not the ALM
    // constant, and not a guessed shape.
    expect(components).toContain("enum ('primary' | 'ghost' | 'danger')")
    expect(components).toContain('`label` — string')
  })

  it('degrades honestly for an untyped component: the name is known, its props are not', () => {
    // `js-ui-kit-untyped` satisfies `detectComponentPackages`'s BUILT-JS-ENTRY
    // tier (imports the JSX runtime, exports a PascalCase binding) so it is a
    // real `componentPackages` entry, but its `.tsx` SOURCE — the only thing
    // `buildPackageManifest` can read here (no `.d.ts` at all) — declares no
    // prop types. This must read as "names known, types unknown", never a
    // fabricated prop list.
    write(
      dir,
      'package.json',
      JSON.stringify({ name: 'p', dependencies: { 'js-ui-kit-untyped': '1.0.0' } }),
    )
    write(
      dir,
      'node_modules/js-ui-kit-untyped/package.json',
      JSON.stringify({ name: 'js-ui-kit-untyped', main: 'dist/index.js', source: 'src/index.tsx' }),
    )
    write(
      dir,
      'node_modules/js-ui-kit-untyped/dist/index.js',
      "import { jsx as _jsx } from 'react/jsx-runtime';\nexport function Card() { return _jsx('div', {}); }\n",
    )
    write(
      dir,
      'node_modules/js-ui-kit-untyped/src/index.tsx',
      'export function Card(props) {\n  return null\n}\n',
    )

    const result = generateStudioProjectGuide(dir)
    expect(result.written).toContain('.claude/design-system-components.md')

    const guide = read(dir, 'CLAUDE.md')
    expect(guide).toContain('## Use `js-ui-kit-untyped` — always')

    const components = read(dir, '.claude/design-system-components.md')
    expect(components).toContain('### Card')
    // No prop line at all — never a stubbed/guessed prop shape for an
    // untyped export.
    expect(components).not.toMatch(/^- `.+` —/m)
  })

  it('tells the agent a design system exists even when its API could not be generated at all', () => {
    // Neither a `.d.ts` nor a `.tsx`/`.jsx` source entry, and no agent docs —
    // the honest "nothing static was readable" case. Must not read as "no
    // design system" (false — a real, importable package IS installed), and
    // must not silently omit the design-system section either.
    write(
      dir,
      'package.json',
      JSON.stringify({ name: 'p', dependencies: { 'bundled-only-kit': '1.0.0' } }),
    )
    write(
      dir,
      'node_modules/bundled-only-kit/package.json',
      JSON.stringify({ name: 'bundled-only-kit', main: 'dist/index.js' }),
    )
    write(
      dir,
      'node_modules/bundled-only-kit/dist/index.js',
      "import { jsx as _jsx } from 'react/jsx-runtime';\nexport function Tag() { return _jsx('span', {}); }\n",
    )

    const result = generateStudioProjectGuide(dir)
    expect(result.written).not.toContain('.claude/design-system-components.md')

    const guide = read(dir, 'CLAUDE.md')
    expect(guide).toContain('bundled-only-kit')
    expect(guide).toContain('could not be generated')
    expect(guide).toContain('studio_list_components')
  })
})
