/**
 * workspacePackageResolve.ts — `sec-01` coverage for the symlink-containment
 * guard on `<dir>/node_modules/<pkg>` resolution. The escape scenario (a
 * `node_modules/<pkg>` entry that is actually a symlink pointing outside the
 * project directory) mirrors `studioAsset.test.ts`'s own symlink-escape test
 * — same try/catch skip for hosts that refuse to create symlinks (notably
 * Windows without Developer Mode / elevation).
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isRealpathContained,
  isRealpathContainedAllowingMissing,
  resolveWorkspacePackageEntry,
} from '../studio/workspacePackageResolve'

function write(dir: string, relPath: string, contents: string): string {
  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

describe('resolveWorkspacePackageEntry', () => {
  let tmpDir: string
  let outsideDir: string

  function setup(): void {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpr-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpr-outside-'))
  }

  function teardown(): void {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }

  it('resolves a real, ordinarily-installed package entry', () => {
    setup()
    try {
      write(tmpDir, 'node_modules/postcss/package.json', JSON.stringify({ name: 'postcss', main: 'index.js' }))
      write(tmpDir, 'node_modules/postcss/index.js', 'module.exports = 1\n')

      const entry = resolveWorkspacePackageEntry(tmpDir, 'postcss')
      expect(entry).toBe(path.join(tmpDir, 'node_modules', 'postcss', 'index.js'))
    } finally {
      teardown()
    }
  })

  it('returns undefined when the package is not installed', () => {
    setup()
    try {
      expect(resolveWorkspacePackageEntry(tmpDir, 'sass')).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('refuses a node_modules/<pkg> entry that is a symlink escaping the project directory, when the host permits creating one', () => {
    setup()
    try {
      const maliciousEntry = write(outsideDir, 'malicious.js', 'module.exports = "should never load"\n')
      write(outsideDir, 'package.json', JSON.stringify({ name: 'evil-postcss' }))
      const pkgDir = path.join(tmpDir, 'node_modules', 'postcss')
      fs.mkdirSync(pkgDir, { recursive: true })
      write(tmpDir, 'node_modules/postcss/package.json', JSON.stringify({ name: 'postcss', main: 'index.js' }))
      const linkPath = path.join(pkgDir, 'index.js')

      try {
        fs.symlinkSync(maliciousEntry, linkPath, 'file')
      } catch {
        // Some hosts (notably Windows without Developer Mode / elevation)
        // refuse to create symlinks at all — nothing to test there, the
        // vector simply doesn't exist on that host.
        return
      }

      expect(resolveWorkspacePackageEntry(tmpDir, 'postcss')).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('never falls back to the admin server\'s own node_modules', () => {
    setup()
    try {
      // No node_modules/react at all inside tmpDir, even though the Studio
      // server itself certainly has one — resolution must not walk up past
      // `dir`.
      expect(resolveWorkspacePackageEntry(tmpDir, 'react')).toBeUndefined()
    } finally {
      teardown()
    }
  })
})

describe('isRealpathContained', () => {
  let tmpDir: string
  let outsideDir: string

  function setup(): void {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpr-contain-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpr-contain-outside-'))
  }

  function teardown(): void {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }

  it('is true for an ordinary file inside dir', () => {
    setup()
    try {
      const target = write(tmpDir, 'postcss.config.js', 'module.exports = {}\n')
      expect(isRealpathContained(target, tmpDir)).toBe(true)
    } finally {
      teardown()
    }
  })

  it('is false for a missing target', () => {
    setup()
    try {
      expect(isRealpathContained(path.join(tmpDir, 'nope.js'), tmpDir)).toBe(false)
    } finally {
      teardown()
    }
  })

  it('is false for a symlinked config file escaping dir, when the host permits creating one', () => {
    setup()
    try {
      const outsideConfig = write(outsideDir, 'postcss.config.js', 'module.exports = { plugins: [] }\n')
      const linkPath = path.join(tmpDir, 'postcss.config.js')

      try {
        fs.symlinkSync(outsideConfig, linkPath, 'file')
      } catch {
        return
      }

      expect(isRealpathContained(linkPath, tmpDir)).toBe(false)
    } finally {
      teardown()
    }
  })
})

/**
 * The bug this pins: `studio_read_file` gated on `isRealpathContained`, which
 * answers `false` for a path that has no real path — i.e. for any file that
 * simply isn't there. The tool therefore reported `"<path>" is not a readable
 * path inside this project` for a MISSING file, blaming containment and making
 * its own accurate "does not exist" message unreachable. Seen in the wild with
 * an agent told to read `.claude/design-system.md` in a project whose roster
 * had not regenerated yet: it read as a permissions problem when the real
 * answer was "that file has not been written".
 *
 * The security property has to survive the relaxation, so the escape cases are
 * tested directly — including the one the relaxation could plausibly have
 * opened, where the tail does NOT exist and the walk climbs to a symlinked
 * parent.
 */
describe('isRealpathContainedAllowingMissing', () => {
  let tmpDir: string
  let outsideDir: string

  function setup(): void {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpr-missing-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpr-missing-outside-'))
  }

  function teardown(): void {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }

  it('accepts a file that does not exist yet, exactly where the strict check refuses it', () => {
    setup()
    try {
      const missing = path.join(tmpDir, '.claude', 'design-system.md')
      // The precise divergence that produced the misleading error.
      expect(isRealpathContained(missing, tmpDir)).toBe(false)
      expect(isRealpathContainedAllowingMissing(missing, tmpDir)).toBe(true)
    } finally {
      teardown()
    }
  })

  it('agrees with the strict check for a file that does exist', () => {
    setup()
    try {
      const present = write(tmpDir, '.claude/design-system.md', '# tokens\n')
      expect(isRealpathContained(present, tmpDir)).toBe(true)
      expect(isRealpathContainedAllowingMissing(present, tmpDir)).toBe(true)
    } finally {
      teardown()
    }
  })

  it('still refuses a MISSING file under a symlinked directory that escapes dir', () => {
    setup()
    try {
      const linkPath = path.join(tmpDir, 'link')
      try {
        fs.symlinkSync(outsideDir, linkPath, 'dir')
      } catch {
        return
      }
      expect(
        isRealpathContainedAllowingMissing(path.join(linkPath, 'not-created-yet.md'), tmpDir),
      ).toBe(false)
    } finally {
      teardown()
    }
  })

  it('still refuses an EXISTING file reached through a symlinked directory that escapes dir', () => {
    setup()
    try {
      write(outsideDir, 'secret.txt', 'shh\n')
      const linkPath = path.join(tmpDir, 'link')
      try {
        fs.symlinkSync(outsideDir, linkPath, 'dir')
      } catch {
        return
      }
      expect(isRealpathContainedAllowingMissing(path.join(linkPath, 'secret.txt'), tmpDir)).toBe(false)
    } finally {
      teardown()
    }
  })

  it('refuses a path outside dir even when nothing along it exists', () => {
    setup()
    try {
      expect(
        isRealpathContainedAllowingMissing(path.join(outsideDir, 'deep', 'nope.md'), tmpDir),
      ).toBe(false)
    } finally {
      teardown()
    }
  })

  it('refuses everything when dir itself does not exist', () => {
    const gone = path.join(os.tmpdir(), 'wpr-never-created-xyz')
    expect(isRealpathContainedAllowingMissing(path.join(gone, 'a.md'), gone)).toBe(false)
  })
})
