/**
 * scrollUnrollRules — turns every scroll region inside a DESIGN-mode frame
 * into a content-sized block, so the frame shows the whole screen instead of
 * a scrollable box. Shared by the portal-mode `CanvasScrollUnrollInjector`
 * (same-origin iframe holding a portaled React tree) and the in-frame live
 * runtime (`runtime.ts`, cross-origin — this module ships inside that bundle
 * too, so it stays free of admin/store imports).
 *
 * ## Why
 *
 * An imported app shell is routinely `html, body, #root { height: 100% }`
 * with a `flex: 1; overflow: auto` region doing the actual scrolling — a
 * pattern that makes total sense for a real browser viewport. Rendered
 * inside a fixed-height design frame, that region clips exactly the way it's
 * built to: everything past the fold is only reachable by scrolling inside
 * the frame, which the canvas cannot allow anyway (wheel events over a
 * design frame are the ones the canvas needs for pan/zoom). "Unrolling"
 * turns that clipped scroll box back into a tall, whole screen.
 *
 * `buildScrollUnrollRules` handles the common case with pure CSS: an
 * `overflow-y: auto`/`scroll` flex region with an authored `min-height: 0`
 * (how authors make a `flex: 1` region shrinkable/scrollable in the first
 * place) becomes content-sized once overflow is visible and its automatic
 * minimum size is restored — SCOPED to elements `snapshotAuthoredStyles` has
 * recorded as authoring `overflow-y: auto`/`scroll`, never a universal `*`
 * rule (see that function's own doc for the measured evidence).
 *
 * Two things a stylesheet alone cannot do, so `startScrollUnroll` runs a
 * bounded JS "tag-then-style" pass:
 *
 *   1. `position: fixed` chrome has nothing sensible to be "fixed" relative
 *      to once the page it floats over is no longer a bounded viewport.
 *   2. A panel with an EXPLICIT clipping height (`height: 100vh`) that is not
 *      itself a flex item doesn't respond to `min-height: auto` — it needs
 *      `height: auto` plus a `min-height` floor set to its own true content
 *      extent (`scrollHeight`), measured before any mutation.
 *
 * Both need `getComputedStyle` + a real layout read, so both are tag-then-
 * style: the JS pass measures and writes `SCROLL_UNROLL_ATTR` (+
 * `SCROLL_UNROLL_MIN_HEIGHT_VAR` for case 2), and the stylesheet does the
 * actual override off that tag.
 *
 * **Never writes `body`'s or `html`'s `height`** — that is owned by the
 * frame's own auto-height pin (a definite `body.style.height` so `%` chains
 * resolve). This module only ever touches DESCENDANTS of `body`
 * (`body.querySelectorAll('*')` cannot select `body`/`html` themselves), so
 * unrolling a nested `height: 100%` block grows `body.scrollHeight`, which is
 * exactly the signal the frame's own auto-height measurement already
 * watches. See `docs/agent-refs/canvas-internals.md`'s "Height, and the
 * feedback loop" for the full pin/unroll contract.
 */

/** The tag `startScrollUnroll` writes onto elements it has adjusted. */
export const SCROLL_UNROLL_ATTR = 'data-studio-unroll'

/**
 * Carries each element's PRE-unroll `overflow-y` — recorded before any
 * override CSS can touch it. Two independent consumers:
 *
 * 1. `collectScrollDeficits` (`resolveFrameFitHeight.ts`) needs it to tell a
 *    genuine author-authored `auto`/`scroll` region (content being actively
 *    un-clipped) from an element that was always plain `visible` (a harmless
 *    sub-pixel line-height/box-height mismatch).
 * 2. `buildScrollUnrollRules` below uses the SAME `auto`/`scroll` values as
 *    the selector that decides which elements get `overflow: visible` and
 *    `min-height: auto` at all. An element authoring `overflow-y: hidden` —
 *    a rounded-corner clip mask, a `text-overflow: ellipsis` container — is
 *    not a scroll region; forcing it visible does not "unroll" anything, it
 *    just breaks the clip. Measured live: `overflow-y: hidden` outnumbered
 *    `overflow-y: auto`/`scroll` roughly 30:1 among elements this pass was
 *    touching, and every one of those `hidden` elements lost its
 *    rounded-corner clip or its text ellipsis on the canvas. Recording the
 *    ONE true original value here and reusing it for both jobs keeps "is
 *    this genuinely a scroll region" answered exactly once, honestly, in one
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
 * never can be.
 */
export const SCROLL_UNROLL_MIN_HEIGHT_VAR = '--studio-unroll-min-height'

/**
 * Marks an element whose author gave it a POSITIVE `min-height` floor, so the
 * scroll-region `min-height: auto !important` rule below (scoped by
 * {@link SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}) can be undone for it alone.
 *
 * Only ever set on an element that is ALSO a genuine scroll region (authored
 * `overflow-y: auto`/`scroll`). Separate from {@link SCROLL_UNROLL_ATTR} on
 * purpose, and deliberately NOT cleared by `clearUnrollTags`: the two answer
 * different questions and change on different schedules. A tag records what
 * this pass DECIDED from live geometry (re-derived every settle); this
 * records what the AUTHOR WROTE, which does not change just because our own
 * fix ran.
 */
export const SCROLL_UNROLL_FLOOR_ATTR = 'data-studio-unroll-floor'

/**
 * Carries the author's own `min-height` for a {@link SCROLL_UNROLL_FLOOR_ATTR}
 * element, read back by the stylesheet.
 */
export const SCROLL_UNROLL_AUTHORED_MIN_HEIGHT_VAR = '--studio-unroll-authored-min-height'

/**
 * The author's `min-height` when it is a real floor worth preserving against
 * the scroll-region reset, else `null`.
 *
 * This function is ONLY ever consulted for an element already confirmed to
 * be a genuine authored scroll region (`overflow-y: auto`/`scroll`) — an
 * element that is NOT a scroll region never reaches the `min-height: auto
 * !important` rule this function's result feeds AT ALL (see
 * `buildScrollUnrollRules`), so its authored `min-height` — `0` included —
 * is never touched, restored, or even inspected.
 *
 * WITHIN that narrowed scope, `auto` and non-positive values (`0`, a negative
 * length, anything unparsable) are exactly what the reset exists to
 * neutralise: `min-height: 0` on a `flex: 1; overflow-y: auto` region is the
 * standard way an author makes it shrinkable in the first place, and
 * restoring that automatic minimum — now that overflow is visible — is what
 * actually grows the region. Anything POSITIVE is a designed floor and the
 * reset was never meant to touch it, even on a genuine scroll region.
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
  /**
   * The element's AUTHORED `overflow-y` — `getComputedStyle` read before any
   * override (this pass's own, or an earlier tag's) can touch it. `'visible'`
   * (the CSS default) excludes `'explicit-height'` below — see that branch's
   * own comment for why.
   */
  originalOverflowY: string
}

/**
 * What (if anything) an element needs tagged, given its current geometry.
 *
 * `fixed` wins over `explicit-height`: a fixed bottom-nav / header is pinned
 * by position, not resized. Sub-pixel deficits are rounding noise from a
 * fractional layout, not hidden content worth acting on (`<= 1` tolerance).
 *
 * `'explicit-height'` additionally requires the element's AUTHORED
 * `overflow-y` to be something OTHER than `'visible'`. A `display: flex;
 * width: 24px; height: 24px` icon frame around an intrinsically larger,
 * un-scaled SVG (`overflow-y` never set — the CSS default, `visible`)
 * reports a real, positive `scrollHeight - clientHeight` deficit in a real
 * browser even though nothing is clipped. An element authoring
 * `overflow-y: visible` was never hiding content in the first place — there
 * is nothing this pass's whole *purpose* ("reveal content a fixed/clipping
 * box would otherwise hide") applies to. `hidden`/`clip`/`auto`/`scroll` all
 * stay eligible: a fixed-height `overflow: hidden` panel genuinely clipping
 * its own taller content authors `hidden`, not `visible`, so this gate
 * leaves it untouched.
 */
export function classifyUnrollElement(metrics: UnrollElementMetrics): ScrollUnrollTag | null {
  if (metrics.position === 'fixed') return 'fixed'
  if (metrics.scrollDeficit > 1 && metrics.originalOverflowY !== 'visible') return 'explicit-height'
  return null
}

/** Bound on how many internal re-measure passes one settle-triggered scan runs. */
export const MAX_UNROLL_PASSES = 3

/**
 * The stylesheet half. Unlayered + `!important` for the same reason as
 * `CanvasAnimationInjector`: `!important` beats non-`!important` regardless
 * of cascade layer, so this has to beat both `@layer user-authored` (author
 * CSS) and `@layer vendor` (package CSS).
 *
 * `overflow`/`min-height` are SCOPED, not universal — only an element
 * `snapshotAuthoredStyles` has recorded as a genuine scroll region (authored
 * `overflow-y: auto` or `overflow-y: scroll`) is ever touched. Anything else
 * (`hidden`, `clip`, the default `visible`) computes exactly as written.
 *
 * `scroll-behavior: auto !important` stays on the universal `*` selector —
 * unlike `overflow`/`min-height` it has no rendering-correctness downside for
 * a non-scrolling element (it only affects the ANIMATION of a programmatic
 * scroll), so there is no honesty cost to leaving it blanket.
 */
export function buildScrollUnrollRules(): string {
  return `
*,
*::before,
*::after {
  scroll-behavior: auto !important;
}
/* Only a CONFIRMED authored scroll region (recorded pre-override by
   snapshotAuthoredStyles) gets unrolled. */
[${SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}="auto"],
[${SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}="scroll"] {
  overflow: visible !important;
  overflow-x: visible !important;
  overflow-y: visible !important;
  /* Overrides an authored \`min-height: 0\` on this \`flex: 1\` scroll region —
     that's the standard way authors make it shrinkable in the first place.
     This also flattens a POSITIVE floor the same element might carry — the
     \`[${SCROLL_UNROLL_FLOOR_ATTR}]\` rule below hands that back. */
  min-height: auto !important;
}
/* Gives back a positive author-written \`min-height\` that the scroll-region
   reset above just flattened. Placed BEFORE the \`explicit-height\` rule so
   that rule still wins on an element carrying both: its floor is the true
   content extent, which is the stronger claim. */
[${SCROLL_UNROLL_FLOOR_ATTR}] {
  min-height: var(${SCROLL_UNROLL_AUTHORED_MIN_HEIGHT_VAR}) !important;
}
/* Sticky/fixed chrome would float mid-frame once its own scroll container
   unrolls. \`position: absolute\` (NOT \`static\`) keeps authored top/left/
   right/bottom offsets meaningful, now resolved against \`body\` instead of
   the viewport — a DELIBERATE, documented divergence from the published
   site (see \`CanvasScrollUnrollInjector.tsx\`'s doc for the full argument). */
[${SCROLL_UNROLL_ATTR}="fixed"] {
  position: absolute !important;
}
/* An inner panel with an explicit clipping height that a plain
   \`min-height: auto\` cannot fix because it isn't a flex item — the JS half
   measures the panel's original box height into the custom property below
   before releasing \`height\`, so nothing shrinks, only grows. */
[${SCROLL_UNROLL_ATTR}="explicit-height"] {
  height: auto !important;
  min-height: var(${SCROLL_UNROLL_MIN_HEIGHT_VAR}) !important;
}
`.trim()
}

/**
 * Records what the AUTHOR's own CSS says, before any override hides it — two
 * values, read in the same pass because both need the same trick to be
 * readable at all.
 *
 * By the time this pass runs, the caller's own scoped stylesheet (identified
 * by `styleElementId`) may already be overriding a PREVIOUSLY-tagged
 * element's computed `overflow-y`/`min-height` — so a plain
 * `getComputedStyle` read here would see that override instead of the
 * author's value. Disabling the stylesheet for the duration of one
 * synchronous batch read (no paint happens between the two toggles) recovers
 * what the author's own CSS, plus every OTHER stylesheet, actually computes.
 *
 * Idempotent per element (skips anything already recorded) rather than
 * re-derived every settle: the AUTHOR's CSS doesn't change between settles
 * just because this pass ran — only brand-new elements from a later DOM edit
 * need a first recording, which the `hasAttribute` guard picks up on the
 * next settle. `clearUnrollTags` leaves both of these alone.
 */
function snapshotAuthoredStyles(doc: Document, styleElementId: string): void {
  const view = doc.defaultView
  const body = doc.body
  if (!view || !body) return
  const styleEl = doc.getElementById(styleElementId) as HTMLStyleElement | null
  const wasDisabled = styleEl?.disabled ?? false
  if (styleEl) styleEl.disabled = true
  for (const el of body.querySelectorAll<HTMLElement>('*')) {
    if (el.hasAttribute(SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR)) continue
    const computed = view.getComputedStyle(el)
    const overflowY = computed.overflowY
    el.setAttribute(SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR, overflowY)
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue
    const floor = authoredMinHeightFloor(computed.minHeight)
    if (floor === null) continue
    // Value first, then the marker: the rule keyed off the marker reads the
    // property, so setting them the other way round would resolve `var()`
    // against an ancestor's inherited value for one frame.
    el.style.setProperty(SCROLL_UNROLL_AUTHORED_MIN_HEIGHT_VAR, floor)
    el.setAttribute(SCROLL_UNROLL_FLOOR_ATTR, '')
  }
  if (styleEl) styleEl.disabled = wasDisabled
}

/**
 * One full-subtree measure-and-tag pass. Only tags elements not already
 * tagged this settle — returns whether it tagged anything new.
 */
function runUnrollPass(doc: Document): boolean {
  const view = doc.defaultView
  const body = doc.body
  if (!view || !body) return false

  let changed = false
  // Never `body`/`html` themselves — querySelectorAll on body only returns
  // descendants, which is exactly the boundary the pin-interaction contract
  // depends on.
  for (const el of body.querySelectorAll<HTMLElement>('*')) {
    if (el.hasAttribute(SCROLL_UNROLL_ATTR)) continue
    const computed = view.getComputedStyle(el)
    // Capture BOTH metrics now, before this element (or any later sibling)
    // is mutated — `scrollHeight` is what gets baked in as the min-height
    // floor below.
    const clientHeight = el.clientHeight
    const scrollHeight = el.scrollHeight
    const originalOverflowY = el.getAttribute(SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR) ?? ''
    const tag = classifyUnrollElement({
      position: computed.position,
      scrollDeficit: scrollHeight - clientHeight,
      clientHeight,
      originalOverflowY,
    })
    if (tag === null) continue
    el.setAttribute(SCROLL_UNROLL_ATTR, tag)
    if (tag === 'explicit-height') {
      // Use the metrics captured ABOVE, before `setAttribute` — see this
      // module's docblock ("Deliberately `scrollHeight`, not `clientHeight`")
      // for why a fresh re-read here would inherit an ancestor's value.
      el.style.setProperty(SCROLL_UNROLL_MIN_HEIGHT_VAR, `${scrollHeight}px`)
    }
    changed = true
  }
  return changed
}

function clearUnrollTags(doc: Document): void {
  for (const el of doc.querySelectorAll<HTMLElement>(`[${SCROLL_UNROLL_ATTR}]`)) {
    el.removeAttribute(SCROLL_UNROLL_ATTR)
    el.style.removeProperty(SCROLL_UNROLL_MIN_HEIGHT_VAR)
  }
}

/**
 * Re-measures and re-tags up to `MAX_UNROLL_PASSES` times in one settle.
 * Ancestors are visited before descendants (`querySelectorAll` returns
 * document order). Tags are MONOTONIC within one settle — a pass only ever
 * ADDS a tag, never removes one another pass in this same run just applied
 * (re-classifying from a POST-fix measurement would see "no deficit anymore"
 * and remove the very tag that resolved it, forever). `clearUnrollTags`
 * re-derives from scratch only at the START of the next settle.
 */
export function runUnrollPasses(doc: Document, styleElementId: string): void {
  snapshotAuthoredStyles(doc, styleElementId)
  clearUnrollTags(doc)
  for (let pass = 0; pass < MAX_UNROLL_PASSES; pass += 1) {
    const changed = runUnrollPass(doc)
    if (!changed) return
  }
}

export interface ScrollUnrollController {
  dispose(): void
}

/**
 * Starts the full behaviour in `doc`: mounts the stylesheet, runs a settle
 * pass, and watches for further DOM mutations (bounded to one
 * `requestAnimationFrame`-coalesced scan per settle — never per pointermove,
 * matching the frame's own auto-height hook).
 *
 * `dispose()` cancels any pending scan, disconnects the observer, clears
 * every tag this pass wrote, and removes the stylesheet — a disabled/torn-
 * down frame has zero residual behaviour.
 *
 * `dataSource` is written onto the `<style>` element's `data-source`
 * attribute purely for DOM-inspection debugging — each caller (the portal
 * injector, the live runtime) names itself so a real board's devtools shows
 * which one owns a given stylesheet.
 */
export function startScrollUnroll(
  doc: Document,
  styleElementId: string,
  dataSource = 'scrollUnrollRules',
): ScrollUnrollController {
  let styleEl = doc.getElementById(styleElementId) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = doc.createElement('style')
    styleEl.id = styleElementId
    styleEl.setAttribute('data-source', dataSource)
    doc.head?.appendChild(styleEl)
  }
  styleEl.textContent = buildScrollUnrollRules()

  const view = doc.defaultView
  const raf = view?.requestAnimationFrame?.bind(view) ?? requestAnimationFrame
  const cancelRaf = view?.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame

  let rafId: number | null = null
  const schedulePass = () => {
    if (rafId !== null) return
    rafId = raf(() => {
      rafId = null
      runUnrollPasses(doc, styleElementId)
    })
  }

  let observer: MutationObserver | null = null
  if (doc.body) {
    schedulePass()
    const MutationObserverCtor = view?.MutationObserver ?? MutationObserver
    try {
      observer = new MutationObserverCtor(() => schedulePass())
      // childList/subtree only — deliberately NOT observing `attributes`:
      // this pass's own writes (the data-* tag, the custom property) are
      // attribute mutations, and watching them would self-trigger forever.
      observer.observe(doc.body, { childList: true, subtree: true })
    } catch (_err) {
      // Some browser realms reject observing a cross-realm node from this
      // context. The scheduled pass above still covers the DOM at start.
      observer?.disconnect()
      observer = null
    }
  }

  return {
    dispose() {
      if (rafId !== null) cancelRaf(rafId)
      observer?.disconnect()
      clearUnrollTags(doc)
      doc.getElementById(styleElementId)?.remove()
    },
  }
}
