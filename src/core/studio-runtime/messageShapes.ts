/**
 * messageShapes — the wire shapes several message families share. A leaf:
 * `messages.ts`, `dropCandidateMessages.ts` and `keyMessages.ts` import from
 * here, and none of them imports another.
 */
import { Type, type Static } from '@sinclair/typebox'

export const NodeRectSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
})
export type NodeRect = Static<typeof NodeRectSchema>

/** The four modifier keys an input event carried — pointer, wheel and key messages alike. */
export const PointerModifiersSchema = Type.Object({
  shiftKey: Type.Boolean(),
  altKey: Type.Boolean(),
  ctrlKey: Type.Boolean(),
  metaKey: Type.Boolean(),
})
