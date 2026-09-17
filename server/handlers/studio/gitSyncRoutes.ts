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
 * ## Why these are not in `git.ts`
 *
 * `server/handlers/studio.ts`'s route table is the file every concurrent
 * change has to touch, so a new route family owns its own sub-router and is
 * composed into `STUDIO_SUB_ROUTERS` with one line (`standing-05`). The
 * existing `git.ts` keeps the local verbs it already had; nothing here
 * duplicates one.
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
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { isAcceptableCommitMessage, resolveWorkspaceRelativePath } from './gitPaths'
import { assertOwnGitRepo } from './gitRunner'
import { commitAndSwitchBranch, isGitFailure, listGitBranches, type GitOperationFailure } from './gitOperations'

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

/** Refusal → HTTP status, identical to `git.ts`'s mapping. `busy` is a 409 like every other state refusal. */
function failureResponse(failure: GitOperationFailure): Response {
  const status = failure.code === 'git-failed' ? 500 : 409
  return jsonResponse(
    { error: failure.message, code: failure.code, ...(failure.dirtyFiles ? { dirtyFiles: failure.dirtyFiles } : {}) },
    { status },
  )
}

/** `/admin/api/studio/git/{branches,commit-and-switch}` — see the module doc. */
export async function tryServeStudioGitSync(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null
  const action = pathname.slice(ROUTE_PREFIX.length)

  try {
    if (action === 'branches' && req.method === 'GET') return await serveBranches(url)
    if (action === 'commit-and-switch' && req.method === 'POST') return await serveCommitAndSwitch(req)
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
