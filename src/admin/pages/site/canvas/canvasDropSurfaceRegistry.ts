/**
 * canvasDropSurfaceRegistry — every mounted design frame a drag could drop
 * INTO, and the three handles a cross-frame drop needs from each: the
 * transform-scaled viewport its candidate rects are measured against, the
 * iframe whose document holds those candidates, and the frame's own empty
 * drag layer to paint the drop line into.
 *
 * ## Why a module-scoped registry and not the store
 *
 * "Which frames are on screen right now" is already answered — by
 * `frameVirtualization.ts`, which decides which frames MOUNT at all, and by
 * the mount pool that keeps a few more warm. Membership here IS that answer:
 * an overlay registers when it mounts and unregisters when it goes, so this
 * list is exactly "the design frames that currently exist", with no second
 * viewport test and no scan of `site.pages`.
 *
 * It is deliberately NOT store state. A drag reads it on every animation
 * frame; a `useEditorStore(selector)` that enumerated frames would re-run on
 * every unrelated store change, which is the one thing the canvas performance
 * rules forbid outright.
 *
 * ## Why the drop layer is the FRAME's, not the dragger's
 *
 * `.viewport` is `overflow: hidden`, so a frame's drag layer is clipped to
 * that frame. Painting a cross-frame drop line into the ORIGIN frame's layer
 * would draw it where nobody can see it. Each frame owns a layer; the session
 * paints into whichever frame the pointer is over and clears the one it left.
 *
 * ## `pageId`, not `frameId`, decides what a drop MEANS
 *
 * Two frames can show the same page — a "duplicate as variant" sibling (WS-10
 * Phase 2). Dropping between those two is an ordinary same-file reparent, not
 * a cross-file move, so the session compares PAGE ids and only takes the
 * cross-file path when they genuinely differ.
 */

/** One mounted design frame, as a drag sees it. */
export interface CanvasDropSurface {
  /** Frame identity (WS-10 Phase 2) — distinguishes two frames of one page. */
  frameId: string | null
  /** The page this frame renders, and therefore the FILE a drop here writes. */
  pageId: string | null
  /** The transform-scaled element `buildFrameCandidateIndex` measures against. */
  viewport: HTMLElement
  /** The frame's iframe, whose document holds the `[data-node-id]` candidates. */
  iframe: HTMLIFrameElement | null
  /** This frame's own empty drag layer (`CanvasDropIndicators`), or `null` before it mounts. */
  dropLayer: () => HTMLElement | null
}

const surfaces = new Map<object, CanvasDropSurface>()

/**
 * Bumped on every registration change.
 *
 * A drag measures every surface's client rect ONCE and reuses it — the same
 * "constant for the length of the gesture" reasoning `FrameCandidateIndex`
 * records. Frames genuinely can arrive mid-gesture, though (auto-panning to
 * the board's edge mounts the frames it reveals), so the session compares this
 * number and re-measures when it moves. A counter rather than a callback
 * because the session is already polling once per animation frame and a
 * callback would only add a second path to the same answer.
 */
let version = 0

/** Publish a frame. `key` is any stable per-overlay token; the same one unregisters it. */
export function registerCanvasDropSurface(key: object, surface: CanvasDropSurface): void {
  surfaces.set(key, surface)
  version += 1
}

export function unregisterCanvasDropSurface(key: object): void {
  if (!surfaces.delete(key)) return
  version += 1
}

/** Every mounted design frame. Live view — do not mutate. */
export function listCanvasDropSurfaces(): readonly CanvasDropSurface[] {
  return [...surfaces.values()]
}

/** Changes whenever a frame is added or removed. See {@link version}. */
export function canvasDropSurfaceVersion(): number {
  return version
}
