/**
 * optimisticStructuralBroadcast — the Class B (cross-frame) call sites for
 * `adapter.optimistic.insert/delete/move` (`live-07`, STATE.md).
 *
 * These three helpers are what fires a structural gesture's same-tick paint
 * into every mounted BRIDGE frame's real DOM, ahead of the async file write
 * landing and Vite's Fast Refresh taking over for real. They exist because
 * the actual mutation path for every one of the four structural gestures
 * (`insertNode`, `deleteNode`/`deleteNodes`, `moveNodes`, plus the
 * source-write-only `writeInsertToSource`) is a plain store-slice action —
 * never a React component that could `useContext(CanvasFrameAdapterContext)`
 * — so the ONE non-React handle onto "every mounted canvas frame" is
 * `canvasFrameAdapterRegistry.ts`'s `listFrameAdapters()`.
 *
 * In PORTAL mode the same-tick paint is not a DOM trick at all — it's the
 * store mutating its own `NodeTree` and React re-rendering the portal.
 * Portal adapters are therefore skipped here on purpose (kept IN via
 * `isBridgeFrameAdapter`, not filtered OUT via `isPortalFrameAdapter` —
 * importing `PortalFrameAdapter.ts` from here would close a real import
 * cycle back through `previewAxesFrameEffect.ts` -> `store.ts` ->
 * `siteSlice.ts` -> `nodeActions.ts`, which is what calls into this file;
 * `BridgeFrameAdapter.ts` carries no such store dependency) — portal
 * adapters already got their paint for free from the tree mutation, and
 * calling `.optimistic.*` on one too would be a second, redundant DOM write
 * racing the first.
 *
 * Broadcasting to EVERY registered bridge adapter (not just "the one frame
 * this gesture came from") is deliberate and safe: `runtime.ts`'s
 * `findByNodeId` — the thing every `handleOptimistic*` handler calls first —
 * returns `null`/no-ops when the id isn't present in that frame's DOM. There
 * is no cheaper, correct way to know "which frame(s) show this page" outside
 * the store, so a broadcast-and-let-absent-frames-no-op is the whole
 * mechanism — do not build a `pageId -> frames` registry for this.
 */
import { listFrameAdapters } from './canvasFrameAdapterRegistry'
import { isBridgeFrameAdapter } from './BridgeFrameAdapter'
import type { FrameDocumentAdapter } from './FrameDocumentAdapter'

function bridgeAdapters(): FrameDocumentAdapter[] {
  return [...listFrameAdapters().values()].filter((adapter) => isBridgeFrameAdapter(adapter))
}

/**
 * `nodeId` is a real canonical id for `move`/`delete`, or a throwaway
 * `optimistic:<uuid>` placeholder for `insert` (there is no real id yet —
 * see `studioSourceWrites.ts`'s `writeInsertToSource`). Safe because
 * `BridgeFrameAdapter.optimistic.insert` stamps the id directly onto the
 * ghost element and never looks it up in its canonical<->stamp index.
 */
export function broadcastOptimisticInsert(nodeId: string, parentNodeId: string, index: number, tagName: string, text?: string): void {
  for (const adapter of bridgeAdapters()) adapter.optimistic.insert(nodeId, parentNodeId, index, tagName, text)
}

export function broadcastOptimisticDelete(nodeId: string): void {
  for (const adapter of bridgeAdapters()) adapter.optimistic.delete(nodeId)
}

export function broadcastOptimisticMove(nodeId: string, parentNodeId: string, index: number): void {
  for (const adapter of bridgeAdapters()) adapter.optimistic.move(nodeId, parentNodeId, index)
}

/**
 * `speed-01` — the same broadcast-and-let-absent-frames-no-op mechanism
 * above, for a properties-panel style commit or scrub preview
 * (`commitApi.ts`'s `writeToTarget`/`previewToTarget`). `nodeId` is always a
 * real canonical id (a style write never targets a placeholder the way an
 * in-flight `insert` can) — `className`, when present, is a CLASS-target
 * write; see `FrameDocumentAdapter.ts`'s `OptimisticDomOps.style` doc.
 */
export function broadcastOptimisticStyle(nodeId: string, patch: Record<string, string>, className?: string): void {
  for (const adapter of bridgeAdapters()) adapter.optimistic.style(nodeId, patch, className)
}

/** Drops whatever optimistic style rule every bridge frame currently has active for `nodeId` — a scrub ended with no commit, or a field lost focus. */
export function broadcastOptimisticStyleClear(nodeId: string): void {
  for (const adapter of bridgeAdapters()) adapter.optimistic.clearStyle(nodeId)
}
