/**
 * gitSyncOperations — the git verbs that exist because a project has a REMOTE,
 * and the two local ones that only make sense alongside them.
 *
 * Split out of `gitOperations.ts` (which owns the local verbs: status, diff,
 * log, commit, branch, push, init, restore, remotes) once this half grew past
 * that file's line budget. The split is by responsibility, not by size:
 * everything here is about reconciling this checkout with `origin`, or about
 * proposing the result to the people on the other end of it.
 *
 *   - **branch list** — one `for-each-ref` with per-branch divergence, which is
 *     what replaced the panel's free-text branch field with a dropdown
 *   - **commit-and-switch** — the one action offered instead of a stash
 *   - **fetch / pull** — with a closed strategy union and `diverged` reported
 *     rather than resolved
 *   - **conflicts** — read the stopped rebase/merge, take one side of one file,
 *     continue, abort
 *   - **pull-request context** — which branch, against which remote, with what
 *     in it
 *
 * Everything shared stays in `gitOperations.ts` and is imported, never
 * re-derived: the refusal vocabulary (`GitOperationFailure`, `gitFailure`), the
 * write-lock wrapper (`withGitWriteLock`), the status read, and — most
 * importantly — `originAcceptsStoredGithubToken`, the gate that decides whether
 * a stored GitHub token may be offered to whatever `origin` names.
 *
 * Same rules as its sibling: argv arrays only, no shell, every caller-supplied
 * string already judged by `gitPaths.ts`, no force push, no reset, no clean, no
 * stash. Every MUTATING verb holds the project write lock; the reads
 * (`listGitBranches`, `readConflictState`, `readPullRequestContext`,
 * `readBranchCommitSubjects`) deliberately do not — see `withGitWriteLock`.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { clientSafeGitError, runGit, GIT_NETWORK_TIMEOUT_MS } from './gitRunner'
import {
  assertUsableBranchName,
  commitFiles,
  gitFailure,
  hasOriginRemote,
  isGitFailure,
  MAX_LOG_COMMITS,
  originAcceptsStoredGithubToken,
  readGitStatus,
  switchBranch,
  withGitWriteLock,
  type GitCommitResult,
  type GitOperationFailure,
} from './gitOperations'

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
  if (!result.ok) return gitFailure('git-failed', clientSafeGitError(result, 'Could not list branches'))

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
  // BOTH halves of the branch-name judgement run BEFORE the commit — argv
  // safety and git's own `check-ref-format`. Checking only the first here left
  // the second to `switchBranch`, which runs after `commitFiles`: a name like
  // `feat..x` or `x.lock` passes argv safety, so the commit landed and the
  // switch then refused, which is exactly the "worst of both" this comment
  // used to promise it prevented.
  const unusable = await assertUsableBranchName(dir, branch)
  if (unusable) return unusable

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

/**
 * The credential a NETWORK verb may actually hand to git, which is `undefined`
 * unless `origin` is a github.com repository.
 *
 * `GIT_ASKPASS` answers whatever host git dialled — the script is handed a
 * prompt string, not a destination it can refuse — so passing a stored GitHub
 * token to an invocation whose `origin` is somebody else's server gives that
 * server a `repo`-scoped token for the whole account. `push` learned this the
 * hard way (the security review of PR #151, proven against a local 401
 * listener); `fetch` and `pull` dial exactly the same remote and go through
 * the same gate rather than re-deriving it.
 *
 * A non-GitHub origin is NOT an error: the verb proceeds with no credential
 * from Studio, which is the pre-G2 behaviour — the host's own helper or
 * ssh-agent answers, or git reports why it could not.
 */
async function credentialForOrigin(dir: string, credential: string | undefined): Promise<string | undefined> {
  if (!credential) return undefined
  return (await originAcceptsStoredGithubToken(dir)) ? credential : undefined
}

/** `git fetch --prune origin`. A network verb, so it takes the long timeout; `--prune` is what makes a deleted upstream report as `gone` rather than silently lingering. */
export function fetchRemote(
  dir: string,
  options: { credential?: string } = {},
): Promise<GitFetchResult | GitOperationFailure> {
  return withGitWriteLock(dir, () => runFetchRemote(dir, options.credential))
}

async function runFetchRemote(dir: string, credential: string | undefined): Promise<GitFetchResult | GitOperationFailure> {
  if (!(await hasOriginRemote(dir))) {
    return gitFailure('no-origin-remote', 'This project has no "origin" remote, so there is nothing to fetch from.')
  }
  const result = await runGit(dir, ['fetch', '--prune', 'origin'], {
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    credential: await credentialForOrigin(dir, credential),
  })
  if (!result.ok) return gitFailure('git-failed', clientSafeGitError(result, 'Fetch failed'))
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
    return gitFailure('no-origin-remote', 'This project has no "origin" remote, so there is nothing to pull from.')
  }
  if (status.branch.detached || !status.branch.branch) {
    return gitFailure('detached-head', 'HEAD is detached, so there is no branch to pull into. Switch to a branch first.')
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
    credential: await credentialForOrigin(dir, credential),
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
    return gitFailure(
      'diverged',
      'origin has commits this branch does not, and this branch has commits origin does not. Choose how to reconcile them: rebase your work on top, or merge.',
    )
  }
  return gitFailure('git-failed', clientSafeGitError(result, 'Pull failed'))
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
  return { kind, files: result.ok ? result.stdout.split('\u0000').filter(Boolean) : [] }
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
    return gitFailure('nothing-in-progress', 'There is no merge or rebase in progress, so there is nothing to resolve.')
  }
  // During a rebase YOUR commit is `--theirs`: the upstream is checked out
  // first and your work is replayed on top of it.
  const flag = kind === 'rebase' ? (side === 'mine' ? '--theirs' : '--ours') : side === 'mine' ? '--ours' : '--theirs'

  const checkout = await runGit(dir, ['checkout', flag, '--', relPath])
  if (!checkout.ok) return gitFailure('git-failed', clientSafeGitError(checkout, 'Could not take that version of the file'))
  const staged = await runGit(dir, ['add', '--', relPath])
  if (!staged.ok) return gitFailure('git-failed', clientSafeGitError(staged, 'Could not stage the resolved file'))
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
    return gitFailure('nothing-in-progress', 'There is no merge or rebase in progress, so there is nothing to continue.')
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
    return gitFailure(
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
    return gitFailure('nothing-in-progress', 'There is no merge or rebase in progress, so there is nothing to abort.')
  }
  const result = await runGit(dir, [kind === 'rebase' ? 'rebase' : 'merge', '--abort'])
  if (!result.ok) return gitFailure('git-failed', clientSafeGitError(result, 'Could not abort'))
  return { ok: true, kind }
}

// ---------------------------------------------------------------------------
// What a pull request needs to know (G5)
// ---------------------------------------------------------------------------

export interface GitPullRequestContext {
  /** The branch being proposed. */
  branch: string
  /** `origin`'s URL, verbatim — the route parses it into `{ owner, repo }` with `gitPaths.parseGithubRemoteUrl`, or refuses. */
  originUrl: string
  /** What `origin/HEAD` points at, the natural base. `null` when nobody has ever run `git remote set-head`. */
  defaultBranch: string | null
}

/**
 * Everything the pull-request route needs out of the repository, in one read.
 *
 * A read — no write lock. Opening a pull request changes nothing on disk; it
 * is an HTTP call to GitHub, and the only reason git is involved at all is to
 * answer "which branch, against which remote, with what in it".
 */
export async function readPullRequestContext(dir: string): Promise<GitPullRequestContext | GitOperationFailure> {
  const status = await readGitStatus(dir)
  if ('ok' in status) return status
  if (!status.hasOrigin) {
    return gitFailure(
      'no-origin-remote',
      'This project has no "origin" remote, so there is nothing to open a pull request against.',
    )
  }
  if (status.branch.detached || !status.branch.branch) {
    return gitFailure('detached-head', 'HEAD is detached, so there is no branch to propose. Switch to a branch first.')
  }

  const remote = await runGit(dir, ['remote', 'get-url', 'origin'])
  if (!remote.ok) return gitFailure('git-failed', clientSafeGitError(remote, 'Could not read the origin remote'))

  return {
    branch: status.branch.branch,
    originUrl: remote.stdout.trim(),
    defaultBranch: await readDefaultBranch(dir),
  }
}

/**
 * The subjects of the commits on `head` that are not on `base`, newest first —
 * what a pull request body says when nobody wrote one.
 *
 * `base` is compared against its REMOTE-TRACKING ref (`origin/main`), not the
 * local branch: the local copy of the base branch may be months stale, and a
 * body listing forty commits the reviewer already has is worse than no body.
 * An empty list is a normal answer and never a failure — the route lets GitHub
 * give the "no commits between these branches" verdict, since it is the side
 * that actually knows.
 */
export async function readBranchCommitSubjects(dir: string, base: string, head: string): Promise<string[]> {
  const result = await runGit(dir, ['log', `--max-count=${MAX_LOG_COMMITS}`, '--format=%s', `origin/${base}..${head}`])
  if (!result.ok) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
