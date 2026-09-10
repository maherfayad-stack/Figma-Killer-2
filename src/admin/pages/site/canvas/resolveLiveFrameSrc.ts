/**
 * resolveLiveFrameSrc — the ONE place `IframeFrameSurface`'s bridge-mode
 * (`documentMode: 'bridge'`, `live-05`, STATE.md) iframe's `src=` URL is
 * constructed.
 *
 * Isolated deliberately: `documentMode='bridge'`'s `src` is genuinely
 * unresolvable to a real working URL until L6's `/__screen/<key>` route
 * exists (plan sequencing — L5 before L6-L9). Threading the construction
 * through one small, well-named function means wiring the real URL shape
 * once L6 lands is a one-function change here, not a re-hunt through every
 * bridge-mode call site. The shape below (`<liveOrigin>/__screen/<key>`) is
 * this session's best-effort placeholder matching L6's own already-named
 * route — not yet exercised end-to-end (no dev server / L6 route exists to
 * resolve against), verified only at the level "does this function produce
 * a well-formed absolute URL from its inputs."
 */

/**
 * Everything `IframeFrameSurface`'s bridge branch needs, beyond what portal
 * mode already has: where the project's live dev server proxy lives (L2's
 * live-origin), which screen/page to boot there (L6's own key), and this
 * page's node ids in document order (`BridgeFrameAdapter`'s canonical<->wire
 * stamp-index translation needs the full set up front — see
 * `liveNodeResolve.ts`'s `buildStampIndex`).
 */
export interface LiveFrameSource {
  /** L2's live-origin base for the open project (the second-port dev-server proxy). */
  liveOrigin: string
  /** The L6 `/__screen/<key>` route's key identifying which page/screen to boot inside the frame. */
  screenKey: string
  /** This page's node ids, in document (tree) order — the same input `BridgeFrameAdapter`'s constructor already requires. */
  nodeIdsInTreeOrder: readonly string[]
}

export function resolveLiveFrameSrc(source: LiveFrameSource): string {
  return `${source.liveOrigin}/__screen/${encodeURIComponent(source.screenKey)}`
}
