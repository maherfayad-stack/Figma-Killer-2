/**
 * frameMeasuredHeights: how tall each board frame ACTUALLY is (SB-5).
 *
 * A frame that has never been manually resized hugs its content: its stored
 * `height` is absent and its box is whatever its document (or, before that, its
 * poster) measures. The live-frame policy needs the real box. With the default
 * 800 px stand in for it, a 3,000 px page whose middle is on screen is "not in
 * view" and its visible part would be a picture, which is the one frame the
 * user is looking at. The pool this replaced hid that behind a 600 px margin;
 * poster-first mounting has none, so the box has to be true.
 *
 * One shared `ResizeObserver` over the frame bodies reports layout heights, which
 * are board units (the pan/zoom transform is on an ancestor and does not enter
 * a layout size). Read through {@link useMeasuredFrameHeights}, which re-renders
 * its reader only when a height actually changed, and hands it a new Map when it did.
 */
import { useSyncExternalStore } from 'react'

/** A height that moved by less than this is not a change worth a re-render. */
const HEIGHT_EPSILON_PX = 1

const EMPTY: ReadonlyMap<string, number> = new Map()
const frameIds = new WeakMap<Element, string>()
const listeners = new Set<() => void>()
/** An immutable snapshot, replaced on every change: a reader that memoizes on it sees the change. */
let snapshot: ReadonlyMap<string, number> = EMPTY
let observer: ResizeObserver | null = null

function publish(next: Map<string, number>): void {
  snapshot = next
  for (const listener of listeners) listener()
}


function sharedObserver(): ResizeObserver | null {
  if (observer || typeof ResizeObserver === 'undefined') return observer
  // One callback delivers every frame that changed in a frame of time: publish once, not per entry.
  observer = new ResizeObserver((entries) => {
    let next: Map<string, number> | null = null
    for (const entry of entries) {
      const frameId = frameIds.get(entry.target)
      if (frameId === undefined) continue
      const height = entry.contentRect.height
      const previous = (next ?? snapshot).get(frameId)
      if (previous !== undefined && Math.abs(previous - height) < HEIGHT_EPSILON_PX) continue
      next ??= new Map(snapshot)
      next.set(frameId, height)
    }
    if (next) publish(next)
  })
  return observer
}

/** Start reporting `body`'s height as `frameId`'s. Returns the stop function. */
export function observeFrameHeight(body: HTMLElement, frameId: string): () => void {
  const shared = sharedObserver()
  if (!shared) return () => {}
  frameIds.set(body, frameId)
  shared.observe(body)
  return () => {
    shared.unobserve(body)
    frameIds.delete(body)
    if (snapshot.has(frameId)) {
      const next = new Map(snapshot)
      next.delete(frameId)
      publish(next)
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The measured body heights by frame id, as of now; a new Map each time any of them changed. */
export function useMeasuredFrameHeights(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY)
}
