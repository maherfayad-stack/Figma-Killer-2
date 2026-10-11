/**
 * staticFrameHold - while something needs to PHOTOGRAPH the board's frames, a
 * Tier-2 frame must be the same-origin static render, not the dev-server iframe.
 *
 * A live frame is a cross-origin `<iframe src=http://localhost:..>`. Nothing in
 * this document can read its pixels or its DOM, so a capture through the open
 * editor tab (`studio_export_frames`, which the share flow falls back to when
 * the headless browser cannot start) could never see a ready frame: it waited
 * out its mount timeout and reported every page as not photographable. Every
 * project opens at Tier 2 by default, so that was the common case, not an edge.
 *
 * `LiveBoardFrame` keeps its static fallback mounted until the live iframe is
 * ready and unmounts it after. While a hold is active it behaves as if the live
 * frame were not ready yet, so the fallback is present (and capturable) for the
 * duration of the export, and the live frame takes over again on release.
 *
 * Holds are counted: two overlapping exports release independently.
 */
import { useSyncExternalStore } from 'react'

let holds = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getHeld(): boolean {
  return holds > 0
}

/** Start holding frames static. Returns the release; calling it twice is harmless. */
export function holdFramesStatic(): () => void {
  holds += 1
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    holds -= 1
    notify()
  }
}

export function useFramesHeldStatic(): boolean {
  return useSyncExternalStore(subscribe, getHeld, getHeld)
}
