/**
 * canvasHover — the hovered node, kept OFF the editor store (P2-I, PERF-1).
 *
 * ## Why hover is not in `useEditorStore`
 *
 * Hover is the most frequent event the editor has: a pointer crossing a page
 * produces a leave and an enter per element. While hover lived in the store,
 * every crossing was a `set()`, and Zustand runs every subscribed selector on
 * every `set()` — the canvas mounts one `NodeRenderer` per node per mounted
 * frame, each with its own selectors, so one crossing on a 40 × 300 board
 * with 12 mounted frames ran ~40k selectors of pure JS before React started
 * (`01-perf.md` §1: 6–18 ms per event; P2-A's hover sweep: 48 frames over
 * 20 ms, worst 124–150 ms). Nothing in the document depends on hover — it is
 * never saved, never undone, never read by a mutation — so it does not belong
 * in the document's store at all. Penpot draws the same line: hover lives in
 * viewport-local state, never its global store.
 *
 * ## Shape
 *
 * One current value, and two ways to listen:
 *
 * - **keyed, by node id** ({@link useIsNodeHovered}) — a Layers row wakes only
 *   when ITS node gains or loses hover. A crossing wakes exactly two rows.
 * - **whole value** ({@link useCanvasHoverSelect}, {@link subscribeCanvasHover})
 *   — the per-frame overlay (rings, the tree ladder, measurement) needs to
 *   know WHERE hover is, and there is one of those per mounted frame, not per
 *   node.
 *
 * `NodeRenderer` does not listen at all: its old per-node hover subscription
 * fed a `data-hovered` attribute no stylesheet ever read (the hover ring is
 * the overlay's, drawn inside the frame).
 *
 * ## Who clears it
 *
 * The store actions that used to null the three hover fields in their recipes
 * (a cleared selection, a document switch, arming Play, a reparse that
 * re-addresses nodes) call {@link clearCanvasHover} / {@link followCanvasHover}
 * instead. Notifying from inside a recipe is safe: every listener here only
 * schedules a React update, none reads the store.
 */
import { useSyncExternalStore } from 'react'
import { createKeyedNotifier } from './keyedNotifier'

export interface CanvasHover {
  readonly nodeId: string
  /** Breakpoint frame the hover came from; `null` is a global hover (a Layers row) that every frame mirrors. */
  readonly breakpointId: string | null
  /**
   * WS-10 Phase 2 — the `BoardFrame.id` the hover came from; `null` is global.
   * A separate dimension from `breakpointId`: every board frame shares the
   * synthetic `'studio'` breakpoint id, so only this tells two variant frames
   * of one page apart (see `CanvasFrameContext`'s doc).
   */
  readonly frameId: string | null
}

let current: CanvasHover | null = null
const wholeValueListeners = new Set<() => void>()
const byNode = createKeyedNotifier()

export function getCanvasHover(): CanvasHover | null {
  return current
}

/**
 * Set the hovered node (`null` clears). A no-op when nothing changes — a
 * bridge frame's coalesced `move` fires once per animation frame while the
 * pointer rests on one node, and a portal frame's pointer events are not
 * coalesced at all (`speed-03`).
 */
export function setCanvasHover(
  nodeId: string | null,
  breakpointId: string | null = null,
  frameId: string | null = null,
): void {
  const previous = current
  if (nodeId === null) {
    if (previous === null) return
    current = null
  } else {
    if (
      previous !== null &&
      previous.nodeId === nodeId &&
      previous.breakpointId === breakpointId &&
      previous.frameId === frameId
    ) {
      return
    }
    current = { nodeId, breakpointId, frameId }
  }
  const changedNodes: string[] = []
  if (previous) changedNodes.push(previous.nodeId)
  if (current && current.nodeId !== previous?.nodeId) changedNodes.push(current.nodeId)
  byNode.notify(changedNodes)
  for (const listener of [...wholeValueListeners]) listener()
}

export function clearCanvasHover(): void {
  setCanvasHover(null)
}

/**
 * ERR-5 — carry the hover across a reparse that re-addresses nodes: to the
 * element's new id when `follow` knows it, cleared when the element is gone.
 * Same contract as the selection's own follow (`lifecycleActions.ts`).
 */
export function followCanvasHover(follow: (nodeId: string) => string | null): void {
  if (current === null) return
  const next = follow(current.nodeId)
  if (next === null) clearCanvasHover()
  else if (next !== current.nodeId) setCanvasHover(next, current.breakpointId, current.frameId)
}

export function subscribeCanvasHover(listener: () => void): () => void {
  wholeValueListeners.add(listener)
  return () => {
    wholeValueListeners.delete(listener)
  }
}

/** Wakes `listener` only when `nodeId` gains or loses hover. */
export function subscribeCanvasHoverNode(nodeId: string, listener: () => void): () => void {
  return byNode.subscribe(nodeId, listener)
}

/**
 * A value derived from the hover — for the handful of per-FRAME consumers,
 * never a per-node one. `select` must return a primitive (or a stable
 * reference): the consumer re-renders only when that result changes, which
 * is what keeps a crossing from re-rendering every mounted frame's overlay.
 */
export function useCanvasHoverSelect<T>(select: (hover: CanvasHover | null) => T): T {
  const snapshot = () => select(current)
  return useSyncExternalStore(subscribeCanvasHover, snapshot, snapshot)
}

/** Whether `nodeId` is hovered, anywhere. Keyed: a crossing re-renders exactly the two rows involved. */
export function useIsNodeHovered(nodeId: string): boolean {
  const snapshot = () => current?.nodeId === nodeId
  return useSyncExternalStore((listener) => subscribeCanvasHoverNode(nodeId, listener), snapshot, snapshot)
}
