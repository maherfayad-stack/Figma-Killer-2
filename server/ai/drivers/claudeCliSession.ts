/**
 * Deterministic per-conversation Claude CLI session id (WS-11 steps 2+3),
 * plus the establish-vs-resume decision — whether a given turn should pass
 * `--session-id` (create a new CLI session) or `--resume` (continue one).
 *
 * `--input-format stream-json` exists and is documented in `--help` as
 * "realtime streaming input" for multi-turn use, and `--replay-user-messages`
 * exists specifically for that mode — both confirmed against the installed
 * binary. What is NOT confirmed is the exact stdin JSON message shape, and
 * verifying it would mean sending a real `-p` turn against a live account (a
 * real cost, and this driver's own tests must never do that). Rather than
 * guess at an unverified wire protocol, this driver uses the mechanism the
 * coordinator confirmed directly from `--help`: `--session-id <uuid>` /
 * `-r, --resume [value]`.
 *
 * Studio's driver model has no server-side session (every HTTP driver
 * replays the full `AiMessage[]` log each turn) and WS-11 §3 deliberately
 * shipped with no new DB column. A stored `claude_session_id` would be the
 * obvious way to track this, but it isn't needed: a conversation's id
 * (`ai_conversations.id`, a nanoid) plus its `session_epoch` (migration 021)
 * hashes to the SAME UUID on every turn, so `claudeCliSessionId` is a pure
 * function with no storage of the UUID itself. The CLI's own
 * `--session-id`/`--resume` files, keyed by that UUID inside
 * `CLAUDE_CONFIG_DIR`, ARE the persisted session state.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * SHA-256 the conversation id (folded with `epoch` when non-zero), take the
 * first 16 bytes, set the RFC 4122 version/variant bits so the result is a
 * well-formed UUID string (the CLI's `--session-id` validates the shape).
 * Deterministic: the same `(conversationId, epoch)` pair always yields the
 * same UUID, on every server process.
 *
 * **`epoch` defaults to `0`, and epoch `0` hashes `conversationId` ALONE —
 * byte-for-byte the same input the pre-epoch version of this function always
 * hashed.** That is load-bearing, not incidental: live self-hosted
 * installations already have `claude` CLI session files on disk keyed by
 * today's UUIDs, and this migration must never orphan them. Only a
 * genuinely bumped epoch (`session_epoch > 0`, written by "Restart agent
 * session") changes the derived id — see `claudeCliSession.test.ts`'s pinned
 * fixture for a concrete, independently-computed proof.
 */
export async function claudeCliSessionId(conversationId: string, epoch = 0): Promise<string> {
  const input = epoch === 0 ? conversationId : `${conversationId}:${epoch}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  const bytes = new Uint8Array(digest).slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ---------------------------------------------------------------------------
// Establish vs. resume
// ---------------------------------------------------------------------------

/**
 * Reproduces the `claude` CLI's own project-directory naming scheme for its
 * session transcripts: every character of the absolute `cwd` that is not
 * `[A-Za-z0-9]` becomes a single `-`. NOT documented anywhere in `--help` —
 * reverse-engineered from real transcripts the installed binary wrote on this
 * machine under both a real, unmodified `~/.claude/projects/` (normal use)
 * AND a `CLAUDE_CONFIG_DIR`-overridden config root (Studio's own smoke test,
 * `.data/claude-cli/<user>/projects/`), which is exactly the override this
 * driver sets on every spawn. Verified against several real directory names
 * with punctuation the naive "just the last path segment" guess would get
 * wrong, e.g. (this repo's own path) `/Users/maher.fayad/Documents/Github/
 * Figma Killer 2` → `-Users-maher-fayad-Documents-Github-Figma-Killer-2`
 * (dot AND space both become `-`, no collapsing of the two), and
 * `/Users/maher.fayad/Claude Projects/Almosafer J+` →
 * `-Users-maher-fayad-Claude-Projects-Almosafer-J-` (`+` also becomes `-`).
 */
export function claudeCliProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Absolute path to the CLI's own transcript file for this `(configDir, cwd, sessionId)`, if the CLI has ever written one. */
function claudeCliSessionFilePath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', claudeCliProjectDirName(cwd), `${sessionId}.jsonl`)
}

/**
 * Whether the CLI has already written a session transcript for this exact
 * `(configDir, cwd, sessionId)` triple. `existsSync` never throws (Node/Bun
 * swallow stat errors and return `false`), so this is safe to call with no
 * try/catch — a permissions error or a pathological path both read as "no
 * session yet", which is the same conclusion an actually-missing file yields.
 */
export function claudeCliSessionFileExists(configDir: string, cwd: string, sessionId: string): boolean {
  return existsSync(claudeCliSessionFilePath(configDir, cwd, sessionId))
}

/**
 * Whether THIS turn should pass `--session-id` (establish) rather than
 * `--resume` (continue) — replaces the earlier `isFirstClaudeCliTurn`
 * (`req.messages.length <= 1`) heuristic entirely.
 *
 * The message-count heuristic was wrong the instant "Restart agent session"
 * existed: after a restart the conversation has plenty of replayed history,
 * but the bumped epoch derives a UUID the CLI has never seen, so `--resume`
 * would fail outright — there is nothing to resume. Message count answers
 * "has this Studio conversation sent a prior turn?", which is a DIFFERENT
 * question from "does the CLI already have a session for THIS uuid at THIS
 * cwd?" — the actual state `--session-id` vs `--resume` needs answered.
 *
 * A direct filesystem probe answers the real question and, as a consequence,
 * self-heals cases the message-count heuristic never could: a cleared/rotated
 * `CLAUDE_CONFIG_DIR`, a server redeploy onto a fresh data volume, or a
 * project's `cwd` changing between turns (a workspace close/reopen) all leave
 * no transcript file for the current `(cwd, sessionId)` pair, so the turn
 * correctly re-establishes instead of sending a `--resume` the CLI will
 * reject.
 *
 * This IS a reverse-engineered filesystem layout, not a documented contract
 * (`claudeCliProjectDirName`'s own doc comment lists the concrete evidence).
 * If a future CLI version changes that layout, the worst-case failure mode
 * is graceful: this probe would read every turn as "no session found" and
 * always establish — never a `--resume` sent for a session that doesn't
 * exist, and never data loss (`ai_messages` is the durable transcript
 * regardless of what the CLI does with its own file). If that ever proves
 * unreliable in practice, the fix is to stop guessing at the CLI's own
 * layout and thread the epoch-bump point through explicitly instead (e.g. a
 * per-conversation "epoch this turn established for" column) rather than
 * silently keep trusting a probe known to be wrong.
 */
export function shouldEstablishClaudeCliSession(configDir: string, cwd: string, sessionId: string): boolean {
  return !claudeCliSessionFileExists(configDir, cwd, sessionId)
}
