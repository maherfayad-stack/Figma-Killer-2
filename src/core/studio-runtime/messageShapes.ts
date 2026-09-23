/**
 * messageShapes — the wire shapes several message families share. A leaf:
 * `messages.ts` and `dropCandidateMessages.ts` both import from here, neither
 * imports the other.
 */
import { Type, type Static } from '@sinclair/typebox'

export const NodeRectSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
})
export type NodeRect = Static<typeof NodeRectSchema>
