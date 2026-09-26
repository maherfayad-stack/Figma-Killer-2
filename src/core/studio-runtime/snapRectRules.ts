/**
 * snapRectRules — the one rect shape every snap rule speaks: a top-left plus
 * a size, in whatever space the caller's rects are in (board units for board
 * furniture, a frame's CSS px for an element).
 *
 * A leaf of its own so `snapRules.ts` can compose `snapSpacingRules.ts`
 * without the two importing each other (P5-F): the type both need, living in
 * either of them, was a cycle.
 */
export interface SnapRect {
  x: number
  y: number
  width: number
  height: number
}
