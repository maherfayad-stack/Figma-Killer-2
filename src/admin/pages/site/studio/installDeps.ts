/**
 * installDeps — client for the WS-1.4 dependency-install job
 * (`server/handlers/studio/installDeps.ts`). Three calls, all against the
 * currently open project's `dir`:
 *
 *   probeDependencyInstall  → GET  /admin/api/studio/install/status
 *       "should the Install dependencies prompt show at all?" — cheap,
 *       no job started.
 *   startDependencyInstall  → POST /admin/api/studio/install
 *       kicks the job, returns its id immediately.
 *   getDependencyInstallJob → GET  /admin/api/studio/install/:id
 *       one poll of a running/finished job's status + capped log.
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

const InstallJobStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('done'),
  Type.Literal('failed'),
  Type.Literal('timeout'),
])

const InstallProbeResponseSchema = Type.Object({
  hasPackageJson: Type.Boolean(),
  hasNodeModules: Type.Boolean(),
  dependencyCount: Type.Number(),
  packageManager: PackageManagerSchema,
})

const InstallStartResponseSchema = Type.Object({
  jobId: Type.String(),
})

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

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'
export type InstallJobStatus = 'running' | 'done' | 'failed' | 'timeout'
export type InstallProbeStatus = {
  hasPackageJson: boolean
  hasNodeModules: boolean
  dependencyCount: number
  packageManager: PackageManager
}
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

/** One poll of a job's current status/log. */
export async function getDependencyInstallJob(jobId: string): Promise<InstallJob> {
  return apiRequest(`/admin/api/studio/install/${encodeURIComponent(jobId)}`, {
    schema: InstallJobResponseSchema,
  })
}
