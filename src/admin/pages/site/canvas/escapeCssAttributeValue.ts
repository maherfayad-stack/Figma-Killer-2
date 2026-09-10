/**
 * escapeCssAttributeValue — split out of `canvasNodeLookup.ts` (`live-05`,
 * STATE.md, the architect's Batch 4 resolution) to break a real import
 * cycle: `PortalFrameAdapter.ts` needs this pure string helper for its own
 * `[data-node-id="…"]` selectors, and `canvasNodeLookup.ts` now imports
 * `PortalFrameAdapter.ts` (for `isPortalFrameAdapter`) — a zero-dependency
 * leaf module is the correct home for something both sides need, not
 * leaving it in whichever of the two happened to define it first.
 */

/** Escape a value for safe interpolation into a `[attr="…"]` CSS selector. */
export function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
