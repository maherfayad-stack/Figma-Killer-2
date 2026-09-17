/**
 * gitAskpass — the one-shot credential handover, tested as the security
 * control it is rather than as a file writer.
 *
 * The rejections are the point:
 *
 *   - a token carrying a quote, a newline, a `$`, or a backtick is REFUSED,
 *     not escaped. The script embeds the token inside single quotes, so a
 *     value that could close them is shell injection running as the server
 *     user;
 *   - the file is owner-only on a POSIX host (mode checks are skipped on
 *     Windows, which has no POSIX mode bits);
 *   - `dispose()` removes the whole directory, is idempotent, and is what
 *     `runGit`'s `finally` calls — so a token never outlives its invocation.
 *
 * The happy path is asserted at the level that matters: the script answers
 * `x-access-token` to a Username prompt and the token to anything else.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { GIT_TOKEN_USERNAME, isEmbeddableGitToken, writeAskpassScript } from '../studio/gitAskpass'

const REAL_TOKEN = 'ghp_0123456789abcdefABCDEF0123456789abcd'

describe('isEmbeddableGitToken — what may be written into a shell script', () => {
  it('accepts every GitHub token shape', () => {
    expect(isEmbeddableGitToken(REAL_TOKEN)).toBe(true)
    expect(isEmbeddableGitToken('github_pat_11ABCDEFG0aBcDeFgHiJkL_MnOpQrStUvWxYz')).toBe(true)
    expect(isEmbeddableGitToken('gho_' + 'a'.repeat(36))).toBe(true)
    // The legacy 40-hex classic PAT.
    expect(isEmbeddableGitToken('0'.repeat(40))).toBe(true)
  })

  it('refuses anything that could break out of the single quotes', () => {
    for (const hostile of [
      "ghp_x'; rm -rf /; echo '",
      'ghp_x`whoami`',
      'ghp_x$(id)',
      'ghp_x\nrm -rf /',
      'ghp_x"y',
      'ghp_x y',
      'ghp_x\\',
      'ghp_x;y',
    ]) {
      expect(isEmbeddableGitToken(hostile)).toBe(false)
    }
  })

  it('refuses an empty, short, or absurdly long value', () => {
    expect(isEmbeddableGitToken('')).toBe(false)
    expect(isEmbeddableGitToken('ghp_1')).toBe(false)
    expect(isEmbeddableGitToken('a'.repeat(256))).toBe(false)
  })
})

describe('writeAskpassScript', () => {
  it('refuses to write a script for a token it cannot embed safely', () => {
    expect(() => writeAskpassScript("ghp_x'; id; '")).toThrow(/not in a format Studio can use/)
  })

  it('writes a shebanged script that answers both prompts', () => {
    const script = writeAskpassScript(REAL_TOKEN)
    try {
      const body = readFileSync(script.path, 'utf8')
      expect(body.startsWith('#!/bin/sh\n')).toBe(true)
      expect(body).toContain(`Username*) printf '%s' '${GIT_TOKEN_USERNAME}'`)
      expect(body).toContain(`*) printf '%s' '${REAL_TOKEN}'`)
    } finally {
      script.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('creates the script owner-only', () => {
    const script = writeAskpassScript(REAL_TOKEN)
    try {
      // 0o700: readable, writable, and executable by the owner and nobody
      // else. A group- or world-readable file would hand the token to every
      // local account for the duration of the push.
      expect(statSync(script.path).mode & 0o777).toBe(0o700)
      expect(statSync(dirname(script.path)).mode & 0o077).toBe(0)
    } finally {
      script.dispose()
    }
  })

  it('dispose removes the whole directory and is idempotent', () => {
    const script = writeAskpassScript(REAL_TOKEN)
    const dir = dirname(script.path)
    expect(existsSync(script.path)).toBe(true)

    script.dispose()
    expect(existsSync(script.path)).toBe(false)
    expect(existsSync(dir)).toBe(false)

    // Called twice by a caller whose `finally` ran after an early dispose —
    // must not throw.
    expect(() => script.dispose()).not.toThrow()
  })

  it('gives each invocation its own directory', () => {
    const first = writeAskpassScript(REAL_TOKEN)
    const second = writeAskpassScript(REAL_TOKEN)
    try {
      expect(dirname(first.path)).not.toBe(dirname(second.path))
      // Disposing one must not remove the other's script mid-push.
      first.dispose()
      expect(existsSync(second.path)).toBe(true)
    } finally {
      first.dispose()
      second.dispose()
    }
  })
})
