# Live-frame memory baseline — L8 Phase B (`perf-06`)
> **Trust:** the 2026-09-13 placeholder below is historical — paths may be wrong, never act on it. The **2026-09-26 section at the end is current**: the first measured baseline (P6-C).

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

## 2026-09-26 — the first measured baseline (P6-C)

> **Trust:** current as of 2026-09-26 (`perf/remaining-budgets`). Measured, not
> estimated. Re-run `tests/e2e/live-frame-budgets.e2e.ts` to reproduce.

The blocker above is gone for a reason it did not anticipate: the e2e suite can
now boot a real Tier-2 board by itself. `tests/e2e/helpers/liveAnimatedFixture.ts`
copies `vite` and `@vitejs/plugin-react` out of this checkout's own install
into the fixture's `node_modules` (copies, because `resolveProjectPackageBin`
refuses a bin that resolves outside the project), and everything they import
resolves upward into the checkout. So these are real cross-origin bridge
frames against a real spawned Vite, reporting `ready` — not the fallback.

**Method.** `live-frame-budgets.e2e.ts`, case "memory per live frame": a
ten-frame board (one animated screen, nine plain 25-row screens), zoomed out
until all ten are on screen and all ten report `ready`; then zoomed in on one
frame so the live pool (`framePool.ts`, `max(onScreen, 8)`) evicts two. Both
states are read after two forced GCs through the PAGE's CDP session
(`Performance.getMetrics`). The live origin is `localhost:<port>` and the
editor `127.0.0.1:<port>`, but Chromium puts them in one renderer process here
(Playwright reports the live frame as part of the page's session), so the
page's JS heap and DOM counters include the live documents. That makes this a
per-process number, not a per-iframe-isolated one — the caveat step 4 above
asked to state.

| | 10 live frames | 8 live frames | per evicted frame |
|---|---|---|---|
| JS heap used | 56.5 / 55.7 MB | 54.8 / 54.0 MB | **0.83 / 0.86 MB** |
| Documents | 12 | 10 | **1.00** |
| DOM nodes | 3,010 / 3,007 | 2,787 / 2,781 | **~112** |
| Detached documents (Documents − Frames) | — | 1 | — |

Two runs, both listed. A plain 25-row screen is small; the heap per frame is
the live document's own React app plus Studio's runtime, and it will grow
with the page. The one "detached" document is constant across every run and
every board size measured (also 1 on the 40-frame portal corpus after 20 pan
cycles and 50 edits, `canvas-edit-budgets.e2e.ts`), so it is not a leak.

**Machine.** Intel Core i5-14400F (16 logical cores), 32 GB, Windows 11 Pro,
headless Chromium from Playwright, GPU rasterization per Chromium's defaults —
under the usual load of several agents' test runs, taken under the shared
heavy-run lock. Treat the absolute numbers as this box's, the per-frame deltas
as the portable part.

**What it decided.** Eight live frames cost well under 10 MB of heap here, so
`LIVE_FRAME_POOL_SIZE` is not memory-bound at this page size. P6-C did NOT
raise it: the pool change that shipped instead is that a Tier-2 board whose
dev server is not ready uses the portal budget (its frames ARE portal
fallbacks until then), which is what lets those frames be rasterized into
posters. See `framePool.ts`.
