/**
 * installJobStore.ts — unit tests for the `.studio/install-job.json`
 * durability sidecar (`infra-01`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readInstallJobFile, writeInstallJobFile, type PersistedInstallJob } from '../studio/installJobStore'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-job-store-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function record(overrides: Partial<PersistedInstallJob> = {}): PersistedInstallJob {
  return {
    id: 'job-1',
    dir: tmpDir,
    packageManager: 'bun',
    status: 'running',
    log: '',
    truncated: false,
    exitCode: null,
    warnings: [],
    startedAt: Date.now(),
    finishedAt: null,
    pid: 1234,
    ...overrides,
  }
}

describe('readInstallJobFile', () => {
  it('returns null when no file exists yet', () => {
    expect(readInstallJobFile(tmpDir)).toBeNull()
  })

  it('round-trips a written record exactly', () => {
    const job = record({ status: 'done', log: 'installed ok', exitCode: 0, finishedAt: Date.now() })
    writeInstallJobFile(job)
    expect(readInstallJobFile(tmpDir)).toEqual(job)
  })

  it('creates the .studio/ sidecar directory if it does not exist yet', () => {
    expect(fs.existsSync(path.join(tmpDir, '.studio'))).toBe(false)
    writeInstallJobFile(record())
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'install-job.json'))).toBe(true)
  })

  it('overwrites the single stored record on a second write (no merge, no history)', () => {
    writeInstallJobFile(record({ id: 'first' }))
    writeInstallJobFile(record({ id: 'second' }))
    expect(readInstallJobFile(tmpDir)?.id).toBe('second')
  })

  it('returns null for unparsable JSON — a corrupted sidecar must not crash a status query', () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.studio', 'install-job.json'), '{ not valid json')
    expect(readInstallJobFile(tmpDir)).toBeNull()
  })

  it('returns null for JSON that fails schema validation (e.g. an unknown status)', () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.studio', 'install-job.json'),
      JSON.stringify({ ...record(), status: 'not-a-real-status' }),
    )
    expect(readInstallJobFile(tmpDir)).toBeNull()
  })
})
