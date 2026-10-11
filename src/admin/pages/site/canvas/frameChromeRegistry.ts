/**
 * frameChromeRegistry — which chrome elements belong to which frame, for the
 * code that has to reach a frame's chrome from the FRAME's side of the boundary
 * without being handed it.
 *
 * `pressRing.ts` is the caller: a press arrives as an event inside the frame's
 * document (`NodeRenderer`) and must restyle the frame's hover ring, which now
 * lives in the parent document beside the iframe. The frame's iframe element is
 * reachable from the event (`window.frameElement`); the ring is not, so the
 * overlay that renders it registers a getter under that iframe.
 *
 * A getter, not the element: the ring is a React element the overlay mounts and
 * unmounts with the permission gate, and the registry must never hold a stale
 * one.
 */
export interface FrameChromeHandles {
  /** The frame's hover ring, or `null` while it is not mounted. */
  hoverRing: () => HTMLElement | null
}

const registry = new Map<HTMLIFrameElement, FrameChromeHandles>()

/** Registers `handles` for `iframe`. Returns how to take them away again (only if they are still the ones registered). */
export function registerFrameChrome(iframe: HTMLIFrameElement, handles: FrameChromeHandles): () => void {
  registry.set(iframe, handles)
  return () => {
    if (registry.get(iframe) === handles) registry.delete(iframe)
  }
}

/** The chrome registered for `iframe`, or `null`. */
export function frameChromeFor(iframe: Element | null): FrameChromeHandles | null {
  return iframe instanceof HTMLIFrameElement ? (registry.get(iframe) ?? null) : null
}
