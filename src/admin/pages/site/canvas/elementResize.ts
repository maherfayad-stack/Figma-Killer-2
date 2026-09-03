/**
 * elementResize — pure geometry for dragging a resize handle on a LAID-OUT
 * element, as opposed to a board rect.
 *
 * ## Why this is not `rectResize.ts`
 *
 * A frame, a sticky note and a doc card are absolutely positioned boxes the
 * board owns: they have an `x`/`y` of their own, so dragging their west edge
 * legitimately moves the box left AND widens it, and `resizeRect` returns a
 * full next rect.
 *
 * An element inside a page is not that. Its position is produced by layout —
 * flow, flex, grid — and the editor does not own it. Dragging the west edge of
 * a centred button cannot move the button left: the moment its width changes,
 * layout re-centres it and decides where its left edge goes. Writing an `x`
 * would mean writing `position: absolute`, which is a different (and much
 * larger) edit than the one the user asked for by grabbing an edge.
 *
 * So this module returns a SIZE and never a position. The west/north handles
 * still work, and still feel right, because they invert the delta: dragging
 * the west edge leftward is a negative `dx` and grows the element. What the
 * user then sees is the element growing symmetrically or rightward depending
 * on its own alignment — which is the honest answer, because that IS what the
 * page's layout does with the extra width.
 *
 * ## Which axes a handle owns
 *
 * `resizeAxes` exists so a drag writes ONLY what it changed. Dragging the east
 * edge must not commit a `height`: the element may be hugging its content
 * vertically, and freezing that measured height into the source turns a
 * responsive box into a fixed one, silently, as a side effect of a horizontal
 * drag. This is the same class of bug as the frame resize's `changesHeight`
 * guard (`BoardFrameView`), for the same reason.
 *
 * Deliberately pure — no React, no DOM reads — so all eight handle directions
 * and the clamp are unit-tested without a browser.
 */
import type { ResizeHandle } from './rectResize'

export interface ElementSize {
  width: number
  height: number
}

/**
 * The smallest an element may be dragged to. Smaller than a frame's floor
 * (200) or an annotation's (80) on purpose: an icon button, a chip or a
 * divider are legitimately tiny, and a floor tuned for board furniture would
 * make them unresizable.
 */
export const MIN_ELEMENT_SIZE = 8

/** Which dimensions `handle` changes — the properties a drag may write. */
export function resizeAxes(handle: ResizeHandle): { width: boolean; height: boolean } {
  return {
    width: handle.includes('e') || handle.includes('w'),
    height: handle.includes('n') || handle.includes('s'),
  }
}

/**
 * The element's size after dragging `handle` by (`dx`, `dy`) from `start`.
 *
 * `dx`/`dy` are in the element's OWN CSS pixels, which is what pointer events
 * raised inside the frame's iframe already report: the canvas zoom is a CSS
 * transform on the iframe element in the parent document, and the browser
 * un-projects it before the event reaches the iframe's own document. There is
 * deliberately no `/ zoom` here — adding one would double-correct.
 *
 * Dimensions the handle does not own come back unchanged, so a caller can
 * compare against `start` to decide what to write.
 */
export function resizeElementSize(
  handle: ResizeHandle,
  start: ElementSize,
  dx: number,
  dy: number,
  minSize: number = MIN_ELEMENT_SIZE,
): ElementSize {
  const axes = resizeAxes(handle)
  // West/north handles invert: dragging them "outward" is a negative delta.
  const widthDelta = handle.includes('w') ? -dx : dx
  const heightDelta = handle.includes('n') ? -dy : dy
  return {
    width: axes.width ? Math.max(minSize, Math.round(start.width + widthDelta)) : start.width,
    height: axes.height ? Math.max(minSize, Math.round(start.height + heightDelta)) : start.height,
  }
}

/**
 * The inline-style patch a finished drag should commit, or `null` when the
 * pointer moved but the size did not (a sub-pixel wobble, or a drag held
 * against the `minSize` clamp).
 *
 * Values are `px` strings rather than bare numbers: this patch is written into
 * the element's own `style={{ … }}` in the user's source, and `width: 148`
 * there reads as a React number that React will serialize to `148px` anyway —
 * spelling the unit keeps the emitted source saying what it means.
 */
export function resizeStylePatch(
  handle: ResizeHandle,
  start: ElementSize,
  next: ElementSize,
): Record<string, string> | null {
  const axes = resizeAxes(handle)
  const patch: Record<string, string> = {}
  if (axes.width && next.width !== start.width) patch['width'] = `${next.width}px`
  if (axes.height && next.height !== start.height) patch['height'] = `${next.height}px`
  return Object.keys(patch).length > 0 ? patch : null
}
