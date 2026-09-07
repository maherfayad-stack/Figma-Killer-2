/**
 * git — `/admin/api/studio/git/*`, Studio's publish verb.
 *
 * Studio's source of truth is a real React repository on disk, and until this
 * existed the editor had zero version-control awareness: every canvas edit was
 * an unattributed working-tree mutation, and a designer had no way to ship one.
 * These routes are the whole of Studio's git surface.
 *
 *   GET  /admin/api/studio/git/status?dir=<abs>
 *       → `{ isRepo, status: { branch, entries, excludedCount, hasOrigin } | null }`
 *       `isRepo: false` is a NORMAL answer, not an error — it is what makes the
 *       panel offer `init`. `entries` carries staged/unstaged/untracked/unmerged
 *       per path (see `gitStatusParse.ts`).
 *
 *   GET  /admin/api/studio/git/diff?dir=<abs>&file=<workspace-rel>
 *       → `{ file, staged, unstaged, untracked, truncated }` — both halves of
 *       one file's unified diff. An untracked file is diffed against
 *       `/dev/null`.
 *
 *   GET  /admin/api/studio/git/log?dir=<abs>&limit=<n>
 *       → `{ commits: [{ sha, shortSha, author, date, subject }] }`
 *
 *   POST /admin/api/studio/git/branch   { dir?, create? } | { dir?, switch? }
 *       → `{ ok, branch, created }`, or a 409 `{ error, code: 'dirty-tree',
 *       dirtyFiles }` when switching over uncommitted work. Studio never
 *       stashes and never force-switches; the client offers "commit first".
 *
 *   POST /admin/api/studio/git/commit   { dir?, message, files }
 *       → `{ ok, sha, shortSha, files }`. Stages EXACTLY `files`. An empty list
 *       refuses.
 *
 *   POST /admin/api/studio/git/push     { dir? }
 *       → `{ ok, branch, output }`. `--set-upstream origin <branch>`, never
 *       `--force`. Authentication is the user's own credential helper's;
 *       Studio stores no token and reads none from its environment.
 *
 *   POST /admin/api/studio/git/init     { dir?, confirm: true, message? }
 *       → `{ ok, branch, sha, filesCommitted }`. Offered only when no `.git`
 *       exists. `confirm` must be literally `true` — an initial commit is not
 *       something a stray request performs.
 *
 *   POST /admin/api/studio/git/restore  { dir?, sha, file }
 *       → `{ ok, file, sha }`. `git checkout <sha> -- <file>` for ONE file.
 *       The client puts a danger-styled confirmation in front of it and
 *       reloads the board afterwards.
 *
 * ## What this file is, and is not
 *
 * Routing only: dir resolution, body validation, mapping a typed
 * `GitOperationFailure` onto an HTTP status. Every git invocation lives in
 * `gitOperations.ts`, the spawn discipline and the repository guard in
 * `gitRunner.ts`, the porcelain parser in `gitStatusParse.ts`, and every
 * judgement of a caller-supplied string in `gitPaths.ts`. Nothing here builds
 * an argv.
 *
 * ## The two rejections that are 404s
 *
 * A `dir` outside `studio-workspace/` and a `dir` with no repository of its own
 * both return a bare 404 with no body. The first is the containment guard
 * (`assertWithinWorkspace`) and must not confirm or deny anything about the
 * server's filesystem. The second matters more than it looks: git discovers a
 * repository by walking UP from its `cwd`, so a project directory without its
 * own `.git` would resolve to **Studio's own repository** — see
 * `gitRunner.ts`'s module doc. Every operation except `status` and `init` sits
 * behind `assertOwnGitRepo`; `status` reports `isRepo: false` instead, because
 * "there is no repository here yet" is the exact state the panel needs to
 * render its `init` offer.
 *
 * A rejected path (`..`, absolute, `node_modules/…`) is also a 404 rather than
 * a 400 — it is indistinguishable from a file that does not exist, and saying
 * more would describe the server's layout.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { isCommitSha, isAcceptableCommitMessage, resolveWorkspaceRelativePath } from './gitPaths'
import { assertOwnGitRepo, assertWithinWorkspace, hasGitRepo } from './gitRunner'
import {
  commitFiles,
  initRepository,
  isGitFailure,
  MAX_LOG_COMMITS,
  pushCurrentBranch,
  readGitFileDiff,
  readGitLog,
  readGitStatus,
  restoreFileFromCommit,
  switchBranch,
  type GitOperationFailure,
} from './gitOperations'

const ROUTE_PREFIX = '/admin/api/studio/git/'

const NOT_FOUND = () => new Response('Not found', { status: 404 })

/**
 * Body of `POST /admin/api/studio/git/branch`. Exactly one of `create`/`switch`
 * must be present — two branch names in one request has no honest meaning, and
 * silently preferring one would make the refusal depend on field order.
 */
const BranchBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  create: Type.Optional(Type.String()),
  switch: Type.Optional(Type.String()),
})

/**
 * Body of `POST /admin/api/studio/git/commit`. `files` is required and must be
 * non-empty: there is deliberately no "commit everything" shape on this wire,
 * because `git add -A` from a button is how a background process's edits end
 * up in a commit the user believes they reviewed.
 */
const CommitBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  message: Type.String(),
  files: Type.Array(Type.String(), { minItems: 1 }),
})

const PushBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
})

/**
 * Body of `POST /admin/api/studio/git/init`. `confirm` is `Type.Literal(true)`
 * rather than a boolean so the schema itself rejects `{ confirm: false }` —
 * creating a repository and committing the whole project is not a thing a
 * request performs by accident, and an explicit literal makes the consent
 * visible in the wire contract rather than in a handler branch.
 */
const InitBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  confirm: Type.Literal(true),
  message: Type.Optional(Type.String()),
})

const RestoreBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  sha: Type.String(),
  file: Type.String(),
})

export type GitCommitBody = Static<typeof CommitBodySchema>

/** Refusal → HTTP status. A refusal is a 409 (the request was well-formed, the repository's state says no); a git invocation failure is a 500. */
function failureResponse(failure: GitOperationFailure): Response {
  const status = failure.code === 'git-failed' ? 500 : 409
  return jsonResponse(
    { error: failure.message, code: failure.code, ...(failure.dirtyFiles ? { dirtyFiles: failure.dirtyFiles } : {}) },
    { status },
  )
}

/** `GET/POST /admin/api/studio/git/*` — see the module doc for the full contract. */
export async function tryServeStudioGit(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null
  const action = pathname.slice(ROUTE_PREFIX.length)

  try {
    if (action === 'status' && req.method === 'GET') return await serveStatus(url)
    if (action === 'diff' && req.method === 'GET') return await serveDiff(url)
    if (action === 'log' && req.method === 'GET') return await serveLog(url)
    if (action === 'branch' && req.method === 'POST') return await serveBranch(req)
    if (action === 'commit' && req.method === 'POST') return await serveCommit(req)
    if (action === 'push' && req.method === 'POST') return await servePush(req)
    if (action === 'init' && req.method === 'POST') return await serveInit(req)
    if (action === 'restore' && req.method === 'POST') return await serveRestore(req)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    console.error('[studio:git]', err)
    return jsonResponse({ error: 'The git operation could not be completed.' }, { status: 500 })
  }

  return null
}

async function serveStatus(url: URL): Promise<Response> {
  const guard = assertWithinWorkspace(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()

  // "No repository yet" is a state, not an error — it is what the panel needs
  // to offer `init`. Every other route treats it as a 404 instead.
  if (!hasGitRepo(guard.dir)) return jsonResponse({ isRepo: false, status: null })

  const status = await readGitStatus(guard.dir)
  if (isGitFailure(status)) return failureResponse(status)
  return jsonResponse({ isRepo: true, status })
}

async function serveDiff(url: URL): Promise<Response> {
  const guard = assertOwnGitRepo(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()

  const fileParam = url.searchParams.get('file')
  if (!fileParam) return NOT_FOUND()
  const relPath = resolveWorkspaceRelativePath(guard.dir, fileParam)
  if (relPath === null) return NOT_FOUND()

  const diff = await readGitFileDiff(guard.dir, relPath)
  if (isGitFailure(diff)) return failureResponse(diff)
  return jsonResponse(diff)
}

async function serveLog(url: URL): Promise<Response> {
  const guard = assertOwnGitRepo(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()

  const limitParam = Number(url.searchParams.get('limit') ?? MAX_LOG_COMMITS)
  const limit = Number.isFinite(limitParam) ? limitParam : MAX_LOG_COMMITS
  const commits = await readGitLog(guard.dir, limit)
  if (isGitFailure(commits)) return failureResponse(commits)
  return jsonResponse({ commits })
}

async function serveBranch(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, BranchBodySchema)
  if (!body) return badRequest('invalid branch body')

  const create = body.create?.trim()
  const target = body.switch?.trim()
  if ((create && target) || (!create && !target)) {
    return badRequest('a branch request names exactly one of "create" or "switch"')
  }

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const result = create
    ? await switchBranch(guard.dir, create, 'create')
    : await switchBranch(guard.dir, target!, 'switch')
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function serveCommit(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, CommitBodySchema)
  if (!body) return badRequest('invalid commit body')

  const message = body.message.trim()
  if (!isAcceptableCommitMessage(message)) return badRequest('a commit needs a message of 1–4096 characters')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  // Every path is re-derived server-side. One unusable path fails the WHOLE
  // commit rather than being dropped: a commit that silently contains fewer
  // files than the user selected is worse than one that refuses and says so.
  const files: string[] = []
  for (const raw of body.files) {
    const relPath = resolveWorkspaceRelativePath(guard.dir, raw)
    if (relPath === null) return NOT_FOUND()
    if (!files.includes(relPath)) files.push(relPath)
  }

  const result = await commitFiles(guard.dir, message, files)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function servePush(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, PushBodySchema)
  if (!body) return badRequest('invalid push body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const result = await pushCurrentBranch(guard.dir)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function serveInit(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, InitBodySchema)
  if (!body) return badRequest('invalid init body')

  // `init` is the one route that does NOT require an existing repository — it
  // is about to create one — so it uses the containment half of the guard only.
  const guard = assertWithinWorkspace(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const message = (body.message ?? '').trim() || 'Initial commit'
  if (!isAcceptableCommitMessage(message)) return badRequest('a commit needs a message of 1–4096 characters')

  const result = await initRepository(guard.dir, message)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function serveRestore(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, RestoreBodySchema)
  if (!body) return badRequest('invalid restore body')
  if (!isCommitSha(body.sha)) return badRequest('restore takes a commit hash, not a revision expression')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const relPath = resolveWorkspaceRelativePath(guard.dir, body.file)
  if (relPath === null) return NOT_FOUND()

  const result = await restoreFileFromCommit(guard.dir, body.sha, relPath)
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}
