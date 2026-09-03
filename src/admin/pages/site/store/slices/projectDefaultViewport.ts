/**
 * projectDefaultViewport — which viewport a project OPENS on.
 *
 * `activeBreakpointId` starts at `'desktop'`, which is the right guess for a
 * website and the wrong one for a phone app: every screen in a mobile project
 * is drawn at phone width, so opening on desktop showed a 393px design stretched
 * across a 1440px frame and made picking the phone the first thing anyone did on
 * every load.
 *
 * The signal is the project's own default frame size (`.studio/meta.json`'s
 * `frameDefaults`, mirrored in `boardSlice`), read through the SAME
 * `resolveDeviceKind` the live-mode device mockup uses — so "this project is
 * phone-shaped" means exactly what it means everywhere else in the canvas, and
 * a project whose frames are 393 wide opens on the viewport that renders them
 * at 393.
 *
 * Applied ONCE per project load, and only while the author has not picked a
 * viewport themselves — it is a default, not a policy. Both of the two moments
 * that can complete the picture call in here (the site's breakpoints arriving,
 * and the frame defaults arriving) because they are two independent fetches and
 * either can land second.
 */
import type { Draft } from 'mutative'
import type { Breakpoint } from '@core/page-tree'
import { deviceKindForWidth, resolveDeviceKind } from '@site/canvas/deviceKind'
import type { EditorStore } from '@site/store/types'

/**
 * The breakpoint a project whose frames are `frameWidth` wide should open on,
 * or `null` to leave the current one alone.
 *
 * Takes the WIDTH rather than the whole `FrameDefaults` so this module has no
 * reason to import `boardSlice`, which imports it — the one cycle
 * `no-circular-dependencies` would have caught. It needs one number anyway.
 *
 * `null` covers every case where there is nothing better to say: no recorded
 * frame width, a desktop-shaped project (already the default), or a phone-shaped
 * project whose site declares no phone viewport to switch to.
 */
export function resolveProjectDefaultBreakpointId(
  breakpoints: readonly Breakpoint[],
  frameWidth: number | undefined,
): string | null {
  const width = frameWidth
  if (typeof width !== 'number' || width <= 0) return null
  // A frame is a screen, so ask the same question the mockup asks about one.
  const kind = deviceKindForWidth(width)
  if (kind === null) return null
  const match = breakpoints.find((breakpoint) => resolveDeviceKind(breakpoint) === kind)
  return match?.id ?? null
}

/**
 * Apply the default viewport if this project load has not already had one.
 *
 * Marks the load as decided even when it changes nothing, so a project that
 * legitimately opens on desktop does not re-run this on every later frame-
 * defaults write.
 */
export function applyProjectDefaultViewport(state: Draft<EditorStore>): void {
  if (state.defaultViewportApplied) return
  const breakpoints = state.site?.breakpoints
  // Both halves have to be in hand: the site brings the viewports, the frame
  // defaults say which one this project is shaped for.
  if (!breakpoints || !state.frameDefaultsSettled) return
  state.defaultViewportApplied = true
  const next = resolveProjectDefaultBreakpointId(breakpoints, state.frameDefaults.width)
  if (!next || next === state.activeBreakpointId) return
  state.activeBreakpointId = next
  state.activeConditionId = null
}
