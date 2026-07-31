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
 *       → { hasPackageJson, hasNodeModules, dependencyCount, packageManager,
 *           job }
 *       Lets the client decide whether to offer the "Install dependencies"
 *       empty state WITHOUT starting a job — not part of the plan's two-route
 *       sketch, but required to know when to show that prompt at all, and it
 *       lives entirely under this module's own route prefix so it can't
 *       collide with any sibling work order's files. `job` is the last known
 *       install job for this project (or `null`), resolved honestly across a
 *       restart — see `resolvePersistedJobStatus`.
 *   GET  /admin/api/studio/install/:id[?dir=<abs>]  → the job's current
 *       status/log. `dir` is optional but should always be sent — it's the
 *       durability fallback to `.studio/install-job.json` when this
 *       process's own in-memory registry has no memory of the job (e.g. a
 *       `bun --watch` restart since the job started).
 *
 * Jobs live in an in-memory `Map<jobId, JobRecord>` while THIS process can
 * observe them — but the dev server runs under `bun --watch`, so any file
 * edit restarts the process and empties that map. Every job is ALSO mirrored
 * to `<appRoot>/.studio/install-job.json` (`installJobStore.ts`) at start and
 * at completion, so a restart mid-install doesn't strand the client polling a
 * `jobId` that 404s forever. A record found on disk with no matching
 * in-memory entry (the process that owned it is gone) resolves to the
 * terminal `'interrupted'` status — never a phantom `'running'` — see
 * `resolveInstallJobStatus`/`resolvePersistedJobStatus` below. The install
 * SUBPROCESS itself, once spawned, is independent of this server process and
 * may keep running regardless of what this file can observe; `.studio/
 * install-job.json` is a durability net for the JOB'S REPORTED STATUS, not a
 * live reattachment mechanism — the truth of whether dependencies actually
 * landed is `probeInstallStatus`'s `hasNodeModules` disk check, which this
 * module's `job` field is deliberately paired with in the status response.
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
 *   - `cwd` is the project's resolved APP ROOT (`approot-01` —
 *     `resolveAppRoot`, `./appRoot.ts`; `''` app root means "the project
 *     directory itself," so this is a no-op for the overwhelmingly common
 *     case), which is itself real-path containment-checked to sit inside the
 *     project directory. The project directory is, in turn, checked for
 *     containment under `studio-workspace/` (symlink-resolved, same
 *     belt-and-braces pattern as `studioAsset.ts`) before a job is ever
 *     started — never the Studio repo's own root, which would otherwise let
 *     an install rewrite this repo's own lockfile. Neither guard is weakened
 *     by the other; they compose.
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
import { resolveAppRoot } from './appRoot'
import { captureSubprocess, minimalSubprocessEnv, type SpawnedProcessLike } from './subprocessRunner'
import { readInstallJobFile, writeInstallJobFile, type PersistedInstallJob } from './installJobStore'
import { reprobeProjectProfile } from './projectProbe'

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
  /**
   * The most recently known install job for this project's app root,
   * resolved honestly (an orphaned `'running'` record from a process that no
   * longer exists resolves to `'interrupted'`, never a phantom `'running'`
   * forever) — `null` when no install has ever been attempted here. Answers
   * "is a completed-then-restarted install still reported correctly?"
   * together with `hasNodeModules` above: the disk fact settles whether
   * dependencies actually landed, `job` settles what happened to the LAST
   * attempt.
   */
  job: PublicInstallJob | null
}

/** `dir` is the PROJECT directory — resolved to its app root (`approot-01`) internally, so a nested `package.json`/`node_modules` (e.g. `journey-screens/`) is reported honestly instead of always reading the project root. */
export function probeInstallStatus(dir: string): InstallProbeStatus {
  const root = resolveAppRoot(dir)
  const pkgPath = join(root, 'package.json')
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
    hasNodeModules: existsSync(join(root, 'node_modules')),
    dependencyCount,
    packageManager: detectPackageManager(root),
    job: resolvePersistedJobStatus(root),
  }
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

/** `'interrupted'` is only ever produced by `resolvePersistedJobStatus` — a job this process has no live memory of, found `'running'` in a stale `.studio/install-job.json` from a process that no longer exists. */
export type InstallJobStatus = 'running' | 'done' | 'failed' | 'timeout' | 'interrupted'

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
  /** Recorded for the persisted record's forensic value only — see `SpawnedProcessLike.pid`'s doc. */
  pid: number | null
}

/** In-memory, per-process job registry — the fast path while this process is the one that started the job. See the module doc for the `.studio/install-job.json` durability net that backs it up. */
const jobs = new Map<string, JobRecord>()

/** A live `JobRecord`'s `status` is never actually `'interrupted'` (only a re-read, orphaned persisted record can be), but the two status unions are otherwise identical, so this is a plain field copy. */
function toPersistedRecord(job: JobRecord): PersistedInstallJob {
  const { id, dir, packageManager, status, log, truncated, exitCode, warnings, startedAt, finishedAt, pid } = job
  return { id, dir, packageManager, status, log, truncated, exitCode, warnings, startedAt, finishedAt, pid }
}

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
    // A successful install is the exact moment the install-DEPENDENT half of
    // the profile becomes knowable: `componentPackages` (which packages ship
    // React components) is detected by reading `node_modules`, so a profile
    // probed before this point reports none — permanently, since the probe
    // otherwise only ever runs at import. That left every imported project
    // with zero registered package components and no error anywhere, which is
    // why an `@alm-design/design-system` `<ActionSheet>` rendered as bare
    // unstyled text on the board.
    //
    // Failure here must not fail the install: the job DID succeed, and
    // `resolveProjectProfile` heals a stale cache on the next read anyway.
    // This re-probe is the fast path, not the only path.
    try {
      reprobeProjectProfile(job.dir)
    } catch (err) {
      console.error('[studio:install] post-install re-probe failed:', err)
    }
  } else {
    job.status = 'failed'
  }
  // Terminal write — the durability net a restart falls back to.
  writeInstallJobFile(toPersistedRecord(job))
}

/**
 * Starts an install job for `dirInput` — the PROJECT directory, already
 * resolved/containment-checked by the caller (this function does not
 * re-check that part, so it stays cheap to drive directly from tests) — and
 * returns the new job's id immediately. `dirInput` is further resolved to its
 * app root (`approot-01` — `resolveAppRoot`, real-path containment-checked
 * against `dirInput` internally, never weakened here) before anything spawns:
 * the package manager runs where `package.json` actually lives, which for
 * the overwhelmingly common case (app root === project dir) is a no-op. The
 * spawn + stream pump + timeout race run in the background; nothing here
 * blocks the caller.
 */
export function startInstallJob(dirInput: string, overrides: InstallJobOverrides = {}): string {
  const projectDir = resolve(dirInput)
  const cwd = resolveAppRoot(projectDir)
  const packageManager = detectPackageManager(cwd)
  const argv = INSTALL_ARGV[packageManager]
  const spawn = overrides.spawn ?? defaultSpawn
  const proc = spawn(argv, { cwd, env: installSubprocessEnv(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })

  const id = crypto.randomUUID()
  const job: JobRecord = {
    id,
    dir: cwd,
    packageManager,
    status: 'running',
    log: '',
    truncated: false,
    exitCode: null,
    warnings: [],
    startedAt: Date.now(),
    finishedAt: null,
    pid: proc.pid ?? null,
  }
  jobs.set(id, job)
  // Initial write — if the process dies before `runInstallJob` ever writes a
  // terminal record, `resolvePersistedJobStatus` still finds THIS record on
  // the next status query and correctly resolves it to 'interrupted' rather
  // than a job no one has ever heard of.
  writeInstallJobFile(toPersistedRecord(job))

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
    writeInstallJobFile(toPersistedRecord(job))
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

function toPublicJob(job: JobRecord): PublicInstallJob {
  const { id, dir, packageManager, status, log, truncated, exitCode, warnings } = job
  return { id, dir, packageManager, status, log, truncated, exitCode, warnings }
}

function toPublicJobFromPersisted(job: PersistedInstallJob): PublicInstallJob {
  const { id, dir, packageManager, status, log, truncated, exitCode, warnings } = job
  return { id, dir, packageManager, status, log, truncated, exitCode, warnings }
}

/** `null` for an unknown job id — the route maps that to a 404. In-memory only: does NOT fall back to the persisted `.studio/install-job.json` record — see `resolveInstallJobStatus` for the durable lookup a restart needs. Kept separate (and still exported) because `waitForSettle`-shaped test/internal callers want the strict "this process's own live registry" answer, with no disk I/O. */
export function getInstallJob(id: string): PublicInstallJob | null {
  const job = jobs.get(id)
  return job ? toPublicJob(job) : null
}

/**
 * The one place that reconciles "found in memory" vs. "found on disk, but
 * the process that started it is gone." `appRoot` is the job's own spawn
 * `cwd` (`resolveAppRoot`'s result, already resolved/containment-checked by
 * the caller) — where `.studio/install-job.json` lives.
 *
 * - In-memory hit: return it live (this IS the process that owns the job;
 *   its log/status are still growing).
 * - Not in memory, nothing persisted: `null` (no install has ever run here).
 * - Not in memory, persisted `'running'`: the process that owned it is gone
 *   — this can NEVER become `'done'`/`'failed'`/`'timeout'` from this
 *   process's point of view, so resolve to `'interrupted'` (write the
 *   correction back, so repeated queries don't recompute it) rather than
 *   report a phantom `'running'` the client would poll forever.
 * - Not in memory, persisted terminal status: return it as-is — a genuinely
 *   completed job surviving a restart, reported truthfully.
 */
function resolvePersistedJobStatus(appRoot: string): PublicInstallJob | null {
  const persisted = readInstallJobFile(appRoot)
  if (!persisted) return null

  const live = jobs.get(persisted.id)
  if (live) return toPublicJob(live)

  if (persisted.status !== 'running') return toPublicJobFromPersisted(persisted)

  const interrupted: PersistedInstallJob = {
    ...persisted,
    status: 'interrupted',
    finishedAt: persisted.finishedAt ?? Date.now(),
    warnings: [
      ...persisted.warnings,
      `The server restarted while this install was running${persisted.pid !== null ? ` (pid ${persisted.pid})` : ''} — its outcome could not be observed. Check whether dependencies actually landed, then retry if not.`,
    ],
  }
  writeInstallJobFile(interrupted)
  return toPublicJobFromPersisted(interrupted)
}

/** By-id lookup with the disk fallback: in-memory first, then `.studio/install-job.json` under `appRootDir` (already resolved + containment-checked by the caller) when `appRootDir` is given and the id matches what's persisted there. `null` maps to a 404 at the route. */
export function resolveInstallJobStatus(id: string, appRootDir?: string): PublicInstallJob | null {
  const live = getInstallJob(id)
  if (live) return live
  if (!appRootDir) return null
  const resolved = resolvePersistedJobStatus(appRootDir)
  return resolved && resolved.id === id ? resolved : null
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
    // `dir` is optional here (the in-memory fast path needs nothing) — only
    // consulted to find `.studio/install-job.json` when THIS process has no
    // live memory of the job (e.g. it restarted since the job started). A
    // malformed/unsafe `dir` degrades to the in-memory-only lookup rather
    // than 404ing the whole request over an optional param.
    let appRootDir: string | undefined
    const dirParam = url.searchParams.get('dir')
    if (dirParam) {
      try {
        const dir = resolveProjectDir(dirParam)
        if (isDirWithinWorkspace(dir)) appRootDir = resolveAppRoot(dir)
      } catch {
        // fall through with appRootDir left undefined
      }
    }
    const job = resolveInstallJobStatus(id, appRootDir)
    if (!job) return new Response('Not found', { status: 404 })
    return jsonResponse(job)
  }

  return null
}
