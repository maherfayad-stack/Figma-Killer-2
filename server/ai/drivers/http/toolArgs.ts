/**
 * Shared tool-argument JSON parsing for all provider drivers.
 *
 * Models emit tool-call arguments as a JSON string. Every driver (Anthropic,
 * OpenAI/OpenRouter Responses, Ollama) funnels that string through this single
 * helper so the failure behaviour is identical across providers.
 *
 * On malformed JSON we return `{}` rather than the raw string. Downstream,
 * `execTool.ts` runs the result through `parseValue(aiTool.inputSchema, …)`:
 *   - for a schema with required fields, `{}` produces a clean TypeBox
 *     validation error that is reported back to the model (a far better signal
 *     than a type error on a raw string), so the model can retry;
 *   - for an all-optional schema, `{}` validates and the tool runs with
 *     defaults — the only sane interpretation of "no usable arguments".
 *
 * Previously each driver had its own copy with divergent catch behaviour
 * (`{}` vs. the raw string), so the same model error produced different
 * outcomes per provider. This is the one source of truth.
 */
export function parseToolArguments(json: string): unknown {
  const parsed = toolArgumentsParse(json)
  return parsed.ok ? parsed.value : {}
}

/**
 * The same parse, telling a clean result from a failure — for the one caller
 * that must know the difference: a tool call whose argument string does not
 * parse after an output-limit stop was cut off mid-argument, and must not run
 * on `{}` (AI-11, `toolLoop.ts`). An empty string is `{}` here too, as above.
 */
export function toolArgumentsParse(json: string): { ok: true; value: unknown } | { ok: false } {
  if (!json.trim()) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(json) }
  } catch {
    return { ok: false }
  }
}
