/**
 * useAdapterReady — L8 Phase A (`perf-06`, STATE.md). Flips to `true` the
 * instant `adapter` fires `ready` (`live-05`'s own signal, already built and
 * tested on both `PortalFrameAdapter` and `BridgeFrameAdapter`), and reports
 * `false` again the moment `adapter` itself changes identity — a fresh
 * bridge iframe boot needs its own ready wait.
 *
 * Own file (not inlined into `LiveBoardFrame.tsx`, which also exports a
 * component) so a stub `FrameDocumentAdapter` can exercise this exact state
 * machine in isolation, without needing a real cross-origin `postMessage`
 * round trip (happy-dom's `MessageEvent` constructor can't carry a real
 * cross-window `source` — the same documented landmine
 * `BridgeFrameAdapter.test.ts` cites for testing against a stubbed channel
 * instead of a real one).
 *
 * Tracks the LAST adapter that actually fired `ready`, rather than a plain
 * boolean reset via an unconditional `setState` in the effect body — the
 * returned value falls back to `false` on its own the moment `adapter`
 * changes, with no separate reset call needed (`react-hooks/set-state-in-effect`
 * flags an unconditional `setState` at the top of an effect body; the only
 * `setState` here happens inside the subscription callback, which is exactly
 * what that rule wants).
 */
import { useEffect, useState } from 'react'
import type { FrameDocumentAdapter } from '../frameAdapter/FrameDocumentAdapter'

export function useAdapterReady(adapter: FrameDocumentAdapter | null): boolean {
  const [readyAdapter, setReadyAdapter] = useState<FrameDocumentAdapter | null>(null)
  useEffect(() => {
    if (!adapter) return
    return adapter.on('ready', () => setReadyAdapter(adapter))
  }, [adapter])
  return adapter !== null && readyAdapter === adapter
}
