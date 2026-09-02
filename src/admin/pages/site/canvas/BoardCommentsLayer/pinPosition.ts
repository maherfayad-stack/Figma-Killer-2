/**
 * Where a comment pin sits, in BOARD coordinates.
 *
 * Its own module rather than an export from the layer component, so both the
 * committed-thread path and the draft path compute this identically — they had
 * two copies of it, which is exactly how a draft pin ends up landing somewhere
 * other than where its committed twin will appear.
 */
import type { CommentAnchor } from '@core/studio-comments'

/** The minimum a board frame has to expose for a pin to be placed against it. */
export interface PinFrame {
  id: string
  x: number
  y: number
}

/**
 * `anchor.dx`/`dy` are frame-LOCAL when the pin was dropped on a frame, which
 * is what makes a pin travel with its frame when the frame is dragged.
 *
 * A pin whose frame has since been removed from the board keeps its coordinates
 * and becomes board-absolute rather than vanishing: the conversation outlives
 * the frame, which is why `anchor.pageId` is denormalized in the first place.
 */
export function pinPosition(
  anchor: CommentAnchor,
  frames: readonly PinFrame[],
): { x: number; y: number } {
  const frame = anchor.frameId
    ? frames.find((candidate) => candidate.id === anchor.frameId)
    : undefined
  return frame
    ? { x: frame.x + anchor.dx, y: frame.y + anchor.dy }
    : { x: anchor.dx, y: anchor.dy }
}
