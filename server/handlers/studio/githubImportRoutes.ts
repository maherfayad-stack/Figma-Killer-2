/**
 * githubImportRoutes — "paste a GitHub URL" as a POLLED JOB, and the post-
 * import summary both import paths end on.
 *
 *   POST /admin/api/studio/import-github   body: { url, ref?, subdir?, token? }
 *       → { jobId }, immediately. Never waits for the clone.
 *   GET  /admin/api/studio/import-github/status?jobId=<id>
 *       → { job } — phase, bytes downloaded, and on success the
 *         `ImportSummary` the launcher's summary step renders.
 *
 * ## Why this stopped being one blocking request
 *
 * It used to be `await runGithubImport(...)` inside the route, and the whole
 * UI for it was a button that read "Importing…". A real repository takes tens
 * of seconds to fetch and unpack, during which the user has no way to tell a
 * slow clone from a hung one, and any proxy with a shorter idle timeout than
 * the clone turns a working import into an unexplained failure.
 *
 * The shape is `installDeps.ts`'s, deliberately: an in-memory
 * `Map<jobId, record>`, a start route that returns an id, and a status route
 * the client polls. There is no SSE here even though the repo has the idiom
 * (`handlers/cms/plugins/events.ts`) — this stream carries four phase changes
 * and a byte counter, and a poll needs no reconnection story, no heartbeat,
 * and no long-lived socket per import.
 *
 * ## What a restart does, and why there is no sidecar file
 *
 * `installDeps.ts` mirrors its jobs to `.studio/install-job.json` because an
 * install's outcome lives in `node_modules/`, which the client cannot see. An
 * import's outcome IS the project directory: if the server restarts mid-import
 * the launcher listing tells the truth on its next load, so a durability
 * sidecar would only be a second, staler answer to a question the listing
 * already answers. A poll against a forgotten job gets an honest 404 and the
 * client says the import lost its progress channel, not that it failed.
 *
 * ## Safety
 *
 * The token is used inside `runGithubImport` and never stored on the job
 * record — a status poll must not be able to read back the credential that
 * started the import. Nothing here widens `runGithubImport`'s own guards: the
 * target directory is still derived server-side from the parsed owner/repo,
 * still never a caller-supplied path, and the wire fields are still passed
 * explicitly rather than spread (so a future schema field cannot reach that
 * function's internal `dir` option).
 */
import { randomUUID } from 'node:crypto'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { parseGithubRepoUrl, runGithubImport } from '../studioGithubImport'
import { writeProjectMeta } from '../studioProjects'
import { buildImportSummary, ImportSummarySchema } from './importSummary'
import { probeProject } from './projectProbe'
import { mergeStudioMeta } from './studioMeta'

/**
 * Body of POST /admin/api/studio/import-github.
 *
 * There is deliberately no `pagesDir` field any more. It used to be here so an
 * importer could pre-declare where a repo's screens live — but at the moment
 * the form is filled in nobody knows that yet, including Studio, and the field
 * had no UI and no caller. The choice now happens where the information
 * exists: the post-import summary step, against the probe's own ranked
 * `pagesDirCandidates`, through `POST /admin/api/studio/pages-dir`.
 */
const GithubImportBodySchema = Type.Object({
  url: Type.String(),
  ref: Type.Optional(Type.String()),
  subdir: Type.Optional(Type.String()),
  token: Type.Optional(Type.String()),
})

/**
 * Where an import currently is. These are phases, not percentages: only
 * `downloading` has a meaningful magnitude (`receivedBytes`), and inventing a
 * percentage for the other three would be a progress bar that lies.
 */
export const ImportJobPhaseSchema = Type.Union([
  Type.Literal('downloading'),
  Type.Literal('unpacking'),
  Type.Literal('probing'),
  Type.Literal('done'),
  Type.Literal('failed'),
])
export type ImportJobPhase = Static<typeof ImportJobPhaseSchema>

export const ImportJobSchema = Type.Object({
  id: Type.String(),
  phase: ImportJobPhaseSchema,
  /** Compressed bytes received so far. 0 until the response body starts arriving. */
  receivedBytes: Type.Number(),
  /**
   * `content-length` when GitHub sent one, else `null` — a zipball is
   * generated on the fly and frequently has no length, so the client must be
   * able to render an indeterminate bar rather than a bar stuck at 0%.
   */
  totalBytes: Type.Union([Type.Number(), Type.Null()]),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
  /** The summary step's payload — present exactly when `phase === 'done'`. */
  summary: Type.Union([ImportSummarySchema, Type.Null()]),
  /** Failure message — present exactly when `phase === 'failed'`. */
  error: Type.Union([Type.String(), Type.Null()]),
})
export type ImportJob = Static<typeof ImportJobSchema>

/**
 * Live jobs. Bounded by `pruneFinishedJobs` rather than left to grow: a record
 * is a few hundred bytes, but an unbounded map keyed by a value clients choose
 * to stop polling is a leak, and this process is long-lived.
 */
const jobs = new Map<string, ImportJob>()

/** How long a finished job stays pollable. Long enough for a client that navigated away and came back; short enough that nothing accumulates. */
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000

function pruneFinishedJobs(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > FINISHED_JOB_TTL_MS) jobs.delete(id)
  }
}

export interface GithubImportRouteDeps {
  /** Injected in tests so a job can be driven without the network. Production passes nothing and `runGithubImport` uses the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Runs one import to completion, updating its job record as it goes. Never
 * throws: every failure lands on the record as `phase: 'failed'`, because the
 * caller has already answered the HTTP request that started this.
 */
async function runImportJob(
  job: ImportJob,
  options: { url: string; ref?: string; subdir?: string; token?: string },
  deps: GithubImportRouteDeps,
): Promise<void> {
  try {
    const result = await runGithubImport(
      {
        url: options.url,
        ref: options.ref,
        subdir: options.subdir,
        token: options.token,
        onProgress: (progress) => {
          job.phase = progress.phase
          job.receivedBytes = progress.receivedBytes
          job.totalBytes = progress.totalBytes
        },
      },
      deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
    )

    job.phase = 'probing'
    // Persist the display name into the freshly-created project's meta.json.
    // Safe to write unconditionally: a successful `runGithubImport` means the
    // target had no pre-existing `.studio/` dir (it refuses to import into
    // one), so this always creates a fresh meta.json rather than clobbering.
    const derivedDisplayName =
      parseGithubRepoUrl(options.url)?.repo ?? result.dir.split(/[\\/]+/).filter(Boolean).pop() ?? 'Untitled'
    writeProjectMeta(result.dir, { displayName: derivedDisplayName })

    // Cache a probe of the freshly-imported repo so the very first `/load`
    // knows where its pages actually live. Without this the import "succeeds"
    // and the canvas is EMPTY — `profile.pagesDir` is the second source
    // `projectPagesDir` consults, after an explicit override. Never fatal: a
    // probe failure must not lose a repo that is already safely on disk, and
    // the summary reports `framework: null` rather than pretending.
    try {
      mergeStudioMeta(result.dir, { profile: probeProject(result.dir) })
    } catch (probeErr) {
      console.error('[studio/githubImportRoutes] post-import probe failed:', probeErr)
    }

    job.summary = buildImportSummary(result.dir, result)
    job.phase = 'done'
    job.finishedAt = Date.now()
  } catch (err) {
    console.error('[studio/githubImportRoutes]', err)
    job.phase = 'failed'
    job.error = err instanceof Error ? err.message : String(err)
    job.finishedAt = Date.now()
  }
}

/**
 * Starts an import and returns its job id. Exported for the route below and
 * for tests, which drive a job with an injected `fetch` and then poll the
 * same status shape the client does.
 */
export function startGithubImportJob(
  options: { url: string; ref?: string; subdir?: string; token?: string },
  deps: GithubImportRouteDeps = {},
): ImportJob {
  const now = Date.now()
  pruneFinishedJobs(now)
  const job: ImportJob = {
    id: randomUUID(),
    phase: 'downloading',
    receivedBytes: 0,
    totalBytes: null,
    startedAt: now,
    finishedAt: null,
    summary: null,
    error: null,
  }
  jobs.set(job.id, job)
  // Deliberately not awaited — the route answers with the id immediately. The
  // promise cannot reject (`runImportJob` catches everything), so there is no
  // unhandled rejection to guard.
  void runImportJob(job, options, deps)
  return job
}

/** The job with this id, or `null` once it has been pruned (or after a server restart — see the module doc). */
export function readGithubImportJob(id: string): ImportJob | null {
  return jobs.get(id) ?? null
}

// `_url` is read for the status route's `jobId` query. Signature matches the
// shape `tryServeStudio` composes for every sub-router.
export async function tryServeStudioGithubImport(
  req: Request,
  url: URL,
  pathname: string,
  deps: GithubImportRouteDeps = {},
): Promise<Response | null> {
  if (pathname === '/admin/api/studio/import-github' && req.method === 'POST') {
    const body = await readValidatedBody(req, GithubImportBodySchema)
    if (!body) return badRequest('invalid import body')
    // A URL that cannot be parsed is rejected here rather than inside the job:
    // it is the one failure a caller can fix by retyping, and reporting it as
    // a 400 on the start request keeps it out of the polling loop entirely.
    if (!parseGithubRepoUrl(body.url)) {
      return jsonResponse(
        { error: 'Not a valid GitHub repository URL — expected https://github.com/<owner>/<repo>.' },
        { status: 400 },
      )
    }
    const job = startGithubImportJob(
      { url: body.url, ref: body.ref, subdir: body.subdir, token: body.token },
      deps,
    )
    return jsonResponse({ jobId: job.id })
  }

  if (pathname === '/admin/api/studio/import-github/status' && req.method === 'GET') {
    const jobId = url.searchParams.get('jobId')
    if (!jobId) return badRequest('import status requires a jobId')
    const job = readGithubImportJob(jobId)
    if (!job) return jsonResponse({ error: 'That import is no longer being tracked.' }, { status: 404 })
    return jsonResponse({ job })
  }

  return null
}

/** Test-only: empties the registry between cases so a leaked job cannot make a later assertion pass. */
export function clearGithubImportJobsForTest(): void {
  jobs.clear()
}
