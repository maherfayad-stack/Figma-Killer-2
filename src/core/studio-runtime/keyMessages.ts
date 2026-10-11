/**
 * keyMessages — the keyboard half of the frame → parent wire (P2-B), posted by
 * `keyForwarding.ts` and replayed by the parent's `canvasFrameKeyRelay.ts`.
 * Split from `messages.ts` for the module-size budget, the same way
 * `dropCandidateMessages.ts` is; `messages.ts` re-exports the public names so
 * `@core/studio-runtime` consumers see one surface.
 */
import { Type, type Static } from '@sinclair/typebox'
import { PointerModifiersSchema } from './messageShapes'

/** Longest `KeyboardEvent.key` / `.code` the wire accepts — the longest real names (`MediaTrackPrevious`, `AudioVolumeMute`) are well inside it. */
export const KEY_NAME_MAX = 32

/**
 * A keystroke inside a DESIGN-mode bridge frame, which the frame has already
 * cancelled. The parent replays a `down` as a keydown on its own document —
 * where the editor's one key dispatcher listens — and a `up` into the
 * dispatcher's release broadcast. Never sent in live mode or while the user
 * is typing into the frame (`keyForwarding.ts`). Bounded strings, booleans
 * and a small integer; nothing here names a node or reaches the DOM.
 */
export const KeyMessageSchema = Type.Object({
  type: Type.Literal('key'),
  phase: Type.Union([Type.Literal('down'), Type.Literal('up')]),
  key: Type.String({ minLength: 1, maxLength: KEY_NAME_MAX }),
  code: Type.String({ maxLength: KEY_NAME_MAX }),
  /** `KeyboardEvent.location`: 0 standard, 1 left, 2 right, 3 numpad. */
  location: Type.Integer({ minimum: 0, maximum: 3 }),
  repeat: Type.Boolean(),
  modifiers: PointerModifiersSchema,
})
export type KeyMessage = Static<typeof KeyMessageSchema>

/**
 * ERR-11 — the frame's window lost focus while in design mode. A key held at
 * that moment sends its keyup to whatever took focus, so the parent treats
 * this as "maybe every key was released" and checks whether focus left the
 * editor altogether (`releaseEditorKeysIfFocusLeft`).
 */
export const FrameBlurMessageSchema = Type.Object({
  type: Type.Literal('blur'),
})
