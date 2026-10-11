/**
 * What the Anthropic driver needs to know about a model to ask it for the
 * right amount of work: how many output tokens it may write in one response,
 * and how its reasoning is switched on (P4-C, AI-11).
 *
 * ## Why per model
 *
 * The driver sent `max_tokens: 8192` to every model. A whole-screen
 * `studio_write_file` is a single tool call whose arguments ARE the file, and a
 * real screen plus its stylesheet passes 8 K tokens — the call was cut off
 * mid-argument and, because a `max_tokens` stop read as a normal stop, silently
 * dropped. Current Claude models allow 64 K (older ones less), and asking for
 * more than a model allows is a 400, so the number has to come from the model.
 *
 * `req.effort` (the composer's Effort control) was ignored by every HTTP
 * driver. It now maps onto the model's own reasoning control:
 *
 *   - `adaptive` (Claude 4.6 and later): `thinking: { type: 'adaptive' }` plus
 *     `output_config: { effort }` — the model decides how much to think, the
 *     effort level bounds it.
 *   - `budget` (Claude 3.7 through 4.5): `thinking: { type: 'enabled',
 *     budget_tokens }`, with the budget scaled from the effort level and kept
 *     under `max_tokens`.
 *   - `none` (older models): no reasoning parameters at all.
 *
 * Reasoning is only ever switched on by an effort the user CHOSE; an unset
 * effort sends none of it. And if a model refuses the parameters anyway (a
 * 400 naming them), the tool loop re-sends the round without them — so a
 * wrong guess here costs one round trip, never the turn.
 *
 * An id this parser cannot read gets the conservative profile the driver
 * always had (8 K, no reasoning): a model it does not know is not one to
 * guess limits for.
 */
import type { AiStreamRequest } from './types'

export type AnthropicReasoningStyle = 'adaptive' | 'budget' | 'none'

export interface AnthropicModelProfile {
  readonly maxOutputTokens: number
  readonly reasoning: AnthropicReasoningStyle
}

type Effort = NonNullable<AiStreamRequest['effort']>

const UNKNOWN_MODEL: AnthropicModelProfile = { maxOutputTokens: 8_192, reasoning: 'none' }

/**
 * `{ major, minor }` from an Anthropic model id, or `null`. Two naming schemes:
 * `claude-3-5-sonnet-20241022` (version first) and `claude-sonnet-4-5`,
 * `claude-opus-4-1-20250805`, `claude-sonnet-4-20250514` (family first; an
 * 8-digit tail is a date, not a minor version).
 */
function modelVersion(modelId: string): { family: string; major: number; minor: number } | null {
  const id = modelId.toLowerCase()
  const versionFirst = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)/.exec(id)
  if (versionFirst) return { family: versionFirst[3]!, major: Number(versionFirst[1]), minor: Number(versionFirst[2] ?? 0) }
  const familyFirst = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id)
  if (familyFirst) return { family: familyFirst[1]!, major: Number(familyFirst[2]), minor: Number(familyFirst[3] ?? 0) }
  return null
}

export function anthropicModelProfile(modelId: string): AnthropicModelProfile {
  const version = modelVersion(modelId)
  if (!version) return UNKNOWN_MODEL
  const { family, major, minor } = version
  const at = major * 10 + minor
  if (at < 35) return { maxOutputTokens: 4_096, reasoning: 'none' }
  if (at < 37) return { maxOutputTokens: 8_192, reasoning: 'none' }
  if (at === 37) return { maxOutputTokens: 64_000, reasoning: 'budget' }
  if (at < 45) return { maxOutputTokens: family === 'opus' ? 32_000 : 64_000, reasoning: 'budget' }
  if (at < 46) return { maxOutputTokens: 64_000, reasoning: 'budget' }
  return { maxOutputTokens: 64_000, reasoning: 'adaptive' }
}

/** Thinking budget per effort level, before it is fitted under `max_tokens`. */
const BUDGET_BY_EFFORT: Readonly<Record<Effort, number>> = {
  low: 4_000,
  medium: 10_000,
  high: 20_000,
  xhigh: 28_000,
  max: 32_000,
}

/** Output a thinking budget always leaves for the reply and its tool calls. */
const REPLY_HEADROOM_TOKENS = 16_000

/**
 * The request-body fields `effort` maps to for this model, or `{}` when it
 * maps to none (no effort chosen, or a model without reasoning).
 */
export function anthropicReasoningFields(profile: AnthropicModelProfile, effort: Effort | undefined): Record<string, unknown> {
  if (effort === undefined || profile.reasoning === 'none') return {}
  if (profile.reasoning === 'adaptive') {
    return { thinking: { type: 'adaptive' }, output_config: { effort } }
  }
  // `budget_tokens` has a floor of 1024 and must stay below `max_tokens`.
  const budget = Math.max(1_024, Math.min(BUDGET_BY_EFFORT[effort], profile.maxOutputTokens - REPLY_HEADROOM_TOKENS))
  return { thinking: { type: 'enabled', budget_tokens: budget } }
}
