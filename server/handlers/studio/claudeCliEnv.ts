/**
 * Per-user `claude` CLI environment — WS-11 §2.1/§5.1.
 *
 * Each Studio user who authenticates the `claude` CLI gets an isolated
 * directory the server creates and owns the lifecycle of:
 *
 *   <dataDir>/claude-cli/<userId>/        mode 0700, never inside a project,
 *                                         never inside uploads/, never served
 *                                         over HTTP
 *
 * Every spawn of `claude` (probe, login, chat) sets `CLAUDE_CONFIG_DIR` to
 * this directory — the CLI writes and reads its own `.credentials.json`,
 * `.claude.json`, `projects/`, and `sessions/` inside it. Studio never reads
 * that file; it only creates the directory and sets an env var.
 *
 * `userId` is not a filename until it has been validated as one — every
 * function here re-validates it, defence in depth alongside `assertPathWithin`
 * (mirrors `appRoot.ts`'s containment discipline for project-relative paths).
 */

import { mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertPathWithin } from '../../util/pathWithin'
import { projectsRootDir } from '../studioProjects'
import { resolveValidatedWorkspaceDir } from './workspaceDir'

/** 0700 — owner read/write/execute only. Best-effort on Windows (NTFS ACLs, not POSIX mode bits). */
const CONFIG_DIR_MODE = 0o700

/**
 * `userId` rows in this app are server-generated `nanoid()` values (default
 * alphabet: `A-Za-z0-9_-`). Reject anything else outright rather than trying
 * to sanitise it — a userId that doesn't match this shape didn't come from
 * `users.id` and has no business being joined into a filesystem path.
 */
const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/

export class InvalidClaudeCliUserIdError extends Error {
  constructor(userId: string) {
    super(`Refusing to derive a Claude CLI config directory from userId "${userId}" — not a valid id shape.`)
    this.name = 'InvalidClaudeCliUserIdError'
  }
}

/**
 * Resolve the root directory all per-user Claude CLI config directories live
 * under. Deliberately NOT `uploadsDir` (that's served over HTTP) and NOT
 * inside any `studio-workspace/<project>` (that's a user's repo). Defaults to
 * `<cwd>/.data/claude-cli`; override with `CLAUDE_CLI_DATA_DIR` for
 * deployments that want it elsewhere (e.g. a persistent volume).
 */
export function resolveClaudeCliDataRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.CLAUDE_CLI_DATA_DIR
  return configured ? resolve(configured) : resolve(process.cwd(), '.data', 'claude-cli')
}

/**
 * Validate `userId` is a safe single path segment. Throws
 * `InvalidClaudeCliUserIdError` rather than sanitising — a caller passing a
 * malformed id has a bug upstream that silent sanitisation would hide.
 */
export function assertSafeClaudeCliUserId(userId: string): void {
  if (!userId || !SAFE_USER_ID.test(userId)) {
    throw new InvalidClaudeCliUserIdError(userId)
  }
}

/**
 * Resolve (without creating) the absolute per-user config directory. Asserts
 * both that `userId` is a safe segment AND that the resolved path is
 * genuinely contained under `dataRoot` — the same defence-in-depth pattern
 * every other untrusted-path write sink in this repo uses (`pathWithin.ts`'s
 * own doc comment).
 */
export function resolveClaudeCliConfigDir(dataRoot: string, userId: string): string {
  assertSafeClaudeCliUserId(userId)
  const dir = join(dataRoot, userId)
  assertPathWithin(dataRoot, dir)
  return dir
}

/**
 * Create the per-user config directory if it doesn't exist, mode 0700.
 * Idempotent — safe to call before every spawn. Re-asserts the mode on an
 * existing directory too, in case it was created by an older code path or a
 * permissive umask left it wider than intended.
 */
export function ensureClaudeCliConfigDir(dataRoot: string, userId: string): string {
  const dir = resolveClaudeCliConfigDir(dataRoot, userId)
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE })
  try {
    chmodSync(dir, CONFIG_DIR_MODE)
  } catch {
    // Best-effort on platforms without POSIX mode bits (Windows). The
    // directory still exists and is still outside anything served over HTTP.
  }
  return dir
}

/**
 * Delete a user's Claude CLI config directory and everything the CLI wrote
 * into it (including `.credentials.json`) — called on user deletion and on
 * an explicit "log out of Claude" action. Never throws if the directory is
 * already gone.
 */
export function deleteClaudeCliConfigDir(dataRoot: string, userId: string): void {
  const dir = resolveClaudeCliConfigDir(dataRoot, userId)
  if (!existsSync(dir)) return
  rmSync(dir, { recursive: true, force: true })
}

/**
 * The L1 login path (WS-11 §2.1): `claude auth login` and `claude
 * setup-token` are Ink TUIs that die immediately on piped stdin, so Studio
 * cannot drive them itself. Instead it shows this prefilled one-liner for the
 * user to run in their own shell — `CLAUDE_CONFIG_DIR` points the CLI's own
 * login flow at this user's isolated directory, and the CLI writes its
 * credentials there. Studio stores nothing for this path.
 */
export function buildClaudeCliLoginCommand(configDir: string): string {
  return `CLAUDE_CONFIG_DIR=${configDir} claude auth login`
}

/**
 * Resolve a CLIENT-SUPPLIED workspace directory into a safe spawn `cwd` for a
 * real chat turn, or `null` if it isn't a genuine, contained studio project.
 *
 * This is NOT the per-user config dir. A chat turn's `cwd` is what makes
 * `.claude/agents/*.md` discovery, `CLAUDE.md` discovery, and the tools' view
 * of the project work at all (WS-12's entire subagent roster reaches the CLI
 * through `.claude/agents/` auto-discovery — spawn in the wrong place and
 * there are silently zero subagents). The per-user config dir stays right for
 * the availability PROBE only, which must never risk a real project's
 * `CLAUDE.md` cache-creation cost (WS-11 §4.0).
 *
 * A thin, name-preserving alias over `resolveValidatedWorkspaceDir`
 * (`workspaceDir.ts`) — the validation itself moved there once WS-12's chat
 * handler needed the exact same check for a second, unrelated purpose
 * (choosing Studio tools/prompt vs. the CMS site's). Keeping this name and
 * signature means `claudeCli.ts`, its tests, and `docs/features/agent.md`
 * needed no changes.
 */
export function resolveClaudeCliWorkspaceCwd(
  requestedDir: string | null | undefined,
  projectsRoot: string = projectsRootDir(),
): string | null {
  return resolveValidatedWorkspaceDir(requestedDir, projectsRoot)
}

// ---------------------------------------------------------------------------
// Platform support — macOS cannot honour per-user isolation (WS-11 §2.1)
// ---------------------------------------------------------------------------

export interface ClaudeCliPlatformSupport {
  readonly supported: boolean
  /** Present only when `supported` is false — shown in the picker's disabled state. */
  readonly reason?: string
}

const MACOS_UNSUPPORTED_REASON =
  'The Claude CLI stores credentials in the macOS Keychain, which CLAUDE_CONFIG_DIR ' +
  'does not relocate. On a macOS host every user of the same OS account would share ' +
  'one Claude login, so this provider is disabled here rather than silently sharing it.'

/**
 * Single-user local-development escape hatch for the macOS block below.
 *
 * The block exists because ONE Mac serving SEVERAL Studio users would silently
 * share one Keychain login between them. On a developer's own laptop, where
 * the only Studio user is the person already logged into the CLI, there is no
 * second user to leak a login to and the block only prevents them using the
 * subscription they are paying for.
 *
 * Deliberately an environment variable and not a setting: a setting lives in
 * the database, which means it can be flipped by anyone who reaches the admin
 * UI — including on a real multi-user host, which is the exact situation the
 * block protects. An env var has to be set by whoever starts the process, so
 * the decision stays with the operator of the machine.
 *
 * Off unless explicitly set to `1` or `true`. Any other value (including
 * `0`, `false`, or an empty string) leaves the block in force — an unset or
 * typo'd variable must never read as consent.
 */
const MACOS_OVERRIDE_ENV_VAR = 'STUDIO_ALLOW_MACOS_CLAUDE_CLI'

function macosOverrideEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env[MACOS_OVERRIDE_ENV_VAR]?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * Whether this host can host per-user Claude CLI logins at all. macOS is the
 * one platform `CLAUDE_CONFIG_DIR` cannot isolate (credentials live in the OS
 * keychain, not a relocatable file) — WS-11 §2.1 requires disabling the
 * provider there with the reason shown, never falling back to a shared login.
 *
 * `STUDIO_ALLOW_MACOS_CLAUDE_CLI` overrides that for single-user local
 * development — see `MACOS_OVERRIDE_ENV_VAR` above for why the isolation
 * argument does not apply there, and why this is an env var rather than a
 * setting. The multi-user hazard is unchanged; the override asserts there are
 * no other users, it does not fix the Keychain.
 */
export function claudeCliPlatformSupport(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCliPlatformSupport {
  if (platform === 'darwin' && !macosOverrideEnabled(env)) {
    return { supported: false, reason: MACOS_UNSUPPORTED_REASON }
  }
  return { supported: true }
}
