/**
 * `applyProjectSeed` — the copy that gives every new project a design system.
 *
 * Three behaviours worth pinning: the seed must never overwrite what the
 * project scaffolder already wrote; a missing or broken PREPARED seed must
 * fall back to Studio's own install rather than leaving the project empty
 * (nobody populates `.data/studio-seed`, so that fallback is the path almost
 * every real project takes); and nothing here may ever turn project creation
 * into a failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyProjectSeed, resolveProjectSeedDir } from './projectSeed'

let root: string
let seedDir: string
let projectDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-seed-'))
  seedDir = join(root, 'seed')
  projectDir = join(root, 'project')
  mkdirSync(join(seedDir, 'node_modules', '@alm-design', 'design-system'), { recursive: true })
  writeFileSync(join(seedDir, 'node_modules', '@alm-design', 'design-system', 'package.json'), '{"name":"ds"}')
  writeFileSync(join(seedDir, 'package.json'), '{"dependencies":{"@alm-design/design-system":"^1.1.2"}}')
  mkdirSync(join(projectDir, 'pages'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('applyProjectSeed', () => {
  it('copies the design system and its declared dependency into a new project', () => {
    const result = applyProjectSeed(projectDir, seedDir)

    expect(result.copied.sort()).toEqual(['node_modules', 'package.json'])
    expect(existsSync(join(projectDir, 'node_modules', '@alm-design', 'design-system', 'package.json'))).toBe(true)
    expect(readFileSync(join(projectDir, 'package.json'), 'utf8')).toContain('@alm-design/design-system')
  })

  it('never overwrites what the scaffolder already wrote', () => {
    // `pages/` is the scaffolder's, and it wins — this ordering is what lets
    // the seed carry a `pages/` directory later without eating the starter page.
    mkdirSync(join(seedDir, 'pages'), { recursive: true })
    writeFileSync(join(seedDir, 'pages', 'Home.tsx'), 'SEED')
    writeFileSync(join(projectDir, 'pages', 'Home.tsx'), 'SCAFFOLD')

    const result = applyProjectSeed(projectDir, seedDir)

    expect(result.skipped).toContain('pages')
    expect(readFileSync(join(projectDir, 'pages', 'Home.tsx'), 'utf8')).toBe('SCAFFOLD')
  })

  it('falls back to Studio\'s own install when no seed directory was prepared', () => {
    // `.data/studio-seed` is opt-in and nothing populates it, so this is the
    // path a real "New project" actually takes. It used to be a no-op, which
    // is why every new project came out with no design system at all.
    const result = applyProjectSeed(projectDir, join(root, 'does-not-exist'))

    expect(result.copied).toContain('node_modules')
    expect(result.copied).toContain('package.json')
    expect(existsSync(join(projectDir, 'node_modules', '@alm-design', 'design-system'))).toBe(true)
  })

  it('declares the copied package in package.json at the version actually on disk', () => {
    // Copying the package without declaring it produces a project whose design
    // system is present but invisible: `componentPackages` is read from the
    // manifest, so every detector downstream would report none.
    applyProjectSeed(projectDir, join(root, 'does-not-exist'))
    const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const declared = manifest.dependencies?.['@alm-design/design-system']
    expect(declared).toBeDefined()

    const installed = JSON.parse(
      readFileSync(join(projectDir, 'node_modules', '@alm-design', 'design-system', 'package.json'), 'utf8'),
    ) as { version?: string }
    expect(declared).toBe(`^${installed.version}`)
  })

  it('falls back the same way when the seed path is a file, not a directory', () => {
    const notADir = join(root, 'seed.txt')
    writeFileSync(notADir, 'nope')

    expect(applyProjectSeed(projectDir, notADir).copied).toContain('node_modules')
  })

  it('never overwrites a package.json the project already has', () => {
    const mine = '{"name":"mine"}'
    writeFileSync(join(projectDir, 'package.json'), mine)

    const result = applyProjectSeed(projectDir, join(root, 'does-not-exist'))

    expect(result.skipped).toContain('package.json')
    expect(readFileSync(join(projectDir, 'package.json'), 'utf8')).toBe(mine)
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
