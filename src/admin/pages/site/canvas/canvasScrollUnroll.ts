/**
 * Pure decision helpers for `CanvasScrollUnrollInjector`. Split out from the
 * component so the classification logic is unit-testable without a real
 * browser layout engine — mirrors `resolveFrameFitHeight.ts` /
 * `resolveCanvasFrameHeight` next to it, which do the same for frame height.
 */

/** The tag `CanvasScrollUnrollInjector` writes onto elements it has adjusted. */
export const SCROLL_UNROLL_ATTR = 'data-studio-unroll'

/**
 * Carries each element's PRE-unroll `overflow-y` — recorded before this
 * injector's own override CSS can touch it. Two independent consumers:
 *
 * 1. `collectScrollDeficits` (`resolveFrameFitHeight.ts`) needs it to tell a
 *    genuine author-authored `auto`/`scroll` region (content this injector
 *    is actively un-clipping) from an element that was always plain
 *    `visible` (a harmless sub-pixel line-height/box-height mismatch on a
 *    badge or title row) — see `STATE.md`'s `canvas-02`/`test-01`/`canvas-04`
 *    for why that gate must stay narrow.
 * 2. `buildScrollUnrollRules` below uses the SAME `auto`/`scroll` values as
 *    the selector that decides which elements get `overflow: visible` and
 *    `min-height: auto` at all. An element authoring `overflow: hidden` —
 *    a rounded-corner clip mask, a `text-overflow: ellipsis` container —
 *    is not a scroll region; forcing it visible does not "unroll" anything,
 *    it just breaks the clip. Measured live: `overflow-y: hidden` outnumbered
 *    `overflow-y: auto`/`scroll` roughly 30:1 among elements this injector
 *    was touching, and every one of those `hidden` elements lost its
 *    rounded-corner clip or its text ellipsis on the canvas — visible on a
 *    real project's Home screen, not a hypothetical. Recording the ONE true
 *    original value here and reusing it for both jobs keeps "is this
 *    genuinely a scroll region" answered exactly once, honestly, in one
 *    place.
 */
export const SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR = 'data-studio-unroll-overflow-y'

/**
 * Custom property carrying the "explicit-height" element's true full content
 * extent (its `scrollHeight`, measured before any mutation), read by the
 * injected stylesheet as `min-height`. Set inline (a value, not a behaviour)
 * — the actual override (`height: auto; min-height: var(...)`) lives in the
 * stylesheet, keyed off `SCROLL_UNROLL_ATTR`.
 *
 * Deliberately `scrollHeight`, not `clientHeight` — and specifically the
 * value measured BEFORE this element (or any earlier-in-document-order
 * ancestor's) tag is applied. Two reasons, either one sufficient on its own:
 * (1) a `clientHeight` re-read taken AFTER this element's own
 * `[data-studio-unroll="explicit-height"]` rule activates resolves
 * `min-height: var(--studio-unroll-min-height)` via CSS custom-property
 * INHERITANCE from whichever ancestor was tagged earlier in the same pass —
 * since custom properties inherit and this element hasn't set its own local
 * value yet, it picks up the ancestor's (often much larger) one and bakes it
 * in permanently; (2) even ignoring inheritance, `min-height` needs to beat
 * an author's `max-height` (a common `max-height: 60vh; overflow-y: auto`
 * sheet-content pattern) — CSS resolves a min/max conflict in favour of
 * `min-height`, but only if the value baked in is actually larger than
 * `max-height`, which `scrollHeight` (the true, uncapped content extent) is
 * and a `clientHeight` read while still clamped to that same `max-height`
 * never can be. Regression coverage:
 * `canvasScrollUnrollInjector.test.tsx`'s "floors it at its true content
 * extent" case.
 */
export const SCROLL_UNROLL_MIN_HEIGHT_VAR = '--studio-unroll-min-height'

/**
 * Marks an element whose author gave it a POSITIVE `min-height` floor, so the
 * scroll-region `min-height: auto !important` rule below (scoped by
 * {@link SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}) can be undone for it alone.
 *
 * Only ever set on an element that is ALSO a genuine scroll region (authored
 * `overflow-y: auto`/`scroll` — see the gate in `snapshotAuthoredStyles`,
 * `CanvasScrollUnrollInjector.tsx`). An element that is not a scroll region
 * is never touched by the min-height override in the first place, so it has
 * nothing to hand back — this marker exists only for the narrower case where
 * the SAME element is both "a scroll region whose `min-height: 0` idiom we
 * must neutralise" and "carries an unrelated, genuinely designed floor" (a
 * scroll region with e.g. `min-height: 300px; overflow-y: auto`, wanting a
 * minimum visible height on top of the content-based growth).
 *
 * Separate from {@link SCROLL_UNROLL_ATTR} on purpose, and deliberately NOT
 * cleared by `clearUnrollTags`: the two answer different questions and change
 * on different schedules. A tag records what this pass DECIDED from live
 * geometry (re-derived every settle); this records what the AUTHOR WROTE,
 * which does not change just because our own fix ran — the same
 * record-once-and-keep contract {@link SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}
 * has, for the same reason.
 */
export const SCROLL_UNROLL_FLOOR_ATTR = 'data-studio-unroll-floor'

/**
 * Carries the author's own `min-height` for a {@link SCROLL_UNROLL_FLOOR_ATTR}
 * element, read back by the stylesheet.
 *
 * The custom-property INHERITANCE trap that
 * {@link SCROLL_UNROLL_MIN_HEIGHT_VAR}'s doc describes cannot bite here:
 * every marked element is given its OWN inline value in the same statement
 * that marks it, so there is never a marked element resolving `var()` against
 * an ancestor's. An unmarked descendant inherits the property but no rule
 * matches it, so it stays inert.
 */
export const SCROLL_UNROLL_AUTHORED_MIN_HEIGHT_VAR = '--studio-unroll-authored-min-height'

/**
 * The author's `min-height` when it is a real floor worth preserving against
 * the scroll-region reset, else `null`.
 *
 * This function is ONLY ever consulted for an element `snapshotAuthoredStyles`
 * (`CanvasScrollUnrollInjector.tsx`) has already confirmed is a genuine
 * authored scroll region (`overflow-y: auto`/`scroll`) — an element that is
 * NOT a scroll region never reaches the `min-height: auto !important` rule
 * this function's result feeds AT ALL (see `buildScrollUnrollRules` below),
 * so its authored `min-height` — `0` included — is never touched, restored,
 * or even inspected; it simply stays whatever the author wrote, honestly,
 * with no machinery involved.
 *
 * WITHIN that narrowed scope, `auto` and non-positive values (`0`, a negative
 * length, anything unparsable) are exactly what the reset exists to
 * neutralise: `min-height: 0` on a `flex: 1; overflow-y: auto` region is the
 * standard way an author makes it shrinkable in the first place (the
 * automatic content-based minimum `auto` gives a flex item would otherwise
 * refuse to let it shrink below its content), and restoring that automatic
 * minimum — now that overflow is visible — is what actually grows the
 * region. Anything POSITIVE is a designed floor and the reset was never meant
 * to touch it, even on a genuine scroll region: a `min-height: 300px;
 * overflow-y: auto` region wants a guaranteed minimum on top of whatever its
 * content grows it to. The design system's
 * `.bottom-sheet--small .bottom-sheet__panel { min-height: 200px }` — NOT
 * itself a scroll region (it's `overflow: hidden`; `.bottom-sheet__content`
 * inside it is the actual scroll region) — never reaches this function at
 * all under the new gate, and needs no restoration: it was never touched.
 *
 * Takes the computed string rather than the element so the decision stays
 * testable without a layout engine — same contract as
 * {@link classifyUnrollElement} beside it.
 */
export function authoredMinHeightFloor(minHeight: string): string | null {
  const value = minHeight.trim()
  if (!value || value === 'auto') return null
  const numeric = Number.parseFloat(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return value
}

export type ScrollUnrollTag = 'fixed' | 'explicit-height'

export interface UnrollElementMetrics {
  /** `getComputedStyle(el).position`. */
  position: string
  /** `el.scrollHeight - el.clientHeight`. */
  scrollDeficit: number
  /** `el.clientHeight` — the box's current (pre-override) height, in px. */
  clientHeight: number
}

/**
 * What (if anything) an element needs tagged, given its current geometry.
 *
 * `fixed` wins over `explicit-height`: a fixed bottom-nav / header is pinned
 * by position, not resized — even if it also happens to clip (unlikely, but
 * mutually exclusive tags keep the stylesheet rules from fighting each other
 * on the same element).
 *
 * Sub-pixel deficits are rounding noise from a fractional layout, not hidden
 * content worth acting on — matches the same `<= 1` tolerance
 * `resolveFrameFitHeight` uses for the same reason.
 */
export function classifyUnrollElement(metrics: UnrollElementMetrics): ScrollUnrollTag | null {
  if (metrics.position === 'fixed') return 'fixed'
  if (metrics.scrollDeficit > 1) return 'explicit-height'
  return null
}

/** Bound on how many internal re-measure passes one settle-triggered scan runs. */
export const MAX_UNROLL_PASSES = 3

/**
 * The stylesheet half. Unlayered + `!important` for the same reason as
 * `CanvasAnimationInjector`: `!important` beats non-`!important` regardless
 * of cascade layer, so this has to beat both `@layer user-authored` (author
 * CSS) and `@layer vendor` (`ProjectCssInjector`'s package CSS, WS-2.3) —
 * see `canvasCssLayers.ts`.
 *
 * Deliberately does NOT touch `html`/`body` `height` — that is owned by
 * `useIframeFrameAutoHeight`'s pin (`iframeBodyReset.ts` sets body's
 * definite height so `%` chains resolve; `useIframeFrameAutoHeight` grows
 * it). Forcing `body { height: auto !important }` here would win over that
 * pin's plain inline `body.style.height` write and collapse the percentage
 * basis every imported app shell depends on — the exact deadlock this
 * injector's docblock and the WS-8.2 work order call out. `body`'s own
 * `overflow: visible` is already set by `iframeBodyReset.ts`.
 *
 * `overflow`/`min-height` are SCOPED, not universal — this is the load-bearing
 * fix in this file, read the rest of this comment before touching it back.
 * ─────────────────────────────────────────────────────────────────────────
 * An earlier version forced `overflow: visible !important` and
 * `min-height: auto !important` on the universal `*` selector — every element
 * in the frame, unconditionally. Measured live against a real project: the
 * elements that selector was touching authored `overflow-y: hidden` roughly
 * 30x more often than `auto`/`scroll`. `overflow: hidden` is not scrolling,
 * it is CLIPPING, and authors rely on it for two everyday things a scroll
 * region has nothing to do with — rounded-corner clip masks (a card, an
 * avatar, a segmented-control track) and `text-overflow: ellipsis`
 * containers (a title, a subtitle, a nav label). Forcing those `visible`
 * doesn't "unroll" anything; it un-clips corners that were meant to be
 * clipped and stops long text from truncating — a real, visible regression
 * on every project with either pattern, which is most of them.
 *
 * So the override below only ever matches an element `snapshotAuthoredStyles`
 * (`CanvasScrollUnrollInjector.tsx`) has recorded as a genuine scroll region —
 * authored `overflow-y: auto` or `overflow-y: scroll` — via
 * `[${SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}="auto"|"scroll"]`. Anything else
 * (`hidden`, `clip`, the default `visible`) is never touched by this rule at
 * all: its authored `overflow` AND its authored `min-height` compute exactly
 * as written, honestly, because nothing here ever overrides them.
 *
 * This also happens to fix a second, related lie for free: a `min-height: 0`
 * authored on a `flex:1; overflow:hidden` element that is NOT itself the
 * scroll region (only its role is "shrink to fit available space", the real
 * scrolling happens in a child) used to compute `min-height: auto` on the
 * canvas — the opposite of what was written — even though it made no visual
 * difference (the automatic-minimum-is-content-size behaviour `auto` invokes
 * only fires when the item's OWN overflow is visible, which this element's
 * `hidden` was never forced to under the OLD universal-`overflow` rule
 * either... except the blanket `min-height` rule didn't know that, so it
 * still lied about the computed value). Under the new gate this element is
 * never touched at all, so it now, correctly, computes `min-height: 0`.
 * `.bottom-sheet__panel { flex: 1; min-height: 0; overflow: hidden }` — the
 * design system's fullscreen sheet shell, its OWN scroll region is the
 * nested `.bottom-sheet__content { overflow-y: auto }` — is exactly this
 * case, and is the regression this paragraph fixes.
 *
 * Frame-later, by design, same as `fixed`/`explicit-height` below: the
 * override needs `snapshotAuthoredStyles` to have run once (it reads a value
 * this same effect's stylesheet must not have already overwritten, so it
 * cannot run any earlier than the injector's own rAF-scheduled tagging pass).
 * A genuine scroll region therefore stays clipped for the one frame before
 * that pass lands, then unrolls — the `useIframeFrameAutoHeight` `ResizeObserver`
 * (watches BODY'S RENDERED SIZE, not the mutation that caused it) picks up
 * the resulting growth exactly the way it already does for `explicit-height`
 * tags, which have used this same timing model since they were added. Do NOT
 * "fix" this by trying to make the scope-check CSS-only (no JS) again — a
 * selector cannot ask "what did the author's stylesheet compute this
 * element's `overflow-y` to before ANY of our own rules ran", which is
 * exactly the question that has to be answered to tell a scroll region from
 * a clip mask.
 *
 * `scroll-behavior: auto !important` stays on the universal `*` selector —
 * unlike `overflow`/`min-height` it has no rendering-correctness downside for
 * a `hidden`/`visible`/`clip` element (it only affects the ANIMATION of a
 * programmatic scroll, never applicable to a non-scrolling box), so there is
 * no honesty cost to leaving it blanket, and no reason to delay it a frame.
 */
export function buildScrollUnrollRules(): string {
  return `
*,
*::before,
*::after {
  scroll-behavior: auto !important;
}
/* Only a CONFIRMED authored scroll region (recorded pre-override by
   snapshotAuthoredStyles) gets unrolled — see the long comment above for why
   this must not be the universal \`*\` selector. */
[${SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}="auto"],
[${SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}="scroll"] {
  overflow: visible !important;
  overflow-x: visible !important;
  overflow-y: visible !important;
  /* Overrides an authored \`min-height: 0\` on this \`flex: 1\` scroll region —
     that's the standard way authors make it shrinkable in the first place.
     Restoring the automatic (content-based) minimum size, now that overflow
     is visible, is what actually grows the region instead of just
     un-clipping it: a flex item's automatic minimum size resolves to its
     content size only when overflow is visible (CSS Flexbox §4.5). This also
     flattens a POSITIVE floor the same element might carry — the
     \`[${SCROLL_UNROLL_FLOOR_ATTR}]\` rule below hands that back. */
  min-height: auto !important;
}
/* Gives back a positive author-written \`min-height\` that the scroll-region
   reset above just flattened — see \`authoredMinHeightFloor\`. Placed BEFORE
   the \`explicit-height\` rule so that rule still wins on an element carrying
   both: its floor is the true content extent, which is the stronger claim. */
[${SCROLL_UNROLL_FLOOR_ATTR}] {
  min-height: var(${SCROLL_UNROLL_AUTHORED_MIN_HEIGHT_VAR}) !important;
}
/* Sticky/fixed chrome would float mid-frame once its own scroll container
   unrolls — there is no longer a bounded viewport for "fixed" to mean
   anything sensible relative to. The JS half tags qualifying elements;
   \`position: absolute\` (NOT \`static\`) keeps their authored top/left/right/
   bottom offsets meaningful, now resolved against \`body\` (already
   \`position: relative\`, see iframeBodyReset.ts) instead of the viewport.

   DELIBERATE, documented divergence from the published site: a genuinely
   \`position: fixed\` element in a REAL browser stays pinned to the visible
   viewport as the page scrolls past it — but on the canvas the whole page is
   unrolled into one tall, non-scrolling document, so there is no longer a
   distinct "viewport" for "fixed" to mean anything relative to. The
   alternative (leave it \`fixed\`) was considered and rejected: the iframe
   ELEMENT itself grows to the unrolled document's full height
   (\`useIframeFrameAutoHeight\`), and a real \`position: fixed\` fixes to THAT
   grown iframe viewport, not to a stable 800px slice of it — a bottom tab
   bar would end up pinned to the bottom of the full unrolled page (often
   several thousand px down), nowhere near the device-screen chrome it is
   meant to overlay. Rewriting to \`absolute\`, anchored against \`body\` at
   its pinned \`CANVAS_VIEWPORT_HEIGHT\` (the same representative device
   height \`resolveViewportUnits.ts\` resolves \`vh\` against), keeps the
   authored offsets meaningful relative to that SAME representative screen
   instead — the nav bar renders once, at the bottom of the first "screen" of
   content, which is what the design actually looks like on a real device. */
[${SCROLL_UNROLL_ATTR}="fixed"] {
  position: absolute !important;
}
/* An inner panel with an explicit clipping height (\`height: 100vh\` etc.)
   that a plain \`min-height: auto\` cannot fix because it isn't a flex item —
   the JS half measures the panel's original box height into the custom
   property below before releasing \`height\`, so nothing shrinks, only grows.

   Verified this does not depend on the scroll-region scope above:
   \`scrollHeight\` reports an element's TRUE content extent (including
   content clipped by \`overflow: hidden\`) regardless of that element's own
   overflow value — only \`overflow: visible\` collapses \`scrollHeight\` to
   \`clientHeight\`. So this tag correctly measures and grows a clipping
   \`overflow: hidden\` panel exactly as it does an \`overflow: auto\` one.

   Known, accepted limitation, not fixed here: this rule cannot distinguish
   "a panel clipping its OWN overflow content" (the case it exists for) from
   "an intentionally undersized crop frame around oversized, non-
   \`object-fit\`-scaled media" (e.g. a fixed-height \`overflow: hidden\` image
   container holding a taller-than-container \`<img>\` with no
   \`object-fit: cover\`) — both present as a real \`scrollDeficit\` and both
   get stretched to their full content height. No live case of the second
   shape was found on the audited project (its image-crop containers use
   \`object-fit: cover\`, which does not inflate \`scrollHeight\` since the
   image's OWN box still matches its container). If a future project hits
   this, the fix is scoping THIS tag by authored overflow the same way the
   rule above was, not reverting this rule. */
[${SCROLL_UNROLL_ATTR}="explicit-height"] {
  height: auto !important;
  min-height: var(${SCROLL_UNROLL_MIN_HEIGHT_VAR}) !important;
}
`.trim()
}
