/**
 * Phase 3b (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — the custom engine's
 * counterpart to `frame-shape.tsx`'s (tldraw-only) module-level iframe
 * registry ("P2/WS-B iframe registry" in that file's own doc).
 * `edit-mode-layer.tsx` needs to reach into the CURRENT edit-mode frame's
 * live `<iframe>` element to open a bridge connection on it — on the
 * tldraw path that's `frame-shape.tsx`'s registry (`CcsFrameShapeComponent`
 * populates it); on the custom engine, `FrameShape.tsx` (2b) populates THIS
 * one instead, keyed the same way (`CanvasFrameRecord.id`, no shape-id
 * indirection needed here any more than anywhere else in this engine).
 *
 * Kept as its own small module (not folded into `FrameShape.tsx` itself)
 * for the exact same reason `frame-shape.tsx` keeps its version at module
 * scope rather than React context: there's exactly one `CustomEngineCanvas`
 * per page in this architecture, so a plain module-level `Map` + listener
 * `Set` is equivalent to a context in practice with far less plumbing, and
 * it lets `CustomEditModeLayerBridge` (`CustomEngineCanvas.tsx`) pass
 * `getRegisteredFrameIframe`/`onFrameIframeRegistryChange` straight into
 * `edit-mode-layer.tsx`'s new `getFrameIframe`/`onFrameIframeChange` props
 * without threading a ref through several component layers.
 *
 * Why this couldn't just be "have `edit-mode-layer.tsx` keep importing from
 * `frame-shape.tsx`": that file is tldraw-specific and explicitly off-limits
 * to change for this task (the tldraw path must not change AT ALL), and
 * `FrameShape.tsx`/`Canvas.tsx` (the custom engine's own rendering layer)
 * have no reason to depend on a tldraw-adjacent module just to register an
 * iframe element — this is a clean, engine-owned equivalent instead.
 */

type IframeRegistryListener = () => void;

const iframeRegistry = new Map<string, HTMLIFrameElement>();
const iframeRegistryListeners = new Set<IframeRegistryListener>();

/** Registers (or clears, with `iframe: null`) the live `<iframe>` element
 * for a given frame id. A no-op if the registry already holds the exact
 * same element (or is already clear) for that id, so a re-render that
 * doesn't actually change anything doesn't spuriously notify listeners. */
export function setRegisteredFrameIframe(frameId: string, iframe: HTMLIFrameElement | null): void {
  const had = iframeRegistry.get(frameId);
  if (had === iframe) return;
  if (iframe) iframeRegistry.set(frameId, iframe);
  else iframeRegistry.delete(frameId);
  for (const listener of iframeRegistryListeners) listener();
}

export function getRegisteredFrameIframe(frameId: string): HTMLIFrameElement | null {
  return iframeRegistry.get(frameId) ?? null;
}

export function onFrameIframeRegistryChange(listener: IframeRegistryListener): () => void {
  iframeRegistryListeners.add(listener);
  return () => iframeRegistryListeners.delete(listener);
}
