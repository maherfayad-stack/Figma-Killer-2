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
 * the Studio conversation id (`claudeCliSession.ts`) — no new DB column,
 * because the same id always hashes to the same UUID. `req.messages` is
 * still only consulted for the LATEST user message text (the `-p` prompt);
 * the CLI's own session file is what remembers the rest, not a replayed
 * `AiMessage[]` log the way every HTTP driver in this directory does it.
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
import { createClaudeCliTurnState, parseClaudeCliLineValue, translateClaudeCliLine } from './claudeCliEvents'
import { claudeCliSessionId, isFirstClaudeCliTurn } from './claudeCliSession'
import {
  mintClaudeCliSessionConnector,
  revokeClaudeCliSessionConnector,
  type ClaudeCliSessionConnector,
} from '../mcp/sessionConnector'
// Imported from the small, SDK-free `endpointPath.ts` module directly — NOT
// the `../mcp` barrel, which also re-exports `handleMcpHttp` and would pull
// `@modelcontextprotocol/sdk` into this driver's module graph transitively.
import { MCP_ENDPOINT_PATH } from '../mcp/endpointPath'
import { readServerConfig } from '../../config'
import { generateStudioAgentRoster } from '../../handlers/studio/agentRoster'
import { stageAttachments, cleanupAttachments, describeAttachmentsForPrompt } from './claudeCliAttachments'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

/** `--effort` is a real, user-requested requirement (WS-12 §5.1), request-driven from `req.effort` with this as the fallback — 'medium' matches the CLI's own implied default weighting (mid-scale of the five confirmed levels). */
const DEFAULT_EFFORT = 'medium'

/** `--permission-mode` fallback when the request names none. Never itself a bypass value. */
const DEFAULT_PERMISSION_MODE = 'default'

/**
 * `--permission-mode` accepts exactly WS-12 §5.2's four modes (plus
 * `auto`/`dontAsk`, confirmed via `--help` but not part of the user-facing
 * four) — a 1:1 mapping, no translation layer.
 *
 * **`bypassPermissions` is allowed, but ONLY as an explicit per-turn user
 * choice — never a default, never inferred, never persisted.** An earlier
 * version of this function refused it outright, reading this driver's "never
 * pass a permission-bypassing flag" hard rule as covering any occurrence of
 * the literal value. The coordinator who set that rule resolved the
 * contradiction directly: the rule means *Studio must never inject a
 * bypassing flag on its own* — no silent default, no working around a
 * prompt the user would otherwise see. It does not mean refusing a mode the
 * user deliberately selected; a user choosing Bypass IS the consent, not
 * something bypassing it. WS-12 §5.2 (and the user's own words specifying
 * this feature — "the mode is it auto, bypass, or ask before edits or just
 * plan") name Bypass as one of exactly four modes the user controls.
 *
 * What stays permanently forbidden, unconditionally: `--dangerously-skip-
 * permissions` / `--allow-dangerously-skip-permissions` — a different,
 * blunter flag this driver's argv never constructs anywhere, checked or not.
 * `--permission-mode bypassPermissions` is the CLI's own documented mode,
 * distinct from that flag, and is the one this function resolves.
 *
 * The three D5 §11.5 guard rails on Bypass are enforced OUTSIDE this
 * function, each independently:
 *   1. Non-persisting — `agentSlice.ts` initializes `agentPermissionMode:
 *      'default'` at store creation (covers reload) and nothing anywhere
 *      reads it from storage; `AgentSessionControls.tsx` also resets it on
 *      a live project switch (no remount needed).
 *   2. Visibly indicated — `AgentSessionControls.tsx`'s composer trigger
 *      switches to `tone="danger"` with a warning icon, and stays that way
 *      the entire time `agentPermissionMode === 'bypassPermissions'`. The
 *      indication is permanent and non-dismissible, not a one-time toast;
 *      it lives on the control that sets the mode rather than in a separate
 *      banner, so it cannot drift out of sync with the actual state.
 *   3. Still trust-tier-bound — Bypass has NO effect on tool-level
 *      authorization at all. `studio_install_deps`'s trust check
 *      (`projectTools.ts`) reads only `.studio/meta.json`'s own `trust`
 *      field; it has no parameter for permission mode to influence, tested
 *      explicitly in `projectTools.test.ts`.
 */
function resolvePermissionMode(
  requested: string | undefined,
): { ok: true; mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' } | { ok: false; message: string } {
  const mode = requested ?? DEFAULT_PERMISSION_MODE
  if (mode !== 'default' && mode !== 'acceptEdits' && mode !== 'plan' && mode !== 'bypassPermissions') {
    return { ok: false, message: `Unknown permission mode "${mode}".` }
  }
  return { ok: true, mode }
}

function resolveEffort(requested: string | undefined): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (requested === 'low' || requested === 'medium' || requested === 'high' || requested === 'xhigh' || requested === 'max') {
    return requested
  }
  return DEFAULT_EFFORT
}

/**
 * Belt-and-braces: `bypassPermissions` may only ever reach argv when
 * `req.permissionMode` itself carried that exact literal — i.e. a user
 * selected it THIS turn. `default` is what every other path (no selection,
 * an unrecognised value already refused above, a stale/reset session)
 * resolves to, so this assertion is really "the resolved mode came from the
 * request, not from a default" — cheap to state, cheap to keep true.
 */
function assertBypassOnlyFromExplicitRequest(
  mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
  requestedMode: string | undefined,
): string {
  if (mode === 'bypassPermissions' && requestedMode !== 'bypassPermissions') {
    throw new Error('[ai/claudeCli] refused to construct --permission-mode bypassPermissions without an explicit per-turn request — this must never be a default or inferred value.')
  }
  return mode
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
  /** Test seam — defaults to `generateStudioAgentRoster` (WS-12 §7). */
  readonly generateRoster?: typeof generateStudioAgentRoster
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
      message: 'Claude CLI credentials must be apiKey-shaped. Re-create the credential in /admin/ai/providers.',
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

  // Checked before anything else spawns — a refused mode must never reach
  // argv assembly, let alone a real subprocess.
  const resolvedMode = resolvePermissionMode(req.permissionMode)
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

  // The real workspace root when one is open and passes containment; the
  // per-user config dir (guaranteed CLAUDE.md-free) otherwise. See the file
  // doc comment's "workspace cwd" section for why this distinction matters.
  const workspaceCwd = resolveClaudeCliWorkspaceCwd(req.workspaceDir, options.projectsRoot)
  const cwd = workspaceCwd ?? configDir

  // Subagent roster (WS-12 §7) — "written beside the MCP config": regenerated
  // on every real turn against an open project, right alongside the MCP
  // config below. Best-effort — a probe failure degrades this turn to "no
  // subagents", never blocks the chat itself. Never attempted for the
  // config-dir fallback (no real project to profile there).
  const generateRoster = options.generateRoster ?? generateStudioAgentRoster
  if (workspaceCwd) {
    try {
      generateRoster(workspaceCwd)
    } catch (err) {
      console.error('[ai/claudeCli] failed to generate the subagent roster — continuing without one:', err)
    }
  }

  const env = minimalSubprocessEnv([], {
    CLAUDE_CONFIG_DIR: configDir,
    ...(req.credentials.apiKey ? { CLAUDE_CODE_OAUTH_TOKEN: req.credentials.apiKey } : {}),
  })

  const mint = options.mintConnector ?? mintClaudeCliSessionConnector
  const revoke = options.revokeConnector ?? revokeClaudeCliSessionConnector
  let connector: ClaudeCliSessionConnector | null = null
  try {
    connector = await mint(
      req.toolContextBase.db,
      req.toolContextBase.userId,
      req.toolContextBase.capabilities,
      req.toolContextBase.conversationId,
    )
  } catch (err) {
    // Fail soft: a turn without tools is degraded, not broken. Blocking the
    // entire chat over a transient connector-store hiccup would be worse
    // than a turn that can only talk, same as step 1 shipped with by design.
    console.error('[ai/claudeCli] failed to mint a session MCP connector — continuing without tools:', err)
  }

  const sessionId = await claudeCliSessionId(req.toolContextBase.conversationId)
  const sessionFlag = isFirstClaudeCliTurn(req.messages.length) ? '--session-id' : '--resume'

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
    ...(connector ? ['--mcp-config', buildMcpConfigJson(connector, options.serverPort)] : []),
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
    // The token is scoped to THIS turn — expire it with the turn, not the
    // 1-day TTL floor. Never reuse a long-lived connector token.
    if (connector) {
      await revoke(req.toolContextBase.db, connector.connectorId, req.toolContextBase.userId)
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
 * coordinator's own probe): an inline JSON string naming one HTTP MCP server,
 * pointed at Studio's own endpoint on this same running process, carrying the
 * turn-scoped connector's bearer token. `127.0.0.1` (not a public hostname) —
 * this is a subprocess of THIS server talking back to itself.
 */
function buildMcpConfigJson(connector: ClaudeCliSessionConnector, serverPort?: number): string {
  const port = serverPort ?? readServerConfig().port
  return JSON.stringify({
    mcpServers: {
      studio: {
        type: 'http',
        url: `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`,
        headers: { Authorization: `Bearer ${connector.token}` },
      },
    },
  })
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
  if (timedOut) return 'Claude CLI timed out before producing a reply.'
  const trimmedStderr = stderr.trim()
  // WS-11 §4.0: stderr is empty on every non-crash path, so anything present
  // here is a genuine crash — surface it verbatim (bounded by
  // `pumpCapped`'s cap already).
  if (trimmedStderr) return `Claude CLI crashed (exit ${exitCode ?? 'unknown'}): ${trimmedStderr}`
  return `Claude CLI exited (${exitCode ?? 'unknown'}) without a result. Run "claude auth status" to check you're logged in.`
}
