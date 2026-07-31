/**
 * Pure decision helpers for `CanvasScrollUnrollInjector`. Split out from the
 * component so the classification logic is unit-testable without a real
 * browser layout engine — mirrors `resolveFrameFitHeight.ts` /
 * `resolveCanvasFrameHeight` next to it, which do the same for frame height.
 */

/** The tag `CanvasScrollUnrollInjector` writes onto elements it has adjusted. */
export const SCROLL_UNROLL_ATTR = 'data-studio-unroll'

/**
 * Carries each element's PRE-unroll `overflow-y` — the value `getComputedStyle`
 * would report if this injector's own blanket `overflow: visible !important`
 * rule did not exist. That rule is unconditional and mounts before any
 * measurement pass ever runs, so by the time JS looks, EVERY element already
 * computes to `visible` — the injector has destroyed the very signal
 * `collectScrollDeficits` (`resolveFrameFitHeight.ts`) needs to tell a
 * genuine author-authored `auto`/`scroll` region (content this injector is
 * actively un-clipping) from an element that was always plain `visible` (a
 * harmless sub-pixel line-height/box-height mismatch on a badge or title
 * row). See `STATE.md`'s `canvas-02`/`test-01`/`canvas-04` for the full
 * history — broadening `collectScrollDeficits`'s gate to "everything counts"
 * swept up exactly that false-positive class and made a real frame render
 * blank. Recording the TRUE original value here, instead, lets that gate
 * stay narrow (`auto`/`scroll` only) while still seeing through this
 * injector's own override.
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
 * `overflow: visible` is already set by `iframeBodyReset.ts`; the universal
 * `*` rule below still matches `html`/`body` for the harmless properties
 * (`overflow-x/y`, `scroll-behavior`, `min-height`, which no-op on a
 * non-flex-item root), just never for `height`.
 */
export function buildScrollUnrollRules(): string {
  return `
*,
*::before,
*::after {
  overflow: visible !important;
  overflow-x: visible !important;
  overflow-y: visible !important;
  scroll-behavior: auto !important;
  /* Overrides an authored \`min-height: 0\` on a \`flex: 1\` scroll region —
     that's the standard way authors make such a region shrinkable in the
     first place. Restoring the automatic (content-based) minimum size, now
     that overflow is visible, is what actually grows the region instead of
     just un-clipping it: a flex item's automatic minimum size resolves to
     its content size only when overflow is visible (CSS Flexbox §4.5). */
  min-height: auto !important;
}
/* Sticky/fixed chrome would float mid-frame once its own scroll container
   unrolls — there is no longer a bounded viewport for "fixed" to mean
   anything sensible relative to. The JS half tags qualifying elements;
   \`position: absolute\` (NOT \`static\`) keeps their authored top/left/right/
   bottom offsets meaningful, now resolved against \`body\` (already
   \`position: relative\`, see iframeBodyReset.ts) instead of the viewport. */
[${SCROLL_UNROLL_ATTR}="fixed"] {
  position: absolute !important;
}
/* An inner panel with an explicit clipping height (\`height: 100vh\` etc.)
   that a plain \`min-height: auto\` cannot fix because it isn't a flex item —
   the JS half measures the panel's original box height into the custom
   property below before releasing \`height\`, so nothing shrinks, only grows. */
[${SCROLL_UNROLL_ATTR}="explicit-height"] {
  height: auto !important;
  min-height: var(${SCROLL_UNROLL_MIN_HEIGHT_VAR}) !important;
}
`.trim()
}
