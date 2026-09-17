/**
 * gitRequests — the wire contract for `/admin/api/studio/git/*`
 * (`server/handlers/studio/git.ts`).
 *
 * Every call goes through `apiRequest` with a TypeBox schema, so a response
 * shape that drifts from the server fails loudly at the boundary instead of
 * producing `undefined` three components deep. Schemas are the source of truth
 * — the exported types are `Static<typeof …>`, never a hand-written mirror.
 *
 * Two things about the SHAPE of these calls are worth knowing before you use
 * them:
 *
 *   - **`getGitStatus` treats "no repository" as data, not as an error.**
 *     `{ isRepo: false, status: null }` is a normal 200. It is what lets the
 *     panel offer "Initialise a repository" instead of showing a failure for a
 *     project that simply has not been put under version control yet.
 *   - **A refusal is an `ApiError` carrying a `code`.** The server answers 409
 *     with `{ error, code, dirtyFiles? }` for every state-based refusal
 *     (dirty tree, no origin, empty file list, …). `gitRefusalCode(err)` reads
 *     that code back off the thrown error so a caller can branch — the
 *     dirty-tree case in particular, where the panel offers "commit these
 *     first" instead of a dead-end toast.
 *
 * There are no `push --force`, `reset`, or `stash` calls here, and there is
 * nowhere to add one: the server has no route for them.
 */
import { apiRequest, ApiError } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GitChangeKindSchema = Type.Union([
  Type.Literal('added'),
  Type.Literal('modified'),
  Type.Literal('deleted'),
  Type.Literal('renamed'),
  Type.Literal('copied'),
  Type.Literal('type-changed'),
])

const GitStatusEntrySchema = Type.Object({
  /** Repository-root-relative, POSIX-separated. */
  path: Type.String(),
  /** Where a rename/copy came from. */
  originalPath: Type.Union([Type.String(), Type.Null()]),
  /** Index vs HEAD. A file can be staged AND further modified — both fields are populated then. */
  staged: Type.Union([GitChangeKindSchema, Type.Null()]),
  /** Working tree vs index. */
  unstaged: Type.Union([GitChangeKindSchema, Type.Null()]),
  untracked: Type.Boolean(),
  /** A merge conflict. Never offered for a one-click commit. */
  unmerged: Type.Boolean(),
  /**
   * Written by Studio's agent during the MOST RECENT turn — paired
   * server-side with `turnWriteLog.ts`, which git itself cannot know about.
   * Not a durable authorship record: the log resets each turn, so a file the
   * agent wrote several turns ago reads as `false`. See the server-side
   * `GitStatusEntryWithAuthorship` doc.
   */
  agentAuthored: Type.Boolean(),
})

const GitBranchStatusSchema = Type.Object({
  branch: Type.Union([Type.String(), Type.Null()]),
  detached: Type.Boolean(),
  upstream: Type.Union([Type.String(), Type.Null()]),
  ahead: Type.Union([Type.Number(), Type.Null()]),
  behind: Type.Union([Type.Number(), Type.Null()]),
  /** Before the first commit. */
  initial: Type.Boolean(),
})

const GitProjectStatusSchema = Type.Object({
  branch: GitBranchStatusSchema,
  entries: Type.Array(GitStatusEntrySchema),
  /** Changed paths withheld because they sit under `node_modules`/`dist`/`.studio`/… — shown as a note so the panel never silently disagrees with the user's terminal. */
  excludedCount: Type.Number(),
  hasOrigin: Type.Boolean(),
})

const GitStatusResponseSchema = Type.Object({
  isRepo: Type.Boolean(),
  status: Type.Union([GitProjectStatusSchema, Type.Null()]),
})

const GitDiffResponseSchema = Type.Object({
  file: Type.String(),
  staged: Type.String(),
  unstaged: Type.String(),
  untracked: Type.Boolean(),
  truncated: Type.Boolean(),
})

const GitLogEntrySchema = Type.Object({
  sha: Type.String(),
  shortSha: Type.String(),
  author: Type.String(),
  /** ISO-8601 with offset — formatted client-side. */
  date: Type.String(),
  subject: Type.String(),
})

const GitLogResponseSchema = Type.Object({ commits: Type.Array(GitLogEntrySchema) })

const GitBranchResponseSchema = Type.Object({
  ok: Type.Boolean(),
  branch: Type.String(),
  created: Type.Boolean(),
})

const GitCommitResponseSchema = Type.Object({
  ok: Type.Boolean(),
  sha: Type.String(),
  shortSha: Type.String(),
  files: Type.Array(Type.String()),
})

const GitPushResponseSchema = Type.Object({
  ok: Type.Boolean(),
  branch: Type.String(),
  /** git's own push output — the remote's "create a pull request" hint lives here and is worth surfacing. */
  output: Type.String(),
})

const GitInitResponseSchema = Type.Object({
  ok: Type.Boolean(),
  branch: Type.String(),
  sha: Type.String(),
  filesCommitted: Type.Number(),
})

const GitRestoreResponseSchema = Type.Object({
  ok: Type.Boolean(),
  file: Type.String(),
  sha: Type.String(),
})

export type GitChangeKind = Static<typeof GitChangeKindSchema>
export type GitStatusEntry = Static<typeof GitStatusEntrySchema>
export type GitBranchStatus = Static<typeof GitBranchStatusSchema>
export type GitProjectStatus = Static<typeof GitProjectStatusSchema>
export type GitStatusResponse = Static<typeof GitStatusResponseSchema>
export type GitFileDiff = Static<typeof GitDiffResponseSchema>
export type GitLogEntry = Static<typeof GitLogEntrySchema>
export type GitCommitResult = Static<typeof GitCommitResponseSchema>
export type GitPushResult = Static<typeof GitPushResponseSchema>

const BASE = '/admin/api/studio/git'

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Branch, divergence, and every changed path. `{ isRepo: false }` is a normal answer — see the module doc. */
export async function getGitStatus(dir: string | undefined, signal?: AbortSignal): Promise<GitStatusResponse> {
  // `apiRequest` skips `undefined` query values, so an unset `dir` simply
  // means "the server's default project" — the same fallback every other
  // studio route takes.
  return apiRequest(`${BASE}/status`, { schema: GitStatusResponseSchema, query: { dir }, signal })
}

/** Both halves of one file's unified diff. An untracked file arrives as a `/dev/null` diff with `untracked: true`. */
export async function getGitFileDiff(
  dir: string | undefined,
  file: string,
  signal?: AbortSignal,
): Promise<GitFileDiff> {
  return apiRequest(`${BASE}/diff`, { schema: GitDiffResponseSchema, query: { dir, file }, signal })
}

/** Recent commits, newest first. Capped server-side. */
export async function getGitLog(
  dir: string | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<GitLogEntry[]> {
  const { commits } = await apiRequest(`${BASE}/log`, {
    schema: GitLogResponseSchema,
    query: { dir, limit },
    signal,
  })
  return commits
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Creates a branch at HEAD and switches to it. Allowed with uncommitted work — creating a branch cannot lose any. */
export async function createGitBranch(dir: string | undefined, name: string) {
  return apiRequest(`${BASE}/branch`, {
    method: 'POST',
    body: { dir, create: name },
    schema: GitBranchResponseSchema,
  })
}

/**
 * Switches to an existing branch. Refuses with `code: 'dirty-tree'` and the
 * offending paths when there is uncommitted work — Studio never stashes on the
 * user's behalf. Callers should read the code back with `gitRefusalCode`.
 */
export async function switchGitBranch(dir: string | undefined, name: string) {
  return apiRequest(`${BASE}/branch`, {
    method: 'POST',
    body: { dir, switch: name },
    schema: GitBranchResponseSchema,
  })
}

/** Stages and commits EXACTLY `files`. There is no "commit everything" call, by design. */
export async function commitGitFiles(
  dir: string | undefined,
  message: string,
  files: readonly string[],
): Promise<GitCommitResult> {
  return apiRequest(`${BASE}/commit`, {
    method: 'POST',
    body: { dir, message, files: [...files] },
    schema: GitCommitResponseSchema,
  })
}

/** `git push --set-upstream origin <current branch>`. Never a force push — the server has no route for one. */
export async function pushGitBranch(dir: string | undefined): Promise<GitPushResult> {
  return apiRequest(`${BASE}/push`, {
    method: 'POST',
    body: { dir },
    schema: GitPushResponseSchema,
  })
}

/** `git init` plus an initial commit of the whole project. `confirm` is a required literal on the wire — the consent is part of the contract, not a handler branch. */
export async function initGitRepository(dir: string | undefined, message?: string) {
  return apiRequest(`${BASE}/init`, {
    method: 'POST',
    body: { dir, confirm: true, message },
    schema: GitInitResponseSchema,
  })
}

/** Restores ONE file from ONE commit, overwriting the working-tree copy. The caller is responsible for confirming first and reloading the board after. */
export async function restoreGitFile(dir: string | undefined, sha: string, file: string) {
  return apiRequest(`${BASE}/restore`, {
    method: 'POST',
    body: { dir, sha, file },
    schema: GitRestoreResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * True when the server refused because of the REPOSITORY'S STATE rather than
 * because anything went wrong — a dirty tree blocking a branch switch, a
 * missing `origin`, a detached HEAD, a repository that already exists. The
 * server answers all of those with 409 and a message written for a human.
 *
 * The 409 envelope also carries a machine-readable `code` and, for the dirty
 * case, `dirtyFiles`. The BROWSER deliberately does not read either: `ApiError`
 * surfaces only the message and the status, and the panel already has the
 * changed-file list on screen — refetching status after a refusal is both
 * simpler and fresher than trusting a list that was computed a request ago.
 * The fields exist for non-browser clients (a terminal, a future tool) reading
 * the same routes, which is why the server keeps emitting them.
 *
 * The distinction matters because a 409 is not a bug report: the message is
 * the whole answer, and the caller offers the obvious next action (commit
 * first, add a remote) rather than logging a failure.
 */
export function isGitStateRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

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
