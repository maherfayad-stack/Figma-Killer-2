/**
 * importGithubProject — client for the GitHub import JOB
 * (`server/handlers/studio/githubImportRoutes.ts`).
 *
 *   POST /admin/api/studio/import-github          → { jobId }
 *   GET  /admin/api/studio/import-github/status   → { job }
 *
 * The route used to be one blocking POST and the entire UI for it was a button
 * reading "Importing…". Cloning a real repository takes tens of seconds, so
 * that told the user nothing and gave any intermediate proxy a request to time
 * out. `importGithubProject` now starts the job and polls it, reporting each
 * phase (and the download's byte count) to its caller, and resolves with the
 * post-import `ImportSummary` the launcher's summary step renders.
 *
 * The caller still points the editor at the returned `dir` afterwards — this
 * client never touches `studioWorkspaceDir`.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { ImportSummarySchema, type ImportSummary } from './importSummary'

export interface ImportGithubProjectInput {
  /** A GitHub repo URL — https://github.com/<owner>/<repo>, .git suffix / trailing slash tolerated. */
  url: string
  /** Branch, tag, or commit SHA. Defaults to the repo's default branch. */
  ref?: string
  /** Import only this subdirectory of the repo as the workspace root. */
  subdir?: string
  /** Sent as a Bearer credential for private repos — never persisted, never logged. */
  token?: string
  /** Called on every poll while the import runs. */
  onProgress?: (progress: ImportProgress) => void
  signal?: AbortSignal
}

/** What the dialog renders while an import is in flight. */
export interface ImportProgress {
  phase: 'downloading' | 'unpacking' | 'probing'
  receivedBytes: number
  /** `null` when GitHub sent no `content-length` — the bar must then read as indeterminate rather than stuck at 0%. */
  totalBytes: number | null
}

const StartImportResponseSchema = Type.Object({ jobId: Type.String() }, { additionalProperties: true })

const ImportJobResponseSchema = Type.Object(
  {
    job: Type.Object(
      {
        phase: Type.Union([
          Type.Literal('downloading'),
          Type.Literal('unpacking'),
          Type.Literal('probing'),
          Type.Literal('done'),
          Type.Literal('failed'),
        ]),
        receivedBytes: Type.Number(),
        totalBytes: Type.Union([Type.Number(), Type.Null()]),
        summary: Type.Union([ImportSummarySchema, Type.Null()]),
        error: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
)

/**
 * How often to ask. Fast enough that the byte counter moves visibly on a slow
 * clone, slow enough that a five-minute import is a few hundred requests
 * against an in-memory map rather than a poll storm.
 */
const POLL_INTERVAL_MS = 600

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

/**
 * Starts a GitHub import and resolves once it has finished, with the summary
 * the post-import step renders. Rejects with the server's own message on a bad
 * URL (a 400 on the start call, before any polling) or on a failed job.
 */
export async function importGithubProject(input: ImportGithubProjectInput): Promise<ImportSummary> {
  const { jobId } = await apiRequest('/admin/api/studio/import-github', {
    method: 'POST',
    body: { url: input.url, ref: input.ref, subdir: input.subdir, token: input.token },
    schema: StartImportResponseSchema,
    signal: input.signal,
  })

  while (true) {
    // A 404 here means the server forgot the job — a `bun --watch` restart, or
    // the finished-job TTL elapsing. `apiRequest` throws with the route's own
    // message, which says the import stopped being tracked rather than that it
    // failed; the project may well be on disk, and the launcher's listing is
    // the honest place to find out.
    const { job } = await apiRequest(
      `/admin/api/studio/import-github/status?jobId=${encodeURIComponent(jobId)}`,
      { schema: ImportJobResponseSchema, signal: input.signal },
    )

    if (job.phase === 'done') {
      if (!job.summary) throw new Error('The import finished without reporting what it found.')
      return job.summary
    }
    if (job.phase === 'failed') {
      throw new Error(job.error ?? 'The import failed.')
    }

    input.onProgress?.({ phase: job.phase, receivedBytes: job.receivedBytes, totalBytes: job.totalBytes })
    await delay(POLL_INTERVAL_MS, input.signal)
  }
}
