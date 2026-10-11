/**
 * frameMount — THE module that answers "does board frame X hold a live
 * iframe, and what does it show instead" (SB-5, poster-first mounting).
 *
 * ## One policy, no pool
 *
 * There used to be a pool: every on-screen frame plus as many recently-seen
 * ones as a budget allowed, evicted least-recently-on-screen, with one budget
 * for portal frames and another for Tier-2 bridge frames. That policy mounted
 * every frame in a 600 px margin around the viewport (50 live iframes on the
 * 100-frame corpus zoomed all the way out) and kept departed frames alive "in
 * case". A board is a picture of itself first and a set of documents only
 * where the user is working, so the policy is now a LIVE SET:
 *
 * - selected, edited and play frames are always live (and do not count
 *   against the cap, so a cap can never take a document out from under a
 *   selection);
 * - frames in view at zoom >= {@link POSTER_ZOOM} are live, nearest the
 *   viewport centre first, up to the adaptive cap (`liveFrameCap.ts`:
 *   default 20, never below 12, rising with free memory);
 * - everything else shows its poster, or, before it has one, a placeholder.
 *
 * `liveFrameCap.ts` decides WHICH frames; this module decides what a frame
 * does with the answer, and owns the vocabulary the rest of the app reads it
 * back in (`data-frame-mount`). Pure — no React, no DOM — so the policy is
 * unit-testable apart from the layer that applies it.
 */

/**
 * What a board frame is showing, and so what it costs:
 *
 * - `live` — a real iframe: the frame is selected, edited, played, in view at
 *   a readable zoom within the cap, or is being photographed for its poster.
 * - `poster` — no iframe; the frame's picture.
 * - `cold` — no iframe and no picture yet (never mounted, or edited since):
 *   the title placeholder. The background fill turns these into posters.
 */
export type FrameMountReason = 'live' | 'poster' | 'cold'

/** The attribute `BoardFrameView` stamps a `FrameMountReason` onto. */
export const FRAME_MOUNT_ATTR = 'data-frame-mount'

export interface FrameMount {
  /** Does this frame render its real iframe body, rather than a poster or placeholder? */
  mounted: boolean
  reason: FrameMountReason
}

/**
 * The single answer, for one frame. `isLive` comes from the layer's live set;
 * `hasPoster` from the poster store for the frame's current key.
 */
export function resolveFrameMount({ isLive, hasPoster }: { isLive: boolean; hasPoster: boolean }): FrameMount {
  if (isLive) return { mounted: true, reason: 'live' }
  return { mounted: false, reason: hasPoster ? 'poster' : 'cold' }
}

/**
 * Did the live set actually change? `BoardFramesLayer` recomputes it on every
 * pan/zoom commit and must not re-render when the answer is "no".
 */
export function sameLiveSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const members = new Set(a)
  return b.every((id) => members.has(id))
}

const FRAME_MOUNT_REASONS: readonly FrameMountReason[] = ['live', 'poster', 'cold']

/**
 * Read a frame element's stamped reason back. Returns `null` for an element
 * that is not a board frame, or a board frame from a build that predates the
 * stamp — callers treat that as "no answer", never as "not mounted".
 */
export function readFrameMountReason(element: Element | null | undefined): FrameMountReason | null {
  const raw = element?.getAttribute(FRAME_MOUNT_ATTR)
  return FRAME_MOUNT_REASONS.find((reason) => reason === raw) ?? null
}
