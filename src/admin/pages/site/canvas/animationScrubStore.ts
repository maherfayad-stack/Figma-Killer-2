/**
 * animationScrubStore — where "hold every animation at 40%" and "play them
 * once" live, between the inspector control that sets them and the canvas
 * injector that renders them.
 *
 * ## Why a module-level store rather than editor state or a prop
 *
 * Two facts decide this. The scrub is EPHEMERAL — it is a way of looking at
 * the board, not a property of the document, so putting it in `site` would
 * make it undoable, savable, and part of a diff that reaches the user's
 * repository. And it is CROSS-CUTTING — the control lives in the Properties
 * panel while every design frame on the board has its own
 * `CanvasAnimationInjector`, so a prop would have to be threaded through the
 * board layer, the frame, and the iframe surface, all of which otherwise know
 * nothing about animation.
 *
 * `studioRawCssStores.ts` solves the identical shape the identical way, for
 * the identical second reason: the injector subscribes to THIS store rather
 * than to `site`, whose reference changes on every unrelated node edit
 * (Mutative mints a new root per mutation) and would re-run the injector's DOM
 * work far more often than the value actually changes.
 *
 * ## The play-once phase machine lives here, not in the component
 *
 * Restarting a CSS animation from JavaScript requires taking `animation` away
 * and giving it back — there is no "seek to 0 and run" in CSS. That is a
 * two-phase sequence (`reset`, then `playing`), and it must be the SAME phase
 * in every frame at the same time or a board of frames replays raggedly. So
 * the phase is a value in this store and `CanvasAnimationInjector` stays a
 * pure function of it, rather than each mounted injector running its own
 * timer against a shared trigger.
 */

import { useSyncExternalStore } from 'react'
import type { AnimationPlayPhase } from '@core/studio-runtime'

// `AnimationPlayPhase` itself now lives in `@core/studio-runtime`
// (`animationFreezeRules.ts`) — it's part of the freeze-rules contract the
// live runtime shares, and this store is one of its two consumers. Re-export
// so existing importers of this module don't need a second import line.
export type { AnimationPlayPhase }

export interface CanvasAnimationScrub {
  /**
   * Where every CSS animation on the design canvas is held, as a fraction of
   * its own timeline, or `null` for "not scrubbing" — in which case each frame
   * falls back to its own `freezePoint` prop.
   */
  progress: number | null
  phase: AnimationPlayPhase
}

const IDLE: CanvasAnimationScrub = { progress: null, phase: 'idle' }

let state: CanvasAnimationScrub = IDLE
const listeners = new Set<() => void>()
let playTimer: ReturnType<typeof setTimeout> | null = null

function emit(next: CanvasAnimationScrub): void {
  if (next.progress === state.progress && next.phase === state.phase) return
  state = next
  for (const listener of listeners) listener()
}

export function getCanvasAnimationScrub(): CanvasAnimationScrub {
  return state
}

export function subscribeCanvasAnimationScrub(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Hold every animation at `progress` (clamped to 0…1). Cancels a play-once in
 * flight — a user reaching for the slider mid-playback means "stop, show me
 * this point", and letting the replay finish over the top of it would show
 * them something else.
 */
export function setCanvasAnimationScrub(progress: number): void {
  cancelPlayTimer()
  const clamped = Math.min(1, Math.max(0, progress))
  emit({ progress: clamped, phase: 'idle' })
}

/** Stop scrubbing: each frame goes back to its own freeze point. */
export function clearCanvasAnimationScrub(): void {
  cancelPlayTimer()
  emit(IDLE)
}

function cancelPlayTimer(): void {
  if (playTimer === null) return
  clearTimeout(playTimer)
  playTimer = null
}

/**
 * Play every animation on the design canvas once, from the start.
 *
 * `RESET_MS` is one animation-frame's worth of delay, not a guess at how long
 * anything takes: it exists only so the `animation: none` phase reaches the
 * iframe's style recalculation before the playing phase replaces it. Without
 * a gap between the two writes the browser coalesces them into no change at
 * all and nothing replays.
 *
 * There is no timer for the END of playback, deliberately. The playing phase's
 * rules ARE the `'end'` freeze (`iteration-count: 1; fill-mode: forwards`), so
 * each animation settles on its own last keyframe when it finishes and stays
 * there — nothing has to notice that it did.
 */
const RESET_MS = 16

export function playCanvasAnimationsOnce(): void {
  cancelPlayTimer()
  emit({ progress: null, phase: 'reset' })
  playTimer = setTimeout(() => {
    playTimer = null
    emit({ progress: null, phase: 'playing' })
  }, RESET_MS)
}

/** Subscribe a component to the current scrub state. */
export function useCanvasAnimationScrub(): CanvasAnimationScrub {
  return useSyncExternalStore(
    subscribeCanvasAnimationScrub,
    getCanvasAnimationScrub,
    getCanvasAnimationScrub,
  )
}
