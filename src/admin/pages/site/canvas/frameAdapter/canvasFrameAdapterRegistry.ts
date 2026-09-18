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
 */
import type { FrameDocumentAdapter } from './FrameDocumentAdapter'

const registry = new Map<HTMLIFrameElement, FrameDocumentAdapter>()

export function registerFrameAdapter(iframe: HTMLIFrameElement, adapter: FrameDocumentAdapter): void {
  registry.set(iframe, adapter)
  notifyFrameAdapterChange()
}

export function unregisterFrameAdapter(iframe: HTMLIFrameElement): void {
  if (!registry.delete(iframe)) return
  notifyFrameAdapterChange()
}

/** Every mounted canvas frame's adapter, keyed by its iframe element. Live view — do not mutate. */
export function listFrameAdapters(): ReadonlyMap<HTMLIFrameElement, FrameDocumentAdapter> {
  return registry
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
