/**
 * `applyProjectSeed` — the copy that gives every new project a design system.
 *
 * The two behaviours worth pinning are both about NOT doing damage: the seed
 * must never overwrite what the project scaffolder already wrote, and a
 * missing/broken seed must never turn project creation into a failure.
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

  it('is a no-op when no seed is installed, rather than throwing', () => {
    // Project creation must not fail because an optional convenience is absent.
    const result = applyProjectSeed(projectDir, join(root, 'does-not-exist'))

    expect(result).toEqual({ copied: [], skipped: [] })
    expect(existsSync(join(projectDir, 'node_modules'))).toBe(false)
  })

  it('is a no-op when the seed path is a file, not a directory', () => {
    const notADir = join(root, 'seed.txt')
    writeFileSync(notADir, 'nope')

    expect(applyProjectSeed(projectDir, notADir)).toEqual({ copied: [], skipped: [] })
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
