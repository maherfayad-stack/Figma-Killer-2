/**
 * gitSyncRequests — the wire contract for the git routes that talk to a REMOTE,
 * plus the two local ones that only make sense alongside them
 * (`server/handlers/studio/gitSyncRoutes.ts`).
 *
 * Split out of `gitRequests.ts` on the same line the server is split on: that
 * module covers the local verbs (status, diff, log, commit, branch, push,
 * init, restore, remotes, sign-in), this one covers branches-as-a-list,
 * commit-and-switch, fetch, pull, conflicts, and pull requests.
 *
 * Same contract in every other respect, and the two rules worth repeating:
 *
 *   - **Every call goes through `apiRequest` with a TypeBox schema**, so a
 *     response shape that drifts from the server fails loudly at the boundary
 *     instead of producing `undefined` three components deep. The exported
 *     types are `Static<typeof …>`, never a hand-written mirror.
 *   - **A refusal is an `ApiError` with status 409**, and the browser reads
 *     only the message — `isGitStateRefusal` in `gitRequests.ts` is still the
 *     test. Where a caller needs more than the message (which side of a
 *     conflict, whether a PR can be opened at all) it asks the REPOSITORY with
 *     a read, never an error body: see `getGitConflicts` and
 *     `getGitPullRequestContext`.
 *
 * There are no `push --force`, `reset`, or `stash` calls here, and nowhere to
 * add one: the server has no route for them.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { GIT_API_BASE as BASE } from './gitRequests'

// ---------------------------------------------------------------------------
// Branches, sync, and pull requests (G3–G5)
//
// Appended rather than interleaved above so the v1 contract stays readable as
// one block. These call `server/handlers/studio/gitSyncRoutes.ts`, a sibling
// sub-router of `git.ts` — same base path, same `{ error, code }` refusal
// envelope, same `isGitStateRefusal` test.
// ---------------------------------------------------------------------------

const GitBranchSummarySchema = Type.Object({
  /** `main` for a local branch, `origin/main` for a remote-tracking one. */
  name: Type.String(),
  remote: Type.Boolean(),
  current: Type.Boolean(),
  upstream: Type.Union([Type.String(), Type.Null()]),
  ahead: Type.Union([Type.Number(), Type.Null()]),
  behind: Type.Union([Type.Number(), Type.Null()]),
  /** The upstream is configured but gone from the remote — git's own `gone`. */
  upstreamGone: Type.Boolean(),
})

const GitBranchListSchema = Type.Object({
  branches: Type.Array(GitBranchSummarySchema),
  current: Type.Union([Type.String(), Type.Null()]),
  /** What `origin/HEAD` points at. `null` when there is no origin, or nobody ever ran `git remote set-head`. */
  defaultBranch: Type.Union([Type.String(), Type.Null()]),
})

const GitCommitAndSwitchResponseSchema = Type.Object({
  ok: Type.Boolean(),
  sha: Type.String(),
  shortSha: Type.String(),
  files: Type.Array(Type.String()),
  branch: Type.String(),
})

export type GitBranchSummary = Static<typeof GitBranchSummarySchema>
export type GitBranchList = Static<typeof GitBranchListSchema>
export type GitCommitAndSwitchResult = Static<typeof GitCommitAndSwitchResponseSchema>

/** Every local and remote-tracking branch, with per-branch divergence. A read — it never answers `busy`. */
export async function getGitBranches(dir: string | undefined, signal?: AbortSignal): Promise<GitBranchList> {
  return apiRequest(`${BASE}/branches`, { schema: GitBranchListSchema, query: { dir }, signal })
}

/**
 * Commit exactly `files`, then switch to `branch` — one server action, one
 * hold of the project write lock. This is what the panel offers instead of a
 * stash when someone picks a different branch with uncommitted work on screen.
 *
 * Refuses with `code: 'dirty-tree'` when files the user did NOT tick are still
 * uncommitted: the commit stands, the switch does not.
 */
export async function commitAndSwitchGitBranch(
  dir: string | undefined,
  message: string,
  files: readonly string[],
  branch: string,
): Promise<GitCommitAndSwitchResult> {
  return apiRequest(`${BASE}/commit-and-switch`, {
    method: 'POST',
    body: { dir, message, files: [...files], switch: branch },
    schema: GitCommitAndSwitchResponseSchema,
  })
}

const GitFetchResponseSchema = Type.Object({
  ok: Type.Boolean(),
  /** git's own fetch output. Empty when there was nothing new — which is itself the answer. */
  output: Type.String(),
})

const GitPullStrategySchema = Type.Union([
  Type.Literal('ff-only'),
  Type.Literal('rebase'),
  Type.Literal('merge'),
])

const GitPullResponseSchema = Type.Object({
  ok: Type.Boolean(),
  strategy: GitPullStrategySchema,
  output: Type.String(),
})

const GitConflictStateSchema = Type.Object({
  /** `null` when nothing is stopped on a conflict. */
  kind: Type.Union([Type.Literal('rebase'), Type.Literal('merge'), Type.Null()]),
  files: Type.Array(Type.String()),
})

const GitConflictSideSchema = Type.Union([Type.Literal('mine'), Type.Literal('theirs')])

const GitConflictResolveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  file: Type.String(),
  side: GitConflictSideSchema,
})

const GitConflictFinishResponseSchema = Type.Object({
  ok: Type.Boolean(),
  kind: Type.Union([Type.Literal('rebase'), Type.Literal('merge')]),
})

export type GitPullStrategy = Static<typeof GitPullStrategySchema>
export type GitConflictState = Static<typeof GitConflictStateSchema>
export type GitConflictSide = Static<typeof GitConflictSideSchema>

/** `git fetch --prune origin`. Changes no file in the working tree — what it changes is that ahead/behind becomes true again. */
export async function fetchGitRemote(dir: string | undefined) {
  return apiRequest(`${BASE}/fetch`, { method: 'POST', body: { dir }, schema: GitFetchResponseSchema })
}

/**
 * `git pull` with the named strategy, defaulting to `ff-only`.
 *
 * `ff-only` refusing on divergence is the point, not a failure: it is the
 * moment the panel offers rebase or merge instead of writing history the user
 * never chose. Read the code back with `gitRefusalCode` — `diverged`,
 * `conflict`, or `dirty-tree`.
 */
export async function pullGitRemote(dir: string | undefined, strategy: GitPullStrategy = 'ff-only') {
  return apiRequest(`${BASE}/pull`, { method: 'POST', body: { dir, strategy }, schema: GitPullResponseSchema })
}

/** Whether a rebase or merge is stopped on a conflict, and which files. A read — it survives a page reload. */
export async function getGitConflicts(dir: string | undefined, signal?: AbortSignal): Promise<GitConflictState> {
  return apiRequest(`${BASE}/conflicts`, { schema: GitConflictStateSchema, query: { dir }, signal })
}

/**
 * Keep one side of one conflicted file, and stage it.
 *
 * `side` is `mine`/`theirs` in the USER's terms. The `--ours`/`--theirs`
 * translation — which INVERTS during a rebase — happens on the server, so no
 * browser code has to know that rule.
 */
export async function resolveGitConflict(dir: string | undefined, file: string, side: GitConflictSide) {
  return apiRequest(`${BASE}/conflict/resolve`, {
    method: 'POST',
    body: { dir, file, side },
    schema: GitConflictResolveResponseSchema,
  })
}

/** Finish the stopped rebase or merge. Refuses with `unresolved-conflicts` while anything is still unmerged, and reports a fresh `conflict` when the next replayed commit conflicts too. */
export async function continueGitConflict(dir: string | undefined) {
  return apiRequest(`${BASE}/conflict/continue`, {
    method: 'POST',
    body: { dir },
    schema: GitConflictFinishResponseSchema,
  })
}

/** `git rebase --abort` / `git merge --abort`. Destructive, so `confirm` is a required literal on the wire and the panel puts a danger-styled confirmation in front of it. */
export async function abortGitConflict(dir: string | undefined) {
  return apiRequest(`${BASE}/conflict/abort`, {
    method: 'POST',
    body: { dir, confirm: true },
    schema: GitConflictFinishResponseSchema,
  })
}

// A pull refusal carries a `code` and, for a conflict, the unmerged paths —
// and the browser still deliberately does not read either, for the reason the
// `isGitStateRefusal` doc above gives. After a refused pull the panel asks the
// REPOSITORY what state it is in (`getGitConflicts`, plus the ahead/behind the
// status it already has), which is both fresher than an error body computed a
// request ago and impossible to get subtly wrong. The fields stay on the wire
// for non-browser clients reading the same routes.

// ---------------------------------------------------------------------------
// Pull requests (G5) — `/admin/api/studio/git/pull-request*`
//
// Two calls, and the split between them is the point: the GET answers "should
// this panel offer to open a PR at all, and what would it compare?", so the
// browser never parses a remote URL and never digs a field out of an error
// body. The POST is then one click with defaults the server read out of the
// repository.
// ---------------------------------------------------------------------------

const GitPullRequestContextSchema = Type.Object({
  /** `false` for a project with no origin, or an origin that is not GitHub. A normal 200, like `isRepo: false`. */
  supported: Type.Boolean(),
  /** The branch a PR would merge INTO — `origin/HEAD`, or `main` when nobody ever set one. */
  base: Type.Union([Type.String(), Type.Null()]),
  /** The current branch. */
  head: Type.Union([Type.String(), Type.Null()]),
  /** GitHub's pre-filled compare page. Offered as a link whether or not a token exists. */
  compareUrl: Type.Union([Type.String(), Type.Null()]),
  /** You are standing on the base branch; a PR from it to itself has no meaning. */
  isDefaultBranch: Type.Boolean(),
})

const GitPullRequestResponseSchema = Type.Object({
  ok: Type.Boolean(),
  url: Type.String(),
  number: Type.Number(),
  compareUrl: Type.String(),
})

export type GitPullRequestContext = Static<typeof GitPullRequestContextSchema>
export type GitPullRequestResult = Static<typeof GitPullRequestResponseSchema>

/** Whether this project can have a pull request opened from it, and the compare URL if so. A read. */
export async function getGitPullRequestContext(
  dir: string | undefined,
  signal?: AbortSignal,
): Promise<GitPullRequestContext> {
  return apiRequest(`${BASE}/pull-request/context`, { schema: GitPullRequestContextSchema, query: { dir }, signal })
}

/**
 * Opens a pull request for the current branch.
 *
 * Every field is optional: the server defaults `base` from `origin/HEAD`,
 * `title` from the last commit subject and `body` from the commit list, so the
 * ordinary case is one click. With no connected GitHub account the server
 * refuses with `no-github-token` and the panel falls back to the compare link
 * it already has from `getGitPullRequestContext`.
 */
export async function openGitPullRequest(
  dir: string | undefined,
  options: { title?: string; body?: string; base?: string } = {},
): Promise<GitPullRequestResult> {
  return apiRequest(`${BASE}/pull-request`, {
    method: 'POST',
    // Named one by one rather than spread. `dir` decides which project the
    // server acts on, and a spread after it lets any future field on
    // `options` — or any caller that reaches this through a looser type —
    // silently take that decision over. The wire shape is small enough to
    // write out, so it is written out.
    body: { dir, title: options.title, body: options.body, base: options.base },
    schema: GitPullRequestResponseSchema,
  })
}
