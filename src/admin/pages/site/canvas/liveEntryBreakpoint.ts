/**
 * liveEntryBreakpoint — which breakpoint Live view opens on.
 *
 * Live view shows ONE real-size frame whose width is the active breakpoint's.
 * The store's default is `desktop` (1440), which opened a Mobile project (its
 * screens are 393 wide) at 1440 px and broke every layout the project was
 * designed for. The project already records the form factor it is designed
 * for as `frameDefaults.width` (`.studio/meta.json`, set at creation from the
 * platform preset), so Live opens on the breakpoint nearest that width.
 */
import type { Breakpoint } from '@core/page-tree'

/** The breakpoint whose width is nearest `frameWidth`; `null` when the project records no width or there are no breakpoints. */
export function liveEntryBreakpointId(breakpoints: readonly Breakpoint[], frameWidth: number | undefined): string | null {
  if (!frameWidth || breakpoints.length === 0) return null
  let best = breakpoints[0]
  for (const bp of breakpoints) {
    if (Math.abs(bp.width - frameWidth) < Math.abs(best.width - frameWidth)) best = bp
  }
  return best.id
}
