# Live-frame memory baseline — L8 Phase B (`perf-06`)

**Status: BLOCKED, placeholder only. No number in this document has been
measured.** This file exists so the blocker and the exact steps to clear it
are written down once, rather than re-derived by whoever picks this up next.

## Why this is blocked

`STUDIO-LIVE-CANVAS-PLAN.md` §L8's "memory per live frame — baseline +
regression gate" budget needs a REAL, booted Tier-2 board: `N` live bridge
iframes hot at once, each a real cross-origin connection to a real spawned
Vite dev server. Measuring memory against anything less (a portal iframe, a
poster placeholder, a stubbed adapter) would not be measuring the thing the
budget is about.

That requires `perf-06`'s own Phase A "human dogfood" gate, which has **not**
happened yet as of this writing (STATE.md, `perf-06` entry, STEPS item 4):
*"promote `test4 copy` to Tier 2 for real, confirm a frame boots, shows the
Tier-0 fallback, then swaps to the live iframe on `ready` — before Phase B
starts."* This is explicitly a human action, not something an agent session
can satisfy by running its own automated Playwright pass and calling it
equivalent — `live-08`'s own PR #106 proved the `ready` handshake fires
end-to-end (a real dev server, a real cross-origin `postMessage`, a real
browser), but stopped short of a full board *reopen* with live frames
actually painting, and STATE.md is explicit that the wider "drag a node on a
live board with no flash" exit criterion still needs a human to drive it.

## What a future session needs to do to fill this in

1. Confirm the Phase A human dogfood gate has actually happened — check
   STATE.md's `perf-06` entry for a note recording it, not just another
   automated Playwright proof.
2. Use `scripts/bench/lib/liveFrameFixture.ts` (`createLiveFrameFixture()`) —
   already built, copies `studio-workspace/test4 copy` into an ephemeral
   `studio-workspace/__bench-live-synth/` and sets its trust tier to
   `'run-project'`. Call `.cleanup()` in a `finally`.
3. Open the fixture's board in a real Chromium session (same
   `lib/browser.ts` harness `studioBoard.bench.ts` already uses), pan enough
   frames on screen to reach `LIVE_FRAME_POOL_SIZE` (8) live bridge iframes
   hot at once, and let them settle to `ready`.
4. Measure with `page.context().newCDPSession(page)` →
   `Performance.getMetrics` → `JSHeapUsedSize`, once at `poolSize` live
   frames hot and once at `poolSize - 1` (evict one, confirm its bridge
   iframe actually tears down via `document.querySelectorAll('iframe')`
   count dropping) — the delta approximates per-frame cost. This is a
   **page-level heap** measurement, not truly per-iframe-isolated (a
   cross-origin iframe's own process/heap isn't directly attributable this
   way in every Chromium build) — say so explicitly in whatever this section
   becomes once it has a real number.
5. **Before trusting any absolute number as a CI gate**, re-run on a quiet,
   dedicated machine — NOT this shared sandbox. `panel-23`'s own Phase B
   numbers (STATE.md) showed up to 2x run-to-run variance on this same
   sandbox (software-rendered, frequently relaunched Chromium, parallel
   agent-session CPU contention), which is not a noise floor safe to gate CI
   on directly. Record the measuring machine's specs (CPU, whether
   virtualized, GPU acceleration on/off) alongside the number.
6. Add the resulting real numbers as a new dated section below this one (do
   not overwrite this placeholder section — it documents why the FIRST
   attempt at this budget was deferred, which is useful history even once a
   real baseline exists).

## What is NOT blocked, and already exists

- `scripts/bench/lib/liveFrameFixture.ts` — the fixture helper (Section 2
  above). Unit-verified by hand during this session: copies the source
  project without mutating it, sets `trust: 'run-project'` via the same
  `mergeStudioMeta` the real trust-tier route uses, and `cleanup()` leaves no
  trace in `git status`.
- `scripts/bench/studioBoard.bench.ts` carries two explicitly-skipped rows
  ("Warm reopen → first live paint" and "Memory per live frame") pointing
  back at this document — see that file for the exact wording shown in a
  real bench run's report.
- The `applyOverlay` visible ≤ 16ms budget's JS-glue half is NOT blocked on
  any of the above — it needs only a stubbed `postMessage` channel, and
  already has a real, passing measurement:
  `src/__tests__/canvas/frameAdapter/bridgeApplyOverlayGlueLatency.test.ts`.
