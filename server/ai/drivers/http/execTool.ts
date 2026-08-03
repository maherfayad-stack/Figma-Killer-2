/**
 * Shared tool-execution body for the direct provider HTTP drivers.
 *
 * Both execution modes funnel through here:
 *   - `server`  — call the tool's `handler(input, ctx)` directly, in-process.
 *   - `browser` — forward to the browser via `bridge.callBrowser(...)` and
 *                 await the POST-back from /admin/api/ai/tool-result.
 *
 * Defence in depth: every raw tool input is re-validated against the
 * canonical TypeBox `inputSchema` before dispatch — the model's argument JSON
 * is untrusted no matter which provider produced it.
 */

import { parseValue, safeParseValue } from '@core/utils/typeboxHelpers'
import { AiToolOutputSchema } from '@core/ai'
import { toolAllowedForCapabilities } from '../../tools/capabilityGate'
import type {
  AiBrowserBridge,
  AiTool,
  AiToolOutput,
  ToolContext,
} from '../../runtime/types'
import type { ToolContextBase } from '../types'

/**
 * Execute one tool call and return the canonical `AiToolOutput`.
 *
 * Input, permission, and server-handler failures are ordinary tool outcomes:
 * the loop feeds `{ ok: false, error }` back to the model so it can recover.
 * A rejected browser bridge is different — no result can reach the active
 * turn, so that infrastructure failure propagates to the loop and terminates
 * the turn instead of inviting the model to retry against the same dead bridge.
 */
export async function executeAiTool(
  aiTool: AiTool,
  rawInput: unknown,
  bridge: AiBrowserBridge,
  signal: AbortSignal,
  toolContextBase: ToolContextBase,
): Promise<AiToolOutput> {
  let validated: unknown
  try {
    validated = parseValue(aiTool.inputSchema, rawInput)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid tool input.'
    return { ok: false, error: message }
  }

  // Defence in depth: `selectStudioTools` should never have offered a
  // tool the caller can't use, but re-check before dispatching to either
  // the server handler or the browser bridge anyway.
  if (!toolAllowedForCapabilities(aiTool, toolContextBase.capabilities)) {
    return { ok: false, error: `Tool ${aiTool.name} is not permitted for this user.` }
  }

  if (aiTool.execution === 'server') {
    if (!aiTool.handler) {
      return { ok: false, error: `Tool ${aiTool.name} declares execution='server' but has no handler.` }
    }
    try {
      const ctx: ToolContext = { ...toolContextBase, signal }
      const result = await aiTool.handler(validated, ctx)
      return normaliseToolOutput(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : `Tool ${aiTool.name} failed.`
      return { ok: false, error: message }
    }
  }

  // Browser execution: forward to the bridge and wait for the POST-back.
  // A resolved `{ ok: false }` remains a recoverable domain failure. Rejection
  // means the transport itself is unavailable and deliberately propagates.
  return await bridge.callBrowser(aiTool.name, validated)
}

/** The only properties the canonical envelope carries. Anything else marks a raw payload. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['ok', 'data', 'error', 'images'])

/**
 * Server-side handlers return their own raw payload. Wrap it in the canonical
 * `AiToolOutput` envelope so the model always sees a consistent `{ ok, data }`
 * shape, whether the tool ran server-side or in the browser.
 *
 * ## Why the key check, and not `safeParseValue` alone
 *
 * `AiToolOutputSchema` is an open TypeBox object — it does not set
 * `additionalProperties: false`. So a raw PAYLOAD that happens to carry its
 * own `ok` field, which most Studio tools return
 * (`{ ok: true, dir, path, content }` from `studio_read_file`, and the same
 * shape from `studio_list_tokens`, `studio_list_components`,
 * `studio_read_package_doc`, …), validated as a well-formed ENVELOPE and was
 * passed straight through with `data` left `undefined`.
 *
 * Nothing looked wrong on the chat path, which forwards the whole object to
 * the provider, extras and all. The MCP path reads `output.data` and falls
 * back to `{ ok: true }` when it is absent — so every one of those tools
 * answered an external MCP client with a bare `{"ok":true}` and no payload.
 * An agent asked to read `design-system.md` got a successful-looking result
 * containing nothing, repeatedly, with no error to explain it.
 *
 * A result is therefore only an envelope when EVERY key is an envelope key.
 * The `ok === false` clause is load-bearing and deliberate: a failure carrying
 * an extra diagnostic field must stay a failure. Without it, re-wrapping would
 * turn `{ ok: false, error, hint }` into `{ ok: true, data: { ok: false, … } }`
 * — silently converting an error into a success, which is far worse than the
 * dropped payload this function is fixing.
 */
export function normaliseToolOutput(result: unknown): AiToolOutput {
  // The handler's return is untyped (`unknown`). Validate against the canonical
  // envelope rather than duck-typing `'ok' in result` — a value like `{ ok: 3 }`
  // would pass the duck-type and then read as truthy-but-not-boolean downstream.
  const parsed = safeParseValue(AiToolOutputSchema, result)
  if (parsed.ok) {
    const keys = Object.keys(result as Record<string, unknown>)
    if (keys.every((key) => ENVELOPE_KEYS.has(key))) return parsed.value
    if (parsed.value.ok === false) return parsed.value
  }
  return { ok: true, data: result }
}
