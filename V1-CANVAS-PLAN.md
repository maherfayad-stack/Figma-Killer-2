# V1 Canvas — Implementation Plan

**Branch:** `instatic-fork`. Builds on [INSTATIC-FORK-PLAN.md](INSTATIC-FORK-PLAN.md) (four-seam fork) and the adapter-swap / commit-on-idle model.

## Status (2026-07-23)

| Phase | Scope | State |
|---|---|---|
| 0 | Adapter-swap spike (node↔source loop) | ✅ Done — `e3c6b49`, `60ba657` |
| 1 | Board layer MVP + sticky notes | ✅ Done — `11c9e77`, `f7183df` |
| 2 | Component manifest + in-place props | ✅ Done — `01ae6ad`, `e1d3ac3` |
| 3 | Visual style editing → source | ✅ Done — `77d4188`, `dd2b3e8` |
| 4 | Multiple boards + documentation | ✅ Done — `321ff35`, `aa5379c` |
| 5 | Performance pass | 🚧 In progress — 5A done (`376cd75`), 5B done, 5C pending |
| 6 | Design tab UI, canvas DnD, Inspect tab, code export, resizable frames + device presets | 🚧 In progress — 6E done, 6A–6D planned — see "Phase 6" below |
| 7 | Multi-file backend, MCP React-app import, GitHub-link import | 📋 Planned — see "Phase 7" below |

**Dogfood fixes landed on top of the phase work:** studio mode made sticky so it stops reverting to CMS breakpoints (`13ec847`); board switcher moved to bottom-center to clear the canvas notch (`9c6df05`).

Phases 1–4 are functionally complete and awaiting a full human dogfood pass. Phase 5 (performance) and the backlog below are the remaining work. **See "Phase 5 — detailed plan" and "Backlog / known limitations" at the bottom of this doc for the actionable next steps.**

## The five things we're building
1. An infinite canvas you can drop **sticky notes / annotations** onto, holding **multiple frames that are real React pages**.
2. **Components with editable props in place** that react instantly.
3. **Visual editing of text, colors, shadows** etc. directly on the canvas.
4. **Multiple canvases (like Figma pages)** — separate flows/screens + documentation around them.
5. Everything **fast and seamless**.

---

## The one decision that governs everything: two stacked canvases

Instatic's "canvas" renders **one document's breakpoints** side-by-side in a pan/zoom layer (`CanvasTransformLayer`, `useCanvas.ts`). It is NOT a Figma-style board of many independent pages + freeform objects. So we introduce **two levels**:

```
BOARD  (NEW — Figma "page"; infinite pan/zoom surface, editor-owned)
  ├── Frame  ── a real React page  (Instatic renders this: iframe + NodeRenderer)
  ├── Frame  ── another React page
  ├── Sticky note      (canvas furniture — NOT React source)
  ├── Text / doc block (canvas furniture)
  └── Connector/arrow  (canvas furniture)
```

- **Frame level = Instatic, reused.** Each frame is an Instatic page (`NodeTree`) rendered via `IframeFrameSurface` + `NodeRenderer`, with all existing editing: select, DnD, inline text edit, property controls, breakpoints, zoom-stable selection overlays.
- **Board level = NEW.** An infinite surface that positions many frames + annotation objects. We extend Instatic's existing pan/zoom + cross-iframe overlay geometry (already zoom-stable, already cross-iframe hit-tested) from "breakpoints of one page" to "arbitrary frames + furniture."

**Doctrine (keeps the thesis intact):** the React source folder is authoritative for *app content*; the editor owns ONLY **spatial metadata** — board list, frame positions, sticky notes, doc blocks, connectors, comments. Sticky notes never touch `.tsx`. This is the playbook's "only editor-owned persistent data is spatial metadata" rule, honored exactly.

### Where data lives
| Data | Home | Authoritative? |
|---|---|---|
| React pages (frames' content) | real `.tsx` files in the app folder | ✅ source of truth |
| Components + their props | real `.tsx` component files | ✅ source of truth |
| Board list, frame x/y, zoom | `.studio/boards.json` (editor-owned) | editor-owned spatial |
| Sticky notes, doc blocks, connectors | `.studio/boards.json` | editor-owned spatial |
| Comments/anchors | `.studio/boards.json` | editor-owned spatial |

`.studio/*` never affects app runtime, mirroring the fork thesis. Git versions both.

---

## Requirement-by-requirement: KEEP / EXTEND / BUILD

### 1. Infinite canvas + sticky notes + multiple React-page frames
- **KEEP:** iframe frame rendering (`IframeFrameSurface`, `NodeRenderer`), pan/zoom (`useCanvas.ts`), zoom-stable overlays + cross-iframe geometry (`canvasOverlayGeometry.ts`, `canvasDomGeometry.ts`).
- **EXTEND:** `CanvasTransformLayer` / `CanvasRoot` from "N breakpoints of the active page" → "N frames of arbitrary pages, freely positioned." Frame position comes from `.studio/boards.json`, not the breakpoint layout.
- **BUILD:** a **board object layer** — a `BoardObject` union (`frame | sticky | text | connector`) rendered in the transform layer; a `boardSlice` in the editor store; a `.studio/boards.json` reader/writer. Sticky notes are positioned divs with their own selection, edited with the existing inline-`contentEditable` mechanism reused from `inlineEditSlice`.

### 2. Components with in-place prop editing, instant reaction
- **KEEP:** schema-driven property controls (`src/core/module-engine/propertySchema.ts` → `property-controls/`), Visual Component instance/ref nodes (`renderVisualComponentRef.ts`), instant in-memory re-render.
- **REWIRE:** map real `.tsx` components → the module/VC registry; derive prop schemas with `react-docgen` (manifest). Prop edit mutates the in-memory node → **instant** canvas re-render; commit-on-idle (autosave adapter) writes the prop to source via ts-morph.
- **BUILD:** an **in-place mini-inspector** — a small floating prop editor anchored to the selected component on the canvas (the panel machinery already exists; this is a compact anchored surface reusing the same controls). "Reacts instantly" = the in-memory buffer render; source write is deferred.

### 3. Visual editing of text, colors, shadows
- **KEEP (all already exist):** inline text edit (double-click `contentEditable`), style/class controls, framework **color tokens**, box-shadow controls, the class ↔ visual-control binding.
- **REWIRE:** style edits currently mutate the class registry / node props → also **project to source** (Tailwind classes or style props) via the codemod adapter, per the editable-surface contract. Colors bind to tokens where possible so they stay themeable.
- **BUILD:** minimal — ensure text/color/shadow controls round-trip cleanly to `.tsx` (class list edit or `style={{}}` edit codemods).

### 4. Multiple boards (Figma pages) + documentation
- **BUILD:** a **board manager** — a `boards[]` collection in `.studio/boards.json`, each board an independent surface with its own frames + furniture. A board switcher in the shell (repurpose Instatic's Site Explorer / DocumentSwitcher UI, which already groups Pages/Templates/Components). Boards reference which React pages appear as frames.
- **Documentation** = `text`/`doc` board objects (markdown-capable, canvas furniture) placed around frames. Reuse the markdown core (`src/core/markdown/`) for rendering doc blocks.

### 5. Fast and seamless
- **In-memory editing** (Instatic's node buffer) = instant; disk/AST only on idle (autosave adapter). Already true.
- **Frame virtualization:** only mount iframes for frames intersecting the viewport; render lightweight placeholders (Instatic already has `CanvasFrameSkeletonFrame`) for offscreen frames. Pause offscreen iframe work.
- **Overlay RAF loop** already arms only when there's visible overlay work (`hasOverlayWork`) — keep that discipline for board objects.
- **Static-HTML preview retained** (`src/core/publisher/`) as the fast export path; heavy real-React mounting only where fidelity requires it.

---

## Phases (risk-ordered — prove the riskiest thing first)

### Phase 0 — Adapter-swap spike (from the fork plan) ⭐ 1–2 days
One real component in one frame → click resolves to `.tsx` line → edit a prop in the panel → ts-morph codemod writes source → HMR reflects it. Implemented as a minimal `IPersistenceAdapter` (`loadSite` = parse folder → `SiteDocument`; `saveSite` = codemod dirty docs). Reuses autosave/dirty-tracking untouched.
**Gate:** the node↔source loop closes for one prop. Nothing else starts until it does.

### Phase 1 — Board layer MVP (Req 1) — 4–6 days
- `boardSlice` + `.studio/boards.json` read/write.
- Extend the transform layer to host multiple page-frames positioned from board data.
- `BoardObject` rendering; **sticky notes** create/move/edit/delete (reuse inline-edit).
**Gate:** one board, two real React-page frames + sticky notes, pan/zoom, positions persist to `.studio`.

### Phase 2 — Component manifest + in-place props (Req 2) — 4–6 days
- Manifest scan (`react-docgen`) → module/VC registry; map real components.
- Instant in-memory prop edit; commit-on-idle → source (extends Phase 0 codemods to component props).
- In-place mini-inspector anchored on canvas.
**Gate:** select a component on a frame, edit typed props in place, instant re-render, source updates on idle.

### Phase 3 — Visual style editing → source (Req 3) — 3–5 days
- Text (done) + color/shadow controls round-trip to `.tsx` (class or style-prop codemods); colors prefer tokens.
- Enforce editable-surface contract: dynamic regions locked ("edit in code").
**Gate:** change text, a color, and a shadow on canvas; all land in source; dynamic nodes stay locked.

### Phase 4 — Multiple boards + documentation (Req 4) — 3–4 days
- `boards[]` + board switcher (repurpose Site Explorer/DocumentSwitcher).
- `text`/`doc` board objects with markdown; connectors/arrows.
**Gate:** multiple independent boards, each with distinct frames + doc blocks; switch between them.

### Phase 5 — Performance pass (Req 5) — 2–4 days
- Frame virtualization (viewport-intersection mount + offscreen pause).
- Board-object overlay stays inside the armed RAF loop.
- Lower autosave debounce to a snappy commit interval; verify no write→watch→write loops (reload event already clears the dirty flag).
**Gate:** dozens of frames + notes on a board, smooth pan/zoom, edits feel instant, source stays correct.

---

## Known hard parts
1. **Board layer is the biggest new build** — heterogeneous canvas objects + multi-frame hosting. Mitigated by extending Instatic's existing zoom-stable, cross-iframe overlay engine rather than starting from scratch.
2. **Node ⇄ AST translation** (inside the adapter) is still the meaty codemod work; the editable-surface contract bounds it.
3. **Frame identity across reload** — a frame maps to a page file; keep the `.studio/boards.json` frame→file reference stable so board layout survives code edits.
4. **Concurrent edit** — a page being canvas-edited is canvas-owned until idle commit; external edits reconcile via the reload event.

## First action
Run **Phase 0**. It is shared with the fork plan and de-risks the entire product. Everything else builds on a proven node↔source loop. — ✅ done; the loop is proven, all of Phases 0–4 ride on it.

---

## Phase 5 — detailed plan (performance + focus)

Phase 5 has two halves: **(A) make the board fast with many frames**, and **(B) strip the CMS chrome so the shell reads as a design-canvas tool, not a CMS.** Do A first (it's the stated gate); B is the "make it feel like the product" cleanup.

### 5A — Frame virtualization
**Problem:** every `BoardFrame` mounts a live `BreakpointFrame` (an iframe + full `NodeRenderer` tree). A board with dozens of frames mounts dozens of iframes → slow pan/zoom, high memory.
**Plan:**
1. In `BoardFramesLayer`, compute each frame's board-space rect (x/y + frame width/height) and intersect it against the current viewport rect (derive from `pan`/`zoom` + container size — the same geometry `canvasOverlayGeometry.ts` already uses).
2. Mount the real `BreakpointFrame` only for frames intersecting an inflated viewport (viewport + ~1 screen margin so scrolling doesn't pop). For offscreen frames, render a lightweight placeholder — reuse `CanvasFrameSkeletonFrame` if it fits, else a plain sized `<div>` with the page title.
3. Keep the drag header + `data-page-id` + `--frame-x/--frame-y` on the placeholder so position, activation, and the "×" still work without the iframe mounted.
4. Preserve per-frame identity: keep `key={page.id}` so React remounts the iframe cleanly when a frame re-enters the viewport.
**Gate:** a board with ~30 frames pans/zooms smoothly; only visible frames have iframes (verify via DOM iframe count).

### 5B — Autosave cadence + write-loop safety
**Problem:** boards autosave on an 800 ms debounce; the CMS page adapter commits on a ~30 s idle. Studio source writeback should feel snappy without thrashing the file watcher.
**Plan:**
1. Confirm the studio source commit path (`fsCodemodAdapter.saveSite` → `/admin/api/studio/save`) uses the idle-commit machinery and that the reload/watch event clears the dirty flag so a write doesn't re-trigger a write (the "write→watch→write loop" risk called out in the plan). Add a guard/test if not already covered.
2. Keep boards' 800 ms debounce (already has the snapshot-identity check from `f7183df` that prevents dropping edits made mid-flight). Do **not** lower it below the round-trip time.
3. Verify overlay RAF discipline: `BreakpointSelectionOverlay`'s loop must only arm when there is visible overlay work (`hasOverlayWork`). Board-object drags (sticky/doc/frame) already run on pointer-capture handlers, not the RAF loop — confirm no board object forces the RAF loop to stay hot when idle.
**Gate:** edit text/prop on a frame → source updates within a beat, no observable write-loop, no dropped board edits.

**Findings (done):**
1. **No write→watch→write loop, and there is no filesystem watcher at all.** Neither Vite's dev server (`studio-workspace/pages/**` is never `import`ed into the client module graph, so writes there don't touch HMR) nor the Bun backend (`server/handlers/studio.ts` reads pages via `node:fs` at request time — no `fs.watch`/chokidar anywhere in `server/`) observes studio page writes. The only reload path while the editor is mounted is the explicit `CMS_SITE_RELOAD_EVENT`, fired solely by `requestCmsSiteReload()` call sites (manual save-and-reload, plugin install) — never by `usePersistence` or either persistence adapter's `saveSite`. Pinned by `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` (a save issues exactly one `POST /admin/api/studio/save`, never a `GET /admin/api/studio/load`) and `src/__tests__/persistence/writeLoopSafety.test.tsx` (the reload handler clears `hasUnsavedChanges`, even from a dirty state, instead of leaving/re-setting it — so a reload can never immediately re-arm autosave).
2. **Studio's commit cadence was inherited from the CMS's user-configurable, default-30s auto-save preference** (`usePersistence` read `readAutoSaveDelayMs()` unconditionally for both adapters). Fixed by adding an `options.autoSaveDelayMs` override to `usePersistence`, wired from `AdminCanvasLayout` to `STUDIO_AUTOSAVE_DELAY_MS` (2s, exported from `fsCodemodAdapter.ts`) only in studio mode; the CMS path is untouched and still reads the preference (default 30s). 2s sits mid-band of the ~1.5-3s target, well above the actual same-machine round trip (a ts-morph codemod POST, tens of ms), and coalesces bursts of edits into one write. Pinned by `src/__tests__/persistence/autoSaveCadence.test.ts` (pure, timer-free unit test of the override-precedence rule).
3. **Overlay RAF discipline was already correct — no change made.** `BreakpointSelectionOverlay`'s tick loop is gated by `if (!hasOverlayWork) return`, and `hasOverlayWork` is derived only from `showToolbar`/`showSelectorHighlight`/`showRings` + selection/hover state — no board-object concept. Board object drags (`BoardFramesLayer`, `DocBlockView`, `StickyNoteView`) all move via `setPointerCapture` pointer handlers and contain no `requestAnimationFrame` call, so they cannot force the loop to stay armed while idle. Pinned by `src/__tests__/canvas/overlayRafDiscipline.test.ts` (source-shape check).

### 5C — Strip CMS chrome → design-canvas focus
**Problem:** the shell still exposes CMS-only workspaces/controls that don't belong in a design tool. `cf71a89` already hid the built-in `base.*` block modules from the palette; this finishes the job at the shell level.
**Plan (audit first, then cut):**
1. Enumerate what the shell shows in studio mode vs. CMS mode (workspaces, top-bar actions, explorer sections). Decide per item: keep, hide-in-studio, or delete.
2. Route studio/CMS divergence through the existing `isStudioMode()` helper (`studio/studioMode.ts`) — do not fork components; gate at render.
3. Candidates to hide/simplify in studio: publish/CMS-only top-bar actions, Posts/Pages/Templates/Components explorer grouping (studio thinks in boards + frames, not CMS document types), any settings that assume DB-backed content.
**Gate:** entering `?studio` presents a board-first UI with no dangling CMS affordances; leaving it restores the full CMS.

**Findings (done):**
1. **Publish action group** (`toolbar/PublishActionGroup.tsx`, mounted via `toolbar/PublishButton.tsx`) is hidden entirely in studio — gated in `AdminCanvasLayout.tsx`'s `rightSlot` on the already-resolved `studioMode` local. It bundles Publish + Save draft + Schedule + the draft-status pill, all targeting the CMS publish pipeline (static-artefact bake, publish-version bump); studio's source of truth is the on-disk `.tsx`, and studio's own 2s idle-commit autosave (`STUDIO_AUTOSAVE_DELAY_MS`) already keeps it in sync without a manual save button. Studio's export story ("Download code") is Phase 6D, not built yet.
2. **"Open live page"** (`shared/OpenLivePageButton`, the toolbar's global trailer) is hidden only when `section === 'site' && isStudioMode()` (gated in `toolbar/Toolbar.tsx`, reusing the `section` prop the shell already receives) — it opens the CMS's published static output, which studio pages never go through. Scoping on `section` (not a bare `isStudioMode()`) matters: the studio flag is a sticky, cross-route localStorage bit, and the button is legitimate CMS chrome on Content / Data / Media / other admin routes even while that bit is set from a previous Site-editor session.
3. **SiteExplorerPanel's Templates and Components sections** (`panels/SiteExplorerPanel/SiteExplorerPanelSections.tsx`) are hidden in studio — both are CMS document types (`page.template`, `site.visualComponents`) `fsCodemodAdapter` never populates, and creating one wouldn't persist: `saveSite` only writes back edits for source-backed `relFile:line:col` nodes, so a "New template"/"New component" click in studio would silently lose its work on the next save. The **Pages** section (and Styles/Scripts) stay — Pages is the only way to see/rename/delete workspace pages by name outside a board frame, and Styles/Scripts weren't touched (lower confidence they're inert, out of the audit's primary scope).
4. **DocumentSwitcher** (`canvas/DocumentSwitcher.tsx`) — kept, unchanged. It only renders inside `TemplateModeControl`/`VisualComponentModeControl`, which themselves only render for CMS-only states (`activeDocument.kind === 'visualComponent'`, `activePage.template.enabled`) that studio's page set can never reach now that Templates/Components creation is hidden (finding 3) — so there was no dangling affordance left to gate.
5. **Not touched (kept, noted as lower-confidence):** the Settings modal (general appearance/theme prefs are meaningful in every mode; its sections weren't individually audited) and the Pages-section context menu's "Open in new tab" / "Set as homepage" actions (same CMS-live-path category as finding 2, but nested deep in a per-item context menu rather than shell/toolbar chrome — narrower audit needed before cutting).

---

## Phase 6 — Design tab UI, canvas DnD, Inspect tab, code export

The "make it feel like a real design tool" phase. Four independent slices — 6A/6B are polish on existing surfaces, 6C/6D are new capability. Each is separately shippable; **6C and 6D are the two that add genuinely new user-facing power, so prefer them if time is short.**

### 6A — Design tab UI pass
**Today:** the right-hand design surfaces already exist and are schema-driven — `panels/PropertiesPanel` (per-node props), plus `ColorsPanel`, `TypographyPanel`, `SpacingPanel`, `FrameworkPanel`, `FrameworkScalePanel`, and the control set in `property-controls/` (`ColorControl`, `TokenizedColorField`, `TokenAwareInput`, `FontFamilyControl`, `NumberControl`, …). They were built for CMS editing and read dense.
**Plan:**
1. Audit the design tab against a designer's mental model: group controls into legible sections (Layout / Typography / Fill & Stroke / Effects), collapse rarely-used ones, and give each control a consistent label/affordance rhythm.
2. Tighten the visual system — spacing scale, section headers, control heights — using existing tokens only (`--bg-*`, `--text-*`, `--border*`, `--space-*`, `--radius`, `--panel-radius`). No new hex.
3. Make token-bound values obvious: when a color/spacing value resolves to a design token, show the token name, not just the raw value (`TokenAwareInput`/`TokenizedColorField` already know this — surface it consistently).
4. Keep every control on the `src/ui/` primitives (`Button`, `Input`, `Select`, `Switch`, `ColorInput`). No bespoke controls.
**Gate:** selecting a node shows a scannable, grouped design tab; token-bound values read as tokens; all existing edits still round-trip to source.

### 6B — Canvas drag & drop
**Today:** DnD runs on `@dnd-kit/core`; canvas-specific behavior is documented in [`docs/reference/canvas-dnd.md`](docs/reference/canvas-dnd.md), with `useCanvasReorderDrag.ts` handling reorder + edge auto-pan. Board-level drags (frames, sticky notes, doc blocks) use raw pointer-capture with `screenDelta / zoom`, deliberately separate from dnd-kit.
**Plan:**
1. **Drop precision:** clearer insertion indicators when dragging a module into the tree — show the exact insertion line and the target parent, at any zoom.
2. **Board-level snapping:** alignment guides + snap-to-edge/center when dragging frames, sticky notes, and doc blocks, so boards stay tidy. Snap logic should be a **pure function** (input: dragged rect + peer rects + threshold → adjusted position + guide lines) so it is unit-testable without a browser, mirroring `frameVirtualization.ts`.
3. **Multi-select drag** for board furniture (marquee or shift-click), moving several objects together.
4. Keep the two drag systems separate — do NOT migrate board furniture onto dnd-kit just for symmetry; pointer-capture is correct there.
**Gate:** dropping a module lands exactly where the indicator showed at any zoom; frames/notes snap and show guides; multi-select moves as one.

### 6C — Inspect tab (colors + CSS properties) ✅ Done
**New capability.** A read-only "Inspect" panel for the selected node — the Figma-inspect / devtools-style view: resolved colors as swatches, typography, spacing/box model, and the effective CSS.
**Plan:**
1. New `panels/InspectPanel/`, registered alongside the existing panels (mounted via `AdminCanvasEditorBody.tsx`; panel layout state lives in `site/layout/siteEditorLayoutPersistence.ts`).
2. **Read computed styles from inside the frame's iframe.** The plumbing already exists: `CanvasDocumentContext` (the frame's `Document`) and `CanvasFrameElementContext` (the iframe element) in `CanvasContexts.ts`; resolve the selected node's element by node id and call `getComputedStyle`. Do NOT re-derive styles from the node tree — the whole point is showing what actually rendered.
3. Present: color swatches (with copy-to-clipboard of hex/rgb **and** the design-token name when the value matches a token), typography (family/size/weight/line-height), box model (margin/padding/size), and a raw CSS block.
4. **Recompute on a settled selection, not on a RAF loop.** Read once per selection/style change; do not add a hot polling loop (respect the `hasOverlayWork` discipline established in Phase 5).
5. Copy affordances everywhere — copying a value is the primary use of an inspect panel.
**Gate:** select any node on a frame → Inspect shows its real rendered colors/typography/box model; token-matched colors display the token name; every value is copyable.

**Findings (done):**
1. **Mounting deviated from the plan** — instead of a bespoke mount in `AdminCanvasEditorBody.tsx`, `InspectPanel` is registered as a 5th `PanelRail` / `LeftSidebar` item (`uiSlice.ts`'s `LeftSidebarPanelId`), the same consolidated-panel mechanism Selectors/Framework/Dependencies already use. It's read-only, so it joins Explorer in `READ_ONLY_RAIL_IDS` (both rail files) and stays visible for non-editing callers — the only panel besides Explorer that does.
2. **Element resolution deviated from the plan too** — `CanvasDocumentContext`/`CanvasFrameElementContext` are canvas-tree-only contexts; `InspectPanel` lives in the sidebar, outside that tree, so there's no provider to consume. Used the already-general `findRenderedCanvasNodes(nodeId)` (`canvas/canvasNodeLookup.ts`) instead — the same lookup the plugin host and `ClassPicker`'s selector picker already use to resolve a node id to its live element(s) across every mounted breakpoint frame. When more than one frame has rendered the node, the one whose `data-breakpoint-id` matches the active breakpoint is preferred.
3. **No effect, no RAF, no polling** — the computed-style read (`useInspectComputedStyle`) is a plain synchronous render-time read (mirrors the existing `useClassPickerDerivedState` → `findRenderedCanvasNodeElement` pattern), gated only by the store subscriptions the component itself declares (`selectedNodeId`, the selected node object, `activeBreakpointId`). It naturally recomputes exactly when one of those changes and never on an unrelated store update.
4. **Token matching is exact-only and color-format-agnostic** — `inspectModel.ts`'s `canonicalColorKey` normalizes hex/rgb(a)/hsl(a) to an rgba channel tuple before comparing a computed value against every `generateFrameworkColorVariableSets(...).light` entry, so `#2563eb` on the node and `rgb(37, 99, 235)` on the token still match. No fuzzy/nearest-color matching — a miss just shows the raw computed value.
5. Pure model + color-parsing logic lives in `panels/InspectPanel/inspectModel.ts`, unit-tested at `src/__tests__/panels/inspectModel.test.ts` (matching the repo's centralized panel-test convention, not a panel-local `__tests__/`).

### 6D — Download the code
**New capability, and the thesis paying off:** because the filesystem is the source of truth, "download the code" is not a codegen step — the real `.tsx` already exists on disk.
**Plan:**
1. Server endpoint under the existing studio handler family (`server/handlers/studio.ts`, sibling of `/load`, `/save`, `/boards`) that streams a **zip** of the workspace source: `studio-workspace/pages/*.tsx` plus any local component/style files the pages import.
2. Decide and document the boundary: ship the page sources + local components; do **not** bundle `node_modules` — the design-system dependency (`@alm-design/design-system`) is an npm package, so emit a minimal `package.json` recording it instead.
3. Client trigger in the toolbar ("Download code"), fetched through `@core/http` — use `apiBlobRequest` (the authenticated binary-response entry), validate the MIME type, then save the blob. **No raw `fetch`.**
4. Exclude editor-owned spatial metadata (`.studio/boards.json`) from the export — it is not app code. Mention it in the doc so the omission is a decision, not an oversight.
**Gate:** click Download code → a zip of real, runnable page source lands; unzipping and `bun install && bun run dev` in a scratch dir renders the same pages.

### 6E — Resizable frames + device-size presets ✅ Done

**New capability.** Give each board frame its own size: drag-resize on the canvas, and a **device-size preset picker at the top of the design tab** (the Penpot pattern — pick "iPhone 16", "iPad Pro 11in", "Web 1280", etc., and the frame snaps to that size).

**Findings (done):**
1. `BoardFrame.width`/`.height` are optional fields (`src/core/studio-board/types.ts`); `coerceFrame` (`serialize.ts`) only sets them when the raw value is a positive number, otherwise omitting the keys entirely rather than baking in 1024×800 — the 1024×800 fallback lives once, at render time (`BoardFramesLayer`'s `frame.width ?? FRAME_WIDTH`), so it's the single source of truth for "no saved size" and old `boards.json` files round-trip byte-for-byte.
2. `resizeFrame(board, pageId, width, height)` (`boardsModel.ts`) mirrors `moveFrame`'s no-op-on-missing-pageId shape; `boardSlice.setFrameSize` is its store-facing action, wired through the existing 800 ms autosave untouched.
3. Device presets ported to `src/core/studio-board/devicePresets.ts` — 65 devices across the seven documented groups (Apple 30, Android 13, Microsoft 3, reMarkable 2, Web 4, Mixed 4, Print 9), read directly from `../penpot/frontend/src/app/main/constants.cljs`'s `size-presets`. Penpot's trailing "SOCIAL MEDIA" group is intentionally not ported (out of scope — this picker targets screen/print form factors). `findMatchingPreset(width, height)` is the pure exact-match lookup `FrameSizePanel` uses to decide "named preset" vs. "Custom".
4. Resize handles: all 8 (4 corners + 4 edge midpoints), gated on the active frame, in `BoardFrameView` (`BoardFramesLayer.tsx`). Geometry is the pure `resizeFrameRect` (`frameResize.ts`, `MIN_FRAME_SIZE = 200`) — it returns the frame's next full rect (x/y/width/height) so a north/west-edge drag can re-anchor position via the existing `onMove` callback in the same gesture that resizes via `onResize`. Live-resize updates continuously on every `pointermove` (not just pointer-up), mirroring the existing frame-DRAG handler's own always-live update — the 800 ms boards autosave is what "settles" the write, not the drag handler. Shift-to-keep-aspect was skipped (optional in the plan; not worth the added complexity for this pass).
5. `FrameSizePanel` (`panels/PropertiesPanel/`) renders at the top of the design tab, gated on `isStudioMode()` + the active page resolving to a frame on the active board. `PropertiesPanel`'s own top-level visibility gate was widened by one clause (`isActiveBoardFrame`) so the panel — and this picker — stays open on a bare frame activation, before any node inside it is selected; `PropertiesPanelBody` still renders its normal "select an element" empty state underneath in that case.

**Prerequisite — per-frame size in the model.** Frames are currently locked to shared constants (`FRAME_WIDTH = 1024`, `FRAME_HEIGHT = 800` in `frameGrid.ts`) and every frame renders at one synthetic `STUDIO_BREAKPOINT` (width 1024, in `BoardFramesLayer.tsx`). This must become per-frame:
1. Extend `BoardFrame` in `@core/studio-board` (`{ pageId, x, y }` → add `width?`, `height?`). **Additive + tolerant parse** — `parseBoardsFile` must default missing sizes to the current 1024×800 so existing `boards.json` files keep working (no migration, no data loss). Keep transforms pure/immutable.
2. `BoardFramesLayer` reads each frame's own `width`/`height` (falling back to the constants) instead of the shared values — for the render box, the virtualization rect (`frameVirtualization.ts` already takes width/height), and the per-frame breakpoint width fed to `BreakpointFrame`.
3. New `boardSlice` action `setFrameSize(pageId, width, height)`, persisted through the existing 800 ms boards autosave (with its snapshot-identity guard).

**Device presets.** Mirror Penpot's list **verbatim** for fidelity — source of truth is `../penpot/frontend/src/app/main/constants.cljs` (`size-presets`), grouped Apple / Android / Microsoft / reMarkable / Web / Mixed / Print (see [[penpot-source-reference-map]]). Port it to a pure TS constant module (e.g. `src/core/studio-board/devicePresets.ts` or a canvas-local module), each entry `{ group, name, width, height }`. No logic, just data — trivially testable.

**Canvas resize.**
1. Resize handles on the selected frame (corner + edge). Reuse the board's pointer-capture + `screenDelta / zoom` pattern (same as frame drag in `BoardFrameView`) so it tracks the cursor 1:1 at any zoom. Factor the resize math (anchor + delta + min-size clamp → new rect) into a **pure function** so it unit-tests without a browser.
2. Live-resize updates the in-memory frame; commit on pointer-up via `setFrameSize`.
3. Sensible min size; optional shift-to-keep-aspect.

**Design-tab preset picker.**
1. A `Select` (from `src/ui/`) at the top of the design tab, grouped by the preset categories, plus editable W/H number inputs (`NumberControl`) showing the frame's current size.
2. Choosing a preset or editing W/H calls `setFrameSize`. Show the active preset name when the frame's size matches one exactly; show "Custom" otherwise.
3. Only meaningful for a selected **frame** (board context) — hide/disable in CMS mode via `isStudioMode()`.

**Gate:** select a frame → design tab shows its size + a device-preset picker; pick "iPhone 16" and the frame snaps to 393×852; drag a corner to resize freely; both persist to `boards.json` and survive reload; old boards without sizes still open at 1024×800.

---

## Phase 7 — Real projects: multi-file backend, MCP import, GitHub import

The largest architectural leap: go from a curated flat `studio-workspace/pages/*.tsx` demo to **loading real, existing React apps**. Three slices, strictly ordered — 7A is the foundation the other two require.

### 7A — Multi-file project backend
**Today:** the studio backend is single-directory and flat. `GET /admin/api/studio/load` scans `studio-workspace/pages/*.tsx` and returns `{ dir, pages }`; `parsePageFile` (`@core/page-parser`) parses one page in isolation; source writeback (`applyStudioEdit`) codemods a single file. Real apps are trees of files with local component imports, shared modules, and nested routes.
**Plan:**
1. **Workspace model.** Replace the flat scan with a project model that walks a configurable root: discover page/route files, local components they import, and shared modules — respecting `tsconfig` path aliases and ignoring `node_modules`/build output. Persist the resolved file graph so the editor knows which file owns which node.
2. **Node identity stays file-scoped.** The `relFile:line:col` node id already namespaces by file — extend the loader so `relFile` is a workspace-relative path across the whole tree, not just `pages/`. Codemods already target a file + position; point them at the resolved path.
3. **Component resolution.** When a page imports a local component, resolve and parse it so its props/tree are available to the inspector and (where editable) writeback — distinguish **local, editable** components from **npm-package** components (`@alm-design/design-system`), which stay read-only prop surfaces.
4. **Boundaries.** Every new endpoint validates with TypeBox via `readValidatedBody`; responses go through the `{ error }` envelope; client reads via `apiRequest`. No raw `fetch`, no `as` at boundaries.
5. **Docs.** Update the studio/fork docs to describe the multi-file workspace model.
**Gate:** point the studio at a multi-file React project (pages + local components + shared modules); pages render as frames; selecting a node resolves to the correct file; edits write to the right file; npm-package components are read-only, local ones editable.

### 7B — GitHub-link import
**New capability.** Paste a GitHub repo URL → the app pulls it in as a studio workspace.
**Plan:**
1. Server endpoint (studio handler family) that, given a repo URL (+ optional branch/subdir), fetches the source into a workspace directory. Prefer a **tarball download of a ref** over a full `git clone` where possible (lighter, no history); support private repos only via an explicit user-supplied token, never a baked-in credential.
2. Hand the fetched tree to the 7A workspace loader — import is just "fetch source, then load it as a project." Do NOT build a second parsing path.
3. **Safety:** treat imported source as untrusted input. Nothing from an imported repo executes on the server; parsing is static (ts-morph / `@core/page-parser`) and the QuickJS sandbox rules for any plugin-like code still apply. Cap repo size / file count and report what was skipped (no silent truncation).
4. Client: a "Import from GitHub" entry (URL input + optional branch/subdir), fetched through `@core/http`; progress + a clear error envelope on failure (bad URL, private without token, too large).
**Gate:** paste a public React repo URL → it imports, loads as a workspace (via 7A), and its pages render as frames; a bad/oversized/private-without-token URL fails with a clear toasted message, not a crash.

### 7C — MCP: import React apps into the system
**New capability, riding existing infra.** Instatic already exposes its CMS tools over MCP at `/_instatic/mcp` (`server/ai/mcp/`, per-connector bearer tokens, the `(userId, scope)` live workspace bridge — see [`docs/features/mcp-connectors.md`](docs/features/mcp-connectors.md)). Add an MCP tool so an external agent (Claude Code, Codex) can import a React app into a studio workspace programmatically.
**Plan:**
1. New MCP tool (e.g. `studio_import_project`) in the MCP server, thin over the 7A/7B import path — accept either a GitHub URL (reuse 7B) or a set of files, land them in a workspace, return the workspace/board summary. **Reuse the import engine; do not fork it into the MCP layer.**
2. Respect the existing MCP contract: `@modelcontextprotocol/sdk` is allowed **only** under `server/ai/mcp/`; the tool is capability-gated like the other write tools; edits stay drafts until an explicit publish/commit call. Reads route in-process; anything mutating the live workspace goes through the `editorBridge` to the connector owner's open workspace.
3. Validate the tool's input/output with TypeBox (the MCP layer already passes schemas as JSON Schema — no zod).
4. **Docs.** Add the new tool to `docs/features/mcp-connectors.md` in the same change.
**Gate:** from an external MCP client, call the import tool with a repo URL → the project lands as a studio workspace and is editable in the owner's open session; the tool honors capability gating and the draft-until-publish rule.

> **Sequencing note:** 7A must land before 7B and 7C — both are "fetch source, then load via 7A." Building either import path against the old flat loader would create a second workspace model to later reconcile, which CLAUDE.md's "no duplicate old/new paths" rule forbids.

---

## Backlog / known limitations (post-v1, not Phase 5 blockers)

These surfaced during implementation and dogfooding. None block the Phase 5 gate; capture them so they aren't lost.

1. **Per-frame breakpoint chrome.** Every studio frame shares one synthetic breakpoint id (`STUDIO_BREAKPOINT.id === 'studio'`, see `BoardFramesLayer.tsx`), so breakpoint-*keyed* chrome (collapsed state, "open in live", toolbar highlight) is not per-frame-correct. Selection rings ARE correct (queried by node id). Revisit if per-frame breakpoints are needed. `centerOnBreakpointFrame` also collides on the shared id.
2. **`alm.*` text + style writeback.** Text/inline-style codemods (`setJsxText`/`setJsxStyle`) round-trip for `base.*` nodes; design-system (`alm.*`) components may not forward `style` or declare an editable text prop, so those edits may not project to source. Needs a per-component editable-surface declaration.
3. **Connectors / arrows.** The board object union was scoped for `frame | sticky | doc`; connectors/arrows (in the original Req-4 sketch) are not built.
4. **Frame default sizing.** ✅ Shipped in **Phase 6E** (per-frame width/height + drag-resize + device-size presets — see the "6E" findings above). A frame with no saved size still renders at the fixed 1024×800 from `frameGrid` — that fallback is intentional, not a gap.
5. **Optional studio toggle in the toolbar.** Studio mode is entered via `?studio` (now sticky via localStorage). A visible on/off toggle in the toolbar would be friendlier than editing the URL.

## Pre-existing failures (NOT from this work — do not "fix")
- `toolbar.test.ts` ENOENT — repo path contains a space (`Figma Killer 2` → `%20`), a fork-base path issue.
- `button-primitive-usage.test.ts` BTN-3 — ~17 fork-base Instatic files use bare `<button>`; allowlist debt inherited from the Instatic base, not introduced here.
