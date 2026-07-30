/**
 * CanvasAnimationInjector — makes every CSS animation inside a DESIGN canvas
 * frame play exactly once and hold its final keyframe.
 *
 * Why
 * ───
 * The design canvas is a static working surface, and an imported app is full of
 * animation that never settles: the eSIM corpus alone has a radar ping and an
 * orbiting dot on `infinite`, and `@alm-design/design-system` ships an `infinite`
 * shimmer on every skeleton variant (button, tag, chip, ad-banner, …). Those run
 * forever behind the selection ring, on every frame of a board at once.
 *
 * Two declarations do the whole job:
 *   - `animation-iteration-count: 1` — a looping animation runs once.
 *   - `animation-fill-mode: forwards` — it then holds its last keyframe instead
 *     of snapping back to the element's base style.
 *
 * Duration and delay are deliberately left alone, so each animation still plays
 * through once at its authored speed and then stops. Transitions are untouched —
 * they are responses to interaction, not ambient motion.
 *
 * Why `!important`
 * ────────────────
 * This has to beat arbitrary author CSS, and the usual lever — being UNLAYERED
 * while author CSS sits in `@layer user-authored` — is not enough here, because
 * `AlmDesignSystemCssInjector` is *also* unlayered (it has to be, or Studio's
 * reset would beat it). Against an unlayered peer, specificity decides, and this
 * rule's `*` selector (0,0,0) loses to the design system's `.btn--skeleton`
 * (0,1,0) and to any author class. Overriding a shorthand (`animation: … infinite`)
 * from an unknown third-party stylesheet is exactly the case `!important` exists
 * for. The repo-wide ban on `!important` is scoped to component CSS modules; this
 * is an injected iframe stylesheet with no cascade position of its own to rely on.
 *
 * Scope
 * ─────
 * Design frames only. `IframeFrameSurface` mounts this when `interaction` is not
 * `'live'`, so live/preview mode still shows the page animating the way a visitor
 * would see it, and the publisher never emits this rule at all.
 *
 * Known consequence: an animation whose final keyframe is invisible ends
 * invisible. `esim-radar-ping` fades `0.75 → 0` opacity, so its rings hold at
 * `opacity: 0` and the radar shows only its core and orbit dot. That is what
 * "stop at the last frame" means for a fade-out; freezing such an animation
 * somewhere more flattering would need a per-animation judgement this cannot make.
 */

import { useEffect } from 'react'

const STYLE_TAG_ID = 'studio-canvas-animation'

/**
 * Module-scope constant: stable across renders, never captured into a closure.
 * `*::before` / `*::after` are listed explicitly because `*` does not match
 * pseudo-elements, and generated content is a common home for spinners and
 * shimmer overlays (the eSIM radar's orbiting dot is an `::before`).
 */
const ANIMATION_RULES = `
*,
*::before,
*::after {
  animation-iteration-count: 1 !important;
  animation-fill-mode: forwards !important;
}
`.trim()

interface CanvasAnimationInjectorProps {
  /** The iframe document to inject the stylesheet into. */
  targetDocument: Document
}

export function CanvasAnimationInjector({ targetDocument }: CanvasAnimationInjectorProps) {
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
    styleEl.textContent = ANIMATION_RULES
  }, [targetDocument])

  // Remove on unmount / document swap. Captures the current doc so cleanup
  // always targets the document this effect installed into.
  useEffect(() => {
    const targetDoc = targetDocument
    return () => {
      targetDoc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  return null
}
