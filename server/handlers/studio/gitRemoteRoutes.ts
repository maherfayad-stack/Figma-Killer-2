/**
 * gitRemoteRoutes — connecting a project to a repository.
 *
 *   GET  /admin/api/studio/git/remotes?dir=<abs>
 *       → `{ remotes: [{ name, fetchUrl, pushUrl }] }` — all of them, not just
 *         `origin`. A project that arrived with three remotes should show
 *         three; a panel that quietly disagrees with the user's terminal is
 *         the failure `excludedCount` exists to avoid elsewhere.
 *
 *   POST /admin/api/studio/git/remote   { dir?, set: { name: 'origin', url } }
 *       → `{ ok: true, remote }`. `name` is `Type.Literal('origin')` on the
 *         wire, so a second remote name is rejected by the SCHEMA rather than
 *         by a handler branch — v1 writes one remote and the contract says so.
 *
 *   POST /admin/api/studio/git/clone    { url }
 *       → `{ jobId }`, immediately.
 *   GET  /admin/api/studio/git/clone/status?jobId=<id>
 *       → `{ job }` — phase, and on success the same `ImportSummary` the
 *         zipball import ends on.
 *
 * ## Why clone is here and not in the import routes
 *
 * Because it is a git operation with git's guards: the URL goes through
 * `gitPaths.ts`'s transport allowlist, the credential comes from the session
 * through `runGit`'s one-shot askpass, and the target is derived from the
 * parsed owner/repo. `githubImportRoutes.ts` owns the zipball path, which
 * shares none of that machinery — it is an HTTP fetch and an unzip. The two
 * meet again at `buildImportSummary`, which is the part that genuinely is the
 * same.
 *
 * ## What this file is, and is not
 *
 * Routing only: body validation, guard → HTTP status, and reading the session
 * for a credential. The URL judgement is `gitPaths.ts`'s, the git invocations
 * are `gitOperations.ts`'s, and the clone job — target derivation, refusals,
 * cleanup — is `gitClone.ts`'s.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { isGitFailure, readRemotes, setOriginRemote, type GitOperationFailure } from './gitOperations'
import { githubProjectFolderName, parseGithubRemoteUrl } from './gitPaths'
import { assertOwnGitRepo } from './gitRunner'
import { cloneTargetIsFree, readGitCloneJob, startGitCloneJob, type GitCloneDeps } from './gitClone'
import { getGithubTokenForRequest } from './githubToken'

const NOT_FOUND = () => new Response('Not found', { status: 404 })

/**
 * Body of `POST /admin/api/studio/git/remote`.
 *
 * `name` is a literal, not a string: "which remote" is not a choice this
 * version offers, and encoding that in the schema means a request naming
 * `upstream` is rejected at the boundary rather than by a branch someone could
 * later relax by accident.
 */
const SetRemoteBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  set: Type.Object({
    name: Type.Literal('origin'),
    url: Type.String(),
  }),
})

/**
 * Body of `POST /admin/api/studio/git/clone`.
 *
 * One field. There is deliberately NO `dir`: the target is
 * `studio-workspace/<owner>-<repo>`, derived server-side from the parsed URL,
 * for the same reason `runGithubImport`'s `dir` option is not on its request
 * schema — a caller-supplied directory for an operation that creates a project
 * is an arbitrary-write primitive.
 */
const CloneBodySchema = Type.Object(
  {
    url: Type.String(),
  },
  // Closed, deliberately. A request carrying `dir` must be REJECTED, not
  // quietly ignored: "the field is ignored" is a property of today's handler,
  // and a future one that reads `body.dir` would be an arbitrary-write bug
  // nobody re-reviewed. Closing the schema makes the refusal part of the
  // contract, and `gitRemote.test.ts` asserts it.
  { additionalProperties: false },
)

/** Refusal → HTTP status, matching `git.ts`: a `git-failed` is a 500, a state refusal is a 409. */
function failureResponse(failure: GitOperationFailure): Response {
  const status = failure.code === 'git-failed' ? 500 : 409
  return jsonResponse({ error: failure.message, code: failure.code }, { status })
}

export async function tryServeStudioGitRemote(
  req: Request,
  url: URL,
  pathname: string,
  deps: GitCloneDeps = {},
): Promise<Response | null> {
  try {
    if (pathname === '/admin/api/studio/git/remotes' && req.method === 'GET') return await serveRemotes(url)
    if (pathname === '/admin/api/studio/git/remote' && req.method === 'POST') return await serveSetRemote(req)
    if (pathname === '/admin/api/studio/git/clone' && req.method === 'POST') return await serveClone(req, deps)
    if (pathname === '/admin/api/studio/git/clone/status' && req.method === 'GET') return serveCloneStatus(url)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    console.error('[studio/gitRemoteRoutes]', err)
    return jsonResponse({ error: 'The git operation could not be completed.' }, { status: 500 })
  }
  return null
}

async function serveRemotes(url: URL): Promise<Response> {
  const guard = assertOwnGitRepo(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()

  const remotes = await readRemotes(guard.dir)
  if (isGitFailure(remotes)) return failureResponse(remotes)
  return jsonResponse({ remotes })
}

async function serveSetRemote(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, SetRemoteBodySchema)
  if (!body) return badRequest('invalid remote body')

  // The URL is judged BEFORE the directory guard, because a rejected URL is
  // the one failure the user can fix by retyping and it deserves a message
  // rather than the guard's bare 404.
  const remote = parseGithubRemoteUrl(body.set.url)
  if (!remote) {
    return jsonResponse(
      {
        error:
          'Studio connects GitHub repositories only — expected https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>.git.',
      },
      { status: 400 },
    )
  }

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  // `remote.url` is the RE-COMPOSED form, never `body.set.url`.
  const result = await setOriginRemote(guard.dir, remote.url)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse({ ok: true, remote: result })
}

async function serveClone(req: Request, deps: GitCloneDeps): Promise<Response> {
  const body = await readValidatedBody(req, CloneBodySchema)
  if (!body) return badRequest('invalid clone body')

  const remote = parseGithubRemoteUrl(body.url)
  if (!remote) {
    return jsonResponse(
      { error: 'Not a GitHub repository URL — expected https://github.com/<owner>/<repo>.' },
      { status: 400 },
    )
  }
  // Refused before a job exists, so the client is told immediately rather than
  // through a poll. Studio never clears a project directory to make room: a
  // clone into an occupied name is a refusal, not an overwrite.
  if (!cloneTargetIsFree(remote)) {
    return jsonResponse(
      {
        error: `A project named "${githubProjectFolderName(remote)}" already exists. Open it, or rename it first.`,
        code: 'project-exists',
      },
      { status: 409 },
    )
  }

  // Session-resolved, exactly as `push` does it — there is no `token` field on
  // this wire, so no request and no proxy log can carry one. A private
  // repository simply needs the user to have signed in.
  const credential = await getGithubTokenForRequest(req)
  const job = startGitCloneJob(remote, credential ?? undefined, deps)
  return jsonResponse({ jobId: job.id })
}

function serveCloneStatus(url: URL): Response {
  const jobId = url.searchParams.get('jobId')
  if (!jobId) return badRequest('clone status requires a jobId')
  const job = readGitCloneJob(jobId)
  if (!job) return jsonResponse({ error: 'That clone is no longer being tracked.' }, { status: 404 })
  return jsonResponse({ job })
}
