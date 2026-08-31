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
 * ## Multi-turn continuity (WS-11 step 2)
 *
 * `--input-format stream-json` exists (`--help` confirms it, plus
 * `--replay-user-messages` for exactly that mode) but its stdin JSON message
 * shape is NOT verified against the binary — establishing it with confidence
 * would mean sending a real paid turn, which this driver's tests must never
 * do. So this driver uses the CONFIRMED alternative instead:
 * `--session-id`/`--resume`, keyed by a UUID deterministically derived from
 * the Studio conversation id AND its `session_epoch` (`claudeCliSession.ts`)
 * — the same `(id, epoch)` pair always hashes to the same UUID, so there is
 * no separately-stored UUID, only the epoch counter itself (migration 021).
 * `req.messages` is still only consulted for the LATEST user message text
 * (the `-p` prompt); the CLI's own session file is what remembers the rest,
 * not a replayed `AiMessage[]` log the way every HTTP driver in this
 * directory does it.
 *
 * ## `req.systemPrompt` is NOT forwarded — and that is not an oversight
 *
 * For the same reason `req.tools` is not: the CLI is an agent, not a raw
 * model. It supplies its own operating instructions, and Studio's chat system
 * prompt describes a tool surface this driver never hands it. What this driver
 * gives the CLI instead is the project's own generated `CLAUDE.md`, loaded for
 * free from the subprocess `cwd` (see the guide generation below).
 *
 * The consequence is easy to trip over and has: **a caller whose instructions
 * live only in `systemPrompt` reaches this model with none of them.** That is
 * what `server/ai/oneShot.ts` composes around — read its module doc before
 * adding another non-chat caller. Making this driver honour `systemPrompt`
 * (`--append-system-prompt`) is a real option, but it would change what the
 * main chat sends on every turn, so it is a deliberate change with its own
 * validation, not a drive-by fix.
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
import type { AiProvider, AiProviderCapabilities, AiProviderModel, AiResolvedCredential, AiStreamRequest } from './types'
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
import { assertBypassOnlyFromExplicitRequest, resolvePermissionMode } from './claudeCliPermissionMode'
import { createClaudeCliTurnState, parseClaudeCliLineValue, translateClaudeCliLine } from './claudeCliEvents'
import { claudeCliSessionId, shouldEstablishClaudeCliSession } from './claudeCliSession'
import {
  mintClaudeCliSessionConnector,
  revokeClaudeCliSessionConnector,
  type ClaudeCliSessionConnector,
} from '../mcp/sessionConnector'
// Imported from the small, SDK-free `endpointPath.ts` module directly — NOT
// the `../mcp` barrel, which also re-exports `handleMcpHttp` and would pull
// `@modelcontextprotocol/sdk` into this driver's module graph transitively.
import { MCP_ENDPOINT_PATH } from '../mcp/endpointPath'
import { PERMISSION_REQUEST_TOOL_NAME } from '../mcp/permissionGate'
import { openTurnConnector } from './claudeCliTurnConnector'
import { approvedProjectMcpServers, type ProjectMcpServerDefinition } from './projectMcpServers'
import { resolvedApprovedRegisteredMcpServers } from './registeredMcpServers'
import { readServerConfig } from '../../config'
import { generateStudioProjectGuide } from '../../handlers/studio/projectGuide'
import { stageAttachments, cleanupAttachments, describeAttachmentsForPrompt } from './claudeCliAttachments'
import { writeMcpConfigFile, cleanupMcpConfigFile, type McpConfigFile } from './claudeCliMcpConfigFile'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

/** `--effort` is a real, user-requested requirement (WS-12 §5.1), request-driven from `req.effort` with this as the fallback — 'medium' matches the CLI's own implied default weighting (mid-scale of the five confirmed levels). */
const DEFAULT_EFFORT = 'medium'

function resolveEffort(requested: string | undefined): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (requested === 'low' || requested === 'medium' || requested === 'high' || requested === 'xhigh' || requested === 'max') {
    return requested
  }
  return DEFAULT_EFFORT
}

/**
 * Conservative aliases the CLI's `--model` flag accepts. Confirmed via
 * `--help`: "Provide an alias for the latest model (e.g. 'sonnet' or 'opus')
 * or a model's full name (e.g. 'claude-sonnet-4-6')" — 'haiku' is the third
 * documented Claude family and follows the same alias convention, but is not
 * independently confirmed. There is no verified "list installed models"
 * command, so this stays a static fallback rather than a live catalogue —
 * `catalogueSource: 'fallback'` is the SAME staleness signal Ollama's driver
 * uses when it has no live catalogue either (the picker/credential-seeding
 * code already treats fallback entries as non-authoritative; see
 * `seedEmptyDefaults` in `handlers/credentials.ts`, which refuses to
 * auto-default a model from a fallback-only list).
 */
const FALLBACK_MODELS: AiProviderModel[] = [
  {
    id: 'opus',
    label: 'Claude Opus',
    tier: 'smartest',
    catalogueSource: 'fallback',
    capabilities: claudeCliCapabilities(),
  },
  {
    id: 'sonnet',
    label: 'Claude Sonnet',
    tier: 'balanced',
    catalogueSource: 'fallback',
    capabilities: claudeCliCapabilities(),
  },
  {
    id: 'haiku',
    label: 'Claude Haiku',
    tier: 'fast',
    catalogueSource: 'fallback',
    capabilities: claudeCliCapabilities(),
  },
]

function claudeCliCapabilities(): AiProviderCapabilities {
  return {
    // Claude models genuinely tool-call; reporting true here is what lets
    // the chat handler's `tools.length > 0 && !modelCapabilities.toolCalling`
    // gate pass. Whether a given turn ACTUALLY has tools available depends on
    // the MCP connector minting below, not this static flag.
    toolCalling: true,
    // WS-12 §5.3 — true because this driver stages an attached image to a
    // file and points the prompt at its path (`claudeCliAttachments.ts`),
    // not because inline image BYTES through `-p` were ever confirmed
    // against the binary (they weren't, and still aren't). The CLI's own
    // built-in file tools do the actual reading.
    visionInput: true,
    // Distinct from `visionInput`: this is about a TOOL RESULT carrying an
    // image (e.g. a render_snapshot screenshot fed back mid-turn), which
    // this driver has no mechanism for — its tool calls are opaque MCP
    // round-trips inside the subprocess, not something this driver mediates.
    toolResultImages: false,
    // The CLI's own caching (if any) isn't something this driver controls
    // via `cache_control` — nothing here to report.
    promptCache: false,
    streaming: true,
  }
}

export const claudeCliDriver: AiProvider = {
  id: 'claudeCli' as AiProviderId,
  label: 'Claude Code (subscription)',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    return claudeCliCapabilities()
  },

  async listModels() {
    return FALLBACK_MODELS
  },

  /**
   * The catalogue above is entirely `'fallback'` by design, so the default
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
  /** Test seam — defaults to `Bun.spawn` via `claudeCliSpawn.ts`. */
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
  readonly mintConnector?: typeof mintClaudeCliSessionConnector
  /** Test seam — defaults to `revokeClaudeCliSessionConnector`. */
  readonly revokeConnector?: typeof revokeClaudeCliSessionConnector
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
  const attachmentStaging = stageAttachments(latestUserMessageContent(req.messages))
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
  const effort = resolveEffort(req.effort)

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
  if (workspaceCwd) {
    try {
      generateGuide(workspaceCwd)
    } catch (err) {
      console.error('[ai/claudeCli] failed to generate the project guide — continuing without one:', err)
    }
  }

  const env = minimalSubprocessEnv([], {
    CLAUDE_CONFIG_DIR: configDir,
    ...(req.credentials.apiKey ? { CLAUDE_CODE_OAUTH_TOKEN: req.credentials.apiKey } : {}),
  })

  // Mints the turn's MCP token and binds both connector-id registries (the
  // permission gate and the workspace this turn is about) — all three are
  // acquired together and released together by `turn.close()` in the `finally`
  // below. See `claudeCliTurnConnector.ts` for why they travel as one unit.
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
  const connector = turn.connector

  const sessionId = await claudeCliSessionId(req.toolContextBase.conversationId, req.sessionEpoch ?? 0)
  // Whether the CLI already has a transcript for THIS uuid at THIS cwd — see
  // `shouldEstablishClaudeCliSession`'s own doc comment for why this replaced
  // the earlier message-count heuristic (it silently self-heals a bumped
  // `session_epoch`, a cleared config dir, and a server redeploy, none of
  // which a message count could ever detect).
  const sessionFlag = shouldEstablishClaudeCliSession(configDir, cwd, sessionId) ? '--session-id' : '--resume'

  // Studio-registered project MCP servers (§ "the gap" in
  // `registeredMcpServers.ts`'s doc comment) — approved-by-name exactly like
  // project-declared `.mcp.json` servers, with any declared secret field
  // decrypted here, right before the spawn, and never written to disk in
  // resolved form. Best-effort: a secret-store hiccup degrades this turn to
  // "no registered servers" rather than blocking the chat, same posture the
  // connector mint above uses.
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

  // The whole config (Studio's own entry, carrying this turn's connector
  // bearer token, plus any approved project/registered servers, which may
  // carry a decrypted secret header/env value) is written to a private,
  // 0600 temp file rather than handed to the CLI as inline `--mcp-config`
  // JSON — see `claudeCliMcpConfigFile.ts`'s doc comment for why: argv is
  // world-readable (`ps -eo command`), so an inline secret there defeats the
  // encrypted-at-rest secret store entirely. A write failure degrades this
  // turn to "no MCP tools", the same fail-soft posture a connector-mint
  // failure already gets, rather than aborting the whole turn.
  let mcpConfigFile: McpConfigFile | null = null
  if (connector) {
    try {
      mcpConfigFile = writeMcpConfigFile(
        buildMcpConfig(
          connector,
          options.serverPort,
          workspaceCwd ? approvedProjectMcpServers(workspaceCwd) : {},
          registeredServers,
        ),
      )
    } catch (err) {
      console.error('[ai/claudeCli] failed to write the MCP config file — continuing without tools:', err)
    }
  }

  const argv = [
    'claude',
    // `-p` with NO positional prompt: the prompt is piped on stdin instead.
    // Mandatory on Windows — see `ClaudeCliSpawnOptions.stdin`.
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // WS-12 §5.4 — required for the `stream_event`/`thinking_delta` events
    // `claudeCliEvents.ts`'s translator watches for. Additive and low-risk:
    // it only asks the CLI to also emit partial-message deltas alongside the
    // existing `assistant`/`result` events already parsed; every event this
    // driver doesn't recognise already falls through to a no-op default
    // case, so an unexpected extra event type here cannot break the stream.
    '--include-partial-messages',
    '--model',
    req.modelId,
    '--effort',
    effort,
    '--permission-mode',
    // Belt-and-braces at the point of maximum consequence — see
    // `assertBypassOnlyFromExplicitRequest`'s own doc comment.
    assertBypassOnlyFromExplicitRequest(resolvedMode.mode, req.permissionMode),
    // sec-XX (see "Native tool surface" above) — `files.length`, since a refusal-only staging result stages nothing on disk.
    '--tools',
    resolveNativeToolAllowlist(workspaceCwd, (attachmentStaging?.files.length ?? 0) > 0),
    // Attachments are staged to an os.tmpdir() directory OUTSIDE the workspace
    // cwd, so the CLI's own path-based permission check would otherwise stop to
    // ask before reading them — "Claude requested permissions to read from
    // …\attachment-1.jpg, but you haven't granted it yet." That prompt is
    // nonsense to the user: THEY attached the file, in this turn, and Studio
    // itself wrote it there. Consent is already unambiguous, so pre-authorise
    // exactly the directory Studio created and nothing else. Turn-scoped and
    // torn down in the `finally` below, so this widens access to a directory
    // that only ever holds this turn's own attachments.
    ...(attachmentStaging?.dir ? ['--add-dir', attachmentStaging.dir] : []),
    // Project-declared MCP servers the user approved by name — how a project's
    // own design-system or Figma server reaches the agent without dropping
    // `--strict-mcp-config`. Empty unless explicitly approved; see
    // `projectMcpServers.ts` for why consent is required. Studio-registered
    // servers (added directly in Studio, never in the project's own
    // `.mcp.json`) are merged in too, resolved above. The value is a PATH to
    // a private 0600 temp file (`mcpConfigFile`, written above), never inline
    // JSON — see `claudeCliMcpConfigFile.ts` for why.
    ...(mcpConfigFile ? ['--mcp-config', mcpConfigFile.path] : []),
    // Turns a headless dead end into a question. Without it the CLI has no TTY
    // to prompt, so any tool needing permission is simply refused and the user
    // is told to grant something with no way to grant it. With it, the request
    // is relayed to the open chat as an Allow / Deny card. Only meaningful
    // alongside a written config file — the tool lives on Studio's own MCP
    // server, which is only reachable through that file.
    ...(mcpConfigFile ? ['--permission-prompt-tool', `mcp__studio__${PERMISSION_REQUEST_TOOL_NAME}`] : []),
    // Mandatory whether or not a connector was minted (WS-11 §4.0 trap #4) —
    // without it the CLI merges the user's own ~/.claude.json and the
    // project's .mcp.json and connects to whatever it finds there. Studio
    // ships exactly the toolset it intends and no more.
    '--strict-mcp-config',
    sessionFlag,
    sessionId,
  ]

  let sawTerminalEvent = false
  // Turn-scoped, never module-scoped — see `ClaudeCliTurnState`.
  const turnState = createClaudeCliTurnState()
  try {
    for await (const raw of spawnClaudeCliNdjson({
      argv,
      cwd,
      env,
      stdin: new TextEncoder().encode(prompt),
      signal: req.signal,
      spawn: options.spawn,
    })) {
      if (raw.kind === 'exit') {
        if (!sawTerminalEvent) {
          yield {
            type: 'error',
            message: claudeCliExitErrorMessage(raw.exitCode, raw.stderr, raw.timedOut),
          }
        }
        return
      }

      const line = parseClaudeCliLineValue(raw.value)
      if (!line) continue
      const { events, turnComplete } = translateClaudeCliLine(line, turnState)
      if (turnComplete) sawTerminalEvent = true
      for (const event of events) yield event
    }
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
    // The plaintext config file (session connector token, plus any resolved
    // MCP server secrets) is turn-scoped working data, same as the staged
    // attachments below — never left behind regardless of how the turn ended
    // (success, error, or the subprocess killed on abort). A leaked secret
    // file on disk is a worse outcome than the inline-argv bug this replaced,
    // so this runs unconditionally, in the same `finally` that already
    // guarantees attachment/connector cleanup across every exit path.
    if (mcpConfigFile) {
      cleanupMcpConfigFile(mcpConfigFile.dir)
    }
    // WS-12 §5.3 — staged attachments are turn-scoped working data, never
    // left behind regardless of how the turn ended (success, error, abort).
    if (attachmentStaging) {
      cleanupAttachments(attachmentStaging.dir)
    }
  }
}

// ---------------------------------------------------------------------------
// MCP config
// ---------------------------------------------------------------------------

/**
 * Verified config shape (confirmed both from `--help`'s `claude mcp add
 * --transport http ... --header "Authorization: Bearer ..."` example and the
 * coordinator's own probe): one HTTP MCP server, pointed at Studio's own
 * endpoint on this same running process, carrying the turn-scoped
 * connector's bearer token. `127.0.0.1` (not a public hostname) — this is a
 * subprocess of THIS server talking back to itself.
 *
 * Returns the plain object, NOT a JSON string — the caller
 * (`writeMcpConfigFile`, `claudeCliMcpConfigFile.ts`) serialises it straight
 * to a private 0600 temp file. This function used to `JSON.stringify` its
 * own return value for passing as inline `--mcp-config` argv, which put
 * every secret it carries (this token, plus any resolved project/registered
 * server secret) into the world-readable process command line — fixed by
 * moving the secret off argv entirely, never by changing what this function
 * assembles.
 */
function buildMcpConfig(
  connector: ClaudeCliSessionConnector,
  serverPort?: number,
  projectServers: Record<string, unknown> = {},
  registeredServers: Record<string, unknown> = {},
): unknown {
  const port = serverPort ?? readServerConfig().port
  return {
    mcpServers: {
      // Project-declared (`.mcp.json`) servers first, then Studio-registered
      // ones, then Studio's own entry LAST so it always wins a name
      // collision against either source. `listProjectMcpServers` and
      // `addRegisteredMcpServer` both already refuse an entry literally named
      // `studio` (`RESERVED_SERVER_NAME`); this ordering means even a future
      // gap in either guard still cannot let a project or a registered server
      // redirect Studio's own tool calls.
      ...projectServers,
      ...registeredServers,
      studio: {
        type: 'http',
        url: `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`,
        headers: { Authorization: `Bearer ${connector.token}` },
      },
    },
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

function claudeCliExitErrorMessage(exitCode: number | null, stderr: string, timedOut: boolean): string {
  // Reached only after the CLI has gone completely silent for the whole idle
  // window (see `idleTimeoutMs` in claudeCliSpawn.ts) — NOT because the turn
  // took a long time. Say which, so the next person reading it in a toast
  // doesn't go looking for a length limit that doesn't exist.
  if (timedOut) return 'Claude CLI stopped responding — no output for 10 minutes. The turn was ended.'
  const trimmedStderr = stderr.trim()
  // WS-11 §4.0: stderr is empty on every non-crash path, so anything present
  // here is a genuine crash — surface it verbatim (bounded by
  // `pumpCapped`'s cap already).
  if (trimmedStderr) return `Claude CLI crashed (exit ${exitCode ?? 'unknown'}): ${trimmedStderr}`
  return `Claude CLI exited (${exitCode ?? 'unknown'}) without a result. Run "claude auth status" to check you're logged in.`
}
