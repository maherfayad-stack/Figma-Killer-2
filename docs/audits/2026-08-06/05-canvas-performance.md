# Canvas performance audit — perf-hunter

Read-only audit. No production code changed. Scope: `src/admin/pages/site/canvas/**`,
`src/admin/pages/site/store/slices/{canvasSlice,selectionSlice,boardSlice}.ts`,
`scripts/bench/**`.

## Verification of prior claims (do not re-diagnose, but confirm state)

- **`standing-03`'s two O(pages×nodes) selectors are genuinely fixed** (`store-01`,
  landed). Verified by reading the current code, not trusting the handoff text:
  - `PropertiesPanelBody.tsx:100` — `sharedTextOriginCount` now reads
    `s._textOriginKeyToCount.get(textOriginKey(origin)) ?? 1`. O(1).
  - `InPlaceInspector/findNodeById.ts:29-49` — `findNodeById` now reads
    `state._nodeIdToPageIds.get(nodeId)` (O(1) map) then a small `pages.find`
    over "a handful-to-tens of pages" to resolve the winning page object — the
    comment is honest about that residual O(pages) step and it is not the
    O(pages×nodes) shape being guarded against.
  - Both indexes live in `src/admin/pages/site/store/slices/site/nodeIndex.ts`,
    built once and maintained incrementally via `DirtyMarks`. Confirmed real,
    not aspirational.
- **`standing-03`'s selection-chrome-in-parent-document defect is fixed**
  (`canvas-05`, WS-5.1, landed). Rings/badge now render inside the iframe via
  `CanvasSelectionOverlayInjector` + `BreakpointSelectionOverlay.tsx`'s
  `measureIframeLocalRect` path (no zoom/pan conversion for the ring itself).
  The toolbar/`InPlaceInspector` still anchor via the old zoom-converting
  measurement, but only on dirty ticks (mount, selection change, pan/zoom
  *commit*, or the inspected node's own local rect changing) — not every RAF
  tick. This is real and matches the STATE.md description.
- **`perf-01`'s pan/zoom-is-60fps result is real and I did not re-measure it**
  (no browser tests run, per task constraints). `useCanvas.ts` still writes
  `transform` to a ref'd element via `applyTransformToDOM`/`scheduleTransformWrite`
  and only commits to the store on a 100ms debounce
  (`scheduleStoreCommit`) — the mechanism perf-01 verified with a
  `MutationObserver` is unchanged. The ~300ms mount-stall on a
  boundary-crossing zoom (6→15 live iframes) is still present and still
  unfixed; perf-01's own two attempted fixes (`useDeferredValue`, staggered
  mounts) are documented as negative results — **not re-attempted here**, see
  Landmines.
- **WS-5.6's bench harness still cannot run under Bun on Windows** — confirmed
  by reading `scripts/bench/lib/browser.ts`'s own KNOWN LIMITATION block
  (Chromium launch hangs without stdio fds 3/4). Not re-attempted; real browser
  numbers live in `tests/e2e/studio-board-perf.e2e.ts` per perf-01's note.

## New findings (not previously diagnosed or fixed)

### P1 — `selectCanvasPageFor`'s per-node page/frame lookup is an UNCACHED O(pages+frames) scan, run twice per node, on every store commit, in board mode

- **Severity:** High. This is the same defect class the brief's trap #11 and
  WS-5.2 name ("never scan every node/page inside a `useEditorStore`
  selector") — but it was never caught because it doesn't scan pages *inside*
  a per-panel selector; it scans pages/frames *inside a per-NODE selector*,
  which every live `NodeRenderer` on a Studio board mounts. It is the fan-out
  version of the bug WS-5.2 fixed the fan-in version of.
- **Evidence:**
  - `src/admin/pages/site/store/store.ts:300-310`:
    ```ts
    export const selectCanvasPageFor = (s: EditorStore, pageId: string | null, frameId?: string | null): Page | null => {
      if (!pageId) return selectActiveCanvasPage(s)
      if (frameId) {
        const locale = selectActiveBoard(s)?.frames.find((f) => f.id === frameId)?.axes?.locale
        if (locale && locale !== s.previewAxes.locale) {
          const localized = s.localizedPages[localizedPageKey(pageId, locale)]
          if (localized) return localized
        }
      }
      return s.site?.pages.find((p) => p.id === pageId) ?? null
    }
    ```
    No cache. Compare `selectActivePage` seven lines above it
    (`store.ts:180-196`), which deliberately keys a single-slot memo on
    `(site, activePageId)` identity specifically so "the first selector after
    a set pays the O(pages) scan once; every other subscriber in the same
    sweep hits the cache" (its own comment). `selectCanvasPageFor`'s `pageId`
    branch — the one every Studio *board* frame actually uses — never got the
    same treatment.
  - `src/admin/pages/site/canvas/NodeRenderer.tsx:70` and `:135-139`: TWO
    separate per-node selectors call `selectCanvasPageFor(s, contextPageId, frameId)`
    independently — once for `node`, once inside the `mcClassName` selector —
    so it's actually two full lookups per node, not one:
    ```ts
    const node = useEditorStore((s) => selectCanvasPageFor(s, contextPageId, frameId)?.nodes[nodeId] ?? null)
    ...
    const mcClassName = useEditorStore((s) => {
      const canvasNode = selectCanvasPageFor(s, contextPageId, frameId)?.nodes[nodeId]
      ...
    })
    ```
  - `src/admin/pages/site/canvas/BoardFramesLayer/BoardFramesLayer.tsx:651-658`:
    every board frame sets `CanvasPageContext.Provider value={page.id}` —
    i.e. **`pageId` is always non-null and `frameId` is always non-null in
    board mode**, so every NodeRenderer on a board hits both the
    `selectActiveBoard(s)?.frames.find(...)` (O(frames)) AND (unless a
    locale override matched) the `s.site.pages.find(...)` (O(pages)) branch,
    twice per node.
  - `src/admin/pages/site/canvas/BreakpointSelectionOverlay.tsx:62` also calls
    `selectCanvasPageFor` — a third call site, once per frame per dirty tick
    (lower frequency, same uncached cost).
- **Root cause:** Zustand re-runs every mounted selector's callback on every
  `set()`. `selectActivePage` solved this for the single-document (CMS/VC)
  path with a sweep-scoped single-slot memo; when board mode's per-frame
  `pageId`/`frameId` resolution (`selectCanvasPageFor`) was added
  (`68748f7`, "resolve node content per-frame via CanvasPageContext") and
  later extended for locale variants (WS-10 §4.4), neither change carried
  the memoization forward — it re-derives `selectActivePage`'s exact problem
  in the exact place that has the MOST subscribers (per-node, not per-panel).
- **Quantifying:** perf-01's own corpus (15 pages / ~803 nodes / 6 live
  iframes) puts roughly 300-400 live `NodeRenderer` instances on screen at
  once. Each does 2 calls × (≤15-frame scan + ≤15-page scan) ≈ 30-60
  comparisons — cheap on THIS corpus. It does not stay cheap: the docs'
  standard 40-page/1000-node board, even virtualized to ~10 live frames ×
  ~80 nodes/frame (≈800 live nodes), yields 800 × 2 × (frames+pages) ≈
  **64,000+ comparisons per store commit** — the same order of magnitude as
  the 40,000-iteration number WS-5.2 was written to kill, on the exact same
  class of board this codebase treats as its stress case. Every keystroke in
  a text field, every drag-scrub of a style value, every node move fires a
  store commit and re-pays this cost across every live node on the board.
- **Proposed fix:** Give `selectCanvasPageFor` the same sweep-scoped memo
  `selectActivePage` already has, generalized to a `Map`:
  a module-level `{ site: object; pagesById: Map<string, Page> }` cache in
  `store.ts`, rebuilt (one O(pages) pass) only when `site` reference changes,
  then O(1) `.get(pageId)` for the rest of that sweep and every sweep after
  until the next site mutation. Do the same for the `frameId → locale` lookup
  (a `Map<string, string | undefined>` keyed the same way, or fold it into
  `boardSlice`'s own board-identity memo). Land in `store.ts` next to
  `selectActivePage`/`_activePageCache`, same file, same pattern — no new
  module needed. Optionally also collapse `NodeRenderer`'s two independent
  calls (`node`, `mcClassName`) into one `useEditorStore` selector returning
  both, since they resolve the same page — but the Map-cache fix alone
  removes the O(pages) cost regardless.
- **Expected win:** O(pages) scan work per store commit drops from
  "2 × live-node-count" instances to 1 (the sweep's first miss). On the
  40-page/800-live-node projection above: ~64,000 comparisons → ~1 rebuild
  pass (≤40 pages) + ~1,600 O(1) map lookups. This is the largest single
  scan-shaped win available in the codebase right now (bigger fan-out than
  the two already-fixed selectors, because it runs per node, not per panel).
- **Effort:** S. Self-contained in `store.ts`; no cross-slice wiring, no new
  invalidation logic beyond "rebuild when `site` reference changes" (already
  the exact invalidation `_activePageCache` uses).
- **Benchmark/budget:** add a case to WS-5.6's `studioBoard.bench.ts` (or the
  Playwright `studio-board-perf.e2e.ts`, since the Bun bench harness can't
  launch a browser) measuring **store-change → panel/node re-render** on a
  40-page synthetic board with board mode active — the existing
  "Store-change → panel re-render < 8ms" budget in the plan is the right
  gate, but today nothing exercises board mode's per-node cost specifically
  (the existing e2e corpus is 15 pages). Add a call-count assertion (spy on
  `Array.prototype.find` scoped to `site.pages`/`board.frames`, or instrument
  `selectCanvasPageFor` in a test build) asserting O(1) amortized calls per
  commit, not O(live nodes).

### P2 — `UserStylesheetInjector` subscribes to the WHOLE `site` object, re-running CSS generation (concat + viewport-unit regex + dark-scheme scanner) on every store commit, once per mounted iframe

- **Severity:** Medium-High. Scales with (live iframe count × edit
  frequency), and iframe count is exactly what WS-5.3 virtualization was
  built to keep non-trivial (6-15+ on the measured board).
- **Evidence:** `src/admin/pages/site/canvas/UserStylesheetInjector.tsx:59-72`:
  ```ts
  const site = useEditorStore((s) => s.site)
  const activePageId = useEditorStore((s) => s.activePageId)
  const activePage = site ? site.pages.find((page) => page.id === activePageId) ?? site.pages[0] : undefined
  const collected = site && activePage ? collectUserStylesheetCss(site, activePage) : ''
  const viewportResolved = viewport ? resolveViewportUnitsForCanvas(collected, viewport) : collected
  const css = rewritePrefersColorScheme(viewportResolved)
  ```
  This is render-body code, not inside `useEffect` — it runs on every render
  of the component. Compare `ClassStyleInjector.tsx:122-131`, which subscribes
  to seven NARROW slices (`s.site?.styleRules`, `s.site?.breakpoints`,
  `s.site?.conditions`, three separate `s.site?.settings.framework.*` reads,
  `s.site?.settings.fonts`) instead of the whole `site` object, and does its
  expensive generation **inside** a `useEffect` gated on those slices — so it
  only recomputes when a relevant field's reference actually changes (Mutative
  structural sharing keeps `site.styleRules` referentially stable when an
  edit touches an unrelated node). `UserStylesheetInjector` does neither: it
  reads the whole `site` (which gets a new reference on literally every
  site-touching mutation, since `site` sits on the path from root to any
  edited leaf — confirmed by reading `selectActivePage`'s own comment on this
  exact behavior at `store.ts:176-179`) and does the expensive work at render
  time, not effect time.
  Mounted once per `IframeFrameSurface` — `IframeFrameSurface.tsx:687-688` —
  i.e. once per live board frame (6-15+ per the measured board).
- **Root cause:** over-broad selector (`s.site` instead of `s.site?.files` +
  `s.site?.runtime`, the only two fields `collectUserStylesheetCss` actually
  reads — see `src/core/publisher/userStylesheets.ts:34-62`) combined with
  doing the CSS-generation work in the render body instead of a
  dependency-gated `useEffect`. `rewritePrefersColorScheme` has a cheap
  short-circuit (`darkSchemeCssTransform.ts:244`, a single regex test before
  the brace-aware scanner runs), so the scanner itself is not the hot part
  for most projects — but `collectUserStylesheetCss` (filter+sort+concat over
  `site.files`) and `resolveViewportUnitsForCanvas` (a global regex `.replace`
  over the full concatenated CSS string) both run unconditionally, per
  iframe, per keystroke.
- **Proposed fix:** Narrow the selectors to `s.site?.files` and
  `s.site?.runtime` (the two actual dependencies), and move the
  `collectUserStylesheetCss` → `resolveViewportUnitsForCanvas` →
  `rewritePrefersColorScheme` pipeline inside the existing `useEffect` (already
  present for the DOM write at `UserStylesheetInjector.tsx:74-92`), gated on
  those narrowed values as deps — mirroring `ClassStyleInjector`'s pattern
  exactly. File: `src/admin/pages/site/canvas/UserStylesheetInjector.tsx`.
- **Expected win:** Re-render frequency for this component drops from "every
  site-touching store commit" to "only when `site.files`/`site.runtime`
  actually change reference" (adding/editing/toggling a stylesheet) —
  eliminating the CSS regeneration cost on the vastly more common case of
  editing node props/text/position, multiplied by however many iframes are
  live.
- **Effort:** S. One file, mirrors an existing sibling pattern in the same
  directory.
- **Benchmark/budget:** extend the planned "store-change → panel re-render
  < 8ms" bench with a render-count assertion (React DevTools profiler API or
  a render-count ref) on `UserStylesheetInjector` across N mounted iframes,
  asserting zero re-renders on an unrelated node-prop edit.

### P3 — `BoardFramesLayer` subscribes to `s.site?.pages` (whole array) and re-runs an O(frames×pages) join on every store commit

- **Severity:** Low-Medium (smaller fan-out than P1/P2 — runs once per
  commit, not once per node/iframe — but compounds with P1 since both are
  paid on every keystroke in board mode).
- **Evidence:** `src/admin/pages/site/canvas/BoardFramesLayer/BoardFramesLayer.tsx:172-173`:
  ```ts
  const board = useEditorStore(selectActiveBoard)
  const pages = useEditorStore((s) => s.site?.pages ?? EMPTY_PAGES)
  ```
  then unconditionally at render time, `:220`:
  ```ts
  const framesWithPages = resolveFramesWithPages(board, pages)
  ```
  which is `src/admin/pages/site/canvas/BoardFramesLayer/resolveFramesWithPages.ts:16-18`:
  ```ts
  return board.frames
    .map((frame) => ({ frame, page: pages.find((p) => p.id === frame.pageId) }))
    .filter(...)
  ```
  an O(frames × pages) nested scan. `s.site?.pages` is the array on the
  direct mutation path (same reasoning as P2: any node edit anywhere gives
  it a new reference), so this component — and its O(frames×pages) join —
  re-runs on every keystroke regardless of which page is being edited.
- **Root cause:** same class as P2 — selecting a container one level too
  high (`site.pages` instead of something narrower, or memoizing the join
  against page-membership identity rather than re-deriving it every render).
- **Proposed fix:** Build a `Map<pageId, Page>` once per `pages` array
  identity (same sweep-scoped memo shape as the P1 fix — could literally
  share the cache this audit proposes for `store.ts`) and change
  `resolveFramesWithPages` to do `board.frames.map(f => ({frame: f, page:
  pagesById.get(f.pageId)}))` — O(frames) instead of O(frames×pages).
  File: `src/admin/pages/site/canvas/BoardFramesLayer/resolveFramesWithPages.ts`
  (+ a shared page-index helper, ideally the SAME one P1 introduces in
  `store.ts`, so this isn't a second parallel cache).
- **Expected win:** Removes an O(frames×pages) scan (up to ~1,600 comparisons
  on a 40-page/40-frame board) per keystroke. Smaller in isolation than P1,
  but free to fix alongside it if the same page-index cache is reused.
- **Effort:** S, and cheapest if bundled with P1 (shared cache).
- **Benchmark/budget:** same "store-change → panel re-render" bench as P1;
  no new gate needed if P1's is written generically enough to also assert on
  `BoardFramesLayer`'s render/scan count.

## Verified clean (checked, not a finding — saves the next agent the re-check)

- **`ClassStyleInjector.tsx`** — narrow per-slice selectors, expensive
  generation gated inside `useEffect` on those slices. Mutative structural
  sharing means an edit to an unrelated node does NOT change
  `site.styleRules`/`site.breakpoints`/etc. reference, so this component
  correctly skips regeneration on most edits. This is the pattern P2 should
  be brought up to.
- **`NodeRenderer.tsx`'s form-preview selectors**
  (`resolveEditorFormPreviewState`/`resolveEditorFormPreviewSuccessMessage`,
  `src/admin/pages/site/canvas/canvasFormPreview.ts:75-86`) already use a
  `WeakMap`-cached parent-id index keyed on `page.nodes` identity — exactly
  the fix shape WS-5.2 used elsewhere. No O(page) walk per node per commit.
- **`EditorChromeInjector.tsx` / `CanvasAnimationInjector.tsx`** — neither
  subscribes to the store at all; both run purely off mount/DOM effects. Zero
  per-store-commit cost regardless of mounted iframe count.
- **`useCanvas.ts`** — re-read against perf-01's claims: ref-based transform,
  rAF-coalesced DOM write, 100ms-debounced store commit, and a `will-change`
  promotion that is released 200ms after the last write (not left permanently
  promoted, which would risk the oversized-composited-layer blank-paint
  failure mode the code comments call out). Matches the browser-measured
  mechanism perf-01 describes; nothing to add.
- **`frameVirtualization.ts` / `frameSnapshotCache.ts` / `useFramePosterCapture.ts`**
  — pure geometry (`isFrameOnScreen`), a `WeakMap<Page, PosterEntry>` cache
  that self-invalidates on Mutative's structural-sharing guarantee (no manual
  revision counter, no leak — stale entries become unreachable once the old
  `Page` object is GC'd), and a plain `setTimeout` settle delay (explicitly
  NOT an rAF/idle staging chain, referencing the exact landmine `CLAUDE.md`
  and this task's own instructions warn about). No finding.
- **Iframe teardown** — `IframeFrameSurface.tsx`'s `attachIframeDoc` stores a
  `_studioCleanup` closure per iframe and calls it before rebinding; every
  `useEffect` in the file (wheel forwarding, pointer/keyboard forwarding,
  navigation guard, readonly-open) returns a matching listener-removal
  cleanup. No accumulating listeners found by inspection.

## Still-open, already-diagnosed items (not re-diagnosed here, listed only for the ranking below)

- **perf-01's ~300ms mount stall on a boundary-crossing zoom** (6→15 live
  iframes). Root cause identified (a single board-frame mount costs
  ~100-140ms — iframe boot + `srcDoc` + injector chain + node tree — so
  scheduling changes can't fix it, only a cheaper mount can) but not
  attempted. `useDeferredValue` and mount-staggering were both tried and
  reverted (see Landmines).
- **WS-5.6's `scripts/bench/studioBoard.bench.ts` cannot execute on Bun on
  Windows** (Chromium launch hangs without stdio fds 3/4). Real numbers must
  go through `tests/e2e/*.e2e.ts` (Playwright's own Node-based test runner)
  until this is fixed at the tooling level, which is out of this audit's
  scope (it's a Bun/Windows/Playwright interaction, not a canvas defect).

## Landmines (do not repeat these experiments)

- **`useDeferredValue` on virtualization inputs does nothing** for the
  zoom-mount-stall — React's transition priority only affects when a render
  *starts*, not the commit, and the commit is where iframe mounting happens
  (perf-01, measured: 290ms with vs 296ms without).
- **Staggering iframe mounts (≤3 per rAF) makes the mount stall WORSE**, not
  better (perf-01, measured: 423ms worst vs 290ms unstaggered, mutations
  163→283). A single mount is already ~100-140ms; spreading that cost over
  more commits lengthens the jank instead of shrinking it.
- **Do not reintroduce a rAF → setTimeout → requestIdleCallback staging
  chain** anywhere in the canvas — this repo removed one before because it
  optimized a cost that was cheap anyway and could strand frames as
  skeletons forever in a backgrounded tab or headless runner (this task's own
  brief; confirmed still true of everything read in this audit —
  `useFramePosterCapture.ts` explicitly calls this landmine out by name in
  its own doc comment when explaining why it uses a plain `setTimeout`).
- **`scripts/bench/` cannot launch a browser under Bun on Windows** — don't
  spend time trying to fix the bench harness itself as part of a canvas perf
  task; it's a documented, separate, tooling-level limitation
  (`scripts/bench/lib/browser.ts`'s KNOWN LIMITATION block). Use
  `tests/e2e/*.e2e.ts` for any real frame-time measurement instead.

---

## TOP 8 PERF WINS, RANKED BY (impact / effort)

1. **P1 — cache `selectCanvasPageFor`'s page/frame lookup** (S effort, High
   impact). Largest fan-out scan in the codebase today — hits every live
   NodeRenderer, twice, on every store commit, in Studio's primary editing
   mode (board mode). Same fix shape as `selectActivePage`'s existing memo;
   near-zero risk.
2. **P3 — index `resolveFramesWithPages`'s join** (S effort, Low-Medium
   impact, but free if bundled with #1's shared page-index cache). Do
   together with P1 for near-zero marginal cost.
3. **P2 — narrow `UserStylesheetInjector`'s selector + move generation into
   its gated `useEffect`** (S effort, Medium-High impact, scales with live
   iframe count). One file, mirrors `ClassStyleInjector`'s already-correct
   pattern next door.
4. **Make one board-frame mount cheaper** (perf-01's named, unfixed
   ~100-140ms-per-mount cost — the real fix for the 300ms zoom stall).
   Effort L — needs profiling WHICH part of iframe boot + injector chain +
   `NodeRenderer` tree mount dominates before touching anything; two cheaper
   scheduling-only attempts already failed. Highest remaining IMPACT on
   perceived "glitching" during zoom, but not cheap — do after 1-3 land and
   are measured, in case they move the number enough to change priority.
5. **Add the WS-5.6 board-mode-specific bench case** (a 40-page synthetic
   board, board mode active, asserting O(1) amortized scan cost per commit)
   so P1/P2/P3 have a gate that can fail if regressed. Effort S, but
   dependent on #1-3 landing first (calibrate against the fixed numbers, not
   the current ones).
6. **Extend `tests/e2e/studio-board-perf.e2e.ts`'s corpus toward the docs'
   40-page/1000-node-per-page stress case** (today's e2e corpus is 15 pages
   / ~803 nodes). Needed to give #1/#3's projected numbers (64,000+
   comparisons) a real measurement instead of an estimate. Effort M
   (synthetic fixture generation), no code dependency on the others.
7. **Investigate whether `resolveViewportUnitsForCanvas`'s global regex pass
   can be skipped when a stylesheet has no viewport-unit-shaped substring**
   (mirroring `rewritePrefersColorScheme`'s existing cheap short-circuit at
   `darkSchemeCssTransform.ts:244`) — a small additional win on top of P2's
   fix, since even a correctly-gated `useEffect` still pays this regex once
   per real stylesheet edit rather than never. Effort S, low standalone
   impact, natural follow-on to #3.
8. **Profile whether `NodeRenderer`'s `node` and `mcClassName` selectors can
   be merged into one `useEditorStore` call** (both resolve the same page via
   `selectCanvasPageFor`) once P1's cache makes the lookup itself free —
   would remove one Zustand-subscription's worth of per-node overhead
   (separate from the O(pages) cost P1 already removes). Effort S, low
   standalone impact until measured — do last, after #1 changes what's
   actually left to optimize.
