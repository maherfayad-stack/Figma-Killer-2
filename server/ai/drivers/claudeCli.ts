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
import type { AiProvider, AiProviderCapabilities, AiProviderModel, AiStreamRequest } from './types'
import { minimalSubprocessEnv, type SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import {
  claudeCliPlatformSupport,
  ensureClaudeCliConfigDir,
  resolveClaudeCliDataRoot,
  resolveClaudeCliWorkspaceCwd,
  type ClaudeCliPlatformSupport,
} from '../../handlers/studio/claudeCliEnv'
import { spawnClaudeCliNdjson, ClaudeCliSpawnError } from './claudeCliSpawn'
import { parseClaudeCliLineValue, translateClaudeCliLine } from './claudeCliEvents'
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

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

/**
 * No session-controls UI exists yet (WS-12 §5.2 owns that). `--effort` is a
 * real, user-requested requirement (not a nicety), so it ships wired with a
 * fixed default rather than waiting for the picker — 'medium' matches the
 * CLI's own implied default weighting (it sits mid-scale of the five
 * confirmed levels: low, medium, high, xhigh, max).
 */
const DEFAULT_EFFORT = 'medium'

/**
 * No session-controls UI exists yet either. `--permission-mode` accepts
 * exactly WS-12 §5.2's four modes plus `auto`/`dontAsk` (confirmed via
 * `--help`), so the mapping is 1:1 with no translation layer whenever that
 * UI ships. `'default'` is the only value used here — never a bypass mode
 * (`bypassPermissions`/`--dangerously-skip-permissions`), per the explicit
 * constraint that this driver must never pass one. Whether `'default'`
 * silently denies (rather than hangs) an MCP tool call in `-p` mode is not
 * yet verified against a real paid turn; if a future dogfood session finds
 * tool calls being denied outright, `'acceptEdits'` is the next thing to try
 * — still not a bypass, just an auto-accept posture for edit-shaped changes.
 */
const DEFAULT_PERMISSION_MODE = 'default'

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
    // Conservative pending verification — image input through `-p` was never
    // confirmed against the binary, and this driver sends no images either way.
    visionInput: false,
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

  const prompt = latestUserPromptText(req.messages)
  if (!prompt) {
    yield { type: 'error', message: 'No user message to send to the Claude CLI.' }
    return
  }

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
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    req.modelId,
    '--effort',
    DEFAULT_EFFORT,
    '--permission-mode',
    DEFAULT_PERMISSION_MODE,
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
  try {
    for await (const raw of spawnClaudeCliNdjson({
      argv,
      cwd,
      env,
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
      const { events, turnComplete } = translateClaudeCliLine(line)
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
