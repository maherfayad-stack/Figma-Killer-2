/**
 * gitRunner — the ONE place `git` is executed, and the guard that decides
 * which directory it may be executed in.
 *
 * ## The guard that matters most: which repository is this?
 *
 * A Studio project lives at `studio-workspace/<project>/`, which is itself
 * inside the Studio repository's own working tree. Git discovers a repository
 * by walking UP from its `cwd` until it finds a `.git`. So running `git` in a
 * project directory that has no `.git` of its own does not fail — it silently
 * finds **Studio's own repository** and reports (or commits, or pushes) that.
 * A "commit the user's design changes" button would have committed into this
 * repo. That is the whole reason `assertOwnGitRepo` exists and why it is a
 * precondition on every operation except `init`:
 *
 *   1. the directory must be contained under `studio-workspace/`, checked on
 *      the REAL path so a symlinked project cannot point elsewhere;
 *   2. it must not BE `studio-workspace/` itself (that directory holds every
 *      project and sits inside the Studio repo);
 *   3. `<dir>/.git` must exist, so discovery terminates at the project and can
 *      never reach an ancestor.
 *
 * `GIT_CEILING_DIRECTORIES` is set to the workspace root as a second,
 * independent stop: even if (3) were somehow wrong, discovery cannot walk out
 * of `studio-workspace/`.
 *
 * ## Subprocess discipline
 *
 * Same posture as `installDeps.ts`, and for the same reasons — see
 * `subprocessRunner.ts`'s module doc:
 *
 *   - `Bun.spawn` with an argv ARRAY. There is no shell in this feature and no
 *     caller-supplied value is ever interpolated into a command string. Every
 *     pathspec is passed after a literal `--`.
 *   - `env` is an explicit allowlist (`minimalSubprocessEnv`), never
 *     `process.env` forwarded wholesale. The extra keys are what git genuinely
 *     needs to find the user's own config and credential/SSH agent —
 *     `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME`, … — and deliberately
 *     do NOT include any token variable. **Studio stores no git credentials
 *     and reads none from its environment**: authentication is the user's own
 *     credential helper's job, or it does not happen.
 *   - `GIT_TERMINAL_PROMPT=0` is forced. Without it a push against a remote
 *     needing a password blocks on a terminal read that will never be
 *     answered, and the request sits until the timeout instead of returning
 *     the real "authentication failed" message.
 *   - `stdin: 'ignore'`, byte-capped stdout/stderr, and a timeout that kills
 *     the child.
 *
 * ## The allowed command set
 *
 * There is no generic "run git with these arguments" entry point here, and
 * there must never be one. `gitOperations.ts` builds each argv itself from
 * validated pieces; the route surface IS the allowed command set. No force
 * push, no reset, no clean, no arbitrary passthrough.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectsRootDir } from '../studioProjects'
import {
  minimalSubprocessEnv,
  runCappedSubprocess,
  type CappedSubprocessResult,
  type SubprocessSpawnFn,
} from './subprocessRunner'
import { isRealpathContained } from './workspacePackageResolve'

/** Local operations (status, diff, log, commit) are disk-bound and fast; a hang means something is wrong, not slow. */
export const GIT_LOCAL_TIMEOUT_MS = 20_000
/** Push crosses the network and may hit a slow remote or an interactive-looking credential helper. */
export const GIT_NETWORK_TIMEOUT_MS = 120_000
/** Generous for a real diff or a page of log output, bounded against a pathological repository. */
const MAX_OUTPUT_BYTES = 1_000_000

/**
 * Environment keys git needs to behave like the user's own git: find their
 * config, reach their credential helper, and talk to their ssh-agent. Every
 * one is a locator, none is a secret, and no token variable appears here —
 * see the module doc.
 */
const GIT_ENV_EXTRA_KEYS = [
  'XDG_CONFIG_HOME',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'APPDATA',
  'LOCALAPPDATA',
] as const

/** Why a directory is not usable as a Studio git repository. Each maps to a 404 at the route — never a message carrying a filesystem path. */
export type GitRepoRefusal = 'outside-workspace' | 'not-a-repository'

export interface GitRepoGuardOk {
  ok: true
  /** The project directory, resolved. Only ever used as a spawn `cwd`; never echoed to the client. */
  dir: string
}
export type GitRepoGuardResult = GitRepoGuardOk | { ok: false; reason: GitRepoRefusal }

/**
 * The containment half of the guard, without the `.git` requirement — the
 * precondition `init` needs (it is about to CREATE the repository) and the
 * first half of {@link assertOwnGitRepo}.
 */
export function assertWithinWorkspace(dirInput: string): GitRepoGuardResult {
  const dir = resolve(dirInput)
  const root = resolve(projectsRootDir())
  // The workspace root itself is not a project: it contains every project and
  // lives inside Studio's own repository.
  if (dir === root) return { ok: false, reason: 'outside-workspace' }
  if (!isRealpathContained(dir, root)) return { ok: false, reason: 'outside-workspace' }
  return { ok: true, dir }
}

/**
 * Full guard: contained under `studio-workspace/` AND owning its own `.git`.
 * Every operation except `init` requires this — see the module doc for what
 * goes wrong without the second half.
 */
export function assertOwnGitRepo(dirInput: string): GitRepoGuardResult {
  const contained = assertWithinWorkspace(dirInput)
  if (!contained.ok) return contained
  // `.git` is a directory in a normal clone and a FILE in a linked worktree or
  // submodule — `existsSync` accepts both, which is correct: either way git
  // stops its discovery walk here.
  if (!existsSync(resolve(contained.dir, '.git'))) return { ok: false, reason: 'not-a-repository' }
  return contained
}

/** Cheap, no-subprocess answer to "does this project have a repository yet?" — what the status route reports so the panel can offer `init`. */
export function hasGitRepo(dirInput: string): boolean {
  return assertOwnGitRepo(dirInput).ok
}

export interface GitRunResult extends CappedSubprocessResult {
  /** `exitCode === 0` and the process was not killed by the timeout. */
  ok: boolean
}

/**
 * Runs one git invocation in `dir`. `args` NEVER contains a caller-supplied
 * string that has not been through `gitPaths.ts`, and callers always place a
 * literal `--` before any pathspec.
 *
 * `spawn` is a test seam so the argv/cwd/env a given operation builds can be
 * asserted without a real repository.
 */
export async function runGit(
  dir: string,
  args: readonly string[],
  options: { timeoutMs?: number; spawn?: SubprocessSpawnFn } = {},
): Promise<GitRunResult> {
  const result = await runCappedSubprocess(['git', ...args], {
    cwd: dir,
    env: minimalSubprocessEnv(GIT_ENV_EXTRA_KEYS, {
      // Never block on an interactive credential prompt — fail fast with the
      // real error instead of sitting until the timeout.
      GIT_TERMINAL_PROMPT: '0',
      // Second, independent stop for git's repository-discovery walk: it can
      // never climb out of studio-workspace/ and find Studio's own .git.
      GIT_CEILING_DIRECTORIES: resolve(projectsRootDir()),
      // Deterministic, parseable output regardless of the host's locale.
      LC_ALL: 'C',
    }),
    timeoutMs: options.timeoutMs ?? GIT_LOCAL_TIMEOUT_MS,
    maxStdoutBytes: MAX_OUTPUT_BYTES,
    maxStderrBytes: MAX_OUTPUT_BYTES,
    spawn: options.spawn,
  })
  return { ...result, ok: result.exitCode === 0 && !result.timedOut }
}

/**
 * git's stderr, trimmed to something safe to hand a browser: no absolute
 * paths (they name the server's filesystem layout), no unbounded length.
 * Authentication failures pass through honestly — that message is the whole
 * point of the push route — with the workspace prefix elided.
 */
export function clientSafeGitError(result: GitRunResult, fallback: string): string {
  if (result.timedOut) return `${fallback}: git did not finish in time and was stopped.`
  const raw = (result.stderr || result.stdout).trim()
  if (!raw) return fallback
  const root = resolve(projectsRootDir())
  return raw
    .split('\n')
    .map((line) => line.split(root).join('<workspace>'))
    .join('\n')
    .slice(0, 2000)
}
