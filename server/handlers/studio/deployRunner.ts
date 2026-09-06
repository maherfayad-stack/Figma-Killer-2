/**
 * deployRunner — the ONE place a provider CLI is executed, and the guard that
 * decides which directory it may be executed in.
 *
 * ## Subprocess discipline
 *
 * Identical posture to `gitRunner.ts` and `installDeps.ts`, for the reasons
 * `subprocessRunner.ts`'s module doc gives:
 *
 *   - `Bun.spawn` with an argv ARRAY, built in `deployProviders.ts` from
 *     constants. **No request field ever reaches an argv.** There is no
 *     "extra arguments" parameter here and there must never be one: the route
 *     surface IS the allowed command set.
 *   - `env` is an explicit allowlist (`minimalSubprocessEnv`), never
 *     `process.env` forwarded wholesale. The extra keys are locators the CLI
 *     needs to find ITS OWN config directory (where its auth state lives), its
 *     cache, and — on a corporate network — its proxy and CA bundle. **No
 *     token variable appears here.** `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
 *     `VERCEL_PROJECT_ID`, `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` are
 *     deliberately excluded even though both CLIs would honour them: Studio
 *     stores no provider credential, reads none from its own environment, and
 *     accepts none on any wire. The CLI's own login state on this machine is
 *     the credential, and if it is absent the answer is "run `vercel login` in
 *     your terminal", not "paste a token into Studio".
 *   - `stdin: 'ignore'` is the anti-hang mechanism, and it is load-bearing
 *     rather than incidental. Both CLIs prompt interactively when a directory
 *     is not linked to a remote project; a prompt in a spawned process with no
 *     terminal would otherwise block until the timeout. With stdin at EOF the
 *     prompt fails immediately and the CLI prints the real instruction
 *     (`run \`vercel link\``), which is what the panel surfaces.
 *   - Byte-capped stdout/stderr and a timeout that kills the child.
 *
 * ## Containment
 *
 * A deploy spawns a process in a project directory and uploads whatever that
 * directory builds, so "which directory?" is the same question `gitRunner.ts`
 * answers, with the same stakes reversed: git would have COMMITTED into
 * Studio's own repository, a deploy would PUBLISH it. `assertWithinWorkspace`
 * is reused rather than reimplemented — it is a general "this is a real project
 * directory under `studio-workspace/`, checked on the symlink-resolved real
 * path, and it is not the workspace root itself" guard that happens to live in
 * the git module because git needed it first.
 *
 * Unlike git, a project does NOT need its own `.git` to be deployed: previews
 * of a project that was never put under version control are legitimate.
 */
import { resolve } from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { assertWithinWorkspace, type GitRepoGuardResult } from './gitRunner'
import {
  minimalSubprocessEnv,
  runCappedSubprocess,
  type CappedSubprocessResult,
  type SubprocessSpawnFn,
} from './subprocessRunner'

/** `vercel whoami` / `netlify status` read local state and answer immediately; a hang here means the CLI is prompting, not thinking. */
export const DEPLOY_PROBE_TIMEOUT_MS = 30_000
/** A real production build of a real app. Generous, bounded — the same order as `installDeps.ts`'s install timeout, doubled because a build is slower than an install. */
export const DEPLOY_BUILD_TIMEOUT_MS = 10 * 60 * 1000
/** Upload + remote build queueing. Crosses the network to a service that may be busy. */
export const DEPLOY_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000

/** Per stream, per invocation. A build log is the one thing a user genuinely reads here, so this is generous; it is still bounded against a runaway process. */
const MAX_OUTPUT_BYTES = 200_000

/**
 * Locators the provider CLIs need to behave like the user's own CLI — find
 * their config (and therefore their auth state), their cache, a corporate
 * proxy, a custom CA bundle. Every one is a locator; none is a secret; and the
 * absent entries are the point — see the module doc.
 */
const DEPLOY_ENV_EXTRA_KEYS = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'npm_config_cache',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const

export interface DeployRunResult extends CappedSubprocessResult {
  /** `exitCode === 0` and the process was not killed by the timeout. */
  ok: boolean
  /**
   * The executable could not be started at all — almost always "this CLI is
   * not installed on this machine". Distinguished from a non-zero exit so the
   * panel can say "install the Vercel CLI" instead of showing an empty log.
   */
  notInstalled: boolean
}

/**
 * Runs one provider-CLI invocation in `dir`.
 *
 * `argv` comes from `PROVIDER_COMMANDS` and nothing else. `spawn` is a test
 * seam so the exact argv/cwd/env an operation builds can be asserted — and so
 * a fake CLI script can stand in for a real one — without a network round trip
 * or a real account.
 */
export async function runDeployCli(
  dir: string,
  argv: readonly string[],
  options: { timeoutMs: number; spawn?: SubprocessSpawnFn },
): Promise<DeployRunResult> {
  try {
    const result = await runCappedSubprocess([...argv], {
      cwd: dir,
      env: minimalSubprocessEnv(DEPLOY_ENV_EXTRA_KEYS, {
        // Deterministic, parseable output regardless of the host's locale or
        // terminal — the preview URL is read back out of this text.
        LC_ALL: 'C',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
      }),
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: MAX_OUTPUT_BYTES,
      spawn: options.spawn,
    })
    return { ...result, ok: result.exitCode === 0 && !result.timedOut, notInstalled: false }
  } catch (err) {
    // `Bun.spawn` throws synchronously when the executable is not on PATH.
    // That is a normal, expected state here (most machines have neither CLI),
    // not an exception worth propagating as a 500.
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: null,
      timedOut: false,
      ok: false,
      notInstalled: true,
    }
  }
}

/**
 * A CLI's output, trimmed to something safe to hand a browser: no absolute
 * paths (they name the server's filesystem layout), no unbounded length. Both
 * CLIs print the project's build output path on success and on failure, so this
 * is not a rare edge — it is every run.
 */
export function clientSafeDeployOutput(result: DeployRunResult, fallback: string): string {
  if (result.notInstalled) return fallback
  if (result.timedOut) return `${fallback}: the CLI did not finish in time and was stopped.`
  const raw = `${result.stdout}\n${result.stderr}`.trim()
  if (!raw) return fallback
  const root = resolve(projectsRootDir())
  return raw
    .split('\n')
    .map((line) => line.split(root).join('<workspace>'))
    .join('\n')
    .slice(0, 20_000)
}

/** Re-exported so callers of this module never reach into `gitRunner.ts` for a guard that is not about git — see the module doc. */
export function assertDeployableProject(dirInput: string): GitRepoGuardResult {
  return assertWithinWorkspace(dirInput)
}
