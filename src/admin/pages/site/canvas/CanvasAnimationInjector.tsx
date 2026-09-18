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

import { useContext, useEffect } from 'react'
import { useCanvasAnimationScrub } from './animationScrubStore'
import {
  applyAnimationFreezeStylesheet,
  removeAnimationFreezeStylesheet,
  startMediaFreeze,
  type CanvasAnimationFreezePoint,
} from '@core/studio-runtime'
import { CanvasFrameAdapterContext } from './CanvasContexts'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'

const STYLE_TAG_ID = 'studio-canvas-animation'

interface CanvasAnimationInjectorProps {
  /**
   * Which keyframe a looping/entrance animation settles on — `'end'`,
   * `'start'`, or a 0…1 fraction of its own timeline. Defaults to `'end'`.
   * See `@core/studio-runtime`'s "Freeze point" doc. Overridden while the
   * inspector's scrub is active (`animationScrubStore.ts`).
   */
  freezePoint?: CanvasAnimationFreezePoint
}

/**
 * Portal mode only (`live-05`, STATE.md, Batch 5) — reads the frame's
 * `Document` through `PortalFrameAdapter`'s escape hatch, calling
 * `applyAnimationFreezeStylesheet`/`startMediaFreeze` directly exactly as
 * before, rather than `adapter.setInteractionMode`.
 *
 * `PortalFrameAdapter.setInteractionMode('design')` already starts its OWN
 * animation-freeze controller (`startAnimationFreeze`, fixed at freeze point
 * `'end'`) alongside hover-suppression and scroll-unroll — built in Batch 1
 * for a future bridge-mode caller, where `runtime.ts`'s `setMode` handler
 * needs exactly that one coupled on/off switch. This component's real
 * product behavior does NOT fit that coupling: the inspector's animation
 * scrub (`animationScrubStore.ts`) needs a variable, frequently-updated
 * freeze point/phase with no `enabled`-style on/off — routing it through
 * `setInteractionMode` would either need a new interface method (scrub isn't
 * expressible through the existing 7) or would run TWO independent freeze
 * controllers simultaneously (this one, scrub-aware; `setInteractionMode`'s,
 * fixed) with two separate `startMediaFreeze` calls each patching
 * `window.matchMedia` — a real, if likely harmless-looking, double-patch
 * bug, not just redundant work. Keeping this fully independent avoids both
 * problems and changes nothing about portal mode's actual behavior.
 */
export function CanvasAnimationInjector({ freezePoint = 'end' }: CanvasAnimationInjectorProps) {
  const adapter = useContext(CanvasFrameAdapterContext)
  // A scrub set from the inspector overrides this frame's own freeze point;
  // with none set, `freezePoint` decides exactly as it did before W5-5.
  const { progress, phase } = useCanvasAnimationScrub()
  const effectiveFreezePoint = progress === null ? freezePoint : progress

  // Reactive half: re-renders the stylesheet text on every freeze-point/phase
  // change. Cheap (a `textContent` write), and deliberately has NO cleanup of
  // its own — removing and recreating the element on every scrub tick would
  // be pure churn. Removal happens once, on unmount, in the next effect.
  useEffect(() => {
    if (!isPortalFrameAdapter(adapter)) return
    const targetDocument = adapter.getPortalWindow()?.document
    if (!targetDocument) return
    applyAnimationFreezeStylesheet(targetDocument, STYLE_TAG_ID, effectiveFreezePoint, phase, 'CanvasAnimationInjector')
  }, [adapter, effectiveFreezePoint, phase])

  useEffect(() => {
    return () => {
      if (!isPortalFrameAdapter(adapter)) return
      const targetDocument = adapter.getPortalWindow()?.document
      if (targetDocument) removeAnimationFreezeStylesheet(targetDocument, STYLE_TAG_ID)
    }
  }, [adapter])

  // Mount-once half: media pause/watch + the matchMedia patch. Independent
  // of freeze point/phase, so this effect's own deps array is exactly
  // [adapter] with nothing to suppress.
  useEffect(() => {
    if (!isPortalFrameAdapter(adapter)) return
    const targetDocument = adapter.getPortalWindow()?.document
    if (!targetDocument) return
    const controller = startMediaFreeze(targetDocument)
    return () => controller.dispose()
  }, [adapter])

  return null
}
