/**
 * installJobStore — persists the most-recently-started install job for a
 * project to `<appRoot>/.studio/install-job.json`.
 *
 * `installDeps.ts`'s job registry is an in-process `Map`, and the dev server
 * runs under `bun --watch` — every file edit restarts the process, which
 * empties that map. Before this module, a running install's `jobId` became
 * unrecoverable the instant the server restarted: `GET /install/:id` 404'd,
 * the client's poll loop kept firing into a dead end forever (its `.catch`
 * only logs), and from the UI this reads as "the install button did
 * nothing." This module closes that gap with a small, honest sidecar file —
 * the SAME `.studio/` directory `meta.json`/`boards.json`/`framework.json`
 * already live in, per `PROJECT-BRIEF.md`'s "Studio state is filesystem-
 * backed, not a database row."
 *
 * Read is defensive (never throws — same posture as `studioFramework.ts`'s
 * `readStudioFrameworkFile`): a missing or corrupted record just means
 * "nothing known," never a crash. Write is unconditional — this is
 * editor-owned operational state, not user content, so there is no
 * "reject an invalid shape" case to report back to a caller.
 *
 * Only the CURRENT process's own live `jobs` Map is ever polled while an
 * install is actually running — this file is a durability net, not a live
 * status channel. `installDeps.ts`'s `resolveInstallJobStatus` is the one
 * place that reconciles "found in memory" vs. "found on disk, but the
 * process that started it is gone" (see that function's doc for why an
 * orphaned `'running'` record always resolves to `'interrupted'`, never a
 * phantom `'running'` forever).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { safeParseValue } from '@core/utils/typeboxHelpers'

const PackageManagerSchema = Type.Union([
  Type.Literal('bun'),
  Type.Literal('pnpm'),
  Type.Literal('yarn'),
  Type.Literal('npm'),
])

/**
 * `'interrupted'` is the one status a persisted record can carry that a
 * live, in-memory job never does — it exists ONLY as the honest outcome of
 * "this process has no memory of that job" (see `installDeps.ts`'s
 * `resolveInstallJobStatus`).
 */
export const PersistedInstallJobStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('done'),
  Type.Literal('failed'),
  Type.Literal('timeout'),
  Type.Literal('interrupted'),
])
export type PersistedInstallJobStatus = Static<typeof PersistedInstallJobStatusSchema>

export const PersistedInstallJobSchema = Type.Object({
  id: Type.String(),
  /** The app-root directory the job actually spawned in (`resolveAppRoot`'s result) — also where this record itself is written. */
  dir: Type.String(),
  packageManager: PackageManagerSchema,
  status: PersistedInstallJobStatusSchema,
  log: Type.String(),
  truncated: Type.Boolean(),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  warnings: Type.Array(Type.String()),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
  /** Recorded for forensic/debug value only — never used to probe OS process liveness (platform-fragile; a PID can be reused). Surfaced in the `'interrupted'` warning text instead. */
  pid: Type.Union([Type.Number(), Type.Null()]),
})
export type PersistedInstallJob = Static<typeof PersistedInstallJobSchema>

function installJobFile(dir: string): string {
  return join(dir, '.studio', 'install-job.json')
}

/**
 * Reads `<dir>/.studio/install-job.json` — `dir` is the app root the job
 * spawned in. Returns `null` when the file is absent, unparsable, or fails
 * `PersistedInstallJobSchema` — a corrupted sidecar must never crash a
 * status query, it should just mean "nothing durably known," same as a
 * fresh project with no install history at all.
 */
export function readInstallJobFile(dir: string): PersistedInstallJob | null {
  const file = installJobFile(dir)
  if (!existsSync(file)) return null

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }

  const result = safeParseValue(PersistedInstallJobSchema, raw)
  return result.ok ? result.value : null
}

/** Writes `job` to `<job.dir>/.studio/install-job.json`, creating the sidecar dir if needed. Overwrites whatever was there — this file holds only the SINGLE most-recent job for the project (installs are not run concurrently against one project), so there is nothing else to merge with. */
export function writeInstallJobFile(job: PersistedInstallJob): void {
  const file = installJobFile(job.dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(job))
}
