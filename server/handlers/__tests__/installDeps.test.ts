/**
 * installDeps.ts — unit tests for the WS-1.4 dependency-install job.
 *
 * No real subprocess is ever spawned here (`spawn` is always injected) and no
 * real timer ever fires (`setTimeoutImpl`/`clearTimeoutImpl` are injected and
 * the fake timer invokes its callback synchronously) — every async wait below
 * is a microtask flush (`await Promise.resolve()`), never a wall-clock delay.
 *
 * Fixture dirs for the containment tests live under the REAL
 * `studio-workspace/` (the containment check is hardcoded to that root), in a
 * uniquely-named, test-owned subfolder that is created and removed by this
 * file only — never touching any other project. Dirs outside the workspace
 * use `os.tmpdir()`, same pattern as the other studio handler tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  detectPackageManager,
  getInstallJob,
  probeInstallStatus,
  resolveInstallJobStatus,
  startInstallJob,
  tryServeStudioInstall,
  type InstallSpawnFn,
  type InstallSpawnedProcess,
  type PublicInstallJob,
} from '../studio/installDeps'
import { readInstallJobFile, writeInstallJobFile, type PersistedInstallJob } from '../studio/installJobStore'
import { projectsRootDir } from '../studioProjects'

// ---------------------------------------------------------------------------
// Fake spawn / fake process helpers — no real subprocess, no real timers.
// ---------------------------------------------------------------------------

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

interface FakeProcessOptions {
  stdout?: string
  stderr?: string
  exitCode?: number
  /** When true, `exited` stays pending until `kill()` is called — simulates a hung install for the timeout test. */
  hangUntilKilled?: boolean
}

function makeFakeProcess(opts: FakeProcessOptions = {}): { proc: InstallSpawnedProcess; wasKilled: () => boolean } {
  let killed = false
  let resolveExited!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  if (!opts.hangUntilKilled) resolveExited(opts.exitCode ?? 0)

  const proc: InstallSpawnedProcess = {
    stdout: streamFromString(opts.stdout ?? ''),
    stderr: streamFromString(opts.stderr ?? ''),
    exited,
    kill: () => {
      killed = true
      resolveExited(opts.exitCode ?? -1)
    },
  }
  return { proc, wasKilled: () => killed }
}

interface SpawnCall {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

function makeSpawnSpy(processFactory: () => InstallSpawnedProcess): { spawn: InstallSpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: InstallSpawnFn = (argv, options) => {
    calls.push({ argv: [...argv], cwd: options.cwd, env: options.env })
    return processFactory()
  }
  return { spawn, calls }
}

/** Fake `setTimeout` that invokes its callback synchronously and records the delay it was given. */
function makeImmediateTimer(): { setTimeoutImpl: typeof setTimeout; clearTimeoutImpl: typeof clearTimeout; delays: number[] } {
  const delays: number[] = []
  const setTimeoutImpl = ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0)
    handler()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  const clearTimeoutImpl = (() => {}) as typeof clearTimeout
  return { setTimeoutImpl, clearTimeoutImpl, delays }
}

/** A no-op timer that never fires — used when a test wants the real 5-minute default to simply never trigger during the run. */
function makeInertTimer(): { setTimeoutImpl: typeof setTimeout; clearTimeoutImpl: typeof clearTimeout } {
  const setTimeoutImpl = (() => 0 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout
  const clearTimeoutImpl = (() => {}) as typeof clearTimeout
  return { setTimeoutImpl, clearTimeoutImpl }
}

/** Polls via microtask flushes only (never a real timer) until the job leaves 'running' or the tick budget is exhausted. */
async function waitForSettle(jobId: string, maxTicks = 200): Promise<PublicInstallJob> {
  for (let i = 0; i < maxTicks; i++) {
    const job = getInstallJob(jobId)
    if (job && job.status !== 'running') return job
    await Promise.resolve()
  }
  throw new Error(`job ${jobId} did not settle within the microtask budget`)
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// detectPackageManager / probeInstallStatus — pure filesystem reads
// ---------------------------------------------------------------------------

describe('detectPackageManager', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installdeps-pm-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('defaults to bun when no lockfile is present', () => {
    expect(detectPackageManager(tmpDir)).toBe('bun')
  })

  it('detects pnpm from pnpm-lock.yaml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '')
    expect(detectPackageManager(tmpDir)).toBe('pnpm')
  })

  it('detects yarn from yarn.lock', () => {
    fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '')
    expect(detectPackageManager(tmpDir)).toBe('yarn')
  })

  it('detects npm from package-lock.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '')
    expect(detectPackageManager(tmpDir)).toBe('npm')
  })

  it('detects bun from bun.lock', () => {
    fs.writeFileSync(path.join(tmpDir, 'bun.lock'), '')
    expect(detectPackageManager(tmpDir)).toBe('bun')
  })
})

describe('probeInstallStatus', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installdeps-probe-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports no package.json / no node_modules for an empty dir', () => {
    expect(probeInstallStatus(tmpDir)).toEqual({
      hasPackageJson: false,
      hasNodeModules: false,
      dependencyCount: 0,
      packageManager: 'bun',
      job: null,
    })
  })

  it('counts dependencies and detects node_modules presence', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }),
    )
    fs.mkdirSync(path.join(tmpDir, 'node_modules'))
    expect(probeInstallStatus(tmpDir)).toEqual({
      hasPackageJson: true,
      hasNodeModules: true,
      dependencyCount: 2,
      packageManager: 'bun',
      job: null,
    })
  })

  it('does not throw on a malformed package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ not valid json')
    const status = probeInstallStatus(tmpDir)
    expect(status.hasPackageJson).toBe(true)
    expect(status.dependencyCount).toBe(0)
  })

  it('approot-01 — reports package.json/node_modules found ONE LEVEL DOWN, not at the project directory', () => {
    const appDir = path.join(tmpDir, 'firmware-console')
    fs.mkdirSync(path.join(appDir, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }))

    expect(probeInstallStatus(tmpDir)).toEqual({
      hasPackageJson: true,
      hasNodeModules: true,
      dependencyCount: 1,
      packageManager: 'bun',
      job: null,
    })
  })
})

// ---------------------------------------------------------------------------
// startInstallJob — spawn argv/cwd, log capping, timeout
// ---------------------------------------------------------------------------

describe('startInstallJob', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installdeps-job-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('spawns with --ignore-scripts in the argv — security-critical, never omitted', async () => {
    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    await waitForSettle(jobId)

    expect(calls).toHaveLength(1)
    expect(calls[0].argv).toContain('--ignore-scripts')
  })

  it('never forwards STUDIO_SECRET_KEY/DATABASE_URL to the install subprocess (sec-01) — env is explicit, not process.env wholesale', async () => {
    const originalKey = process.env.STUDIO_SECRET_KEY
    const originalDb = process.env.DATABASE_URL
    process.env.STUDIO_SECRET_KEY = 'top-secret-test-value'
    process.env.DATABASE_URL = 'postgres://leak-me'
    try {
      const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
      const timer = makeInertTimer()
      const jobId = startInstallJob(tmpDir, { spawn, ...timer })
      await waitForSettle(jobId)

      expect(calls).toHaveLength(1)
      expect(calls[0].env.STUDIO_SECRET_KEY).toBeUndefined()
      expect(calls[0].env.DATABASE_URL).toBeUndefined()
      expect(Object.values(calls[0].env)).not.toContain('top-secret-test-value')
      expect(Object.values(calls[0].env)).not.toContain('postgres://leak-me')
    } finally {
      if (originalKey === undefined) delete process.env.STUDIO_SECRET_KEY
      else process.env.STUDIO_SECRET_KEY = originalKey
      if (originalDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = originalDb
    }
  })

  it('includes --ignore-scripts for a detected non-bun manager too (pnpm)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '')
    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    await waitForSettle(jobId)

    expect(calls[0].argv[0]).toBe('pnpm')
    expect(calls[0].argv).toContain('--ignore-scripts')
  })

  it('runs with cwd = the resolved project dir, never the repo root', async () => {
    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    await waitForSettle(jobId)

    expect(normalize(calls[0].cwd)).toBe(normalize(path.resolve(tmpDir)))
    expect(normalize(calls[0].cwd)).not.toBe(normalize(process.cwd()))
  })

  it('caps combined stdout+stderr log output and marks the job truncated', async () => {
    const bigOutput = 'x'.repeat(5000)
    const { spawn } = makeSpawnSpy(() => makeFakeProcess({ stdout: bigOutput, exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, maxLogBytes: 100, ...timer })
    const job = await waitForSettle(jobId)

    expect(job.truncated).toBe(true)
    expect(Buffer.byteLength(job.log, 'utf8')).toBeLessThan(5000)
    expect(job.log).toContain('truncated')
  })

  it('does not truncate output under the cap', async () => {
    const { spawn } = makeSpawnSpy(() => makeFakeProcess({ stdout: 'hello install\n', exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    const job = await waitForSettle(jobId)

    expect(job.truncated).toBe(false)
    expect(job.log).toContain('hello install')
    expect(job.status).toBe('done')
  })

  it('marks the job failed on a non-zero exit code', async () => {
    const { spawn } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 1 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    const job = await waitForSettle(jobId)

    expect(job.status).toBe('failed')
    expect(job.exitCode).toBe(1)
  })

  it('times out, kills the process, and marks the job timeout — no real wait', async () => {
    let killedFlag: () => boolean = () => false
    const { spawn } = makeSpawnSpy(() => {
      const { proc, wasKilled } = makeFakeProcess({ hangUntilKilled: true })
      killedFlag = wasKilled
      return proc
    })
    const { setTimeoutImpl, clearTimeoutImpl, delays } = makeImmediateTimer()
    const jobId = startInstallJob(tmpDir, { spawn, timeoutMs: 5 * 60 * 1000, setTimeoutImpl, clearTimeoutImpl })
    const job = await waitForSettle(jobId)

    expect(delays).toEqual([5 * 60 * 1000])
    expect(killedFlag()).toBe(true)
    expect(job.status).toBe('timeout')
  })

  it('warns about postinstall-prone packages on a successful install', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { sharp: '^0.33.0' } }))
    const { spawn } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    const job = await waitForSettle(jobId)

    expect(job.status).toBe('done')
    expect(job.warnings.join(' ')).toContain('sharp')
  })

  // -------------------------------------------------------------------------
  // approot-01 — a project's app root is not always its project directory.
  // -------------------------------------------------------------------------

  it('runs with cwd = the resolved APP ROOT when package.json sits one level down, not the project directory', async () => {
    // Shares nothing with the eSIM corpus's own naming — genericRepoShapes.test.ts discipline.
    const appDir = path.join(tmpDir, 'firmware-console')
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'firmware-console' }))

    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    await waitForSettle(jobId)

    expect(normalize(calls[0].cwd)).toBe(normalize(appDir))
    expect(normalize(calls[0].cwd)).not.toBe(normalize(tmpDir))
  })

  it("uses the app root's OWN lockfile to pick the package manager, not the project directory's", async () => {
    const appDir = path.join(tmpDir, 'firmware-console')
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'firmware-console' }))
    fs.writeFileSync(path.join(appDir, 'pnpm-lock.yaml'), '')
    // A DIFFERENT manager's lockfile at the project root must not win.
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '')

    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    await waitForSettle(jobId)

    expect(calls[0].argv[0]).toBe('pnpm')
  })

  it('still runs at the project directory when package.json sits there too — the nested-app fix does not regress the common case', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'fixture' }))
    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })
    await waitForSettle(jobId)

    expect(normalize(calls[0].cwd)).toBe(normalize(path.resolve(tmpDir)))
  })
})

describe('getInstallJob', () => {
  it('returns null for an unknown job id', () => {
    expect(getInstallJob('this-job-does-not-exist')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// infra-01 — durability: .studio/install-job.json survives a server restart
// ---------------------------------------------------------------------------

describe('install job durability (.studio/install-job.json)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installdeps-durable-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function orphanRecord(overrides: Partial<PersistedInstallJob> = {}): PersistedInstallJob {
    return {
      id: 'orphan-job-id',
      dir: path.resolve(tmpDir),
      packageManager: 'bun',
      status: 'running',
      log: '',
      truncated: false,
      exitCode: null,
      warnings: [],
      startedAt: Date.now(),
      finishedAt: null,
      pid: null,
      ...overrides,
    }
  }

  it('writes a running record synchronously at start, then a terminal record once the job settles', async () => {
    const { spawn } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0, stdout: 'ok' }).proc)
    const timer = makeInertTimer()
    const jobId = startInstallJob(tmpDir, { spawn, ...timer })

    // Synchronous — `startInstallJob` writes this BEFORE the async job runner
    // ever awaits anything, so it's on disk the instant the call returns.
    const runningRecord = readInstallJobFile(tmpDir)
    expect(runningRecord?.id).toBe(jobId)
    expect(runningRecord?.status).toBe('running')

    await waitForSettle(jobId)

    const doneRecord = readInstallJobFile(tmpDir)
    expect(doneRecord?.status).toBe('done')
    expect(doneRecord?.log).toContain('ok')
  })

  it('resolveInstallJobStatus resolves an orphaned persisted "running" record — no matching in-memory job, simulating a server restart — to "interrupted", never a phantom "running"', () => {
    writeInstallJobFile(orphanRecord({ pid: 424242 }))

    const resolved = resolveInstallJobStatus('orphan-job-id', path.resolve(tmpDir))
    expect(resolved?.status).toBe('interrupted')
    expect(resolved?.warnings.join(' ')).toContain('424242')

    // The correction is written back — a second read sees the same honest answer.
    const onDisk = readInstallJobFile(tmpDir)
    expect(onDisk?.status).toBe('interrupted')
  })

  it('resolveInstallJobStatus leaves an already-terminal persisted record untouched', () => {
    writeInstallJobFile(orphanRecord({ status: 'done', exitCode: 0, finishedAt: Date.now(), warnings: ['pre-existing'] }))

    const resolved = resolveInstallJobStatus('orphan-job-id', path.resolve(tmpDir))
    expect(resolved?.status).toBe('done')
    expect(resolved?.warnings).toEqual(['pre-existing'])
  })

  it('resolveInstallJobStatus returns null when the id matches neither memory nor what is persisted at dir', () => {
    writeInstallJobFile(orphanRecord({ id: 'some-other-job', status: 'done' }))
    expect(resolveInstallJobStatus('completely-unknown-id', path.resolve(tmpDir))).toBeNull()
  })

  it('probeInstallStatus surfaces the persisted job, resolving an orphaned "running" record honestly', () => {
    writeInstallJobFile(orphanRecord({ packageManager: 'npm', log: 'installing…' }))

    const status = probeInstallStatus(tmpDir)
    expect(status.job?.id).toBe('orphan-job-id')
    expect(status.job?.status).toBe('interrupted')
  })
})

// ---------------------------------------------------------------------------
// Route — tryServeStudioInstall
// ---------------------------------------------------------------------------

describe('tryServeStudioInstall', () => {
  function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
    const url = new URL(`http://localhost${pathAndQuery}`)
    const req = new Request(url, init)
    return { req, url, pathname: url.pathname }
  }

  it('404s on an unknown job id', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/install/nonexistent-job-id')
    const res = await tryServeStudioInstall(req, url, pathname)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
  })

  it('rejects install/status for a dir outside studio-workspace/', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'installdeps-outside-'))
    try {
      const { req, url, pathname } = makeRequest(`/admin/api/studio/install/status?dir=${encodeURIComponent(outside)}`)
      const res = await tryServeStudioInstall(req, url, pathname)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(404)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects POST /install for a dir outside studio-workspace/ without starting a job', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'installdeps-outside-post-'))
    try {
      const { req, url, pathname } = makeRequest('/admin/api/studio/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: outside }),
      })
      const res = await tryServeStudioInstall(req, url, pathname)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(404)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('accepts install/status for a dir actually inside studio-workspace/', async () => {
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    const insideDir = fs.mkdtempSync(path.join(root, '__installdeps_test_'))
    try {
      const { req, url, pathname } = makeRequest(`/admin/api/studio/install/status?dir=${encodeURIComponent(insideDir)}`)
      const res = await tryServeStudioInstall(req, url, pathname)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(200)
      const body = await res!.json()
      expect(body).toEqual({
        hasPackageJson: false,
        hasNodeModules: false,
        dependencyCount: 0,
        packageManager: 'bun',
        job: null,
      })
    } finally {
      fs.rmSync(insideDir, { recursive: true, force: true })
    }
  })

  it('400s on an invalid POST body', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: 123 }),
    })
    const res = await tryServeStudioInstall(req, url, pathname)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(400)
  })

  it('returns null for a pathname it does not own', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/load')
    const res = await tryServeStudioInstall(req, url, pathname)
    expect(res).toBeNull()
  })

  it('GET /install/:id?dir= falls back to the persisted record when the id is unknown to THIS process (simulated server restart)', async () => {
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    const insideDir = fs.mkdtempSync(path.join(root, '__installdeps_test_durable_'))
    try {
      writeInstallJobFile({
        id: 'restart-sim-job',
        dir: path.resolve(insideDir),
        packageManager: 'bun',
        status: 'running',
        log: '',
        truncated: false,
        exitCode: null,
        warnings: [],
        startedAt: Date.now(),
        finishedAt: null,
        pid: null,
      })

      const { req, url, pathname } = makeRequest(
        `/admin/api/studio/install/restart-sim-job?dir=${encodeURIComponent(insideDir)}`,
      )
      const res = await tryServeStudioInstall(req, url, pathname)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { status: string; id: string }
      expect(body.id).toBe('restart-sim-job')
      expect(body.status).toBe('interrupted')
    } finally {
      fs.rmSync(insideDir, { recursive: true, force: true })
    }
  })

  it('GET /install/:id still 404s when neither memory nor a dir-resolved disk record has the id', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/install/some-unknown-id-without-dir')
    const res = await tryServeStudioInstall(req, url, pathname)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
  })
})
