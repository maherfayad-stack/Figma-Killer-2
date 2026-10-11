/**
 * posterFillTarget — the ONE frame the background fill (`PosterFill`) has
 * mounted just to photograph it, if any.
 *
 * A module-level store rather than state in `BoardFramesLayer`: the fill is
 * driven by a component that has nothing to do with the layer's render, and the
 * layer only needs to know one id to add to its live set. It never takes a
 * slot of the live cap and lasts only as long as the picture takes.
 */
import { useSyncExternalStore } from 'react'

export type PosterFillState = 'running' | 'done'

let target: string | null = null
let state: PosterFillState = 'running'
const listeners = new Set<() => void>()

/** Set (or clear, with `null`) the frame being mounted for its picture. */
export function setPosterFillFrameId(frameId: string | null): void {
  if (target === frameId) return
  target = frameId
  for (const listener of listeners) listener()
}

/**
 * Whether the fill has more to photograph. `BoardFramesLayer` stamps it as
 * `data-poster-fill`, so a test that measures an idle board can wait for the
 * fill's own work to be over instead of counting it as the editor's.
 */
export function setPosterFillState(next: PosterFillState): void {
  if (state === next) return
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The frame the fill is photographing right now. */
export function usePosterFillFrameId(): string | null {
  return useSyncExternalStore(subscribe, () => target, () => null)
}

/** `running` while the fill still has frames to photograph (or has not looked yet), `done` once the whole board has a picture. */
export function usePosterFillState(): PosterFillState {
  return useSyncExternalStore(subscribe, () => state, () => 'running')
}
