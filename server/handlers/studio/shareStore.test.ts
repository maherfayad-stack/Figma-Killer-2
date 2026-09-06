/**
 * shareStore — the registry behind `/share/<token>`.
 *
 * The three things worth locking down here are the three that would each be a
 * security bug on their own: a token narrow enough to guess, a revocation
 * that does not take effect, and a path that escapes the share's directory.
 *
 * Fixture posture matches `referenceUpload.test.ts` — a temp directory
 * created INSIDE `projectsRootDir()`, because the cross-project lookup scans
 * exactly that root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isShareTokenShape } from '@core/studio-share'
import { projectsRootDir } from '../studioProjects'
import {
  clearShareLookupMemo,
  findShareRecord,
  listShareSummaries,
  mintShareToken,
  resolveActiveShare,
  resolveShareFile,
  revokeShareRecord,
  shareSnapshotDir,
  upsertShareRecord,
  type ShareRecord,
} from './shareStore'

let dir: string

beforeEach(() => {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, '__share_store_test_'))
  clearShareLookupMemo()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  clearShareLookupMemo()
})

function record(token: string, overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    token,
    boardId: 'board-1',
    boardName: 'Board 1',
    createdAt: '2026-09-01T10:00:00.000Z',
    snapshotAt: '2026-09-01T10:00:00.000Z',
    frameCount: 2,
    ...overrides,
  }
}

describe('mintShareToken', () => {
  it('mints a 256-bit token in the shape the routes accept', () => {
    const token = mintShareToken()
    expect(isShareTokenShape(token)).toBe(true)
    expect(token.startsWith('shr_')).toBe(true)
    // 32 random bytes base64url-encode to 43 characters with no padding.
    expect(token.length).toBe('shr_'.length + 43)
  })

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => mintShareToken()))
    expect(tokens.size).toBe(500)
  })

  it('refuses anything that is not exactly that shape', () => {
    expect(isShareTokenShape('')).toBe(false)
    expect(isShareTokenShape('shr_')).toBe(false)
    expect(isShareTokenShape('shr_short')).toBe(false)
    expect(isShareTokenShape('../../etc/passwd')).toBe(false)
    expect(isShareTokenShape('shr_../../../etc/passwd')).toBe(false)
    expect(isShareTokenShape(`${mintShareToken()}/..`)).toBe(false)
    expect(isShareTokenShape(mintShareToken().replace('shr_', 'cap_'))).toBe(false)
  })
})

describe('the share lifecycle', () => {
  it('creates, lists, resolves and revokes', () => {
    const token = mintShareToken()
    upsertShareRecord(dir, record(token))

    expect(listShareSummaries(dir).map((s) => s.token)).toEqual([token])
    expect(resolveActiveShare(token)?.dir).toBe(dir)

    const revoked = revokeShareRecord(dir, token, '2026-09-02T10:00:00.000Z')
    expect(revoked?.revokedAt).toBe('2026-09-02T10:00:00.000Z')

    // Revocation is immediate: the very next resolution fails.
    expect(resolveActiveShare(token)).toBeNull()
    // …but the record is KEPT so the owner's dialog can still show it.
    expect(listShareSummaries(dir)).toHaveLength(1)
    expect(listShareSummaries(dir)[0]?.revokedAt).toBe('2026-09-02T10:00:00.000Z')
  })

  it('revoking deletes the snapshot bytes, not just the record', () => {
    const token = mintShareToken()
    const snapshotDir = shareSnapshotDir(dir, token)!
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(path.join(snapshotDir, 'board.json'), '{}')

    revokeShareRecord(dir, token, '2026-09-02T10:00:00.000Z')
    // No record yet, so nothing was revoked and nothing was deleted.
    expect(fs.existsSync(snapshotDir)).toBe(true)

    upsertShareRecord(dir, record(token))
    revokeShareRecord(dir, token, '2026-09-02T10:00:00.000Z')
    expect(fs.existsSync(snapshotDir)).toBe(false)
  })

  it('resolves nothing for an unknown or malformed token', () => {
    expect(resolveActiveShare(mintShareToken())).toBeNull()
    expect(resolveActiveShare('nonsense')).toBeNull()
    expect(resolveActiveShare('')).toBeNull()
  })

  it('replaces rather than duplicates on re-capture', () => {
    const token = mintShareToken()
    upsertShareRecord(dir, record(token))
    upsertShareRecord(dir, record(token, { snapshotAt: '2026-09-03T10:00:00.000Z', frameCount: 5 }))

    const summaries = listShareSummaries(dir)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.frameCount).toBe(5)
    // `createdAt` is the link's age, `snapshotAt` the picture's — see shareRoutes.
    expect(summaries[0]?.createdAt).toBe('2026-09-01T10:00:00.000Z')
  })

  it('treats a corrupted registry as empty rather than throwing', () => {
    fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.studio', 'shares.json'), 'not json at all')
    expect(listShareSummaries(dir)).toEqual([])
    expect(findShareRecord(dir, mintShareToken())).toBeNull()
  })
})

describe('resolveShareFile containment', () => {
  it('resolves a plain filename inside the share directory', () => {
    const token = mintShareToken()
    const snapshotDir = shareSnapshotDir(dir, token)!
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(path.join(snapshotDir, 'board.json'), '{}')

    expect(resolveShareFile(dir, token, 'board.json')).toBe(path.join(snapshotDir, 'board.json'))
  })

  it('refuses every way out of the share directory', () => {
    const token = mintShareToken()
    for (const candidate of [
      '../board.json',
      '../../shares.json',
      '..%2Fboard.json',
      'nested/board.json',
      'nested\\board.json',
      '/etc/passwd',
      'a\0b.png',
    ]) {
      expect(resolveShareFile(dir, token, candidate)).toBeNull()
    }
  })

  it('refuses a token that is not a token', () => {
    expect(shareSnapshotDir(dir, '../../..')).toBeNull()
    expect(resolveShareFile(dir, '../../..', 'board.json')).toBeNull()
  })

  it('refuses a symlink that points out of the share directory', () => {
    const token = mintShareToken()
    const snapshotDir = shareSnapshotDir(dir, token)!
    fs.mkdirSync(snapshotDir, { recursive: true })
    const outside = path.join(dir, 'secret.txt')
    fs.writeFileSync(outside, 'secret')
    fs.symlinkSync(outside, path.join(snapshotDir, 'aaaaaa-0.png'))

    expect(resolveShareFile(dir, token, 'aaaaaa-0.png')).toBeNull()
  })
})
