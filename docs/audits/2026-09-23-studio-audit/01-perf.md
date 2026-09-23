# Audit 01: canvas performance, lag and jank

Auditor: perf-hunter (read-only). Branch audited: `fix/studio-load-memo-cold-on-every-load` @ `560ddb0e`.
Scope: canvas, studio-board, editor store, overlays, pan/zoom, drag loops, iframe frames, injectors, live runtime, reparse/writeback, load path, benches.

## 0. What is already fixed. Do not re-plan these.

- `standing-03` defects: rings render inside the iframe (`BreakpointSelectionOverlay.tsx` module doc, WS-5.1). The full-site selector scans read O(1) indexes (`nodeIndex.ts`), gated by `no-full-site-scan-in-selectors.test.ts`.
- S4: the permanent per-frame overlay rAF loop is gone (`overlayMeasureScheduler.ts`).
- S1/perf-9: staged frame mount, one frame pool (`framePool.ts`), poster queue.
- S2: drag session with no per-move commits. Pan writes the transform through a ref (`useCanvas.ts`).
- Current branch (`08b93adf`): the `/load` memo no longer invalidates itself through `lastOpenedAt`. The workspace ts-morph project is reused. Re-sync went from 2.9–3.3 s to 0.27–0.5 s. perf-10 made insert/duplicate/wrap/group optimistic. parser-14 made the parse cache track deep imports.

## 1. Measurement I took (scratch bench, not committed)

`scratchpad/audit/sweep.bench.ts` loads the real editor store with a synthetic site. It subscribes the exact 11 `NodeRenderer` selectors (`NodeRenderer.tsx:116-196`) for every node of every mounted frame, then times one store `set()`. This is pure selector-sweep cost: no React, no DOM. Bun/JSC, this machine, median / p95:

| board (pages × nodes/page, mounted frames) | subscribers | hover edge | no-op hover set | selectNode | keystroke (updateNodeProps) | pan commit |
|---|---|---|---|---|---|---|
| 12 × 28, 12 (= the perf fixture) | 3,696 | 0.56 / 1.04 ms | 0.55 | 0.86 / 1.31 | 1.25 / 1.95 | 0.59 |
| 40 × 150, 8 | 13,200 | 2.02 / 4.12 ms | 1.95 | 3.78 / 6.28 | 4.41 / 6.98 | 2.68 |
| 40 × 300, 12 | 39,600 | **6.37 / 9.72 ms** | 7.43 | **11.95 / 17.97** | **12.65 / 18.27** | 7.93 |

Cost split at 40×300×12, with a no-op set:
- The two `useShallow` object selectors (inline-edit triple, preview pair): **3.36 ms (~45%)**.
- Node lookup plus the class-name string build: 1.02 ms.
- Form-preview pair: 0.67 ms.
- isSelected/isHovered: 0.11 ms.
- Action refs: 0.08 ms.

The cost is linear at about 0.18 µs per subscriber. **The committed perf fixture sits at 0.5 ms, so no existing gate can see this.**

## 2. Findings

Severity: P0 = visible lag in common use · P1 = lag in larger boards · P2 = minor.

### PERF-1 · P1 · CONFIRMED + measured — every store set runs N×M×11 per-node selectors, and hover goes through the global store
- **Evidence:**
  - `NodeRenderer.tsx:116-196`: 11 subscriptions per node.
  - `per-node-selector-budget.test.ts`: counts subscriptions, not their cost.
  - `useCanvasNodeInteraction.ts:206-220`: `hoverNode` on every `mouseenter`/`mouseleave`.
  - `NodeRenderer.tsx:536-537`: those handlers.
  - `selectionSlice.ts:250`: `hoverNode` has no same-value guard.
  - The module doc's claim "O(2) not O(N)" is true for re-renders, not for selector work.
- **Mechanism:** every hover crossing, selection, keystroke, scrub-preview tick and pan commit evaluates every selector of every mounted node. At 40×300 with 12 mounted frames that is 6–18 ms of pure JS before React starts, per event.
  - Hover crossings come in leave+enter pairs, so that is two sweeps.
  - `data-hovered` (`NodeRenderer.tsx:393`) has no CSS consumer (only `BodyEditor` mirrors it). The `isHovered` subscription therefore re-renders two module components per crossing to produce nothing visible.
- **Fix, in order:**
  1. Take hover out of the editor store. Use a canvas-local keyed notifier (`Map<nodeId, Set<listener>>`) that diffs old and new, and notify only the two affected ids. Penpot keeps hover in viewport-local state, never the global store (`penpot/frontend/src/app/main/ui/workspace/viewport.cljs:140-141`, `viewport/hooks.cljs:179-230`).
  2. Do the same keyed diff for `selectedNodeIds`.
  3. Replace the two `useShallow` object selectors with primitive selectors. `initialValue`/`multiline` are constant for the session, so read them via `getState()` when `isInlineEditing` flips.
  4. Delete the `isHovered` subscription and `data-hovered`, then lower the budget test.
  5. Guard `hoverNode` against same-value sets.
- **Effort:** M. **Owner:** store-engineer + canvas-engineer; perf-hunter adds the budget.
- **Plan:** WS-5.6 specs "store change → panel re-render < 8 ms" on a 20,000-node board. It was never built (see §3).

### PERF-2 · P0 · CONFIRMED mechanism, cost estimated — selection chrome mounts inside the observed `<body>`, so every hover or selection re-runs the frame's two full-document layout passes
- **Evidence:**
  - `CanvasSelectionOverlayInjector.tsx:142`: the overlay root is appended to `body`.
  - `CanvasSelectionChrome.tsx:111-119`: the hover ring is conditionally mounted. Rings and badges are keyed per selected id, so every hover start/end and every selection change produces a `childList` mutation under `body`.
  - Portal-mode observer 1: `useIframeFrameAutoHeight.ts:188` into `frameFitMutationScheduler.ts`. A `childList` record triggers an immediate `onSettle`: the body height is reset to the viewport height, then an rAF runs `collectScrollDeficits` (`frameFitRules.ts:153-166`: `querySelectorAll('*')` + `scrollHeight` + `getComputedStyle`, a forced layout).
  - Portal-mode observer 2: `scrollUnrollRules.ts:422-426` into `runUnrollPasses` (`:361-368`): `snapshotAuthoredStyles` + `clearUnrollTags` + `getComputedStyle` on every element.
  - Neither observer filters the overlay root. By contrast `overlayMeasureScheduler.ts:227-233` does, and the live runtime explicitly documents and filters exactly this (`runtime.ts:436-450`: "repositioning a ring on every select/hover would otherwise spuriously reset the fit pin").
- **Cost:** `canvas-internals.md` §S1 measured each pass at about 5 ms per frame on the 28-node fixture. Real pages are 10–20× larger.
  - Hover is continuous in normal use, so this is a per-crossing forced-layout stall.
  - Pages with internal scroll containers may also visibly flicker height across the refit rAF passes.
  - This violates "nothing moves that the user didn't move". The flicker is suspected, not observed.
- **Multiplier:** a Layers-panel hover or selection (`TreeNode.tsx:150,393`) carries no `frameId`, so rings mount in every mounted frame (8–12) and every one of them pays both passes.
- **Fix:**
  - Put one shared predicate, `isSelectionChromeMutation(record)`, beside `selectionChromeCss.ts` in `@core/studio-runtime`, and use it in all four observers.
  - Keep ring and badge elements mounted and toggle visibility through an attribute, so no `childList` happens at all.
- **Effort:** S. **Owner:** canvas-engineer. **Plan:** not covered.

### PERF-3 · P0 · CONFIRMED — the selection toolbar and InPlaceInspector freeze during pan/zoom, then jump
- **Evidence:**
  - `BreakpointSelectionOverlay.tsx:292`: the anchor is re-dirtied only by the debounced committed `[zoom, panX, panY]`.
  - `:515`: the pass returns when the anchor is not dirty.
  - `useCanvas.ts:259-260`: the store commit fires 100 ms after the last event.
  - `overlayMeasureScheduler.ts:172`: the viewport hold re-runs only the cheap in-iframe ring pass. That work is wasted: rings live inside the iframe and move with the transform for free.
  - The chrome is portaled into the untransformed canvas root, and nothing hides it during a gesture.
- **Mechanism:** the rings move with the canvas while the toolbar and the in-place inspector stay pinned to their old screen position for the whole gesture. They snap about 100 ms after it ends.
- **Fix (either option):**
  - Keep a board-space anchor, measured once, and during `canvasViewportActivity` position the chrome as `board × transformRef.zoom + pan`. This is arithmetic only, no layout reads.
  - Or host the chrome in a transform-following layer with the comment pins' `--canvas-zoom` counter-scale.
  - With either option, skip the ring re-measure during a pure viewport hold.
- **Effort:** S–M. **Owner:** canvas-engineer. **Plan:** WS-5.1 chose "once per pan/zoom commit", so this is the plan's own design. Not covered. No e2e checks chrome position mid-gesture.

### PERF-4 · P1 · CONFIRMED — two permanent rAF loops (rulers) force a layout read every frame, forever
- **Evidence:**
  - `CanvasRulers/useRulerCanvasPaint.ts:47-57`: a loop reading `offsetWidth`/`offsetHeight` every tick.
  - `CanvasRoot.tsx:592-594`: the rulers are always mounted in design mode.
  - The docblock (`:14-23`) says polling is required. That is stale since S4 added `canvasViewportActivity.ts`.
- **Mechanism:** an idle board never lets the main thread sleep, and forces layout early in every frame after any parent-document write. This is exactly the defect S4 removed from the overlay.
- **Fix:** subscribe to `onCanvasViewportActivityChange` (loop only while active). Add a `ResizeObserver` for length and one paint when the origin changes.
- **Effort:** S. **Owner:** canvas-engineer. **Plan:** not covered. S4 fixed only the overlay.

### PERF-5 · P1 · CONFIRMED — poster rasterization (85–350 ms main-thread) re-runs after every edit, and can land under a click
- **Evidence:**
  - `useFramePosterCapture.ts`: the effect depends on the `page` identity.
  - `frameSnapshotCache.ts:34`: the cache is a `WeakMap<Page>`, so every edit misses.
  - `framePosterQueue.ts:77-98`: the busy listeners are only on the parent `document`.
  - `useIframeEventForwarding.ts:340-364`: iframe `pointerdown` is forwarded only for pans.
  - Capture cost: `canvas-internals.md` §S1 table.
- **Mechanism:** edit a frame and pause for 700 ms. The queue then rasterizes the on-screen frame you just edited, using `html-to-image`, which walks the computed style of every element and re-embeds fonts on each call. A click or resize drag that starts inside a frame is invisible to the busy detector, so it can land during the capture.
- **Fix:**
  - Capture only when a poster can be needed: on the on-screen→offscreen transition while the frame is still pooled, or at eviction. Never capture a frame that is on screen and live.
  - Register the busy listeners on every frame document through the adapter registry.
  - Compute `fontEmbedCSS` once per stylesheet version.
- **Effort:** M. **Owner:** perf-hunter + canvas-engineer. **Plan:** WS-5.3 said "rasterize each frame once when it first settles". The implementation re-rasterizes after every edit.

### PERF-6 · P1 · CONFIRMED — a post-write re-sync replaces whole pages and the whole style registry
- **Evidence:**
  - `store/slices/site/lifecycleActions.ts:259-298` (`patchPages`): `nextPages.push(fresh)`, and `styleRules` is replaced wholesale.
  - `ClassStyleInjector.tsx`: its effect depends on `classes`.
  - `NodeRenderer.tsx:116`: the node selector.
- **Mechanism:** after every structural gesture or line-shifting save:
  - Every node object of the touched page is new, so every `NodeRenderer` of that frame re-renders.
  - Nodes below a shifted line get new `file:line:col` ids, so they remount (new keys).
  - Every mounted frame regenerates the class CSS and rewrites its `<style>` element, a full restyle ×M.
  - The page's poster is invalidated, which feeds PERF-5.
- **Fix:** reconcile in `patchPages`.
  - Reuse the previous node object when it is deep-equal.
  - Keep previous rule objects and the registry identity when their content is unchanged.
  - Longer term: the relocation map `store-14` already builds can re-key moved nodes so they reuse DOM instead of remounting.
- **Effort:** M. **Owner:** store-engineer. **Plan:** perf-10 hid the latency; the reconciliation cost is unaddressed.

### PERF-7 · P1 · CONFIRMED — cold load renders nothing until every page is parsed, and nothing persists across a server restart
- **Evidence:**
  - `server/handlers/studio.ts:397-412`: its own comment says the parse finishes before the stream starts.
  - `studioLoadResponse.ts:135-140`.
  - `fsCodemodAdapter.ts:221-229`: the client buffers the whole stream, then calls `loadSite`.
  - `pageParseCache.ts:56`: an in-memory `Map` only.
  - parser-14 measured `test4` cold at 3–5.6 s.
- **Mechanism:** WS-5.5's "first frames render while the rest parse" was never delivered, and neither was its "< 2 s first frame on a warm cache" budget. `performance.e2e.ts:17` allows 20 s.
- **Fix:**
  - Parse in viewport-priority order; the frame positions are in `boards.json`.
  - Stream each page as it is parsed, and apply it on the client via `patchPages`.
  - Persist the parse cache under `.studio/cache/` keyed by content hash, as the styles cache already is.
- **Effort:** L. **Owner:** server-engineer + parser-surgeon + store-engineer.

### PERF-8 · P1 on large repos · CONFIRMED mechanism, SUSPECTED impact — the `/load` warm path does synchronous O(files) disk I/O per gesture on the server event loop
- **Evidence:**
  - `studioLoadMemo.ts:142-153`: walk + `statSync` of every file on every request.
  - `componentSources.ts:152-164`: on a miss, `refreshFromFileSystemSync` reads every file's contents, then re-globs.
  - Single-slot project cache (`cachedProject`): two open projects thrash it.
  - The fingerprint is a 32-bit rolling hash. A collision is a stale load. That is a correctness landmine, not perf.
- **Fix:**
  - Invalidate from `fs.watch` (a dirty set) instead of walking and statting on every request.
  - Refresh only the files whose stamp changed; the fingerprint already computes those stamps.
  - Use a small LRU of projects.
- **Effort:** M. **Owner:** server-engineer. Only measured on 64 files (14 ms).

### PERF-9 · P1 for Tier-2 boards · CONFIRMED — the live runtime resets frame fit on every attribute mutation, with no debounce
- **Evidence:** `runtime.ts:428-455` and `:479-495`, which self-document this as a "KNOWN SIMPLIFICATION".
- **Mechanism:** a JS-animated app writes attributes every frame (framer-motion, carousels). Each write triggers a body height reset plus `collectScrollDeficits` (a full-document forced layout) per frame, and can make the height oscillate. Vite projects now auto-promote to Tier 2 by default (CLAUDE.md), so this is the default path for them.
- **Fix:** port `frameFitMutationScheduler`. Attribute-only records do not reset the fit; `childList` records do, debounced.
- **Effort:** S. **Owner:** canvas-engineer (runtime).

### PERF-10 · P2 · CONFIRMED — an idle MutationObserver per portal frame
- **Evidence:** `PortalFrameAdapter.ts:174-178` observes `attributes: true`, subtree. Portal mode never calls `select`/`hover` (`CanvasSelectionOverlayInjector.tsx:87`), so its rings are always empty.
- **Mechanism:** every attribute write in every frame allocates records and schedules an rAF that does nothing. Examples: ring style writes on every pass, and inline styles on every frame of an element resize.
- **Fix:** arm the observer lazily on the first `select`/`hover`. **Effort:** S. **Owner:** canvas-engineer.

### PERF-11 · P2 · CONFIRMED — store writes without equality guards on hot paths
- **Evidence:**
  - `boardAnnotationSliceActions.ts:130-133` (`setSelection`) writes a fresh array on every marquee `pointermove` (`useMarqueeSelection.ts:244`). The marquee handler is not rAF-coalesced either.
  - `selectionSlice.ts:250` (`hoverNode`) has no guard.
- **Cost:** a no-op set costs the full sweep: 7.4 ms at 40×300×12. **Fix:** equality guards. **Effort:** S. **Owner:** store-engineer.

### PERF-12 · P2 · CONFIRMED — whole-site subscriptions in always-mounted chrome re-render on every keystroke
- **Evidence:**
  - `AdminCanvasLayout.tsx:125`: the editor shell subscribes to `s.site` only for `!site` and `site?.id`.
  - `useAutoResolveDependencies.ts:45`: its effect re-runs on every edit.
  - `StudioPagesTree.tsx:62`, `DocumentSwitcher.tsx:40`, `TemplateModeControl.tsx:69`.
  - `CanvasComposedTree.tsx:72-73`: a `pages.filter` per store set, allocating.
- **Gap:** the gate only detects `for (const page of X.pages)` loops, not `.filter`/`.find`/`.map` on `pages`.
- **Fix:** narrow the selectors, and widen the gate's pattern. **Effort:** S. **Owner:** store-engineer.

### PERF-13 · P2 · CONFIRMED — a global (Layers-panel) selection arms chrome in every mounted frame
- **Evidence:**
  - `BreakpointSelectionOverlay.tsx:175-180`: `selectedNodeFrameId === null` means every frame.
  - `:284`: an InPlaceInspector wrapper in every frame.
  - `:569-576`: a scheduler per frame (ResizeObserver + MutationObserver + scroll listener).
  - `canvasNodeLookup.ts:153-160`: a miss is not cached, so every pass in a non-owning frame runs a `querySelector`, per rAF during a pan hold.
- **Fix:** scope the chrome through `_nodeIdToPageIds` to frames whose page contains the node. **Effort:** S–M. It multiplies PERF-2.

### PERF-14 · P2 · SUSPECTED — selection→ring paint includes the full inspector render
- **Evidence:** `selectNode` commits the rings, the Properties panel, the Layers panel and InPlaceInspector in one sync commit. There is no `useDeferredValue`/`startTransition` anywhere in the inspector (only `SelectorsPanel.tsx:174`). The rings position one rAF after the commit.
- **Fix:** the inspector reads a deferred selection, so the ring paints first. Gate it with the missing budget in §3. **Owner:** panel-designer + perf-hunter.

### PERF-15 · P2 · SUSPECTED — `will-change` toggled around every gesture
- **Evidence:** `useCanvas.ts:210-219`, released 200 ms after the last write.
- **Mechanism:** on a many-frame board this may re-rasterize every mounted iframe at gesture end. Profile a zoom on the 12-frame fixture before changing anything.

### Side note (correctness, not perf) · SUSPECTED
`mouseleave` from a child back into its parent calls `hoverNode(null)` (`NodeRenderer.tsx:537`). The parent never receives `mouseenter`, so the parent shows no hover ring. Owner: canvas-engineer.

## 3. Budgets and benches — what exists, what is missing

**Exists:**

| Gate | Checks |
|---|---|
| `studio-board-perf.e2e.ts` (12 frames × ~28 nodes) | Pan worst < 40 ms and layer mutations < 10; zoom worst < 250 ms and mean < 35 ms; live iframes < frames; posters appear |
| `studio-feel.e2e.ts` | Zoom smoothness on 3-frame `test4` |
| `performance.e2e.ts` | Startup < 20 s |
| Inspector height budgets | Height only |
| Unit gates | Subscription count (`per-node-selector-budget`), full-site loop pattern, overlay rAF discipline, pool mount counts |
| `bench:editor-store` | Mutation cost with zero subscribers, which is blind to PERF-1 |

**Missing, and should exist:**
1. **Subscriber-sweep bench** in `bench:editor-store`: the §1 scratch bench, with a budget (e.g. hover set < 1.5 ms at 40×300×12).
2. **Large corpus.** Generate a 40-frame × 300-node board into the e2e throwaway workspace. Every current budget runs on 28-node pages.
3. **Selection → ring paint < 32 ms** (WS-5.6, never built): click → first rAF after the ring style write.
4. **Keystroke → paint**, for inspector text and inline edit, on the large corpus.
5. **Hover sweep:** a scripted mouse path across 50 nodes, asserting no long animation frame > 20 ms (catches PERF-1 and PERF-2). Add a Layers-panel hover variant with 12 mounted frames.
6. **Pan with a live selection:** assert the toolbar and inspector stay within N px of the ring mid-gesture (PERF-3).
7. **Idle rAF count:** 2 s idle with a selection must show 0 rAF callbacks per second from the app (PERF-4). The S4 unit test covers only the overlay.
8. **Post-structural-gesture re-sync:** count re-rendered `NodeRenderer`s and measure time after a ⌘D (PERF-6).
9. **Cold / warm load, first frame interactive:** < 2 s warm on a 40-page repo (WS-5.5), plus a server-restart case (PERF-7).
10. **No long task > 50 ms within 1 s of a click that follows a 700 ms post-edit pause** (PERF-5).
11. **Memory:** heap and detached-document count after 20 pan cycles and 50 edits (pool evictions, poster data URLs).
12. **Server `/load` on a 1,000-file repo:** warm-path time and event-loop block time (PERF-8).
13. **Tier-2 animated fixture:** frame-fit passes per second on an app with a JS animation (PERF-9).

## 4. Recommended order
1. PERF-2 (S, P0).
2. PERF-3 (S–M, P0).
3. PERF-4 (S).
4. PERF-11 guards (S).
5. PERF-1 (M, the biggest scaling lever), landed together with budgets 1, 2 and 5 so it is measured before and after.
6. PERF-5, then PERF-6.
7. PERF-7 and PERF-8 on the server line.
