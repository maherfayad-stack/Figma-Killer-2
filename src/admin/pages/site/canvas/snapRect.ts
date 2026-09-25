/**
 * snapRect — the one rect shape every snap module speaks: a top-left plus a
 * size, in whatever space the caller's rects are in (board units for board
 * furniture, a frame's CSS px for an element).
 *
 * Its own leaf module so the snap modules can share it without importing one
 * another: `boardSnapping.ts` composes `snapSpacing.ts`, and the type both
 * need living in either of them made a cycle (P5-F).
 */
export interface SnapRect {
  x: number
  y: number
  width: number
  height: number
}
