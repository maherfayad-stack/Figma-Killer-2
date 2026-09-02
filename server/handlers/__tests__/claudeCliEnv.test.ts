/**
 * claudeCliEnv.ts — per-user Claude CLI config directory: containment,
 * mode, the L1 login one-liner, and macOS platform disablement (WS-11 §2.1/§5.1).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InvalidClaudeCliUserIdError,
  assertSafeClaudeCliUserId,
  buildClaudeCliLoginCommand,
  claudeCliPlatformSupport,
  deleteClaudeCliConfigDir,
  ensureClaudeCliConfigDir,
  resolveClaudeCliConfigDir,
  resolveClaudeCliDataRoot,
  resolveClaudeCliWorkspaceCwd,
} from '../studio/claudeCliEnv'

const scratchDirs: string[] = []
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-cli-env-test-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveClaudeCliDataRoot', () => {
  it('defaults to <cwd>/.data/claude-cli when CLAUDE_CLI_DATA_DIR is unset', () => {
    const root = resolveClaudeCliDataRoot({})
    expect(root.endsWith(join('.data', 'claude-cli'))).toBe(true)
  })

  it('honours CLAUDE_CLI_DATA_DIR when set', () => {
    const configured = join(tmpdir(), 'claude-cli-configured-root')
    const root = resolveClaudeCliDataRoot({ CLAUDE_CLI_DATA_DIR: configured })
    expect(root).toBe(configured)
  })
})

describe('assertSafeClaudeCliUserId', () => {
  it('accepts a nanoid-shaped id', () => {
    expect(() => assertSafeClaudeCliUserId('V1StGXR8_Z5jdHi6B-myT')).not.toThrow()
  })

  it.each([
    '',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    'C:\\Windows',
    'user id with spaces',
    'user;rm -rf',
  ])('rejects %p', (bad) => {
    expect(() => assertSafeClaudeCliUserId(bad)).toThrow(InvalidClaudeCliUserIdError)
  })
})

describe('resolveClaudeCliConfigDir', () => {
  it('joins dataRoot + userId for a valid id', () => {
    const root = scratchRoot()
    const dir = resolveClaudeCliConfigDir(root, 'user-123')
    expect(dir).toBe(join(root, 'user-123'))
  })

  it('throws on a path-traversal userId instead of silently containing it', () => {
    const root = scratchRoot()
    expect(() => resolveClaudeCliConfigDir(root, '..')).toThrow()
    expect(() => resolveClaudeCliConfigDir(root, '../../etc')).toThrow()
  })
})

describe('ensureClaudeCliConfigDir', () => {
  it('creates the directory mode 0700 (idempotent)', () => {
    const root = scratchRoot()
    const dir = ensureClaudeCliConfigDir(root, 'user-abc')
    expect(existsSync(dir)).toBe(true)
    if (process.platform !== 'win32') {
      const mode = statSync(dir).mode & 0o777
      expect(mode).toBe(0o700)
    }
    // Calling again must not throw and must return the same path.
    const again = ensureClaudeCliConfigDir(root, 'user-abc')
    expect(again).toBe(dir)
  })

  it('never creates the directory outside dataRoot for a malicious userId', () => {
    const root = scratchRoot()
    expect(() => ensureClaudeCliConfigDir(root, '../escape')).toThrow()
    expect(existsSync(join(root, '..', 'escape'))).toBe(false)
  })
})

describe('deleteClaudeCliConfigDir', () => {
  it('removes an existing directory and everything the CLI wrote into it', () => {
    const root = scratchRoot()
    const dir = ensureClaudeCliConfigDir(root, 'user-to-delete')
    expect(existsSync(dir)).toBe(true)
    deleteClaudeCliConfigDir(root, 'user-to-delete')
    expect(existsSync(dir)).toBe(false)
  })

  it('is a no-op when the directory does not exist', () => {
    const root = scratchRoot()
    expect(() => deleteClaudeCliConfigDir(root, 'never-created')).not.toThrow()
  })
})

describe('buildClaudeCliLoginCommand', () => {
  it('produces the exact prefilled one-liner WS-11 §2.1 specifies', () => {
    expect(buildClaudeCliLoginCommand('/data/claude-cli/user-1'))
      .toBe('CLAUDE_CONFIG_DIR=/data/claude-cli/user-1 claude auth login')
  })
})

describe('resolveClaudeCliWorkspaceCwd (WS-11 step 2 fix)', () => {
  it('returns the resolved path for a genuine, contained project directory', () => {
    const root = scratchRoot()
    const project = join(root, 'my-project')
    mkdirSync(project, { recursive: true })
    expect(resolveClaudeCliWorkspaceCwd(project, root)).toBe(project)
  })

  it('returns null when no directory is supplied', () => {
    const root = scratchRoot()
    expect(resolveClaudeCliWorkspaceCwd(undefined, root)).toBeNull()
    expect(resolveClaudeCliWorkspaceCwd(null, root)).toBeNull()
    expect(resolveClaudeCliWorkspaceCwd('', root)).toBeNull()
  })

  it('returns null when the directory does not exist', () => {
    const root = scratchRoot()
    expect(resolveClaudeCliWorkspaceCwd(join(root, 'nope'), root)).toBeNull()
  })

  it('returns null when the path is a file, not a directory', () => {
    const root = scratchRoot()
    const filePath = join(root, 'not-a-dir.txt')
    writeFileSync(filePath, 'x')
    expect(resolveClaudeCliWorkspaceCwd(filePath, root)).toBeNull()
  })

  it('returns null for a directory outside the projects root — never trusts the client', () => {
    const root = scratchRoot()
    const outside = scratchRoot()
    expect(resolveClaudeCliWorkspaceCwd(outside, root)).toBeNull()
  })

  it('returns null for the projects root itself (never a project)', () => {
    const root = scratchRoot()
    expect(resolveClaudeCliWorkspaceCwd(root, root)).toBeNull()
  })

  it('returns null for a path-traversal attempt', () => {
    const root = scratchRoot()
    const project = join(root, 'my-project')
    mkdirSync(project, { recursive: true })
    expect(resolveClaudeCliWorkspaceCwd(join(project, '..', '..'), root)).toBeNull()
  })

  // Security-guard's own documented trap: a textual prefix check on an
  // UNRESOLVED path is bypassable when the path contains a symlink. Skipped
  // on Windows, where symlink creation needs elevated privileges in CI.
  if (process.platform !== 'win32') {
    it('resolves symlinks on BOTH sides before the containment check', () => {
      const root = scratchRoot()
      const realProject = join(scratchRoot(), 'real-project')
      mkdirSync(realProject, { recursive: true })
      const linkedProject = join(root, 'linked-project')
      symlinkSync(realProject, linkedProject, 'dir')
      // The link lives inside root, but its target does not — containment
      // must be checked on the REAL path, so this must be rejected.
      expect(resolveClaudeCliWorkspaceCwd(linkedProject, root)).toBeNull()
    })
  }
})

describe('claudeCliPlatformSupport', () => {
  // Every case passes an EXPLICIT env. Reading the ambient `process.env` here
  // would make the darwin cases fail on a developer's own machine the moment
  // they set the override to use the provider locally — a test that breaks
  // because of a legitimate local setting teaches people to ignore it.
  const NO_ENV: NodeJS.ProcessEnv = {}

  it('disables the provider on darwin with a reason, never silently', () => {
    const result = claudeCliPlatformSupport('darwin', NO_ENV)
    expect(result.supported).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(result.reason).toContain('Keychain')
  })

  it.each(['linux', 'win32'] as const)('supports %s', (platform) => {
    const result = claudeCliPlatformSupport(platform, NO_ENV)
    expect(result.supported).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it.each(['1', 'true', 'TRUE', ' true '])(
    'the local-dev override (%p) enables darwin',
    (value) => {
      const result = claudeCliPlatformSupport('darwin', { STUDIO_ALLOW_MACOS_CLAUDE_CLI: value })
      expect(result.supported).toBe(true)
      expect(result.reason).toBeUndefined()
    },
  )

  // An unset, empty, or typo'd variable must never read as consent — the
  // block it lifts exists to stop several users silently sharing one Keychain
  // login, so "not explicitly yes" has to mean no.
  it.each(['0', 'false', '', 'yes', 'on', 'ture'])(
    'anything other than 1/true leaves darwin blocked (%p)',
    (value) => {
      const result = claudeCliPlatformSupport('darwin', { STUDIO_ALLOW_MACOS_CLAUDE_CLI: value })
      expect(result.supported).toBe(false)
      expect(result.reason).toContain('Keychain')
    },
  )

  it('does not affect non-darwin platforms either way', () => {
    const result = claudeCliPlatformSupport('linux', { STUDIO_ALLOW_MACOS_CLAUDE_CLI: '0' })
    expect(result.supported).toBe(true)
  })
})
