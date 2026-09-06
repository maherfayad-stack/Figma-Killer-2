/**
 * What goes on the `claude` command line, and the MCP config file it points
 * at — assembled in one place because a cold turn and a warm session must
 * differ in EXACTLY one flag (`--input-format`) and nothing else.
 *
 * When the two paths built their own argv arrays, "the warm session behaves
 * like a cold turn" was a claim nobody could check. Here it is a property of
 * the code: one function, one options object, one documented difference.
 *
 * Every individual flag's reasoning lives with the field that controls it
 * below; `claudeCli.ts`'s module doc covers the ones that need whole
 * paragraphs (`--strict-mcp-config`, `--tools`, the system-prompt split).
 */

import { MCP_ENDPOINT_PATH } from '../mcp/endpointPath'
import { PERMISSION_REQUEST_TOOL_NAME } from '../mcp/permissionGate'
import type { ClaudeCliSessionConnector } from '../mcp/sessionConnector'
import { readServerConfig } from '../../config'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../runtime/types'

export interface ClaudeCliArgvOptions {
  readonly modelId: string
  readonly effort: string
  readonly permissionMode: string
  /** `resolveNativeToolAllowlist`'s answer — a hard ceiling on native built-ins. */
  readonly nativeTools: string
  /** Directories outside `cwd` the CLI is pre-authorised to read (staged attachments). */
  readonly addDirs: readonly string[]
  /** Path to the private 0600 MCP config file, or `null` when none could be written (the turn runs without tools). */
  readonly mcpConfigPath: string | null
  /** The dynamic half of Studio's system prompt, already extracted. `null` when there is none to send. */
  readonly systemPromptSuffix: string | null
  /** `--session-id` to establish a new CLI session, `--resume` to continue one. */
  readonly sessionFlag: '--session-id' | '--resume'
  readonly sessionId: string
  /**
   * The ONE difference between a cold turn and a warm session.
   *
   * `'text'` — the prompt is the raw bytes on stdin, the process answers once
   * and exits. `'stream-json'` — stdin is an NDJSON channel that stays open
   * for many turns (`claudeCliStdinProtocol.ts`). Everything else about the
   * invocation is identical, deliberately.
   */
  readonly inputFormat: 'text' | 'stream-json'
}

export function buildClaudeCliArgv(options: ClaudeCliArgvOptions): string[] {
  return [
    'claude',
    // `-p` with NO positional prompt: the prompt is piped on stdin instead.
    // Mandatory on Windows — see `ClaudeCliSpawnOptions.stdin`.
    '-p',
    '--input-format',
    options.inputFormat,
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
    options.modelId,
    '--effort',
    options.effort,
    '--permission-mode',
    options.permissionMode,
    // sec-XX (see `claudeCli.ts`, "Native tool surface").
    '--tools',
    options.nativeTools,
    // Attachments are staged OUTSIDE the workspace cwd, so the CLI's own
    // path-based permission check would otherwise stop to ask before reading
    // them — "Claude requested permissions to read from …\attachment-1.jpg,
    // but you haven't granted it yet." That prompt is nonsense to the user:
    // THEY attached the file and Studio itself wrote it there. Consent is
    // already unambiguous, so pre-authorise exactly the directory Studio
    // created and nothing else.
    ...options.addDirs.flatMap((dir) => ['--add-dir', dir]),
    // Project-declared and Studio-registered MCP servers the user approved by
    // name, plus Studio's own entry. The value is a PATH to a private 0600
    // temp file, never inline JSON — see `claudeCliMcpConfigFile.ts` for why
    // (argv is world-readable via `ps -eo command`).
    ...(options.mcpConfigPath ? ['--mcp-config', options.mcpConfigPath] : []),
    // Turns a headless dead end into a question. Without it the CLI has no TTY
    // to prompt, so any tool needing permission is simply refused and the user
    // is told to grant something with no way to grant it. With it, the request
    // is relayed to the open chat as an Allow / Deny card. Only meaningful
    // alongside a written config file — the tool lives on Studio's own MCP
    // server, which is only reachable through that file.
    ...(options.mcpConfigPath ? ['--permission-prompt-tool', `mcp__studio__${PERMISSION_REQUEST_TOOL_NAME}`] : []),
    // Mandatory whether or not a connector was minted (WS-11 §4.0 trap #4) —
    // without it the CLI merges the user's own ~/.claude.json and the
    // project's .mcp.json and connects to whatever it finds there. Studio
    // ships exactly the toolset it intends and no more.
    '--strict-mcp-config',
    ...(options.systemPromptSuffix ? ['--append-system-prompt', options.systemPromptSuffix] : []),
    options.sessionFlag,
    options.sessionId,
  ]
}

/**
 * Verified config shape (confirmed both from `--help`'s `claude mcp add
 * --transport http ... --header "Authorization: Bearer ..."` example and the
 * coordinator's own probe): one HTTP MCP server, pointed at Studio's own
 * endpoint on this same running process, carrying the connector's bearer
 * token. `127.0.0.1` (not a public hostname) — this is a subprocess of THIS
 * server talking back to itself.
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
export function buildMcpConfig(
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

/**
 * The dynamic half of `systemPrompt`, or `null` when there is none worth
 * sending (no boundary marker found, or the suffix is empty/whitespace — the
 * "project profile unavailable" degrade in `buildStudioAgentSystemPrompt` is
 * still real text, so this only skips a GENUINELY empty suffix, never that
 * fallback message).
 *
 * `systemPrompt` is `[staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
 * dynamicSuffix]` for every REAL Studio-project turn
 * (`buildStudioAgentSystemPrompt`'s own contract) — this driver only asks for
 * the suffix when `workspaceCwd` is set, which is exactly when the caller
 * (`chat.ts` via `buildStudioProjectSystemPrompt`) built it that way, so the
 * boundary marker is always expected to be present in practice; a missing
 * marker degrades to `null` rather than guessing.
 */
export function dynamicSystemPromptSuffix(systemPrompt: readonly string[]): string | null {
  const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (boundaryIndex === -1) return null
  const suffix = systemPrompt.slice(boundaryIndex + 1).join('\n\n').trim()
  return suffix.length > 0 ? suffix : null
}
