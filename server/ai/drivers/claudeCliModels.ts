/**
 * Claude CLI driver — the static model catalogue and the capability report.
 *
 * Split out of `claudeCli.ts`: this is the one part of the driver that has
 * nothing to do with running a turn. It is pure data plus one pure function,
 * and it changes for its own reason (Anthropic ships a new model alias, or a
 * capability the driver mediates changes shape) rather than for any of the
 * reasons the turn machinery changes.
 */

import type { AiProviderCapabilities, AiProviderModel } from './types'

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
export const CLAUDE_CLI_FALLBACK_MODELS: AiProviderModel[] = [
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

export function claudeCliCapabilities(): AiProviderCapabilities {
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
