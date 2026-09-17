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
 * There are none here. `push` succeeds if the user's own git credential helper
 * or ssh-agent answers, and otherwise fails with git's real message passed
 * through (`clientSafeGitError`). Studio never stores a git token, never reads
 * one from its environment, and never accepts one on this wire.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { isArgvSafeBranchName } from './gitPaths'
import { GIT_LOCK_WAIT_MS, ProjectWriteLockBusyError, withProjectWriteLock } from './projectWriteLock'
import {
  clientSafeGitError,
  runGit,
  GIT_NETWORK_TIMEOUT_MS,
  type GitRunResult,
} from './gitRunner'
import { parseGitStatusPorcelainV2, type GitStatus, type GitStatusEntry } from './gitStatusParse'
import { readAllTurnWrites } from './turnWriteLog'

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
  return path.split('/').some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))
}

/** `git status --porcelain=v2 --branch -z`, parsed, plus the two extra facts the panel needs. */
export async function readGitStatus(dir: string): Promise<GitProjectStatus | GitOperationFailure> {
  const result = await runGit(dir, ['status', '--porcelain=v2', '--branch', '-z'])
  if (!result.ok) return failure('git-failed', clientSafeGitError(result, 'Could not read git status'))

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

export interface GitBranchSummary {
  /** Short name — `main` for a local branch, `origin/main` for a remote-tracking one. */
  name: string
  /** `true` for a `refs/remotes/…` ref. The panel offers these as "check out a copy of", never as a thing to commit onto. */
  remote: boolean
  /** The one branch HEAD points at. Always exactly one, or none on a detached HEAD. */
  current: boolean
  /** Configured upstream (`origin/main`), or `null`. Always `null` for a remote-tracking ref. */
  upstream: string | null
  /** Commits on this branch not on its upstream. `null` when there is no upstream to compare against. */
  ahead: number | null
  behind: number | null
  /** The upstream is configured but no longer exists on the remote — git's own `gone`. */
  upstreamGone: boolean
}

export interface GitBranchList {
  branches: GitBranchSummary[]
  /** The checked-out branch, or `null` on a detached HEAD. */
  current: string | null
  /**
   * What `origin/HEAD` points at, short form (`main`). This is the remote's
   * own answer to "what is the default branch", and it is what a pull request
   * targets and what "you are on a non-default branch" is measured against.
   * `null` when there is no origin, or when nobody has ever run
   * `git remote set-head`.
   */
  defaultBranch: string | null
}

/** `%xx` in a `for-each-ref` format is a raw byte — 0x1F separates fields, and no ref name may contain a control character. */
const REF_FIELD_SEP = ''

const BRANCH_REF_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
].join('%1f')

/** `ahead 2, behind 1` / `ahead 3` / `behind 4` / `gone` / empty — git's `%(upstream:track,nobracket)`. */
function parseUpstreamTrack(track: string): { ahead: number | null; behind: number | null; gone: boolean } {
  if (track === 'gone') return { ahead: null, behind: null, gone: true }
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  if (!ahead && !behind) return { ahead: null, behind: null, gone: false }
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: false }
}

/**
 * Every branch this repository knows about — local and remote-tracking — with
 * per-branch divergence, in ONE `for-each-ref`.
 *
 * A read: it takes no write lock (see `withGitWriteLock`). The panel replaced
 * a free-text branch field with a dropdown built from this, so it runs
 * whenever the Version control panel opens; one subprocess that answers the
 * whole question is the difference between that being free and being a
 * per-branch `rev-list` storm.
 *
 * `%(upstream:track)` is git's own ahead/behind, computed against whatever
 * each branch's upstream is — it is NOT a fetch, so it is as current as the
 * last fetch and no more. That is exactly what the panel should show: G4's
 * Fetch button is what makes it fresher.
 */
export async function listGitBranches(dir: string): Promise<GitBranchList | GitOperationFailure> {
  const result = await runGit(dir, ['for-each-ref', `--format=${BRANCH_REF_FORMAT}`, 'refs/heads', 'refs/remotes'])
  if (!result.ok) return failure('git-failed', clientSafeGitError(result, 'Could not list branches'))

  const branches: GitBranchSummary[] = []
  let current: string | null = null
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    const [refname, short, upstream, track, head] = line.split(REF_FIELD_SEP)
    if (!refname || !short) continue
    // `origin/HEAD` is a symbolic ref to another entry in this same list, not
    // a branch anyone can check out. It is read separately, below.
    if (refname.endsWith('/HEAD')) continue
    const remote = refname.startsWith('refs/remotes/')
    const isCurrent = head === '*'
    if (isCurrent) current = short
    const { ahead, behind, gone } = parseUpstreamTrack((track ?? '').trim())
    branches.push({
      name: short,
      remote,
      current: isCurrent,
      upstream: remote ? null : upstream || null,
      ahead,
      behind,
      upstreamGone: gone,
    })
  }

  return { branches, current, defaultBranch: await readDefaultBranch(dir) }
}

/** `origin/HEAD` → `main`. Absent on a repository nobody has cloned (git only writes it on clone or an explicit `set-head`), which is a normal `null`, not a failure. */
async function readDefaultBranch(dir: string): Promise<string | null> {
  const result = await runGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (!result.ok) return null
  const value = result.stdout.trim()
  return value.startsWith('origin/') ? value.slice('origin/'.length) : value || null
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
async function withGitWriteLock<T>(
  dir: string,
  run: () => Promise<T | GitOperationFailure>,
): Promise<T | GitOperationFailure> {
  try {
    return await withProjectWriteLock(dir, run, { waitMs: GIT_LOCK_WAIT_MS })
  } catch (err) {
    if (err instanceof ProjectWriteLockBusyError) return failure('busy', err.message)
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

async function runSwitchBranch(
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

export interface GitCommitAndSwitchResult extends GitCommitResult {
  /** The branch now checked out. */
  branch: string
}

/**
 * Commit the named files, then switch — the one action the panel offers when
 * someone picks a different branch with uncommitted work on screen.
 *
 * This exists as a single operation rather than two client calls because the
 * two halves have to be atomic against every other writer: between a commit
 * and a switch, a canvas save can dirty the tree again and turn the switch
 * into a refusal the user did nothing to cause. Both halves run inside ONE
 * hold of the project write lock — `commitFiles` and `switchBranch` acquire it
 * reentrantly, so composing them here costs nothing and cannot deadlock.
 *
 * Studio still never stashes. If the tree is STILL dirty after the commit
 * (files the user did not tick), the switch refuses and says so, naming what
 * is left. The commit stands — it is what the user asked for, it is
 * recoverable, and silently rolling it back would be the surprising option.
 */
export function commitAndSwitchBranch(
  dir: string,
  message: string,
  files: readonly string[],
  branch: string,
): Promise<GitCommitAndSwitchResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runCommitAndSwitch(dir, message, files, branch))
}

async function runCommitAndSwitch(
  dir: string,
  message: string,
  files: readonly string[],
  branch: string,
): Promise<GitCommitAndSwitchResult | GitOperationFailure> {
  // Validate the branch name BEFORE committing: refusing after a commit that
  // only existed to enable the switch would be the worst of both.
  if (!isArgvSafeBranchName(branch)) {
    return failure('invalid-branch-name', `"${branch}" is not a usable branch name.`)
  }

  const committed = await commitFiles(dir, message, files)
  if (isGitFailure(committed)) return committed

  const switched = await switchBranch(dir, branch, 'switch')
  if (isGitFailure(switched)) {
    if (switched.code !== 'dirty-tree') return switched
    return {
      ...switched,
      message: `Committed ${committed.shortSha}, but these files are still uncommitted, so the branch was not switched. Commit or discard them, then switch.`,
    }
  }

  return { ...committed, branch: switched.branch }
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
export function pushCurrentBranch(dir: string): Promise<GitPushResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runPushCurrentBranch(dir))
}

async function runPushCurrentBranch(dir: string): Promise<GitPushResult | GitOperationFailure> {
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

// ---------------------------------------------------------------------------
// Fetch, pull, and the conflicts they can produce (G4)
// ---------------------------------------------------------------------------

/**
 * How a pull is allowed to reconcile divergence. There is no default beyond
 * `ff-only` and no "just figure it out": rebase and merge write different
 * history, and which one a team wants is not something a design tool may
 * decide on their behalf. The panel asks, once, after `ff-only` reports the
 * divergence.
 */
export type GitPullStrategy = 'ff-only' | 'rebase' | 'merge'

export interface GitFetchResult {
  ok: true
  /** git's own fetch output, client-safe. Empty when there was nothing new, which is itself the answer. */
  output: string
}

export interface GitPullResult {
  ok: true
  strategy: GitPullStrategy
  output: string
}

export interface GitConflictState {
  /** The operation that is mid-flight, or `null` when the tree is not in a conflicted state. */
  kind: 'rebase' | 'merge' | null
  /** Paths git reports as unmerged. Empty while `kind` is `null`. */
  files: string[]
}

export interface GitConflictResolveResult {
  ok: true
  file: string
  side: GitConflictSide
}

export interface GitConflictAbortResult {
  ok: true
  kind: 'rebase' | 'merge'
}

/**
 * Whose version of a conflicted file to keep, in the user's terms rather than
 * git's.
 *
 * `--ours`/`--theirs` INVERT between a merge and a rebase — during a rebase
 * your commits are replayed on top of the upstream, so `--ours` is the
 * upstream and `--theirs` is your own work. Asking a designer to know that is
 * how people destroy an afternoon's work with one click, so this wire takes
 * `mine`/`theirs` and the translation happens here, against the operation
 * actually in progress.
 */
export type GitConflictSide = 'mine' | 'theirs'

/** `git fetch --prune origin`. A network verb, so it takes the long timeout; `--prune` is what makes a deleted upstream report as `gone` rather than silently lingering. */
export function fetchRemote(
  dir: string,
  options: { credential?: string } = {},
): Promise<GitFetchResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runFetchRemote(dir, options.credential))
}

async function runFetchRemote(dir: string, credential: string | undefined): Promise<GitFetchResult | GitOperationFailure> {
  if (!(await hasOriginRemote(dir))) {
    return failure('no-origin-remote', 'This project has no "origin" remote, so there is nothing to fetch from.')
  }
  const result = await runGit(dir, ['fetch', '--prune', 'origin'], {
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    credential,
  })
  if (!result.ok) return failure('git-failed', clientSafeGitError(result, 'Fetch failed'))
  return { ok: true, output: clientSafeGitError(result, '') || result.stdout.trim() }
}

/**
 * `git pull` with the strategy the caller named, and nothing else.
 *
 * - **A dirty tree refuses**, naming the files. Studio never stashes, and a
 *   pull over uncommitted work is how a designer loses a screen they never
 *   saw git touch.
 * - **`ff-only` is the default everywhere upstream**, and its failure on
 *   divergence is a FEATURE: it is the moment the panel asks "rebase or
 *   merge?" instead of picking one. That refusal is reported as `diverged`,
 *   not as a git failure.
 * - **A conflict is reported as `conflict` with the unmerged paths**, so the
 *   panel can show them rather than leaving the repository in a state the user
 *   can only understand from a terminal.
 *
 * `-c core.editor=true` is passed because a merge commit would otherwise open
 * an editor no one is watching and hang until the timeout. It is an argv
 * option, not an env var, so it applies to this one invocation only.
 */
export function pullRemote(
  dir: string,
  strategy: GitPullStrategy,
  options: { credential?: string } = {},
): Promise<GitPullResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runPullRemote(dir, strategy, options.credential))
}

async function runPullRemote(
  dir: string,
  strategy: GitPullStrategy,
  credential: string | undefined,
): Promise<GitPullResult | GitOperationFailure> {
  const status = await readGitStatus(dir)
  if ('ok' in status) return status
  if (!status.hasOrigin) {
    return failure('no-origin-remote', 'This project has no "origin" remote, so there is nothing to pull from.')
  }
  if (status.branch.detached || !status.branch.branch) {
    return failure('detached-head', 'HEAD is detached, so there is no branch to pull into. Switch to a branch first.')
  }
  const dirty = status.entries.map((entry) => entry.path)
  if (dirty.length > 0) {
    return {
      ok: false,
      code: 'dirty-tree',
      message:
        'There are uncommitted changes in this project. Studio will not pull over them and will never stash them — commit them first.',
      dirtyFiles: dirty,
    }
  }

  const branch = status.branch.branch
  const strategyArgs =
    strategy === 'rebase'
      ? ['pull', '--rebase', 'origin', branch]
      : strategy === 'merge'
        ? ['pull', '--no-rebase', '--no-edit', 'origin', branch]
        : ['pull', '--ff-only', 'origin', branch]

  const result = await runGit(dir, ['-c', 'core.editor=true', ...strategyArgs], {
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    credential,
  })
  if (result.ok) return { ok: true, strategy, output: clientSafeGitError(result, '') || result.stdout.trim() }

  const conflict = await readConflictState(dir)
  if (conflict.kind) {
    return {
      ok: false,
      code: 'conflict',
      message:
        conflict.kind === 'rebase'
          ? 'Your commits could not be replayed on top of origin cleanly. Resolve each file, then continue.'
          : 'The merge could not be completed cleanly. Resolve each file, then continue.',
      conflictFiles: conflict.files,
    }
  }
  if (strategy === 'ff-only' && /fast-forward|diverg/i.test(result.stderr + result.stdout)) {
    return failure(
      'diverged',
      'origin has commits this branch does not, and this branch has commits origin does not. Choose how to reconcile them: rebase your work on top, or merge.',
    )
  }
  return failure('git-failed', clientSafeGitError(result, 'Pull failed'))
}

/**
 * Whether a rebase or merge is stopped on a conflict, and which paths are
 * unmerged.
 *
 * A read: no write lock, so the panel can show the conflict list on a fresh
 * page load without contending with anything.
 *
 * The in-progress markers are asked for with `rev-parse --git-path` rather
 * than by assuming `<dir>/.git` is a directory — it is a FILE in a linked
 * worktree or a submodule, and a hard-coded path probe would silently answer
 * "no conflict" there.
 *
 * **`REBASE_HEAD` is deliberately NOT the rebase test**, even though it looks
 * like the obvious one: git leaves it behind after a rebase completes
 * successfully (verified against real git, not assumed), so a repository that
 * finished a rebase an hour ago would report itself as still conflicted
 * forever. `.git/rebase-merge` / `.git/rebase-apply` exist only while a rebase
 * is actually in flight.
 */
export async function readConflictState(dir: string): Promise<GitConflictState> {
  const kind = await conflictKind(dir)
  if (!kind) return { kind: null, files: [] }
  const result = await runGit(dir, ['diff', '--name-only', '--diff-filter=U', '-z'])
  return { kind, files: result.ok ? result.stdout.split(' ').filter(Boolean) : [] }
}

async function conflictKind(dir: string): Promise<'rebase' | 'merge' | null> {
  if (await gitPathExists(dir, 'rebase-merge')) return 'rebase'
  if (await gitPathExists(dir, 'rebase-apply')) return 'rebase'
  // MERGE_HEAD exists exactly while a merge is uncommitted, and is cleared by
  // the merge commit. `--quiet` makes absence a silent exit 1.
  if ((await runGit(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok) return 'merge'
  return null
}

/** `git rev-parse --git-path <name>` resolves to a path relative to the repository root, whatever shape `.git` has. */
async function gitPathExists(dir: string, name: string): Promise<boolean> {
  const result = await runGit(dir, ['rev-parse', '--git-path', name])
  if (!result.ok) return false
  const relative = result.stdout.trim()
  return relative.length > 0 && existsSync(resolve(dir, relative))
}

/**
 * Take one side of one conflicted file, and stage it.
 *
 * `relPath` must already have been through `resolveWorkspaceRelativePath` —
 * this function does not re-validate, and its only caller is the route, which
 * does. The `mine`/`theirs` → `--ours`/`--theirs` translation is the whole
 * reason this is a named operation rather than two argv lines at the route;
 * see {@link GitConflictSide}.
 */
export function resolveConflictFile(
  dir: string,
  relPath: string,
  side: GitConflictSide,
): Promise<GitConflictResolveResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runResolveConflictFile(dir, relPath, side))
}

async function runResolveConflictFile(
  dir: string,
  relPath: string,
  side: GitConflictSide,
): Promise<GitConflictResolveResult | GitOperationFailure> {
  const kind = await conflictKind(dir)
  if (!kind) {
    return failure('nothing-in-progress', 'There is no merge or rebase in progress, so there is nothing to resolve.')
  }
  // During a rebase YOUR commit is `--theirs`: the upstream is checked out
  // first and your work is replayed on top of it.
  const flag = kind === 'rebase' ? (side === 'mine' ? '--theirs' : '--ours') : side === 'mine' ? '--ours' : '--theirs'

  const checkout = await runGit(dir, ['checkout', flag, '--', relPath])
  if (!checkout.ok) return failure('git-failed', clientSafeGitError(checkout, 'Could not take that version of the file'))
  const staged = await runGit(dir, ['add', '--', relPath])
  if (!staged.ok) return failure('git-failed', clientSafeGitError(staged, 'Could not stage the resolved file'))
  return { ok: true, file: relPath, side }
}

/**
 * Finish the rebase or merge that is stopped on a conflict.
 *
 * Refuses while anything is still unmerged, naming what — `rebase --continue`
 * would otherwise fail with a message written for a terminal. A rebase can
 * stop AGAIN on the next replayed commit, which is reported as a fresh
 * `conflict` with the new file list rather than as a success that quietly
 * left the repository mid-rebase.
 */
export function continueConflictResolution(dir: string): Promise<GitConflictAbortResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runContinueConflictResolution(dir))
}

async function runContinueConflictResolution(dir: string): Promise<GitConflictAbortResult | GitOperationFailure> {
  const state = await readConflictState(dir)
  if (!state.kind) {
    return failure('nothing-in-progress', 'There is no merge or rebase in progress, so there is nothing to continue.')
  }
  if (state.files.length > 0) {
    return {
      ok: false,
      code: 'unresolved-conflicts',
      message: 'Some files are still unmerged. Choose a version for each one first.',
      conflictFiles: state.files,
    }
  }

  const args = state.kind === 'rebase' ? ['rebase', '--continue'] : ['commit', '--no-edit']
  const result = await runGit(dir, ['-c', 'core.editor=true', ...args])
  if (!result.ok) {
    return failure(
      'git-failed',
      clientSafeGitError(result, state.kind === 'rebase' ? 'Could not continue the rebase' : 'Could not finish the merge'),
    )
  }

  const after = await readConflictState(dir)
  if (after.kind) {
    return {
      ok: false,
      code: 'conflict',
      message: 'The next commit conflicts too. Resolve each file, then continue again.',
      conflictFiles: after.files,
    }
  }
  return { ok: true, kind: state.kind }
}

/**
 * `git rebase --abort` / `git merge --abort` — throw away the in-progress
 * reconciliation and put the branch back where it was.
 *
 * The one destructive verb this work order adds, which is why the client puts
 * the same danger-styled confirmation in front of it that `restore` has. It is
 * still narrower than it looks: abort restores the pre-pull state, and the
 * pull refused to start over a dirty tree, so there is no uncommitted work for
 * it to discard.
 */
export function abortConflictResolution(dir: string): Promise<GitConflictAbortResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runAbortConflictResolution(dir))
}

async function runAbortConflictResolution(dir: string): Promise<GitConflictAbortResult | GitOperationFailure> {
  const kind = await conflictKind(dir)
  if (!kind) {
    return failure('nothing-in-progress', 'There is no merge or rebase in progress, so there is nothing to abort.')
  }
  const result = await runGit(dir, [kind === 'rebase' ? 'rebase' : 'merge', '--abort'])
  if (!result.ok) return failure('git-failed', clientSafeGitError(result, 'Could not abort'))
  return { ok: true, kind }
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
