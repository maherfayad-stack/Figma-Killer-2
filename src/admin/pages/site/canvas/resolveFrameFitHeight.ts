/**
 * How tall a design frame's `<body>` has to be for nothing inside it to scroll.
 *
 * A design frame shows a whole screen at once. Two things make that fail on an
 * imported app screen, and both are solved by the same number:
 *
 *   - An app shell sizes itself to the viewport (`body { height: 100% }` → a
 *     `height: 100%` flex column → a `flex: 1` scroll region) and scrolls
 *     INTERNALLY. At a device-sized 800px that region shows a fraction of its
 *     content, and the rest is only reachable by scrolling inside the frame —
 *     which the canvas cannot allow anyway, because those wheel events are the
 *     ones it needs for pan and zoom.
 *   - A percentage height only resolves against a DEFINITE parent height. Left
 *     `auto`, the whole chain collapses and the scroll region computes to 0.
 *
 * So body gets a definite height, and that height grows until no descendant
 * needs to scroll: `pinned + deficit`, where the deficit is how much content a
 * scroll region is hiding. Growing body grows the `flex: 1` region by the same
 * amount, so one pass normally settles it.
 *
 * GROWTH IS MONOTONIC, and that is the whole safety argument. Content height
 * depends on the pin whenever a descendant uses a percentage height, so any rule
 * that could also SHRINK the pin closes a feedback loop — pin, relayout,
 * different content height, different pin — and sections visibly flicker in and
 * out while it runs. Only ever growing, with a hard ceiling, terminates.
 */

import { SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR } from './canvasScrollUnroll'

/** Ceiling on the fitted height. A pathological page (a `88vh` hero feeding its own container) stops here instead of growing without bound. */
export const MAX_FRAME_FIT_HEIGHT = 20000

/**
 * How many times one document may grow before the canvas accepts that it will
 * not fit.
 *
 * The monotonic-growth argument assumes growing body grows a scroll region while
 * the CONTENT inside it stays put. That does not hold when the content is itself
 * percentage-sized off the region: every pass makes the region taller, the
 * content taller with it, and the deficit never closes. Measured on the eSIM
 * corpus, one screen rode that all the way to the 20000px ceiling and dragged
 * its frame to 100342px — the "editor lags until the tab crashes" failure
 * `resolveViewportUnits` was written to prevent.
 *
 * A height ceiling alone does not help, because it is reached by growing. A pass
 * budget stops the chase early and leaves that one frame scrolling internally,
 * which is exactly the behaviour it had before any of this. Real screens settle
 * in one or two passes.
 */
export const MAX_FRAME_FIT_PASSES = 4

export interface FrameFitMetrics {
  /** Body's current definite height — what the deficit is measured against. */
  pinnedHeight: number
  /** For each descendant that can scroll, how much content it is hiding (`scrollHeight - clientHeight`). */
  scrollDeficits: readonly number[]
  /** How many times this document has already grown. */
  passesUsed: number
}

/**
 * The next definite body height, or `null` when nothing inside needs to scroll.
 *
 * Only INNER scroll regions drive this. Content overflowing body itself is not a
 * scrolling problem for the canvas — body overflows visibly and the iframe
 * element grows to it (`resolveCanvasFrameHeight`) — and feeding body's own
 * `scrollHeight` in here was actively harmful: a single inflated measurement
 * during first layout, before the stylesheets and images settle, pinned a frame
 * straight to the ceiling and nothing afterwards could lower it.
 */
export function resolveFrameFitHeight({
  pinnedHeight,
  scrollDeficits,
  passesUsed,
}: FrameFitMetrics): number | null {
  if (passesUsed >= MAX_FRAME_FIT_PASSES) return null
  if (pinnedHeight >= MAX_FRAME_FIT_HEIGHT) return null

  const deficit = Math.max(...scrollDeficits, 0)
  // Sub-pixel deficits are rounding noise in a fractional layout, not hidden
  // content; chasing them would resize the frame every frame forever.
  if (deficit <= 1) return null
  return Math.min(Math.ceil(pinnedHeight + deficit), MAX_FRAME_FIT_HEIGHT)
}

/**
 * Every scroll region's hidden-content height, in document order.
 *
 * `hidden`/`clip` is excluded: that is the design deliberately clipping (an
 * avatar mask, a marquee), not content the author expects a reader to reach,
 * and growing the frame to "reveal" it would break the design's own intent.
 *
 * EVERY OTHER overflow value counts, not just `auto`/`scroll`. An element
 * with an EXPLICIT height (not `auto`) and `overflow: visible` can still
 * have `scrollHeight > clientHeight` — a `position: absolute; inset: 0`
 * overlay root sized against `body`'s pin (see iframeBodyReset.ts's "Body is
 * the containing block" comment) is the common shape: its own box is a fixed
 * height, but a taller child paints past it rather than being clipped or
 * scrolled, because CSS never grows an explicit-height box to fit content —
 * only `height: auto` boxes do that. `visible` means the author wants that
 * excess SEEN, which is exactly what this frame's own root `overflow: hidden`
 * clip boundary (the same file, same "Body is the containing block" comment)
 * would otherwise silently defeat if nothing ever grew the pin to match.
 *
 * **Do not broaden this gate to "everything except hidden/clip" again.** That
 * was tried (`canvas-02`) to fix the eSIM manual-entry-sheet clipping, and a
 * real-browser pass (`test-01`) showed it makes things strictly worse: the
 * frame rendered as a blank box. The reason is definitional — for an
 * `overflow: visible` element, `scrollHeight` counts children that are
 * *already painted and visible*. That excess is not hidden content, so
 * treating it as a deficit is measuring the wrong thing, and because the
 * caller takes `Math.max(...)` a single large bogus value pins body at
 * 2000px+ and pushes real content out of the frame's fixed device box.
 *
 * The genuine defect that attempt was chasing (`canvas-04`): in a DESIGN
 * frame, `CanvasScrollUnrollInjector` forces every element's `overflow-y` to
 * `visible !important`, unconditionally, before this function ever runs —
 * so reading `getComputedStyle(el).overflowY` here always sees `visible`,
 * even for an element the AUTHOR wrote as `overflow-y: auto`. This function
 * was permanently blind to exactly the regions it exists to find. The fix
 * stays a narrow `auto`/`scroll` gate (never broadened — see above) but reads
 * the PRE-unroll value the injector recorded
 * (`SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR`, `canvasScrollUnroll.ts`) instead
 * of the computed value it has since overwritten. In live mode, or before
 * the injector's first settle, no recording exists yet — computed style is
 * the correct fallback there (nothing has overwritten it). See `STATE.md`
 * (`canvas-02`, `test-01`, `canvas-04`) for the full evidence.
 */
export function collectScrollDeficits(doc: Document): number[] {
  const view = doc.defaultView
  if (!view || !doc.body) return []

  const deficits: number[] = []
  for (const el of doc.body.querySelectorAll('*')) {
    const scrollHeight = el.scrollHeight
    if (scrollHeight <= el.clientHeight + 1) continue
    const overflowY = el.getAttribute(SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR) ?? view.getComputedStyle(el).overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue
    deficits.push(scrollHeight - el.clientHeight)
  }
  return deficits
}
