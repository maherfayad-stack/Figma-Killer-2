/**
 * designSystemDigest — the seventh generated reference file. Covers: all
 * five token families (colors, typography, spacing, radius, elevation — the
 * last two `FrameworkSettings` has no home for at all), the one-line-per-
 * component index never silently dropping a variant, the content-hash cache,
 * and graceful degradation (no design system, unreadable files, CSS noise
 * that looks like a class selector but isn't).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDesignSystemDigest, designSystemCacheFileExists, getOrBuildDesignSystemDigest } from './designSystemDigest'
import type { DesignSystemRef } from './projectProfileSchema'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'design-system-digest-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = join(dir, ...relPath.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents)
  return full
}

const IMPORTED_ROOT = 'styles/imported/fixture-ds'

function importedRef(): DesignSystemRef[] {
  return [{ name: 'fixture-ds', source: 'imported', root: IMPORTED_ROOT }]
}

describe('buildDesignSystemDigest', () => {
  it('returns undefined when there are no design systems', () => {
    expect(buildDesignSystemDigest(dir, [])).toBeUndefined()
  })

  it('returns undefined when a design system root has no readable .css file', () => {
    write(`${IMPORTED_ROOT}/README.md`, '# not css')
    expect(buildDesignSystemDigest(dir, importedRef())).toBeUndefined()
  })

  it('classifies colors, spacing, and typography sizes via the shared tokenExtractCssScan engine', () => {
    write(
      `${IMPORTED_ROOT}/tokens.css`,
      `:root {
        --color-aqua-100: #0C9AB0;
        --background-primary-default: var(--color-aqua-100);
        --space-sm: 8px;
        --type-body-size: 14px;
      }`,
    )
    const digest = buildDesignSystemDigest(dir, importedRef())!
    expect(digest).toContain('## Colors (2 tokens)')
    expect(digest).toContain('color(1)')
    expect(digest).toContain('background(1)')
    expect(digest).toContain('--space-sm: 8px')
    expect(digest).toContain('--type-body-size: 14px')
  })

  // ── The two families FrameworkSettings has no home for ───────────────────
  it('classifies --rounded-*/--radius-* tokens as a Radius family (classifyDeclaration alone would call these unclassified)', () => {
    write(`${IMPORTED_ROOT}/tokens.css`, `:root { --rounded-sm: 8px; --radius-lg: 16px; }`)
    const digest = buildDesignSystemDigest(dir, importedRef())!
    expect(digest).toContain('## Radius (2 tokens)')
    expect(digest).toContain('--rounded-sm: 8px')
    expect(digest).toContain('--radius-lg: 16px')
  })

  it('classifies --elevation-*/--*-shadow tokens as an Elevation family by name, not value (a shadow shorthand never passes the color check)', () => {
    write(
      `${IMPORTED_ROOT}/tokens.css`,
      `:root { --elevation-floating: 0px -4px 16px rgba(0, 0, 0, 0.08); --card-shadow: 0 2px 8px rgba(0,0,0,0.1); }`,
    )
    const digest = buildDesignSystemDigest(dir, importedRef())!
    expect(digest).toContain('## Elevation / shadow (2 tokens)')
    expect(digest).toContain('--elevation-floating')
    expect(digest).toContain('--card-shadow')
  })

  it('counts a genuinely unclassifiable declaration rather than guessing', () => {
    write(`${IMPORTED_ROOT}/tokens.css`, `:root { --liquid-glass-filter: blur(20px) saturate(1.8); }`)
    const digest = buildDesignSystemDigest(dir, importedRef())!
    expect(digest).toContain('1 other custom properties were found but did not fit any family above')
  })

  // ── Component index — never silently drop a variant ──────────────────────
  it('lists every BEM modifier variant found for a block, not just a sample', () => {
    write(
      `${IMPORTED_ROOT}/Button.css`,
      `.btn { display: flex; }
       .btn--primary { color: red; }
       .btn--secondary { color: blue; }
       .btn--size-small { padding: 4px; }
       .btn__icon { width: 16px; }`,
    )
    const digest = buildDesignSystemDigest(dir, importedRef())!
    expect(digest).toContain('## Components (1)')
    expect(digest).toContain('.btn — variants: --primary, --secondary, --size-small')
    expect(digest).toContain(`${IMPORTED_ROOT}/Button.css`)
    // The element class must never be mistaken for its own block or a variant.
    expect(digest).not.toContain('.btn__icon —')
    expect(digest).not.toMatch(/variants:[^\n]*__icon/)
  })

  it('does not mint a fake block from a filename mentioned in a comment or an @import statement', () => {
    write(
      `${IMPORTED_ROOT}/index.css`,
      `@import './Button.css';
       /* see Button.css for the base styles */
       body { margin: 0; }`,
    )
    write(`${IMPORTED_ROOT}/Button.css`, `.btn { display: flex; }`)
    const digest = buildDesignSystemDigest(dir, importedRef())!
    expect(digest).not.toContain('.css —')
  })

  it('indexes components correctly even when every component is bundled into ONE css file (a real npm package\'s dist/index.css shape)', () => {
    write(
      `${IMPORTED_ROOT}/dist/index.css`,
      `:root { --rounded-sm: 8px; }
       .btn { display: flex; }
       .btn--primary { color: red; }
       .badge { display: inline; }
       .badge--new { color: green; }`,
    )
    const digest = buildDesignSystemDigest(dir, importedRef())!
    expect(digest).toContain('## Components (2)')
    expect(digest).toContain('.btn — variants: --primary')
    expect(digest).toContain('.badge — variants: --new')
    expect(digest).toContain('## Radius (1 tokens)')
  })

  it('discovers css under a dist/ folder — the real corpus\'s only shape for a bundled node_modules install (listWorkspaceFiles would skip it)', () => {
    write(`${IMPORTED_ROOT}/dist/index.css`, `:root { --space-sm: 8px; }`)
    const digest = buildDesignSystemDigest(dir, importedRef())
    expect(digest).toBeDefined()
    expect(digest).toContain('--space-sm: 8px')
  })

  it('merges CSS from more than one design system in one digest', () => {
    write(`${IMPORTED_ROOT}/tokens.css`, `:root { --space-sm: 8px; }`)
    write('node_modules/acme-ui/dist/index.css', `:root { --rounded-sm: 8px; } .card { display: block; }`)
    const refs: DesignSystemRef[] = [...importedRef(), { name: 'acme-ui', source: 'node-modules', root: 'node_modules/acme-ui' }]
    const digest = buildDesignSystemDigest(dir, refs)!
    expect(digest).toContain('--space-sm: 8px')
    expect(digest).toContain('--rounded-sm: 8px')
    expect(digest).toContain('.card')
    expect(digest).toContain('acme-ui')
  })
})

describe('getOrBuildDesignSystemDigest — content-hash cache', () => {
  it('returns undefined and writes no cache file when there are no design systems', () => {
    expect(getOrBuildDesignSystemDigest(dir, [])).toBeUndefined()
    expect(designSystemCacheFileExists(dir, [])).toBe(false)
  })

  it('writes a cache file on first build and reuses it on the next call with unchanged inputs', () => {
    write(`${IMPORTED_ROOT}/tokens.css`, `:root { --space-sm: 8px; }`)
    const refs = importedRef()

    const first = getOrBuildDesignSystemDigest(dir, refs)
    expect(first).toBeDefined()
    expect(designSystemCacheFileExists(dir, refs)).toBe(true)

    const second = getOrBuildDesignSystemDigest(dir, refs)
    expect(second).toBe(first!)
  })

  it('regenerates when the underlying CSS file changes (different mtime -> different cache key)', () => {
    const file = write(`${IMPORTED_ROOT}/tokens.css`, `:root { --space-sm: 8px; }`)
    const refs = importedRef()
    const first = getOrBuildDesignSystemDigest(dir, refs)!
    expect(first).toContain('--space-sm: 8px')

    writeFileSync(file, `:root { --space-sm: 12px; }`)
    // Force a distinct mtime — some filesystems have coarse mtime resolution.
    const future = new Date(Date.now() + 60_000)
    utimesSync(file, future, future)

    const second = getOrBuildDesignSystemDigest(dir, refs)!
    expect(second).toContain('--space-sm: 12px')
    expect(second).not.toBe(first)
  })

  it('never throws for a design system root that does not exist on disk', () => {
    const refs: DesignSystemRef[] = [{ name: 'missing', source: 'imported', root: 'styles/imported/missing' }]
    expect(() => getOrBuildDesignSystemDigest(dir, refs)).not.toThrow()
    expect(getOrBuildDesignSystemDigest(dir, refs)).toBeUndefined()
  })
})

describe('cache file shape', () => {
  it('writes .studio/cache/design-system-<hash>.md, the same convention styleCompile.ts uses for styles-<hash>', () => {
    write(`${IMPORTED_ROOT}/tokens.css`, `:root { --space-sm: 8px; }`)
    const refs = importedRef()
    getOrBuildDesignSystemDigest(dir, refs)

    const cacheDir = join(dir, '.studio', 'cache')
    const files = readdirSync(cacheDir)
    const match = files.find((f) => /^design-system-[0-9a-f]{16}\.md$/.test(f))
    expect(match).toBeDefined()
    expect(readFileSync(join(cacheDir, match!), 'utf8')).toContain('--space-sm: 8px')
  })
})
