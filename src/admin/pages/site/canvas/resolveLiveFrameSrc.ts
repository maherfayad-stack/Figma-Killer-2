/**
 * resolveLiveFrameSrc — the ONE place `IframeFrameSurface`'s bridge-mode
 * (`documentMode: 'bridge'`, `live-05`, STATE.md) iframe's `src=` URL is
 * constructed.
 *
 * Isolated deliberately: `documentMode='bridge'`'s `src` was genuinely
 * unresolvable to a real working URL until L6's `/__screen/<key>` route
 * existed (plan sequencing — L5 before L6-L9). That route now exists — the
 * generated shell's `App.jsx` matches `/__screen/<key>` as a pathname suffix
 * (`server/handlers/studio/prototypeShell/shellFiles.ts`) and Studio's own
 * live-origin proxy (`server/liveOrigin.ts`) forwards the full, prefixed
 * path unchanged to a dev server configured with a matching Vite `base`
 * (`server/handlers/studio/devServer.ts`'s `STUDIO_LIVE_BASE_PATH`) — so the
 * URL this function builds resolves to a real page when driven directly
 * (curl/browser against a running dev server, proxied or bare). What is
 * still NOT built is the caller: nothing in production yet constructs a
 * `LiveFrameSource` and flips a real board frame's `documentMode` to
 * `'bridge'` — see `IframeFrameSurface.tsx`'s own doc for that gap.
 */
import type { PreviewAxes } from '@core/studio-board'

/**
 * Everything `IframeFrameSurface`'s bridge branch needs, beyond what portal
 * mode already has: where the project's live dev server proxy lives (L2's
 * live-origin), which screen/page to boot there (L6's own key), the preview
 * axes to apply (direction/colour-scheme/locale — the same query params the
 * generated shell's `/__screen/<key>` route reads), and this page's node ids
 * in document order (`BridgeFrameAdapter`'s canonical<->wire stamp-index
 * translation needs the full set up front — see `liveNodeResolve.ts`'s
 * `buildStampIndex`).
 */
export interface LiveFrameSource {
  /** L2's live-origin base for the open project (the second-port dev-server proxy). */
  liveOrigin: string
  /** The L6 `/__screen/<key>` route's key identifying which page/screen to boot inside the frame. */
  screenKey: string
  /** This page's node ids, in document (tree) order — the same input `BridgeFrameAdapter`'s constructor already requires. */
  nodeIdsInTreeOrder: readonly string[]
  /** Direction/colour-scheme/locale to apply inside the live frame — the same triple every other preview surface reads. */
  axes: PreviewAxes
}

/**
 * `<liveOrigin>/__screen/<key>?dir=&theme=&lang=` — `lang` is omitted
 * entirely when `axes.locale` is unset, matching the generated shell's own
 * `ScreenRoute` fallback (`PREVIEW_AXES`'s project default) for "no override
 * requested" rather than sending an empty string it would have to
 * special-case.
 */
export function resolveLiveFrameSrc(source: LiveFrameSource): string {
  const url = new URL(`${source.liveOrigin}/__screen/${encodeURIComponent(source.screenKey)}`)
  url.searchParams.set('dir', source.axes.direction)
  url.searchParams.set('theme', source.axes.colorScheme)
  if (source.axes.locale) url.searchParams.set('lang', source.axes.locale)
  return url.toString()
}
