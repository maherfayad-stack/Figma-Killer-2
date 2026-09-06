/**
 * gitOperations — the eight things Studio is allowed to ask git to do, and
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
 *   never `--force`, and there is no route that could make it so.
 * - **Restoring a file requires a raw sha** (`gitPaths.isCommitSha`), not git's
 *   revision grammar — the only shas that exist in the UI are ones `git log`
 *   printed.
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
 * There are none here. `push` succeeds if the user's own git credential helper
 * or ssh-agent answers, and otherwise fails with git's real message passed
 * through (`clientSafeGitError`). Studio never stores a git token, never reads
 * one from its environment, and never accepts one on this wire.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { isArgvSafeBranchName } from './gitPaths'
import {
  clientSafeGitError,
  runGit,
  GIT_NETWORK_TIMEOUT_MS,
  type GitRunResult,
} from './gitRunner'
import { parseGitStatusPorcelainV2, type GitStatus, type GitStatusEntry } from './gitStatusParse'

/** Enough history for "what happened recently" without turning the log route into a repository export. */
export const MAX_LOG_COMMITS = 50

/** ASCII unit/record separators — chosen for `git log --format` because neither can occur in a commit subject, author name, or ISO date. */
const FIELD_SEP = '\u001f'
const RECORD_SEP = '\u001e'

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
    | 'git-failed'
  message: string
  /** Present only for `dirty-tree` — the paths that must be dealt with first. */
  dirtyFiles?: string[]
}

export interface GitProjectStatus {
  branch: GitStatus['branchStatus']
  entries: GitStatusEntry[]
  /** How many changed paths were withheld because they sit under an excluded directory — see the module doc. */
  excludedCount: number
  /** Whether an `origin` remote exists. `false` disables push in the panel instead of failing on click. */
  hasOrigin: boolean
}

/** True when the path's FIRST segment (or any segment) is a directory Studio never lets git touch. */
function isExcludedPath(path: string): boolean {
  return path.split('/').some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))
}

/** `git status --porcelain=v2 --branch -z`, parsed, plus the two extra facts the panel needs. */
export async function readGitStatus(dir: string): Promise<GitProjectStatus | GitOperationFailure> {
  const result = await runGit(dir, ['status', '--porcelain=v2', '--branch', '-z'])
  if (!result.ok) return failure('git-failed', clientSafeGitError(result, 'Could not read git status'))

  const parsed = parseGitStatusPorcelainV2(result.stdout)
  const kept = parsed.entries.filter((entry) => !isExcludedPath(entry.path))
  return {
    branch: parsed.branchStatus,
    entries: kept,
    excludedCount: parsed.entries.length - kept.length,
    hasOrigin: await hasOriginRemote(dir),
  }
}

async function hasOriginRemote(dir: string): Promise<boolean> {
  const result = await runGit(dir, ['remote'])
  if (!result.ok) return false
  return result.stdout.split('\n').some((line) => line.trim() === 'origin')
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
      return failure('git-failed', clientSafeGitError(result, 'Could not read the diff for this file'))
    }
    return { file: relPath, staged: '', unstaged: result.stdout, untracked: true, truncated: result.stdoutTruncated }
  }

  const [unstagedResult, stagedResult] = await Promise.all([
    runGit(dir, ['diff', '--', relPath]),
    runGit(dir, ['diff', '--cached', '--', relPath]),
  ])
  if (!unstagedResult.ok || !stagedResult.ok) {
    const failed = unstagedResult.ok ? stagedResult : unstagedResult
    return failure('git-failed', clientSafeGitError(failed, 'Could not read the diff for this file'))
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

export interface GitLogEntry {
  sha: string
  shortSha: string
  author: string
  /** ISO-8601 with offset (`%aI`) — the client formats it; the server never guesses a locale. */
  date: string
  subject: string
}

/** Recent history for the panel's log view. A repository with no commits yet returns an empty list, not a failure. */
export async function readGitLog(dir: string, limit: number): Promise<GitLogEntry[] | GitOperationFailure> {
  const capped = Math.max(1, Math.min(Math.trunc(limit), MAX_LOG_COMMITS))
  const format = ['%H', '%h', '%an', '%aI', '%s'].join('%x1f') + '%x1e'
  const result = await runGit(dir, ['log', `--max-count=${capped}`, `--format=${format}`])
  if (!result.ok) {
    // A fresh repository has no HEAD; `git log` fails there and that is not an error worth surfacing.
    if (/does not have any commits yet|unknown revision/i.test(result.stderr)) return []
    return failure('git-failed', clientSafeGitError(result, 'Could not read the commit log'))
  }
  return result.stdout
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .flatMap((record) => {
      const [sha, shortSha, author, date, subject] = record.split(FIELD_SEP)
      if (!sha || !shortSha) return []
      return [{ sha, shortSha, author: author ?? '', date: date ?? '', subject: subject ?? '' }]
    })
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
export async function switchBranch(
  dir: string,
  name: string,
  mode: 'create' | 'switch',
): Promise<GitBranchResult | GitOperationFailure> {
  if (!isArgvSafeBranchName(name)) {
    return failure('invalid-branch-name', `"${name}" is not a usable branch name.`)
  }
  const refCheck = await runGit(dir, ['check-ref-format', `refs/heads/${name}`])
  if (!refCheck.ok) {
    return failure('invalid-branch-name', `git rejected "${name}" as a branch name.`)
  }

  if (mode === 'switch') {
    const dirty = await dirtyPaths(dir)
    if (dirty === null) return failure('git-failed', 'Could not read git status before switching branches.')
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
  if (!result.ok) return failure('git-failed', clientSafeGitError(result, 'Could not switch branch'))
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
export async function commitFiles(
  dir: string,
  message: string,
  files: readonly string[],
): Promise<GitCommitResult | GitOperationFailure> {
  if (files.length === 0) {
    return failure('empty-file-list', 'Select at least one file to commit.')
  }

  const add = await runGit(dir, ['add', '--', ...files])
  if (!add.ok) return failure('git-failed', clientSafeGitError(add, 'Could not stage the selected files'))

  const commit = await runGit(dir, ['commit', '--message', message, '--', ...files])
  if (!commit.ok) return failure('git-failed', clientSafeGitError(commit, 'Could not create the commit'))

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
 * Authentication is entirely the user's own credential helper's or
 * ssh-agent's — see the module doc. A failure passes git's real message
 * through, because "Support for password authentication was removed" is
 * exactly what the user needs to read.
 */
export async function pushCurrentBranch(dir: string): Promise<GitPushResult | GitOperationFailure> {
  const status = await readGitStatus(dir)
  if ('ok' in status) return status
  if (!status.hasOrigin) {
    return failure(
      'no-origin-remote',
      'This project has no "origin" remote, so there is nowhere to push. Add one with git, then try again.',
    )
  }
  if (status.branch.detached || !status.branch.branch) {
    return failure('detached-head', 'HEAD is detached, so there is no branch to push. Switch to a branch first.')
  }

  const branch = status.branch.branch
  const result = await runGit(dir, ['push', '--set-upstream', 'origin', branch], {
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
  })
  if (!result.ok) return failure('git-failed', clientSafeGitError(result, 'Push failed'))
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
export async function initRepository(dir: string, message: string): Promise<GitInitResult | GitOperationFailure> {
  if (existsSync(join(dir, '.git'))) {
    return failure('already-a-repository', 'This project already has a git repository.')
  }

  const init = await runGit(dir, ['init', '--initial-branch=main'])
  if (!init.ok) return failure('git-failed', clientSafeGitError(init, 'Could not initialise a git repository'))

  const gitignore = join(dir, '.gitignore')
  if (!existsSync(gitignore)) writeFileSync(gitignore, SCAFFOLDED_GITIGNORE)

  const add = await runGit(dir, ['add', '--all'])
  if (!add.ok) return failure('git-failed', clientSafeGitError(add, 'Could not stage the project for its first commit'))

  const commit = await runGit(dir, ['commit', '--message', message])
  if (!commit.ok) return failure('git-failed', clientSafeGitError(commit, 'Could not create the first commit'))

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
export async function restoreFileFromCommit(
  dir: string,
  sha: string,
  relPath: string,
): Promise<GitRestoreResult | GitOperationFailure> {
  const result = await runGit(dir, ['checkout', sha, '--', relPath])
  if (!result.ok) return failure('git-failed', clientSafeGitError(result, 'Could not restore that file'))
  return { ok: true, file: relPath, sha }
}

function failure(code: GitOperationFailure['code'], message: string): GitOperationFailure {
  return { ok: false, code, message }
}

/** Narrowing helper — every operation returns either its success shape or a `GitOperationFailure`, and only the failure carries `ok: false`. */
export function isGitFailure(value: object): value is GitOperationFailure {
  return 'ok' in value && (value as { ok: unknown }).ok === false
}

export type { GitRunResult }
