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
| 5 | Performance pass | ⏳ **Next** — not started |

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

### 5C — Strip CMS chrome → design-canvas focus
**Problem:** the shell still exposes CMS-only workspaces/controls that don't belong in a design tool. `cf71a89` already hid the built-in `base.*` block modules from the palette; this finishes the job at the shell level.
**Plan (audit first, then cut):**
1. Enumerate what the shell shows in studio mode vs. CMS mode (workspaces, top-bar actions, explorer sections). Decide per item: keep, hide-in-studio, or delete.
2. Route studio/CMS divergence through the existing `isStudioMode()` helper (`studio/studioMode.ts`) — do not fork components; gate at render.
3. Candidates to hide/simplify in studio: publish/CMS-only top-bar actions, Posts/Pages/Templates/Components explorer grouping (studio thinks in boards + frames, not CMS document types), any settings that assume DB-backed content.
**Gate:** entering `?studio` presents a board-first UI with no dangling CMS affordances; leaving it restores the full CMS.

---

## Backlog / known limitations (post-v1, not Phase 5 blockers)

These surfaced during implementation and dogfooding. None block the Phase 5 gate; capture them so they aren't lost.

1. **Per-frame breakpoint chrome.** Every studio frame shares one synthetic breakpoint id (`STUDIO_BREAKPOINT.id === 'studio'`, see `BoardFramesLayer.tsx`), so breakpoint-*keyed* chrome (collapsed state, "open in live", toolbar highlight) is not per-frame-correct. Selection rings ARE correct (queried by node id). Revisit if per-frame breakpoints are needed. `centerOnBreakpointFrame` also collides on the shared id.
2. **`alm.*` text + style writeback.** Text/inline-style codemods (`setJsxText`/`setJsxStyle`) round-trip for `base.*` nodes; design-system (`alm.*`) components may not forward `style` or declare an editable text prop, so those edits may not project to source. Needs a per-component editable-surface declaration.
3. **Connectors / arrows.** The board object union was scoped for `frame | sticky | doc`; connectors/arrows (in the original Req-4 sketch) are not built.
4. **Frame default sizing.** New frames use a fixed grid height (~800px) from `frameGrid`; frames don't size to their content.
5. **Optional studio toggle in the toolbar.** Studio mode is entered via `?studio` (now sticky via localStorage). A visible on/off toggle in the toolbar would be friendlier than editing the URL.

## Pre-existing failures (NOT from this work — do not "fix")
- `toolbar.test.ts` ENOENT — repo path contains a space (`Figma Killer 2` → `%20`), a fork-base path issue.
- `button-primitive-usage.test.ts` BTN-3 — ~17 fork-base Instatic files use bare `<button>`; allowlist debt inherited from the Instatic base, not introduced here.
