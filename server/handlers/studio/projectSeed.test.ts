/**
 * `applyProjectSeed` — what a brand-new project starts with.
 *
 * Four behaviours worth pinning: the seed never overwrites what the project
 * scaffolder already wrote; a new project comes out with a `package.json` that
 * declares **no design-system dependency** (the design system is a folder in
 * the project now, so an unzipped download installs only what npm can still
 * serve); the project is marked design-system-backed so Studio maintains that
 * folder from here on; and nothing here may ever turn project creation into a
 * failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyProjectSeed, resolveProjectSeedDir } from './projectSeed'
import { readStudioMeta } from './studioMeta'
import { isDesignSystemBacked } from './builtinDesignSystem'

let root: string
let seedDir: string
let designSystemSourceDir: string
let projectDir: string

/** A minimal stand-in for `vendor/alm-design-system/`, which DS-1 creates and this branch does not have. */
function writeVendoredDesignSystem(): void {
  const src = join(designSystemSourceDir, 'src')
  mkdirSync(join(src, 'components'), { recursive: true })
  mkdirSync(join(src, 'context'), { recursive: true })
  mkdirSync(join(src, 'tokens'), { recursive: true })
  mkdirSync(join(src, 'icons'), { recursive: true })
  writeFileSync(join(designSystemSourceDir, 'package.json'), '{"name":"alm-design-system","version":"1.1.2"}')
  writeFileSync(join(src, 'index.js'), "export { Button } from './components/Button'\n")
  writeFileSync(join(src, 'components', 'Button.jsx'), 'export function Button() { return null }\n')
  writeFileSync(join(src, 'context', 'DesignSystemContext.jsx'), 'export const ctx = null\n')
  writeFileSync(join(src, 'tokens', 'index.css'), ':root { --a: 1px }\n')
  writeFileSync(join(src, 'icons', 'LineIcons.jsx'), 'export const ChevronIcon = null\n')
}

function seed(extra: { seedDir?: string } = {}) {
  return applyProjectSeed(projectDir, { designSystemSourceDir, ...extra })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-seed-'))
  seedDir = join(root, 'seed')
  designSystemSourceDir = join(root, 'vendor', 'alm-design-system')
  projectDir = join(root, 'project')
  mkdirSync(seedDir, { recursive: true })
  mkdirSync(join(projectDir, 'pages'), { recursive: true })
  writeVendoredDesignSystem()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('applyProjectSeed', () => {
  it('gives a new project the design system as a folder, not as a dependency', () => {
    const result = seed()

    expect(isDesignSystemBacked(projectDir)).toBe(true)
    expect(result.copied).toContain('design-system')
    expect(existsSync(join(projectDir, 'design-system', 'components', 'Button.jsx'))).toBe(true)
  })

  it('writes a package.json with react and vite and NO design-system dependency', () => {
    // The download zip excludes `node_modules` and there is no registry that
    // serves the retired package, so a manifest naming it is a manifest that
    // cannot install.
    seed()
    const manifest = readFileSync(join(projectDir, 'package.json'), 'utf8')

    expect(manifest).not.toContain('alm-design')
    const parsed = JSON.parse(manifest) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      scripts: Record<string, string>
    }
    expect(parsed.dependencies.react).toBeDefined()
    expect(parsed.dependencies['react-dom']).toBeDefined()
    expect(parsed.devDependencies.vite).toBeDefined()
    expect(parsed.devDependencies['@vitejs/plugin-react']).toBeDefined()
    expect(parsed.scripts.dev).toBe('vite')
  })

  it('records the design system in .studio/meta.json — the write-side authority', () => {
    // Without the flag, `ensureDesignSystemFiles` refuses on every later open
    // and the folder silently goes stale.
    seed()
    expect(readStudioMeta(projectDir).designSystem).toBe('alm')
  })

  it('preserves what the scaffolder already wrote to .studio/meta.json', () => {
    mkdirSync(join(projectDir, '.studio'), { recursive: true })
    writeFileSync(
      join(projectDir, '.studio', 'meta.json'),
      JSON.stringify({ displayName: 'My App', platform: 'mobile' }),
    )

    seed()
    const meta = readStudioMeta(projectDir)

    expect(meta.displayName).toBe('My App')
    expect(meta.platform).toBe('mobile')
    expect(meta.designSystem).toBe('alm')
  })

  it('copies a prepared seed directory, when one exists', () => {
    mkdirSync(join(seedDir, 'styles'), { recursive: true })
    writeFileSync(join(seedDir, 'styles', 'house.css'), '.house {}\n')

    const result = seed({ seedDir })

    expect(result.copied).toContain('styles')
    expect(readFileSync(join(projectDir, 'styles', 'house.css'), 'utf8')).toBe('.house {}\n')
  })

  it('never overwrites what the scaffolder already wrote', () => {
    // `pages/` is the scaffolder's, and it wins — this ordering is what lets
    // the seed carry a `pages/` directory later without eating the starter page.
    mkdirSync(join(seedDir, 'pages'), { recursive: true })
    writeFileSync(join(seedDir, 'pages', 'Home.tsx'), 'SEED')
    writeFileSync(join(projectDir, 'pages', 'Home.tsx'), 'SCAFFOLD')

    const result = seed({ seedDir })

    expect(result.skipped).toContain('pages')
    expect(readFileSync(join(projectDir, 'pages', 'Home.tsx'), 'utf8')).toBe('SCAFFOLD')
  })

  it('never overwrites a value the project\'s own package.json already set', () => {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'mine', dependencies: { react: '18.0.0' } }))

    seed()
    const parsed = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      name: string
      dependencies: Record<string, string>
    }

    expect(parsed.name).toBe('mine')
    expect(parsed.dependencies.react).toBe('18.0.0')
    // …and still gains what it was missing.
    expect(parsed.dependencies['react-dom']).toBeDefined()
  })

  it('works with no prepared seed directory at all — the normal case', () => {
    // Nothing populates `.data/studio-seed`, so this is the path every real
    // "New project" takes.
    const result = applyProjectSeed(projectDir, {
      seedDir: join(root, 'does-not-exist'),
      designSystemSourceDir,
    })

    expect(result.copied).toContain('package.json')
    expect(result.copied).toContain('design-system')
  })

  it('works when the seed path is a file, not a directory', () => {
    const notADir = join(root, 'seed.txt')
    writeFileSync(notADir, 'nope')

    expect(seed({ seedDir: notADir }).copied).toContain('design-system')
  })

  it('never fails project creation when Studio has no vendored design system', () => {
    rmSync(designSystemSourceDir, { recursive: true, force: true })

    const result = seed()

    expect(result.copied).toContain('package.json')
    expect(result.skipped).toContain('design-system')
    expect(existsSync(join(projectDir, 'design-system'))).toBe(false)
  })
})

describe('resolveProjectSeedDir', () => {
  it('defaults under .data/, beside the other private local runtime state', () => {
    expect(resolveProjectSeedDir({})).toBe(join(process.cwd(), '.data', 'studio-seed'))
  })

  it('honours an explicit override', () => {
    expect(resolveProjectSeedDir({ STUDIO_PROJECT_SEED_DIR: '/tmp/custom-seed' })).toBe('/tmp/custom-seed')
  })
})
