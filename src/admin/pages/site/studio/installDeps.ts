/**
 * installDeps — client for the WS-1.4 dependency-install job
 * (`server/handlers/studio/installDeps.ts`). Three calls, all against the
 * currently open project's `dir`:
 *
 *   probeDependencyInstall  → GET  /admin/api/studio/install/status
 *       "should the Install dependencies prompt show at all?" — cheap,
 *       no job started. Also carries the last known `job` for this project
 *       (`infra-01`), resolved honestly across a server restart — see that
 *       field's doc below.
 *   startDependencyInstall  → POST /admin/api/studio/install
 *       kicks the job, returns its id immediately.
 *   getDependencyInstallJob → GET  /admin/api/studio/install/:id?dir=<dir>
 *       one poll of a running/finished job's status + capped log. `dir` is
 *       optional but should always be passed — it's the durability fallback:
 *       if the server restarted since the job started (its in-process job
 *       registry is per-process, not persisted — `bun --watch` restarts on
 *       every file edit), this is what lets the server find the job's
 *       `.studio/install-job.json` record instead of 404ing forever.
 *
 * A real install is 30s-3min — callers own the polling loop (a plain
 * `setInterval`, cleared on unmount/terminal status); this module never
 * blocks waiting for a job to finish.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'

const PackageManagerSchema = Type.Union([
  Type.Literal('bun'),
  Type.Literal('pnpm'),
  Type.Literal('yarn'),
  Type.Literal('npm'),
])

/**
 * `'interrupted'` is a terminal status a job can ONLY arrive at via a server
 * restart mid-install (see `resolvePersistedJobStatus` server-side) — the
 * server lost its live handle on the subprocess and can no longer observe
 * (or report) how it actually ended. Treat it like `'failed'`/`'timeout'`:
 * stop polling, surface it, let the user retry.
 */
const InstallJobStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('done'),
  Type.Literal('failed'),
  Type.Literal('timeout'),
  Type.Literal('interrupted'),
])

const InstallJobResponseSchema = Type.Object({
  id: Type.String(),
  dir: Type.String(),
  packageManager: PackageManagerSchema,
  status: InstallJobStatusSchema,
  log: Type.String(),
  truncated: Type.Boolean(),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  warnings: Type.Array(Type.String()),
})

const InstallProbeResponseSchema = Type.Object({
  hasPackageJson: Type.Boolean(),
  hasNodeModules: Type.Boolean(),
  dependencyCount: Type.Number(),
  packageManager: PackageManagerSchema,
  /** The last known job for this project's app root, or `null` if none has ever run — lets a fresh mount (page reload, or a server restart) notice and resume a still-`'running'` job instead of silently offering "Install dependencies" again over a job that's already in flight. */
  job: Type.Union([InstallJobResponseSchema, Type.Null()]),
})

const InstallStartResponseSchema = Type.Object({
  jobId: Type.String(),
})

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'
export type InstallJobStatus = 'running' | 'done' | 'failed' | 'timeout' | 'interrupted'
export type InstallJob = {
  id: string
  dir: string
  packageManager: PackageManager
  status: InstallJobStatus
  log: string
  truncated: boolean
  exitCode: number | null
  warnings: string[]
}
export type InstallProbeStatus = {
  hasPackageJson: boolean
  hasNodeModules: boolean
  dependencyCount: number
  packageManager: PackageManager
  job: InstallJob | null
}

/** Cheap check — does the active project have deps to install, with none installed yet? No job is started. */
export async function probeDependencyInstall(dir?: string): Promise<InstallProbeStatus> {
  return apiRequest('/admin/api/studio/install/status', {
    schema: InstallProbeResponseSchema,
    query: dir ? { dir } : undefined,
  })
}

/** Starts the install job; returns its id for polling via {@link getDependencyInstallJob}. */
export async function startDependencyInstall(dir?: string): Promise<string> {
  const { jobId } = await apiRequest('/admin/api/studio/install', {
    method: 'POST',
    body: { dir },
    schema: InstallStartResponseSchema,
  })
  return jobId
}

/** One poll of a job's current status/log. Pass `dir` whenever it's known — see the module doc for why it's the restart-durability fallback, not an optional nicety. */
export async function getDependencyInstallJob(jobId: string, dir?: string): Promise<InstallJob> {
  return apiRequest(`/admin/api/studio/install/${encodeURIComponent(jobId)}`, {
    schema: InstallJobResponseSchema,
    query: dir ? { dir } : undefined,
  })
}
