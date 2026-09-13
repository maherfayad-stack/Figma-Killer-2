/**
 * animationFreezeRules — makes every source of motion inside a DESIGN-mode
 * frame settle, so the frame reads as a still, whole screen instead of a
 * live preview mid-animation. Shared by the portal-mode
 * `CanvasAnimationInjector` and the in-frame live runtime (`runtime.ts`,
 * cross-origin — this module ships inside that bundle too, so it stays free
 * of admin/store imports).
 *
 * Four independent motion sources, four rules:
 *
 *   - CSS animations → `animation-iteration-count: 1; animation-fill-mode:
 *     forwards` (freeze point `'end'`) or `animation-play-state: paused`
 *     (freeze point `'start'`) — see "Freeze point" below.
 *   - CSS transitions → `transition: none` — a transition is a response to
 *     interaction, never ambient motion, and one caught mid-flight by a
 *     layout change is pure jitter.
 *   - Smooth scrolling → `scroll-behavior: auto`.
 *   - `<video>` / `<audio>` → paused and stripped of `autoplay`, both for
 *     elements present at mount and for ones inserted afterwards.
 *
 * ## Freeze point
 *
 * `'end'` (default) holds the LAST keyframe — correct for entrance motion.
 * `'start'` pauses the animation instead of letting it run — correct for
 * motion whose end state is not what should be shown at rest (a fade-out
 * ping, a toast sliding away). A NUMBER between 0 and 1 generalises both:
 * `0` shows what `'start'` shows and `1` shows what `'end'` shows, via a
 * negative delay on a paused animation — CSS's way of expressing "already
 * this far in". A negative delay is measured against the DURATION, which
 * differs per animation and which no `*` selector can read, so this rule
 * also forces `animation-duration: 1s` on everything (harmless — a paused
 * animation does not advance).
 *
 * ## `prefers-reduced-motion`
 *
 * `patchReducedMotionMatchMedia` patches `window.matchMedia` inside the
 * frame so a `(prefers-reduced-motion: reduce)` query always reports
 * `matches: true` — every JS-driven check sees "reduce motion" requested.
 * This does NOT retarget the browser's native CSS `@media
 * (prefers-reduced-motion: reduce)` evaluation, which reflects a real
 * OS-level signal no page-injected script can override.
 *
 * ## What this cannot freeze
 *
 * Animated GIF/WebP/APNG frame-advance is decoded by the image codec, not
 * the CSS engine. JS-driven animation (framer-motion, GSAP, rAF loops) and
 * `<canvas>`/WebGL loops are equally out of reach — no attempt is made to
 * intercept `requestAnimationFrame`.
 *
 * ## Why `!important`
 *
 * This has to beat arbitrary author AND vendor CSS. `!important`
 * declarations always beat non-`!important` ones regardless of cascade
 * layer, which is what lets this beat both `@layer vendor` and
 * `@layer user-authored` content, plus a high-specificity selector like
 * `.btn--skeleton` (0,1,0) against this rule's `*` (0,0,0). The repo-wide
 * ban on `!important` is scoped to component CSS modules; this is an
 * injected iframe stylesheet with no cascade position of its own to rely on.
 */

/**
 * `reset` strips `animation` entirely for one frame so the next phase starts
 * every animation from its first keyframe; `playing` lets each run once at
 * its authored speed and settle on its last. `idle` is the resting state, in
 * which `progress` (or, when that is `null`, the frame's own freeze point)
 * decides what is shown.
 */
export type AnimationPlayPhase = 'idle' | 'reset' | 'playing'

/**
 * See "Freeze point" in the module docblock. A number is a fraction of each
 * animation's own timeline, clamped to 0…1 — `0` is `'start'` and `1` is
 * `'end'`.
 */
export type CanvasAnimationFreezePoint = 'end' | 'start' | number

/** The `animation-*` block for a given freeze point — see "Freeze point". */
export function animationFreezeDeclarations(freezePoint: CanvasAnimationFreezePoint): string {
  if (typeof freezePoint === 'number') {
    const progress = Math.min(1, Math.max(0, freezePoint))
    return `animation-duration: 1s !important;
  animation-delay: -${progress}s !important;
  animation-iteration-count: 1 !important;
  animation-fill-mode: both !important;
  animation-play-state: paused !important;`
  }
  if (freezePoint === 'start') {
    return `animation-play-state: paused !important;`
  }
  return `animation-iteration-count: 1 !important;
  animation-fill-mode: forwards !important;`
}

/**
 * Module-scope: stable across renders, never captured into a closure.
 * `*::before` / `*::after` are listed explicitly because `*` does not match
 * pseudo-elements, and generated content is a common home for spinners and
 * shimmer overlays.
 *
 * `transition: none` is dropped for the two play-once phases: a play-once is
 * the one moment a design frame is deliberately being watched move, and a
 * transition suppressed through it would make the preview lie about what a
 * visitor sees.
 */
export function buildAnimationRules(freezePoint: CanvasAnimationFreezePoint, phase: AnimationPlayPhase): string {
  const animationRules =
    phase === 'reset'
      ? `animation: none !important;`
      : phase === 'playing'
        ? `animation-play-state: running !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  animation-fill-mode: forwards !important;`
        : animationFreezeDeclarations(freezePoint)

  const transitionRule = phase === 'idle' ? '\n  transition: none !important;' : ''

  return `
*,
*::before,
*::after {
  ${animationRules}${transitionRule}
  scroll-behavior: auto !important;
}
`.trim()
}

export const MEDIA_SELECTOR = 'video, audio'

export function freezeMediaElement(el: Element): void {
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

export function freezeAllMedia(doc: Document): void {
  for (const el of doc.querySelectorAll(MEDIA_SELECTOR)) {
    freezeMediaElement(el)
  }
}

/**
 * Watches `doc.body` for later-inserted `<video>`/`<audio>` (a lazy carousel
 * slide, a video whose `src` swaps on route change) and freezes them too.
 * Returns the disconnect function; call `freezeAllMedia(doc)` once yourself
 * first to cover what's already mounted.
 */
export function watchMediaInsertions(doc: Document): () => void {
  if (!doc.body) return () => {}
  const MutationObserverCtor = doc.defaultView?.MutationObserver ?? MutationObserver
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
    observer.observe(doc.body, { childList: true, subtree: true })
  } catch (_err) {
    // Some browser realms reject observing a cross-realm node from this
    // context. freezeAllMedia()'s own pass still covers everything present
    // when it was called.
    observer?.disconnect()
    observer = null
  }
  return () => observer?.disconnect()
}

const REDUCED_MOTION_QUERY = /prefers-reduced-motion/

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

/**
 * Installs the `matchMedia` patch on `view` and returns the restore
 * function. A plain function (not inlined at the call site) so the patch
 * assignment doesn't read, to a caller's own mutation analysis, as mutating
 * something reachable from a prop/state value it owns.
 */
export function patchReducedMotionMatchMedia(view: Document['defaultView']): (() => void) | undefined {
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

export interface AnimationFreezeController {
  /**
   * Re-renders the freeze stylesheet for a new freeze point / play phase —
   * cheap (a `textContent` write), and does not touch the media pause or
   * `matchMedia` patch, which are mount-once concerns. Callers whose freeze
   * point can change live (the portal injector's scrub slider) call this on
   * every change instead of tearing the controller down and starting a new
   * one.
   */
  update(freezePoint: CanvasAnimationFreezePoint, phase: AnimationPlayPhase): void
  dispose(): void
}

/**
 * Mounts/updates the freeze stylesheet only — no media pause, no
 * `matchMedia` patch. Split out from {@link startAnimationFreeze} so a
 * caller whose freeze point/phase changes on every render (the portal
 * injector's scrub slider) can re-render JUST the stylesheet, in a
 * `useEffect` keyed on those values alone, without disturbing the mount-once
 * media/matchMedia setup — see `CanvasAnimationInjector.tsx`'s "Two effects,
 * on purpose".
 *
 * `dataSource` is written onto the `<style>` element's `data-source`
 * attribute purely for DOM-inspection debugging — see the identical note on
 * `startScrollUnroll`.
 */
export function applyAnimationFreezeStylesheet(
  doc: Document,
  styleElementId: string,
  freezePoint: CanvasAnimationFreezePoint,
  phase: AnimationPlayPhase,
  dataSource = 'animationFreezeRules',
): void {
  let styleEl = doc.getElementById(styleElementId) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = doc.createElement('style')
    styleEl.id = styleElementId
    styleEl.setAttribute('data-source', dataSource)
    doc.head?.appendChild(styleEl)
  }
  styleEl.textContent = buildAnimationRules(freezePoint, phase)
}

export function removeAnimationFreezeStylesheet(doc: Document, styleElementId: string): void {
  doc.getElementById(styleElementId)?.remove()
}

export interface MediaFreezeController {
  dispose(): void
}

/**
 * The mount-once half of {@link startAnimationFreeze}: pauses every media
 * element (present + future) and patches `matchMedia`. Does not touch any
 * stylesheet — pair with {@link applyAnimationFreezeStylesheet} for the full
 * behaviour, or use {@link startAnimationFreeze} directly when the freeze
 * point/phase are fixed for the controller's whole lifetime (the live
 * runtime, which has no scrub slider).
 */
export function startMediaFreeze(doc: Document): MediaFreezeController {
  freezeAllMedia(doc)
  const stopWatchingMedia = watchMediaInsertions(doc)
  const restoreMatchMedia = patchReducedMotionMatchMedia(doc.defaultView)
  return {
    dispose() {
      stopWatchingMedia()
      restoreMatchMedia?.()
    },
  }
}

/**
 * Starts the full behaviour in `doc`: mounts the freeze stylesheet at
 * `freezePoint`/`phase`, pauses every media element (present + future), and
 * patches `matchMedia`. `dispose()` undoes all three. Composed from
 * {@link applyAnimationFreezeStylesheet} + {@link startMediaFreeze} — reach
 * for those directly if the caller needs to update the stylesheet
 * independently of the mount-once media/matchMedia setup.
 */
export function startAnimationFreeze(
  doc: Document,
  styleElementId: string,
  freezePoint: CanvasAnimationFreezePoint = 'end',
  phase: AnimationPlayPhase = 'idle',
  dataSource = 'animationFreezeRules',
): AnimationFreezeController {
  applyAnimationFreezeStylesheet(doc, styleElementId, freezePoint, phase, dataSource)
  const media = startMediaFreeze(doc)

  return {
    update(nextFreezePoint, nextPhase) {
      applyAnimationFreezeStylesheet(doc, styleElementId, nextFreezePoint, nextPhase, dataSource)
    },
    dispose() {
      media.dispose()
      removeAnimationFreezeStylesheet(doc, styleElementId)
    },
  }
}
