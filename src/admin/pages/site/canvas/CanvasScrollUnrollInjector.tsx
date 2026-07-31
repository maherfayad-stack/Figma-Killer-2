/**
 * CanvasScrollUnrollInjector — turns every scroll region inside a DESIGN
 * canvas frame into a content-sized block, so the frame shows the whole
 * screen instead of a scrollable box.
 *
 * Why
 * ───
 * An imported app shell is routinely `html, body, #root { height: 100% }`
 * with a `flex: 1; overflow: auto` region doing the actual scrolling — a
 * pattern that makes total sense for a real browser viewport. Rendered
 * inside a fixed-height design frame, that region clips exactly the way it's
 * built to: everything past the fold is only reachable by scrolling inside
 * the frame, which the canvas cannot allow anyway (wheel events over a frame
 * are the ones `useCanvas` needs for pan/zoom — see `IframeFrameSurface`'s
 * wheel-forwarding effect). "Unrolling" turns that clipped scroll box back
 * into a tall, whole screen.
 *
 * The stylesheet half (see `canvasScrollUnroll.ts` → `buildScrollUnrollRules`)
 * handles the common case: an `overflow: auto` flex region with an authored
 * `min-height: 0` (how authors make a `flex: 1` region shrinkable/scrollable
 * in the first place) becomes content-sized once overflow is visible and its
 * automatic minimum size is restored.
 *
 * Two things a stylesheet alone cannot do, so they're the JS half:
 *
 *   1. `position: fixed` chrome (a bottom nav, a sticky header) has nothing
 *      sensible to be "fixed" relative to once the page it was floating over
 *      is no longer a bounded viewport — turning it `position: static` would
 *      reflow it into the document, which is not what the app looks like.
 *      `position: absolute` (pinned via the SAME authored top/left/right/
 *      bottom offsets, now resolved against `body`) keeps it visually where
 *      the author put it. Detecting "is this fixed" needs `getComputedStyle`
 *      — no selector matches on a computed value.
 *   2. A panel with an EXPLICIT clipping height (`height: 100vh`) that is
 *      not itself a flex item doesn't respond to `min-height: auto` (that
 *      only has special content-based resolution for flex/grid items — CSS
 *      Flexbox §4.5). It needs `height: auto` plus a `min-height` floor set
 *      to its OWN true content extent (`scrollHeight`), which has to be
 *      MEASURED before the override is written — and specifically before
 *      ANY mutation this same pass makes, ancestor or self (see
 *      `SCROLL_UNROLL_MIN_HEIGHT_VAR`'s own doc for why re-reading
 *      `clientHeight` afterward silently inherits an unrelated ancestor's
 *      value instead).
 *
 * Both need `getComputedStyle` + a real layout read, so both are tag-then-
 * style: the JS pass measures and writes a `data-studio-unroll` attribute
 * (+ a `--studio-unroll-min-height` custom property for case 2), and the
 * STYLESHEET does the actual override off that tag. This keeps "detect" and
 * "apply" in the two places they belong and makes both independently
 * testable — `canvasScrollUnroll.test.ts` covers the pure classification,
 * this file covers the DOM wiring.
 *
 * Cost is bounded: one full-subtree pass per DOM settle (`MutationObserver`
 * → a single `requestAnimationFrame`-coalesced scan, with a small bounded
 * retry loop — see `MAX_UNROLL_PASSES` — so a multi-level plain-block
 * `height: 100%` chain, which needs its ancestors fixed in DOCUMENT order
 * before the next one up can be correctly measured, converges within one
 * settle instead of needing a further DOM edit to trigger a second pass).
 * It never runs per animation frame and never per pointermove — the same
 * "measure and write only inside a rAF boundary, never continuously" rule
 * `useIframeFrameAutoHeight` follows for the same reason.
 *
 * The pin ⇄ unroll interaction
 * ─────────────────────────────
 * `useIframeFrameAutoHeight` pins `body`'s height to a definite px value so
 * `%` chains resolve, then grows the OUTER iframe element to
 * `body.scrollHeight` / `documentElement.scrollHeight`. This injector never
 * writes `body`'s or `html`'s `height` (see the long comment in
 * `buildScrollUnrollRules`) — it only ever touches DESCENDANTS of `body`
 * (`doc.body.querySelectorAll('*')` cannot select `body` or `html`
 * themselves). Unrolling a nested `height: 100%` block makes it grow past
 * `body`'s CURRENT pinned height, `body` stays `overflow: visible` (already
 * true — `iframeBodyReset.ts`), so `body.scrollHeight` now reports the
 * larger content height, which is exactly the signal
 * `useIframeFrameAutoHeight`'s own measurement already watches to grow the
 * visible frame. The two systems compose through that one shared number
 * instead of fighting over who owns `body`'s height. See
 * `canvasScrollUnrollPinInteraction.test.tsx` for the regression coverage.
 *
 * What this does NOT handle
 * ──────────────────────────
 * - Elements whose `position: fixed` (or clipping height) is applied by a
 *   class/style-attribute toggle on an EXISTING element, with no node
 *   inserted or removed, won't be re-tagged until some LATER DOM edit
 *   triggers a settle pass — this mirrors `useIframeFrameAutoHeight`'s own
 *   `MutationObserver`, which also only watches `childList`/`characterData`,
 *   not `style`/`class` attribute changes (watching `style` here specifically
 *   would also self-trigger on this injector's own tagging writes).
 * - A deeply-nested chain of plain (non-flex-item) `height: 100%` blocks,
 *   more levels than `MAX_UNROLL_PASSES`, may need a further DOM settle to
 *   fully converge.
 * - Animated GIF/WebP/APNG, JS-driven animation (framer-motion, GSAP), and
 *   `<canvas>`/WebGL loops are unaffected — same reasons as documented in
 *   `CanvasAnimationInjector`.
 *
 * Scope
 * ─────
 * Design frames only, and only while `enabled` (default on — see
 * `IframeFrameSurface`). Never mounted in live/preview mode, never reaches
 * the publisher: this is an iframe-only `<style>` + `data-*` tagging pass,
 * not a page-tree mutation, and none of it is written back to source.
 */

import { useEffect } from 'react'
import {
  buildScrollUnrollRules,
  classifyUnrollElement,
  MAX_UNROLL_PASSES,
  SCROLL_UNROLL_ATTR,
  SCROLL_UNROLL_MIN_HEIGHT_VAR,
  SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR,
} from './canvasScrollUnroll'

const STYLE_TAG_ID = 'studio-canvas-scroll-unroll'

interface CanvasScrollUnrollInjectorProps {
  /** The iframe document to inject the stylesheet + tagging pass into. */
  targetDocument: Document
  /** Toggleable per board ("Unroll scroll" in the canvas toolbar). Default on. */
  enabled?: boolean
}

export function CanvasScrollUnrollInjector({
  targetDocument,
  enabled = true,
}: CanvasScrollUnrollInjectorProps) {
  // Stylesheet: mounted only while enabled, removed (not left inert) when
  // toggled off so a disabled board has zero residual behaviour.
  useEffect(() => {
    if (!enabled) {
      targetDocument.getElementById(STYLE_TAG_ID)?.remove()
      return
    }
    let styleEl = targetDocument.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDocument.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'CanvasScrollUnrollInjector')
      targetDocument.head.appendChild(styleEl)
    }
    styleEl.textContent = buildScrollUnrollRules()
    return () => {
      targetDocument.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument, enabled])

  // Tagging pass: position:fixed → data-studio-unroll="fixed"; a clipping
  // explicit-height panel → data-studio-unroll="explicit-height" + the
  // measured min-height custom property.
  useEffect(() => {
    if (!enabled || !targetDocument.body) return
    const doc = targetDocument
    const view = doc.defaultView
    const raf = view?.requestAnimationFrame?.bind(view) ?? requestAnimationFrame
    const cancelRaf = view?.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame

    let rafId: number | null = null
    const schedulePass = () => {
      if (rafId !== null) return
      rafId = raf(() => {
        rafId = null
        runUnrollPasses(doc)
      })
    }

    schedulePass()

    const MutationObserverCtor = view?.MutationObserver ?? MutationObserver
    let observer: MutationObserver | null = null
    try {
      observer = new MutationObserverCtor(() => schedulePass())
      // childList/subtree only — matches useIframeFrameAutoHeight's own
      // observer. Deliberately NOT observing `attributes`: this pass's own
      // writes (the data-* tag, the custom property) are attribute
      // mutations, and watching them would self-trigger every pass forever.
      observer.observe(doc.body, { childList: true, subtree: true })
    } catch (_err) {
      // Some browser realms reject observing a cross-realm node from this
      // context (mirrors iframeFrameObservers.ts). The scheduled pass above
      // still covers the DOM as it exists at mount.
      observer?.disconnect()
      observer = null
    }

    return () => {
      if (rafId !== null) cancelRaf(rafId)
      observer?.disconnect()
      clearUnrollTags(doc)
    }
  }, [targetDocument, enabled])

  return null
}

/**
 * Re-measures and re-tags up to `MAX_UNROLL_PASSES` times in one settle.
 * Ancestors are visited before descendants (`querySelectorAll` returns
 * document order). A parent's true deficit can depend on a child that this
 * SAME pass hasn't reached yet (an outer plain `height: 100%` block wrapping
 * an inner one — the outer's scrollHeight only reflects the inner's fixed,
 * grown height once the inner has actually been fixed), so re-scanning
 * catches what the first pass measured too early, without waiting for a
 * further, unrelated DOM edit to trigger the next settle.
 *
 * Tags are MONOTONIC within one settle — a pass only ever ADDS a tag, never
 * removes one another pass in this same run just applied. This is load-
 * bearing, not a simplification: once a tag applies, the stylesheet rule it
 * activates changes the element's OWN measured geometry (that's the whole
 * point — `height: auto` makes it grow to content), so re-classifying it
 * from a POST-fix measurement would see "no deficit anymore" and remove the
 * very tag that resolved it, which reapplies the deficit, which reapplies
 * the tag, forever. `clearUnrollTags` re-derives from scratch only at the
 * START of the next MUTATION-triggered settle (mirrors
 * `useIframeFrameAutoHeight` resetting its own pin on a foreign mutation),
 * never mid-convergence.
 */
function runUnrollPasses(doc: Document): void {
  snapshotOriginalOverflow(doc)
  clearUnrollTags(doc)
  for (let pass = 0; pass < MAX_UNROLL_PASSES; pass += 1) {
    const changed = runUnrollPass(doc)
    if (!changed) return
  }
}

/**
 * Records each element's TRUE pre-unroll `overflow-y` onto
 * `SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR` before `collectScrollDeficits`
 * (`resolveFrameFitHeight.ts`) ever needs to read it. By the time this pass
 * runs, this component's OWN blanket stylesheet (mounted in the effect
 * above, in the same commit) has already forced every element's computed
 * `overflow-y` to `visible` — so a plain `getComputedStyle` read here would
 * see the very override we're trying to see past. Disabling the stylesheet
 * for the duration of one synchronous batch read (no paint happens between
 * the two toggles — this is all inside one JS task) recovers what the
 * author's own CSS, plus every OTHER injector, actually computes.
 *
 * Idempotent per element (skips anything already recorded) rather than
 * re-derived every settle like the tag attributes below: the AUTHOR's CSS
 * doesn't change between settles just because our own fix ran, so the
 * recorded value stays correct — only brand-new elements from a later DOM
 * edit need a first recording, which the `hasAttribute` guard picks up on
 * the next settle this same function runs for.
 */
function snapshotOriginalOverflow(doc: Document): void {
  const view = doc.defaultView
  const body = doc.body
  if (!view || !body) return
  const styleEl = doc.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
  const wasDisabled = styleEl?.disabled ?? false
  if (styleEl) styleEl.disabled = true
  for (const el of body.querySelectorAll<HTMLElement>('*')) {
    if (el.hasAttribute(SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR)) continue
    el.setAttribute(SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR, view.getComputedStyle(el).overflowY)
  }
  if (styleEl) styleEl.disabled = wasDisabled
}

/**
 * One full-subtree measure-and-tag pass. Only tags elements not already
 * tagged this settle (see the monotonic-tagging note above) — returns
 * whether it tagged anything new.
 */
function runUnrollPass(doc: Document): boolean {
  const view = doc.defaultView
  const body = doc.body
  if (!view || !body) return false

  let changed = false
  // Never `body`/`html` themselves — querySelectorAll on body only returns
  // descendants, which is exactly the boundary the pin-interaction contract
  // above depends on.
  for (const el of body.querySelectorAll<HTMLElement>('*')) {
    if (el.hasAttribute(SCROLL_UNROLL_ATTR)) continue
    const computed = view.getComputedStyle(el)
    // Capture BOTH metrics now, before this element (or any later sibling)
    // is mutated — `scrollHeight` is what gets baked in as the min-height
    // floor below. See the long comment at the write site for why re-reading
    // either metric after `setAttribute` is wrong.
    const clientHeight = el.clientHeight
    const scrollHeight = el.scrollHeight
    const tag = classifyUnrollElement({
      position: computed.position,
      scrollDeficit: scrollHeight - clientHeight,
      clientHeight,
    })
    if (tag === null) continue
    el.setAttribute(SCROLL_UNROLL_ATTR, tag)
    if (tag === 'explicit-height') {
      // Use the metrics captured ABOVE, before `setAttribute` — not a fresh
      // `el.clientHeight` re-read here. `querySelectorAll` visits ancestors
      // before descendants, so by the time a deep descendant is processed
      // in THIS SAME pass, an ancestor higher up may already have been
      // tagged and had ITS `--studio-unroll-min-height` custom property set
      // moments ago. Custom properties inherit — re-reading `clientHeight`
      // AFTER this element's own `setAttribute` activates
      // `[data-studio-unroll="explicit-height"] { height: auto !important;
      // min-height: var(--studio-unroll-min-height) !important }` on ITSELF
      // resolves that `min-height` against the INHERITED ancestor value
      // (this element hasn't set its own local one yet), forcing its
      // clientHeight up to match — a small, correctly-sized element (e.g. a
      // "66" price label, ~12px) then gets the ancestor's much larger min-
      // height (e.g. 1608px) baked in as its own PERMANENT floor. Measured
      // live: `.homepage` (root, correctly needs 1608px) tags first; every
      // descendant tagged afterward in the same pass — `.hp-enhance__row`,
      // `.price`, `.price__value` — inherited and locked in that same
      // 1608px, inflating a two-character price span to over a thousand
      // pixels tall and, cascading up through `flex-direction: column`
      // ancestors, roughly tripling the whole page's real content height
      // (and, on the board, overlapping the frames below it). `scrollHeight`
      // captured before any mutation is a pure geometry read, immune to this
      // — it reports this element's own true overflow extent regardless of
      // what an ancestor's inline style says.
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
