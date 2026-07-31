/**
 * framesInMarquee — pure rect-intersection test for a marquee (drag-to-select)
 * selection box, WS-7.1.
 *
 * Both sides are in the SAME space: canvas-root-relative screen pixels
 * (`[0, width] x [0, height]` of the untransformed canvas root). The caller
 * measures each frame's RENDERED box once at pointerdown — see
 * `useMarqueeSelection.ts`'s `measureFrameRects` — and subtracts the canvas
 * root's own `getBoundingClientRect()` origin, exactly as it already does for
 * the raw `clientX`/`clientY` the marquee rect is built from.
 *
 * `board-03`: this used to take BOARD-space rects plus the pan/zoom transform
 * and derive the screen rect itself, sized `(frame.height ?? FRAME_HEIGHT)`.
 * That rect is a fiction for any frame the author has never resized:
 * `canvas-04`'s auto-height frames render `height: auto` with `--frame-h`
 * only as a `min-height`, so an eSIM-sized screen draws thousands of board
 * units taller than its nominal rect — and a marquee dragged across the part
 * of it the user can actually SEE selected nothing. Fresh boards are entirely
 * auto-height (`boardSlice`'s `addFrame`/`seedFramesForActiveBoard` save
 * position only), so that was the common case, not the edge case. Hit-testing
 * the rendered box makes the gesture mean what it looks like it means.
 *
 * Sibling of `frameVirtualization.ts`, which still owns the board→screen
 * transform for the virtualization window — that one is asking a different
 * question ("should this frame mount at all"), and answers it before any DOM
 * exists to measure.
 */

/** The drag rectangle, in screen space (canvas-root-relative pixels), already normalized to a non-negative width/height. */
export interface MarqueeRect {
  x: number
  y: number
  width: number
  height: number
}

/** A marquee-selectable frame: its rendered screen-space rect plus the id selecting it resolves to. */
export interface MarqueeFrame extends MarqueeRect {
  pageId: string
}

/**
 * Normalize two arbitrary drag points (start may be below/right of current)
 * into a non-negative `MarqueeRect`.
 */
export function marqueeRectFromPoints(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): MarqueeRect {
  const x = Math.min(startX, currentX)
  const y = Math.min(startY, currentY)
  return { x, y, width: Math.abs(currentX - startX), height: Math.abs(currentY - startY) }
}

/**
 * The `pageId`s of every frame whose rendered rect intersects `marquee`.
 * Intersection, not containment — a frame partially inside the marquee is
 * selected, matching the spec ("drag to select intersecting frames") and
 * Figma's own marquee behaviour. Touching edges do not count as intersecting.
 */
export function framesInMarquee(frames: readonly MarqueeFrame[], marquee: MarqueeRect): string[] {
  const mLeft = marquee.x
  const mTop = marquee.y
  const mRight = marquee.x + marquee.width
  const mBottom = marquee.y + marquee.height

  const selected: string[] = []
  for (const frame of frames) {
    const right = frame.x + frame.width
    const bottom = frame.y + frame.height
    if (frame.x < mRight && right > mLeft && frame.y < mBottom && bottom > mTop) {
      selected.push(frame.pageId)
    }
  }
  return selected
}
