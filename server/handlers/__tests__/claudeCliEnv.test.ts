/**
 * claudeCliEnv.ts — per-user Claude CLI config directory: containment,
 * mode, the L1 login one-liner, and macOS platform disablement (WS-11 §2.1/§5.1).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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

describe('claudeCliPlatformSupport', () => {
  it('disables the provider on darwin with a reason, never silently', () => {
    const result = claudeCliPlatformSupport('darwin')
    expect(result.supported).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(result.reason).toContain('Keychain')
  })

  it.each(['linux', 'win32'] as const)('supports %s', (platform) => {
    const result = claudeCliPlatformSupport(platform)
    expect(result.supported).toBe(true)
    expect(result.reason).toBeUndefined()
  })
})
