/**
 * Deterministic per-conversation Claude CLI session id (WS-11 steps 2+3).
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
 * (`ai_conversations.id`, a nanoid) hashes to the SAME UUID on every turn, so
 * `claudeCliSessionId` is a pure function with no storage at all. The CLI's
 * own `--session-id`/`--resume` files, keyed by that UUID inside
 * `CLAUDE_CONFIG_DIR`, ARE the persisted session state.
 */

/**
 * SHA-256 the conversation id, take the first 16 bytes, set the RFC 4122
 * version/variant bits so the result is a well-formed UUID string (the CLI's
 * `--session-id` validates the shape). Deterministic: the same
 * `conversationId` always yields the same UUID, on every server process.
 */
export async function claudeCliSessionId(conversationId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(conversationId))
  const bytes = new Uint8Array(digest).slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Whether this is the first turn of a conversation (from the CLI's
 * perspective, so `--session-id` should ESTABLISH a session) or a later one
 * (`--resume` should CONTINUE it). Derived from the replayed history length,
 * not stored state — a brand-new conversation's first turn always has
 * exactly the just-sent user message and nothing else.
 */
export function isFirstClaudeCliTurn(messageCount: number): boolean {
  return messageCount <= 1
}
