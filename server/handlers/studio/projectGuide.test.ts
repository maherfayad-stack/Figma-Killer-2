/**
 * projectGuide — gates for what Studio writes into a user's project, and (just
 * as important) what it refuses to overwrite.
 *
 * Exercised against real temp directories, never the real `claude` binary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateStudioProjectGuide } from './projectGuide'
import { buildDesignSystemGuide, renderComponentReference, renderIconReference } from './designSystemGuide'
import { readStudioMeta } from './studioMeta'

function write(root: string, relPath: string, contents: string): void {
  const full = join(root, ...relPath.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

function read(root: string, relPath: string): string {
  return readFileSync(join(root, ...relPath.split('/')), 'utf8')
}

/**
 * The policy the generated `CLAUDE.md` used to state. Every entry is a line
 * that shipped, and most contradict at least one design policy or fidelity
 * mode the user can pick (audit 06, AI-1).
 */
const POLICY_STATEMENTS = [
  '— always',
  'There is no third',
  'no third option',
  'Never hardcode',
  'Never introduce a second styling system',
  'Never draw an icon yourself',
  'Never hand-roll',
  'Do not ask before building',
  'Never report a screen as done',
  'Reply in one or two sentences',
  '## Building a screen',
  '## Writing the component',
  '## Verifying',
  '## Assets you do not have',
  '## What you cannot do here',
]

function assertFactsOnly(guide: string): void {
  for (const statement of POLICY_STATEMENTS) expect(guide).not.toContain(statement)
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

    it('wires the PreToolUse(Write|Edit) control-plane refusal — the security-load-bearing one (sec-12)', () => {
      // Without this hook the agent's native Write reaches `.studio/meta.json`
      // and can promote its own project to Tier 2, which is exactly the
      // consent A10's second gate reads. See `agentWriteScope.ts`.
      generateStudioProjectGuide(dir)
      const settings = JSON.parse(read(dir, '.claude/settings.local.json')) as {
        hooks: { PreToolUse?: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
      }
      const preToolUse = settings.hooks.PreToolUse?.[0]
      expect(preToolUse, 'no PreToolUse hook — nothing stops a native write into .studio/').toBeDefined()
      expect(preToolUse!.matcher).toBe('Write|Edit')
      expect(preToolUse!.hooks[0]!.command).toContain(process.execPath)
      expect(preToolUse!.hooks[0]!.command).toContain('denyControlPlaneWrite.ts')
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
    /**
     * A manifest on disk from an older generator, without a sweep record — the
     * state of a project Studio generated a guide in before. The sweep only
     * ever runs there (security review of #233, F7): on a project with no
     * manifest nothing under these names is Studio's.
     */
    function studioGeneratedBefore(files: Record<string, { hash: string; size: number; mtimeMs: number }> = {}): void {
      write(dir, '.claude/.studio-generated.json', JSON.stringify({ files }))
    }

    it('deletes guides a previous generator version wrote and this one does not', () => {
      studioGeneratedBefore()
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
      studioGeneratedBefore()
      write(dir, '.claude/figma.md', '# Figma asset workflow\n')
      const result = generateStudioProjectGuide(dir)
      expect(result.pruned).toEqual(['.claude/figma.md'])
    })

    it('sweeps once, then never again — a file the user later creates is theirs', () => {
      studioGeneratedBefore()
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
      studioGeneratedBefore()
      write(dir, '.claude/figma.md', '# Figma asset workflow\n')
      expect(generateStudioProjectGuide(dir).pruned).toEqual(['.claude/figma.md'])

      const second = mkdtempSync(join(tmpdir(), 'studio-guide-2nd-'))
      try {
        write(second, 'package.json', JSON.stringify({ name: 'p2', dependencies: {} }))
        write(second, 'pages/Home.tsx', 'export default function Home() {\n  return <main />\n}\n')
        write(second, '.claude/.studio-generated.json', JSON.stringify({ files: {} }))
        write(second, '.claude/figma.md', '# Figma asset workflow\n')
        expect(generateStudioProjectGuide(second).pruned).toEqual(['.claude/figma.md'])
      } finally {
        rmSync(second, { recursive: true, force: true })
      }
    })

    // Security review of #233, F7: the names are generic, so a name alone is
    // never proof that Studio wrote the file.
    it("never sweeps an imported repository's own .claude files — no manifest, nothing of Studio's", () => {
      write(dir, '.claude/agents/design-critic.md', '# Our own design critic\n')
      write(dir, '.claude/figma.md', '# Our Figma notes\n')
      const result = generateStudioProjectGuide(dir)
      expect(result.pruned).toEqual([])
      expect(read(dir, '.claude/agents/design-critic.md')).toBe('# Our own design critic\n')
      expect(read(dir, '.claude/figma.md')).toBe('# Our Figma notes\n')
      // Recorded as swept all the same, so a later turn cannot delete them either.
      expect(generateStudioProjectGuide(dir).pruned).toEqual([])
      expect(existsSync(join(dir, '.claude/figma.md'))).toBe(true)
    })

    it('where the manifest still holds the hash Studio wrote, only an unedited file is swept', () => {
      const studioWrote = '# screen-builder\n'
      const hash = createHash('sha256').update(studioWrote, 'utf8').digest('hex')
      studioGeneratedBefore({
        '.claude/agents/screen-builder.md': { hash, size: 0, mtimeMs: 0 },
        '.claude/agents/design-critic.md': { hash, size: 0, mtimeMs: 0 },
      })
      write(dir, '.claude/agents/screen-builder.md', studioWrote)
      write(dir, '.claude/agents/design-critic.md', '# edited by the user\n')
      const result = generateStudioProjectGuide(dir)
      expect(result.pruned).toEqual(['.claude/agents/screen-builder.md'])
      expect(read(dir, '.claude/agents/design-critic.md')).toBe('# edited by the user\n')
    })
  })

  describe('never through a link (security review of #233, F7)', () => {
    it('a .claude junction out of the project gets no guide file, no hook settings and no manifest', () => {
      const outside = mkdtempSync(join(tmpdir(), 'studio-guide-outside-'))
      try {
        symlinkSync(outside, join(dir, '.claude'), 'junction')
        generateStudioProjectGuide(dir)
        expect(readdirSync(outside)).toEqual([])
      } finally {
        rmdirSync(join(dir, '.claude'))
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('a legacy artefact reached through a .claude junction is never deleted', () => {
      const outside = mkdtempSync(join(tmpdir(), 'studio-guide-outside-'))
      try {
        writeFileSync(join(outside, 'figma.md'), '# not the project\'s\n')
        writeFileSync(join(outside, '.studio-generated.json'), JSON.stringify({ files: {} }))
        symlinkSync(outside, join(dir, '.claude'), 'junction')
        expect(generateStudioProjectGuide(dir).pruned).toEqual([])
        expect(existsSync(join(outside, 'figma.md'))).toBe(true)
      } finally {
        rmdirSync(join(dir, '.claude'))
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  it('names the real conventions of this project', () => {
    generateStudioProjectGuide(dir)
    const guide = read(dir, 'CLAUDE.md')
    expect(guide).toContain('pages/')
    expect(guide).toContain('.tsx')
    expect(guide).toContain('CSS Modules')
  })

  it('states facts only — policy belongs to the system prompt, and would contradict it here', () => {
    // AI-1: this file used to tell the agent "Use <ds> — always … There is no
    // third option" on the same turn the prompt said the design policy was
    // FREE. The workflow, the definition of done and every rule now arrive
    // with the system prompt, which reaches the CLI.
    generateStudioProjectGuide(dir)
    assertFactsOnly(read(dir, 'CLAUDE.md'))
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
    // cleared — stayed permanently empty: no design system on disk, so
    // `design-system-components.md` never generated, while `CLAUDE.md` told
    // the agent to read it. Observed exactly that way, twice.
    //
    // DS-2 changed WHAT the heal writes: a `package.json` with no
    // design-system dependency, plus the `designSystem: 'alm'` mark that makes
    // Studio maintain the project's own `design-system/` folder from here on.
    // The folder itself needs Studio's vendored copy, which DS-1 adds — so on
    // a checkout without `vendor/alm-design-system/` the mark is written and
    // the folder is not, which is exactly the degrade-honestly behaviour
    // `ensureDesignSystemFiles` promises.
    rmSync(join(dir, 'package.json'))
    expect(existsSync(join(dir, 'package.json'))).toBe(false)

    generateStudioProjectGuide(dir)

    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(read(dir, 'package.json')).not.toContain('alm-design')
    expect(readStudioMeta(dir).designSystem).toBe('alm')
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

  /**
   * DS-3 — the BUILT-IN design system is not a package and has no specifier
   * that is true everywhere: it lives in a folder at the project root, so each
   * file spells it by its own distance from there. The generator used to print
   * the npm name, which now resolves to nothing from anywhere — and an agent
   * follows a generated import line literally.
   */
  it('teaches a RELATIVE folder import for the built-in design system, never a package name', () => {
    const contract = buildDesignSystemGuide(pkgDir, 'alm', { kind: 'folder', dirName: 'design-system' })!.importContract!
    expect(contract).toContain("from '../design-system'")
    expect(contract).toContain("'../../design-system'") // the rule, not just one example
    expect(contract).not.toContain("from '@scope/ds'")
    expect(contract).not.toContain("from 'alm'")
    // The folder's index loads its own token CSS — no separate import to write.
    expect(contract).not.toContain("import '")
  })

  it('tells the agent the folder is Studio-managed, so it is read but never hand-edited', () => {
    const contract = buildDesignSystemGuide(pkgDir, 'alm', { kind: 'folder', dirName: 'design-system' })!.importContract!
    expect(contract).toContain('never hand-edit')
  })

  it('does not hand out per-file icon paths for the built-in system, because the project has only a few of them', () => {
    // Studio ships 568 SVGs; a project's copy carries the ~20 its own
    // components import. Printing all of them as importable paths would be an
    // instruction that fails on almost every one.
    mkdirSync(join(pkgDir, 'src', 'icons', 'line-icons'), { recursive: true })
    writeFileSync(join(pkgDir, 'src', 'icons', 'line-icons', 'wifi.svg'), '<svg/>', 'utf8')
    const guide = buildDesignSystemGuide(pkgDir, 'alm', { kind: 'folder', dirName: 'design-system' })!
    const rendered = renderIconReference(guide)!
    expect(rendered).toContain('inline them, do not import them')
    expect(rendered).toContain('wifi')
    expect(rendered).not.toContain('?raw')
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

  it('renders a reference that names each component as a real export, and leaves policy to the prompt', () => {
    const rendered = renderComponentReference(buildDesignSystemGuide(pkgDir, '@scope/ds')!)
    expect(rendered).toContain('### Button')
    expect(rendered).toContain("real named export of `@scope/ds`")
    // "Import it — do not re-implement it" contradicted a FREE design policy.
    expect(rendered).not.toContain('do not re-implement')
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
    expect(guide).toContain('## The design system: `js-ui-kit`')
    assertFactsOnly(guide)
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
    expect(guide).toContain('## The design system: `js-ui-kit-untyped`')
    assertFactsOnly(guide)

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

/**
 * `parser-13` — the design system a user installed can be a CRLF checkout, and
 * a heading regex anchored with `$` matches NOTHING in one. That exact failure
 * emptied Studio's OWN vendored manifest (`STATE.md` `server-24`); this is the
 * same bug one directory over, in a package Studio does not control.
 *
 * The doc's bytes are written by the test, LF twin and CRLF twin, because this
 * repository's working tree is CRLF-converted by Git on checkout.
 */
describe('buildDesignSystemGuide against a CRLF-checked-out package', () => {
  const CLAUDE_MD_LINES = [
    '# Kit',
    '',
    '## Components',
    '',
    '### Panel',
    '',
    '```jsx',
    '<Panel tone="quiet" />',
    '```',
    '',
    '### Ribbon',
    '',
    '```jsx',
    '<Ribbon label="New" />',
    '```',
  ]
  const DESIGN_MD_LINES = [
    '# Kit intent',
    '',
    '## Component Decision Map',
    '',
    '| I want to… | Use |',
    '|---|---|',
    '| Group related controls | `Panel` |',
    '',
    '## Panel',
    '',
    'Panels group related controls.',
  ]

  function buildPackage(eol: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'studio-ds-eol-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/kit', main: './dist/index.js' }), 'utf8')
    writeFileSync(join(dir, 'CLAUDE.md'), CLAUDE_MD_LINES.join(eol), 'utf8')
    writeFileSync(join(dir, 'design.md'), DESIGN_MD_LINES.join(eol), 'utf8')
    return dir
  }

  it('reads the same guide out of a CRLF package as out of its LF twin', () => {
    const lfDir = buildPackage('\n')
    const crlfDir = buildPackage('\r\n')
    try {
      const lf = buildDesignSystemGuide(lfDir, '@scope/kit')!
      const crlf = buildDesignSystemGuide(crlfDir, '@scope/kit')!

      expect(crlf.components.map((c) => c.name)).toEqual(['Panel', 'Ribbon'])
      expect(crlf.components.map((c) => c.name)).toEqual(lf.components.map((c) => c.name))
      expect(crlf.components[0]!.summary).toBe('Panels group related controls.')
      expect(crlf.decisionMap).toContain('`Panel`')
      // No `\r` may survive into text the agent is shown.
      expect(JSON.stringify(crlf)).not.toContain('\\r')
    } finally {
      rmSync(lfDir, { recursive: true, force: true })
      rmSync(crlfDir, { recursive: true, force: true })
    }
  })
})
