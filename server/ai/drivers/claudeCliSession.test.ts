/**
 * claudeCliSession.ts — deterministic session-id derivation (including the
 * session-restart epoch) and the establish-vs-resume filesystem probe
 * (WS-11 step 2, extended for the "Restart agent session" control).
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeCliSessionFileExists,
  claudeCliSessionId,
  shouldEstablishClaudeCliSession,
} from './claudeCliSession'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('claudeCliSessionId', () => {
  it('produces a well-formed UUID string (the shape --session-id validates)', async () => {
    const id = await claudeCliSessionId('conv-1')
    expect(id).toMatch(UUID_RE)
  })

  it('is deterministic — the same conversationId always yields the same UUID', async () => {
    const a = await claudeCliSessionId('conv-abc123')
    const b = await claudeCliSessionId('conv-abc123')
    expect(a).toBe(b)
  })

  it('yields different UUIDs for different conversation ids', async () => {
    const a = await claudeCliSessionId('conv-a')
    const b = await claudeCliSessionId('conv-b')
    expect(a).not.toBe(b)
  })

  describe('session_epoch (migration 021 — "Restart agent session")', () => {
    // Independently computed with Node's own `crypto.createHash('sha256')`
    // (not this module) against a fixed conversation id, so this is a real
    // regression pin, not a tautological "function equals itself" check.
    it('epoch 0 (default) reproduces the EXACT pre-epoch UUID — never orphans a live CLI session', async () => {
      expect(await claudeCliSessionId('conv-pin-test')).toBe('302ce9c9-26bc-403c-85b1-027f615f743a')
      expect(await claudeCliSessionId('conv-pin-test', 0)).toBe('302ce9c9-26bc-403c-85b1-027f615f743a')
    })

    it('a bumped epoch derives a DIFFERENT, still-deterministic UUID', async () => {
      const bumped = await claudeCliSessionId('conv-pin-test', 1)
      expect(bumped).toBe('80d586f1-ac67-4e94-ac18-15e492aca860')
      expect(bumped).not.toBe(await claudeCliSessionId('conv-pin-test', 0))
      // Deterministic at the bumped epoch too.
      expect(await claudeCliSessionId('conv-pin-test', 1)).toBe(bumped)
    })

    it('different epochs of the same conversation never collide', async () => {
      const seen = new Set<string>()
      for (let epoch = 0; epoch < 5; epoch += 1) {
        seen.add(await claudeCliSessionId('conv-pin-test', epoch))
      }
      expect(seen.size).toBe(5)
    })
  })
})

describe('claudeCliSessionFileExists / shouldEstablishClaudeCliSession', () => {
  let configDir: string

  // Each `it` creates and tears down its own temp dir explicitly (rather than
  // a shared `beforeEach`/`afterEach` pair) so a failure in one test can never
  // leak a directory another test then silently reuses.
  function freshConfigDir(): string {
    return mkdtempSync(join(tmpdir(), 'claude-cli-session-probe-'))
  }

  it('reports no session file for a cwd/sessionId the CLI has never written', () => {
    configDir = freshConfigDir()
    try {
      expect(claudeCliSessionFileExists(configDir, '/some/project', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(false)
      expect(shouldEstablishClaudeCliSession(configDir, '/some/project', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('detects a transcript the CLI wrote at its own real naming scheme (dots and spaces both become "-")', () => {
    configDir = freshConfigDir()
    try {
      const cwd = '/Users/maher.fayad/Documents/Github/Figma Killer 2'
      const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const projectDirName = '-Users-maher-fayad-Documents-Github-Figma-Killer-2'
      const transcriptDir = join(configDir, 'projects', projectDirName)
      mkdirSync(transcriptDir, { recursive: true })
      writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), '')

      expect(claudeCliSessionFileExists(configDir, cwd, sessionId)).toBe(true)
      expect(shouldEstablishClaudeCliSession(configDir, cwd, sessionId)).toBe(false)
      // A DIFFERENT sessionId at the exact same cwd still reads as "no session".
      expect(claudeCliSessionFileExists(configDir, cwd, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBe(false)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('never throws for a config dir that does not exist at all (self-heals a cleared/rotated config dir)', () => {
    const missingDir = join(tmpdir(), 'claude-cli-session-probe-missing-' + Math.random().toString(36).slice(2))
    expect(existsSync(missingDir)).toBe(false)
    expect(() => shouldEstablishClaudeCliSession(missingDir, '/some/project', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')).not.toThrow()
    expect(shouldEstablishClaudeCliSession(missingDir, '/some/project', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')).toBe(true)
  })
})
