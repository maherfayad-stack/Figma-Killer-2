/**
 * githubScratchRepo — driving a REAL, throwaway, PRIVATE GitHub repository
 * from a Playwright spec.
 *
 * The G-track dogfood (`STUDIO-FIGMA-FEEL-PLAN.md` §3 G8, `git-22`'s "Human
 * action needed") cannot be met by a fixture: every claim in it — "the branch
 * is on GitHub", "a real PR exists", "Pull brought GitHub's version onto
 * disk" — is a claim about github.com. A local bare repository, which is what
 * `git.test.ts` and `gitSyncRoutes.test.ts` correctly use, can prove the argv
 * is right and proves nothing about the product.
 *
 * So this module gives a spec one thing: a private repository that exists for
 * the length of one run and is destroyed afterwards, plus the reads that let
 * the spec check GitHub's own answer rather than the panel's.
 *
 * ## The four rules this module is built around
 *
 * 1. **The token is never printed, logged, written to disk, or committed.**
 *    Every authenticated call is made by `gh`, which holds the credential in
 *    its own keyring; git's network verbs get it through
 *    `-c credential.helper='!gh auth git-credential'`, which hands the token
 *    from gh to git without it ever passing through this process. The ONE
 *    exception is {@link readGithubTokenForSignIn}, which exists because the
 *    dogfood's first step is a human pasting a token into Studio's sign-in
 *    field — see that function's own doc for the guard it carries.
 * 2. **The repository name says what it is.** `studio-g8-scratch-<unix-ms>`:
 *    unmistakably a throwaway, and unique per run so two runs (or a crashed
 *    run and its successor) can never share one.
 * 3. **Cleanup always runs, and says so when it cannot finish.** Deleting a
 *    repository needs the `delete_repo` scope, which a `repo`-scoped token
 *    does not have and which cannot be granted non-interactively. When the
 *    delete is refused the repository is ARCHIVED instead (read-only, so a
 *    later run cannot push into it by accident) and the caller is handed the
 *    name to report — never silently left behind.
 * 4. **Nothing here asserts.** It creates, seeds, reads and destroys; the
 *    spec decides what any of it means.
 *
 * ## Why `gh` and not the REST API directly
 *
 * A spec that talked to `api.github.com` itself would need the token in this
 * process, in an `Authorization` header, one `console.log` away from a CI log.
 * `gh` already has the credential and already refuses to print it.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Names every scratch repository this suite creates. Grep-able, and obviously disposable. */
export const SCRATCH_REPO_PREFIX = 'studio-g8-scratch-'

/** Author identity for the seed commit. Never a real person — the repo is destroyed. */
const SEED_AUTHOR = ['-c', 'user.name=Studio G8 Dogfood', '-c', 'user.email=g8-dogfood@studio.invalid']

/**
 * Hands git the signed-in `gh` credential for ONE invocation without the token
 * entering this process.
 *
 * The empty first value clears whatever helper the host has configured (on
 * Windows that is Git Credential Manager, which opens a GUI dialog and blocks
 * — the same trap `docs/features/studio-git.md` warns test authors about); the
 * second installs gh's own helper for this command only. Nothing is written to
 * `.git/config`.
 */
const GH_CREDENTIAL_HELPER = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!gh auth git-credential',
]

export interface RunResult {
  readonly ok: boolean
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function run(file: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): RunResult {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 180_000,
    windowsHide: true,
    // `gh` and `git` are both resolved from PATH; `shell: false` (the default)
    // keeps every caller-supplied value an argv token rather than shell text.
  })
  return {
    ok: result.status === 0,
    code: result.status ?? -1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

/** Run `gh`, throwing with gh's own stderr when it fails. */
export function gh(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): string {
  const result = run('gh', args, options)
  if (!result.ok) {
    throw new Error(`gh ${args[0] ?? ''} failed (exit ${result.code}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/** Run `gh` and parse its stdout as JSON. */
export function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T
}

/**
 * Run `git`. Pass `network: true` for any verb that dials github.com so the
 * gh credential helper is installed for that one invocation.
 */
export function git(
  cwd: string,
  args: string[],
  options: { network?: boolean; allowFailure?: boolean; timeoutMs?: number } = {},
): RunResult {
  const prefix = options.network ? GH_CREDENTIAL_HELPER : []
  const result = run('git', [...prefix, ...args], { cwd, timeoutMs: options.timeoutMs })
  if (!result.ok && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd} (exit ${result.code}): ${result.stderr || result.stdout}`)
  }
  return result
}

/** `git` that returns stdout and throws on failure — the common case. */
export function gitOut(cwd: string, args: string[], options: { network?: boolean } = {}): string {
  return git(cwd, args, options).stdout
}

// ─── Availability ────────────────────────────────────────────────────────────

/**
 * Is there a usable GitHub credential on this machine?
 *
 * `gh auth token` is the cheapest honest test: it succeeds only when gh holds
 * a token it can hand over. **Its stdout is discarded here without ever being
 * assigned to a named variable** — this function answers yes/no and nothing
 * else, so a spec can gate itself without the token existing in its scope.
 */
export function githubCredentialAvailable(): boolean {
  return run('gh', ['auth', 'token'], { timeoutMs: 30_000 }).ok
}

/** The login of the account `gh` is signed in as. */
export function githubLogin(): string {
  return gh(['api', 'user', '--jq', '.login'])
}

/**
 * The token, for the ONE place the dogfood genuinely needs it: typing it into
 * Studio's "Paste a token instead" field, which is the sign-in path this
 * machine can actually exercise (`GITHUB_OAUTH_CLIENT_ID` is unset, so the
 * device flow answers 501 — `git-21`).
 *
 * **Contract for every caller:** hand the return value straight to
 * `locator.fill()` and nothing else. Do not log it, do not put it in an
 * assertion message, do not write it to a file, do not pass it to `gh`.
 *
 * The guard below is not decoration. Playwright's trace and video recorders
 * capture `fill` values and page pixels respectively, so a run with either
 * enabled would persist the token into `.tmp/playwright-results`. The field
 * itself is `type="password"`, which is what keeps the failure screenshot
 * (always on) harmless; a trace has no such protection, so the run is refused
 * rather than downgraded.
 */
export function readGithubTokenForSignIn(): string {
  if (process.env.E2E_TRACE === '1' || process.env.E2E_VIDEO === '1') {
    throw new Error(
      'github-sync.e2e.ts refuses to run with E2E_TRACE=1 or E2E_VIDEO=1: a Playwright trace records ' +
        "the value of every fill(), and this spec fills a real GitHub token into Studio's sign-in field. " +
        'Re-run without those variables.',
    )
  }
  const result = run('gh', ['auth', 'token'], { timeoutMs: 30_000 })
  if (!result.ok) throw new Error('gh auth token failed — this spec should have skipped itself.')
  return result.stdout
}

// ─── The scratch repository ──────────────────────────────────────────────────

export interface ScratchRepo {
  readonly owner: string
  readonly name: string
  /** `owner/name` — what every `gh api repos/{full}/…` path wants. */
  readonly full: string
  /** The URL a user would paste into Studio's import dialog. */
  readonly httpsUrl: string
  /** The project folder Studio derives, server-side, for a clone of this repo. */
  readonly expectedProjectFolder: string
}

/**
 * Create `<login>/studio-g8-scratch-<unix-ms>`, private and empty.
 *
 * Issues and the wiki are disabled: nothing in this dogfood uses them, and a
 * repository that cannot receive an issue is one fewer thing left behind if
 * the delete is refused.
 */
export function createScratchRepo(): ScratchRepo {
  const owner = githubLogin()
  const name = `${SCRATCH_REPO_PREFIX}${Date.now()}`
  const full = `${owner}/${name}`
  gh(['repo', 'create', full, '--private', '--disable-issues', '--disable-wiki'], { timeoutMs: 120_000 })
  return {
    owner,
    name,
    full,
    httpsUrl: `https://github.com/${full}`,
    // `gitClone.ts` derives the target from the parsed owner/repo, server-side.
    expectedProjectFolder: `${owner}-${name}`,
  }
}

export type ScratchRepoCleanup =
  | { kind: 'deleted' }
  /** The delete was refused. `detail` is gh's reason, `archived` says whether the fallback worked. */
  | { kind: 'manual-delete-needed'; detail: string; archived: boolean }

/**
 * Destroy the scratch repository. **Never throws** — a cleanup that fails a
 * run tells the reader nothing about the product and hides whatever the run
 * actually found.
 *
 * `gh repo delete` needs the `delete_repo` scope. A `repo`-scoped token (what
 * `gh auth status` reports on a normal developer machine) gets HTTP 403, and
 * `gh auth refresh -s delete_repo` is an interactive browser grant that a spec
 * cannot perform. In that case the repository is archived — GitHub then
 * refuses every write to it, including a push from a later run — and the
 * caller reports the name so a human can finish the job.
 */
export function deleteScratchRepo(repo: ScratchRepo): ScratchRepoCleanup {
  const deleted = run('gh', ['repo', 'delete', repo.full, '--yes'], { timeoutMs: 120_000 })
  // gh exits 0 while printing the 403 to stderr for this particular refusal,
  // so the exit code alone is not the test.
  const refusal = `${deleted.stdout}\n${deleted.stderr}`.trim()
  if (deleted.ok && !/HTTP 4\d\d|delete_repo/i.test(refusal)) return { kind: 'deleted' }

  const archived = run('gh', ['api', '-X', 'PATCH', `repos/${repo.full}`, '-F', 'archived=true'], {
    timeoutMs: 120_000,
  })
  return {
    kind: 'manual-delete-needed',
    detail: refusal || `gh repo delete exited ${deleted.code}`,
    archived: archived.ok,
  }
}

// ─── Seeding, cloning, and reading GitHub's own state ────────────────────────

/** An ephemeral directory outside the repository working tree. */
export function makeTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `studio-g8-${label}-`))
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * Give the empty scratch repository one real commit, containing a copy of a
 * Studio workspace project.
 *
 * The copy is made in the OS temp directory rather than under
 * `studio-workspace/`: a second project folder there would be visible to the
 * server, would be picked up by the "first project on disk" fallback, and
 * would dirty the tracked corpus every other spec measures.
 *
 * Returns the commit sha GitHub now has on `main`, read back from GitHub
 * rather than from the local clone — the point of the seed is that the remote
 * really has it.
 */
export function seedScratchRepo(repo: ScratchRepo, sourceProjectDir: string): { sha: string; workDir: string } {
  const workDir = makeTempDir('seed')
  fs.cpSync(sourceProjectDir, workDir, { recursive: true })
  // A project copied out of this repository's own working tree may carry a
  // `.git` if someone experimented in it; the seed must own its history.
  fs.rmSync(path.join(workDir, '.git'), { recursive: true, force: true })

  git(workDir, ['init', '-b', 'main'])
  git(workDir, [...SEED_AUTHOR, 'add', '-A'])
  git(workDir, [...SEED_AUTHOR, 'commit', '-m', 'seed: the G8 dogfood project'])
  git(workDir, ['remote', 'add', 'origin', `${repo.httpsUrl}.git`])
  git(workDir, ['push', '-u', 'origin', 'main'], { network: true, timeoutMs: 300_000 })
  // An empty repository takes its default branch from the first push, but say
  // so explicitly so the assertion "the dropdown lists main" is about the
  // product rather than about GitHub's default-branch setting.
  gh(['api', '-X', 'PATCH', `repos/${repo.full}`, '-f', 'default_branch=main'])

  return { sha: remoteBranchSha(repo, 'main'), workDir }
}

/** The sha GitHub currently has at the tip of `branch`. Throws when the branch does not exist. */
export function remoteBranchSha(repo: ScratchRepo, branch: string): string {
  return gh(['api', `repos/${repo.full}/branches/${branch}`, '--jq', '.commit.sha'])
}

/** `null` rather than a throw when the branch simply is not there yet. */
export function remoteBranchShaOrNull(repo: ScratchRepo, branch: string): string | null {
  const result = run('gh', ['api', `repos/${repo.full}/branches/${branch}`, '--jq', '.commit.sha'])
  return result.ok ? result.stdout : null
}

export interface RemoteFile {
  /** Decoded UTF-8 contents. */
  readonly text: string
  /** The blob sha the Contents API needs to accept an update. */
  readonly sha: string
}

/** Read one file as GitHub has it on `ref`. */
export function readRemoteFile(repo: ScratchRepo, repoPath: string, ref: string): RemoteFile {
  const response = ghJson<{ content: string; encoding: string; sha: string }>([
    'api',
    `repos/${repo.full}/contents/${repoPath}?ref=${encodeURIComponent(ref)}`,
  ])
  if (response.encoding !== 'base64') {
    throw new Error(`the contents API returned ${response.encoding} for ${repoPath}, which this helper cannot decode`)
  }
  return { text: Buffer.from(response.content, 'base64').toString('utf8'), sha: response.sha }
}

/**
 * Commit a new version of one file **on GitHub**, through the Contents API —
 * the machine equivalent of the dogfood's "edit a file on github.com".
 *
 * Deliberately not a local commit followed by a push: a push would prove the
 * local repository can write, whereas the step being modelled is someone else
 * changing the repository while Studio is not looking.
 *
 * Returns the new commit sha.
 */
export function writeRemoteFile(
  repo: ScratchRepo,
  repoPath: string,
  text: string,
  message: string,
  branch: string,
): string {
  const current = readRemoteFile(repo, repoPath, branch)
  const response = ghJson<{ commit: { sha: string } }>([
    'api',
    '-X',
    'PUT',
    `repos/${repo.full}/contents/${repoPath}`,
    '-f',
    `message=${message}`,
    '-f',
    `content=${Buffer.from(text, 'utf8').toString('base64')}`,
    '-f',
    `sha=${current.sha}`,
    '-f',
    `branch=${branch}`,
  ])
  return response.commit.sha
}

export interface RemotePullRequest {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly headRef: string
  readonly baseRef: string
}

/** Every pull request on the scratch repo, whatever its state. */
export function listRemotePullRequests(repo: ScratchRepo): RemotePullRequest[] {
  return ghJson<RemotePullRequest[]>([
    'api',
    `repos/${repo.full}/pulls?state=all&per_page=50`,
    '--jq',
    '[.[] | {number: .number, title: .title, state: .state, headRef: .head.ref, baseRef: .base.ref}]',
  ])
}

export function closeRemotePullRequest(repo: ScratchRepo, number: number): void {
  gh(['api', '-X', 'PATCH', `repos/${repo.full}/pulls/${number}`, '-f', 'state=closed'])
}

/**
 * A fresh `git clone` of the scratch repository into a temp directory — the
 * independent witness for "what does GitHub actually have".
 *
 * Used where reading the API is not enough: a sha proves a commit exists, a
 * clone proves the file contents that commit carries are the ones Studio
 * pushed.
 */
export function cloneFresh(repo: ScratchRepo, branch: string, label = 'verify'): string {
  const dir = makeTempDir(label)
  const target = path.join(dir, 'clone')
  git(dir, ['clone', '--branch', branch, `${repo.httpsUrl}.git`, target], {
    network: true,
    timeoutMs: 300_000,
  })
  return target
}

// ─── Local repository reads (the on-disk half of every assertion) ────────────

/** The branch currently checked out in `dir`. */
export function localBranch(dir: string): string {
  return gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** The sha at HEAD in `dir`. */
export function localHeadSha(dir: string): string {
  return gitOut(dir, ['rev-parse', 'HEAD'])
}

/** The subject line of the most recent commit in `dir`. */
export function localHeadSubject(dir: string): string {
  return gitOut(dir, ['log', '-1', '--format=%s'])
}

/** `git status --porcelain` as a list of `XY path` lines. */
export function localStatusLines(dir: string): string[] {
  return gitOut(dir, ['status', '--porcelain'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Every path git tracks in `dir`, POSIX-separated, sorted. */
export function localTrackedFiles(dir: string): string[] {
  return gitOut(dir, ['ls-files'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
}

/**
 * Does git have a lock file open in `dir`?
 *
 * The write lock exists precisely so a second writer never surfaces git's own
 * `index.lock` error — and an abandoned `index.lock` is worse than the error,
 * because it wedges the repository until someone deletes it by hand.
 */
export function danglingGitLocks(dir: string): string[] {
  const gitDir = path.join(dir, '.git')
  if (!fs.existsSync(gitDir)) return []
  return ['index.lock', 'HEAD.lock', 'config.lock'].filter((name) => fs.existsSync(path.join(gitDir, name)))
}
