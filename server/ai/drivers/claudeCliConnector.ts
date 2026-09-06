/**
 * claudeCliConnector — the MCP connector a `claude` subprocess authenticates
 * with, and the two in-memory registries keyed by its id.
 *
 * Split out of `claudeCli.ts` because it is a different reason to change: this
 * module owns the LIFECYCLE of that credential and everything bound to it,
 * while `claudeCli.ts` owns spawning the CLI and streaming its output.
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
 * ## Two lifetimes, one credential, and why the registries are separable
 *
 * A COLD turn (`openTurnConnector`) mints, binds, streams, and revokes inside
 * one turn — the token's life is the turn's.
 *
 * A WARM session (`claudeCliSessionPool.ts`) cannot work that way: the CLI
 * reads `--mcp-config` and authenticates its MCP clients ONCE, at startup, so
 * a token revoked after turn 1 leaves turn 2 silently toolless. Its token is
 * therefore conversation-scoped, minted with the process and revoked when the
 * session is disposed.
 *
 * But the two REGISTRIES must still be rebound every turn even on a reused
 * process, and that is not a detail — `bridge` is the live browser connection
 * relaying permission prompts, and it is a different object after a reload or
 * a second tab, while `workspaceDir` changes the moment the user opens another
 * project. Binding them once at spawn would relay this turn's Allow/Deny card
 * down a dead socket and point this turn's writes at the previous project.
 * Hence `bindConnectorRegistries`, which both entry points below are built on:
 * the cold path binds once for its turn, the warm path re-binds per turn while
 * the token underneath stays put.
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

export interface ConnectorRegistryBinding {
  readonly bridge: AiBrowserBridge
  /** The validated open project, or `undefined` when the turn has none. */
  readonly workspaceDir: string | undefined
}

/**
 * Bind the permission gate and the workspace for one turn, returning the
 * matching release. Safe to call repeatedly against the same connector id as
 * long as each binding's release runs before the next is taken.
 */
export function bindConnectorRegistries(connectorId: string, binding: ConnectorRegistryBinding): () => void {
  const releasePermissionGate = registerPermissionGate(connectorId, binding.bridge)
  const releaseWorkspace = binding.workspaceDir ? registerConnectorWorkspace(connectorId, binding.workspaceDir) : null
  return () => {
    releasePermissionGate()
    releaseWorkspace?.()
  }
}

/** Mint a connector, fail-soft. `null` means the turn runs without tools rather than failing. */
export async function mintConnectorOrNull(options: {
  readonly db: DbClient
  readonly userId: string
  readonly capabilities: readonly CoreCapability[]
  readonly conversationId: string
  readonly mintConnector?: MintConnector
}): Promise<ClaudeCliSessionConnector | null> {
  const mint = options.mintConnector ?? mintClaudeCliSessionConnector
  try {
    return await mint(options.db, options.userId, options.capabilities, options.conversationId)
  } catch (err) {
    console.error('[ai/claudeCli] failed to mint a session MCP connector — continuing without tools:', err)
    return null
  }
}

export interface OpenTurnConnectorOptions extends ConnectorRegistryBinding {
  readonly db: DbClient
  readonly userId: string
  readonly capabilities: readonly CoreCapability[]
  readonly conversationId: string
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

/** The COLD path's connector: minted, bound, and revoked all within one turn. */
export async function openTurnConnector(options: OpenTurnConnectorOptions): Promise<TurnConnector> {
  const revoke = options.revokeConnector ?? revokeClaudeCliSessionConnector
  const connector = await mintConnectorOrNull(options)
  const release = connector ? bindConnectorRegistries(connector.connectorId, options) : null

  return {
    connector,
    close: async () => {
      release?.()
      // The token is scoped to THIS turn — expire it with the turn, not the
      // 1-day TTL floor. Never reuse a long-lived connector token.
      if (connector) await revoke(options.db, connector.connectorId, options.userId)
    },
  }
}
