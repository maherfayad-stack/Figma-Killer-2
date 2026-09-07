/**
 * agentUserScope — which subdirectory of a project's agent cache belongs to
 * which account, and how a hook subprocess learns that without being told
 * twice.
 *
 * ## The bug this closes (W10 §5)
 *
 * `.studio/cache/turnWrites.json` and `.studio/cache/pageVerification.json`
 * were per PROJECT. Two people working the same project shared both: user A's
 * `Write` calls landed in the log user B's Stop hook read back, so B's turn
 * was blocked on screens B never touched — and, worse in the other direction,
 * A's passing `studio_compare` satisfied B's gate for a page B had just
 * rewritten. A verification gate that can be satisfied by somebody else's
 * work is not a gate.
 *
 * So both files move under `.studio/cache/agent/<userKey>/`. Every entry
 * there is a disposable derived cache — regenerable by re-running the turn or
 * the compare, gitignored by the existing `.studio/cache/` rule, and a
 * missing file reads as empty — so this is a path change, not a migration.
 * Whatever a live installation has under the old paths simply stops being
 * read, which for both files means "this turn wrote nothing yet" and "this
 * page has not been verified yet": the safe direction in both cases.
 *
 * Design references and design VARIABLES deliberately do NOT move. They
 * describe the design the project is being built to, not one person's session
 * — two designers must see the same reference set, and splitting them would
 * mean an agent could not measure against a reference a colleague registered.
 *
 * ## Why a hash, and why an env var
 *
 * The key is a hash of the user id, not the id itself: the directory name
 * lands in the user's own git working tree (ignored, but visible), and a user
 * id is an addressing identifier elsewhere in this system. A hash is stable,
 * path-safe, and says nothing.
 *
 * The `Stop`/`PostToolUse` hooks run as their own subprocesses, spawned by
 * the `claude` CLI, and the only thing they are handed on stdin is the CLI's
 * own event JSON — no user in it. The alternative to an env var was baking
 * the key into the generated `.claude/settings.local.json` hook command, but
 * that file is ONE per project shared by every user of it, so the last person
 * to open the project would silently rewrite everyone else's hooks to point
 * at their own cache. The CLI passes its environment to the hooks it spawns,
 * and `claudeCli.ts` already builds that environment per turn from the
 * authenticated user — so the env var is the one channel that is already
 * per-(user, turn) by construction.
 */
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The key used when no user is known: a hook spawned before this env var
 * existed, or a server-side digest built without a `userId` in hand. It is a
 * real, ordinary key — one more sibling directory, never a fallback that
 * reads somebody else's cache.
 */
export const SHARED_AGENT_USER_KEY = 'shared'

/** The variable `claudeCli.ts` sets on the CLI subprocess environment and the hooks read back. */
export const STUDIO_AGENT_USER_KEY_ENV = 'STUDIO_AGENT_USER_KEY'

/** Stable, path-safe, non-identifying key for one account. */
export function studioAgentUserKey(userId: string | null | undefined): string {
  if (!userId) return SHARED_AGENT_USER_KEY
  return createHash('sha256').update(userId).digest('hex').slice(0, 16)
}

/**
 * The key a hook subprocess should use: whatever `claudeCli.ts` put on the
 * environment, or the shared key. Validated against the same alphabet
 * `studioAgentUserKey` produces — this value becomes a path segment, and it
 * arrives through an environment variable, so it is a boundary like any
 * other.
 */
export function studioAgentUserKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[STUDIO_AGENT_USER_KEY_ENV]
  return raw && /^[a-f0-9]{16}$/.test(raw) ? raw : SHARED_AGENT_USER_KEY
}

/** `<dir>/.studio/cache/agent/<userKey>` — the per-account root for this project's disposable agent caches. */
export function agentCacheDir(dir: string, userKey: string): string {
  return join(dir, '.studio', 'cache', 'agent', userKey)
}

/**
 * Every account key that has an agent cache in this project. For the one
 * question that is genuinely project-wide rather than per-session: the git
 * panel's "was this file written by an agent" marker, which is about the file
 * on disk and must not depend on which of the project's users is looking.
 */
export function listAgentCacheUserKeys(dir: string): string[] {
  try {
    return readdirSync(join(dir, '.studio', 'cache', 'agent'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No agent cache in this project yet — no user has run a turn against it.
    return []
  }
}
