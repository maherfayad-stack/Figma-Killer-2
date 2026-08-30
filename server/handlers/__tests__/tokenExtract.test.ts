/**
 * tokenExtract.ts — `tokens-01` coverage.
 *
 * The main fixture below deliberately shares NOTHING with the eSIM corpus
 * (`--brand-*`/`--gap-*`/`--radius-*`/`--fs-*`, not `--color-*`/`--space-*`/
 * `--type-*`) — same discipline `genericRepoShapes.test.ts` documents: a
 * classifier grown against one corpus's naming habits risks encoding them.
 * `probeProject` runs for real against each fixture (never a hand-typed
 * `ProjectProfile` stand-in), matching `styleCompile.test.ts`'s precedent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { probeProject } from '../studio/projectProbe'
import { readStudioFrameworkFile, writeStudioFrameworkFile } from '../studioFramework'
import {
  extractProjectTokens,
  mergeExtractedFramework,
  tryServeStudioTokens,
} from '../studio/tokenExtract'
import type { ProjectProfile } from '../studio/projectProfileSchema'
import type { FrameworkSettings } from '@core/framework-schema'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-extract-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function writePackageJson(deps: Record<string, string> = {}): void {
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: deps }))
}

// ---------------------------------------------------------------------------
// Source 1 — project's own compiled CSS (`:root` custom properties)
// ---------------------------------------------------------------------------

describe('extractProjectTokens — project-css source, a corpus sharing nothing with eSIM', () => {
  it('groups colors by prefix, resolves var() indirection + dark values, builds one spacing group per prefix, and reports unclassifiable values', async () => {
    // A `.module.css` file is Tier 0 (no trust promotion) and its `:root`
    // block passes through `compileProjectStyles`'s CSS-Modules renamer
    // UNCHANGED (only `.class` selectors are rewritten) — the real path
    // `compileProjectStyles`'s `.css` output reaches this module through.
    write(
      'design/tokens.module.css',
      [
        ':root {',
        '  --brand-primary: #3366ff;',
        '  --brand-secondary: var(--brand-primary);', // indirection — must resolve
        '  --gap-sm: 4px;',
        '  --gap-md: 8px;',
        '  --gap-lg: 16px;',
        '  --radius-sm: 4px;',
        '  --fs-base: 16px;', // NOT `--font*`/`--text*`/`--type*` — unclassifiable by name
        '  --fs-lg: 20px;',
        '  --size-full: 100%;', // spacing-family name, non-length value — unclassifiable
        '}',
        ':root[data-theme=dark] {',
        '  --brand-primary: #7799ff;',
        '}',
        '.card { color: var(--brand-primary); }',
      ].join('\n'),
    )

    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.cssModules).toBe(true)

    const result = await extractProjectTokens(tmpDir, profile)

    expect(result.source).toBe('project-css')
    expect(result.counts).toEqual({ colors: 2, spacing: 4, typography: 0 })

    const bySlug = new Map(result.framework.colors.tokens.map((t) => [t.slug, t]))
    expect(bySlug.get('brand-primary')?.lightValue).toBe('#3366ff')
    expect(bySlug.get('brand-primary')?.darkValue).toBe('#7799ff')
    expect(bySlug.get('brand-primary')?.darkModeEnabled).toBe(true)
    expect(bySlug.get('brand-primary')?.category).toBe('brand')
    // Resolved THROUGH the indirection, not left as the literal `var(...)` text.
    expect(bySlug.get('brand-secondary')?.lightValue).toBe('#3366ff')
    // ...and the indirection is resolved in the DARK scope too. This assertion
    // used to read `darkModeEnabled === false`, on the reasoning that "no dark
    // override was declared for this one, so don't fabricate one". That
    // confused "the dark block names this token" with "this token resolves
    // differently in dark", and the difference is the whole of a design
    // system's semantic layer: `--brand-secondary: var(--brand-primary)` IS
    // #7799ff under `[data-theme=dark]` in any browser. Treating that as
    // "no dark value" imported a light literal that then shadowed the
    // package's own dark palette — see `board-08` in `STATE.md`.
    expect(bySlug.get('brand-secondary')?.darkValue).toBe('#7799ff')
    expect(bySlug.get('brand-secondary')?.darkModeEnabled).toBe(true)

    const spacingGroups = result.framework.spacing?.groups ?? []
    const gapGroup = spacingGroups.find((g) => g.namingConvention === 'gap')
    const radiusGroup = spacingGroups.find((g) => g.namingConvention === 'radius')
    expect(gapGroup?.manualSizes.map((s) => s.min).sort((a, b) => a - b)).toEqual([4, 8, 16])
    expect(radiusGroup?.manualSizes).toHaveLength(1)
    expect(radiusGroup?.manualSizes[0]?.min).toBe(4)

    // `--fs-*` (not font/text/type) and `--size-full` (not a length) never
    // guessed into a family.
    expect(result.framework.typography).toBeUndefined()
    const unclassifiedWarning = result.warnings.find((w) => w.code === 'unclassified-tokens-skipped')
    expect(unclassifiedWarning?.message).toContain('3 ') // fs-base, fs-lg, size-full
  })

  it('builds a typography size ladder from `--type-*-size` style names, separate from family/weight/line-height detail', async () => {
    write(
      'design/type.module.css',
      [
        ':root {',
        '  --type-display-size: 34px;',
        '  --type-display-weight: 600;',
        '  --type-display-family: "Custom Sans", sans-serif;',
        '  --type-body-size: 14px;',
        '  --type-body-lh: 20px;',
        '}',
      ].join('\n'),
    )

    const profile = probeProject(tmpDir)
    const result = await extractProjectTokens(tmpDir, profile)

    expect(result.counts.typography).toBe(2)
    const group = result.framework.typography?.groups[0]
    expect(group?.namingConvention).toBe('type')
    const stepNames = group?.manualSizes.map((s) => s.name).sort()
    expect(stepNames).toEqual(['body', 'display'])

    // Family/weight/line-height are real, counted, but NOT invented into the
    // group shape (no field for them there) — reported honestly instead.
    const detailWarning = result.warnings.find((w) => w.code === 'typography-detail-not-mapped')
    expect(detailWarning?.message).toContain('3 ') // weight, family, lh
  })
})

// ---------------------------------------------------------------------------
// Source 2 — Tailwind theme fallback (static read only)
// ---------------------------------------------------------------------------

describe('extractProjectTokens — tailwind-theme source', () => {
  it('reads theme.extend colors/spacing/fontSize from the config file, without executing it', async () => {
    writePackageJson({ tailwindcss: '^3.4.0' })
    write(
      'tailwind.config.js',
      [
        '/** @type {import("tailwindcss").Config} */',
        'module.exports = {',
        '  content: ["./src/**/*.{js,jsx}"],',
        '  theme: {',
        '    extend: {',
        '      colors: {',
        "        primary: '#0ea5e9',",
        '        accent: { 500: \'#f59e0b\', 700: \'#b45309\' },',
        '      },',
        '      spacing: {',
        "        '18': '4.5rem',",
        '      },',
        '      fontSize: {',
        "        tiny: '10px',",
        "        base: '16px',",
        '      },',
        '    },',
        '  },',
        '  plugins: [],',
        '}',
        '',
      ].join('\n'),
    )

    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.tailwind).not.toBeNull()

    const result = await extractProjectTokens(tmpDir, profile)

    expect(result.source).toBe('tailwind-theme')
    const bySlug = new Map(result.framework.colors.tokens.map((t) => [t.slug, t]))
    expect(bySlug.get('primary')?.lightValue).toBe('#0ea5e9')
    expect(bySlug.get('accent-500')?.lightValue).toBe('#f59e0b')
    expect(bySlug.get('accent-700')?.lightValue).toBe('#b45309')

    const spacing = result.framework.spacing?.groups[0]?.manualSizes.map((s) => s.min)
    expect(spacing).toContain(4.5 * 16) // '4.5rem' -> px, 16px root assumption

    const typography = result.framework.typography?.groups[0]?.manualSizes
    expect(typography?.some((s) => s.min === 10)).toBe(true)
    expect(typography?.some((s) => s.min === 16)).toBe(true)

    // Tier 1 never ran at the default Tier 0 trust — this is a genuinely
    // different (static, no-execution) path, and the propagated warning
    // proves it never silently promoted anything.
    expect(result.warnings.some((w) => w.code === 'style-toolchain-requires-trust-promotion')).toBe(true)
  })

  it('resolves a NESTED tailwind config path with OS-correct separators (Windows path-join safety)', async () => {
    const profile = probeProject(tmpDir)
    const nestedProfile: ProjectProfile = {
      ...profile,
      styleToolchain: {
        ...profile.styleToolchain,
        tailwind: { version: '3.4.0', configPath: 'config/build/tailwind.config.js' },
      },
    }
    write(
      'config/build/tailwind.config.js',
      'module.exports = { theme: { extend: { colors: { nested: "#123456" } } } }\n',
    )

    const result = await extractProjectTokens(tmpDir, nestedProfile)
    expect(result.source).toBe('tailwind-theme')
    expect(result.framework.colors.tokens.map((t) => t.slug)).toContain('nested')
  })
})

// ---------------------------------------------------------------------------
// No tokens anywhere — honest, not fabricated
// ---------------------------------------------------------------------------

describe('extractProjectTokens — nothing found', () => {
  it('returns an empty result with a clear warning, never a fabricated default', async () => {
    write('src/App.tsx', 'export default function App() { return null }\n')

    const profile = probeProject(tmpDir)
    const result = await extractProjectTokens(tmpDir, profile)

    expect(result.source).toBe('none')
    expect(result.counts).toEqual({ colors: 0, spacing: 0, typography: 0 })
    expect(result.framework.colors.tokens).toEqual([])
    expect(result.framework.typography).toBeUndefined()
    expect(result.framework.spacing).toBeUndefined()
    expect(result.warnings.some((w) => w.code === 'no-design-tokens-found')).toBe(true)
  })

  it('points at dependency install, not a generic message, when the reason is an unresolved vendor CSS import', async () => {
    writePackageJson({ '@acme/ui': '^1.0.0' })
    write('src/main.tsx', "import '@acme/ui/dist/style.css'\n")
    // No node_modules — vendor CSS cannot be resolved.

    const profile = probeProject(tmpDir)
    const result = await extractProjectTokens(tmpDir, profile)

    expect(result.source).toBe('none')
    const finding = result.warnings.find((w) => w.code === 'no-design-tokens-found')
    expect(finding?.fix).toContain('install')
  })
})

// ---------------------------------------------------------------------------
// mergeExtractedFramework — never clobber
// ---------------------------------------------------------------------------

describe('mergeExtractedFramework', () => {
  it('replaces an EMPTY family, but leaves a non-empty one untouched — whole-family granularity, same precedent as mergeStudioMeta', () => {
    const existing: FrameworkSettings = {
      colors: {
        tokens: [
          {
            id: 'user-1',
            category: '',
            slug: 'hand-picked',
            lightValue: '#000000',
            darkValue: '',
            darkModeEnabled: false,
            generateUtilities: { text: true, background: true, border: true, fill: false },
            generateTransparent: true,
            generateShades: { enabled: true, count: 4 },
            generateTints: { enabled: true, count: 4 },
            order: 0,
            createdAt: 123,
            updatedAt: 123,
          },
        ],
      },
      // typography/spacing intentionally absent — empty families.
    }
    const extracted: FrameworkSettings = {
      colors: { tokens: [{ ...existing.colors.tokens[0]!, id: 'extracted-1', slug: 'should-not-appear' }] },
      typography: {
        groups: [
          {
            id: 'g1', name: 'Type', namingConvention: 'type',
            min: { fontSize: 14, scaleRatio: 1.125 }, max: { fontSize: 34, scaleRatio: 1.333 },
            steps: 'body,display', baseScaleIndex: 0, mode: 'fluid_manual',
            manualSizes: [{ id: 's1', name: 'body', min: 14, max: 14 }],
            order: 0, createdAt: 0, updatedAt: 0,
          },
        ],
      },
    }

    const merged = mergeExtractedFramework(existing, extracted)

    // Colors already had real data — untouched, byte for byte.
    expect(merged.colors.tokens).toEqual(existing.colors.tokens)
    // Typography was empty — filled from the extraction.
    expect(merged.typography?.groups[0]?.namingConvention).toBe('type')
  })

  it('fills every family when nothing was persisted yet (existing === null)', () => {
    const extracted: FrameworkSettings = { colors: { tokens: [] } }
    expect(mergeExtractedFramework(null, extracted)).toEqual(extracted)
  })
})

// ---------------------------------------------------------------------------
// Route — tryServeStudioTokens (GET never writes, POST merges + persists)
// ---------------------------------------------------------------------------

describe('tryServeStudioTokens', () => {
  function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
    const url = new URL(`http://localhost${pathAndQuery}`)
    const req = new Request(url, init)
    return { req, url, pathname: url.pathname }
  }

  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/other')
    expect(await tryServeStudioTokens(req, url, pathname)).toBeNull()
  })

  it('GET previews without writing framework.json', async () => {
    write('design/tokens.module.css', ':root { --accent: #ff0055; }\n')

    const { req, url, pathname } = makeRequest(`/admin/api/studio/tokens?dir=${encodeURIComponent(tmpDir)}`)
    const res = await tryServeStudioTokens(req, url, pathname)
    expect(res).not.toBeNull()
    const body = (await res!.json()) as { source: string; counts: { colors: number } }
    expect(body.source).toBe('project-css')
    expect(body.counts.colors).toBe(1)
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'framework.json'))).toBe(false)
  })

  it('POST merges + persists, and a SECOND POST preserves what the first extraction (now "existing data") already wrote — user edits made in between are never clobbered', async () => {
    write('design/tokens.module.css', ':root { --accent: #ff0055; --space-md: 12px; }\n')

    const { req: req1, url: url1, pathname: p1 } = makeRequest('/admin/api/studio/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: tmpDir }),
    })
    const res1 = await tryServeStudioTokens(req1, url1, p1)
    expect(res1).not.toBeNull()
    const body1 = (await res1!.json()) as { framework: FrameworkSettings }
    expect(body1.framework.colors.tokens).toHaveLength(1)
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'framework.json'))).toBe(true)

    // Simulate a user hand-editing the persisted colors in the panel.
    const onDisk = readStudioFrameworkFile(tmpDir)!
    const edited: FrameworkSettings = {
      ...onDisk,
      colors: { tokens: [{ ...onDisk.colors.tokens[0]!, lightValue: '#USER-EDITED' }] },
    }
    writeStudioFrameworkFile(tmpDir, edited)

    const { req: req2, url: url2, pathname: p2 } = makeRequest('/admin/api/studio/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: tmpDir }),
    })
    const res2 = await tryServeStudioTokens(req2, url2, p2)
    const body2 = (await res2!.json()) as { framework: FrameworkSettings }
    // Colors already had data (the user's edit) — a second extraction must
    // not overwrite it back to the freshly-scanned value.
    expect(body2.framework.colors.tokens[0]?.lightValue).toBe('#USER-EDITED')

    const finalOnDisk = readStudioFrameworkFile(tmpDir)!
    expect(finalOnDisk.colors.tokens[0]?.lightValue).toBe('#USER-EDITED')
  })
})
