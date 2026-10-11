# Board speed: one scene, few live documents (design plan, 2026-10-10)
> **Purpose:** the design for a fast board: one scene, few live documents (bundles SB-0..SB-9, decisions D1..D7) · **Read when:** before starting or reviewing a bundle of this plan · **Trust:** live design, not built (2026-10-10; STATE.md says which bundles are in flight) · **Owner:** studio-architect; studio-scribe folds shipped bundles out · **Verified:** 2026-10-10 (design read against the code, nothing run)

Status: design only. No repo file was edited and nothing was run (RAM). No STATE.md entry written because the owner said not to touch repo files; the implementing agent writes it at SB-0. Not on ROADMAP except as the open row "Frame pool ... SPEED speed-09" (ROADMAP §13, covered by none) and P2-A/P6-C budgets. This plan supersedes speed-09.

## 1. GOAL / DONE WHEN

GOAL: stop paying per-document cost for every screen on the board. At most ~4-6 screens are live documents; every other screen is a cached bitmap plus a parent-side rect index, composited on one surface.

DONE WHEN (100-frame corpus, preview build, `board-scale-budgets.e2e.ts`): pan/zoom p95 frame <= 16 ms; click->ring p95 <= 16 ms (on a live frame AND on a poster frame); `document.querySelectorAll('iframe').length <= liveCap + 2`; documents and JS listeners flat across 20 zoom cycles.

## 2. What exists (build on it, do not re-invent)

- `BoardFramesLayer/frameVirtualization.ts` `isFrameOnScreen` (board->screen math, 600 px margin). Keep, extend with a zoom rule.
- `framePool.ts` (192 lines): ONE LRU policy, `max(8, onScreen+4)` portal / `max(onScreen, 8)` live. This is why 20 iframes are mounted for ~4 visible: the floor of 8, +4 headroom, +600 px margin, plus Tier-2 fallback+bridge pairs. The pool is a memory ceiling, not a target, but it keeps whole documents warm.
- `framePosterQueue.ts` (quiet-timer, serial), `useFramePosterCapture.ts` (html-to-image, 85-1160 ms main thread per frame), `frameSnapshotCache.ts` (WeakMap<Page> -> dataURL; dies on reload; `getFramePoster(page,width)`), `FramePosterPlaceholder.tsx`.
- `frameAdapter/FrameDocumentAdapter.ts` (+Portal 527 / Bridge 537 lines): already the seam between "frame DOM" and the rest; has `NodeMeasurement`, `DropCandidateGeometry`. The rect index plugs in here.
- `AgentSnapshotFrame` (offscreen, inert, `interaction='capture'`): a ready-made single reusable capture document.
- `frameTreeMountQueue.ts` (one tree commit at a time, centre first), `overlayMeasureScheduler.ts`, `nodeVisualRect` (canvasDomGeometry.ts:230), `canvasHover.ts`, `canvasPressTarget.ts`.
- Audit `01-perf.md`: PERF-2 (a ring/badge `childList` mutation in a frame triggers frame-fit `collectScrollDeficits` = `querySelectorAll('*')` + `getComputedStyle` forced layout, and unroll `getComputedStyle` on every element, in EVERY mounted frame when a Layers hover/selection carries no frameId), PERF-5/P2-I (posters), P6-A/C.

## 3. Why iframes stay (fidelity constraint)

A single shared document (or Shadow DOM per screen) cannot honour the user's CSS: `html/body/:root` selectors, `vh/vw` units, `@media (max-width)` against the frame width, `@layer` order, `dir`/`data-theme` on the document element. Trap 1 forbids wrappers. So a "live" screen = one iframe document, and the lever is HOW MANY are live and WHAT ELSE does the work. Constructed stylesheets cannot be shared across documents in Chromium, so vendor CSS parses once per live doc (~7 ms, size-of-CSS memory each): another reason to cap live docs. Parse-never-execute is untouched: posters/indices are derived from the same parse-rendered DOM; Tier-2 bridge frames keep their existing gate (`trustGate.ts`).

## 4. Where the 52-58 ms click task most likely goes (verify in SB-0, do not assume)

Measured so far: hit test + `NodeRenderer` re-render are NOT it (renders per click 2,799 -> 2; inspector stubbed = no change). Native hit-test in a clean document is ~0.1-1 ms. Remaining suspects, in order: (H1) in-frame ring/badge DOM mutation -> MutationObservers (frame-fit, unroll, adapter attributes, overlay) -> forced style+layout per mounted frame (PERF-2 multiplier x 20 docs); (H2) per-frame overlay measure passes reading rects in dirty documents; (H3) parent-document style/layout with 20 transformed iframes; (H4) `selectNode` store notify (6-10 ms measured). The design removes H1/H2 structurally rather than patching each observer.

## 5. Options evaluated (estimates, labelled; every one is validated by SB-0 numbers)

| Option | Effect (estimate) | Cost | Verdict |
|---|---|---|---|
| A. Live cap + posters for the rest (drop 8-floor pool, drop live margin) | docs 20 -> <=6 (-70%); heap 20x0.85 = 17 MB -> ~5 MB live; all per-doc observers/listeners -70%; fixes unbounded growth by construction | M; needs posters to exist BEFORE unmount (capture while live+idle, or pre-captured) | YES, core |
| B. Bitmap posters: store as encoded WebP Blob (IndexedDB + `.studio/cache/posters/<contentHash>-<w>.webp`), decode on demand into an `ImageBitmap` LRU with mip levels (1x, 1/2, 1/4, 1/8) | encoded ~80-150 KB per 390x1600 screen; 100 frames ~12 MB on disk, 0 in heap; decoded 1x at DPR2 is ~10 MB GPU each, so a decoded budget (e.g. 48 MB) and zoom-matched mip are mandatory, at 0.25 zoom a level is ~0.15 MB | L | YES |
| C. Frame pool / literal document reuse | saves iframe create 12 ms + vendor CSS 7 ms of a ~60 ms mount (~30%) but only on mounts, which poster-first makes rare; adds stale-state risk (portal root re-parent, injector cleanup rewrites, S1 STATE note) | M | NO. Delete speed-09. The only "pool" kept is the single reusable capture frame |
| D. CSS containment / `content-visibility` | parent style/layout on 100 wrappers: est 1-3 ms. `contain: paint` is unsafe: resize handles and labels hang outside the frame box. Use `content-visibility:auto` + `contain-intrinsic-size` (last measured height) on the poster placeholder only, `contain: layout style` on the wrapper | S | YES, small, in SB-1 |
| E. Single poster surface (one 2D `<canvas>` under the live frames, drawImage of mip-selected ImageBitmaps, redrawn in the same rAF that already writes the transform in `useCanvas.applyTransformToDOM`) | 100 draws ~1-2 ms; one layer instead of 100 `<img>`; deterministic texture memory | M | YES (2D first). WebGL/OffscreenCanvas worker only if the SB-6 spike shows > 4 ms at 300 frames: trilinear mips + texture streaming are its only wins; context-loss + 600-900 LOC is its cost |
| F. Parent-side spatial index (board-space rects per node, flatbush-style packed R-tree, ~120 LOC own, no dependency) | click/hover hit-test = one tree lookup, 0 cross-document layout reads; works on POSTER frames (click a screen you never mounted) | L | YES, with G |
| G. Chrome (rings, handles, badges, hover, measure) drawn in ONE parent overlay from the index, not as DOM inside each frame | removes in-frame childList mutations entirely => H1 gone, frame-fit/unroll observers never see chrome, canvas-23 "chrome counts as content" class of bug disappears, bridge runtime overlay root deleted | L | YES, the biggest click lever |
| H. Incremental per-node re-render | Portal frames already reconcile per node (P2-I, P6-A: 2 renders per click). What is still whole-frame: `ClassStyleInjector` rewrites the whole `<style>` text (restyle x M). Replace with rule-level CSSOM `insertRule/deleteRule/replace` diff, only in frames rendering the page, skip identical text | M | YES (SB-7) |
| I. Poster rasterizer | html-to-image clones DOM and copies computed style per element (85-1160 ms). Studio owns the document, so serialize `documentElement.outerHTML` + the injected `<style>` texts into one SVG foreignObject (real cascade, no per-element computed-style walk): est 2-5 ms serialize per 300-node frame + off-thread decode; fonts/images inlined once per stylesheet version. Alternative: HTML-in-Canvas `drawElementImage` (WICG; availability in shipping Chrome UNVERIFIED) or a server-side headless screenshot (needs a browser on host; not assumed) | spike in SB-2 | Decide by the spike; budget <= 15 ms main per poster |

## 6. Target architecture

Three frame states, chosen by one pure function (replaces `resolveFrameMount`'s `on-screen | pooled | offscreen`):

- `live`: iframe document mounted, React portal attached. Members: selected frames, the frame being edited/dragged into, frames in view at zoom >= Z_LIVE (rank by distance to viewport centre, adaptive cap `LIVE_CAP`: default 20, scaled by device memory and the measured live-frame budget, never below 12), the play/live-mode frame. Hover alone does NOT promote (hover ring comes from the index).
- `poster`: no document. Bitmap (mip-selected) on the poster canvas + rect index entry. Selectable, hoverable, ring-able.
- `cold`: title card only (never rasterized yet); fills in from the background capture queue.

Data (all derived, none authoritative; disk source of truth unchanged):
- `FramePoster {key = hash(pageContent, styleRegistry, width, axes, preview locale), blob, size, indexBlob}` persisted in `.studio/cache/posters/` (gitignored like `.studio/cache` parse cache) and IndexedDB; in-memory `ImageBitmap` LRU.
- `FrameGeometryIndex` per frame: packed arrays `{nodeId, depth, parentIndex, x,y,w,h in frame-local px, visualRect semantic = nodeVisualRect}`, rebuilt by `adapter.measureAll()` after each settled commit (one batched read pass: 300 nodes ~1-3 ms clean layout) and by the existing observers marking it dirty. Board hit-test: `hitTestBoard(clientPoint)` -> frame (parent-side rect math, no iframe.getBoundingClientRect) -> index lookup -> `canvasPressTarget` applied to the STORE tree's ancestor chain (it must stop reading `closest()` on DOM; confirm in SB-3).
- Poster capture runs in one reusable offscreen capture frame (`AgentSnapshotFrame` path) serially in the settle queue (setTimeout, not rAF/idle: PROJECT-BRIEF trap), also used to fill a freshly opened board in the background and to refresh a live frame's poster when it is idle (not under the user's hands).

Click path after: pointerdown (parent canvas root, one listener) -> `hitTestBoard` ~0.05 ms -> `selectNode` 6-10 ms measured (store) -> parent overlay paints from index in the same commit. If the frame is a poster, it is promoted in the background (`frameTreeMountQueue`), ring already visible; edit gestures that mutate the tree wait for `live` (<= 250 ms) — drag of a poster frame node starts only after promote with a visible "preparing" cursor? (owner decision D3).

Pan/zoom: transform imperative (unchanged); poster canvas redrawn in the same rAF; live iframes inside the transformed layer; during an active gesture live frames keep their current paint (no mount/unmount, `framePosterQueue` busy rules unchanged); promotion/demotion happens on settle (after `canvasViewportActivity` ends), centre-first.

## 7. Budgets (new e2e `tests/e2e/board-scale-budgets.e2e.ts`, `@production-bundle`, generator fixture of 100 frames x ~150 nodes; calibrate in SB-0, then freeze at ~20% over the median of 3 runs, like `canvas-feel-budgets`)

| Metric | Today (12-frame board, measured) | Target (100 frames) |
|---|---|---|
| iframes in DOM at 4 visible | 20 | <= liveCap + 2 (<= 8), 4 typical |
| documents / JS listeners after 20 zoom cycles | grows | delta 0 (+/- 2 docs) vs cycle 1 |
| pan p95 frame time (2 s scripted) | worst 50-92 ms (18 frames) | p95 <= 16, worst <= 32 |
| zoom (1 -> 0.1 -> 1) p95 | mean 21-22, worst 195 ms | p95 <= 16, worst <= 50 (promotion deferred to settle) |
| click -> ring, live frame, p95 | 62-77 ms (47 ms prod mean) | <= 16 |
| click -> ring, poster frame | not possible (no selection) | <= 16 |
| longest task within 1 s of a click | 52-58 ms | <= 16 ms (hard fail > 50) |
| poster -> live promote, interactive | n/a | <= 250 ms (matches 100-140 ms mount + queue) |
| main-thread per poster refresh | 85-1160 ms | <= 15 ms |
| heap per live frame | ~0.85 MB (+ doc-side style copy) | <= 1.2 MB |
| tab JS heap, 100-frame board | ~linear, unbounded | <= 150 MB; decoded poster budget 48 MB (GPU), persisted posters off-heap |
| idle rAF/s, idle listeners churn | 0 | 0 |

## 8. Phased bundles (suggested ids `SB-n`; serial, tree builds after each; heavy-run lock for e2e)

| Id | Change | Main files | Risk | Tests / gates | Size |
|---|---|---|---|---|---|
| SB-0 | Attribute and baseline. CDP tracing harness splits Recalculate Style/Layout by frame for a click; `Memory.getDOMCounters` zoom-cycle gate (find and fix the leak: candidates are adapters/observers/listeners not disconnected on unmount, `framePosterQueue.frameListeners`, registry subscribers); 100-frame fixture generator; record the table in section 7 | `tests/e2e/board-scale-budgets.e2e.ts` (new), `tests/e2e/helpers/` (new trace helper), `tests/e2e/fixtures/` generator, leaking owners found by trace | Low | new e2e records numbers, only the leak assertion is hard | S, 2-3 d |
| SB-1 | Containment quick wins: `content-visibility:auto` + `contain-intrinsic-size` on `FramePosterPlaceholder`; `contain: layout style` on frame wrapper; Layers hover/selection always carries a `frameId` (kills PERF-2 multiplier) | `BoardFramesLayer.module.css`, `FramePosterPlaceholder.tsx`, `TreeNode.tsx` (selection path), `selectionSlice.ts` | Low-med (handles hang outside; no `contain: paint`) | `framePoolMountReason.test.tsx` unchanged; e2e click delta | S, 1-2 d |
| SB-2 | Poster store v2 + capture. Content-hash keys, WebP blob persistence (IndexedDB + `.studio/cache/posters/` via a declared studio route + `routeCapabilities.ts` row), `ImageBitmap` mip LRU, serial capture in the reusable capture frame, background fill on open, Studio-owned foreignObject serializer (spike first; keep html-to-image only for agent exports, else delete from poster path). Delete `frameSnapshotCache.ts` WeakMap, `framePosterNeeded` (capture while live+idle, not while off-screen) | `BoardFramesLayer/frameSnapshotCache.ts`->`posterStore.ts`, `useFramePosterCapture.ts`, `framePosterQueue.ts`, `AgentSnapshotFrame.tsx`, `server/handlers/studio/posterCache.ts` (new) + `subRouters.ts` + `routeCapabilities.ts` | Med: fidelity vs html-to-image (fonts, images), cache invalidation keys, disk growth (cap + LRU eviction) | unit: key/eviction/mip; `renderEvidence.test.ts`; `studio-routes-capability-declared.test.ts`; e2e poster refresh <= 15 ms main | L, 7-10 d |
| SB-3 | Rect index. `FrameGeometryIndex` (packed R-tree), `adapter.measureAll()` on Portal + Bridge adapters (Bridge: runtime posts one batched `NodeMeasurement[]`), dirty signals reuse existing observers, `hitTestBoard`, `canvasPressTarget` switched to tree-based ancestry. Index persists with the poster | `frameAdapter/FrameDocumentAdapter.ts`, `PortalFrameAdapter.ts`, `BridgeFrameAdapter.ts`, `canvasDomGeometry.ts` (reuse `nodeVisualRect`), `canvasPressTarget.ts`, `canvasNodesUnderPoint.ts` (replace `elementsFromPoint`), new `frameGeometryIndex.ts`, `public/runtime/` source in `@core/studio-runtime` + rebuild bundle | High: staleness (images/fonts loading, fixed->absolute unroll), transformed nodes need quads, box-less nodes | parity test: index rect == live `nodeVisualRect` for every node on 3 real fixtures (rotation, display:contents, flex gaps); hover/click latency unit bench; e2e hit-test equals native hit-test on a click grid | L, 8-10 d |
| SB-4 | Parent-side chrome. One board-space overlay renders rings, handles, badges, hover, measure, spacing handles from the index; delete in-frame overlay root for portal frames and the bridge runtime's overlay root; per-frame `BreakpointSelectionOverlay` observers go | `BreakpointSelectionOverlay.tsx` (700 lines -> shrink), `CanvasSelectionOverlayInjector.tsx`, `CanvasSelectionChrome.tsx`, `overlayMeasureScheduler.ts`, `CanvasResizeHandles.tsx`, `CanvasSpacingHandles.tsx`, `MeasureLayer.tsx`, `@core/studio-runtime` overlay modules, `selectionChromeCss`, `useIframeFrameAutoHeight.ts`/`frameFitMutationScheduler.ts` (drop overlay-root filters), `canvasGesture.ts` | High: crisp 1-px lines under zoom (counter-scale with `--canvas-zoom`, already exists), resize/drag latency, live-mode runtime chrome, a11y of rings | existing ring tests re-pointed; `liveFrameParity.test.ts`; e2e click->ring <= 16, "no DOM mutation inside a frame on select/hover" test (MutationObserver count == 0); `selection-keyboard-hands.e2e.ts` | L, 10-14 d |
| SB-5 | Poster-first mounting. Replace `framePool.ts` policy with live set (selected, edited, in-view at zoom >= Z_LIVE, adaptive cap, default 20, floor 12); `FrameMountReason = 'live' | 'poster' | 'cold'`; promote on settle / on edit; delete `MIN_FRAME_POOL`, `FRAME_POOL_HEADROOM`, `LIVE_FRAME_POOL_SIZE`, the portal/live cost split (a bridge frame is just a live frame with its own cap) and the 600 px live margin (margin stays for poster prefetch only) | `framePool.ts`, `frameVirtualization.ts` (add zoom rule + rank), `BoardFramesLayer.tsx`, `BoardFrameView.tsx`, `LiveBoardFrame.tsx`, `frameTreeMountQueue.ts`, `agent/renderEvidence.ts` (mount-reason strings) | High: user edits a poster frame (inspector) needs a live doc; agent capture expects 'visible' frames mounted; prototype/play mode | rewrite `framePool.test.ts` + `framePoolMountReason.test.tsx` to assert `live <= cap` at every pan step; architecture gate `board-live-frame-cap.test.ts` (no constant above cap, no second pool); e2e iframe count, promote <= 250 ms, `studio-board-perf.e2e.ts` updated | M-L, 6-8 d |
| SB-6 | Poster compositor. One 2D canvas replaces per-frame poster `<img>` and placeholders; mip selection by zoom*DPR; redraw in `applyTransformToDOM`'s rAF; spike gate for WebGL at 300 frames | `CanvasTransformLayer.tsx`, `useCanvas.ts`, new `BoardPosterCanvas.tsx`, `BoardFramesLayer/FramePosterPlaceholder.tsx` (becomes title-only) | Med: canvas/iframe 1-frame sync; DPR/zoom crispness; decode jank (decode in `createImageBitmap`, off-thread) | e2e pan/zoom p95 at 100 and 300 frames; budgets frozen here | M, 5-6 d |
| SB-7 | Incremental style. `ClassStyleInjector` applies a rule-level CSSOM diff (insert/delete/replace), only in frames whose page uses the changed classes, skips identical; poster dirty only on content/style hash change | `ClassStyleInjector.tsx`, `canvasClassCss.ts`, `AuthoredCssInjector.tsx`, `lifecycleActions.ts` (already deep-equal) | Med: CSS-order within `@layer user-authored`, `mc-classes` vs `mc-authored` source order must survive | existing class-CSS tests; new test: N edits -> 0 full `<style>` text writes; keystroke->canvas budget stays <= 42 ms (dev) | M, 4 d |
| SB-8 | Tier-2: cap live bridge frames (<= 3, each is a cross-origin doc plus a dev-server connection); poster/index for a bridge frame come from the runtime (same serializer, runs INSIDE the dev-server doc, so it only runs where Tier 2 already executes the project); fallback portal no longer mounts beside the bridge | `LiveBoardFrame.tsx`, `BridgeFrameAdapter.ts`, `@core/studio-runtime/runtime.ts`, `trustGate.ts` unchanged | High: cross-origin capture, HMR re-index (`hmr:after`) | `live-frame-budgets.e2e.ts`, `studio-tier2-two-gates.test.ts` stays green | M, 5 d |
| SB-9 | Delete and document: dead poster/pool code, `html-to-image` from the board path, STATE/docs (`canvas-internals.md` Perf + framePool sections, `docs/features/canvas-iframe-per-frame.md`, `path-index.md`), ROADMAP row speed-09 closed | docs + knip/fallow pass | Low | `bun run fallow` clean; docs gate | S, 1-2 d |

Total ~ 50-65 agent-days. SB-0 -> SB-1 -> SB-2 -> SB-3 -> SB-4 -> SB-5 -> SB-6 are strictly sequential (each leans on the previous); SB-7 can run beside SB-5; SB-8 after SB-5. Ship value early: SB-0+SB-1 (leak, containment) are shippable alone; SB-4 alone (even without posters) should take click->ring to the store-bound ~10-12 ms.

## 9. Risks

- Staleness of the index/poster (images, fonts, animation freeze, unroll pass moving things) -> index is versioned by the frame's settle count, rebuilt after every settle; a hit on a stale entry is verified against the live doc when the frame is live; posters are marked stale by hash, never shown as current after an edit while a live doc exists.
- A poster is a stale picture (the old S1 note): the edited frame is always live, so the user never edits a picture; other frames' posters refresh on idle after a hash change.
- Fidelity of the bitmap (fonts, backdrop-filter, video, canvas): the capture frame is the real injector chain; document gaps by name like the animation-freeze note. Never fake it.
- Moving chrome out of the frames touches every gesture (resize, spacing, text edit caret, crop): do SB-4 with the existing gesture tests as the contract, one chrome kind per PR inside the bundle.
- Parent overlay crispness at zoom and DPR -> counter-scale, as in-frame chrome already does; e2e pixel-snap assertions on ring width.
- Disk cache growth / privacy -> `.studio/cache/posters/` gitignored, LRU-capped (default 500 MB), per-project; no upload anywhere.
- Agent tools (`studio_export_frames`) assume 'visible' frames are mounted -> `renderEvidence.ts` mounts through the capture frame, not the board.
- RAM is scarce on the dev machine: every e2e here is heavy-run-locked; the 100-frame fixture is generated, not committed.

## 10. Owner decisions needed

- D1 (decided, see `docs/decisions.md` SB-D1): adaptive live cap, default 20, never below 12; Z_LIVE = 0.35.
- D2: Is a bitmap poster acceptable for screens the user is not editing, even at 100% zoom beyond the cap (picture refreshes on idle, not instantly on every edit elsewhere)?
- D3: Editing a node on a poster frame: auto-promote with a short wait (<= 250 ms), or require a click-to-activate like Figma's "enter frame"?
- D4: Persist posters to `.studio/cache/posters/` (disk, gitignored, capped) - yes/no, and the cap size.
- D5: Tier-2 posters: rasterize inside the dev-server document (runtime-side, needs Tier 2 already granted, higher fidelity) or from the static fallback (cheaper, lower fidelity)? Also: is "cap 3 live bridge frames" OK?
- D6: Rasterizer path: accept the Studio-owned foreignObject serializer (replacing html-to-image on the board), or wait for a browser-native HTML-in-Canvas API (availability unverified)?
- D7: WebGL scene: not now (2D canvas first, revisit only if SB-6 measures > 4 ms at 300 frames). Confirm.
