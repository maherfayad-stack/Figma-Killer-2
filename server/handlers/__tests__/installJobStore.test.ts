/**
 * installJobStore.ts — unit tests for the `.studio/install-job.json`
 * durability sidecar (`infra-01`).
 *
 * `sec-18` — the sidecar is keyed on the PROJECT directory, which for a
 * monorepo import is NOT the app root the install spawns in. The last case
 * here drives that with a monorepo fixture: the record lands at
 * `<project>/.studio/`, never at `<project>/apps/web/.studio/`, and a stale
 * record left at the old app-root location is ignored rather than read.
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
    writeInstallJobFile(tmpDir, job)
    expect(readInstallJobFile(tmpDir)).toEqual(job)
  })

  it('creates the .studio/ sidecar directory if it does not exist yet', () => {
    expect(fs.existsSync(path.join(tmpDir, '.studio'))).toBe(false)
    writeInstallJobFile(tmpDir, record())
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'install-job.json'))).toBe(true)
  })

  it('overwrites the single stored record on a second write (no merge, no history)', () => {
    writeInstallJobFile(tmpDir, record({ id: 'first' }))
    writeInstallJobFile(tmpDir, record({ id: 'second' }))
    expect(readInstallJobFile(tmpDir)?.id).toBe('second')
  })

  it('returns null for unparsable JSON — a corrupted sidecar must not crash a status query', () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.studio', 'install-job.json'), '{ not valid json')
    expect(readInstallJobFile(tmpDir)).toBeNull()
  })

  it('writes at the PROJECT root on a monorepo, never inside the app', () => {
    // The app root is `<project>/apps/web` — where `package.json` and
    // `node_modules` are, and where the package manager actually spawns.
    const appRoot = path.join(tmpDir, 'apps', 'web')
    fs.mkdirSync(appRoot, { recursive: true })

    writeInstallJobFile(tmpDir, record({ dir: appRoot }))

    expect(fs.existsSync(path.join(tmpDir, '.studio', 'install-job.json'))).toBe(true)
    // A second `.studio/` inside the user's own git-tracked application is
    // the defect (`sec-15`'s informational, `server-25`'s `lastDeploy` one
    // module over). It must not exist.
    expect(fs.existsSync(path.join(appRoot, '.studio'))).toBe(false)
    // …and the record still REPORTS the app root, which is what a poller asked about.
    expect(readInstallJobFile(tmpDir)?.dir).toBe(appRoot)
  })

  it('ignores a record left at the old app-root location — no migration, no fallback read', () => {
    const appRoot = path.join(tmpDir, 'apps', 'web')
    fs.mkdirSync(path.join(appRoot, '.studio'), { recursive: true })
    fs.writeFileSync(
      path.join(appRoot, '.studio', 'install-job.json'),
      JSON.stringify(record({ id: 'from-an-older-build', dir: appRoot })),
    )

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
