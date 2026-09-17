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
 *   GET  /admin/api/studio/git/pull-request/context?dir=<abs>
 *       → `{ supported, base, head, compareUrl, isDefaultBranch }`.
 *       `supported: false` is a NORMAL 200 (no origin, or an origin that is
 *       not GitHub) — the same posture `status`'s `isRepo: false` takes. It is
 *       what lets the panel decide whether to offer "Open PR" at all, and it
 *       is where the compare URL comes from, so no browser code ever parses a
 *       remote URL or reads a field off an error body.
 *
 *   POST /admin/api/studio/git/pull-request { dir?, title?, body?, base? }
 *       → `{ ok, url, number, compareUrl }`. Every field defaults from the
 *       repository: `base` from `origin/HEAD`, `title` from the last commit
 *       subject, `body` from the commit list. With no connected GitHub account
 *       it answers `409 { code: 'no-github-token', compareUrl }` — a link is a
 *       worse product than a button and a much better one than a dead end.
 *
 * ## Why these are not in `git.ts`
 *
 * `server/handlers/studio.ts`'s route table is the file every concurrent
 * change has to touch, so a new route family owns its own sub-router and is
 * composed in with one line (`standing-05`). The existing `git.ts` keeps the
 * local verbs it already had; nothing here duplicates one.
 *
 * The network verbs (`fetch`, `pull`, `pull-request`) act with the requesting
 * user's own GitHub credential, which `getGithubTokenForRequest`
 * (`githubToken.ts`, G2) resolves from the session — so this stays an ordinary
 * `(req, url, pathname)` sub-router with no `DbClient` threaded through it.
 * That lookup is deliberately soft: a request with no session simply has no
 * stored credential, git runs without one exactly as it did before, and
 * nothing here 401s.
 *
 * ## What this file is, and is not
 *
 * Routing only — exactly like `git.ts`: dir resolution, body validation, and
 * mapping a typed `GitOperationFailure` onto an HTTP status. **No argv is
 * built here.** Every git invocation lives in `gitOperations.ts`, the spawn
 * discipline and the repository guard in `gitRunner.ts`, and every judgement
 * of a caller-supplied string in `gitPaths.ts`.
 *
 * Every POST here goes through `originAllowed`, the same CSRF check the
 * credential-writing GitHub routes and `handleCmsRequest` apply. `SameSite=Lax`
 * already stops a cross-SITE POST from carrying the session cookie; this closes
 * the same-site-different-subdomain case, which matters because a forged `pull`
 * rewrites a working tree and a forged `pull-request` publishes under the
 * user's GitHub identity.
 *
 * Refusals follow the same contract as `git.ts`: a state-based refusal is a
 * **409** with `{ error, code, … }`, a git invocation that actually failed is
 * a **500**, and anything a guard rejected — a `dir` outside the workspace, a
 * project with no repository of its own, an unusable path — is a bare **404**
 * that says nothing about the server's filesystem.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { isStateChangingMethod, originAllowed } from '../../auth/security'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import {
  isAcceptableCommitMessage,
  isArgvSafeBranchName,
  parseGithubRemoteUrl,
  resolveWorkspaceRelativePath,
} from './gitPaths'
import { assertOwnGitRepo } from './gitRunner'
import { isGitFailure, type GitOperationFailure } from './gitOperations'
import {
  abortConflictResolution,
  commitAndSwitchBranch,
  continueConflictResolution,
  fetchRemote,
  listGitBranches,
  pullRemote,
  readBranchCommitSubjects,
  readConflictState,
  readPullRequestContext,
  resolveConflictFile,
} from './gitSyncOperations'
import { githubCompareUrl, openGithubPullRequest } from './githubPullRequest'
import { getGithubTokenForRequest } from './githubToken'

const ROUTE_PREFIX = '/admin/api/studio/git/'

const NOT_FOUND = () => new Response('Not found', { status: 404 })

/**
 * Exactly the actions this sub-router answers.
 *
 * Declared as a set rather than inferred from the `if` ladder so the CSRF
 * check below can run BEFORE the dispatch: a route table that decides "is this
 * mine?" only by falling through its handlers cannot apply a guard to all of
 * them at once.
 */
const OWNED_ACTIONS = new Set([
  'branches',
  'commit-and-switch',
  'fetch',
  'pull',
  'conflicts',
  'conflict/resolve',
  'conflict/continue',
  'conflict/abort',
  'pull-request',
  'pull-request/context',
])

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

/**
 * Body of `POST .../pull-request`. Every field is optional because every one
 * has an honest default read out of the repository — somebody who has just
 * pushed a branch should be able to open a PR without composing anything.
 */
const PullRequestBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  /** The branch to merge INTO. Defaults to whatever `origin/HEAD` points at. */
  base: Type.Optional(Type.String()),
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
 * `/admin/api/studio/git/{branches,commit-and-switch,fetch,pull,conflict*,pull-request}`
 * — see the module doc.
 */
export async function tryServeStudioGitSync(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null
  const action = pathname.slice(ROUTE_PREFIX.length)
  if (!OWNED_ACTIONS.has(action)) return null

  // CSRF defence in depth, matching `githubAuthRoutes.ts`, `handleCmsRequest`
  // and the AI routes. `SameSite=Lax` on the session cookie already stops a
  // cross-SITE POST from carrying it; this closes the
  // same-site-different-subdomain case it does not cover. Every POST below
  // changes the user's repository — a forged `pull` could rewrite their
  // working tree, a forged `pull-request` could publish a proposal under their
  // GitHub identity — so the check is worth the line.
  if (isStateChangingMethod(req.method) && !originAllowed(req)) {
    return jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 })
  }

  try {
    if (action === 'branches' && req.method === 'GET') return await serveBranches(url)
    if (action === 'commit-and-switch' && req.method === 'POST') return await serveCommitAndSwitch(req)
    if (action === 'fetch' && req.method === 'POST') return await serveFetch(req)
    if (action === 'pull' && req.method === 'POST') return await servePull(req)
    if (action === 'conflicts' && req.method === 'GET') return await serveConflicts(url)
    if (action === 'conflict/resolve' && req.method === 'POST') return await serveResolveConflict(req)
    if (action === 'conflict/continue' && req.method === 'POST') return await serveContinueConflict(req)
    if (action === 'conflict/abort' && req.method === 'POST') return await serveAbortConflict(req)
    if (action === 'pull-request/context' && req.method === 'GET') return await servePullRequestContext(url)
    if (action === 'pull-request' && req.method === 'POST') return await servePullRequest(req)
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

async function serveFetch(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, DirOnlyBodySchema)
  if (!body) return badRequest('invalid fetch body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const result = await fetchRemote(guard.dir, { credential: await githubCredential(req) })
  if (isGitFailure(result)) return failureResponse(result)
  return jsonResponse(result)
}

async function servePull(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, PullBodySchema)
  if (!body) return badRequest('invalid pull body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  // The default is the strategy that cannot rewrite anything. Rebase and merge
  // are only ever reached by an explicit choice the panel asked for.
  const result = await pullRemote(guard.dir, body.strategy ?? 'ff-only', {
    credential: await githubCredential(req),
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

/**
 * The requesting user's own GitHub token, or `undefined` for `runGit`'s
 * `credential` option. Soft by design — see `githubToken.ts`.
 */
async function githubCredential(req: Request): Promise<string | undefined> {
  return (await getGithubTokenForRequest(req)) ?? undefined
}

/**
 * What the panel needs to decide whether to offer "Open PR", and the compare
 * URL to offer beside it.
 *
 * A read, and a `supported: false` answer rather than a refusal: a project
 * with no origin, or an origin that is not GitHub, is an ordinary state the
 * panel renders around — not an error. This route exists so the browser never
 * has to parse a remote URL or dig a field out of an error body.
 */
async function servePullRequestContext(url: URL): Promise<Response> {
  const guard = assertOwnGitRepo(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()

  const unsupported = { supported: false, base: null, head: null, compareUrl: null, isDefaultBranch: false }

  const context = await readPullRequestContext(guard.dir)
  if (isGitFailure(context)) {
    // No origin / detached HEAD are states, not failures, for THIS question.
    if (context.code === 'no-origin-remote' || context.code === 'detached-head') return jsonResponse(unsupported)
    return failureResponse(context)
  }

  const target = parseGithubRemoteUrl(context.originUrl)
  if (!target) return jsonResponse(unsupported)

  const base = context.defaultBranch || 'main'
  return jsonResponse({
    supported: true,
    base,
    head: context.branch,
    compareUrl: githubCompareUrl(target, base, context.branch),
    // A PR from the default branch onto itself has no meaning; the panel hides
    // the button rather than offering one that would refuse.
    isDefaultBranch: base === context.branch,
  })
}

/**
 * Opens a pull request for the current branch.
 *
 * The defaults are the feature: base from `origin/HEAD`, title from the last
 * commit subject, body from the commit list. Someone who has just pushed a
 * branch should be able to click once.
 */
async function servePullRequest(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, PullRequestBodySchema)
  if (!body) return badRequest('invalid pull-request body')

  const guard = assertOwnGitRepo(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const context = await readPullRequestContext(guard.dir)
  if (isGitFailure(context)) return failureResponse(context)

  // The SAME allowlist `POST git/remote` validates a URL with — one definition
  // of "is this a GitHub remote", not two that can drift.
  const target = parseGithubRemoteUrl(context.originUrl)
  if (!target) {
    // Deliberately says nothing about what the remote actually is: it may be a
    // private host, and this answer is about GitHub support, not about them.
    return jsonResponse(
      {
        error: 'This project\'s "origin" remote is not a GitHub repository, so Studio cannot open a pull request for it.',
        code: 'not-a-github-remote',
      },
      { status: 409 },
    )
  }

  const base = (body.base ?? '').trim() || context.defaultBranch || 'main'
  if (!isArgvSafeBranchName(base)) return badRequest('that is not a usable base branch name')
  if (base === context.branch) {
    return jsonResponse(
      {
        error: `You are on "${context.branch}", which is also the base branch. Switch to a branch with your changes on it first.`,
        code: 'same-branch',
        compareUrl: githubCompareUrl(target, base, context.branch),
      },
      { status: 409 },
    )
  }

  const subjects = await readBranchCommitSubjects(guard.dir, base, context.branch)
  const title = (body.title ?? '').trim() || subjects[0] || context.branch
  const prBody = body.body ?? subjects.map((subject: string) => `- ${subject}`).join('\n')

  const result = await openGithubPullRequest({
    target,
    title,
    body: prBody,
    base,
    head: context.branch,
    // Belongs to the person making the request and to nobody else.
    token: await getGithubTokenForRequest(req),
  })
  if (!result.ok) {
    // A GitHub that could not be reached is not a refusal — it is a bad
    // gateway, and retrying is the right next action.
    const status = result.code === 'github-unreachable' ? 502 : 409
    return jsonResponse({ error: result.message, code: result.code, compareUrl: result.compareUrl }, { status })
  }
  return jsonResponse(result)
}
