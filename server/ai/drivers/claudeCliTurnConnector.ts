/**
 * claudeCliTurnConnector — the per-turn MCP connector a `claude` subprocess
 * authenticates with, and the two in-memory registries keyed by its id.
 *
 * Split out of `claudeCli.ts` because it is a different reason to change: this
 * module owns the LIFECYCLE of a turn-scoped credential and everything bound
 * to it, while `claudeCli.ts` owns spawning the CLI and streaming its output.
 * The three pieces here are set up together, must be torn down together, and
 * are meaningless apart — bundling them behind one open/close pair is what
 * stops a future edit from adding a fourth registration and forgetting the
 * matching release in a `finally` block several hundred lines away.
 *
 * The three:
 *   1. **The connector** itself (`sessionConnector.ts`) — a short-lived bearer
 *      token carrying exactly the caller's own capabilities. Minting is
 *      FAIL-SOFT: a turn that cannot get one is degraded (no tools) rather
 *      than broken, which is the posture WS-11 step 1 shipped with.
 *   2. **The permission gate** (`permissionGate.ts`) — must be live BEFORE the
 *      spawn, because the CLI resolves `--permission-prompt-tool` against
 *      `tools/list` during startup and the tool is only advertised while the
 *      gate is registered.
 *   3. **The workspace binding** (`connectorWorkspace.ts`) — which Studio
 *      project this turn is about. A tool call arriving over `/_studio/mcp`
 *      has only a connector id to identify the turn, so without this the
 *      Studio tools fall back to "first project alphabetically" and an agent
 *      silently works on `untitled` while the user is in `untitled-2`.
 *
 * `close()` releases in the reverse order of acquisition and is safe to call
 * once, from a `finally`. The registries are released BEFORE the connector is
 * revoked, so no prompt can be relayed down a bridge whose turn has ended.
 */
import type { DbClient } from '../../db/client'
import type { CoreCapability } from '@core/capabilities'
import type { AiBrowserBridge } from '../runtime/types'
import { registerPermissionGate } from '../mcp/permissionGate'
import { registerConnectorWorkspace } from '../mcp/connectorWorkspace'
import {
  mintClaudeCliSessionConnector,
  revokeClaudeCliSessionConnector,
  type ClaudeCliSessionConnector,
} from '../mcp/sessionConnector'

export type MintConnector = typeof mintClaudeCliSessionConnector
export type RevokeConnector = typeof revokeClaudeCliSessionConnector

export interface OpenTurnConnectorOptions {
  readonly db: DbClient
  readonly userId: string
  readonly capabilities: readonly CoreCapability[]
  readonly conversationId: string
  /** Relays permission prompts to the human. */
  readonly bridge: AiBrowserBridge
  /** The validated open project, or `undefined` when the turn has none. */
  readonly workspaceDir: string | undefined
  /** Test seams — default to the real store-backed implementations. */
  readonly mintConnector?: MintConnector
  readonly revokeConnector?: RevokeConnector
}

export interface TurnConnector {
  /** `null` when minting failed — the turn runs without tools rather than failing. */
  readonly connector: ClaudeCliSessionConnector | null
  /** Release both registries, then revoke the token. Idempotent enough to sit in a `finally`. */
  close(): Promise<void>
}

export async function openTurnConnector(options: OpenTurnConnectorOptions): Promise<TurnConnector> {
  const mint = options.mintConnector ?? mintClaudeCliSessionConnector
  const revoke = options.revokeConnector ?? revokeClaudeCliSessionConnector

  let connector: ClaudeCliSessionConnector | null = null
  try {
    connector = await mint(options.db, options.userId, options.capabilities, options.conversationId)
  } catch (err) {
    console.error('[ai/claudeCli] failed to mint a session MCP connector — continuing without tools:', err)
  }

  const releasePermissionGate = connector
    ? registerPermissionGate(connector.connectorId, options.bridge)
    : null
  const releaseWorkspace =
    connector && options.workspaceDir
      ? registerConnectorWorkspace(connector.connectorId, options.workspaceDir)
      : null

  const active = connector
  return {
    connector,
    close: async () => {
      releasePermissionGate?.()
      releaseWorkspace?.()
      // The token is scoped to THIS turn — expire it with the turn, not the
      // 1-day TTL floor. Never reuse a long-lived connector token.
      if (active) await revoke(options.db, active.connectorId, options.userId)
    },
  }
}
