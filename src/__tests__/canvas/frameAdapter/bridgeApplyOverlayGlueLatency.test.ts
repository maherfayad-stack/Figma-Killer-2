/**
 * L8 Phase B (`perf-06`, STATE.md) — the `applyOverlay` visible ≤ 16ms
 * budget's GLUE-LATENCY half: how long `BridgeFrameAdapter.applyOverlay()`
 * takes to hand its message off to the channel, measured against the SAME
 * stubbed `{ postMessage, addEventListener, removeEventListener }` triple
 * `BridgeFrameAdapter.test.ts` already drives (see that file's own doc for
 * why a stub, not a real cross-window `MessageEvent` — happy-dom cannot
 * carry a real `source`).
 *
 * This is deliberately a `bun test` perf assertion, not a `bun run bench`
 * browser row — per `perf-06`'s own STATE.md Budgets table: "a micro-bench
 * timing `applyOverlay()` call → stub-received round trip proves the JS
 * glue is fast, with ZERO dependency on L6/Phase A" (unlike the OTHER two
 * new Phase B budgets — warm-reopen and memory-per-frame — which genuinely
 * need a bootable Tier-2 project and stay explicitly blocked/TODO in
 * `scripts/bench/studioBoard.bench.ts`).
 *
 * What this measures, and what it does NOT: `BridgeFrameAdapter.post()` is
 * fully synchronous today (`toInboundEnvelope` + `channel.postMessage`, no
 * `await`/`setTimeout`/`queueMicrotask` in between) — so this is really "did
 * the adapter's own call path stay synchronous and cheap", not a real
 * cross-origin network/paint latency (that half needs a real live iframe —
 * `studioBoard.bench.ts`'s own header doc makes the same "synthetic proxy vs.
 * real measurement" distinction for its four existing rows). A REGRESSION
 * here (someone adding an `await`, a big `JSON.stringify`, or a synchronous
 * DOM measurement into the call path) is exactly what this budget exists to
 * catch — the number itself is expected to sit far under budget today.
 */
import { describe, it, expect } from 'bun:test'
import { toOutboundEnvelope } from '@core/studio-runtime'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'

const FRAME_ORIGIN = 'https://live.studio.test'

/** Same shape as `BridgeFrameAdapter.test.ts`'s own `makeStubChannel` — kept local (not imported) so this perf gate has no dependency on that file's fixtures changing shape underneath it. */
function makeStubChannel(): { channel: BridgeFrameChannel; posted: unknown[] } {
  const posted: unknown[] = []
  const channel: BridgeFrameChannel = {
    postMessage: (message) => { posted.push(message) },
    // A booted runtime reports `ready` first; the adapter queues every post until it does.
    addEventListener: (type, h) => {
      if (type === 'message') h({ origin: FRAME_ORIGIN, source: undefined, data: toOutboundEnvelope({ type: 'ready' }) } as MessageEvent)
    },
    removeEventListener: () => {},
  }
  return { channel, posted }
}

describe('BridgeFrameAdapter.applyOverlay — glue-latency budget (L8 Phase B, perf-06)', () => {
  it('hands an overlay off to the channel in well under 16ms per call', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({
      channel: stub.channel,
      frameOrigin: FRAME_ORIGIN,
      nodeIdsInTreeOrder: ['n1'],
    })

    const ITERATIONS = 500
    let worstMs = 0
    let totalMs = 0
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now()
      adapter.applyOverlay('n1', `outline: 2px solid #${i.toString(16).padStart(6, '0')};`)
      const elapsedMs = performance.now() - t0
      worstMs = Math.max(worstMs, elapsedMs)
      totalMs += elapsedMs
    }
    adapter.dispose()

    // Every call actually reached the channel — a passing budget on a
    // no-op stub would be meaningless.
    expect(stub.posted).toHaveLength(ITERATIONS)

    const meanMs = totalMs / ITERATIONS
    // Benchmark output, not app logging — see `layersTreePerf.test.tsx` for
    // the established "print the real number, gate the budget" pattern this
    // follows.
    console.warn(
      `[bridge-apply-overlay-glue] iterations=${ITERATIONS} worstMs=${worstMs.toFixed(3)} meanMs=${meanMs.toFixed(3)}`,
    )

    const BUDGET_MS = 16
    expect(worstMs).toBeLessThanOrEqual(BUDGET_MS)
  })
})
