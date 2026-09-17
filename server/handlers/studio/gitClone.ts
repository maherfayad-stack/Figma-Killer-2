/**
 * gitClone — "import this repository **and keep its history**", as a polled
 * job.
 *
 * ## Why this exists beside the zipball import
 *
 * `studioGithubImport.ts` downloads a zipball: fast, needs no `git` on the
 * host, and lands a directory of files with **no `.git`**. That is the right
 * default for "show me this repo on a board". It is the wrong thing entirely
 * for "this is my project now": the user's first commit has no parent, their
 * branch has no upstream, and pushing means pasting a URL into a terminal.
 *
 * A clone lands the same files PLUS the history, the branches, and `origin`
 * already set — so the version-control panel is fully working the moment the
 * board opens. `--filter=blob:none` keeps that affordable: a partial clone
 * fetches the commit graph and only the blobs actually checked out, so a
 * repository with a decade of large assets does not become a gigabyte on disk
 * to show forty screens.
 *
 * ## Safety — the same posture as `runGithubImport`, and the same reasons
 *
 * - **The target is derived server-side, always.** `studio-workspace/<owner>-
 *   <repo>`, from the PARSED owner/repo (`githubProjectFolderName`). There is
 *   no `dir` on this wire and no option here that accepts one.
 * - **The URL is `parseGithubRemoteUrl`'s allowlist**, and the string handed
 *   to git is that function's re-composed URL — not the caller's. git's URL
 *   grammar contains transports that execute (`ext::sh -c …`) and transports
 *   that read this server's own disk (`file://`).
 * - **An existing directory refuses.** Unlike the zipball import, this does
 *   NOT clear its target: `git clone` demands an empty directory, and making
 *   one by deleting a project would be deleting user data to satisfy a button.
 *   A project that is already here is reported as a refusal the user can act
 *   on, and their bytes stay where they are.
 * - **Containment is checked on the real path** after the clone, before the
 *   directory is reported back — a `.git` arriving from a hostile repository
 *   cannot relocate the target, but the check costs nothing and it is the rule.
 * - **The credential is the signed-in user's**, resolved from the session by
 *   the route and handed over through `runGit`'s one-shot askpass (G2). Never
 *   in argv, never in the URL, never in the environment.
 *
 * ## Job shape
 *
 * Identical to `githubImportRoutes.ts`'s, deliberately: `POST` returns a
 * `jobId`, `GET …/status?jobId=` returns the record, and the terminal record
 * carries the same `ImportSummary` the launcher's summary step already
 * renders — so a clone and a zipball import end on the same screen. A clone is
 * minutes of network on a real repository; blocking a request on it would hand
 * every intermediate proxy a request to time out.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { projectsRootDir, writeProjectMeta } from '../studioProjects'
import { buildImportSummary, ImportSummarySchema } from './importSummary'
import { githubProjectFolderName, type GithubRemote } from './gitPaths'
import { assertWithinWorkspace, clientSafeGitError, runGit, GIT_NETWORK_TIMEOUT_MS } from './gitRunner'
import { probeProject } from './projectProbe'
import { mergeStudioMeta } from './studioMeta'
import type { SubprocessSpawnFn } from './subprocessRunner'
import { isRealpathContainedAllowingMissing } from './workspacePackageResolve'

/**
 * A clone has no byte counter Studio can honestly report — git writes its
 * progress to a tty this subprocess does not have — so the phases are the
 * whole truth, and there is deliberately no percentage.
 */
export const CloneJobPhaseSchema = Type.Union([
  Type.Literal('cloning'),
  Type.Literal('probing'),
  Type.Literal('done'),
  Type.Literal('failed'),
])

export const CloneJobSchema = Type.Object({
  id: Type.String(),
  phase: CloneJobPhaseSchema,
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
  /** The summary step's payload — present exactly when `phase === 'done'`. */
  summary: Type.Union([ImportSummarySchema, Type.Null()]),
  /** Failure message — present exactly when `phase === 'failed'`. Client-safe: no filesystem path, no token. */
  error: Type.Union([Type.String(), Type.Null()]),
})
export type CloneJob = Static<typeof CloneJobSchema>

const jobs = new Map<string, CloneJob>()

/** How long a finished job stays pollable — long enough for a client that navigated away, short enough that nothing accumulates. */
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000

function pruneFinishedJobs(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > FINISHED_JOB_TTL_MS) jobs.delete(id)
  }
}

/** A refusal the route turns into a 409 — the request was well-formed and the workspace's state says no. */
export class CloneRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloneRefusal'
  }
}

/**
 * The directory a clone of `remote` will land in. Exported so the route can
 * refuse an already-existing project BEFORE starting a job, and so tests can
 * assert the derivation without cloning.
 */
export function cloneTargetDir(remote: GithubRemote): string {
  return resolve(projectsRootDir(), githubProjectFolderName(remote))
}

export interface GitCloneDeps {
  /** Test seam matching `runGit`'s, so a clone can be driven without a network. */
  spawn?: SubprocessSpawnFn
}

/**
 * Runs one clone to completion, updating its record as it goes. Never throws:
 * the HTTP request that started this was answered long ago.
 */
async function runCloneJob(
  job: CloneJob,
  remote: GithubRemote,
  credential: string | undefined,
  deps: GitCloneDeps,
): Promise<void> {
  const target = cloneTargetDir(remote)
  // Flipped once this job is the thing that may have put bytes at `target`.
  // Guards the cleanup below: a refusal raised BEFORE this point was caused by
  // something already on disk, and must never delete it.
  let mayHaveWritten = false
  try {
    // Re-checked here as well as at the route: the route's check and this one
    // are separated by however long the client waited, and losing a project to
    // a race is not a failure mode worth leaving open.
    if (existsSync(target)) {
      throw new CloneRefusal(
        `A project named "${githubProjectFolderName(remote)}" already exists. Open it, or rename it first — Studio will not overwrite a project directory.`,
      )
    }
    // Containment BEFORE the clone, on a path that does not exist yet:
    // `isRealpathContainedAllowingMissing` checks the deepest existing
    // ancestor's REAL path, which is the workspace root, so a symlinked root
    // cannot redirect the clone. (`assertWithinWorkspace` answers `false` for
    // a missing path by construction, which is right for its own callers and
    // wrong here.)
    if (!isRealpathContainedAllowingMissing(target, resolve(projectsRootDir()))) {
      throw new CloneRefusal('That repository cannot be cloned here.')
    }

    mkdirSync(projectsRootDir(), { recursive: true })
    mayHaveWritten = true

    // git runs in the WORKSPACE ROOT, not in the target — the target does not
    // exist yet. The `--` guards the two positionals, and both are
    // server-derived: `parseGithubRemoteUrl`'s re-composed URL and a folder
    // name built from the parsed owner/repo.
    const clone = await runGit(
      projectsRootDir(),
      ['clone', '--filter=blob:none', '--', remote.url, githubProjectFolderName(remote)],
      { timeoutMs: GIT_NETWORK_TIMEOUT_MS, credential, spawn: deps.spawn },
    )
    if (!clone.ok) {
      throw new CloneRefusal(clientSafeGitError(clone, 'The repository could not be cloned'))
    }

    // Re-checked on the REAL path now that it exists: a repository can carry
    // git-stored symlinks, so "the target I derived" and "the directory that
    // is now on disk" are not the same claim. Nothing is reported back until
    // this passes.
    const landed = assertWithinWorkspace(target)
    if (!landed.ok) throw new CloneRefusal('That repository cannot be cloned here.')

    job.phase = 'probing'

    // Same aftermath as the zipball import, so both paths end on the same
    // summary screen. `writeProjectMeta` is safe to write unconditionally: the
    // directory did not exist a moment ago.
    writeProjectMeta(target, { displayName: remote.repo })
    try {
      mergeStudioMeta(target, { profile: probeProject(target) })
    } catch (probeErr) {
      // Never fatal: a probe failure must not lose a repository that is
      // already safely on disk. The summary reports `framework: null`.
      console.error('[studio/gitClone] post-clone probe failed:', probeErr)
    }

    // A clone reports no per-file counts, and inventing them would be a
    // number the user could check and find wrong. `buildImportSummary` reads
    // the page count back off disk, which is the figure that actually matters.
    job.summary = buildImportSummary(target, { files: 0, skipped: 0 })
    job.phase = 'done'
    job.finishedAt = Date.now()
  } catch (err) {
    console.error('[studio/gitClone]', err)
    // A half-written clone is not a project. Remove it — but ONLY when this
    // job is what created it, so a refusal caused by a pre-existing project
    // can never delete that project.
    if (mayHaveWritten && job.phase === 'cloning') {
      try {
        rmSync(target, { recursive: true, force: true })
      } catch (cleanupErr) {
        console.error('[studio/gitClone] could not remove a partial clone:', cleanupErr)
      }
    }
    job.phase = 'failed'
    job.error = err instanceof Error ? err.message : 'The clone failed.'
    job.finishedAt = Date.now()
  }
}

/**
 * Starts a clone and returns its job id. `url` must already have been parsed
 * by the caller — the parsed value is what is passed, so a raw string cannot
 * reach git through this function.
 */
export function startGitCloneJob(
  remote: GithubRemote,
  credential: string | undefined,
  deps: GitCloneDeps = {},
): CloneJob {
  const now = Date.now()
  pruneFinishedJobs(now)
  const job: CloneJob = {
    id: randomUUID(),
    phase: 'cloning',
    startedAt: now,
    finishedAt: null,
    summary: null,
    error: null,
  }
  jobs.set(job.id, job)
  // Deliberately not awaited — the route answers with the id immediately, and
  // `runCloneJob` catches everything, so there is no unhandled rejection.
  void runCloneJob(job, remote, credential, deps)
  return job
}

/** The job with this id, or `null` once it has been pruned (or after a server restart — the launcher listing is then the honest answer). */
export function readGitCloneJob(id: string): CloneJob | null {
  return jobs.get(id) ?? null
}

/** Refuses up front when a project with the derived name is already on disk, so the client is told before a job exists. */
export function cloneTargetIsFree(remote: GithubRemote): boolean {
  return !existsSync(cloneTargetDir(remote))
}

/** Test-only: empties the registry between cases so a leaked job cannot make a later assertion pass. */
export function clearGitCloneJobsForTest(): void {
  jobs.clear()
}
