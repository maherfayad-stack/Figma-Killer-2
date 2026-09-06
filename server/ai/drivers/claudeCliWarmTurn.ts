/**
 * Serving one chat turn from a warm, pooled `claude` process.
 *
 * Three modules sit under this one, each with its own reason to change:
 * `claudeCliStdinProtocol.ts` (what a turn looks like on the wire),
 * `claudeCliWarmSession.ts` (one live process), and
 * `claudeCliSessionPool.ts` (which process, and for how long). THIS module is
 * the turn itself: it decides what the process needs to be started with, mints
 * and holds the session-scoped credential, rebinds the per-turn registries,
 * and hands back a plain "served / did not serve" answer.
 *
 * `claudeCli.ts` calls exactly one function here and, on a `false`, runs the
 * cold path it has always run. That boundary is the point: the driver stays
 * readable as "try warm, else cold", and everything warm-specific — the reuse
 * fingerprint, the connector lifetime, the board-state carry — lives here
 * where it can be read as one story.
 */

import type { AiStreamEvent } from '../runtime/types'
import type { AiStreamRequest } from './types'
import type { ClaudeCliSessionConnector } from '../mcp/sessionConnector'
import { revokeClaudeCliSessionConnector } from '../mcp/sessionConnector'
import { bindConnectorRegistries, mintConnectorOrNull, type MintConnector, type RevokeConnector } from './claudeCliConnector'
import { buildClaudeCliArgv, buildMcpConfig } from './claudeCliArgv'
import { cleanupMcpConfigFile, tryWriteMcpConfigFile } from './claudeCliMcpConfigFile'
import { translateClaudeCliStream } from './claudeCliEvents'
import { ClaudeCliWarmSession, ClaudeCliWarmSessionDeadError } from './claudeCliWarmSession'
import {
  acquireWarmSession,
  disposeWarmSessionsForConversation,
  type WarmSessionLease,
  type WarmSessionResources,
} from './claudeCliSessionPool'
import { removeConversationAttachmentsRoot } from './claudeCliAttachments'
import type { SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'

/**
 * The test seams a warm turn needs — a structural subset of
 * `StreamClaudeCliOptions`, declared here rather than imported so the driver
 * can depend on this module without this module depending back on the driver.
 */
export interface WarmTurnSeams {
  readonly spawn?: SubprocessSpawnFn
  readonly serverPort?: number
  readonly mintConnector?: MintConnector
  readonly revokeConnector?: RevokeConnector
}

export interface WarmTurnContext {
  readonly argvOptions: Omit<Parameters<typeof buildClaudeCliArgv>[0], 'mcpConfigPath' | 'inputFormat'>
  readonly cwd: string
  readonly env: Record<string, string>
  readonly prompt: string
  readonly projectServers: Record<string, unknown>
  readonly registeredServers: Record<string, unknown>
  readonly forceRespawn: boolean
  readonly workspaceDir: string | undefined
}

/**
 * Serve this turn from a warm session, yielding its events. Returns `true`
 * when it did; `false` means the caller must run the cold path, and is
 * guaranteed to be returned WITHOUT having yielded anything — a turn that has
 * already streamed text to the user can never be silently re-run.
 *
 * Every failure here is a `false`, never a thrown error: a warm session is an
 * optimisation over a path that still works.
 */
export async function* runWarmTurn(
  req: AiStreamRequest,
  options: WarmTurnSeams,
  ctx: WarmTurnContext,
): AsyncGenerator<AiStreamEvent, boolean, void> {
  const conversationId = req.toolContextBase.conversationId
  if (ctx.forceRespawn) await disposeWarmSessionsForConversation(conversationId)

  let lease: WarmSessionLease
  try {
    lease = await acquireWarmSession({
      conversationId,
      fingerprint: warmSessionFingerprint(ctx),
      create: () => createWarmSession(req, options, ctx),
    })
  } catch (err) {
    console.error('[ai/claudeCli] could not start a warm session — falling back to a cold spawn:', err)
    return false
  }

  // Re-bound on EVERY turn, reused process or not: `bridge` is the live
  // browser connection that relays permission prompts and is a different
  // object after a reload, and `workspaceDir` changes the moment the user
  // opens another project. See `claudeCliConnector.ts`.
  const releaseRegistries = lease.connectorId
    ? bindConnectorRegistries(lease.connectorId, { bridge: req.bridge, workspaceDir: ctx.workspaceDir })
    : null

  let discarded = false
  try {
    // On the turn that SPAWNED the session the suffix already went out as
    // `--append-system-prompt`; consuming it here is what records that, so the
    // next turn only resends it if it has actually changed.
    const changedState = lease.takeSystemState(ctx.argvOptions.systemPromptSuffix)
    const prompt =
      changedState && !lease.spawnedNow
        ? `${STUDIO_STATE_PREAMBLE}\n${changedState}\n\n${ctx.prompt}`
        : ctx.prompt

    yield* translateClaudeCliStream(lease.session.runTurn(prompt, req.signal))
    return true
  } catch (err) {
    if (!(err instanceof ClaudeCliWarmSessionDeadError)) throw err
    // The process was gone before it produced anything for this turn. Drop it
    // and let the caller cold-spawn — the user sees a normal, slightly slower
    // reply rather than an error about a subprocess they never asked for.
    console.error('[ai/claudeCli] warm session unusable, falling back to a cold spawn:', err.message)
    discarded = true
    await lease.discard()
    return false
  } finally {
    releaseRegistries?.()
    if (!discarded) lease.endTurn()
  }
}

/** Labels the live-state block a warm turn carries inside its user message, so the model can tell Studio's per-turn state from the human's own words. */
const STUDIO_STATE_PREAMBLE = 'Updated Studio board state for this turn:'

/**
 * Everything baked into argv at spawn and unchangeable afterwards. A change to
 * any of it means the running process cannot honestly serve this turn, so the
 * pool respawns — see `claudeCliSessionPool.ts` for why `effort` is in here
 * (there is no `set_effort` control request) and `sessionFlag` is not.
 *
 * The MCP servers are fingerprinted by DEFINITION, not by the config file's
 * bytes: the file also carries a freshly-minted bearer token, which differs on
 * every mint and would make every session look incompatible with itself.
 */
function warmSessionFingerprint(ctx: WarmTurnContext): string {
  return JSON.stringify([
    ctx.argvOptions.modelId,
    ctx.argvOptions.effort,
    ctx.argvOptions.permissionMode,
    ctx.argvOptions.nativeTools,
    ctx.argvOptions.sessionId,
    ctx.cwd,
    ctx.env.CLAUDE_CONFIG_DIR ?? '',
    ctx.projectServers,
    ctx.registeredServers,
  ])
}

/**
 * Mint the conversation-scoped connector, write its MCP config file, and start
 * the process. The returned `dispose` is the ONLY thing that ends any of them,
 * and the pool guarantees it runs on every path that ends a session.
 */
async function createWarmSession(
  req: AiStreamRequest,
  options: WarmTurnSeams,
  ctx: WarmTurnContext,
): Promise<WarmSessionResources> {
  const connector = await mintConnectorOrNull({
    db: req.toolContextBase.db,
    userId: req.toolContextBase.userId,
    capabilities: req.toolContextBase.capabilities,
    conversationId: req.toolContextBase.conversationId,
    ...(options.mintConnector ? { mintConnector: options.mintConnector } : {}),
  })
  const mcpConfigFile = connector
    ? tryWriteMcpConfigFile(buildMcpConfig(connector, options.serverPort, ctx.projectServers, ctx.registeredServers))
    : null

  let session: ClaudeCliWarmSession
  try {
    session = ClaudeCliWarmSession.start({
      argv: buildClaudeCliArgv({
        ...ctx.argvOptions,
        mcpConfigPath: mcpConfigFile?.path ?? null,
        inputFormat: 'stream-json',
      }),
      cwd: ctx.cwd,
      env: ctx.env,
      ...(options.spawn ? { spawn: options.spawn } : {}),
    })
  } catch (err) {
    // Nothing is running, so nothing the pool would ever call `dispose` on —
    // clean up here and let the caller fall back.
    if (mcpConfigFile) cleanupMcpConfigFile(mcpConfigFile.dir)
    if (connector) await revokeWarmConnector(req, options, connector)
    throw err
  }

  return {
    session,
    connectorId: connector?.connectorId ?? null,
    dispose: async () => {
      session.dispose()
      if (mcpConfigFile) cleanupMcpConfigFile(mcpConfigFile.dir)
      // The token's life is the SESSION's, not a turn's — the CLI authenticates
      // its MCP clients once, at startup, so revoking sooner would leave a
      // running session silently toolless. See `claudeCliConnector.ts`.
      if (connector) await revokeWarmConnector(req, options, connector)
    },
  }
}

function revokeWarmConnector(
  req: AiStreamRequest,
  options: WarmTurnSeams,
  connector: ClaudeCliSessionConnector,
): Promise<void> {
  const revoke = options.revokeConnector ?? revokeClaudeCliSessionConnector
  return revoke(req.toolContextBase.db, connector.connectorId, req.toolContextBase.userId)
}

/**
 * End a conversation for good: kill its warm process (revoking the token with
 * it) and remove the attachment root its turns staged into.
 *
 * Called on conversation delete and on "Restart agent session". The attachment
 * root is removed HERE and not in a session's own `dispose` on purpose: its
 * lifetime is the conversation's, not the process's — a cold turn stages into
 * the same directory, including the cold turn that a just-discarded warm
 * session falls back to.
 */
export async function endClaudeCliConversation(conversationId: string): Promise<void> {
  await disposeWarmSessionsForConversation(conversationId)
  removeConversationAttachmentsRoot(conversationId)
}
