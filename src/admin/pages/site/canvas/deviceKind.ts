/**
  * deviceKind — which physical device, if any, live mode should draw around
 * the page.
 *
 * Live mode already renders the page at a breakpoint's width. That answers
 * "does it reflow" but not "does it look like a phone" — a 375px-wide strip
 * running the full height of a desktop window reads as a narrow website, not
 * as a screen someone holds. The mockup supplies the missing physical context:
 * bezel, corner radius, and the notch/home-indicator furniture that a real
 * design has to survive.
 *
 * ## Why the breakpoint's `icon` decides it
 *
 * `Breakpoint.icon` is already an explicit, user-controlled statement about
 * what kind of device a viewport context represents — it is chosen in
 * Settings → Viewport contexts and rendered in the toolbar. Reading it here
 * means a site that renames `mobile` to `handset`, or adds a second phone
 * context at 320px, gets the right chrome with no extra configuration and no
 * new field to keep in sync.
 *
 * Matching on breakpoint `id` instead would have worked only for the three
 * seeded ids (`DEFAULT_BREAKPOINTS`) and silently fallen back to bare on every
 * custom context — the common case for any real project.
 *
 * Width is the FALLBACK, not the primary signal, because `icon` is a free
 * string (any pixel-art-icons name is valid) and a site may legitimately use
 * something other than the three canonical names. The thresholds are
 * deliberately generous: they only have to separate "phone-ish" from
 * "tablet-ish" from "everything else".
 *
 * ## Desktop draws nothing, on purpose
 *
 * A monitor bezel around a desktop breakpoint would be decoration with no
 * information in it — a desktop page has no notch to avoid, no rounded screen
 * corners to lose content behind, and the browser chrome it really sits in is
 * the one the author is already looking at.
 */

import type { Breakpoint } from '@core/page-tree'

/** The device chromes live mode can draw. `null` anywhere means "no mockup". */
export type DeviceKind = 'phone' | 'tablet'

/**
 * Bezel thickness in CSS px, per device.
 *
 * Lives in TS rather than CSS because it is needed in two places that must
 * agree: the stylesheet draws it, and `CanvasLiveSurface` subtracts it when
 * fitting the mockup to the available width. A bezel is drawn OUTSIDE the
 * screen box (a `box-shadow` spread, so it costs no layout width and the page
 * keeps its exact breakpoint width) — which also means nothing else would stop
 * it being clipped by the surface's overflow on a narrow window.
 */
export const DEVICE_BEZEL_PX: Record<DeviceKind, number> = {
  phone: 12,
  tablet: 16,
}

/** Icons that name a device outright. Anything else falls through to width. */
const ICON_DEVICE: Record<string, DeviceKind | null> = {
  smartphone: 'phone',
  tablet: 'tablet',
  monitor: null,
}

/** Widest viewport still drawn as a phone when the icon does not say. */
const PHONE_MAX_WIDTH = 480

/** Widest viewport still drawn as a tablet when the icon does not say. */
const TABLET_MAX_WIDTH = 1024

/**
 * The device chrome for a breakpoint, or `null` for none.
 *
 * `null` breakpoint (still hydrating) is `null` rather than a guess: drawing a
 * phone around a skeleton that turns out to be a desktop would flash the wrong
 * device on every load.
 */
export function resolveDeviceKind(breakpoint: Breakpoint | null): DeviceKind | null {
  if (!breakpoint) return null
  const named = ICON_DEVICE[breakpoint.icon]
  // `undefined` = the icon names no device and we fall through to width;
  // `null` = the icon explicitly means "not a device" (a monitor), which is an
  // answer, not a gap, so it must not fall through.
  if (named !== undefined) return named
  return deviceKindForWidth(breakpoint.width)
}

/**
 * The device chrome a bare WIDTH implies — the fallback above, exposed for
 * callers that have a size and no viewport to go with it (a project's default
 * frame width, deciding which viewport to open on). Same thresholds, one copy.
 */
export function deviceKindForWidth(width: number): DeviceKind | null {
  if (width <= PHONE_MAX_WIDTH) return 'phone'
  if (width <= TABLET_MAX_WIDTH) return 'tablet'
  return null
}
