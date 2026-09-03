/**
 * The entrance animation for a screen the player just navigated to.
 *
 * WHY THIS IS NOT A CSS ANIMATION ANY MORE
 * ────────────────────────────────────────
 * A CSS `@keyframes` entrance only re-runs when the element is remounted, so
 * the screen wrapper used to be keyed on the page id to force that. It worked,
 * and it took the `<iframe>` down with it: React unmounted the old frame and
 * mounted a new one in the same commit, the portal that renders the page into
 * the frame's `<body>` never re-established against the new document, and the
 * player showed an empty device — a blank screen on every single navigation,
 * which is the one thing a prototype must never do.
 *
 * The Web Animations API replays on demand without remounting anything, so the
 * frame now survives navigation and only its CONTENT changes. That is also
 * cheaper: an iframe remount re-parses and re-injects every stylesheet.
 *
 * `prefers-reduced-motion` has to be honoured here explicitly. The global CSS
 * rule that clamps `animation-duration` cannot see a script-driven animation.
 */
import type { PrototypeTransition } from '@core/studio-prototype'

const DURATION_MS = 220
const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

/**
 * `null` for a transition that has no screen entrance: `instant` by definition,
 * and `popup`/`sheet`, which are how an OVERLAY presents — an overlay is a
 * second surface over a screen that stays put, so it animates itself.
 */
export function screenEntranceKeyframes(transition: PrototypeTransition): Keyframe[] | null {
  switch (transition) {
    case 'dissolve':
      return [{ opacity: 0 }, { opacity: 1 }]
    // A leftward navigation brings the new screen in from the right.
    case 'slide-left':
    case 'push-left':
      return [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }]
    case 'slide-right':
    case 'push-right':
      return [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }]
    case 'instant':
    case 'popup':
    case 'sheet':
      return null
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Play `transition`'s entrance on `element`. Returns the running animation so
 * the caller can cancel it, or `null` when there is nothing to play.
 */
export function playScreenEntrance(
  element: HTMLElement,
  transition: PrototypeTransition | null,
): Animation | null {
  if (!transition) return null
  const keyframes = screenEntranceKeyframes(transition)
  if (!keyframes) return null
  // jsdom and older engines have no `element.animate`; the screen simply
  // appears, which is what `instant` does anyway.
  if (typeof element.animate !== 'function') return null
  return element.animate(keyframes, {
    duration: prefersReducedMotion() ? 0 : DURATION_MS,
    easing: EASING,
    fill: 'both',
  })
}
