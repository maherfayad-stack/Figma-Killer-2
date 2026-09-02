/**
 * Session-scoped MCP connectors for the `claudeCli` driver (WS-11 step 3).
 *
 * A bare `claude` subprocess runs its own agent loop with its own tools and
 * cannot touch the canvas. Studio already solved exactly this for external
 * clients: `/_studio/mcp`, per-connector bearer tokens, and the
 * `(userId, scope)` live bridge (`editorBridge.ts`) that routes browser tools
 * to the connector owner's open Site workspace. Reusing it here means the
 * `claude` subprocess gets Studio's real toolset — including browser-bridged
 * writes, relayed to the SAME open workspace an external Claude Code
 * connector would reach — with zero new tool-routing code.
 *
 * The difference from an admin-minted connector (`handlers/connectors.ts`):
 * this one is minted BY THE SERVER, per chat turn, never by a human clicking
 * "create connector" — so it deliberately bypasses that handler's step-up
 * gate (`requireStepUp`), which exists for a human consciously creating a
 * long-lived delegated credential. Nothing here is long-lived: capabilities
 * are exactly the calling user's own (the same privilege-floor rule — never
 * more than the caller holds), the token TTL is the shortest `createConnector`
 * accepts (1 day, the day-granularity floor), and the caller explicitly
 * revokes it the instant the turn ends (success, error, or abort) via a
 * `finally` block — the TTL is a safety net, not the real boundary.
 */

import type { DbClient } from '../../db/client'
import type { CoreCapability } from '@core/capabilities'
import { createConnector, revokeConnector } from './connectors/store'
import { generateConnectorToken, hashConnectorToken } from './connectors/token'

/** Shortest TTL `createConnector` accepts — see file doc comment: explicit revocation on turn end is the real boundary, not this. */
const SESSION_CONNECTOR_TTL_DAYS = 1

export interface ClaudeCliSessionConnector {
  readonly connectorId: string
  readonly token: string
}

/**
 * Mint a session-scoped MCP connector for one `claudeCli` chat turn, carrying
 * exactly the calling user's own capabilities (never more — the same
 * privilege floor `handlers/connectors.ts` enforces for human-created ones,
 * just derived from the caller instead of asked of them).
 */
export async function mintClaudeCliSessionConnector(
  db: DbClient,
  userId: string,
  capabilities: readonly CoreCapability[],
  conversationId: string,
): Promise<ClaudeCliSessionConnector> {
  const token = generateConnectorToken()
  const record = await createConnector(db, {
    userId,
    label: `Claude CLI session (${conversationId})`,
    type: 'local',
    capabilities,
    tokenHash: await hashConnectorToken(token),
    ttlDays: SESSION_CONNECTOR_TTL_DAYS,
  })
  return { connectorId: record.id, token }
}

/**
 * Revoke a session connector when the turn ends. Best-effort and silent on
 * failure — a stream that already finished (successfully or not) must not
 * surface a cleanup error to the user; the 1-day TTL is the backstop if this
 * somehow doesn't run.
 */
export async function revokeClaudeCliSessionConnector(
  db: DbClient,
  connectorId: string,
  userId: string,
): Promise<void> {
  try {
    await revokeConnector(db, connectorId, userId)
  } catch (err) {
    console.error('[ai/claudeCli] failed to revoke session connector:', err)
  }
}
