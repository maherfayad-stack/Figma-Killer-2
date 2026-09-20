/**
 * LiveBoardFrame — L8 Phase A (`perf-06`, STATE.md): the Tier-2 half of
 * `BoardFrameView`'s render fork (the other half stays today's unmodified
 * portal `BreakpointFrame`, for Tier 0/1).
 *
 * Mounts BOTH subtrees at once — a Tier-0 fallback (a cached poster, or a
 * plain portal `BreakpointFrame` over the SAME page tree the store already
 * holds — the static parse is trust-tier-independent) and the real bridge
 * iframe — so the bridge's cold boot runs CONCURRENTLY with showing the
 * fallback instead of paying that cost serially after the fallback is
 * already on screen. Swaps to the bridge iframe the instant its adapter
 * fires `ready` (`live-05`'s own signal, already built and tested on both
 * `PortalFrameAdapter` and `BridgeFrameAdapter` — no new "ready" concept
 * needed here).
 *
 * The bridge iframe stays mounted across the whole not-ready → ready
 * transition — only its `hidden` attribute toggles — so the `postMessage`
 * channel `IframeFrameSurface` already opened for it never has to
 * reconnect. The fallback subtree, by contrast, fully UNMOUNTS once ready:
 * there is no reason to keep a same-origin portal render alive underneath a
 * working live frame.
 *
 * Known, accepted gap (see `perf-06`'s STATE.md entry). Once a frame reaches
 * `ready`, no further poster is ever captured for it — `useFramePosterCapture`
 * cannot read into a cross-origin document (`live-05`'s own deliberate
 * deferral). Phase B is what wires poster capture to also run against this
 * component's Tier-0-fallback subtree while IT is the visible one (same-
 * origin at that moment); this component does not call
 * `useFramePosterCapture` itself.
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import type { Breakpoint, Page } from '@core/page-tree'
import type { PreviewAxes } from '@core/studio-board'
import { BreakpointFrame } from '../BreakpointFrame'
import { useResolvedFrameAxes } from '../previewAxesFrameEffect'
import type { LiveFrameSource } from '../resolveLiveFrameSrc'
import type { FrameDocumentAdapter } from '../frameAdapter/FrameDocumentAdapter'
import { useLiveOrigin } from '@site/studio/useLiveOrigin'
import { useDevServerReadiness } from '@site/studio/useDevServerReadiness'
import { getStudioProjectKey, subscribeStudioProjectKey } from '@site/studio/studioProjectTrust'
import { FramePosterPlaceholder } from './FramePosterPlaceholder'
import { getFramePoster } from './frameSnapshotCache'
import { useAdapterReady } from './useAdapterReady'
import { useBridgeFrameDiagnostics } from '../useBridgeFrameDiagnostics'
import { useBridgeFrameInteraction } from './useBridgeFrameInteraction'

interface LiveBoardFrameProps {
  page: Page
  breakpoint: Breakpoint
  isActive: boolean
  onActivate: (breakpointId: string) => void
  frameId: string
  axesOverride?: Partial<PreviewAxes>
  /** This frame's own board-space width — same value `getFramePoster` keys the poster cache on. */
  width: number
}

export function LiveBoardFrame({
  page,
  breakpoint,
  isActive,
  onActivate,
  frameId,
  axesOverride,
  width,
}: LiveBoardFrameProps) {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const bareLiveOrigin = useLiveOrigin()
  const projectKey = useSyncExternalStore(subscribeStudioProjectKey, getStudioProjectKey, getStudioProjectKey)
  const readiness = useDevServerReadiness(projectDir)
  const axes = useResolvedFrameAxes(axesOverride)

  const [adapter, setAdapter] = useState<FrameDocumentAdapter | null>(null)
  const ready = useAdapterReady(adapter)

  // Z5 — a crash inside this cross-origin frame is posted over the bridge as
  // an `error` message and reaches nothing unless somebody records it. The
  // scope key is this board frame's own id, which is what `BoardFrameView`'s
  // badge subscribes to; the same call also makes the findings visible to
  // `studio_page_diagnostics`, which reads this iframe's `contentWindow`.
  useBridgeFrameDiagnostics(adapter, frameId)
  // `live-12` — clicks and wheel forwarded out of the cross-origin frame
  // reach selection and zoom; without this they reached nothing.
  useBridgeFrameInteraction(adapter, { breakpointId: breakpoint.id, frameId, isActive, onActivate })

  // `server/liveOrigin.ts` (L2) routes on the `/p/<projectKey>` path
  // segment — `useLiveOrigin` only knows the bare server-topology origin
  // (project-agnostic by design, see that hook's own doc), so the two must
  // be joined here, once both are known. `projectKey` comes from the SAME
  // `/load` response `trust` did (`studioProjectTrust.ts`), server-computed
  // (`registeredMcpServerProjectKey`'s sanitization can't be safely
  // reproduced client-side — see that field's own doc).
  const liveOrigin = bareLiveOrigin && projectKey ? `${bareLiveOrigin}/p/${projectKey}` : null

  // Only once the dev server is READY. The live-origin proxy answers 503
  // for every other phase, and an iframe that loaded that 503 stays on it:
  // nothing here re-points it when the phase moves, because `liveFrame`'s
  // identity (below) must not change on every poll. So a frame handed a
  // `liveFrame` while the server was still `booting` — which is every frame
  // on a board that just opened, since `useDevServerPrewarm` starts the boot
  // as the canvas mounts — sat on an error document for good, and the
  // fallback never handed off. The boot itself is still concurrent with the
  // fallback (prewarm owns it, not this frame); this only delays the one
  // network attempt until it can succeed.
  const attemptLive = liveOrigin !== null && readiness.phase === 'ready'

  // React Compiler exception #1 (CLAUDE.md) — this value feeds
  // `IframeFrameSurface`'s bridge-adapter-construction effect, which keys on
  // the WHOLE `liveFrame` object reference. An unstable reference here would
  // tear down and reconstruct the `BridgeFrameAdapter` — and this
  // component's own `adapter` state via `onAdapterChange` — on every render,
  // which becomes an infinite render loop (`setAdapter` itself triggers the
  // next render), not just a wasted allocation. `bun test` runs without the
  // compiler, so this can't be left for it to stabilize.
  const liveFrame = useMemo<LiveFrameSource | undefined>(() => {
    if (!attemptLive || !liveOrigin) return undefined
    return {
      liveOrigin,
      screenKey: page.id,
      // `liveNodeResolve.ts`'s own documented invariant: a `NodeTree`'s
      // `nodes` map's key order IS document/tree order (the parser's own
      // insertion order, preserved for a string-keyed object) — no separate
      // tree walk needed to reproduce it.
      nodeIdsInTreeOrder: Object.keys(page.nodes),
      axes,
    }
  }, [attemptLive, liveOrigin, page, axes])

  const posterUrl = getFramePoster(page, width)

  return (
    <>
      {!ready && (
        posterUrl ? (
          <FramePosterPlaceholder title={page.title} posterUrl={posterUrl} />
        ) : (
          <BreakpointFrame
            page={page}
            breakpoint={breakpoint}
            isActive={isActive}
            onActivate={onActivate}
            frameId={frameId}
            axesOverride={axesOverride}
            showBreakpointChrome={false}
          />
        )
      )}
      <div hidden={!ready} data-testid="live-board-frame-bridge">
        <BreakpointFrame
          page={page}
          breakpoint={breakpoint}
          isActive={isActive}
          onActivate={onActivate}
          frameId={frameId}
          axesOverride={axesOverride}
          showBreakpointChrome={false}
          documentMode="bridge"
          liveFrame={liveFrame}
          onAdapterChange={setAdapter}
        />
      </div>
    </>
  )
}
