# V1 Canvas — Implementation Plan

**Branch:** `instatic-fork`. Builds on [INSTATIC-FORK-PLAN.md](INSTATIC-FORK-PLAN.md) (four-seam fork) and the adapter-swap / commit-on-idle model.

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
Run **Phase 0**. It is shared with the fork plan and de-risks the entire product. Everything else builds on a proven node↔source loop.
