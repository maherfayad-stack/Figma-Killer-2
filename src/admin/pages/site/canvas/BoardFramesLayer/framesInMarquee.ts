/**
 * framesInMarquee — pure board→screen intersection test for a marquee
 * (drag-to-select) selection box, WS-7.1.
 *
 * Sibling of `frameVirtualization.ts` and deliberately shaped like it: same
 * board→screen transform math (`screenX = panX + boardX * zoom`), no React,
 * no DOM reads, unit-testable without a browser. Where `isFrameOnScreen`
 * asks "does this frame intersect the viewport", `framesInMarquee` asks
 * "does this frame intersect the marquee the user is dragging" — the
 * marquee rect is already in the SAME screen space as the viewport box
 * (`[0, width] x [0, height]` of the untransformed canvas root), so the
 * caller is responsible for subtracting `canvasRootRef`'s own
 * `getBoundingClientRect()` origin from raw `clientX`/`clientY` before
 * calling this, exactly as `BoardFramesLayer` already does for
 * `viewportSize`.
 */

import type { FrameRect, ViewportState } from './frameVirtualization'

/** A marquee-selectable frame: its board-space rect plus the id selecting it resolves to. */
export interface MarqueeFrame extends FrameRect {
  pageId: string
}

/** The drag rectangle, in screen space (canvas-root-relative pixels), already normalized to a non-negative width/height. */
export interface MarqueeRect {
  x: number
  y: number
  width: number
  height: number
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
 * The `pageId`s of every frame whose board-space rect intersects `marquee`,
 * given the current pan/zoom transform. Intersection, not containment — a
 * frame partially inside the marquee is selected, matching the spec ("drag
 * to select intersecting frames") and Figma's own marquee behaviour.
 */
export function framesInMarquee(
  frames: readonly MarqueeFrame[],
  marquee: MarqueeRect,
  viewport: Pick<ViewportState, 'panX' | 'panY' | 'zoom'>,
): string[] {
  const { panX, panY, zoom } = viewport
  const mLeft = marquee.x
  const mTop = marquee.y
  const mRight = marquee.x + marquee.width
  const mBottom = marquee.y + marquee.height

  const selected: string[] = []
  for (const frame of frames) {
    const left = panX + frame.x * zoom
    const top = panY + frame.y * zoom
    const right = left + frame.width * zoom
    const bottom = top + frame.height * zoom

    if (left < mRight && right > mLeft && top < mBottom && bottom > mTop) {
      selected.push(frame.pageId)
    }
  }
  return selected
}
