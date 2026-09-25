/**
 * Binds history compaction (`conversations/compaction.ts`, AI-18) to a chat
 * turn: which credential may pay for the summary, and how big the window is.
 *
 * The summary is written by `claude-haiku-4-5-20251001` through the Anthropic
 * HTTP driver, with the TURN's own credential — so it only ever runs when that
 * credential is an Anthropic API key. Every other provider (and the `claude`
 * CLI, which compacts its own session) gets its history back untouched: no
 * key is borrowed from another credential, and nothing fails.
 *
 * Lives beside `studioHttpTurn.ts` rather than inside `handlers/chat.ts` for
 * the same reason: it never touches a `Request`.
 */
import type { DbClient } from '../db/client'
import type { AiMessage } from './runtime/types'
import type { AiResolvedCredential, ToolContextBase } from './drivers/types'
import { resolveDriver } from './drivers'
import { runOneShotCompletion } from './oneShot'
import { getModelCatalogue, pricingKey } from './pricing'
import {
  COMPACTION_INSTRUCTIONS,
  COMPACTION_MODEL_ID,
  DEFAULT_CONTEXT_WINDOW,
  compactHistory,
} from './conversations/compaction'

export interface TurnHistoryCompaction {
  readonly db: DbClient
  readonly conversationId: string
  readonly modelId: string
  readonly credentials: AiResolvedCredential
  readonly messages: AiMessage[]
  readonly toolContextBase: ToolContextBase
  readonly signal: AbortSignal
}

/** The history this turn replays — compacted when an Anthropic key can pay for it and it is needed, else as it was. */
export async function compactHistoryForTurn(turn: TurnHistoryCompaction): Promise<AiMessage[]> {
  if (turn.credentials.providerId !== 'anthropic' || !turn.credentials.apiKey) return turn.messages
  let contextWindow = DEFAULT_CONTEXT_WINDOW
  try {
    contextWindow = (await getModelCatalogue(turn.db)).get(pricingKey(turn.modelId))?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  } catch (err) {
    console.error('[ai/compaction] no context window for this model — assuming the default:', err)
  }
  return compactHistory({
    conversationId: turn.conversationId,
    messages: turn.messages,
    contextWindow,
    summarize: (transcript) =>
      runOneShotCompletion({
        driver: resolveDriver('anthropic'),
        credentials: turn.credentials,
        modelId: COMPACTION_MODEL_ID,
        instructions: COMPACTION_INSTRUCTIONS,
        userMessage: transcript,
        signal: turn.signal,
        toolContextBase: turn.toolContextBase,
      }),
  })
}
