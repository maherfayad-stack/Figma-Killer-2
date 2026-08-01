/**
 * Claude CLI driver — a local subprocess, not an HTTP provider (WS-11).
 *
 * Studio's AgentPanel becomes a front-end over a local `claude` process,
 * exactly the way the Claude Code VS Code extension works: no API key, no
 * token Studio ever reads, subscription login (Pro/Max) works directly
 * because the CLI carries whatever login the user already has.
 *
 * ## The loop-ownership fork (WS-11 §4.1, step 1 scope note)
 *
 * Every other driver in this directory is a thin HTTP adapter: `runToolLoop`
 * (`http/toolLoop.ts`) owns the multi-turn agent loop, tool dispatch, and
 * retries, and the driver only translates one provider's wire format. This
 * driver does NOT use `runToolLoop` — the `claude` subprocess owns its own
 * agent loop internally. Turn structure, retries, and tool-permission prompts
 * are the CLI's, not `toolLoop.ts`'s. That is a genuine behavioural fork from
 * every other driver, not an oversight.
 *
 * **Step 1 (this file) ships with NO tools wired through.** `req.tools` is
 * accepted (the interface requires it) but never forwarded to the CLI — no
 * `--mcp-config` is passed, so the subprocess genuinely has zero tools of its
 * own either. Routing Studio's real toolset through `/_studio/mcp` (so a
 * `claude` turn can actually touch the canvas) is WS-11 step 3, deliberately
 * not built here — see `docs/features/agent.md`. A chat that streams text and
 * nothing else is step 1's whole proof: if `claude -p` streams a reply into
 * the AgentPanel using the user's own login, the premise holds.
 *
 * **Also deliberately out of step 1's scope**, both because nothing upstream
 * of this driver threads the information through yet:
 *   - No project `cwd`. `AiStreamRequest`/`ToolContextBase` carry no workspace
 *     path today, so this driver spawns inside the user's own Claude CLI
 *     config directory — guaranteed empty of any `CLAUDE.md`/`.claude/agents`,
 *     which doubles as avoiding WS-11 §4.0's cost trap (a real project's
 *     `CLAUDE.md` can cache-create tens of thousands of tokens per turn).
 *   - No multi-turn history replay. Every other driver replays the full
 *     `AiMessage[]` log each turn (no server-side session). This driver has
 *     no verified mechanism for that yet (no `--resume`/session-id wiring),
 *     so it sends only the latest user message's text as the `-p` prompt.
 *     A real multi-turn conversation is a later step.
 */

import type { AiAuthMode, AiContentBlock, AiProviderId, AiStreamEvent } from '../runtime/types'
import type { AiProvider, AiProviderCapabilities, AiProviderModel, AiStreamRequest } from './types'
import { minimalSubprocessEnv, type SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import {
  claudeCliPlatformSupport,
  ensureClaudeCliConfigDir,
  resolveClaudeCliDataRoot,
  type ClaudeCliPlatformSupport,
} from '../../handlers/studio/claudeCliEnv'
import { spawnClaudeCliNdjson, ClaudeCliSpawnError } from './claudeCliSpawn'
import { parseClaudeCliLineValue, translateClaudeCliLine } from './claudeCliEvents'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

/**
 * Conservative aliases the CLI's `--model` flag accepts (confirmed present
 * in `--help`; WS-11 §4.0 verified the flag shape, not a specific catalogue).
 * There is no verified "list models" command — the CLI is the source of
 * truth for what a given install supports, not `/v1/models` (no API key to
 * call that with) — so this is a static, explicitly-labelled fallback, the
 * same pattern Ollama's driver uses when it has no live catalogue.
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
    // Reported true so the chat handler's tool-calling gate
    // (`tools.length > 0 && !modelCapabilities.toolCalling` → 422) doesn't
    // block every turn — Claude models genuinely tool-call; step 1 simply
    // doesn't route Studio's tools to this driver yet (see file doc comment).
    toolCalling: true,
    // Conservative pending verification — WS-11 §4.0 didn't confirm image
    // input through `-p`, and step 1 sends no images either way.
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
 * tests can inject a fake spawn and platform-support result without a real
 * `claude` binary or a real subprocess — the `AiProvider` interface itself
 * has no room for test seams (every other driver's tests inject at the
 * `fetch` layer instead; this driver's equivalent boundary is `spawn`).
 */
export interface StreamClaudeCliOptions {
  /** Test seam — defaults to `Bun.spawn` via `claudeCliSpawn.ts`. */
  readonly spawn?: SubprocessSpawnFn
  /** Test seam — defaults to the real `process.platform` check. */
  readonly platformSupport?: ClaudeCliPlatformSupport
  /** Test seam — defaults to `resolveClaudeCliDataRoot()` (env-derived). */
  readonly dataRoot?: string
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

  const env = minimalSubprocessEnv([], {
    CLAUDE_CONFIG_DIR: configDir,
    ...(req.credentials.apiKey ? { CLAUDE_CODE_OAUTH_TOKEN: req.credentials.apiKey } : {}),
  })

  const argv = [
    'claude',
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    req.modelId,
    '--permission-mode',
    'default',
    // Mandatory (WS-11 §4.0 trap #4 — without it the CLI merges the user's
    // own ~/.claude.json and any project .mcp.json and connects to
    // whatever it finds there. Studio ships exactly the toolset it
    // intends — zero, in step 1 — and no more.
    '--strict-mcp-config',
  ]

  let sawTerminalEvent = false
  try {
    for await (const raw of spawnClaudeCliNdjson({
      argv,
      // No project workspace is threaded through yet (see file doc
      // comment) — spawn inside the user's own config dir, which is
      // guaranteed to hold no CLAUDE.md and so can never hit the cache-
      // creation cost trap WS-11 §4.0 warns about.
      cwd: configDir,
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
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly (step 1 — see file doc comment for what's intentionally
// not here yet: system prompt, multi-turn history, images, tools).
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
