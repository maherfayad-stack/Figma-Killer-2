/**
 * elementResizeRules — the pure geometry and policy of dragging a resize
 * handle on a LAID-OUT element, shared by the portal-mode handles
 * (`useElementResizeDrag.ts`, same document) and the in-frame runtime's
 * handles (`resizeHandles.ts`, cross-origin). One implementation, two hosts,
 * like every other rule module in this package — this file ships inside the
 * runtime bundle, so it stays free of admin/store/DOM imports.
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
 */

/** The eight drag handles every resizable thing on the board offers — four corners, four edges. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Every handle, in visual order (top-left clockwise) — the order each view renders them in. */
export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export interface ElementSize {
  width: number
  height: number
}

/** The inline-style patch a finished drag commits — `px` strings, only the dimensions the drag changed. A type alias, not an interface, so it stays assignable to the store's `Record<string, …>` patch parameter. */
export type ElementSizePatch = {
  width?: string
  height?: string
}

/**
 * The smallest an element may be dragged to. Smaller than a frame's floor
 * (200) or an annotation's (80) on purpose: an icon button, a chip or a
 * divider are legitimately tiny, and a floor tuned for board furniture would
 * make them unresizable.
 */
export const MIN_ELEMENT_SIZE = 8

/**
 * Outer displays CSS simply ignores `width`/`height` on. A resize offered on
 * one of these lands in the source and changes nothing on screen — a dead
 * affordance that is harder to spot than a refusal, because it appears to
 * have worked. The geometric half of `resizeOffer.ts`'s `canOfferResize`;
 * the in-frame runtime applies it on its own side of the wire, where the
 * computed display actually lives.
 */
const UNSIZEABLE_DISPLAYS = new Set(['inline', 'contents', 'none'])

export function isSizeableDisplay(display: string): boolean {
  return !UNSIZEABLE_DISPLAYS.has(display)
}

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
 * raised inside the frame's document already report: the canvas zoom is a CSS
 * transform on the iframe element in the parent document, and the browser
 * un-projects it before the event reaches the frame's own document. There is
 * deliberately no `/ zoom` here — adding one would double-correct.
 *
 * Dimensions the handle does not own come back unchanged, so a caller can
 * compare against `start` to decide what to write.
 *
 * ## `proportional` — `K4`'s scale tool (`K`)
 *
 * With the scale tool armed, a drag keeps the element's START aspect ratio and
 * returns BOTH dimensions, including the one the handle does not own: dragging
 * the east edge of a 200×100 box to 300 wide also makes it 150 tall. The ratio
 * is taken from `start`, never from the running size — deriving it per move
 * would compound rounding and let the shape drift over a long drag.
 *
 * A corner handle owns both axes and therefore has two candidate sizes; the
 * one with the LARGER relative change wins, so the box follows whichever way
 * the pointer actually travelled rather than snapping to the axis that happens
 * to be listed first.
 *
 * A zero-width or zero-height start has no ratio to preserve (an empty inline
 * element, a `display: contents` host), so `proportional` degrades to the
 * ordinary single-axis resize rather than dividing by zero.
 */
export function resizeElementSize(
  handle: ResizeHandle,
  start: ElementSize,
  dx: number,
  dy: number,
  minSize: number = MIN_ELEMENT_SIZE,
  proportional = false,
): ElementSize {
  const axes = resizeAxes(handle)
  // West/north handles invert: dragging them "outward" is a negative delta.
  const widthDelta = handle.includes('w') ? -dx : dx
  const heightDelta = handle.includes('n') ? -dy : dy
  const free = {
    width: axes.width ? Math.max(minSize, Math.round(start.width + widthDelta)) : start.width,
    height: axes.height ? Math.max(minSize, Math.round(start.height + heightDelta)) : start.height,
  }
  if (!proportional || start.width <= 0 || start.height <= 0) return free

  const ratio = start.height / start.width
  const scale =
    axes.width && axes.height
      ? Math.max(free.width / start.width, free.height / start.height)
      : axes.width
        ? free.width / start.width
        : free.height / start.height

  return {
    width: Math.max(minSize, Math.round(start.width * scale)),
    height: Math.max(minSize, Math.round(start.width * scale * ratio)),
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
 *
 * With `proportional` (`K4`'s scale tool) the axis guard is lifted: the whole
 * point of that drag is that the handle changes the dimension it does not own,
 * so refusing to write it would leave the committed source disagreeing with
 * what the user watched happen on screen. The `!== start` guard stays, so a
 * drag that genuinely moved only one dimension still writes only that one.
 */
export function resizeStylePatch(
  handle: ResizeHandle,
  start: ElementSize,
  next: ElementSize,
  proportional = false,
): ElementSizePatch | null {
  const axes = resizeAxes(handle)
  const patch: ElementSizePatch = {}
  if ((proportional || axes.width) && next.width !== start.width) patch.width = `${next.width}px`
  if ((proportional || axes.height) && next.height !== start.height) patch.height = `${next.height}px`
  return patch.width !== undefined || patch.height !== undefined ? patch : null
}
