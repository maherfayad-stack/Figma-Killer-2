/**
 * elementResizeRules — the pure geometry and policy of dragging a resize
 * handle on a LAID-OUT element, shared by the portal-mode handles
 * (`useElementResizeDrag.ts`, same document) and the in-frame runtime's
 * handles (`resizeHandles.ts`, cross-origin). One implementation, two hosts,
 * like every other rule module in this package — this file ships inside the
 * runtime bundle, so it stays free of admin/store/DOM imports. The one DOM
 * read both hosts share (what the element looks like at pointerdown) is
 * `elementResizeMeasure.ts`.
 *
 * ## Why this is not `rectResize.ts`
 *
 * A frame, a sticky note and a doc card are absolutely positioned boxes the
 * board owns: they have an `x`/`y` of their own, so dragging their west edge
 * legitimately moves the box left AND widens it, and `resizeRect` returns a
 * full next rect.
 *
 * An element inside a page usually is not that. Its position is produced by
 * layout — flow, flex, grid — and the editor does not own it. Dragging the
 * west edge of a centred button cannot move the button left: the moment its
 * width changes, layout re-centres it and decides where its left edge goes.
 * So for a FLOW element this module returns a size and nothing else, and the
 * west/north handles invert the delta instead (dragging the west edge leftward
 * is a negative `dx` and grows the element).
 *
 * The exception is an element that ALREADY decides its own position through
 * its offsets — `position: absolute | fixed` (IX-6d). There the page's layout
 * does not re-place it, so a west drag that only widened it would grow it to
 * the RIGHT, away from the cursor. For those, {@link ResizeBoxStart.offsets}
 * is present and the step also carries the offset that keeps the OPPOSITE
 * edge where it was (Penpot's `get-handler-resize-origin`).
 *
 * ## The size written is the CSS size, not the rect (IX-6a)
 *
 * A drag moves the element's BORDER box — that is what the handles sit on and
 * what the cursor drags. CSS `width` is the border box only under
 * `box-sizing: border-box`; under the initial `content-box` it excludes the
 * padding and border. Writing the measured rect as `width` therefore grows a
 * padded `content-box` element by its padding + border on the first preview
 * frame, and commits that too. So the geometry runs in border-box space (the
 * aspect ratio and the floor are VISUAL facts) and only the output is
 * converted: `width = borderBox - insetWidth`, where `insetWidth` is the
 * padding + border `content-box` puts outside `width` (0 for `border-box`).
 *
 * ## Modifiers are read live (IX-6c)
 *
 * {@link ResizeModifiers} is passed per step, not captured at pointerdown:
 * pressing or releasing ⇧ or ⌥ mid-drag changes the very next step. ⇧ (or
 * `K4`'s scale tool) keeps the START border box's aspect ratio; ⌥ resizes
 * about the centre, so the delta doubles on each owned axis and — for a
 * positioned element — the offsets move by half of it.
 *
 * ## What a step writes
 *
 * A step carries every dimension, and {@link resizeStylePatch} writes only the
 * ones that moved. Dragging the east edge must not commit a `height`: the
 * element may be hugging its content vertically, and freezing that measured
 * height into the source turns a responsive box into a fixed one, silently,
 * as a side effect of a horizontal drag. The same class of bug as the frame
 * resize's `changesHeight` guard (`BoardFrameView`), for the same reason.
 */

/** The eight drag handles every resizable thing on the board offers — four corners, four edges. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Every handle, in visual order (top-left clockwise) — the order each view renders them in. */
export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/**
 * The smallest an element's BORDER box may be dragged to. Smaller than a
 * frame's floor (200) or an annotation's (80) on purpose: an icon button, a
 * chip or a divider are legitimately tiny, and a floor tuned for board
 * furniture would make them unresizable.
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

/** Which dimensions `handle` drags directly. */
export function resizeAxes(handle: ResizeHandle): { width: boolean; height: boolean } {
  return {
    width: handle.includes('e') || handle.includes('w'),
    height: handle.includes('n') || handle.includes('s'),
  }
}

/** The two modifiers a resize honours, read from the pointer/key event of EACH step. */
export interface ResizeModifiers {
  /** ⇧ held, or `K4`'s scale tool armed: keep the start border box's aspect ratio. */
  proportional: boolean
  /** ⌥ held: resize about the centre — the opposite edge moves by the same amount. */
  fromCenter: boolean
}

/**
 * The modifiers of ONE event — a pointer move, or the key press that changed
 * them. `scaleTool` is `K4`'s `K`, which only the pointerdown knows: the tool
 * is latched for the gesture, the keys are not.
 */
export function resizeModifiersOf(
  event: { shiftKey: boolean; altKey: boolean },
  scaleTool: boolean,
): ResizeModifiers {
  return { proportional: scaleTool || event.shiftKey, fromCenter: event.altKey }
}

/**
 * The property the horizontal offset of a positioned element is written to.
 * Physical `left` in a left-to-right element; the logical `insetInlineStart`
 * under `direction: rtl`, where the inline start is the RIGHT edge — the same
 * choice `canvasFreeMove.ts` makes for a free move. camelCase, because this
 * is a key of the element's `style={{…}}` object in the user's source.
 */
export type InlineOffsetProperty = 'left' | 'insetInlineStart'

/** A positioned element's offsets at pointerdown, in its own CSS px. */
export interface ResizeOffsets {
  inlineProperty: InlineOffsetProperty
  inline: number
  top: number
}

/** Everything a resize needs to know about the element, read once at pointerdown (`readResizeBoxStart`). */
export interface ResizeBoxStart {
  /** Computed CSS `width`/`height` in px — the values the source spells. */
  width: number
  height: number
  /** Padding + border `box-sizing: content-box` puts OUTSIDE `width`/`height`; 0 under `border-box`. */
  insetWidth: number
  insetHeight: number
  /** Present only when the element is positioned freely (`absolute` / `fixed`). */
  offsets: ResizeOffsets | null
}

/** One step of a drag: CSS values, whole pixels. Offsets are `null` for a flow element. */
export interface ResizeStep {
  width: number
  height: number
  inline: number | null
  top: number | null
}

/** A step exactly at the start — what an unmoved drag shows. */
export function resizeStartStep(start: ResizeBoxStart): ResizeStep {
  return {
    width: Math.round(start.width),
    height: Math.round(start.height),
    inline: start.offsets ? Math.round(start.offsets.inline) : null,
    top: start.offsets ? Math.round(start.offsets.top) : null,
  }
}

/**
 * How far one visual edge of an axis moves when that axis's border box grows
 * by `grow`. `owned`: the handle drags this axis; `startSide`: it drags the
 * start (west/north) edge. An axis the handle does not own only changes under
 * the aspect lock, and then grows about its centre — which keeps an edge drag
 * with ⇧ from shoving the element sideways.
 */
function leadingEdgeShift(grow: number, owned: boolean, startSide: boolean, fromCenter: boolean): number {
  if (grow === 0) return 0
  if (fromCenter || !owned) return -grow / 2
  return startSide ? -grow : 0
}

/**
 * The element after dragging `handle` by (`dx`, `dy`) from `start`, under
 * `modifiers`.
 *
 * `dx`/`dy` are in the element's OWN CSS pixels, which is what pointer events
 * raised inside the frame's document already report: the canvas zoom is a CSS
 * transform on the iframe element in the parent document, and the browser
 * un-projects it before the event reaches the frame's own document. There is
 * deliberately no `/ zoom` here — adding one would double-correct.
 *
 * With `proportional`, a corner handle has two candidate sizes and the one
 * with the larger scale wins; the ratio always comes from `start`, never from
 * the running size, so a long drag cannot drift. A zero-sized start (a
 * `display: contents` host) has no ratio and degrades to a free resize rather
 * than dividing by zero.
 */
export function resizeElementBox(
  handle: ResizeHandle,
  start: ResizeBoxStart,
  dx: number,
  dy: number,
  modifiers: ResizeModifiers,
  minSize: number = MIN_ELEMENT_SIZE,
): ResizeStep {
  const axes = resizeAxes(handle)
  const factor = modifiers.fromCenter ? 2 : 1
  const boxWidth = start.width + start.insetWidth
  const boxHeight = start.height + start.insetHeight
  // A border box can never be smaller than the padding + border it carries.
  const minWidth = Math.max(minSize, start.insetWidth)
  const minHeight = Math.max(minSize, start.insetHeight)

  // West/north handles invert: dragging them "outward" is a negative delta.
  const pullX = (handle.includes('w') ? -dx : dx) * factor
  const pullY = (handle.includes('n') ? -dy : dy) * factor
  let width = axes.width ? Math.max(minWidth, boxWidth + pullX) : boxWidth
  let height = axes.height ? Math.max(minHeight, boxHeight + pullY) : boxHeight

  if (modifiers.proportional && boxWidth > 0 && boxHeight > 0) {
    const scale =
      axes.width && axes.height
        ? Math.max(width / boxWidth, height / boxHeight)
        : axes.width
          ? width / boxWidth
          : height / boxHeight
    width = Math.max(minWidth, boxWidth * scale)
    height = Math.max(minHeight, boxHeight * scale)
  }

  const cssWidth = axes.width || modifiers.proportional
    ? Math.max(0, Math.round(width - start.insetWidth))
    : Math.round(start.width)
  const cssHeight = axes.height || modifiers.proportional
    ? Math.max(0, Math.round(height - start.insetHeight))
    : Math.round(start.height)

  if (!start.offsets) return { width: cssWidth, height: cssHeight, inline: null, top: null }

  // The border box grew by exactly what the CSS size grew by — the insets
  // are constant — so the edge arithmetic runs on the CSS delta.
  const growX = cssWidth - start.width
  const growY = cssHeight - start.height
  const leftShift = leadingEdgeShift(growX, axes.width, handle.includes('w'), modifiers.fromCenter)
  const topShift = leadingEdgeShift(growY, axes.height, handle.includes('n'), modifiers.fromCenter)
  const { inlineProperty, inline, top } = start.offsets
  // Under RTL the inline start is the RIGHT edge, whose shift is the growth
  // plus the left edge's shift — and a rightward move SHRINKS the distance
  // from the containing block's right side.
  const nextInline = inlineProperty === 'left' ? inline + leftShift : inline - (growX + leftShift)
  return {
    width: cssWidth,
    height: cssHeight,
    inline: Math.round(nextInline),
    top: Math.round(top + topShift),
  }
}

/** The inline-style patch a finished drag commits: `px` strings, only the properties that moved. */
export type ElementResizePatch = {
  width?: string
  height?: string
  left?: string
  insetInlineStart?: string
  top?: string
}

/**
 * The inline-style patch a finished drag should commit, or `null` when the
 * pointer moved but nothing did (a sub-pixel wobble, or a drag held against
 * the floor). "Moved" is against the START rounded the way a step rounds, so
 * a fractional computed width (`233.33px` in a flex row) never produces a
 * write on an axis the drag did not touch.
 *
 * Values are `px` strings rather than bare numbers: this patch is written into
 * the element's own `style={{ … }}` in the user's source, and `width: 148`
 * there reads as a React number that React will serialize to `148px` anyway —
 * spelling the unit keeps the emitted source saying what it means.
 */
export function resizeStylePatch(start: ResizeBoxStart, step: ResizeStep): ElementResizePatch | null {
  const origin = resizeStartStep(start)
  const patch: ElementResizePatch = {}
  if (step.width !== origin.width) patch.width = `${step.width}px`
  if (step.height !== origin.height) patch.height = `${step.height}px`
  if (start.offsets && step.inline !== null && step.inline !== origin.inline) {
    patch[start.offsets.inlineProperty] = `${step.inline}px`
  }
  if (step.top !== null && step.top !== origin.top) patch.top = `${step.top}px`
  return Object.keys(patch).length > 0 ? patch : null
}
