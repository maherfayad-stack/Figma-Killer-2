/**
 * A subagent's usage, billed to the conversation that delegated it (AI-23).
 *
 * Priced as the subagent's OWN model — a Sonnet child priced at the parent's
 * Opus rate would overstate the turn, and the other way round would hide it —
 * and added to the conversation's totals, which the list view and the turn's
 * audit row read. No message row claims it (`addConversationUsageTotals`).
 */
import type { DbClient } from '../../db/client'
import type { AiProviderId } from '../runtime/types'
import { resolveCostUsd } from '../pricing'
import { addConversationUsageTotals } from '../conversations/store'
import type { DelegateUsage } from './delegateRunner'

export async function recordDelegatedUsage(
  db: DbClient,
  conversationId: string,
  providerId: AiProviderId,
  usage: DelegateUsage,
  modelId: string,
): Promise<void> {
  const costUsd = usage.costUsd ?? await resolveCostUsd(db, providerId, modelId, {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
  })
  await addConversationUsageTotals(db, conversationId, {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUsd,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
  })
}
