/**
 * gitSyncRoutes — the git routes that talk to a REMOTE, plus the two that
 * exist because of them.
 *
 *   GET  /admin/api/studio/git/branches?dir=<abs>
 *       → `{ branches, current, defaultBranch }`. Every local and
 *       remote-tracking ref with its own upstream/ahead/behind, in one
 *       `for-each-ref`. This is what replaced the panel's free-text branch
 *       field with a dropdown.
 *
 *   POST /admin/api/studio/git/commit-and-switch { dir?, message, files, switch }
 *       → `{ ok, sha, shortSha, files, branch }`. One action, one hold of the
 *       project write lock: commit exactly `files`, then switch. Studio still
 *       never stashes — this is the alternative to stashing.
 *
 *   POST /admin/api/studio/git/fetch { dir? }
 *       → `{ ok, output }`. `git fetch --prune origin`. Nothing in the working
 *       tree changes; what changes is that ahead/behind becomes true again.
 *
 *   POST /admin/api/studio/git/pull { dir?, strategy? }
 *       → `{ ok, strategy, output }`. `strategy` defaults to `ff-only`, which
 *       REFUSES on divergence with `409 { code: 'diverged' }` — that refusal is
 *       the moment the panel asks "rebase or merge?" instead of picking one.
 *       A conflict is `409 { code: 'conflict', files }`.
 *
 *   GET  /admin/api/studio/git/conflicts?dir=<abs>
 *       → `{ kind: 'rebase' | 'merge' | null, files }`. A read, so the panel
 *       can still show a conflict after a page reload.
 *
 *   POST /admin/api/studio/git/conflict/resolve { dir?, file, side }
 *       → `{ ok, file, side }`. `side` is `mine`/`theirs` in the USER's terms;
 *       the `--ours`/`--theirs` translation (which inverts during a rebase)
 *       happens in `gitOperations.ts`, never here and never in a browser.
 *
 *   POST /admin/api/studio/git/conflict/continue { dir? }
 *       → `{ ok, kind }`, or `409 { code: 'unresolved-conflicts', files }`.
 *
 *   POST /admin/api/studio/git/conflict/abort { dir?, confirm: true }
 *       → `{ ok, kind }`. The one destructive verb here, so `confirm` is a
 *       TypeBox `Type.Literal(true)` — the consent is in the wire contract
 *       rather than in a handler branch, exactly as `init` does it.
 *
 * ## Why these are not in `git.ts`
 *
 * `server/handlers/studio.ts`'s route table is the file every concurrent
 * change has to touch, so a new route family owns its own sub-router and is
 * composed in with one line (`standing-05`). The existing `git.ts` keeps the
 * local verbs it already had; nothing here duplicates one.
 *
 * It is composed into `STUDIO_SESSION_SUB_ROUTERS` rather than
 * `STUDIO_SUB_ROUTERS` because `fetch` and `pull` may act with the requesting
 * user's own GitHub credential, which is reachable only through the
 * `DbClient`. The identity is optional and nothing here 401s — see
 * `gitRemoteCredential.ts`.
 *
 * ## What this file is, and is not
 *
 * Routing only — exactly like `git.ts`: dir resolution, body validation, and
 * mapping a typed `GitOperationFailure` onto an HTTP status. **No argv is
 * built here.** Every git invocation lives in `gitOperations.ts`, the spawn
 * discipline and the repository guard in `gitRunner.ts`, and every judgement
 * of a caller-supplied string in `gitPaths.ts`.
 *
 * Refusals follow the same contract as `git.ts`: a state-based refusal is a
 * **409** with `{ error, code, … }`, a git invocation that actually failed is
 * a **500**, and anything a guard rejected — a `dir` outside the workspace, a
 * project with no repository of its own, an unusable path — is a bare **404**
 * that says nothing about the server's filesystem.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import type { DbClient } from '../../db/client'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { isAcceptableCommitMessage, resolveWorkspaceRelativePath } from './gitPaths'
import { gitCredentialForRequest } from './gitRemoteCredential'
import { assertOwnGitRepo } from './gitRunner'
import {
  abortConflictResolution,
  commitAndSwitchBranch,
  continueConflictResolution,
  fetchRemote,
  isGitFailure,
  listGitBranches,
  pullRemote,
  readConflictState,
  resolveConflictFile,
  type GitOperationFailure,
} from './gitOperations'

const ROUTE_PREFIX = '/admin/api/studio/git/'

const NOT_FOUND = () => new Response('Not found', { status: 404 })

/**
 * Body of `POST /admin/api/studio/git/commit-and-switch`. `files` is required
 * and non-empty for the same reason `commit`'s is: there is no "commit
 * everything" shape on this wire.
 */
const CommitAndSwitchBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  message: Type.String(),
  files: Type.Array(Type.String(), { minItems: 1 }),
  switch: Type.String(),
})

const DirOnlyBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
})

/**
 * Body of `POST .../pull`. `strategy` is a closed union with a default of
 * `ff-only`: a pull that silently merged or rebased because a field was
 * missing would write history the user never chose.
 */
const PullBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  strategy: Type.Optional(
    Type.Union([Type.Literal('ff-only'), Type.Literal('rebase'), Type.Literal('merge')]),
  ),
})

/** Body of `POST .../conflict/resolve`. `side` is in the user's terms — see `GitConflictSide`. */
const ResolveConflictBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  file: Type.String(),
  side: Type.Union([Type.Literal('mine'), Type.Literal('theirs')]),
})

/** Body of `POST .../conflict/abort`. `Type.Literal(true)`, so `{ confirm: false }` is rejected by the schema — same posture as `init`. */
const AbortConflictBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  confirm: Type.Literal(true),
})

/** Refusal → HTTP status, identical to `git.ts`'s mapping. `busy` is a 409 like every other state refusal. */
function failureResponse(failure: GitOperationFailure): Response {
  const status = failure.code === 'git-failed' ? 500 : 409
  return jsonResponse(
    {
      error: failure.message,
      code: failure.code,
      ...(failure.dirtyFiles ? { dirtyFiles: failure.dirtyFiles } : {}),
      ...(failure.conflictFiles ? { files: failure.conflictFiles } : {}),
    },
    { status },
  )
}

/**
 * `/admin/api/studio/git/{branches,commit-and-switch,fetch,pull,conflict*}` —
 * see the module doc.
 *
 * Takes the `DbClient` (it is a `STUDIO_SESSION_SUB_ROUTERS` entry) for ONE
 * reason: `fetch` and `pull` may need the requesting user's own GitHub
 * credential, which lives against their account and nowhere else. The identity
 * is OPTIONAL — see `gitRemoteCredential.ts` — so none of these routes 401s,
 * and a project with an ssh remote or a local credential helper behaves
 * exactly as it did before.
 */
export async function tryServeStudioGitSync(
  req: Request,
  runtime: { db: DbClient },
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null
  const action = pathname.slice(ROUTE_PREFIX.length)

  try {
    if (action === 'branches' && req.method === 'GET') return await serveBranches(url)
    if (action === 'commit-and-switch' && req.method === 'POST') return await serveCommitAndSwitch(req)
    if (action === 'fetch' && req.method === 'POST') return await serveFetch(req, runtime.db)
    if (action === 'pull' && req.method === 'POST') return await servePull(req, runtime.db)
    if (action === 'conflicts' && req.method === 'GET') return await serveConflicts(url)
    if (action === 'conflict/resolve' && req.method === 'POST') return await serveResolveConflict(req)
    if (action === 'conflict/continue' && req.method === 'POST') return await serveContinueConflict(req)
    if (action === 'conflict/abort' && req.method === 'POST') return await serveAbortConflict(req)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    console.error('[studio:git-sync]', err)
    return jsonResponse({ error: 'The git operation could not be completed.' }, { status: 500 })
  }

  return null
}

async function serveBranches(url: URL): Promise<Response> {
  const guard = assertOwnGitRepo(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()

  const result = await listGitBranches(guard.dir)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function serveCommitAndSwitch(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, CommitAndSwitchBodySchema)
  if (!body) return badRequest('invalid commit-and-switch body')

  const message = body.message.trim()
  if (!isAcceptableCommitMessage(message)) return badRequest('a commit needs a message of 1–4096 characters')
  const branch = body.switch.trim()
  if (!branch) return badRequest('commit-and-switch names the branch to switch to')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  // Re-derived server-side, exactly as `commit` does: one unusable path fails
  // the WHOLE request rather than being dropped, because a commit that quietly
  // contains fewer files than the user ticked is worse than a refusal.
  const files: string[] = []
  for (const raw of body.files) {
    const relPath = resolveWorkspaceRelativePath(guard.dir, raw)
    if (relPath === null) return NOT_FOUND()
    if (!files.includes(relPath)) files.push(relPath)
  }

  const result = await commitAndSwitchBranch(guard.dir, message, files, branch)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function serveFetch(req: Request, db: DbClient): Promise<Response> {
  const body = await readValidatedBody(req, DirOnlyBodySchema)
  if (!body) return badRequest('invalid fetch body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const result = await fetchRemote(guard.dir, { credential: await gitCredentialForRequest(req, db) })
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function servePull(req: Request, db: DbClient): Promise<Response> {
  const body = await readValidatedBody(req, PullBodySchema)
  if (!body) return badRequest('invalid pull body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  // The default is the strategy that cannot rewrite anything. Rebase and merge
  // are only ever reached by an explicit choice the panel asked for.
  const result = await pullRemote(guard.dir, body.strategy ?? 'ff-only', {
    credential: await gitCredentialForRequest(req, db),
  })
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function serveConflicts(url: URL): Promise<Response> {
  const guard = assertOwnGitRepo(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()
  return jsonResponse(await readConflictState(guard.dir))
}

async function serveResolveConflict(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, ResolveConflictBodySchema)
  if (!body) return badRequest('invalid conflict resolve body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const relPath = resolveWorkspaceRelativePath(guard.dir, body.file)
  if (relPath === null) return NOT_FOUND()

  const result = await resolveConflictFile(guard.dir, relPath, body.side)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function serveContinueConflict(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, DirOnlyBodySchema)
  if (!body) return badRequest('invalid conflict continue body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const result = await continueConflictResolution(guard.dir)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function serveAbortConflict(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, AbortConflictBodySchema)
  if (!body) return badRequest('invalid conflict abort body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const result = await abortConflictResolution(guard.dir)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}
