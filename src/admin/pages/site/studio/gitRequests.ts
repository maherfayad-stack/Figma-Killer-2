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
