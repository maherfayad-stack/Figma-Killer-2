/**
 * installDeps — WS-1.4: `bun install` (or the detected package manager) as a
 * polled job, never a blocking request. An imported repo has no
 * `node_modules`, so package CSS, Tailwind, package components, and the
 * already-shipped `?raw` package-icon resolution all silently resolve to
 * nothing until this runs — but a real install can take 30 s to 3 minutes,
 * which is not something an HTTP request should sit inside.
 *
 *   POST /admin/api/studio/install          body: { dir }  → { jobId }
 *   GET  /admin/api/studio/install/status?dir=<abs>
 *       → { hasPackageJson, hasNodeModules, dependencyCount, packageManager }
 *       Lets the client decide whether to offer the "Install dependencies"
 *       empty state WITHOUT starting a job — not part of the plan's two-route
 *       sketch, but required to know when to show that prompt at all, and it
 *       lives entirely under this module's own route prefix so it can't
 *       collide with any sibling work order's files.
 *   GET  /admin/api/studio/install/:id      → the job's current status/log
 *
 * Jobs are an in-memory `Map<jobId, JobRecord>`, **per-process, not
 * persisted**. A server restart loses in-flight job status (the install
 * itself, once spawned, is a detached OS process and keeps running — only the
 * client's ability to poll its result is lost). This is deliberate: Studio
 * state lives on disk, and an install job is a transient action, not
 * something to invent a persistence story for.
 *
 * Safety (see `.claude/agents/security-guard.md` "Subprocesses" — binding on
 * this module):
 *   - `Bun.spawn` with an argv array — never a shell string, never string
 *     interpolation of anything caller-supplied.
 *   - `--ignore-scripts` is always present, for every detected package
 *     manager, and is NOT a request option. A postinstall script is arbitrary
 *     code execution, and it must not run before the user has consented to a
 *     trust tier that allows it (`meta-03` decision 1 in STATE.md: a fresh
 *     import stays Tier 0). Packages that commonly need a postinstall step
 *     (`sharp`, `esbuild`, …) are surfaced as a warning string in the job
 *     result instead — re-running WITH scripts is a separate, explicitly
 *     confirmed action (not built here) that promotes the project to Tier 1.
 *   - `cwd` is always the resolved project directory, checked for containment
 *     under `studio-workspace/` (symlink-resolved, same belt-and-braces
 *     pattern as `studioAsset.ts`) — never the Studio repo's own root, which
 *     would otherwise let an install rewrite this repo's own lockfile.
 *   - `env` is `subprocessRunner.ts`'s `minimalSubprocessEnv`, never
 *     `process.env` forwarded wholesale (`sec-01`) — a package manager's own
 *     child process (dependency resolution, any script that DOES run despite
 *     `--ignore-scripts`, e.g. a package's own `bin` invoked directly) must
 *     not be able to read `STUDIO_SECRET_KEY`, `DATABASE_URL`, or an AI
 *     provider key out of this server's environment. The extra keys beyond
 *     the base set (`APPDATA`/`LOCALAPPDATA`/`npm_config_cache`) are what a
 *     real npm/pnpm/yarn/bun install needs to find its own cache/config —
 *     omitting them wouldn't leak anything, but would make installs behave
 *     unpredictably across hosts.
 *   - 5-minute timeout; the process is killed and the job marked `timeout`.
 *   - stdout/stderr are capped (`DEFAULT_MAX_LOG_BYTES`, each independently)
 *     via `subprocessRunner.ts`'s shared `captureSubprocess` — a runaway
 *     install cannot grow a job's log without bound. The log says so when it
 *     happens.
 *   - Package manager detection reads only lockfile presence in `dir`; it
 *     never shells out, never reads `PATH`, never trusts a client-supplied
 *     package manager name.
 *
 * `startInstallJob` and the timing/spawn primitives it uses are injectable
 * (`InstallJobOverrides`) so tests can assert on the exact argv/cwd/env
 * passed to "spawn" and simulate a timeout deterministically, without
 * touching the network, a real subprocess, or the wall clock — see
 * `server/handlers/__tests__/installDeps.test.ts`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { captureSubprocess, minimalSubprocessEnv, type SpawnedProcessLike } from './subprocessRunner'

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

/** Checked in order; the first lockfile present wins. */
const LOCKFILE_MANAGERS: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
]

/** No lockfile present (or an unrecognized one) defaults to `bun` — this project's own toolchain. */
export function detectPackageManager(dir: string): PackageManager {
  for (const { file, manager } of LOCKFILE_MANAGERS) {
    if (existsSync(join(dir, file))) return manager
  }
  return 'bun'
}

/** `--ignore-scripts` is mandatory for every manager — never conditional, never wire-configurable. */
const INSTALL_ARGV: Record<PackageManager, string[]> = {
  bun: ['bun', 'install', '--ignore-scripts'],
  pnpm: ['pnpm', 'install', '--ignore-scripts'],
  yarn: ['yarn', 'install', '--ignore-scripts'],
  npm: ['npm', 'install', '--ignore-scripts'],
}

// ---------------------------------------------------------------------------
// Postinstall-prone package warnings
// ---------------------------------------------------------------------------

/** Packages that commonly ship a postinstall step `--ignore-scripts` will have skipped. */
const POSTINSTALL_PRONE_PACKAGES = new Set([
  'sharp',
  'esbuild',
  'puppeteer',
  'puppeteer-core',
  'playwright',
  'playwright-core',
  'canvas',
  'better-sqlite3',
  'sqlite3',
  'node-sass',
  'bcrypt',
  'fsevents',
  'cypress',
])

function readPackageJsonDependencyNames(dir: string): string[] {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return []
    const names = new Set<string>()
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const value = (parsed as Record<string, unknown>)[field]
      if (value && typeof value === 'object') {
        for (const name of Object.keys(value)) names.add(name)
      }
    }
    return [...names]
  } catch {
    return [] // malformed package.json — nothing to warn about, the install itself already ran
  }
}

function detectPostinstallWarnings(dir: string): string[] {
  const flagged = readPackageJsonDependencyNames(dir).filter((name) => POSTINSTALL_PRONE_PACKAGES.has(name))
  if (flagged.length === 0) return []
  return [
    `${flagged.join(', ')} ${flagged.length === 1 ? 'is' : 'are'} commonly shipped with a postinstall step, ` +
      'which --ignore-scripts skipped. If the app misbehaves at runtime, re-installing with scripts enabled ' +
      '(a separate, explicitly-confirmed action) may resolve it.',
  ]
}

// ---------------------------------------------------------------------------
// Workspace containment
// ---------------------------------------------------------------------------

/**
 * True when `dir` exists and sits at-or-under `studio-workspace/`, checked
 * lexically first (cheap traversal reject) and then again on the
 * symlink-resolved real path — a repo can arrive from GitHub and git stores
 * symlinks, so a textual check alone is bypassable. Same pattern as
 * `studioAsset.ts`'s asset containment guard.
 */
function isDirWithinWorkspace(dir: string): boolean {
  const root = resolve(projectsRootDir())
  const target = resolve(dir)
  if (target !== root && !target.startsWith(root + sep)) return false
  if (!existsSync(target)) return false
  try {
    const realTarget = realpathSync(target)
    const realRoot = existsSync(root) ? realpathSync(root) : root
    return realTarget === realRoot || realTarget.startsWith(realRoot + sep)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Install probe — "should we offer the Install dependencies empty state?"
// ---------------------------------------------------------------------------

export interface InstallProbeStatus {
  hasPackageJson: boolean
  hasNodeModules: boolean
  dependencyCount: number
  packageManager: PackageManager
}

export function probeInstallStatus(dir: string): InstallProbeStatus {
  const pkgPath = join(dir, 'package.json')
  let hasPackageJson = false
  let dependencyCount = 0
  if (existsSync(pkgPath)) {
    hasPackageJson = true
    try {
      const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && 'dependencies' in parsed) {
        const deps = (parsed as Record<string, unknown>).dependencies
        if (deps && typeof deps === 'object') dependencyCount = Object.keys(deps).length
      }
    } catch {
      // malformed package.json — still report hasPackageJson, zero deps
    }
  }
  return {
    hasPackageJson,
    hasNodeModules: existsSync(join(dir, 'node_modules')),
    dependencyCount,
    packageManager: detectPackageManager(dir),
  }
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

export type InstallJobStatus = 'running' | 'done' | 'failed' | 'timeout'

/** The minimal shape `startInstallJob` needs from a spawned child process — real `Bun.spawn` output already satisfies it. Re-exported shape from `subprocessRunner.ts` so existing call sites/tests keep their own name for it. */
export type InstallSpawnedProcess = SpawnedProcessLike

export type InstallSpawnFn = (
  argv: string[],
  options: { cwd: string; env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'; stdin: 'ignore' },
) => InstallSpawnedProcess

const defaultSpawn: InstallSpawnFn = (argv, options) =>
  Bun.spawn(argv, options) as unknown as InstallSpawnedProcess

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
/** Cap per job, per stream (stdout/stderr each capped independently by `subprocessRunner.ts`'s `captureSubprocess`). Generous for a real install log, bounded against a runaway process. */
const DEFAULT_MAX_LOG_BYTES = 200_000

/** Beyond `subprocessRunner.ts`'s cross-platform base env, a real package manager install additionally wants its own cache/config dirs resolvable. Nothing here is a secret — omitting these would just make installs behave unpredictably across hosts, not leak anything. */
const INSTALL_ENV_EXTRA_KEYS = ['APPDATA', 'LOCALAPPDATA', 'npm_config_cache'] as const

function installSubprocessEnv(): Record<string, string> {
  return minimalSubprocessEnv(INSTALL_ENV_EXTRA_KEYS)
}

export interface InstallJobOverrides {
  /** Test seam — defaults to `Bun.spawn`. */
  spawn?: InstallSpawnFn
  timeoutMs?: number
  maxLogBytes?: number
  /** Test seam — inject to assert/trigger the timeout deterministically, without a real wait. */
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

interface JobRecord {
  id: string
  dir: string
  packageManager: PackageManager
  status: InstallJobStatus
  log: string
  truncated: boolean
  exitCode: number | null
  warnings: string[]
  startedAt: number
  finishedAt: number | null
}

/** In-memory, per-process job registry. See the module doc for why this is intentionally not persisted. */
const jobs = new Map<string, JobRecord>()

async function runInstallJob(
  job: JobRecord,
  proc: InstallSpawnedProcess,
  opts: { timeoutMs: number; maxLogBytes: number; setTimeoutImpl: typeof setTimeout; clearTimeoutImpl: typeof clearTimeout },
): Promise<void> {
  const result = await captureSubprocess(proc, {
    timeoutMs: opts.timeoutMs,
    maxStdoutBytes: opts.maxLogBytes,
    maxStderrBytes: opts.maxLogBytes,
    setTimeoutImpl: opts.setTimeoutImpl,
    clearTimeoutImpl: opts.clearTimeoutImpl,
  })

  job.log = result.stdout + result.stderr
  job.truncated = result.stdoutTruncated || result.stderrTruncated
  job.exitCode = result.exitCode
  job.finishedAt = Date.now()
  if (result.timedOut) {
    job.status = 'timeout'
  } else if (result.exitCode === 0) {
    job.status = 'done'
    job.warnings = detectPostinstallWarnings(job.dir)
  } else {
    job.status = 'failed'
  }
}

/**
 * Starts an install job for `dirInput` (already resolved/containment-checked
 * by the caller — this function does not re-check, so it stays cheap to
 * drive directly from tests) and returns the new job's id immediately. The
 * spawn + stream pump + timeout race run in the background; nothing here
 * blocks the caller.
 */
export function startInstallJob(dirInput: string, overrides: InstallJobOverrides = {}): string {
  const dir = resolve(dirInput)
  const packageManager = detectPackageManager(dir)
  const argv = INSTALL_ARGV[packageManager]
  const spawn = overrides.spawn ?? defaultSpawn
  const proc = spawn(argv, { cwd: dir, env: installSubprocessEnv(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })

  const id = crypto.randomUUID()
  const job: JobRecord = {
    id,
    dir,
    packageManager,
    status: 'running',
    log: '',
    truncated: false,
    exitCode: null,
    warnings: [],
    startedAt: Date.now(),
    finishedAt: null,
  }
  jobs.set(id, job)

  const opts = {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxLogBytes: overrides.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
    setTimeoutImpl: overrides.setTimeoutImpl ?? setTimeout,
    clearTimeoutImpl: overrides.clearTimeoutImpl ?? clearTimeout,
  }

  void runInstallJob(job, proc, opts).catch((err) => {
    console.error('[studio:install]', err)
    job.status = 'failed'
    job.finishedAt = Date.now()
  })

  return id
}

export interface PublicInstallJob {
  id: string
  dir: string
  packageManager: PackageManager
  status: InstallJobStatus
  log: string
  truncated: boolean
  exitCode: number | null
  warnings: string[]
}

/** `null` for an unknown job id — the route maps that to a 404. */
export function getInstallJob(id: string): PublicInstallJob | null {
  const job = jobs.get(id)
  if (!job) return null
  const { id: jobId, dir, packageManager, status, log, truncated, exitCode, warnings } = job
  return { id: jobId, dir, packageManager, status, log, truncated, exitCode, warnings }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const InstallBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
})

const INSTALL_ROUTE = '/admin/api/studio/install'
const INSTALL_STATUS_ROUTE = `${INSTALL_ROUTE}/status`

export async function tryServeStudioInstall(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname === INSTALL_STATUS_ROUTE && req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      if (!isDirWithinWorkspace(dir)) return new Response('Not found', { status: 404 })
      return jsonResponse(probeInstallStatus(dir))
    } catch (err) {
      console.error('[studio:install]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (pathname === INSTALL_ROUTE && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, InstallBodySchema)
      if (!body) return badRequest('invalid install body')
      const dir = resolveProjectDir(body.dir)
      if (!isDirWithinWorkspace(dir)) return new Response('Not found', { status: 404 })
      const jobId = startInstallJob(dir)
      return jsonResponse({ jobId })
    } catch (err) {
      console.error('[studio:install]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname.startsWith(`${INSTALL_ROUTE}/`) && req.method === 'GET') {
    const id = pathname.slice(`${INSTALL_ROUTE}/`.length)
    if (!id || id === 'status') return new Response('Not found', { status: 404 })
    const job = getInstallJob(id)
    if (!job) return new Response('Not found', { status: 404 })
    return jsonResponse(job)
  }

  return null
}
