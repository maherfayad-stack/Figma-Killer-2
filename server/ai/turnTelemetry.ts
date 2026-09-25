/**
 * One turn's telemetry — the `kind: 'turn'` line `agentTurnLog.ts` stores in
 * the project's `.studio/agent-turns.jsonl` (AI-25).
 *
 * Model routing is only as good as the measurement behind it. The per-tool
 * lines already said where Studio's own time went; nothing recorded which
 * MODEL a turn ran on, what kind of turn it was, what it cost, or how it
 * ended — so "Sonnet is good enough for small edits" could only ever be an
 * opinion. This records exactly those numbers, for every turn with a project
 * open, on both agent paths, and `bench:agent-turn` reads them back per
 * (role, model).
 *
 * Numbers only: no prompt, no reply, no file content (`agentTurnLog.ts`'s
 * "what is never written here").
 */
import type { AiProviderId, AiStreamEvent } from './runtime/types'
import type { ModelRoute } from './routing/modelRouting'
import type { FidelityMode } from '../handlers/studio/fidelityMode'
import { appendAgentTurnSummary } from '../handlers/studio/agentTurnLog'

export interface TurnTelemetry {
  /** Feed every event the turn emits. */
  observe(event: AiStreamEvent): void
  /** Record the turn. A no-op with no project open. Never throws. */
  finish(result: { promptTokens: number; completionTokens: number; aborted: boolean }): void
}

export function createTurnTelemetry(params: {
  /** The validated open project, or `null` (nothing is recorded). */
  readonly dir: string | null
  readonly conversationId: string
  readonly providerId: AiProviderId
  readonly conversationModelId: string
  readonly route: ModelRoute
  readonly fidelityMode?: FidelityMode
  /** Test seam. */
  readonly now?: () => number
}): TurnTelemetry {
  const now = params.now ?? Date.now
  const startedAt = now()
  let rounds = 0
  let toolCalls = 0
  let errored = false
  return {
    observe(event) {
      if (event.type === 'context') rounds += 1
      else if (event.type === 'toolResult') toolCalls += 1
      else if (event.type === 'error') errored = true
    },
    finish({ promptTokens, completionTokens, aborted }) {
      if (!params.dir) return
      appendAgentTurnSummary(params.dir, {
        kind: 'turn',
        at: now(),
        conversationId: params.conversationId,
        provider: params.providerId,
        model: params.route.modelId,
        conversationModel: params.conversationModelId,
        modelMode: params.route.mode,
        role: params.route.role,
        durationMs: Math.max(0, now() - startedAt),
        rounds,
        toolCalls,
        promptTokens,
        completionTokens,
        outcome: aborted ? 'aborted' : errored ? 'error' : 'ok',
        ...(params.fidelityMode ? { fidelityMode: params.fidelityMode } : {}),
      })
    },
  }
}
