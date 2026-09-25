/**
 * gitOperations — the ten things Studio is allowed to ask git to do, and
 * nothing else.
 *
 * Each exported function builds its own argv from already-validated pieces and
 * hands it to `runGit` (`gitRunner.ts`, which owns the spawn discipline and
 * the "is this really the project's own repository" guard). There is
 * deliberately no generic passthrough: **the route surface IS the allowed
 * command set**. No force push. No reset. No clean. No checkout of a ref while
 * the tree is dirty. No `git add -A` outside `init`.
 *
 * ## The refusals, and why each one exists
 *
 * - **Switching branches with a dirty tree refuses**, returning the dirty file
 *   list so the client can offer "commit these first". Studio never stashes on
 *   the user's behalf: a stash is an invisible place their work went, and a
 *   design tool that loses a screen into `refs/stash` has lost it as far as the
 *   user is concerned. It never force-switches either, for the obvious reason.
 * - **Creating a branch is NOT blocked by a dirty tree**, and that is not an
 *   inconsistency. `git switch -c` at HEAD moves a pointer; it cannot change a
 *   single byte in the working tree, so there is nothing to lose. Switching to
 *   an existing branch checks out a different commit, which can. This
 *   distinction is what makes the intended flow — edit on the canvas, then
 *   branch, then commit — work without a stash.
 * - **Committing an empty file list refuses.** `git commit -a` and `git add -A`
 *   are not reachable from any route: a commit stages exactly the paths the
 *   user selected, so a background process that happened to touch a file can
 *   never ride along in a commit the user thinks they understand.
 * - **Pushing without an `origin` remote refuses** rather than inventing one.
 *   Push always names the branch explicitly and always sets upstream; it is
 *   never `--force`, and there is no route that could make it so. Adding that
 *   remote is a separate, explicit act (`setOriginRemote`).
 * - **`origin` is the only remote name Studio writes.** `setOriginRemote` has
 *   no name parameter, and the URL it takes has already been through
 *   `parseGithubRemoteUrl`'s two-shape allowlist — git's URL grammar includes
 *   transports that execute (`ext::`) and transports that point at this
 *   server's own disk (`file://`).
 * - **Restoring a file requires a raw sha** (`gitPaths.isCommitSha`), not git's
 *   revision grammar — the only shas that exist in the UI are ones `git log`
 *   printed.
 * - **Every mutating verb holds the project write lock** (G7,
 *   `projectWriteLock.ts`, via `withGitWriteLock` below) so a canvas save
 *   cannot land between two of its subprocesses, and two git verbs cannot race
 *   into git's own `index.lock`. A verb that waits more than five seconds
 *   refuses with `code: 'busy'`. Reads take no lock — see `withGitWriteLock`.
 *
 * ## What the status view hides, and says it hides
 *
 * Entries under `EXCLUDED_WORKSPACE_DIR_NAMES` (`node_modules`, `dist`,
 * `.next`, `.turbo`, `.git`, and Studio's own `.studio/`) are filtered out of
 * the status list, and the count of what was filtered is reported as
 * `excludedCount` so the panel can say so instead of quietly disagreeing with
 * the user's terminal. They are also unreachable from `diff`, `commit`, and
 * `restore` — `gitPaths.ts` rejects them at the boundary — so this is a
 * consistent rule, not a display filter over a wider capability.
 *
 * ## Credentials
 *
 * Nothing here reads one. `pushCurrentBranch` takes an OPTIONAL `credential`
 * string that its route resolved from the signed-in session (G2's encrypted
 * per-user token — `githubToken.ts`); without one, `push` succeeds exactly
 * when the user's own credential helper or ssh-agent answers, and otherwise
 * fails with git's real message passed through (`clientSafeGitError`). The
 * token is never read from the environment, never accepted as a request
 * field, and never placed in argv or a remote URL — `gitRunner.ts` hands it to
 * a one-shot askpass script instead.
 *
 * **The token is only offered to a github.com remote.** An askpass program
 * answers whatever host git dialled — it is handed a prompt string, not a
 * destination it can refuse — so every network verb (`push`, `fetch`, `pull`)
 * reads `origin`'s push URL through `originAcceptsStoredGithubToken` and drops
 * the credential unless `parseGithubRemoteUrl` accepts it. `origin` is not
 * always Studio's: `setOriginRemote` only ever writes an allowlisted URL, but a
 * project can arrive with a `.git` pointing anywhere.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES, excludedWorkspaceSegment } from '@core/page-parser'
import { splitLines } from '@core/utils/lineEndings'
import { isArgvSafeBranchName, parseGithubRemoteUrl, redactRemoteUrlCredentials } from './gitPaths'
import { GIT_LOCK_WAIT_MS, ProjectWriteLockBusyError, withProjectWriteLock } from './projectWriteLock'
import {
  clientSafeGitError,
  runGit,
  GIT_NETWORK_TIMEOUT_MS,
  type GitRunResult,
} from './gitRunner'
import {
  GIT_LOG_FORMAT,
  parseGitLogRecords,
  parseGitRemoteLines,
  parseGitStatusPorcelainV2,
  type GitLogEntry,
  type GitRemote,
  type GitStatus,
  type GitStatusEntry,
} from './gitOutputParse'
import { readAllTurnWrites } from './turnWriteLog'

/** Enough history for "what happened recently" without turning the log route into a repository export. */
export const MAX_LOG_COMMITS = 50

/** A refusal any operation can produce. `message` is already client-safe (no absolute paths, bounded length). */
export interface GitOperationFailure {
  ok: false
  code:
    | 'dirty-tree'
    | 'invalid-branch-name'
    | 'no-origin-remote'
    | 'detached-head'
    | 'empty-file-list'
    | 'already-a-repository'
    | 'busy'
    /** A pull stopped on a conflict, or `continue` found the next commit conflicts too. */
    | 'conflict'
    /** `ff-only` could not fast-forward: both sides have commits. The panel asks rebase or merge. */
    | 'diverged'
    /** `continue` was asked for while files are still unmerged. */
    | 'unresolved-conflicts'
    /** `continue`/`abort`/`resolve` with no rebase or merge stopped. */
    | 'nothing-in-progress'
    | 'git-failed'
  message: string
  /** Present only for `dirty-tree` — the paths that must be dealt with first. */
  dirtyFiles?: string[]
  /** Present only for `conflict`/`unresolved-conflicts` — the unmerged paths, so the panel can offer a choice per file. */
  conflictFiles?: string[]
}

/**
 * A status entry plus the one thing git cannot know: whether Studio's own
 * agent wrote this file.
 *
 * The agent authors files natively (`Write`/`Edit` inside the project `cwd`),
 * which never touches Studio's HTTP surface — `turnWriteLog.ts` exists because
 * a `PostToolUse` hook is the only signal that fires exactly when that happens.
 * Pairing it with git status is what lets the panel say "the AI wrote this one"
 * next to a file the user is about to commit under their own name.
 *
 * **Scope, stated honestly:** the write log is reset at the start of every
 * turn, so `agentAuthored` means "written by the agent during the MOST RECENT
 * turn", not "ever written by an agent". A file the agent wrote three turns
 * ago and the user has not committed shows as unlabelled. That is a real
 * limitation of the underlying signal, not of this pairing — a durable
 * per-file authorship record would be a different (and much larger) feature.
 */
export interface GitStatusEntryWithAuthorship extends GitStatusEntry {
  agentAuthored: boolean
}

export interface GitProjectStatus {
  branch: GitStatus['branchStatus']
  entries: GitStatusEntryWithAuthorship[]
  /** How many changed paths were withheld because they sit under an excluded directory — see the module doc. */
  excludedCount: number
  /** Whether an `origin` remote exists. `false` disables push in the panel instead of failing on click. */
  hasOrigin: boolean
}

/** True when the path's FIRST segment (or any segment) is a directory Studio never lets git touch. */
function isExcludedPath(path: string): boolean {
  // Case-folded: on Windows and macOS `.STUDIO` IS `.studio`.
  return excludedWorkspaceSegment(path) !== null
}

/** `git status --porcelain=v2 --branch -z`, parsed, plus the two extra facts the panel needs. */
export async function readGitStatus(dir: string): Promise<GitProjectStatus | GitOperationFailure> {
  const result = await runGit(dir, ['status', '--porcelain=v2', '--branch', '-z'])
  if (!result.ok) return gitFailure('git-failed', clientSafeGitError(result, 'Could not read git status'))

  const parsed = parseGitStatusPorcelainV2(result.stdout)
  // Every account's log, not just the viewer's: "an agent wrote this file" is
  // a fact about the working tree, and a colleague's agent-written file must
  // not be shown to this viewer as hand-written. See `readAllTurnWrites`.
  const agentWritten = new Set(readAllTurnWrites(dir).map((entry) => entry.file))
  const kept = parsed.entries
    .filter((entry) => !isExcludedPath(entry.path))
    .map((entry) => ({ ...entry, agentAuthored: agentWritten.has(entry.path) }))
  return {
    branch: parsed.branchStatus,
    entries: kept,
    excludedCount: parsed.entries.length - kept.length,
    hasOrigin: await hasOriginRemote(dir),
  }
}

/** Whether an `origin` remote exists at all. Exported for `gitSyncOperations.ts`'s fetch, which has the same precondition. */
export async function hasOriginRemote(dir: string): Promise<boolean> {
  const result = await runGit(dir, ['remote'])
  if (!result.ok) return false
  return splitLines(result.stdout).some((line) => line.trim() === 'origin')
}

/**
 * True when `origin`'s push URL is a repository on github.com — the ONLY
 * remote a stored GitHub token may be offered to.
 *
 * This is not belt-and-braces, it is the guard. `GIT_ASKPASS` answers whatever
 * host git is talking to: the script `gitAskpass.ts` writes prints the token
 * for every "Password for '…'" prompt, because an askpass program is not told
 * which credential the caller intended. So the decision "is this remote
 * allowed to see this token" has to be made HERE, before the script exists.
 *
 * `origin` is not always Studio's: `setOriginRemote` writes only URLs that
 * passed `parseGithubRemoteUrl`, but a project can arrive with a `.git` whose
 * `origin` the user set in their own terminal — a company GitLab, a mirror, an
 * `ext::` transport. Without this check the first push after signing in hands
 * that host a token with the `repo` scope over the whole account.
 *
 * A non-GitHub origin is NOT an error: the push proceeds with no credential
 * from Studio, which is exactly the pre-G2 behaviour (the host's own helper or
 * ssh-agent answers, or git reports why it could not).
 *
 * Exported because it IS the guard — it gets its own rejection tests rather
 * than being reachable only through a push that needs a network.
 */
export async function originAcceptsStoredGithubToken(dir: string): Promise<boolean> {
  const result = await runGit(dir, ['remote', 'get-url', '--push', 'origin'])
  if (!result.ok) return false
  const url = splitLines(result.stdout.trim())[0]?.trim() ?? ''
  return parseGithubRemoteUrl(url) !== null
}

/**
 * Every remote this repository has, as `git remote -v` reports them, with any
 * credential redacted out of the URLs — see {@link redactRemoteUrlCredentials}.
 *
 * Otherwise unfiltered: a project that already had three remotes when the
 * user opened it should SEE three, even though Studio will only ever write
 * `origin`. Hiding them would make the panel disagree with the user's
 * terminal, which is the failure mode `excludedCount` exists to avoid
 * elsewhere in this module. The reading itself is `parseGitRemoteLines`.
 */
export async function readRemotes(dir: string): Promise<GitRemote[] | GitOperationFailure> {
  const result = await runGit(dir, ['remote', '-v'])
  if (!result.ok) return gitFailure('git-failed', clientSafeGitError(result, 'Could not read the remotes'))
  // Parsed once, CRLF-safe, by the module that owns git's output grammar; then
  // redacted HERE and not at the route, so every consumer of this function
  // inherits it and a second redaction at a second call site is not a second
  // policy. A repo cloned outside Studio can carry a token in `.git/config`.
  return parseGitRemoteLines(result.stdout).map((remote) => ({
    ...remote,
    fetchUrl: redactRemoteUrlCredentials(remote.fetchUrl),
    pushUrl: redactRemoteUrlCredentials(remote.pushUrl),
  }))
}

/**
 * Points `origin` at `url`, creating it or replacing it.
 *
 * Two deliberate narrowings, both from the G1 work order:
 *
 *   - **`origin` is the only name.** There is no parameter for another one.
 *     A designer who needs a second remote has a terminal; a UI that can
 *     create arbitrarily-named remotes is a UI that can create one Studio's
 *     own push path then silently disagrees with.
 *   - **`url` must already have been through `parseGithubRemoteUrl`**, and
 *     what is passed here is that function's RE-COMPOSED url, never the
 *     caller's string. This function does not re-validate, and its only
 *     callers are the route and the clone job, both of which do.
 *
 * `set-url` then `add` rather than `remove` then `add`: replacing a remote
 * must not drop the remote-tracking refs a later fetch/pull depends on.
 */
export async function setOriginRemote(dir: string, url: string): Promise<GitRemote | GitOperationFailure> {
  const setUrl = await runGit(dir, ['remote', 'set-url', 'origin', url])
  if (!setUrl.ok) {
    const add = await runGit(dir, ['remote', 'add', 'origin', url])
    if (!add.ok) return gitFailure('git-failed', clientSafeGitError(add, 'Could not set the origin remote'))
  }

  const remotes = await readRemotes(dir)
  if (isGitFailure(remotes)) return remotes
  const origin = remotes.find((remote) => remote.name === 'origin')
  if (!origin) return gitFailure('git-failed', 'git accepted the remote but did not report it back.')
  return origin
}

export interface GitFileDiff {
  file: string
  /** `git diff --cached -- <file>` — what is staged, relative to HEAD. Empty when nothing is staged for this path. */
  staged: string
  /** `git diff -- <file>` for a tracked file, or a `/dev/null` diff for an untracked one. Empty when the working tree matches the index. */
  unstaged: string
  /** `true` when the file is untracked, so the client can label `unstaged` as "new file" rather than "unstaged changes". */
  untracked: boolean
  /** `true` when either diff hit `runGit`'s output cap — the panel says so instead of showing a silently cut-off hunk as if it were the whole change. */
  truncated: boolean
}

/**
 * Both halves of one file's diff. `relPath` must already have been through
 * `resolveWorkspaceRelativePath` — this function does not re-validate, and its
 * only caller is the route, which does.
 *
 * An untracked file has nothing in the index to diff against, so it is diffed
 * against `/dev/null` with `--no-index`. That form exits 1 when the files
 * differ, which is the normal case here — hence the explicit exit-code
 * handling rather than `result.ok`.
 */
export async function readGitFileDiff(dir: string, relPath: string): Promise<GitFileDiff | GitOperationFailure> {
  const untracked = await isUntracked(dir, relPath)

  if (untracked) {
    const result = await runGit(dir, ['diff', '--no-index', '--', '/dev/null', relPath])
    // 0 = identical (an empty new file), 1 = differs. Anything else is a real failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return gitFailure('git-failed', clientSafeGitError(result, 'Could not read the diff for this file'))
    }
    return { file: relPath, staged: '', unstaged: result.stdout, untracked: true, truncated: result.stdoutTruncated }
  }

  const [unstagedResult, stagedResult] = await Promise.all([
    runGit(dir, ['diff', '--', relPath]),
    runGit(dir, ['diff', '--cached', '--', relPath]),
  ])
  if (!unstagedResult.ok || !stagedResult.ok) {
    const failed = unstagedResult.ok ? stagedResult : unstagedResult
    return gitFailure('git-failed', clientSafeGitError(failed, 'Could not read the diff for this file'))
  }
  return {
    file: relPath,
    staged: stagedResult.stdout,
    unstaged: unstagedResult.stdout,
    untracked: false,
    truncated: unstagedResult.stdoutTruncated || stagedResult.stdoutTruncated,
  }
}

/** `git ls-files --error-unmatch` exits non-zero for a path git has never tracked — the cheapest honest answer to "is this untracked?". */
async function isUntracked(dir: string, relPath: string): Promise<boolean> {
  const result = await runGit(dir, ['ls-files', '--error-unmatch', '--', relPath])
  return !result.ok
}

/** Recent history for the panel's log view. A repository with no commits yet returns an empty list, not a failure. The reading itself is `parseGitLogRecords`. */
export async function readGitLog(dir: string, limit: number): Promise<GitLogEntry[] | GitOperationFailure> {
  const capped = Math.max(1, Math.min(Math.trunc(limit), MAX_LOG_COMMITS))
  const result = await runGit(dir, ['log', `--max-count=${capped}`, `--format=${GIT_LOG_FORMAT}`])
  if (!result.ok) {
    // A fresh repository has no HEAD; `git log` fails there and that is not an error worth surfacing.
    if (/does not have any commits yet|unknown revision/i.test(result.stderr)) return []
    return gitFailure('git-failed', clientSafeGitError(result, 'Could not read the commit log'))
  }
  return parseGitLogRecords(result.stdout)
}

/**
 * Runs one MUTATING git verb with exclusive write access to the project.
 *
 * A git verb is a sequence of subprocesses with real `await` points between
 * them, and a canvas save is synchronous — so without this, a save lands
 * BETWEEN the staging step and the commit step, and the commit contains
 * content the user never reviewed. Two overlapping git verbs produce git's own
 * `index.lock` error, which carries a filesystem path and has no business
 * reaching a browser. See `projectWriteLock.ts`.
 *
 * Five seconds, then `busy` — a 409 at the route. A person who clicked Commit
 * would rather be told the project is busy than watch a spinner for the length
 * of a dependency install.
 *
 * READS (`readGitStatus`, `readGitFileDiff`, `readGitLog`, `listGitBranches`)
 * deliberately do NOT go through here: they mutate nothing, the panel re-reads
 * status after every action, and a read that could answer `busy` would turn
 * the whole panel into an error state for the duration of an install.
 */
export async function withGitWriteLock<T>(
  dir: string,
  run: () => Promise<T | GitOperationFailure>,
): Promise<T | GitOperationFailure> {
  try {
    return await withProjectWriteLock(dir, run, { waitMs: GIT_LOCK_WAIT_MS })
  } catch (err) {
    if (err instanceof ProjectWriteLockBusyError) return gitFailure('busy', err.message)
    throw err
  }
}

export interface GitBranchResult {
  ok: true
  branch: string
  created: boolean
}

/**
 * Creates a branch at HEAD and switches to it, or switches to an existing one.
 *
 * The dirty-tree rule differs between the two on purpose — see the module doc.
 * `name` is validated twice: `isArgvSafeBranchName` (so it can never pose as a
 * flag) and then git's own `check-ref-format`, which is the authority on what
 * a ref may be called.
 */
export function switchBranch(
  dir: string,
  name: string,
  mode: 'create' | 'switch',
): Promise<GitBranchResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runSwitchBranch(dir, name, mode))
}

/**
 * Both halves of "is this a usable branch name", as a reusable refusal:
 * argv-safety first (`gitPaths.ts` — a leading `-` would be read as a flag by
 * the very command that is about to receive it), then git's own
 * `check-ref-format`, which is the authority on what a ref may be called
 * (`feat..x`, `x.lock`, `x~1` all fail here and nowhere else).
 *
 * Exported because `commitAndSwitchBranch` has to ask BEFORE it commits.
 * Leaving the second half inside `switchBranch` meant a name that passed
 * argv-safety but failed `check-ref-format` produced a commit that existed
 * only to enable a switch that then refused — the outcome that function's
 * own doc calls the worst of both.
 */
export async function assertUsableBranchName(
  dir: string,
  name: string,
): Promise<GitOperationFailure | null> {
  if (!isArgvSafeBranchName(name)) {
    return gitFailure('invalid-branch-name', `"${name}" is not a usable branch name.`)
  }
  const refCheck = await runGit(dir, ['check-ref-format', `refs/heads/${name}`])
  if (!refCheck.ok) {
    return gitFailure('invalid-branch-name', `git rejected "${name}" as a branch name.`)
  }
  return null
}

async function runSwitchBranch(
  dir: string,
  name: string,
  mode: 'create' | 'switch',
): Promise<GitBranchResult | GitOperationFailure> {
  const unusable = await assertUsableBranchName(dir, name)
  if (unusable) return unusable

  if (mode === 'switch') {
    const dirty = await dirtyPaths(dir)
    if (dirty === null) return gitFailure('git-failed', 'Could not read git status before switching branches.')
    if (dirty.length > 0) {
      return {
        ok: false,
        code: 'dirty-tree',
        message:
          'There are uncommitted changes in this project. Studio will not switch branches over them and will never stash them — commit them first, or discard them yourself.',
        dirtyFiles: dirty,
      }
    }
  }

  const args = mode === 'create' ? ['switch', '--create', name] : ['switch', name]
  const result = await runGit(dir, args)
  if (!result.ok) return gitFailure('git-failed', clientSafeGitError(result, 'Could not switch branch'))
  return { ok: true, branch: name, created: mode === 'create' }
}

/** Every path git considers changed, excluded dirs already filtered out. `null` when status itself failed. */
async function dirtyPaths(dir: string): Promise<string[] | null> {
  const status = await readGitStatus(dir)
  if ('ok' in status) return null
  return status.entries.map((entry) => entry.path)
}

export interface GitCommitResult {
  ok: true
  sha: string
  shortSha: string
  /** The paths actually committed — exactly the requested list, echoed so the client can confirm nothing else rode along. */
  files: string[]
}

/**
 * Stages exactly `files` and commits exactly `files`.
 *
 * The pathspec is repeated on both `git add` and `git commit` deliberately:
 * `add` puts the selected content in the index, and the `commit` pathspec
 * bounds the commit to those paths even if something else was already staged
 * by a process Studio does not control. `-A`/`-a` appear nowhere.
 *
 * `files` must already have been through `resolveWorkspaceRelativePath`.
 */
export function commitFiles(
  dir: string,
  message: string,
  files: readonly string[],
): Promise<GitCommitResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runCommitFiles(dir, message, files))
}

async function runCommitFiles(
  dir: string,
  message: string,
  files: readonly string[],
): Promise<GitCommitResult | GitOperationFailure> {
  if (files.length === 0) {
    return gitFailure('empty-file-list', 'Select at least one file to commit.')
  }

  const add = await runGit(dir, ['add', '--', ...files])
  if (!add.ok) return gitFailure('git-failed', clientSafeGitError(add, 'Could not stage the selected files'))

  const commit = await runGit(dir, ['commit', '--message', message, '--', ...files])
  if (!commit.ok) return gitFailure('git-failed', clientSafeGitError(commit, 'Could not create the commit'))

  const head = await runGit(dir, ['rev-parse', 'HEAD'])
  const sha = head.ok ? head.stdout.trim() : ''
  return { ok: true, sha, shortSha: sha.slice(0, 7), files: [...files] }
}

export interface GitPushResult {
  ok: true
  branch: string
  /** git's own stdout+stderr for the push, client-safe — the remote's "create a pull request" hint lives here and is worth showing. */
  output: string
}

/**
 * `git push --set-upstream origin <branch>`. Never `--force`, never
 * `--force-with-lease`, and there is no route parameter that could add one.
 *
 * `credential` is the signed-in user's GitHub token (G2), resolved by the
 * route from the session — never from a request field and never from the
 * environment. It is optional: without it the push falls back to the user's
 * own credential helper or ssh-agent exactly as it did before, and a failure
 * passes git's real message through, because "Support for password
 * authentication was removed" is exactly what the user needs to read.
 *
 * It is also DROPPED when `origin` is not a github.com repository — see
 * `originAcceptsStoredGithubToken`. An askpass program answers whatever host
 * git dialled, so "which remote may see this token" is decided here.
 */
export function pushCurrentBranch(
  dir: string,
  options: { credential?: string } = {},
): Promise<GitPushResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runPushCurrentBranch(dir, options))
}

async function runPushCurrentBranch(
  dir: string,
  options: { credential?: string },
): Promise<GitPushResult | GitOperationFailure> {
  const status = await readGitStatus(dir)
  if ('ok' in status) return status
  if (!status.hasOrigin) {
    return gitFailure(
      'no-origin-remote',
      'This project has no "origin" remote, so there is nowhere to push. Add one with git, then try again.',
    )
  }
  if (status.branch.detached || !status.branch.branch) {
    return gitFailure('detached-head', 'HEAD is detached, so there is no branch to push. Switch to a branch first.')
  }

  const branch = status.branch.branch
  // Resolved BEFORE the token is written anywhere: a non-GitHub origin never
  // causes an askpass script carrying the token to exist at all.
  const credential =
    options.credential && (await originAcceptsStoredGithubToken(dir)) ? options.credential : undefined
  const result = await runGit(dir, ['push', '--set-upstream', 'origin', branch], {
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    credential,
  })
  if (!result.ok) return gitFailure('git-failed', clientSafeGitError(result, 'Push failed'))
  return { ok: true, branch, output: clientSafeGitError(result, '') || result.stdout.trim() }
}

/** The `.gitignore` a fresh repository gets when the project has none — the same directories Studio already refuses to let git touch. */
const SCAFFOLDED_GITIGNORE = `${[...EXCLUDED_WORKSPACE_DIR_NAMES].sort().join('\n')}\n`

export interface GitInitResult {
  ok: true
  branch: string
  sha: string
  filesCommitted: number
}

/**
 * `git init` + one initial commit of the current tree.
 *
 * This is the only operation that stages with `-A`, because "commit the
 * project as it stands" is what an initial commit means. To keep that from
 * meaning "commit `node_modules`", a `.gitignore` listing the excluded
 * directories is written FIRST — but only when the project has none. An
 * existing `.gitignore` is never modified: it is the user's file and their
 * intent.
 *
 * The caller is responsible for the explicit confirmation flag; this function
 * only refuses the cases that are wrong regardless of consent (a repository
 * already exists).
 */
export function initRepository(dir: string, message: string): Promise<GitInitResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runInitRepository(dir, message))
}

async function runInitRepository(dir: string, message: string): Promise<GitInitResult | GitOperationFailure> {
  if (existsSync(join(dir, '.git'))) {
    return gitFailure('already-a-repository', 'This project already has a git repository.')
  }

  const init = await runGit(dir, ['init', '--initial-branch=main'])
  if (!init.ok) return gitFailure('git-failed', clientSafeGitError(init, 'Could not initialise a git repository'))

  const gitignore = join(dir, '.gitignore')
  if (!existsSync(gitignore)) writeFileSync(gitignore, SCAFFOLDED_GITIGNORE)

  const add = await runGit(dir, ['add', '--all'])
  if (!add.ok) return gitFailure('git-failed', clientSafeGitError(add, 'Could not stage the project for its first commit'))

  const commit = await runGit(dir, ['commit', '--message', message])
  if (!commit.ok) return gitFailure('git-failed', clientSafeGitError(commit, 'Could not create the first commit'))

  const head = await runGit(dir, ['rev-parse', 'HEAD'])
  const listed = await runGit(dir, ['ls-files', '-z'])
  const filesCommitted = listed.ok ? listed.stdout.split('\u0000').filter(Boolean).length : 0
  return { ok: true, branch: 'main', sha: head.ok ? head.stdout.trim() : '', filesCommitted }
}

export interface GitRestoreResult {
  ok: true
  file: string
  sha: string
}

/**
 * `git checkout <sha> -- <file>` — one file, one commit, overwriting the
 * working tree copy. The most destructive thing in this feature, which is why
 * the sha must be a literal hash (never `HEAD~1`, never `@{yesterday}`), the
 * path must survive `resolveWorkspaceRelativePath`, and the client puts a
 * danger-styled confirmation in front of it.
 */
export function restoreFileFromCommit(
  dir: string,
  sha: string,
  relPath: string,
): Promise<GitRestoreResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runRestoreFileFromCommit(dir, sha, relPath))
}

async function runRestoreFileFromCommit(
  dir: string,
  sha: string,
  relPath: string,
): Promise<GitRestoreResult | GitOperationFailure> {
  const result = await runGit(dir, ['checkout', sha, '--', relPath])
  if (!result.ok) return gitFailure('git-failed', clientSafeGitError(result, 'Could not restore that file'))
  return { ok: true, file: relPath, sha }
}

/**
 * A refusal, as a value. Exported because `gitSyncOperations.ts` builds the
 * same shape for the remote verbs and must not invent a second vocabulary for
 * it.
 */
export function gitFailure(code: GitOperationFailure['code'], message: string): GitOperationFailure {
  return { ok: false, code, message }
}

/** Narrowing helper — every operation returns either its success shape or a `GitOperationFailure`, and only the failure carries `ok: false`. */
export function isGitFailure(value: object): value is GitOperationFailure {
  return 'ok' in value && (value as { ok: unknown }).ok === false
}

export type { GitRunResult }
