/**
 * playbackMotion — every animation the prototype player runs, in one place.
 *
 * WHERE THE NUMBERS COME FROM
 * ───────────────────────────
 * The motion tokens of the `almosafer-prototype` skill, which are the ones the
 * design system's own components ship. Two principles are baked into them and
 * are the reason not to round them off:
 *
 *   - `EASE_IOS` is the curve the design system's `BottomSheet` uses. A sheet
 *     the DS animates and a sheet Studio animates have to move identically, or
 *     a prototype reads as assembled from parts.
 *   - Dismissal is quicker than presentation. Arriving is the moment worth
 *     drawing out; leaving should get out of the way. That asymmetry is what
 *     reads as iOS.
 *
 * WHY SCRIPT AND NOT CSS
 * ──────────────────────
 * A CSS `@keyframes` entrance only replays when its element is remounted, and
 * remounting a screen here means remounting an `<iframe>` — which drops the
 * React portal that renders the page into it and leaves the player showing an
 * empty device. The Web Animations API replays on demand against a frame that
 * stays put. Keeping the overlay on the same mechanism means one source for
 * every duration instead of the same numbers written twice, once per language.
 *
 * `prefers-reduced-motion` has to be honoured here explicitly: the global CSS
 * rule that clamps `animation-duration` cannot see a script-driven animation.
 * Durations collapse to 1ms rather than 0 so `finished` still resolves and the
 * outgoing screen is still cleaned up.
 */
import type { PrototypeTransition } from '@core/studio-prototype'

/** Navigation pushes and sheet presentation — the design system's own curve. */
const EASE_IOS = 'cubic-bezier(0.32, 0.72, 0, 1)'
/** Colour, opacity, elevation. */
const EASE_OUT = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

const DUR_QUICK = 180
const DUR_ALERT = 280
const DUR_SELECT = 340
const DUR_NAV = 420
const DUR_SHEET = 500

/**
 * How far the departing screen parallaxes back under the arriving one. UIKit
 * moves it a third of the way, not the whole width — the point is that it is
 * still there, underneath.
 */
const PARALLAX = '33%'
/** How dark the departing screen goes. UIKit DARKENS rather than fades: a fade would read as a cross-dissolve. */
const DIM_OPACITY = 0.28

export interface ScreenMotion {
  /** Keyframes for the arriving screen. */
  incoming: Keyframe[] | null
  /** Keyframes for the departing screen, or `null` when it simply stays put. */
  outgoing: Keyframe[] | null
  /** Keyframes for the dim over the departing screen. */
  dim: Keyframe[] | null
  duration: number
  easing: string
}

/**
 * A slide moves ONLY the arriving screen; a push moves both, the departing one
 * parallaxing back and darkening under it. That distinction is the whole
 * difference between the two names in the inspector, so it has to be real.
 */
export function screenMotion(transition: PrototypeTransition): ScreenMotion | null {
  switch (transition) {
    case 'dissolve':
      return {
        incoming: [{ opacity: 0, transform: 'scale(1.015)' }, { opacity: 1, transform: 'scale(1)' }],
        outgoing: [{ opacity: 1 }, { opacity: 0 }],
        dim: null,
        duration: DUR_SELECT,
        easing: EASE_OUT,
      }
    // A leftward navigation brings the new screen in from the right; the
    // departing screen, when it moves at all, goes the same way.
    case 'slide-left':
      return slide('100%')
    case 'slide-right':
      return slide('-100%')
    case 'push-left':
      return push('100%', `-${PARALLAX}`)
    case 'push-right':
      return push('-100%', PARALLAX)
    case 'instant':
    case 'popup':
    case 'sheet':
      return null
  }
}

function slide(from: string): ScreenMotion {
  return {
    incoming: [{ transform: `translateX(${from})` }, { transform: 'translateX(0)' }],
    outgoing: null,
    dim: null,
    duration: DUR_NAV,
    easing: EASE_IOS,
  }
}

function push(from: string, to: string): ScreenMotion {
  return {
    ...slide(from),
    outgoing: [{ transform: 'translateX(0)' }, { transform: `translateX(${to})` }],
    dim: [{ opacity: 0 }, { opacity: DIM_OPACITY }],
  }
}

export interface OverlayMotion {
  panel: Keyframe[]
  scrim: Keyframe[]
  duration: number
  easing: string
}

/**
 * An overlay presents OVER the screen that opened it, which stays mounted and
 * visible behind a scrim — that is the whole difference from a navigation.
 *
 * A sheet rises from the bottom edge on the design system's own curve and
 * duration. A popup is a centred card, so it scales up rather than travelling,
 * and takes a dialog's shorter beat.
 */
export function overlayMotion(transition: PrototypeTransition): OverlayMotion | null {
  switch (transition) {
    case 'sheet':
      return {
        panel: [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
        scrim: [{ opacity: 0 }, { opacity: 1 }],
        duration: DUR_SHEET,
        easing: EASE_IOS,
      }
    case 'popup':
      return {
        panel: [{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'scale(1)' }],
        scrim: [{ opacity: 0 }, { opacity: 1 }],
        duration: DUR_ALERT,
        easing: EASE_OUT,
      }
    default:
      return null
  }
}

/** The quick beat everything leaving uses. Exported so callers do not invent one. */
export const DISMISS_MS = DUR_QUICK

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Run `keyframes` on `element`. Returns the animation, or `null` when there is
 * nothing to run (no keyframes, or an engine without WAAPI — jsdom, and older
 * browsers, where the screen simply appears).
 */
export function play(
  element: HTMLElement | null,
  keyframes: Keyframe[] | null,
  duration: number,
  easing: string,
): Animation | null {
  if (!element || !keyframes) return null
  if (typeof element.animate !== 'function') return null
  return element.animate(keyframes, {
    duration: prefersReducedMotion() ? 1 : duration,
    easing,
    // `backwards`, never `both`: holding the last keyframe leaves an identity
    // transform on the element, and a transformed ancestor disables
    // `backdrop-filter` on everything inside it — the glass in a navbar or a
    // sheet would silently stop blurring for the rest of the session.
    fill: 'backwards',
  })
}
