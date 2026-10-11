/**
 * `req.effort` (the composer's Effort control) on the OpenAI-shaped wires:
 * Responses' `reasoning.effort` and chat/completions' `reasoning_effort`
 * (P4-C, AI-11). Every HTTP driver used to ignore the control.
 *
 * OpenAI's own scale tops out at `high` on most reasoning models, so Studio's
 * `xhigh` and `max` ask for the most the provider reliably accepts. A model
 * that takes no reasoning parameter at all refuses the request with a 400,
 * and the tool loop re-sends the round without it — a wrong guess costs one
 * round trip, never the turn.
 */
import type { AiStreamRequest } from './types'

export function openAiReasoningEffort(effort: NonNullable<AiStreamRequest['effort']>): 'low' | 'medium' | 'high' {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort
}
