/**
 * Claude CLI driver — a local subprocess, not an HTTP provider (WS-11).
 *
 * Studio's AgentPanel becomes a front-end over a local `claude` process,
 * exactly the way the Claude Code VS Code extension works: no API key, no
 * token Studio ever reads, subscription login (Pro/Max) works directly
 * because the CLI carries whatever login the user already has.
 *
 * ## The loop-ownership fork (WS-11 §4.1)
 *
 * Every other driver in this directory is a thin HTTP adapter: `runToolLoop`
 * (`http/toolLoop.ts`) owns the multi-turn agent loop, tool dispatch, and
 * retries, and the driver only translates one provider's wire format. This
 * driver does NOT use `runToolLoop` — the `claude` subprocess owns its own
 * agent loop internally. Turn structure, retries, and tool-permission prompts
 * are the CLI's, not `toolLoop.ts`'s. That is a genuine behavioural fork from
 * every other driver, not an oversight — do not paper over it.
 *
 * `req.tools` (Studio's generic `AiTool[]` list) is therefore never forwarded
 * to the CLI directly — it wouldn't mean anything to it. Instead (step 3),
 * the subprocess is launched with `--mcp-config` pointing at Studio's own
 * `/_studio/mcp` endpoint, carrying a connector token minted and scoped to
 * this one chat turn (`mcp/sessionConnector.ts`). The CLI's own MCP client
 * discovers Studio's real toolset — including browser-bridged writes,
 * relayed through the SAME `(userId, scope)` live bridge an external Claude
 * Code connector uses (`docs/features/mcp-connectors.md`) — with zero
 * duplicated tool-routing code. `--strict-mcp-config` is mandatory: without
 * it the CLI merges the user's own `~/.claude.json` and the project's
 * `.mcp.json` and connects to whatever it finds there. Studio ships exactly
 * the toolset it intends and no more.
 *
 * `--mcp-config`'s argument is a PATH, not inline JSON — the config
 * (connector token, plus any resolved project/registered server secrets) is
 * written to a private 0600 temp file by `writeMcpConfigFile`
 * (`claudeCliMcpConfigFile.ts`) and cleaned up in this function's own
 * `finally` block. Process command lines are world-readable
 * (`ps -eo command`), so passing that same JSON inline would print every
 * secret it carries to any local process — see that file's doc comment for
 * the full reasoning.
 *
 * ## The workspace `cwd` (WS-11 step 2 fix)
 *
 * A REAL chat turn spawns in the resolved, containment-checked project
 * directory (`resolveClaudeCliWorkspaceCwd`) — not the per-user config dir.
 * This is what makes `.claude/agents/*.md` auto-discovery work at all (the
 * entire WS-12 §7 subagent roster reaches the CLI through it — spawn in the
 * wrong place and there are silently zero subagents), plus `CLAUDE.md`
 * discovery and the tools' own view of the project. The per-user config dir
 * remains right for the availability PROBE only
 * (`server/ai/drivers/claudeCliProbe.ts`), which must never risk a real
 * project's `CLAUDE.md` cache-creation cost (WS-11 §4.0's $0.168 warning) —
 * when no workspace is open (or it fails containment), a chat turn falls back
 * to the config dir too, a documented degraded case, not a crash.
 *
 * ## Multi-turn continuity: a WARM process, with the cold spawn as recovery
 *
 * Every turn used to cold-spawn `claude` and re-handshake every MCP server
 * attached to it — the largest fixed cost in a turn, paid identically for
 * "change this padding" and "rebuild the checkout screen". WS-11 deferred the
 * fix because `--input-format stream-json`'s stdin message shape "was never
 * verified"; W4-2B verified it against the installed binary, and
 * `claudeCliStdinProtocol.ts` records exactly what the spike established
 * (envelope shape, turn boundaries, the measured 956 ms → 3 ms first-line
 * difference, the fact that MCP servers initialize once, and the one hard
 * rule: malformed stdin kills the process).
 *
 * So a conversation now keeps ONE subprocess alive across its turns
 * (`claudeCliSessionPool.ts` decides which conversation gets which process and
 * when one dies; `claudeCliWarmSession.ts` talks to it). A turn that cannot
 * use a warm process — none compatible, spawn failed, or the process died
 * before producing output — runs down the COLD path below, unchanged. That
 * path is not legacy and not a shim: it is the crash-recovery mechanism, and
 * deleting it would turn every wedged subprocess into a broken conversation.
 *
 * Both paths still pass `--session-id`/`--resume`, keyed by a UUID
 * deterministically derived from the Studio conversation id AND its
 * `session_epoch` (`claudeCliSession.ts`) — the same `(id, epoch)` pair always
 * hashes to the same UUID, so there is no separately-stored UUID, only the
 * epoch counter itself (migration 021). That is what lets a cold turn pick up
 * the transcript a dead warm session left behind, instead of starting over.
 * `req.messages` is still only consulted for the LATEST user message text; the
 * CLI's own session (in memory when warm, its transcript file when cold) is
 * what remembers the rest, not a replayed `AiMessage[]` log the way every HTTP
 * driver in this directory does it.
 *
 * ## `req.systemPrompt`'s STATIC PREFIX is not forwarded — its DYNAMIC
 * SUFFIX is (the write-verification gate)
 *
 * For the same reason `req.tools` is not: the CLI is an agent, not a raw
 * model. It supplies its own operating instructions, and the static half of
 * Studio's chat system prompt (`systemPrompt.ts`'s `buildStaticPromptPrefix`
 * — role, workflow, failure examples) describes a tool surface this driver
 * never hands it; the project's own generated `CLAUDE.md`, loaded for free
 * from the subprocess `cwd` (see the guide generation below), covers the same
 * ground in this driver's own vocabulary instead.
 *
 * On a WARM session the suffix cannot ride `--append-system-prompt` past the
 * first turn — it is argv, fixed at spawn. A warm turn whose suffix has
 * CHANGED therefore carries it inside the user message instead, and only when
 * it changed (`WarmSessionLease.takeSystemState`): re-sending an unchanged
 * board digest every turn would stack a fresh copy into the conversation's
 * permanent history, which is the opposite of what the cache-stability
 * reasoning below is protecting.
 *
 * The DYNAMIC SUFFIX (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` onward — board state,
 * armed design references, per-page write/verify status, capability facts)
 * is different in kind: it is per-turn, per-project LIVE STATE that cannot
 * live in `CLAUDE.md` without busting that file's own turn-to-turn stability
 * (and the prompt-cache reuse that stability buys — WS-11 §4.0's $0.168
 * warning). This was the exact gap a real, measured session fell into: the
 * digest that states plainly whether a just-written page has a passing
 * `studio_compare` was computed on every turn and never reached this driver
 * at all, so an agent authoring files natively through this driver had no
 * live signal that anything was unverified — only the Stop-hook gate below
 * caught it, after the fact. `--append-system-prompt` below forwards ONLY
 * this suffix (never the static prefix CLAUDE.md already covers) — small,
 * appended after the CLI's own base prompt and `CLAUDE.md`, so it costs a
 * few hundred uncached tokens per turn rather than perturbing what IS cached.
 *
 * Whether THIS turn establishes or resumes is decided by
 * `shouldEstablishClaudeCliSession`: does the CLI already have a transcript
 * file for the derived uuid at this `cwd`? Not a message-count heuristic —
 * see that function's own doc comment for why a bumped `session_epoch`
 * (the "Restart agent session" control) makes a pure message-count check
 * wrong, and why a direct filesystem probe is the honest question to ask
 * instead.
 *
 * ## Native tool surface (sec-XX)
 *
 * `--tools` below is a hard ceiling on native built-ins — at most `Task`/`Read`, never `Bash`/`Write`/`Edit`/`Glob`/`Grep`/`WebFetch`. Reasoning: `resolveNativeToolAllowlist`'s own doc comment (`claudeCliToolSurface.ts`).
 */

import type { AiAuthMode, AiContentBlock, AiProviderId, AiStreamEvent } from '../runtime/types'
import type { AiProvider, AiResolvedCredential, AiStreamRequest } from './types'
import { claudeCliCapabilities, CLAUDE_CLI_FALLBACK_MODELS } from './claudeCliModels'
import { minimalSubprocessEnv, type SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { assertLooksLikeSetupToken, verifyClaudeCliCredential } from './claudeCliVerify'
import {
  claudeCliPlatformSupport,
  ensureClaudeCliConfigDir,
  resolveClaudeCliDataRoot,
  resolveClaudeCliWorkspaceCwd,
  type ClaudeCliPlatformSupport,
} from '../../handlers/studio/claudeCliEnv'
import { spawnClaudeCliNdjson, ClaudeCliSpawnError } from './claudeCliSpawn'
import { resolveNativeToolAllowlist } from './claudeCliToolSurface'
import { assertBypassCameFromRequest, resolvePermissionMode } from './claudeCliPermissionMode'
import { translateClaudeCliStream } from './claudeCliEvents'
import { claudeCliSessionId, shouldEstablishClaudeCliSession } from './claudeCliSession'
import { openTurnConnector, type MintConnector, type RevokeConnector } from './claudeCliConnector'
import { approvedProjectMcpServers, type ProjectMcpServerDefinition } from './projectMcpServers'
import { resolvedApprovedRegisteredMcpServers } from './registeredMcpServers'
import { generateStudioProjectGuide } from '../../handlers/studio/projectGuide'
import { readTurnWriteLog, resetTurnWriteLog } from '../../handlers/studio/turnWriteLog'
import { STUDIO_AGENT_USER_KEY_ENV, studioAgentUserKey } from '../../handlers/studio/agentUserScope'
import { resolveTurnRouting } from '../routing/turnRouting'
import {
  stageAttachments,
  cleanupAttachments,
  describeAttachmentsForPrompt,
  ensureConversationAttachmentsRoot,
} from './claudeCliAttachments'
import { cleanupMcpConfigFile, tryWriteMcpConfigFile } from './claudeCliMcpConfigFile'
import { clearCliNeedsAuthCache, recallCliSignIns } from '../credentials/cliMcpConnectionProbe'
import { buildClaudeCliArgv, buildMcpConfig, dynamicSystemPromptSuffix } from './claudeCliArgv'
import { runWarmTurn } from './claudeCliWarmTurn'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

/**
 * `--effort` is a real, user-requested requirement (WS-12 §5.1). It is
 * request-driven from `req.effort` when the user pinned one, and otherwise
 * ROUTED per turn by `../routing/turnRouting.ts` — read that module for the two
 * rules it enforces (an explicit choice is never overridden; unsure routes up)
 * and for why the MODEL is deliberately not routed alongside the effort.
 */

export const claudeCliDriver: AiProvider = {
  id: 'claudeCli' as AiProviderId,
  label: 'Claude Code (subscription)',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    return claudeCliCapabilities()
  },

  async listModels() {
    return CLAUDE_CLI_FALLBACK_MODELS
  },

  /**
   * The catalogue (`claudeCliModels.ts`) is entirely `'fallback'` by design, so the default
   * live-model test can never pass here (see `verifyCredential`'s doc on the
   * `AiProvider` interface). The honest check is the smallest possible real
   * turn — see `verifyClaudeCliCredential` below for why `claude auth status`
   * is NOT that check, despite being the free one. Factored out for the same
   * reason `stream()` is a thin wrapper over `streamClaudeCli` — the
   * `AiProvider` interface itself has no room for a `spawn` test seam.
   */
  verifyCredential(credentials: AiResolvedCredential): Promise<void> {
    return verifyClaudeCliCredential(credentials)
  },

  validateSecretShape(secret: string): void {
    assertLooksLikeSetupToken(secret)
  },

  stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    return streamClaudeCli(req)
  },
}

/**
 * The `stream()` implementation, factored out of the `AiProvider` object so
 * tests can inject a fake spawn, platform-support result, and MCP
 * connector mint/revoke without a real `claude` binary, a real subprocess,
 * or a real database — the `AiProvider` interface itself has no room for
 * test seams (every other driver's tests inject at the `fetch` layer
 * instead; this driver's equivalent boundary is `spawn` plus the two MCP
 * connector functions).
 */
export interface StreamClaudeCliOptions {
  /** Test seam — defaults to `Bun.spawn`. ONE seam for both paths: a warm session spawns with `stdin: 'pipe'`, a cold turn with the prompt bytes, and both go through here. */
  readonly spawn?: SubprocessSpawnFn
  /** Test seam — defaults to the real `process.platform` check. */
  readonly platformSupport?: ClaudeCliPlatformSupport
  /** Test seam — defaults to `resolveClaudeCliDataRoot()` (env-derived). */
  readonly dataRoot?: string
  /** Test seam — defaults to `studio-workspace/` (`projectsRootDir()`). */
  readonly projectsRoot?: string
  /** Test seam — defaults to `readServerConfig().port`. */
  readonly serverPort?: number
  /** Test seam — defaults to `mintClaudeCliSessionConnector`. */
  readonly mintConnector?: MintConnector
  /** Test seam — defaults to `revokeClaudeCliSessionConnector`. */
  readonly revokeConnector?: RevokeConnector
  /**
   * Force the warm path off for this turn. Set by the tests that exercise the
   * cold path in isolation; production never sets it, because "warm, falling
   * back to cold" is the whole behaviour, not an option.
   */
  readonly disableWarmSession?: boolean
  /** Test seam — defaults to `generateStudioProjectGuide` (the project's own generated `CLAUDE.md` + design-system references). */
  readonly generateGuide?: typeof generateStudioProjectGuide
  /** Test seam — defaults to `resolveMcpServerSecretsRoot()` (env-derived); where registered-server secret values are decrypted from. */
  readonly mcpServerSecretsDataRoot?: string
}

export async function* streamClaudeCli(
  req: AiStreamRequest,
  options: StreamClaudeCliOptions = {},
): AsyncGenerator<AiStreamEvent> {
  const platform = options.platformSupport ?? claudeCliPlatformSupport()
  if (!platform.supported) {
    yield { type: 'error', message: platform.reason ?? 'Claude CLI is not available on this host.' }
    return
  }

  if (req.credentials.authMode !== 'apiKey') {
    // Defensive: a non-apiKey credential reaching this driver implies a
    // mismatched DB row or a bypassed UI. `apiKey` itself may legitimately
    // be null (the L1 terminal-login path stores no credential row at
    // all) — only the auth MODE is asserted here.
    yield {
      type: 'error',
      message: 'Claude CLI credentials must be apiKey-shaped. Re-create the credential in Settings → AI → Providers.',
    }
    return
  }

  const promptText = latestUserPromptText(req.messages)
  if (!promptText) {
    yield { type: 'error', message: 'No user message to send to the Claude CLI.' }
    return
  }

  // WS-12 §5.3 — stage any attached images to files and point the prompt at
  // their paths; `null` when the turn has none (the common case), costing
  // nothing. Torn down unconditionally in the `finally` block below,
  // alongside connector revocation.
  //
  // Staged into the conversation's stable root rather than a bare temp
  // directory, because a warm process can only ever read from directories that
  // were on its argv at spawn — see `ensureConversationAttachmentsRoot`. The
  // per-TURN directory beneath it, and its cleanup, are unchanged.
  const attachmentsRoot = ensureConversationAttachmentsRoot(
    req.toolContextBase.userId,
    req.toolContextBase.conversationId,
  )
  const attachmentStaging = stageAttachments(latestUserMessageContent(req.messages), attachmentsRoot)
  const prompt = attachmentStaging ? promptText + describeAttachmentsForPrompt(attachmentStaging) : promptText

  // The real workspace root when one is open and passes containment; `null`
  // otherwise. Resolved here rather than beside `cwd` below because BOTH the
  // permission-mode default and the native tool allowlist depend on it. Pure
  // and cheap (a path containment check), so hoisting it costs nothing.
  const workspaceCwd = resolveClaudeCliWorkspaceCwd(req.workspaceDir, options.projectsRoot)

  // Checked before anything else spawns — a refused mode must never reach
  // argv assembly, let alone a real subprocess.
  const resolvedMode = resolvePermissionMode(req.permissionMode, workspaceCwd !== null)
  if (!resolvedMode.ok) {
    yield { type: 'error', message: resolvedMode.message }
    return
  }
  // Auto-routing needs to know whether the LAST turn wrote anything, so this
  // reads the turn-write log BEFORE `resetTurnWriteLog` clears it for this
  // turn (a few lines below, right before spawn). Zero when no project is open.
  const agentUserKey = studioAgentUserKey(req.toolContextBase.userId)
  const previousTurnWriteCount = workspaceCwd ? readTurnWriteLog(workspaceCwd, agentUserKey).length : 0
  const routing = resolveTurnRouting({
    requestedEffort: req.effort,
    signals: {
      prompt: promptText,
      attachmentCount: attachmentStaging?.files.length ?? 0,
      previousTurnWriteCount,
    },
  })
  const effort = routing.effort
  // Emitted before anything is spent, so the composer can show what this turn
  // was routed to while it is still running — see the event's own doc.
  yield {
    type: 'routing',
    mode: routing.mode,
    effort: routing.effort,
    ...(routing.shape ? { shape: routing.shape } : {}),
    reason: routing.reason,
  }

  let configDir: string
  try {
    configDir = ensureClaudeCliConfigDir(options.dataRoot ?? resolveClaudeCliDataRoot(), req.toolContextBase.userId)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    yield { type: 'error', message: `Could not prepare the Claude CLI environment: ${detail}` }
    return
  }

  // `workspaceCwd` (hoisted above) is the real workspace root when one is open
  // and passes containment; the per-user config dir is the fallback. See the
  // file doc comment's "workspace cwd" section for why this distinction
  // matters — and note that a real project's own generated `CLAUDE.md`
  // (`projectGuide.ts`) is loaded by the CLI precisely BECAUSE cwd is the
  // project, which is why the fallback dir must stay CLAUDE.md-free.
  const cwd = workspaceCwd ?? configDir

  // The project's own authoring guide — `CLAUDE.md` at the project root plus
  // the `.claude/` design-system references — regenerated on every real turn
  // against an open project, right alongside the MCP config below. The CLI
  // loads `CLAUDE.md` from its cwd for free, so this is how the agent learns
  // this project's conventions without spending a tool call on it.
  // Best-effort: a probe failure degrades this turn to "no guide", never
  // blocks the chat itself. Never attempted for the config-dir fallback (no
  // real project to profile there, and that dir must stay CLAUDE.md-free).
  const generateGuide = options.generateGuide ?? generateStudioProjectGuide
  // The CLI reads `CLAUDE.md` ONCE, at startup, so a warm process keeps
  // serving the guide it was born with. `generateStudioProjectGuide` is
  // manifest-gated and returns an EMPTY `written` list on the overwhelmingly
  // common turn where nothing changed — which makes "the guide was actually
  // rewritten" a free, exact signal that the warm session is now stale and
  // must be replaced rather than reused.
  let guideRewritten = false
  if (workspaceCwd) {
    try {
      guideRewritten = generateGuide(workspaceCwd).written.length > 0
    } catch (err) {
      console.error('[ai/claudeCli] failed to generate the project guide — continuing without one:', err)
    }
    // verification-gate item 2/3 — a fresh turn-write log for THIS turn. The
    // project's generated `.claude/settings.local.json` (part of the guide
    // just above) wires a `PostToolUse` hook that appends to this log on
    // every native `Write`/`Edit`, and a `Stop` hook that reads it back — see
    // `turnWriteLog.ts`'s "turn boundary" note for why the reset has to
    // happen HERE, right before spawn, and not inside either hook.
    resetTurnWriteLog(workspaceCwd, agentUserKey)
  }

  // The CLI caches "this server needs authentication" per config dir and a
  // headless turn believes that cache over the server itself — so one turn
  // taken before the sign-in disables the connector for every turn after it,
  // sign-in or no sign-in. Drop the entry for each server this user has
  // actually been observed signed in to, right before the spawn that would
  // otherwise read it. Two small file operations, no subprocess, fail-soft.
  // See `cliMcpConnectionProbe.ts`'s `clearCliNeedsAuthCache`.
  clearCliNeedsAuthCache(configDir, recallCliSignIns(configDir))

  const env = minimalSubprocessEnv([], {
    CLAUDE_CONFIG_DIR: configDir,
    // Inherited by every hook the CLI spawns (`recordToolWrite`,
    // `stopGateCheck`), which is how a hook subprocess learns WHOSE turn it
    // is running inside — the generated hook command cannot carry it, because
    // one project's `.claude/settings.local.json` is shared by every user of
    // that project. Non-identifying by construction. See `agentUserScope.ts`.
    [STUDIO_AGENT_USER_KEY_ENV]: agentUserKey,
    ...(req.credentials.apiKey ? { CLAUDE_CODE_OAUTH_TOKEN: req.credentials.apiKey } : {}),
  })

  const sessionId = await claudeCliSessionId(req.toolContextBase.conversationId, req.sessionEpoch ?? 0)
  // Whether the CLI already has a transcript for THIS uuid at THIS cwd — see
  // `shouldEstablishClaudeCliSession`'s own doc comment for why this replaced
  // the earlier message-count heuristic (it silently self-heals a bumped
  // `session_epoch`, a cleared config dir, and a server redeploy, none of
  // which a message count could ever detect).
  //
  // Read at SPAWN time only. A warm session establishes on its first turn and
  // is `--resume`-able forever after, which is exactly what lets a cold
  // fallback pick up where a dead warm process left off — but it also means
  // this value flips after the first turn, so it must never enter the pool's
  // reuse fingerprint or every second turn would respawn.
  const sessionFlag = shouldEstablishClaudeCliSession(configDir, cwd, sessionId) ? '--session-id' : '--resume'

  // Studio-registered project MCP servers (§ "the gap" in
  // `registeredMcpServers.ts`'s doc comment) — approved-by-name exactly like
  // project-declared `.mcp.json` servers, with any declared secret field
  // decrypted here, right before the spawn, and never written to disk in
  // resolved form. Best-effort: a secret-store hiccup degrades this turn to
  // "no registered servers" rather than blocking the chat, same posture the
  // connector mint below uses.
  let registeredServers: Record<string, ProjectMcpServerDefinition> = {}
  if (workspaceCwd) {
    try {
      registeredServers = await resolvedApprovedRegisteredMcpServers(
        req.toolContextBase.userId,
        workspaceCwd,
        options.mcpServerSecretsDataRoot,
        options.projectsRoot,
      )
    } catch (err) {
      console.error('[ai/claudeCli] failed to resolve registered MCP servers — continuing without them:', err)
    }
  }
  const projectServers = workspaceCwd ? approvedProjectMcpServers(workspaceCwd) : {}

  // Everything below is shared by both paths — the ONLY difference between a
  // warm session's argv and a cold turn's is `--input-format`
  // (`claudeCliArgv.ts`).
  const argvOptions = {
    modelId: req.modelId,
    effort,
    // Belt-and-braces at the point of maximum consequence — see
    // `assertBypassCameFromRequest`'s own doc comment.
    permissionMode: assertBypassCameFromRequest(resolvedMode.mode, req.permissionMode),
    // sec-XX (see "Native tool surface" above) — `files.length`, since a
    // refusal-only staging result stages nothing on disk.
    nativeTools: resolveNativeToolAllowlist(workspaceCwd, (attachmentStaging?.files.length ?? 0) > 0),
    // The conversation's attachment ROOT, not this turn's directory beneath
    // it, and granted unconditionally rather than only on turns that staged
    // something. `--add-dir` is argv: a warm process can only ever read from
    // directories it was told about at spawn, so a per-turn grant would mean
    // the first attachment sent to an already-running session hits exactly the
    // "you haven't granted it yet" dead end this pre-authorisation exists to
    // prevent. It is not a widening worth worrying about — the directory holds
    // nothing but files this conversation's own user attached, and `--tools`
    // above remains the actual ceiling: without `Read` granted for THIS turn,
    // an authorised directory buys the agent nothing.
    addDirs: [attachmentsRoot],
    sessionFlag,
    sessionId,
    // The write-verification gate — ONLY the dynamic suffix (never the static
    // prefix CLAUDE.md already covers), and only when a real project is open.
    // See this file's own doc comment, "req.systemPrompt's STATIC PREFIX...".
    systemPromptSuffix: workspaceCwd ? dynamicSystemPromptSuffix(req.systemPrompt) : null,
  } as const

  // WS-12 §5.3 — staged attachments are turn-scoped working data, never left
  // behind regardless of how the turn ended, which path served it, or whether
  // the consumer abandoned the stream mid-reply. This wraps BOTH paths: the
  // warm one returns early on success, so a cleanup living only in the cold
  // path's own `finally` would silently leak every warm turn's attachments.
  try {
    // ---- warm path -----------------------------------------------------------
    //
    // A conversation keeps one `claude` process alive across its turns. When
    // there is a compatible one, this turn costs a single line of NDJSON instead
    // of a process start plus an MCP handshake with every attached server.
    // Anything that goes wrong here falls through to the cold path below, which
    // is the same code that used to run for every turn.
    if (!options.disableWarmSession) {
      const served = yield* runWarmTurn(req, options, {
        argvOptions,
        cwd,
        env,
        prompt,
        projectServers,
        registeredServers,
        // The CLI reads `CLAUDE.md` once, at startup — a session that predates a
        // rewrite is serving stale instructions and has to be replaced.
        forceRespawn: guideRewritten,
        workspaceDir: workspaceCwd ?? undefined,
      })
      if (served) return
    }

    // ---- cold path — also the crash-recovery path ----------------------------
    //
    // Reached when no warm session could be used: the warm path is disabled, the
    // spawn failed, or the process died before this turn produced any output.
    // Keeping it is not caution about a new feature — it is the recovery
    // mechanism, and without it a single wedged subprocess would break a
    // conversation permanently.
    //
    // Mints the turn's MCP token and binds both connector-id registries (the
    // permission gate and the workspace this turn is about) — all three are
    // acquired together and released together by `turn.close()` in the `finally`
    // below. See `claudeCliConnector.ts` for why they travel as one unit.
    const turn = await openTurnConnector({
      db: req.toolContextBase.db,
      userId: req.toolContextBase.userId,
      capabilities: req.toolContextBase.capabilities,
      conversationId: req.toolContextBase.conversationId,
      bridge: req.bridge,
      workspaceDir: workspaceCwd ?? undefined,
      ...(options.mintConnector ? { mintConnector: options.mintConnector } : {}),
      ...(options.revokeConnector ? { revokeConnector: options.revokeConnector } : {}),
    })

    // The whole config (Studio's own entry, carrying this turn's connector
    // bearer token, plus any approved project/registered servers, which may
    // carry a decrypted secret header/env value) is written to a private,
    // 0600 temp file rather than handed to the CLI as inline `--mcp-config`
    // JSON — see `claudeCliMcpConfigFile.ts`'s doc comment for why: argv is
    // world-readable (`ps -eo command`), so an inline secret there defeats the
    // encrypted-at-rest secret store entirely. A write failure degrades this
    // turn to "no MCP tools", the same fail-soft posture a connector-mint
    // failure already gets, rather than aborting the whole turn.
    const mcpConfigFile = turn.connector
      ? tryWriteMcpConfigFile(buildMcpConfig(turn.connector, options.serverPort, projectServers, registeredServers))
      : null

    try {
      yield* translateClaudeCliStream(
        spawnClaudeCliNdjson({
          argv: buildClaudeCliArgv({ ...argvOptions, mcpConfigPath: mcpConfigFile?.path ?? null, inputFormat: 'text' }),
          cwd,
          env,
          stdin: new TextEncoder().encode(prompt),
          signal: req.signal,
          spawn: options.spawn,
        }),
      )
    } catch (err) {
      if (err instanceof ClaudeCliSpawnError) {
        yield { type: 'error', message: err.message }
        return
      }
      throw err
    } finally {
      // Releases the permission gate and the workspace binding first, then
      // revokes the token — so no prompt can be relayed down a bridge whose turn
      // has already ended.
      await turn.close()
      // On the COLD path the plaintext config file (connector token, plus any
      // resolved MCP server secrets) is turn-scoped working data and is never
      // left behind, however the turn ended (success, error, or the subprocess
      // killed on abort) — a leaked secret file on disk is a worse outcome than
      // the inline-argv bug this replaced. A WARM session's config file is
      // SESSION-scoped instead, for the same reason its token is, and is
      // removed by that session's `dispose` (`createWarmSession`).
      if (mcpConfigFile) {
        cleanupMcpConfigFile(mcpConfigFile.dir)
      }
    }
  } finally {
    if (attachmentStaging) {
      cleanupAttachments(attachmentStaging.dir)
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly — see the file doc comment's "Multi-turn continuity"
// section for why only the latest message is sent here (the CLI's own
// `--session-id`/`--resume` session remembers the rest, not a replayed log).
// ---------------------------------------------------------------------------

function latestUserPromptText(messages: AiStreamRequest['messages']): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue
    const text = textOf(msg.content)
    if (text) return text
  }
  return null
}

/** The SAME latest user message `latestUserPromptText` reads from — its full content blocks, for attachment staging (WS-12 §5.3). `[]` when there is no user message at all (the caller already refuses that case via `latestUserPromptText` returning `null`). */
function latestUserMessageContent(messages: AiStreamRequest['messages']): AiContentBlock[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!
    if (msg.role === 'user') return msg.content
  }
  return []
}

function textOf(blocks: AiContentBlock[]): string | null {
  const text = blocks
    .filter((block): block is Extract<AiContentBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text)
    .join('\n')
  return text.length > 0 ? text : null
}
