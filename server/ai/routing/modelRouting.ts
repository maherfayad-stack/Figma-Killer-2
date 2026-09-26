/**
 * Model routing — which model ONE turn (or one subagent, or one utility call)
 * runs on, from one table (AI-25).
 *
 * ## The table
 *
 * {@link MODEL_ROUTING_TABLE} is the single place a model id is assigned to a
 * job. The assignments are the owner's (ROADMAP P4-G, 2026-09-23 audit 06 §4):
 * `claude-opus-5-5` for build and creative turns, `claude-sonnet-5` for small
 * edits, questions and subagents, `claude-haiku-4-5-20251001` for utility calls
 * (history compaction today). Everything that picks a model by job reads it:
 * the chat turn (`chatTurnModel.ts`), `studio_delegate`'s subagents, and
 * compaction (`conversations/compaction.ts`).
 *
 * **The assignments are not yet measured.** `claude-fable-5-1` has no role
 * until `bun run bench:agent-models` has run it against the creative and match
 * briefs ({@link MODEL_BENCH_CANDIDATES}); the same run is what confirms or
 * changes the three assignments above. The per-turn telemetry that bench and
 * the owner read is `handlers/studio/agentTurnLog.ts`'s turn summaries.
 *
 * ## Three rules, each one inherited from `turnRouting.ts`
 *
 * 1. **A chosen model is never overridden.** Routing needs to know WHY a
 *    conversation carries its model id: `ai_conversations.model_source`
 *    (migration 024) says `default` (Studio's default, never picked) or
 *    `chosen` (the user picked it in the model picker). Only `default` is
 *    routed. A row from before the column existed reads as `chosen`.
 * 2. **Routing only ever spends less.** A turn never runs on a model of a
 *    higher tier than the conversation's own: with Sonnet as the default, a
 *    build turn stays on Sonnet rather than being moved up to Opus. Tiers are
 *    read off the id (`opus` > `sonnet` > `haiku`); an id with no known tier
 *    is never routed away from, and never routed to.
 * 3. **Only to a model the key can use.** The target must be in the
 *    credential's live model list; otherwise the turn keeps its own model.
 *
 * ## Which providers
 *
 * The Anthropic API-key provider only. The ids are Anthropic's, and the
 * `claude` CLI is deliberately left alone: its catalogue is three static
 * aliases, so an id cannot be checked before the spawn, and its warm session
 * is keyed to one model — routing per turn would cold-start the process the
 * warm pool exists to keep (`claudeCliSessionPool.ts`). A CLI turn still
 * records its model, role and outcome in the telemetry, so the bench can
 * measure both paths.
 *
 * Pure: no I/O, no clock. `modelRouting.test.ts` covers the table.
 */
import type { AiProviderId } from '../runtime/types'
import type { TurnShape } from './turnRouting'

/** The jobs a model is assigned to. */
export type ModelRole = 'build' | 'creative' | 'smallEdit' | 'question' | 'subagent' | 'utility'

export const MODEL_ROUTING_TABLE: Readonly<Record<ModelRole, string>> = {
  build: 'claude-opus-5-5',
  creative: 'claude-opus-5-5',
  smallEdit: 'claude-sonnet-5',
  question: 'claude-sonnet-5',
  subagent: 'claude-sonnet-5',
  utility: 'claude-haiku-4-5-20251001',
}

/**
 * Every model `bench:agent-models` runs, in order. `claude-fable-5-1` is here
 * and in no role: it gets one only after a measured run says where it fits.
 */
export const MODEL_BENCH_CANDIDATES: readonly string[] = [
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
]

/** Providers whose turns are routed. See the module doc for why the CLI is not one. */
const ROUTED_PROVIDERS: ReadonlySet<AiProviderId> = new Set<AiProviderId>(['anthropic'])

/** How a conversation's model id was set. `chosen` is anything the user picked. */
export type ModelSource = 'default' | 'chosen'

/** A model family's rank, cheapest first. `null`: not a family routing knows. */
export function modelTier(modelId: string): 1 | 2 | 3 | null {
  const id = modelId.toLowerCase()
  if (id.includes('opus')) return 3
  if (id.includes('sonnet')) return 2
  if (id.includes('haiku')) return 1
  return null
}

/** The role a chat turn plays, from its classified shape. A build with no design to match is creative work. */
export function roleForTurn(shape: TurnShape, fidelityMode: string | undefined): ModelRole {
  if (shape === 'build') return fidelityMode === 'creative' ? 'creative' : 'build'
  return shape
}

export interface ModelRoute {
  /** The model this call runs on. */
  readonly modelId: string
  /** `pinned`: the user's choice, used verbatim. `routed`: moved by the table. `default`: the conversation's own model, routing made no change. */
  readonly mode: 'pinned' | 'routed' | 'default'
  readonly role: ModelRole
  /** One sentence, shown to the user. */
  readonly reason: string
}

export interface RouteModelInput {
  readonly providerId: AiProviderId
  /** The conversation's own model id (`ai_conversations.model_id`). */
  readonly modelId: string
  readonly modelSource: ModelSource
  readonly role: ModelRole
  /** The ids the credential can use, or `null` when the list is unknown (then nothing is routed). */
  readonly availableModelIds: ReadonlySet<string> | null
}

/** Pick the model for one call. Pure. See the module doc for the three rules. */
export function routeModel(input: RouteModelInput): ModelRoute {
  const { providerId, modelId, modelSource, role, availableModelIds } = input
  const keep = (reason: string): ModelRoute => ({ modelId, mode: 'default', role, reason })

  if (modelSource === 'chosen') {
    return { modelId, mode: 'pinned', role, reason: `${modelId} was picked for this conversation, so every turn runs on it.` }
  }
  if (!ROUTED_PROVIDERS.has(providerId)) return keep('Model routing applies to the Anthropic API-key provider only.')

  const target = MODEL_ROUTING_TABLE[role]
  if (target === modelId) return keep(`${modelId} is the model for this kind of turn.`)
  const fromTier = modelTier(modelId)
  const toTier = modelTier(target)
  if (fromTier === null || toTier === null) return keep(`Routing does not know the tier of ${fromTier === null ? modelId : target}, so the conversation's model is kept.`)
  if (toTier > fromTier) return keep(`The default model is ${modelId}; routing never moves a turn up to a larger model.`)
  if (availableModelIds === null || !availableModelIds.has(target)) {
    return keep(`${target} is not in this key's model list, so the conversation's model is kept.`)
  }
  return { modelId: target, mode: 'routed', role, reason: `${ROLE_LABEL[role]} runs on ${target}; the conversation default is ${modelId}.` }
}

const ROLE_LABEL: Readonly<Record<ModelRole, string>> = {
  build: 'A build turn',
  creative: 'A creative build turn',
  smallEdit: 'A small edit',
  question: 'A question',
  subagent: 'A subagent',
  utility: 'A utility call',
}
