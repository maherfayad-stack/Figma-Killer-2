/**
 * The read-side guards compare an excluded directory the way the filesystem
 * resolves its name — case-folded, trailing dots and NTFS stream suffixes
 * dropped — as the write side already did (P4-C). On Windows and default
 * macOS `.GIT/config` IS `.git/config`, and a guard that compared
 * `EXCLUDED_WORKSPACE_DIR_NAMES` case-sensitively served it.
 *
 * Every guard is driven with the spellings that open the excluded directory,
 * and with a link named like source that LANDS in one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWorkspaceFiles, resolveWorkspaceReadPath } from '@core/page-parser'
import { resolveStudioAssetResponse } from '../studioAsset'
import { resolveContainedRefPath } from '../studioEditTargets'
import { normalizeWorkspaceRelativePath } from '../studio/gitPaths'
import { isSafeRelPath } from '../studio/archiveIngest'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-read-guards-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), '[core]\n\tfsmonitor = secret\n')
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  mkdirSync(join(dir, 'src', 'assets'), { recursive: true })
  writeFileSync(join(dir, 'src', 'assets', 'logo.png'), 'png')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'

/** Spellings that open an excluded directory on a case-insensitive filesystem. */
const EXCLUDED_SPELLINGS = ['.GIT/config', '.Git/config', 'Node_Modules/pkg/index.js', 'NODE_MODULES/pkg/index.js']

describe('the project asset route (GET /admin/api/studio/asset)', () => {
  it('still serves an ordinary project file', async () => {
    const res = await resolveStudioAssetResponse(dir, 'src/assets/logo.png', new Request('http://x/'))
    expect(res?.status).toBe(200)
  })

  for (const spelling of EXCLUDED_SPELLINGS) {
    it(`refuses ${spelling}`, async () => {
      if (!caseInsensitiveFs) return
      expect(await resolveStudioAssetResponse(dir, spelling, new Request('http://x/'))).toBeNull()
    })
  }

  it('refuses a link named like source that lands in .git', async () => {
    symlinkSync(join(dir, '.git'), join(dir, 'src', 'pics'), 'junction')
    expect(await resolveStudioAssetResponse(dir, 'src/pics/config', new Request('http://x/'))).toBeNull()
  })
})

describe('the shared read decoder and the edit targets that use it', () => {
  for (const spelling of EXCLUDED_SPELLINGS) {
    it(`refuses ${spelling} before touching the filesystem`, () => {
      expect(resolveWorkspaceReadPath(dir, spelling)).toBeNull()
      expect(resolveContainedRefPath(dir, spelling)).toBeNull()
    })
  }

  it('refuses the trailing-dot and stream spellings too', () => {
    expect(resolveWorkspaceReadPath(dir, '.git./config')).toBeNull()
    expect(resolveWorkspaceReadPath(dir, '.git::$INDEX_ALLOCATION/config')).toBeNull()
  })
})

describe('git pathspecs, archive entries and the workspace walk', () => {
  it('a git pathspec into .GIT is refused', () => {
    expect(normalizeWorkspaceRelativePath('.GIT/config')).toBeNull()
    expect(normalizeWorkspaceRelativePath('src/.Git/hooks/pre-commit')).toBeNull()
  })

  it('an archive entry under .GIT or .Studio never lands', () => {
    expect(isSafeRelPath('.GIT/hooks/post-checkout')).toBe(false)
    expect(isSafeRelPath('.Studio/meta.json')).toBe(false)
    expect(isSafeRelPath('src/App.tsx')).toBe(true)
  })

  it('the walk never enters a case variant of an excluded directory', () => {
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    mkdirSync(join(dir, 'Node_Modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'Node_Modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    expect(listWorkspaceFiles(dir).filter((rel) => rel.toLowerCase().startsWith('node_modules'))).toEqual([])
  })
})
