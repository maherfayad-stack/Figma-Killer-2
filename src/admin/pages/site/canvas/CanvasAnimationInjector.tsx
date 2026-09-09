/**
 * CanvasAnimationInjector — makes every source of motion inside a DESIGN
 * canvas frame settle, so a frame reads as a still, whole screen instead of a
 * live preview mid-animation.
 *
 * The freeze stylesheet, the media pause/watch pass, and the
 * `prefers-reduced-motion` `matchMedia` patch all live in
 * `@core/studio-runtime` (`animationFreezeRules.ts`) — ONE implementation,
 * shared verbatim with the in-frame live runtime (`runtime.ts`), which runs
 * the identical freeze behaviour for a Tier 2 frame in its own `'design'`
 * interaction mode. See that module's docblock for the full rationale
 * (freeze points, why `!important`, what cannot be frozen).
 *
 * ## Scrubbing and playing back (`animationScrubStore.ts`)
 *
 * The two phases of a play-once — `'reset'` (take `animation` away so the
 * next phase starts from the first keyframe) and `'playing'` (let each run
 * once and settle) — arrive from `animationScrubStore.ts` rather than from a
 * prop, so every frame on the board replays in step. When the store is idle
 * and no scrub is set, the `freezePoint` prop decides, exactly as before.
 *
 * ## Two effects, on purpose
 *
 * Mounting the media pause/watch pass + the `matchMedia` patch
 * (`startMediaFreeze`) is a MOUNT-ONCE concern — re-running it on every
 * freeze-point/phase change would tear down and reinstall the `matchMedia`
 * patch and the media `MutationObserver` on every scrub tick, for no
 * behavioural gain. Only the stylesheet text needs to react to
 * `effectiveFreezePoint`/`phase`, so it is rendered by a SEPARATE effect
 * (`applyAnimationFreezeStylesheet`) keyed on exactly those two values — each
 * effect's dependency array is therefore complete on its own terms, with no
 * manual memoization or lint suppression needed to keep them apart.
 *
 * Scope
 * ─────
 * Design frames only. `IframeFrameSurface` mounts this when `interaction` is not
 * `'live'`, so live/preview mode still shows the page animating the way a visitor
 * would see it, and the publisher never emits this rule at all.
 */

import { useEffect } from 'react'
import { useCanvasAnimationScrub } from './animationScrubStore'
import {
  applyAnimationFreezeStylesheet,
  removeAnimationFreezeStylesheet,
  startMediaFreeze,
  type CanvasAnimationFreezePoint,
} from '@core/studio-runtime'

const STYLE_TAG_ID = 'studio-canvas-animation'

interface CanvasAnimationInjectorProps {
  /** The iframe document to inject the stylesheet into. */
  targetDocument: Document
  /**
   * Which keyframe a looping/entrance animation settles on — `'end'`,
   * `'start'`, or a 0…1 fraction of its own timeline. Defaults to `'end'`.
   * See `@core/studio-runtime`'s "Freeze point" doc. Overridden while the
   * inspector's scrub is active (`animationScrubStore.ts`).
   */
  freezePoint?: CanvasAnimationFreezePoint
}

export function CanvasAnimationInjector({
  targetDocument,
  freezePoint = 'end',
}: CanvasAnimationInjectorProps) {
  // A scrub set from the inspector overrides this frame's own freeze point;
  // with none set, `freezePoint` decides exactly as it did before W5-5.
  const { progress, phase } = useCanvasAnimationScrub()
  const effectiveFreezePoint = progress === null ? freezePoint : progress

  // Reactive half: re-renders the stylesheet text on every freeze-point/phase
  // change. Cheap (a `textContent` write), and deliberately has NO cleanup of
  // its own — removing and recreating the element on every scrub tick would
  // be pure churn. Removal happens once, on unmount, in the next effect.
  useEffect(() => {
    applyAnimationFreezeStylesheet(targetDocument, STYLE_TAG_ID, effectiveFreezePoint, phase, 'CanvasAnimationInjector')
  }, [targetDocument, effectiveFreezePoint, phase])

  useEffect(() => {
    return () => removeAnimationFreezeStylesheet(targetDocument, STYLE_TAG_ID)
  }, [targetDocument])

  // Mount-once half: media pause/watch + the matchMedia patch. Independent
  // of freeze point/phase, so this effect's own deps array is exactly
  // [targetDocument] with nothing to suppress.
  useEffect(() => {
    const controller = startMediaFreeze(targetDocument)
    return () => controller.dispose()
  }, [targetDocument])

  return null
}
