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
}

export function unregisterFrameAdapter(iframe: HTMLIFrameElement): void {
  registry.delete(iframe)
}

/** Every mounted canvas frame's adapter, keyed by its iframe element. Live view — do not mutate. */
export function listFrameAdapters(): ReadonlyMap<HTMLIFrameElement, FrameDocumentAdapter> {
  return registry
}
