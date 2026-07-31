/**
 * CanvasAnimationInjector — makes every source of motion inside a DESIGN
 * canvas frame settle, so a frame reads as a still, whole screen instead of a
 * live preview mid-animation.
 *
 * Why
 * ───
 * The design canvas is a static working surface, and an imported app is
 * full of motion that never settles: the eSIM corpus alone has a radar ping and an
 * orbiting dot on `infinite`, `@alm-design/design-system` ships an `infinite`
 * shimmer on every skeleton variant (button, tag, chip, ad-banner, …), and a
 * transition mid-flight during a layout change reads as canvas jitter. Those
 * run forever behind the selection ring, on every frame of a board at once.
 *
 * Four independent motion sources, four rules:
 *
 *   - CSS animations → `animation-iteration-count: 1; animation-fill-mode:
 *     forwards` (freeze point `'end'`) or `animation-play-state: paused`
 *     (freeze point `'start'`) — see "Freeze point" below.
 *   - CSS transitions → `transition: none` — a transition is a response to
 *     interaction (hover, focus, a class toggle), never ambient motion, and
 *     one caught mid-flight by a layout change is pure jitter.
 *   - Smooth scrolling → `scroll-behavior: auto` — `scrollIntoView({behavior:
 *     'smooth'})` or an anchor jump has nothing to animate toward on a canvas
 *     that never actually scrolls.
 *   - `<video>` / `<audio>` → paused and stripped of `autoplay`, both for
 *     elements present at mount and for ones inserted afterwards (a lazy
 *     carousel slide, a video whose `src` swaps on route change).
 *
 * Duration and delay are deliberately left alone for CSS animations, so each
 * one still plays through once at its authored speed before settling.
 *
 * Freeze point
 * ────────────
 * `'end'` (default) holds the LAST keyframe — correct for entrance motion (a
 * fade-in, a slide-in card), which is the common case. `'start'` pauses the
 * animation instead of letting it run — correct for motion whose end state is
 * not what should be shown at rest (a fade-out ping, a toast sliding away).
 * `'end'`'s known consequence: an animation whose final keyframe is invisible
 * ends invisible. `esim-radar-ping` fades `0.75 → 0` opacity, so its rings
 * hold at `opacity: 0` and the radar shows only its core and orbit dot — that
 * is what "stop at the last frame" means for a fade-out; `freezePoint:
 * 'start'` is the fix for exactly this case, per project.
 *
 * `prefers-reduced-motion`
 * ────────────────────────
 * A well-behaved app gates its own motion behind `@media
 * (prefers-reduced-motion: reduce)` or a `matchMedia` check (React hooks like
 * `useReducedMotion`, CSS-in-JS helpers). This injector patches
 * `window.matchMedia` inside the iframe so a `(prefers-reduced-motion:
 * reduce)` query always reports `matches: true` — every JS-driven check sees
 * "reduce motion" requested. **This does NOT retarget the browser's native
 * CSS `@media (prefers-reduced-motion: reduce)` evaluation** — that reflects
 * a real OS-level signal that no page-injected script can override without
 * devtools-protocol control (`Emulation.setEmulatedMedia`), which is not
 * available from inside a same-origin iframe. An app whose reduced-motion
 * handling lives entirely in a stylesheet `@media` block, with no JS check,
 * is not affected by this rule — its animations are still caught by the
 * iteration-count/transition/scroll-behavior rules above, just not through
 * this specific mechanism.
 *
 * What this cannot freeze
 * ────────────────────────
 * Animated GIF/WebP/APNG frame-advance is decoded by the image codec, not the
 * CSS engine — no stylesheet rule can pause it. Left alone; there is no
 * partial fix worth faking here. JS-driven animation (framer-motion, GSAP,
 * rAF loops) only runs when the "Run scripts" toggle is on, and this injector
 * makes no attempt to intercept `requestAnimationFrame` or a running rAF loop.
 * `<canvas>`/WebGL animation loops are equally out of reach — same reason.
 *
 * Why `!important`
 * ────────────────
 * This has to beat arbitrary author AND vendor CSS. `!important` declarations
 * always beat non-`!important` ones regardless of cascade layer, so being
 * unlayered isn't even the load-bearing part any more — both `ProjectCssInjector`
 * (`@layer vendor`, WS-2.3) and `ClassStyleInjector`/`UserStylesheetInjector`
 * (`@layer user-authored`) are real named layers now (see `canvasCssLayers.ts`).
 * What `!important` buys is escaping SPECIFICITY: this rule's `*` selector
 * (0,0,0) would otherwise lose to a vendor selector like the design system's
 * `.btn--skeleton` (0,1,0) and to any author class. Overriding a shorthand
 * (`animation: … infinite`) from an unknown third-party stylesheet is exactly
 * the case `!important` exists for. The repo-wide ban on `!important` is scoped
 * to component CSS modules; this is an injected iframe stylesheet with no
 * cascade position of its own to rely on.
 *
 * Scope
 * ─────
 * Design frames only. `IframeFrameSurface` mounts this when `interaction` is not
 * `'live'`, so live/preview mode still shows the page animating the way a visitor
 * would see it, and the publisher never emits this rule at all.
 */

import { useEffect } from 'react'

const STYLE_TAG_ID = 'studio-canvas-animation'

/** See "Freeze point" in the module docblock. */
export type CanvasAnimationFreezePoint = 'end' | 'start'

/**
 * Module-scope: stable across renders, never captured into a closure.
 * `*::before` / `*::after` are listed explicitly because `*` does not match
 * pseudo-elements, and generated content is a common home for spinners and
 * shimmer overlays (the eSIM radar's orbiting dot is an `::before`).
 */
function buildAnimationRules(freezePoint: CanvasAnimationFreezePoint): string {
  const animationFreeze =
    freezePoint === 'start'
      ? // Pausing wherever the animation currently is, mounted before the
        // animation has had any real time to run, holds it at (or very near)
        // its 0%/from keyframe — correct when the END state is the one that
        // should stay hidden.
        `animation-play-state: paused !important;`
      : `animation-iteration-count: 1 !important;
  animation-fill-mode: forwards !important;`

  return `
*,
*::before,
*::after {
  ${animationFreeze}
  transition: none !important;
  scroll-behavior: auto !important;
}
`.trim()
}

interface CanvasAnimationInjectorProps {
  /** The iframe document to inject the stylesheet into. */
  targetDocument: Document
  /**
   * Which keyframe a looping/entrance animation settles on. Defaults to
   * `'end'` (today's behaviour). See "Freeze point" above.
   */
  freezePoint?: CanvasAnimationFreezePoint
}

export function CanvasAnimationInjector({
  targetDocument,
  freezePoint = 'end',
}: CanvasAnimationInjectorProps) {
  // Stylesheet: animation freeze, transitions, smooth scroll.
  useEffect(() => {
    let styleEl = targetDocument.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDocument.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'CanvasAnimationInjector')
      // Appended LAST rather than prepended: `!important` already settles the
      // cascade, and being last means this is also the winner against any
      // equally-`!important` author rule of the same specificity.
      targetDocument.head.appendChild(styleEl)
    }
    styleEl.textContent = buildAnimationRules(freezePoint)
  }, [targetDocument, freezePoint])

  // Remove on unmount / document swap. Captures the current doc so cleanup
  // always targets the document this effect installed into.
  useEffect(() => {
    const targetDoc = targetDocument
    return () => {
      targetDoc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  // <video> / <audio>: pause + strip autoplay, at mount and on later insert.
  useEffect(() => {
    if (!targetDocument.body) return
    freezeAllMedia(targetDocument)

    const MutationObserverCtor = targetDocument.defaultView?.MutationObserver ?? MutationObserver
    let observer: MutationObserver | null = null
    try {
      observer = new MutationObserverCtor((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue
            freezeMediaElement(node as Element)
            for (const child of (node as Element).querySelectorAll(MEDIA_SELECTOR)) {
              freezeMediaElement(child)
            }
          }
        }
      })
      observer.observe(targetDocument.body, { childList: true, subtree: true })
    } catch (_err) {
      // Some browser realms reject observing a cross-realm node from this
      // context (mirrors iframeFrameObservers.ts). The freezeAllMedia() pass
      // above still covers everything present at mount.
      observer?.disconnect()
      observer = null
    }
    return () => {
      observer?.disconnect()
    }
  }, [targetDocument])

  // prefers-reduced-motion: patch matchMedia so JS-driven checks see "reduce".
  // See "prefers-reduced-motion" in the module docblock for what this does
  // and does not cover. The patch/restore itself lives in a plain function
  // (not inlined here) because assigning `view.matchMedia` directly inside
  // the component body reads to the React Compiler as mutating something
  // reachable from the `targetDocument` prop.
  useEffect(() => {
    return patchReducedMotionMatchMedia(targetDocument.defaultView)
  }, [targetDocument])

  return null
}

const MEDIA_SELECTOR = 'video, audio'

function freezeMediaElement(el: Element): void {
  if (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO') return
  el.removeAttribute('autoplay')
  const media = el as HTMLMediaElement
  try {
    media.pause()
  } catch (_err) {
    // Some elements throw if playback never actually started; best-effort
    // freezing is still better than letting the error abort the pass.
  }
}

function freezeAllMedia(doc: Document): void {
  for (const el of doc.querySelectorAll(MEDIA_SELECTOR)) {
    freezeMediaElement(el)
  }
}

const REDUCED_MOTION_QUERY = /prefers-reduced-motion/

/**
 * Installs the `matchMedia` patch on `view` and returns the restore
 * function. A plain function rather than inlined in the effect: React
 * Compiler's mutation analysis reads a direct `view.matchMedia = …`
 * assignment inside the component body as mutating something reachable from
 * the `targetDocument` prop, even though this write targets the iframe's own
 * window, not React-owned state.
 */
function patchReducedMotionMatchMedia(view: Document['defaultView']): (() => void) | undefined {
  if (!view || typeof view.matchMedia !== 'function') return undefined
  // Kept unbound so cleanup can restore the EXACT original reference rather
  // than a wrapper around it — other code may have captured the original
  // function reference before this patch installed.
  const nativeMatchMedia = view.matchMedia
  view.matchMedia = ((query: string) => {
    if (!REDUCED_MOTION_QUERY.test(query)) return nativeMatchMedia.call(view, query)
    return createReducedMotionMediaQueryList(query)
  }) as typeof view.matchMedia
  return () => {
    view.matchMedia = nativeMatchMedia
  }
}

/**
 * A static `MediaQueryList` stand-in. The canvas never toggles this mid
 * session, so no change event ever needs to fire — `addEventListener` /
 * `addListener` are accepted (a defensively-coded library that subscribes
 * won't throw) but never invoked.
 */
function createReducedMotionMediaQueryList(query: string): MediaQueryList {
  const reduce = !/no-preference/.test(query)
  return {
    matches: reduce,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  } as MediaQueryList
}
