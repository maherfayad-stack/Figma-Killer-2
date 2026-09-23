/**
 * canvasFrameAdapterRegistry — the module-scoped record of "every mounted
 * canvas frame's own adapter," so a Class B caller (`live-05`, STATE.md —
 * the architect's Batch 4 resolution) can enumerate every frame instead of
 * scanning `document.querySelectorAll('iframe')` + reading
 * `frame.contentDocument`, which is structurally impossible cross-origin.
 *
 * A real `Map`, not a `WeakMap`: callers need to ENUMERATE every registered
 * frame (`listFrameAdapters`), not just look up a known key — a `WeakMap`
 * offers no iteration by design.
 *
 * Registry membership IS "is a canvas frame": only `IframeFrameSurface`
 * ever registers one, in the SAME effect that already constructs/disposes
 * the adapter (both `documentMode` branches) — `register`/`unregister` are
 * two more calls in an already-existing lifecycle, not a new one.
 *
 * `unregisterFrameAdapter` is deliberately keyed by the SAME `iframe`
 * reference `registerFrameAdapter` was called with, not by the adapter
 * itself — an unmounting frame's effect cleanup always has the iframe
 * element still in scope (its `iframeRef`), which is the stable identity
 * across a frame's lifetime; the adapter instance is what CHANGES underneath
 * it (a fresh one per `iframeDoc`/`documentMode` transition).
 *
 * `speed-01` — each registration also carries the frame's own `breakpointId`
 * (`IframeFrameSurface`'s own prop, in scope at every `registerFrameAdapter`
 * call site). `optimisticStructuralBroadcast.ts`'s `broadcastOptimisticStyle`
 * needs it to target a breakpoint-context style preview at ONLY the bridge
 * frame(s) rendering that breakpoint — a live board frame IS a breakpoint
 * frame, so this is not an edge case, it is the common one. One registration
 * object per iframe is the single source of truth; `listFrameAdapters()`
 * stays adapter-only (its existing 8 call sites never need the breakpoint
 * id) and is derived from the same map `listFrameAdapterRegistrations()`
 * reads, so the two views can never drift apart.
 */
import type { FrameDocumentAdapter } from './FrameDocumentAdapter'

export interface FrameAdapterRegistration {
  adapter: FrameDocumentAdapter
  breakpointId: string
}

const registry = new Map<HTMLIFrameElement, FrameAdapterRegistration>()

export function registerFrameAdapter(iframe: HTMLIFrameElement, adapter: FrameDocumentAdapter, breakpointId: string): void {
  registry.set(iframe, { adapter, breakpointId })
  notifyFrameAdapterChange()
}

export function unregisterFrameAdapter(iframe: HTMLIFrameElement): void {
  if (!registry.delete(iframe)) return
  notifyFrameAdapterChange()
}

/** Every mounted canvas frame's adapter, keyed by its iframe element. A fresh, point-in-time view — every existing caller reads it immediately (iterates, `.get()`s, or spreads it) rather than holding it across a registry change. */
export function listFrameAdapters(): ReadonlyMap<HTMLIFrameElement, FrameDocumentAdapter> {
  const view = new Map<HTMLIFrameElement, FrameDocumentAdapter>()
  for (const [iframe, registration] of registry) view.set(iframe, registration.adapter)
  return view
}

/** Every mounted canvas frame's full registration (adapter + breakpoint id), keyed by its iframe element. Same point-in-time-view contract as {@link listFrameAdapters}. */
export function listFrameAdapterRegistrations(): ReadonlyMap<HTMLIFrameElement, FrameAdapterRegistration> {
  return new Map(registry)
}

/**
 * Callbacks for "the set of registered adapters changed".
 *
 * `BreakpointSelectionOverlay` is rendered as a SIBLING of the frame surface,
 * not a descendant, so it cannot read `CanvasFrameAdapterContext` — it only
 * holds the iframe element. It needs the adapter to subscribe to the frame's
 * `hmr:before`/`hmr:after`/`frame:resize` runtime events (S4), and the
 * registration effect inside `IframeFrameSurface` may run either before or
 * after the overlay's own effect. Polling for it would reintroduce exactly the
 * kind of loop S4 removes, so registration announces itself instead.
 */
const changeListeners = new Set<() => void>()

function notifyFrameAdapterChange(): void {
  for (const listener of changeListeners) listener()
}

/** Subscribe to registrations/unregistrations. Returns an unsubscribe. */
export function onFrameAdapterRegistryChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}
