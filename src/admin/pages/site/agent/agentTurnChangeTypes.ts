/**
 * The shapes of AI-7's "what did this turn change" — a dependency-free leaf,
 * so the slice's type file and the module that fetches them can both import
 * them without importing each other. See `agentTurnChanges.ts`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

const TurnFileSchema = Type.Object({
  path: Type.String(),
  change: Type.Union([Type.Literal('created'), Type.Literal('modified')]),
  state: Type.Union([Type.Literal('current'), Type.Literal('changed-since'), Type.Literal('reverted')]),
  revertable: Type.Boolean(),
  reason: Type.Union([Type.String(), Type.Null()]),
  added: Type.Union([Type.Number(), Type.Null()]),
  removed: Type.Union([Type.Number(), Type.Null()]),
})

const TurnChangesSchema = Type.Object({
  turnId: Type.String(),
  startedAtMs: Type.Number(),
  files: Type.Array(TurnFileSchema),
})

export const ListResponseSchema = Type.Object({ turns: Type.Array(TurnChangesSchema) })
export const DiffResponseSchema = Type.Object({ path: Type.String(), diff: Type.String(), added: Type.Number(), removed: Type.Number() })
export const RevertResponseSchema = Type.Object({ reverted: Type.Array(Type.String()) })

export type AgentTurnChanges = Static<typeof TurnChangesSchema>
export type AgentTurnFileChange = Static<typeof TurnFileSchema>
export type AgentTurnFileDiff = Static<typeof DiffResponseSchema>

export type AgentRevertResult =
  | { readonly ok: true; readonly reverted: string[] }
  | { readonly ok: false; readonly message: string }
