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
 * - **A target another job owns refuses too.** `git clone` is what creates the
 *   directory, so "it does not exist yet" is not a lock — two jobs for one
 *   repository would both pass that check. `inFlightTargets` holds the name for
 *   the life of the job, which is what makes the failure cleanup below safe:
 *   nothing at `target` can have come from anywhere but this job.
 * - **Containment is checked on the real path** after the clone, before the
 *   directory is reported back — a `.git` arriving from a hostile repository
 *   cannot relocate the target, but the check costs nothing and it is the rule.
 * - **The credential is the signed-in user's**, resolved from the session by
 *   the route and handed over through `runGit`'s one-shot askpass (G2). Never
 *   in argv, never in the URL, never in the environment.
 *
 * ## A cloned `.studio/`: links are removed, plain files kept
 *
 * `.studio/` is where Studio keeps its own records, and most of them are meant
 * to be committed (`boards.json`, `comments.json`, `prototype.json`), so a
 * clone of a Studio project brings its `.studio/` along. git stores symlinks,
 * so a hostile repository can also bring `.studio -> ~` or
 * `.studio/boards.json -> ~/.bashrc`: every later store write would land
 * there, and the thumbnail and share routes would serve from there.
 *
 * Decision: **replace, not refuse.** Right after the clone and before Studio
 * writes anything, `stripStudioStoreLinks` removes every link in the clone's
 * `.studio/` — the folder itself if it is one, and any entry at any depth
 * inside a real one — as a link, never following it. Every plain file stays,
 * so cloning your own project back keeps its board. Refusing was the
 * alternative: it leaves the user unable to import a repository whose only
 * problem is a stray link, for no safety gain, because nothing a link could
 * point Studio at survives the removal. And `studioStore.ts` refuses a link
 * on every read and write anyway, so a link that appears later (a `git pull`)
 * fails closed instead of being followed. The zipball import never had the
 * problem: it drops every `.studio/` entry (`archiveIngest.ts`), and an
 * archive entry lands as bytes, never as a link.
 *
 * Share state is the one committed record that is dropped outright:
 * `shares.json` and `shares/` hold bearer tokens this server minted, so a
 * cloned one is a token its author knows (`dropShareState`).
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
import { stripStudioStoreLinks } from './studioStore'
import { dropShareState } from './shareStore'
import type { SubprocessSpawnFn } from './subprocessRunner'
import { isRealpathStrictlyInsideAllowingMissing } from './workspacePackageResolve'

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

/**
 * Targets a clone job currently owns.
 *
 * `existsSync(target)` alone is not a lock: `git clone` creates the directory,
 * not Studio, so two jobs for the SAME repository both see a free target, both
 * spawn git into it, and the loser's failure handler then deletes the winner's
 * work — including a clone that had already finished and been reported as a
 * project. (Two clicks on Connect, or a client that retried, is enough.)
 *
 * Holding the name for the life of the job makes "nothing at `target` existed
 * when this job started, and nothing else may put anything there" true, which
 * is exactly the premise the cleanup below relies on before it removes
 * anything.
 */
const inFlightTargets = new Set<string>()

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
  // something already on disk, and must never delete it. Sound only because
  // this job holds `target` in `inFlightTargets` — see that set's doc.
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
    // `isRealpathStrictlyInsideAllowingMissing` checks the deepest existing
    // ancestor's REAL path, which is the workspace root, so a symlinked root
    // cannot redirect the clone, and refuses the root itself. The archive
    // import's target-clearing funnel (`archiveIngest.ts`) uses the same
    // helper. (`assertWithinWorkspace` answers `false` for a missing path by
    // construction, which is right for its own callers and wrong here.)
    if (!isRealpathStrictlyInsideAllowingMissing(target, resolve(projectsRootDir()))) {
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

    // The repository's own `.studio/`, made link-free BEFORE Studio writes a
    // single record into it — see "A cloned `.studio/`" in the module doc.
    const stripped = stripStudioStoreLinks(target)
    if (stripped.rootReplaced || stripped.removed.length > 0) {
      console.warn(
        `[studio/gitClone] removed links from the cloned repository's .studio folder (${stripped.rootReplaced ? 'the folder itself' : `${stripped.removed.length} entr${stripped.removed.length === 1 ? 'y' : 'ies'}`})`,
      )
    }
    // Share tokens are capabilities THIS server mints. One that arrived in a
    // repository is a token the repository's author knows: kept, it would
    // resolve on the public share route at once, and "Update" would photograph
    // this user's board into it.
    dropShareState(target)

    job.phase = 'probing'

    // Same aftermath as the zipball import, so both paths end on the same
    // summary screen. `writeProjectMeta` is safe to write unconditionally: the
    // directory did not exist a moment ago, and it REPLACES any `meta.json`
    // the repository shipped — trust tier and approved MCP servers included.
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
  } finally {
    // Released only now: while the job runs, the name belongs to it, and a
    // second request for the same repository is a refusal rather than a race.
    inFlightTargets.delete(target)
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
  const target = cloneTargetDir(remote)
  const job: CloneJob = {
    id: randomUUID(),
    phase: 'cloning',
    startedAt: now,
    finishedAt: null,
    summary: null,
    error: null,
  }
  jobs.set(job.id, job)

  // Refused here too, not only at the route: a second job for a target another
  // job owns would spawn git into a directory git is already filling, fail
  // with "already exists and is not an empty directory", and then take the
  // FIRST job's clone with it on cleanup. Everything from here to the `add` is
  // synchronous, so no request can interleave.
  if (inFlightTargets.has(target)) {
    job.phase = 'failed'
    job.error = `A clone into "${githubProjectFolderName(remote)}" is already running. Wait for it to finish.`
    job.finishedAt = now
    return job
  }
  inFlightTargets.add(target)

  // Deliberately not awaited — the route answers with the id immediately, and
  // `runCloneJob` catches everything, so there is no unhandled rejection.
  void runCloneJob(job, remote, credential, deps)
  return job
}

/** The job with this id, or `null` once it has been pruned (or after a server restart — the launcher listing is then the honest answer). */
export function readGitCloneJob(id: string): CloneJob | null {
  return jobs.get(id) ?? null
}

/**
 * Refuses up front when a project with the derived name is already on disk —
 * or when another clone job is already filling that name — so the client is
 * told before a job exists rather than through a poll.
 *
 * The second half is the one that is easy to miss: `git clone` is what creates
 * the directory, so between "the target is free" and "git has made it" there
 * is a window in which a second request also sees it free.
 */
export function cloneTargetIsFree(remote: GithubRemote): boolean {
  const target = cloneTargetDir(remote)
  return !inFlightTargets.has(target) && !existsSync(target)
}

/** Test-only: empties the registry between cases so a leaked job cannot make a later assertion pass. */
export function clearGitCloneJobsForTest(): void {
  jobs.clear()
  inFlightTargets.clear()
}
