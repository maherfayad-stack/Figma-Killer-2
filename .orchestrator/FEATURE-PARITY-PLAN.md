# FEATURE-PARITY-PLAN — canvas-code-studio (post P5-rework)

**Status:** PLAN ONLY — awaiting human approval. No execution yet (2026-07-16).
Backs onto `PENPOT-FIDELITY-SPEC.md` (look/feel, done) + three Penpot research
briefs in scratchpad (`penpot-findings-{design,workspace,features}.md`, mined
from a Penpot clone, MPL-2.0).

Human feedback that triggered this (2026-07-16):
> "editing anything in the canvas isn't functional at all; zooming in/out and
> TLdraw functionality not there at all; changing the widths of the side
> panels; commenting, adding frames, editing text; exporting to PNG/JPG/SVG —
> all missing. Get back to Penpot and grab all the features … put a plan …
> also this top part is taking big space, add its content to the left pane and
> remove it."

---

## 0. The load-bearing decision: what "editing on canvas" means here

Penpot is a **vector tool** — every shape is a free-floating SVG rect on an
infinite viewBox; you drag it anywhere, resize/rotate freely. **We are a
code-first tool**: a frame is a real React app rendered in an iframe, and the
elements inside it are **real DOM in normal CSS flow, styled by Tailwind
classes**. That difference decides which Penpot features port 1:1, which port
*reframed*, and which don't port at all.

Two layers, two interaction models:

| Layer | What it is | Interaction model |
|---|---|---|
| **Frames (boards)** | tldraw shapes positioned by `.studio/canvas.json` geometry | **Full free-canvas**: pan/zoom/select/marquee/move/resize frames — tldraw already does this; we mostly need to *expose* it. |
| **Elements inside a frame** | real JSX/DOM nodes | **Context-aware drag (Figma auto-layout model)** — see D-EDIT. Plus: select, in-place text edit, prop/class edits, insert/delete. |

This is not a limitation to apologize for — it's the whole thesis ("the file IS
a real app"). The plan makes the **frame layer** feel like Penpot, and makes the
**element layer** a first-class *code-aware* editor (select → drag/text/class
edits → real AST ops), which is what our P3 engine already powers.

> **DECISION D-EDIT (RESOLVED, human 2026-07-16): dragging an element is
> CONTEXT-AWARE, exactly like Figma auto-layout.**
> - **Parent is a flex/grid container** → the element is **NOT free**; dragging
>   **re-sorts within the layout** (bound to flex/grid rules — drag between
>   siblings shows a drop indicator and reorders; position is owned by DOM order
>   + layout props, committed as a `move-node` reorder, never absolute x/y).
> - **Parent is NOT flex/grid** → the element is **free**; dragging sets its
>   position (committed as absolute positioning written into the JSX/classes:
>   `absolute` + inset/translate).
> This mirrors Figma: inside auto-layout you sort, outside it you place freely.
> The tool must **detect the parent's layout mode** (from the parent's Tailwind
> classes / computed style via the bridge) and switch drag behavior accordingly,
> showing the right affordance (reorder drop-line vs. free move) for each.
> Still out: multi-select free-transform, rotate, and resize-handles on in-flow
> elements (resize = edit w/h classes in the inspector) — [advanced]/later.

Architecture note: Penpot's biggest lesson — "route every mutation through one
canonical apply-ops-to-tree layer so undo/redo + sync are free" — **we already
have**: the P3 AST engine (`applyOp`/`invertOp`, daemon undo/redo, git
checkpoints). Every feature below emits existing `CanvasOp`s or a small additive
control-message; none needs a second scene model.

---

## 1. Current state (audit, 2026-07-16)

Works: dashboard, open project, camera-fit, Pages+Layers/boards, Assets, Tokens,
Inspector, component insert (renders), inspector text/class edits write to source.

Broken / missing (matches the human's list):
- **Zoom/pan feel absent** — tldraw's zoom + nav UI are explicitly nulled
  (`MINIMAL_COMPONENTS` in `StudioCanvas.tsx`); zoom only via undiscoverable
  Cmd+wheel; no zoom widget.
- **Canvas editing not functional** — element select works ONLY after
  double-clicking a frame into "edit mode" (`edit-mode-layer.tsx`), and only
  *selects* (feeds inspector). No in-place text edit; no single-click select.
- **Toolbar tools are dead** — `activeTool` is set in the store but **no canvas
  code consumes it**; Frame/Text/Image/Comment do nothing.
- **No panel resize** — sidebars are fixed 318px.
- **No comments** (P7, never built).
- **No export** (no PNG/JPG/SVG; `screenshot-capture.ts` exists as a raster
  building block).
- **Top bar** (`TopBar.tsx`, 52px) duplicates what Penpot puts in the sidebar
  headers — the human wants it folded into the left pane and removed.

---

## 2. The plan — workstreams FP-1 … FP-7

Each maps a cluster of the human's asks to a code-first implementation. Ordered
by dependency + value. Priority tags: **[core]** now, **[secondary]** v1,
**[advanced]** defer. All: workers Sonnet/no-git, sequential, gated by real
browser dogfood (per `dogfood-ui-before-gating`).

### FP-1 — Canvas interaction unlock + zoom UI  [core]  → "zoom/tldraw functionality"
- **Expose tldraw's native interactions** on the frame layer: pan (space+drag,
  middle-drag, wheel), zoom (Cmd/Ctrl+wheel anchored at cursor). Stop nulling
  the pieces we want; keep our custom chrome.
- **Penpot zoom widget** (in the new right-pane header, FP-2): % readout +
  dropdown → Zoom in/out, 100% (Shift+0), Fit all (Shift+1), Fit selection
  (Shift+2), each with its shortcut. Wire the `+`/`-`/`Shift+0/1/2` keys.
- **Frame select on canvas** ↔ studio selection: clicking a frame selects it
  (tldraw) and syncs to Layers/Inspector; marquee-select frames (tldraw native).
- Files: `packages/canvas/StudioCanvas.tsx` (component overrides, camera API),
  a new zoom-widget in `apps/studio` header, `use-workspace-keymap.ts`.
- Accept: pan/zoom by mouse+keyboard+widget; zoom %; fit-all/selection; frame
  click selects and reflects in panels. Dogfooded.

### FP-2 — Panel resize + fold the top bar into the panes  [core]  → "panel widths" + "top part taking space"
- **Resizable left/right panels**: drag handle on the inner edge, min/max clamp
  (318–500 left, 318–768 right per spec), width persisted per-project in
  localStorage (Penpot's `use-resize-hook` mechanics, reimplemented as a React
  hook in `packages/ui` or `apps/studio`).
- **Remove `TopBar.tsx`**; redistribute its content (Penpot has no global top
  bar — a left header + a right header):
  - **Left pane header**: project/file name (inline rename), the File/main menu,
    back-to-dashboard.
  - **Right pane header**: zoom widget (FP-1) + comments toggle (FP-5) + undo/redo.
  - **Status bar** keeps daemon-connection + selected-uid.
  This reclaims the 52px band and matches Penpot exactly.
- Files: new `use-resize` hook, `WorkspaceShell.tsx` (drop the topbar row + grid
  row), left/right panel headers, delete/gut `TopBar.tsx`.
- Accept: drag both panel edges (persists across reload); no global top bar;
  file name + menu in left header, zoom/comments/undo in right header. Dogfooded.

### FP-3 — Toolbar tools wired to real canvas actions  [core]  → "adding frames"
- Wire `activeTool` → actual behavior:
  - **Select (V)** — default; frame select + element select (FP-4).
  - **Frame (F/B)** — create a new frame (reuse the existing `create-frame`
    control op; click places a default frame, or the existing "+ New Frame"
    flow, restyled). Auto-name.
  - **Text (T)** — insert a text element (`insert-node` of a `<p>`/`<span>` with
    placeholder) into the active frame, then enter in-place edit (FP-4).
  - **Image** — file picker → insert an `<img>` element (copy asset into the
    file-folder `public/` via a daemon op, `src` set) OR data-URI for MVP.
  - **Insert component (I)** — opens Assets (exists).
  - **Comment (C)** — enters comment mode (FP-5).
- Files: `Toolbar.tsx`, `use-node-ops.ts`/`use-component-insert.ts`, a new
  tool-action bridge between studio store `activeTool` and canvas/daemon;
  possibly one additive control-message for image asset copy.
- Accept: each tool does what it says; adding a frame works from the toolbar;
  Text inserts + edits; Image inserts. Dogfooded.

### FP-4 — In-place canvas editing (select + text + context-aware drag)  [core]  → "canvas editing / editing text"
This is the meatiest FP; it may split into FP-4a (select+text) and FP-4b (drag).
- **Frictionless element select on canvas**: clicking inside a frame selects the
  element under the cursor (drive the existing bridge hit-test without requiring
  a prior double-click "edit mode"; a frame becomes "active" on select, then its
  elements are hit-testable). Two-way sync canvas ↔ Layers ↔ Inspector. Keep the
  hover outline + breadcrumb from `edit-mode-layer.tsx`.
- **In-place text editing**: double-click a text element → the bridge turns that
  node `contentEditable` in the iframe → on blur/Enter, commit `set-text` to
  source (extend `packages/bridge` with an edit-text message; daemon already
  applies `set-text`). Esc cancels.
- **Context-aware drag-to-move (D-EDIT, Figma auto-layout model)** — on
  pointer-down on a selected element, the bridge reports the **parent's layout
  mode** (flex/grid vs. not):
  - **Flex/grid parent → drag re-sorts within the layout.** Show a drop-indicator
    line between siblings; on drop, commit a `move-node` reorder (P3 op — already
    exists). No coordinates written; DOM order + layout props own position. This
    is exactly Figma auto-layout reordering.
  - **Non-layout parent → free drag.** Live-translate a ghost while dragging; on
    drop, commit absolute positioning into source (add `absolute` + `left/top`
    or a `translate`, via `set-classes`/`set-prop`). The element is genuinely
    free-placed, written back as clean-ish positioning classes.
  - The overlay must render the correct affordance per mode and detect the mode
    live (parent class/computed-style over the bridge). Snapping-to-siblings is a
    [secondary] add-on once basic drag works.
- Files: `packages/bridge` (additive: enter-edit-text/commit; report-parent-
  layout; drag hit-tracking), `edit-mode-layer.tsx` (single-click select + drag
  gestures + drop indicators), selection store ↔ workspace store sync, node-ops
  (`move-node`, `set-classes`) reuse, `Inspector`/`LayersPanel` (consume
  selection).
- Accept: click an element → selects everywhere; double-click text → edit in
  place → source updates; **drag an element in a flex/grid parent → it reorders;
  drag one in a non-layout parent → it moves freely**, both writing correct
  source that still renders. Dogfooded.

### FP-5 — Comments (local-first)  [secondary]  → "commenting"
- **Local comment threads** now (full backend sync is P6): a pin placed on the
  canvas anchored to `{frameId, x, y}` (+ optional element uid), stored in
  `.studio/canvas.json` (a `comments` map) via an additive daemon control-
  message, OR a local store if we keep comments out of source-of-truth. Pins
  render on the canvas overlay (reuse the overlay layer), **follow their frame**
  when it moves, cluster when overlapping.
- Thread + replies + resolve, a comments list panel (left tab or right dock),
  unread dot on the comment toggle. Author = local profile (Guest) until P6 auth.
- Files: new `comments-store` + overlay pins in `packages/canvas`, a comments
  panel in `apps/studio`, additive control-message + canvas.json schema (spatial
  metadata — fits the One Rule), Comment tool wiring (FP-3).
- Accept: place a pin, reply, resolve; pin follows frame; list shows threads.
  Dogfooded. (Cross-device sync deferred to P6.)

### FP-6 — Export (raster now, code-native, SVG later)  [secondary]  → "export PNG/JPG/SVG"
- **PNG / JPG export** of a frame (and of a selected element's bounding region):
  rasterize the rendered iframe DOM to a canvas and download. Reuse/extend
  `screenshot-capture.ts` (or an html-to-image approach inside the iframe via
  the bridge, since cross-origin canvas capture of an iframe is restricted —
  the bridge running INSIDE the file-app can rasterize its own DOM and post the
  blob back). Scale options (1x/2x/3x), suffix.
- **Export section** in the Inspector (Penpot pattern: per-node export specs) +
  a quick "Export frame" action.
- **Code export** (the native code-first export): "Copy JSX" / "Open file" for a
  node/frame — arguably our most valuable export; cheap to add.
- **SVG export**: DEFER — serializing arbitrary rendered HTML to SVG is not
  straightforward (unlike Penpot's SVG-native tree). Note it; revisit if needed.
- Files: bridge (rasterize-self message), an export util + Inspector Export
  section, download helper.
- Accept: export a frame to PNG + JPG at chosen scale; copy JSX. Dogfooded.
  (SVG explicitly out for now.)

### FP-7 — Structure ops + keyboard parity  [secondary]  (much already exists)
- **Undo/redo**: exists (daemon ADR-0018) — ensure `Cmd+Z`/`Cmd+Shift+Z` wired
  in the studio + a visible affordance (right header).
- **Copy/paste/duplicate/delete** of elements: node-ops exist — wire to canvas
  selection + standard shortcuts.
- **One keyboard dispatch map** (spec §5.9 + features §1 table) for tools, zoom,
  nudge-not-applicable, undo, delete, etc. — a single `use-workspace-keymap`.
- **Group** = "wrap in container" (exists). **Align/distribute**, **rotate**,
  **rulers/guides**, **snapping of elements**, **flex/grid track editor**,
  **path/vector tools**, **boolean ops** → **[advanced] / out** (vector-only or
  large; revisit case-by-case).

---

## 3. Explicitly OUT (and why)

- **Resize handles + rotate on in-flow elements** — out (resize = edit w/h
  classes in the inspector; rotate = out). NOTE: free x/y drag is now **IN** for
  non-layout parents, and drag-to-reorder is IN for flex/grid parents — see
  D-EDIT (Figma auto-layout model).
- **Vector tools** (rect/ellipse/line/path/pen/curve), **boolean ops**, **masks**
  — we don't draw vectors; we edit JSX. (Consistent with ADR-0024.)
- **SVG export** — deferred (HTML→SVG serialization is hard); PNG/JPG + code now.
- **Multiplayer presence, async export progress, cross-file comment dashboard**
  — need the P6 backend; comments ship local-first now, sync later.
- **Flex/grid track editor, ruler guides, pixel-grid** — [advanced], later.

---

## 4. Sequencing + gating

Recommended order (each gated by a real-browser dogfood, committed, tagged):
**FP-1 → FP-2 → FP-3 → FP-4** (this quartet makes the tool *feel* like a working
editor: zoom/pan, resizable panes, no wasted top bar, working tools, real canvas
select + text edit) → **FP-6 export** → **FP-5 comments** → **FP-7 polish**.

FP-1..4 are the "it actually works like Penpot to use" milestone — I'd dogfood
and show you after FP-4, before doing comments/export.

Estimated: ~1 worker per FP, sequential (session-limit discipline). FP-4 (bridge
in-place text edit) and FP-5 (comments) are the two meatiest.

---

## 5. Decisions — RESOLVED (human, 2026-07-16)

- **D-EDIT** ✅ **Context-aware drag (Figma auto-layout):** flex/grid parent →
  drag re-sorts within layout (bound to layout rules); non-layout parent → drag
  is free (absolute positioning written to source). Resize-handles/rotate on
  in-flow elements stay out. (See §0 + FP-4.)
- **D-EXPORT** ✅ **PNG/JPG + copy-code now; SVG deferred.**
- **D-COMMENTS** ✅ **Local-first now** (pins/threads in canvas.json); cross-device
  sync when P6 lands.
- **D-ORDER** ✅ **Run FP-1 → FP-4, then dogfood + show the human**, before FP-5
  (comments) / FP-6 (export) / FP-7 (structure). FP-4 may split into FP-4a
  (select+text) → FP-4b (context-aware drag) given its size.
- **P6** remains parked until the human sees FP-1..4 working.

## 6. NEXT ACTION (when execution is authorized)
Start **FP-1** (canvas interaction unlock + zoom widget), sequential Sonnet
worker, no-git, gated by real-browser dogfood. Do NOT begin until the human says
go. This doc + the three scratchpad Penpot briefs are the alignment source.
