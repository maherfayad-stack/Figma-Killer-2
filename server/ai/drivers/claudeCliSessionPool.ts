/**
 * The registry of warm `claude` processes — which conversation gets which
 * subprocess, when one may be reused, and when it is killed.
 *
 * `claudeCliWarmSession.ts` knows how to talk to ONE process. This module
 * knows how many there are, whose they are, and how long they live. Keeping
 * those apart is what lets the lifetime policy (below) be read and changed
 * without touching the wire protocol, and vice versa.
 *
 * ## The reuse key, and why `effort` is in it
 *
 * A pooled process is reused only for the same (USER, conversation) AND the
 * same `fingerprint` — the caller's summary of everything baked into argv at
 * spawn time and unchangeable afterwards: user, model, effort, permission
 * mode, cwd, config dir, native tool allowlist, the MCP config's hash, and the
 * static system prompt's version — which is what carries the fidelity mode and
 * the design policy (`claudeCliWarmTurn.ts`'s `warmSessionFingerprint`).
 *
 * The user is in BOTH halves of that key on purpose. A conversation id is
 * per-user already, so keying by it alone was not a leak — but a `claude`
 * process holds a per-user `CLAUDE_CONFIG_DIR`, a connector token minted with
 * one user's capabilities, and that user's staged attachments, so "whose
 * process is this" must be a fact the pool knows rather than one it infers
 * from an id it never checks. The key is `${userId}\u0000${conversationId}`
 * (the `editorBridge.ts` idiom — NUL occurs in neither part).
 * Anything else and the old process is killed and a new one spawned, which
 * costs exactly what every turn used to cost. Reuse is a discount, never a
 * risk of running a turn under settings it did not ask for.
 *
 * `effort` is the uncomfortable one. `--effort` is argv-only: the spike probed
 * for a `set_effort` control request and the binary answered "Unsupported
 * control request subtype" (`claudeCliStdinProtocol.ts` §5). Per-turn effort
 * routing (`../routing/turnRouting.ts`) picks `low` for a plain question and
 * `medium` for everything else, so a conversation that alternates between
 * asking and building respawns on each switch and gets no warm discount on
 * those turns. It is never SLOWER than today — a respawn is the status quo —
 * but the win is real only for runs of same-shaped turns, which is the common
 * case for the build sessions this was aimed at. The honest fix is a
 * `set_effort` control request in the CLI, not a lie about what effort a turn
 * ran at.
 *
 * `set_model` and `set_permission_mode` DO exist and were confirmed working,
 * so those two could be re-negotiated in place instead of respawning. They are
 * deliberately still in the fingerprint: both change what the agent is allowed
 * to do, both change rarely (they are session controls a human toggles), and
 * "the process was started with exactly these settings" is a property worth
 * more than a saved second on a rare turn.
 *
 * ## Lifetime
 *
 * - **Idle:** killed after `IDLE_TIMEOUT_MS` with no turn. A user who wanders
 *   off does not leave a `claude` process (and its MCP children) resident.
 * - **Max lifetime:** killed after `MAX_LIFETIME_MS` regardless of use. This
 *   is what bounds staleness of everything the CLI reads ONCE at startup —
 *   `CLAUDE.md`, settings, the MCP server list — and stops a long session
 *   accumulating unbounded context in the CLI's own memory.
 * - **Pool cap:** at most `MAX_POOL_SIZE` live processes across all users,
 *   and at most `MAX_POOL_SIZE_PER_USER` for any ONE of them; the
 *   least-recently-used idle one is evicted to make room. A server with forty
 *   open conversations must not hold forty CLI processes — and one busy user
 *   with four tabs must not evict everyone else's warm session to do it,
 *   which is what a global cap alone allows.
 * - **Explicit:** `disposeWarmSessionsForConversation` on conversation delete
 *   and on "Restart agent session", so the process and its MCP connector die
 *   with the thing they belonged to rather than lingering until a timer.
 *
 * ## The connector token's revocation story
 *
 * A cold turn mints an MCP connector token, hands it to the subprocess, and
 * revokes it in a `finally` — the token's life is the turn's. That cannot hold
 * here: the CLI reads `--mcp-config` and authenticates its MCP clients ONCE at
 * startup, so revoking after turn 1 would leave a warm session holding a dead
 * token and silently toolless for turn 2. So a warm session's token is
 * CONVERSATION-scoped: minted with the process, revoked by `dispose()` — which
 * runs on idle timeout, max lifetime, fingerprint change, pool eviction, crash
 * detection, conversation delete, and session restart. Every path that ends a
 * session ends its token. The 1-day TTL floor `createConnector` enforces
 * remains the backstop it always was, and the capability floor is unchanged:
 * the token carries exactly the calling user's own capabilities, never more.
 */

import type { ClaudeCliWarmSession } from './claudeCliWarmSession'

/** Ten minutes without a turn. Long enough to survive a user reading a reply, writing a follow-up, and getting distracted once; short enough that an abandoned tab does not hold a process for an afternoon. */
const IDLE_TIMEOUT_MS = 10 * 60_000

/** One hour, used or not. See "Lifetime" — this is the bound on `CLAUDE.md`/settings staleness, not a health measure. */
const MAX_LIFETIME_MS = 60 * 60_000

/** Live processes across ALL conversations and users. Each one is a `claude` process plus its MCP children, so this is a real resource ceiling on a shared server, not a tuning knob. */
const MAX_POOL_SIZE = 8

/**
 * Live processes for ONE user. Two — the warm session for the conversation
 * they are working in, plus one they just switched away from and are likely
 * to switch back to. Well under the global cap on purpose: without a per-user
 * bound, one person with several tabs open fills all eight slots and every
 * OTHER user's next turn pays a full cold spawn, which is the shared-server
 * shape of the very cost this pool exists to remove.
 */
const MAX_POOL_SIZE_PER_USER = 2

/** What the caller must hand the pool when a new process is needed: the running session plus a teardown for everything minted or written alongside it. */
export interface WarmSessionResources {
  readonly session: ClaudeCliWarmSession
  /** The conversation-scoped connector's id, or `null` when minting failed and the session runs without tools. Surfaced so each turn can re-bind the permission gate and workspace registries against it. */
  readonly connectorId: string | null
  /** Revoke the connector, remove the MCP config file, kill the process. Called exactly once, on every path that ends the session. */
  dispose(): Promise<void>
}

/** A pooled session, checked out for one turn. */
export interface WarmSessionLease {
  readonly session: ClaudeCliWarmSession
  /** The session's connector id — the caller re-binds the permission gate and workspace registries against it on every turn. `null` when the session has no tools. */
  readonly connectorId: string | null
  /** `false` when an existing process was reused — i.e. this turn skipped the whole spawn + MCP handshake. */
  readonly spawnedNow: boolean
  /**
   * The dynamic system-prompt suffix to include in THIS turn's message, or
   * `null` when the session has already been told it.
   *
   * A process receives the suffix once, in its `--append-system-prompt-file`
   * text at spawn, and a warm process cannot be given it again after the fact — so a warm turn carries it inside
   * the user message instead. Sending it on every turn would put a fresh copy
   * of the board digest into the conversation's permanent history each time,
   * so it is sent only when it actually differs from what this session was
   * last told. Consuming it here is what records that.
   */
  takeSystemState(suffix: string | null): string | null
  /** End the turn: re-arm the idle countdown, or drop the session if it died during it. */
  endTurn(): void
  /** Drop and tear down this session immediately — used when a turn discovers the process is unusable. */
  discard(): Promise<void>
}

interface PoolEntry {
  readonly key: string
  readonly userId: string
  readonly fingerprint: string
  readonly resources: WarmSessionResources
  readonly createdAt: number
  lastUsedAt: number
  lastSystemState: string | null
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

const pool = new Map<string, PoolEntry>()

/** NUL separates the two parts — it can occur in neither a user id nor a conversation id. Same idiom as `editorBridge.ts`'s `bridgeKey`. */
function poolKey(userId: string, conversationId: string): string {
  return `${userId}\u0000${conversationId}`
}

export interface AcquireWarmSessionOptions {
  /** Whose turn this is. Half the pool key, and the reason a per-user cap can exist at all. */
  readonly userId: string
  readonly conversationId: string
  /** Everything baked into argv at spawn and unchangeable afterwards — see "The reuse key". */
  readonly fingerprint: string
  /** Called only when no compatible process exists. May throw; the caller falls back to a cold turn. */
  readonly create: () => Promise<WarmSessionResources>
}

/**
 * Check out a warm session for one turn, spawning one if there is no
 * compatible live process. The returned lease is checked back in by
 * `endTurn()` (or `discard()`), which the caller must run in a `finally`.
 */
export async function acquireWarmSession(options: AcquireWarmSessionOptions): Promise<WarmSessionLease> {
  const key = poolKey(options.userId, options.conversationId)
  const existing = pool.get(key)
  if (existing) {
    const reusable =
      existing.fingerprint === options.fingerprint &&
      existing.resources.session.alive &&
      !existing.resources.session.busy &&
      Date.now() - existing.createdAt < MAX_LIFETIME_MS
    if (reusable) {
      clearIdleTimer(existing)
      existing.lastUsedAt = Date.now()
      return lease(existing, false)
    }
    await evict(key)
  }

  await enforcePoolCap(options.userId)
  const resources = await options.create()
  const entry: PoolEntry = {
    key,
    userId: options.userId,
    fingerprint: options.fingerprint,
    resources,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastSystemState: null,
    idleTimer: undefined,
  }
  pool.set(key, entry)
  return lease(entry, true)
}

function lease(entry: PoolEntry, spawnedNow: boolean): WarmSessionLease {
  return {
    session: entry.resources.session,
    connectorId: entry.resources.connectorId,
    spawnedNow,
    takeSystemState: (suffix) => {
      if (suffix === null || suffix === entry.lastSystemState) return null
      entry.lastSystemState = suffix
      return suffix
    },
    endTurn: () => {
      entry.lastUsedAt = Date.now()
      if (!entry.resources.session.alive) {
        void evict(entry.key)
        return
      }
      armIdleTimer(entry)
    },
    discard: () => evict(entry.key),
  }
}

/** Kill and forget the warm session for one user's conversation. The hook for conversation delete and "Restart agent session". */
export async function disposeWarmSessionsForConversation(userId: string, conversationId: string): Promise<void> {
  await evict(poolKey(userId, conversationId))
}

/** Kill and forget everything. Server shutdown, and the reset every test needs. */
export async function disposeAllWarmSessions(): Promise<void> {
  await Promise.all([...pool.keys()].map((id) => evict(id)))
}

/** Live process count — observability for tests and for anything that wants to report pool pressure. */
export function warmSessionCount(): number {
  return pool.size
}

async function evict(key: string): Promise<void> {
  const entry = pool.get(key)
  if (!entry) return
  pool.delete(key)
  clearIdleTimer(entry)
  try {
    await entry.resources.dispose()
  } catch (err) {
    // Teardown of a process that is probably already gone must never surface
    // to the user or block the turn that triggered it.
    console.error('[ai/claudeCli] failed to dispose a warm session:', err)
  }
}

function armIdleTimer(entry: PoolEntry): void {
  clearIdleTimer(entry)
  entry.idleTimer = setTimeout(() => void evict(entry.key), IDLE_TIMEOUT_MS)
  // Never hold the process open on this timer alone — a pending idle-kill is
  // not a reason for the server to stay alive.
  entry.idleTimer.unref?.()
}

function clearIdleTimer(entry: PoolEntry): void {
  if (entry.idleTimer === undefined) return
  clearTimeout(entry.idleTimer)
  entry.idleTimer = undefined
}

/**
 * Make room for one more, for `userId`. Drops dead entries first (free), then
 * evicts the least-recently-used IDLE session — never one with a turn in
 * flight, which would kill a reply mid-sentence for a user who is watching it
 * arrive.
 *
 * Two caps, enforced in this order:
 *   1. This user's own (`MAX_POOL_SIZE_PER_USER`) — evicting only from their
 *      OWN sessions. A user over their share pays for it themselves.
 *   2. The global one (`MAX_POOL_SIZE`) — the machine's real ceiling, which
 *      may evict anyone's least-recently-used idle session.
 */
async function enforcePoolCap(userId: string): Promise<void> {
  for (const [key, entry] of pool) {
    if (!entry.resources.session.alive) await evict(key)
  }
  await evictOldestIdleWhile(
    () => countForUser(userId) >= MAX_POOL_SIZE_PER_USER,
    (entry) => entry.userId === userId,
  )
  await evictOldestIdleWhile(() => pool.size >= MAX_POOL_SIZE, () => true)
}

function countForUser(userId: string): number {
  let count = 0
  for (const entry of pool.values()) if (entry.userId === userId) count += 1
  return count
}

/**
 * Evict the least-recently-used idle entry matching `eligible` for as long as
 * `overCap` holds. Returns as soon as every remaining candidate is mid-turn:
 * running over a cap for a moment is strictly better than truncating a reply,
 * and the next `endTurn` brings the count back down.
 */
async function evictOldestIdleWhile(
  overCap: () => boolean,
  eligible: (entry: PoolEntry) => boolean,
): Promise<void> {
  while (overCap()) {
    let oldest: PoolEntry | undefined
    for (const entry of pool.values()) {
      if (entry.resources.session.busy || !eligible(entry)) continue
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry
    }
    if (!oldest) return
    await evict(oldest.key)
  }
}
