# Audit 04 — Canvas interaction model vs Penpot/Figma
> **Trust:** historical, dated 2026-09-23. Paths and line numbers were true at `560ddb0e`; re-read the code before acting on a finding. The plan built from it is `ROADMAP.md`.

Auditor: canvas-engineer (read-only). Date 2026-09-23. Branch `fix/studio-load-memo-cold-on-every-load`.
Penpot ground truth: `C:\Users\Admin\Documents\GitHub\penpot` (paths below are relative to
`frontend/src/app/main/` unless they start with `common/`).
Studio paths are relative to `src/admin/pages/site/` unless they start with `src/`, `docs/` or `spotlight/`
(= `src/admin/spotlight/`).

## 0. Executive summary

Studio's interaction layer is architecturally sound. It has one key dispatcher with a scope ladder,
a zero-React-commit drag session, Alt-duplicate, Cmd free-move, reflow preview, cross-frame transplant, OS file drop,
Alt measure, resize handles, and Space/middle/hand pan. **What it lacks is the second half of each gesture family.**
Penpot defines that half, and it maps onto a code-backed tree better than Figma's does:

1. **With an element selected, the arrow keys do nothing.** In Penpot, an arrow **reorders a layout child**
   and **nudges an absolute one** (`data/workspace/transforms.cljs:1047-1064`). The same mapping works on
   Studio's source: move a flow child with `moveNode`, and nudge an absolute child with `left`/`top`
   through the existing `canvasFreeMove` machinery.
2. **Tab / Shift+Tab do not cycle siblings.** Tab is swallowed inside the iframe
   (`canvas/useIframeEventForwarding.ts:257`).
3. **Shift+click on the canvas selects a tree-order RANGE**, not a toggle (`canvas/useCanvasNodeInteraction.ts:198`).
   On a canvas that selects elements the user never pointed at. Penpot and Figma both toggle.
4. **Cmd+A with an element selected falls through to the browser's select-all.** The only select-all scope
   stands down when a node is selected (`canvas/useBoardSelectAllShortcut.ts:26`). Penpot selects the siblings
   (`data/workspace/selection.cljs:281-309`).
5. **Resize has no modifiers and makes three wrong writes.**
   - No modifiers: Shift does not lock aspect and Alt does not resize from centre.
   - Bug: the resize ignores `box-sizing`, so a content-box element jumps by padding+border.
   - Bug: on a `flex:1` child it writes a `width` the flex algorithm ignores, so the handles track the cursor and then snap back.
   - Bug: on an absolute element the W/N handles grow the wrong way.
6. **Snapping is sibling-only and not zoom-aware.** It ignores parent edges and centres, ruler guides and
   equal spacing, and the threshold is a fixed 6 frame-px (Penpot uses `10 / zoom`, `main/snap.cljs:25,96-98`).
7. **Tools insert immediately at the selection and never at the pointer.** There is also no `V` key, and `T`
   does not start text editing. Penpot arms a tool, then click places it (100×100 default) or drag draws it.
   The shape is parented to the frame under the cursor, at the flex drop-index
   (`data/workspace/drawing/box.cljs:107-126`, `drawing/common.cljs:52-96`).
8. **There are no on-canvas padding/gap handles.** Penpot draws them on every selected flex board
   (`ui/flex_controls/{padding,gap,margin}.cljs`, wired in `ui/workspace/viewport.cljs:278-289,544-565`).
   Studio already paints the padding bands for Alt-measure, so the handles are one step away.
9. **Assets cannot be dragged onto the canvas.** Insertion is click-only (`panels/AssetsPanel/AssetCard.tsx:49`).
   The drag machinery (`useCanvasInsertionDrag`) already exists.
10. **Marquee works on the empty board only.** It cannot select elements inside a frame
    (`canvas/BoardFramesLayer/useMarqueeSelection.ts`).

The existing plans cover none of items 1–5 and 7–10. Item 6 is partly D1/K6. The feel plan (K1–K7) and
parity plan D2 closed the rest of the gesture surface; this audit is the backlog after them.

---

## 1. Shortcut parity matrix

Source: `data/workspace/shortcuts.cljs` (`base-shortcuts` + `opacity-shortcuts` + `data/workspace/text/shortcuts.cljs`).
Studio registry: `spotlight/keybindings.ts` + `spotlight/keybindingGestures.ts`.
Handlers: `canvas/useCanvas{NodeShortcuts,SelectionKeyboard,ToolShortcuts}.ts`, `canvas/useBoard*.ts`,
`hooks/useCanvas.ts:425-470` (zoom keys).

Legend: **✓** present · **~** partial / different key · **✗** missing · **N/A** does not map to a code-backed tool.
"Code?" = does it make sense when the document is `.tsx`?

### Edit
| Penpot id | Penpot key | Studio | Status | Code? / note |
|---|---|---|---|---|
| undo | ⌘Z | ⌘Z | ✓ | |
| redo | ⌘⇧Z, ⌘Y | ⌘⇧Z, ⌘Y | ✓ | |
| clear-undo | ⌥Q | — | ✗ | N/A — undo history is session-local already |
| copy | ⌘C | ⌘C | ✓ | |
| copy-link | ⇧⌥C | — | ✗ | Yes. Map to "copy source location" (`pages/Foo.tsx:42:7`). P2 |
| cut | ⌘X | ⌘X | ✓ | |
| paste | ⌘V | ⌘V (lands after the selection, K7) | ✓ | |
| paste-replace | ⌘⇧V | — | ✗ | Yes: replace the selection with the clipboard (a transplant + delete). P2 |
| copy-props | ⌘⌥C | — | ✗ | **Yes, high value**: copy the inline `style` bag + `className`. P1 |
| paste-props | ⌘⌥V | — | ✗ | **Yes**: paste the style/class onto the selection (N nodes). P1 |
| delete | Del/⌫ | Del/⌫/⌘⌫ | ✓ | |
| duplicate | ⌘D | ⌘D | ✓ | Penpot remembers the offset between repeated ⌘D (`selection.cljs:406-449`); Studio does not. P2, absolute elements only |
| start-editing | ↵ | ↵ = select FIRST child | ~ | Penpot/Figma: ↵ on a container selects ALL children, ↵ on text edits it (`data/workspace.cljs:891-929`). IX-7 |
| start/stop-measure | ⌥ (hold) | ⌥+hover | ~ | No parent-frame fallback, no size pill. IX-19 |
| escape | Esc | Esc (deselect ladder) | ✓ | With a selection, Esc does not disarm a latched tool (documented) |
| find | ⌘F | — | ✗ | Yes: layers search. The DOM panel has no search field. P2 |
| find-and-replace | ⌘H | — | ✗ | Yes: text content across the page. P2 |

### Modify layers
| Penpot id | Penpot key | Studio | Status | Code? / note |
|---|---|---|---|---|
| rename | ⌥N | ⌘R (Figma) | ~ | Keep ⌘R. Add ⌥N as an alias for Penpot hands. P2 S |
| group | ⌘G | ⌘G | ✓ | Writes `wrapJsxElements` |
| ungroup | ⇧G | ⌘⇧G (Figma) | ~ | Keep Figma's key. ⇧G is free. Alias P2 |
| mask / unmask | ⌘M / ⌘⇧M | — | N/A | Closest CSS is `overflow: clip` on a wrapper. Skip |
| create-component-variant | ⌘K | ⌘K = Spotlight | N/A (conflict) | Componentize is disabled (parity 0.4) |
| detach-component | ⌘⇧K | — | N/A | Later: "inline this component" |
| flip-vertical / horizontal | ⇧V / ⇧H | — | ✗ | Yes: `scale: 1 -1` / `-1 1` inline (the individual property, so an authored `transform` is untouched). P2 |
| bring-forward / backward | ⌘↑ / ⌘↓ | ⌘] ⌘[ and ⌥↑ ⌥↓ = index ∓ 1 | ~ | **Semantic divergence**: Studio "up" = earlier in the DOM = painted BELOW. That is right for flow order, wrong for overlapping absolute siblings. Document it. Add ⌘↑/⌘↓ aliases. IX-9 |
| bring-front / back | ⌘⇧↑ / ⌘⇧↓ | — | ✗ | Yes: `moveNode` to index 0 / last. P1 S. IX-9 |
| move-unit (1px) | ←↑→↓ (+⌥) | frames/notes only | ✗ for nodes | **P0**. IX-1 |
| move-fast (10px) | ⇧ + arrows | frames/notes only | ✗ for nodes | **P0**. IX-1 |
| artboard-selection | ⌘⌥G | ⌘G wraps in `<div>` | ~ | Equivalent result. Alias ⌘⌥G → group. P2 |
| toggle-layout-flex | ⇧A | — | ✗ | **Yes**: `display:flex` on a container; for N adjacent siblings, group then flex (Figma's ⇧A). P1. IX-10 |
| toggle-layout-grid | ⌘⇧A | — | ✗ | Yes: `display:grid`. P2 |
| opacity-0..9 | 0–9 | — | ✗ | Yes: inline `opacity` (1 = 10% … 0 = 100%). P2 S |

### Tools
| Penpot id | Penpot key | Studio | Status | Code? / note |
|---|---|---|---|---|
| move | V | — | ✗ | **P0 S**: `setCanvasTool('move')`, disarm comment / insert tools. IX-11 |
| draw-frame (board) | B, A | F = container INSIDE the selection | ~ | Figma F = frame. Studio "board" = page file. IX-13 |
| draw-rect | R | R = box BESIDE the selection, immediate | ~ | No pointer placement or draw gesture. IX-12 |
| draw-ellipse | E | O (Figma) | ~ | Add E as an alias. P2 S |
| draw-text | T | T = insert `base.text`, immediate | ~ | Does not start editing. Penpot T on a selected text starts editing (`shortcuts.cljs:306-310`). IX-12 |
| draw-path / curve | P / ⇧C | — | N/A | SVG path authoring is out of scope |
| draw-line / arrow | L / ⇧L | — | ✗ / N/A | L → `<hr>` possible. P2 |
| add-comment | C | C | ✓ | |
| toggle-comments-visibility | ⌘⇧C | ⌘⇧C = copy as PNG (Figma) | N/A (conflict) | Keep Figma's |
| insert-image | ⇧K | — | ✗ | **Yes**: file picker → the existing `asset-drop` pipeline → `<img>` beside the selection. P1 S |
| toggle-visibility | ⌘⇧H | ⌘⇧H | ✓ | |
| toggle-lock | ⌘⇧L | ⌘⇧L | ✓ | |
| toggle-lock-size (proportion) | ⇧L | — | ✗ | Yes: write `aspect-ratio` and have resize honour it. P2 |
| scale | K | K | ✓ | |
| open-color-picker (eyedropper) | I | — | ✗ | Yes (`EyeDropper` API). P2 |
| toggle-focus-mode | F | F = container | N/A (conflict) | Figma's F wins |

### Alignment
| Penpot id | Penpot key | Studio | Status | Code? / note |
|---|---|---|---|---|
| align-left/right/top/bottom/hcenter/vcenter | ⌥A ⌥D ⌥W ⌥S ⌥H ⌥V | Inspector buttons only (`inspector/sections/AlignSection.tsx`) | ~ | **Yes**: bind to `resolveAlignWrite` (flow child → `align-self`/`justify-self`; absolute → `left/right/top/bottom` against the parent). Frames: bulk align exists. P1 S. IX-20 |
| h/v-distribute | ⌘⇧⌥H / ⌘⇧⌥V | frames only (toolbar) | ~ | For flow children: `justify-content: space-between` on the parent. P2 |

### Main menu / view
| Penpot id | Penpot key | Studio | Status | Code? / note |
|---|---|---|---|---|
| toggle-rulers | ⌘⇧R | rulers always on | ✗ | P2 S |
| select-all | ⌘A | ⌘A = all FRAMES; **falls through to the browser with a node selected** | ~ / bug | **P0 S**. IX-4 |
| toggle-guides | ⌘' | — | ✗ | P2 S |
| toggle-alignment (dynamic snap) | ⌘\ | — | ✗ | P2 S. Figma: holding ⌘ disables snap, but Studio's ⌘-drag means free move — a conflict |
| thumbnail-set | ⇧T | — | N/A | |
| show-pixel-grid | ⇧, | — | ✗ | P2 |
| snap-pixel-grid | , | always rounds to integer px | ~ | Implicit; fine |
| export-shapes | ⌘⇧E | Inspector ExportSection only | ✗ | P2 S |
| toggle-snap-ruler-guide | ⌘⇧G | — (⌘⇧G = ungroup) | N/A (conflict) | |
| toggle-snap-guides | ⌘⇧' | — | ✗ | P2 |
| show-shortcuts | ? | ? | ✓ | |

### Panels
| Penpot id | Penpot key | Studio | Status |
|---|---|---|---|
| toggle-layers | ⌥L | F6 cycles focus only | ✗ (P2 S) |
| toggle-assets | ⌥I | — | ✗ (P2 S) |
| toggle-history | ⌘⌥H | — | N/A |
| color / text palette | ⌥P / ⌥T | — | N/A |
| hide-ui | \ | — | ✗ (P2 S; useful for dogfood screenshots) |

### Zoom
| Penpot id | Penpot key | Studio | Status | Note |
|---|---|---|---|---|
| increase-zoom | + = | + = | ~ | React `onKeyDown` on the canvas div (`hooks/useCanvas.ts:442`). **Dead once focus is in a panel.** Same class of bug `board-02`/`select-01` fixed. IX-15 |
| decrease-zoom | − _ | − | ~ | Same, and `_` is missing |
| reset-zoom (100%) | ⇧0 | ⌘0 | ~ | Add ⇧0 (Figma's key too). P1 S |
| fit-all | ⇧1 | ⇧1 | ~ | Focus-bound (same handler) |
| zoom-selected | ⇧2 | ⇧2 | ~ | Focus-bound |
| zoom-lens | Z / ⌥Z (+click, drag rect) | — | ✗ | P2. Also Space+⌘-drag = drag-zoom (`ui/workspace/viewport/actions.cljs:79-86`) |

### Navigation
| Penpot id | Penpot key | Studio | Status | Note |
|---|---|---|---|---|
| select-next / prev | Tab / ⇧Tab | Tab blocked in the iframe | ✗ | **P0 S**. IX-3 |
| select-parent-layer | ⇧↵ | ⇧↵ (anchor only) | ~ | Penpot maps EVERY selected node to its parent (`workspace.cljs:931-947`). P2 |
| open-viewer / inspect / comments / dashboard | g v / g i / g c / g d | — | ✗ | g d → Overview; g v → Live/Play. P2 |

### Shape / text / misc
| Penpot | Key | Studio | Status | Note |
|---|---|---|---|---|
| bool union/diff/intersect/exclude | ⌘⌥U/D/I/E | — | N/A | |
| toggle-theme | ⌥M | — | ✗ | P2 |
| plugins | ⌘⌥P | — | ✗ | P2 |
| bold / italic / underline / strike | ⌘B / ⌘I / ⌘U / ⌥⇧5 | — (⌘I = AI panel) | ✗ | Outside an edit: inline `font-weight`/`font-style`/`text-decoration` on text nodes. Inside an inline edit it is a markup change (`<strong>`), which is out of scope. P2 |
| font-size ± | ⌘⇧> / ⌘⇧< | — | ✗ | Inline `font-size` ± 1. P2 S |

### Studio-only bindings (keep)
⌘K Spotlight · ⌘S save · ⌘, settings · F6 panel focus · ⌘I AI · H hand tool · ⌥↑/⌥↓ reorder · ⌘⇧C copy PNG ·
⌘R rename · Space pan · and the gesture rows (⌥-drag copy, ⌘-drag free move, ⇧-drag axis lock, cross-frame drag,
file drop, reflow preview).

### Conflict register (decide once, write in `keybindings.ts` header)
| Key | Penpot meaning | Studio meaning | Recommendation |
|---|---|---|---|
| ⌘K | create component | Spotlight | Keep Spotlight |
| F | focus mode | container (Figma frame) | Keep Figma |
| ⌘⇧C | toggle comments | copy as PNG (Figma) | Keep Figma |
| ⌘⇧G | toggle snap to ruler guides | ungroup (Figma) | Keep Figma |
| ⌘I | italic | AI panel | Keep AI outside a text edit |
| ⌘-drag | marquee over shapes (`actions.cljs:111-112`) | free move (feel-plan §6 decision 6) | Keep free move; the in-frame marquee needs a different trigger (IX-16) |
| ⇧-click | toggle | range (layers-panel semantics) | **Change the canvas to toggle** (IX-2) |

---

## 2. Gesture-by-gesture audit

Each row gives: current behaviour (file:line), the gap vs Penpot (file), the fix, and the write it produces.

### 2.1 Moving elements — flow reorder vs free move
- **Current.** Pressing the body opens one session. `canvas/useCanvasBodyDragTrigger.ts` feeds it and
  `canvas/useCanvasReorderDrag.ts` runs it. It activates at `DRAG_ACTIVATE_PX = 4` (`canvas/canvasDragFrame.ts:197`)
  and commits in `canvas/canvasDragCommit.ts:84-107`. The decision (`canvas/canvasFreeMove.ts:184-257`):
  - An element that is `position: absolute|fixed` → free move, writing inline `left`/`top`
    (`inset-inline-start` in RTL).
  - A flow element with ⌘ held and a positioned parent → writes `position:absolute` + `left`/`top`.
  - A flow element with ⌘ held and a static parent → refuses, offering the `position-parent-relative` remedy.
  - Anything else → reorder or reparent through `moveNodes`.

  This is the correct code-backed analogue of Penpot's `start-move` (`transforms.cljs:668-876`). Penpot also
  resolves a target frame and a flex `drop-index` / grid `drop-cell` per move (`:752-761`).
- **Gaps.**
  - Free move always writes `left`+`top`. An element anchored by `right`/`bottom`, or centred with
    `translate(-50%)`, gets a second, conflicting inset. The box stretches, or the offset doubles.
    Penpot preserves constraints (`common/src/app/common/geom/shapes/constraints.cljc`). → **IX-21**
  - Multi-select free move is unsupported: the plan is per `draggedId`. → IX-22 (P2)
  - A grid drop resolves to a child INDEX, not a cell (`docs/reference/canvas-dnd.md` "Grid is a CSS-only
    heuristic"). Penpot's `get-drop-cell` (`transforms.cljs:651`) is the model. → IX-23 (P2)

### 2.2 Reparenting by drag, and drop indicators
- **Current.** The innermost candidate wins, with before/inside/after zones and zoom-aware edge bands
  (`canvas/canvasDnd.ts:182-201`). Refusals preview while the pointer is still down (G5). The reflow ghost is
  `canvas/canvasReflowPreview.ts`. The drop line, refused box and chip are painted by `canvas/canvasDragPainter.ts`.
  Cross-frame transplant is D2 G3.
- **Gap.** The axis is still a CSS heuristic for grid (`canvas/canvasDomGeometry.ts:339`). Penpot draws the
  target frame's outline while you move over it. Studio shows the "inside" dashed box only for the inside zone,
  so on a before/after line the destination *parent* is never outlined. That becomes ambiguous in nested flex
  rows. → **IX-24** (P1 S): during a drag, paint a faint parent outline for `target.parentId` from the same
  candidate index (zero reads).

### 2.3 Drag from the layers panel
- **Current.** Reordering inside the panel uses `@dnd-kit` (`panels/DomPanel/…`, `useDomPanelDnd.ts`).
  A panel-to-canvas drag is unsupported (`docs/reference/canvas-dnd.md` §"DOM panel ⇄ canvas parity").
- **Penpot.** Also panel-only. Not a parity gap. P2, and blocked on the D2 "one mechanism" decision
  (dnd-kit removal).

### 2.4 Drag from the Insert / Assets panel onto the canvas
- **Current.** Asset cards insert on click only (`panels/AssetsPanel/AssetCard.tsx:49`) at
  `resolveInsertLocation` (inside the selected container, else after it; `store/insertLocation.ts:74`).
  The notch primitives DO drag, via `canvas/useCanvasInsertionDrag.ts` + `canvasInsertionDrop.ts`
  (`resolveCanvasPointerInsertionDrop`). The doc names Assets-panel drag as follow-up DS-4b.
- **Penpot.** Assets drag onto the viewport lands at the cursor, inside the frame under it, at the flex
  drop-index (`ui/workspace/viewport/actions.cljs` on-drop; `drawing/box.cljs:107-126` for the same parenting
  rule).
- **Fix (IX-8, P1 M).** Wire `AssetCard` through `useCanvasInsertionDrag`. `onDrop(ghost, location)` →
  `insertInserterItem(item, location)`. Placement follows the cursor and the parent layout, because it uses the
  same resolver as a reorder drag. Holding ⌘ over a positioned parent could reuse K6 to also write
  `position:absolute; left; top` at the drop point (P2). The write is one `insert` structural edit, the same
  as click-insert. The refusal chip comes from the same `refusePlacement` preview.

### 2.5 Alt-drag duplicate
- **Current.** ✓ for elements (read live, one `duplicateJsxElement` destination write) and for frames
  (latched, a `boards.json` copy). See `docs/reference/canvas-dnd.md` §K2. Matches Penpot's
  `start-move-duplicate` (`transforms.cljs:635`, `:797-876`).
- **Gap.** None material.

### 2.6 Shift constrain axis
- **Current.** ✓ `constrainToDragAxis` (`canvas/canvasDragSession.ts:206-212`), applied to both reorder and
  free move (`canvas/canvasDragFrame.ts:227`).
- **Penpot.** Also sets `snap-ignore-axis` so the locked axis does not snap (`transforms.cljs:775-790`).
- **Gap (P2 S).** Free-move snapping still snaps the locked axis. Pass the lock into `stepFreeMove` and skip
  that axis in `computeSnap`.

### 2.7 Arrow nudge (1 / 10 px)
- **Current.** Frames and notes only (`canvas/useBoardFrameNudge.ts:44-58`; `spotlight/keybindings.ts:501-510`).
  With a node selected the arrows are **unclaimed by design**, reserved "for a future select sibling"
  (`keybindings.ts:230-235`; `canvas-internals.md` §K1).
- **Penpot** (`transforms.cljs:1047-1064`): `move-selected` →
  - every selected shape is a layout child and not absolute → `reorder-selected-layout-child`
    (`:883-975`). Flex: index ±1, `reverse?`-aware. Grid: swap with the neighbour cell.
  - otherwise → `nudge-selected-shapes` (1 / big = 10, user-configurable; `ui/workspace/nudge.cljs`).
- **Fix (IX-1, P0 M).** Add a new `node`-rung handler, `useCanvasNodeNudge`:
  - **Flow child** (computed `position` is not absolute/fixed): an arrow ON the parent axis (from
    `resolveCanvasAxisFromStyle`, reversed-aware) → `moveNode(id, parent, idx ∓ 1)`. This is the existing
    `runMoveShortcut` (`canvas/useCanvasNodeShortcuts.ts:54-71`) generalised to four directions. A cross-axis
    arrow in a block/flex parent does nothing. In a grid it can move by the measured column count (P2).
    Multi-select: group by parent and move each run (Penpot `move-flex-children`, `:905-915`).
    Write: one `move` structural edit (`moveJsxElement` reorder form).
  - **Absolute/fixed child**: step `left`/`top` (or `inset-inline-start`, negated in RTL) by 1, or 10 with ⇧.
    Reuse `planFreeMoveProperties` + `readFreeMoveBase` (`canvasFreeMove.ts:148,269`), never `needsAbsolute`.
    Write: `setNodeInlineStyles(id, { left, top })` → one `style` edit.
    **Coalesce a key-hold into one undo entry and one source write.** Use the ScrubInput live-commit path,
    closed on keyup through the dispatcher's `handleKeyUp` broadcast (the pattern `useBoardFrameNudge` uses
    with `endBoardGesture`). Parity 0.3 (undo flooding) applies if you skip this.
  - Keep ⌥↑/⌥↓ and ⌘[/⌘]. Tab/⇧Tab (IX-3), not the arrows, take over "select sibling", so the reservation in
    `keybindings.ts` is released. Update that comment and `canvas-internals.md` §K1.
  - The guards are the ones already in place: `inline-edit` rung, `isTextInputTarget`, `isInsideKeyOwningOverlay`.

### 2.8 Snapping
- **Current.**
  - Free move snaps to SIBLINGS only (`canvasFreeMove.ts:227-240`) at a fixed `FREE_MOVE_SNAP_PX = 6`
    frame-px (`:72`).
  - Board furniture snaps to peers plus ruler guides (`boardSnapping.ts:149`) at a fixed
    `SNAP_THRESHOLD_BOARD_UNITS = 8` (`:80`).
  - One snap per axis, closest wins. There is no resize snapping and no drawing snapping.
- **Penpot.**
  - `snap-accuracy 10`, `snap-distance-accuracy 20`, both divided by zoom (`main/snap.cljs:25-27,96-98,146`).
  - Snap points: parent frame edges and centres, siblings, guides, layout grids.
  - Equal-distance (spacing) snapping, drawn as pink distance segments (`ui/workspace/viewport/snap_distances.cljs`).
  - Snap is applied to move, resize (`transforms.cljs:303`) and draw (`drawing/box.cljs:135-150`).
  - The pixel grid is `gpt/round-step 1`.
- **Fixes.**
  - **IX-5a (P1 S)**: make both thresholds screen-space (`px / zoom`). A fixed frame-px threshold is
    effectively 24 screen px at 400% zoom and 1.5 px at 25%.
  - **IX-5b (P1 S)**: add the parent content-box rect (edges and centre) as a snap peer in `resolveFreeMove`.
    It is already in the candidate index, so this costs zero reads.
  - **IX-5c (P2 M)**: element free move snaps to ruler guides. Guides are board space; convert through the
    frame's board origin, which `canvasDragBoard.ts` already measures.
  - **IX-5d (P2 M)**: equal-spacing snap and distance pills (port `snap_distances.cljs`'s segment algorithm
    over the candidate index).
  - **IX-5e (P2 S)**: snap toggles (⌘' / ⌘⇧') in the view menu.

### 2.9 Smart guides and measure-on-hover (Alt)
- **Current.** ✓ K5 `canvas/MeasureLayer.tsx`: distances selection → hovered, plus the hovered node's
  padding bands. It needs a hovered node other than the selection (`MeasureLayer.tsx:326-327`), and it runs
  one `adapter.measure` per rAF for as long as Alt is held (`:349-362`).
- **Penpot** (`ui/measurements.cljs:358-386`): with no hover, or when hovering the selection itself, it measures
  selection → **parent frame**. It always draws the selection's W×H `size-display`, plus a permanent
  `selection-size-badge` (`viewport.cljs:512`).
- **Fixes.**
  - **IX-19 (P1 S)**: fall back to the parent: when `hovered` is null or selected, measure against
    `getParent(tree, anchor)`.
  - **IX-18 (P1 S)**: a W×H size badge under the selection ring. Paint it in the same pass as the node badge
    (`canvasSelectionOverlayPositioning.ts:397` `positionNodeBadge`), rounded, in frame px. It must also update
    live during resize and free move, since they share the same ring measurement.
  - Perf (P2 S): stop the measure loop re-issuing while neither the pointer nor the layout moved (key it on
    `hoveredNodeId` + the overlay MutationObserver tick).

### 2.10 Resize handles
- **Current.**
  - Eight handles (`canvas/CanvasResizeHandles.tsx`), a size-only model (`canvas/elementResize.ts`), a
    preview-then-commit drag (`canvas/useElementResizeDrag.ts:100-200`) and the `resizeOffer.ts` policy.
  - Proportional only with the K tool, latched at pointerdown (`CanvasResizeHandles.tsx:76`).
  - The write is `setNodeInlineStyles(id, { width?, height? })` (`useElementResizeDrag.ts:175`).
  - Single selection only.
- **Penpot** (`transforms.cljs:151-335`): Shift OR the shape's `:proportion-lock` → keep ratio; Alt → from the
  centre (`normalize-proportion-lock`, `:266-271`). A layout child's sizing flips to `:fix` on resize
  (`:246-254`). Snapping applies (`:303`). Multi-select resize scales the group.
- **Gaps / fixes.**
  - **IX-6a (P0 S) — box-sizing bug.** The start size is `getBoundingClientRect()`, which is the border box
    (`useElementResizeDrag.ts:100-101`). It is written as `width` with no `box-sizing` check (a grep finds no
    `boxSizing` in the resize path). On a `content-box` element the first preview frame, and the commit, grow
    the element by padding + border. Subtract them when the computed `box-sizing` is `content-box`. Note this
    in Landmines: "resize writes the CSS width, not the rect width".
  - **IX-6b (P0 M) — flex/grid children.** On the main axis of a `flex: 1` or `flex-grow` child, `width` is
    overridden by flex-grow. The handles track the cursor and then snap back, which is exactly the failure
    `resizeOffer.ts` exists to prevent. Route the commit through `elementSizing.ts`'s `sizingPatch('fixed')`
    with the same `sizingAxisRole` (`panels/PropertiesPanel/elementSizing.ts:140,227`). That also clears
    `flex`/`flex-grow` and `align-self: stretch` as needed. This is Penpot's `layout-item-h-sizing → :fix`.
    The preview must apply the same patch or it lies for the whole drag.
  - **IX-6c (P0 S) — modifiers.** Read `shiftKey` live per move, and OR it with the K tool:
    `proportional = scaleTool || e.shiftKey`. Alt means resize from the centre, so the delta doubles on each
    owned axis. For an absolute element, also shift `left`/`top` by −delta/2. Write: the same `{ width, height }`
    patch, plus `left`/`top` for absolute elements.
  - **IX-6d (P1 S) — absolute elements, W/N handles.** Today the west handle grows the element to the right,
    because `left` is fixed. When `isPositionedFreely`, the W/N handles must also write `left`/`top` so the
    opposite edge stays put (Penpot's `get-handler-resize-origin`, `transforms.cljs:68`).
  - **IX-6e (P1 M)**: snap the moving edge to sibling and parent edges (the same `computeSnap` on one edge).
  - **IX-6f (P2 S)**: double-clicking an edge handle sets Hug on that axis (`sizingPatch('hug')`) — Figma's gesture.
  - **IX-6g (P2 L)**: multi-select resize.
  - `min-width`/`max-width` clamps let the preview detach from the cursor. Clamp the preview to computed
    min/max (P2 S).

### 2.11 Rotation
- **Current.** None (parity plan D3: "rotation is the one clean, low-risk gap").
- **Penpot.** `start-rotate` (`transforms.cljs:485-553`): the angle around the centre; ⇧ snaps to 15°, ⌘ to 45°.
- **Fix (IX-25, P2 M).** A rotate cursor zone just outside each corner handle, rendered by the same portal as
  the handles. Preview with the individual `rotate` property. Write `setNodeInlineStyles({ rotate: 'Ndeg' })`
  — the CSS `rotate` property, NOT `transform`, so an authored transform survives. Rings stay AABB (what
  `getBoundingClientRect` gives). Refuse elements whose `resizeOffer` refuses.

### 2.12 Multi-select marquee
- **Current.** Board-level marquee for frames and annotations only
  (`canvas/BoardFramesLayer/useMarqueeSelection.ts:186-268`). Inside a frame every pixel is a node, so a drag
  becomes a move.
- **Penpot.** A pointerdown on empty space, OR with ⌘ held, starts `handle-area-selection`
  (`ui/workspace/viewport/actions.cljs:111-112`; `data/workspace/selection.cljs:59-127`). ⇧ adds, ⇧⌘ removes.
  Space held while dragging moves the rect. Results are recomputed every 100 ms.
- **Fix (IX-16, P1 M).** An in-frame marquee is armed when the press lands on the frame's ROOT node
  (body/page root) itself, i.e. no child element under the pointer. That is the code-backed equivalent of
  Penpot's "no id" branch. ⌘ stays with free move (conflict register).
  - It selects the root's descendants whose frame-space rects intersect the marquee, limited to the shallowest
    level that has any hit. With ⌥ held it selects the deepest.
  - Use the drag session's candidate index, which costs zero extra reads.
  - Paint in the frame's drag layer.
  - Write: selection only.

### 2.13 Select inside (double-click / ⌘-click deep select)
- **Current.** A click selects the INNERMOST node under the pointer (`canvas/NodeRenderer.tsx:442-464`,
  `isClosestCanvasNodeTarget`). Double-click starts an inline text edit only
  (`canvas/useCanvasNodeInteraction.ts:263-276`). There is an Alt-hold tree ladder to pick ancestors.
- **Penpot.** Boards are transparent to hover and click, so the deepest non-group shape wins; groups are
  opaque (`ui/workspace/viewport/hooks.cljs:294-348`). ⌘ deep-selects into groups. Double-click on a selected
  parent selects the child under the cursor, and double-click on a grid enters grid edit
  (`actions.cljs:198-247`). A "Select layer" context submenu lists every shape under the pointer.
- **Assessment.** Studio has no group objects (⌘G makes a `<div>`, and every `<div>` is a board), so
  innermost-wins **is** Penpot's behaviour. ⌘-click is taken by toggle, and toggle belongs on ⇧ (IX-2).
  Once IX-2 lands, ⌘-click is free for deep select, but it is a no-op under innermost-wins, so leave it as an
  alias of toggle. Gap: the context menu has no "select layer under pointer" list; the Alt ladder covers
  ancestors only. **IX-26 (P2 S)**: add a submenu of `elementsFromPoint` node ids.

### 2.14 Enter / Shift+Enter tree navigation
- **Current.** ↵ selects the FIRST child (`store/slices/selectionTraversalActions.ts:53-64`). ⇧↵ selects the
  anchor's parent (`:38-51`). ↵ on an instance steps in.
- **Penpot** (`data/workspace.cljs:891-947`): ↵ on text/path starts edit mode; ↵ on group/board selects ALL
  children; ↵ on N shapes selects all their children. ⇧↵ maps every selected node to its parent.
- **Fix (IX-7, P1 S).**
  - ↵ on a node whose module has `inlineTextEdit` → `startInlineEdit` (the double-click path).
  - ↵ on a container → `selectMany(children)`.
  - ⇧↵ → parents of every selected node, de-duplicated.
  - Rename the action `selectChildren`. Update spotlight `layers.selectFirstChild` and the `?` sheet label.

### 2.15 Tab sibling cycling
- **Current.** ✗. Tab is blocked inside the iframe (`useIframeEventForwarding.ts:257-261`). In the parent
  document it walks panel focus.
- **Penpot** (`selection.cljs:164-216`): Tab / ⇧Tab select the next / previous sibling, wrapping, single
  selection; with N selected they collapse to the first.
- **Fix (IX-3, P0 S).** Add a `node`-rung binding `layers.selectNextSibling` / `layers.selectPrevSibling`
  (Tab / ⇧Tab).
  - Active only when a node is selected AND the event target is the canvas, the iframe, or `body`. It must
    NEVER be active inside a panel, or Tab loses its a11y role in the inspector.
  - Order is source order (visual order in flow), wrapping.
  - Change the iframe bridge to forward Tab as a clone instead of dropping it. It still `preventDefault`s
    inside the frame.
  - Note for Landmines: this is a new events×keyboard interaction.

### 2.16 Hover outlines
- **Current.** ✓ `data-hovered` on the node, plus the in-frame hover ring. It is suppressed in play mode.
- **Gap.** Penpot does not hover-outline the parents of the current selection (`hooks.cljs:299-300,350-351`).
  In Studio, moving across a selected child's parent padding re-rings the parent. That is minor, but with
  innermost-click it is correct. No action.

### 2.17 Auto-layout gap / padding handles on canvas
- **Current.** ✗ (grep finds no gap or padding handle). K5 already paints padding bands on Alt.
- **Penpot** (`ui/flex_controls/padding.cljs`, `gap.cljs`, `margin.cljs`; `viewport.cljs:278-289,544-565`):
  - Shown for a single selected flex board with no transform in flight.
  - Hovering a band highlights it; dragging changes the value.
  - ⇧ applies to both sides of the axis (`padding.cljs:166-167`) and ⌥ applies to all four.
  - Margins show for a flex child.
- **Fix (IX-17, P1 L).** An in-frame overlay component in `BreakpointSelectionOverlay`, beside the resize
  handles.
  - Show it when the selection's computed `display` is flex/grid (padding) and there are ≥ 2 children (gap).
  - Geometry comes from the one `adapter.measure` pass: padding-*, row/column-gap, child rects.
  - Drag writes `setNodeInlineStyles({ paddingTop | … | gap | rowGap | columnGap })`. ⇧ writes the axis pair,
    ⌥ writes all four.
  - Preview on the element's own style, as resize does, and freeze through `beginCanvasGesture`.
  - Refuse where `canWriteInlineStyleForModule` refuses. Refuse a class-owned padding the inline write would
    shadow unless the inspector would also write inline — use the inspector's own write-target resolver so the
    two surfaces agree.

### 2.18 Frame / board creation tool
- **Current.** A new board frame goes through `canvas/BoardFramesLayer/AddPagePicker.tsx`
  (`createStudioPage`, server-placed). There is no draw gesture. `F` inserts a `base.container` inside the
  selection (`useCanvasToolShortcuts.ts:132`).
- **Penpot.** B/A arms `:frame`. Drawing on the empty canvas makes a root board; drawing inside a board makes a
  nested board. Drawing around existing shapes adopts them (`drawing/common.cljs:82-96`).
- **Fix (IX-13, P2 M).**
  - B arms a board tool. Drag on the EMPTY board → `AddPagePicker` at the pointer, and the created frame takes
    the drawn x/y/width (width → a breakpoint preset if one is within a few px).
  - Inside a frame B behaves like the F container tool (IX-12).
  - Write: a new page file plus a `boards.json` frame.

### 2.19 Rectangle / ellipse / text tools (R / O / T)
- **Current.** Immediate insert: R/O put a container BESIDE the selection (`useCanvasToolShortcuts.ts:348-365`),
  T/F put text/container INSIDE it (`:339-346`). No pointer placement, no draw gesture. T does not open an edit.
  There is no V key.
- **Penpot** (`drawing/box.cljs:92-153`, `drawing/common.cljs:40-98`):
  - Arm a tool. The cursor becomes a crosshair.
  - Press → the parent is the top nested frame at the point; the index is the flex drop-index there.
  - Drag → size from the drag. ⇧ gives a square; ⌘ (`mod?`) draws from the centre.
  - A click without a drag gives 100×100 centred on the point. Text starts editing immediately.
  - Snap applies throughout. After the draw, the tool returns to move.
- **Fix (IX-12, P1 L).**
  - `canvasTool` gains `'insert'` with a module id.
  - Hover paints the SAME drop line as insertion drag (`resolveCanvasPointerInsertionDrop`), so the user sees
    where it will land before pressing.
  - Click → `insertNode(parent, index)` at the point. This is a flow insert: position comes from layout. That
    is honest and matches parity §15.3.
  - Drag → the same insert plus inline `width`/`height` from the drag, snapped. Inside a positioned parent with
    ⌘ it also writes `position:absolute; left; top` (reusing K6's plan).
  - T → start the inline edit on the created node once the resync lands. `pendingCreatedSelection.ts`
    (store-13) is the hook.
  - Pressing the key again, V, or Esc disarms. Keep the current "insert at selection" behaviour on ⏎ while the
    tool is armed, so keyboard-only users are not stranded.
  - Writes: one structural `insert`, optionally with `style` props (the same channel `O`'s `borderRadius` uses).
  - Needs an owner decision: armed tools (Penpot/Figma) or immediate insert (current). Recommend armed; the
    `keybindings.ts:426-431` comment argues against it only because "there is no rectangle to draw", and the
    size-from-drag write answers that.
- **IX-11 (P0 S)**: bind V → `setCanvasTool('move')`, and also disarm comment and insert tools.

### 2.20 Pan / zoom gestures
- **Current.** ✓ wheel pan, ⇧-wheel horizontal, ⌘/Ctrl-wheel zoom, pinch, Space-drag (parent and iframe),
  middle drag, H tool (`hooks/useCanvas.ts:560-640`; `canvas/canvasPanInput.ts`). ✓ ⇧1 / ⇧2 / ⌘0. Auto-pan
  during drag.
- **Gaps.**
  - **IX-15 (P1 S)**: +/−/⇧1/⇧2 are a React `onKeyDown` on the canvas div (`hooks/useCanvas.ts:425-470`), dead
    after a click into any panel. Move them to the dispatcher's `global` rung.
  - Two raw `document` keydown listeners (Space, ⌘0; `useCanvas.ts:359,391`) live outside the dispatcher
    because the gate only scans `canvas/`. Fold them in and widen `keybindings-single-dispatcher.test.ts` to
    `hooks/`.
  - Add ⇧0 and `_`.
  - Z lens and Space+⌘-drag zoom (P2 M).

### 2.21 Selection model details
- **IX-2 (P0 S)**: ⇧-click on the canvas = toggle, ⌘-click = toggle (alias).
  - Range stays a layers-panel gesture (Penpot's `shift-select-shapes`/`expand-region-selection` is panel-only;
    canvas `select-shape id shift?` toggles; `actions.cljs:187`).
  - Change: `mode = e.shiftKey || e.metaKey || e.ctrlKey ? 'toggle' : 'replace'` in
    `useCanvasNodeInteraction.ts:198`.
  - The DOM panel keeps `range`.
- **IX-4 (P0 S)**: ⌘A with a node selected selects the anchor's siblings (Penpot `select-all`,
  `selection.cljs:281-309`: parent of the selection, not hidden, not blocked).
  - Pressing it again with all siblings selected climbs one level (Figma).
  - Add a `node`-rung branch that `preventDefault`s. Today the keystroke reaches the browser and highlights
    admin text.
- **IX-27 (P2 S)**: the context menu lacks bring to front/back, add/remove flex, copy CSS, and select layer.
  Penpot's list is in `ui/workspace/context_menu.cljs`.

---

## 3. Gap register

| id | P | file:line (Studio) | Penpot reference | Fix and the write it produces | Effort | Owner | Existing plan coverage |
|---|---|---|---|---|---|---|---|
| IX-1 | P0 | `canvas/useCanvasNodeShortcuts.ts:54-71`; `spotlight/keybindings.ts:230-235,501-510` | `data/workspace/transforms.cljs:883-1064` | Arrows: a flow child reorders along the parent axis (`moveNode` → `move` edit); an absolute child nudges `left`/`top` by 1/10 (`style` edit, coalesced per key-hold) | M | canvas-engineer (+store-engineer for coalescing) | None. The feel plan explicitly left arrows unclaimed |
| IX-2 | P0 | `canvas/useCanvasNodeInteraction.ts:198` | `ui/workspace/viewport/actions.cljs:182-187`; `data/workspace/selection.cljs:129,231` | ⇧-click toggles on the canvas; range stays in the DOM panel. Selection only | S | canvas-engineer | None |
| IX-3 | P0 | `canvas/useIframeEventForwarding.ts:257-261` | `selection.cljs:164-216`; `shortcuts.cljs:581-589` | Tab/⇧Tab: next/previous sibling, wrapping, canvas-scoped only. Selection only | S | canvas-engineer | None |
| IX-4 | P0 | `canvas/useBoardSelectAllShortcut.ts:26` | `selection.cljs:281-309` | ⌘A with a node selected → siblings; again → climb. Selection only. Stops the browser select-all leak | S | canvas-engineer | None (board-02 fixed frames only) |
| IX-6a | P0 | `canvas/useElementResizeDrag.ts:100-101,136,175` | n/a (CSS correctness) | Convert the border-box rect to the CSS `width`/`height` per `box-sizing` before preview and commit | S | canvas-engineer | None |
| IX-6b | P0 | `canvas/elementResize.ts`; `useElementResizeDrag.ts:174` | `transforms.cljs:246-254` | Resizing a flex/grid child → `sizingPatch('fixed')` from `elementSizing.ts` (width plus clearing `flex`/`align-self` as needed) | M | canvas-engineer + panel-designer (shared resolver) | None |
| IX-6c | P0 | `canvas/CanvasResizeHandles.tsx:76`; `elementResize.ts:95-120` | `transforms.cljs:266-271` | ⇧ keeps aspect (live, ORed with K); ⌥ resizes from centre (±delta/2, plus `left`/`top` for absolute elements) | S | canvas-engineer | K4 did the K tool only |
| IX-11 | P0 | `spotlight/keybindings.ts` (no `v`) | `shortcuts.cljs:291-294` | V → move tool, disarms every tool | S | canvas-engineer | None |
| IX-5a | P1 | `canvas/canvasFreeMove.ts:72`; `canvas/boardSnapping.ts:80` | `main/snap.cljs:25-27,96-98` | Snap thresholds in screen px ÷ zoom | S | canvas-engineer | None |
| IX-5b | P1 | `canvas/canvasFreeMove.ts:227-240` | `main/snap.cljs:83-94` (frame snap points) | Add the parent content box (edges and centre) as a snap peer | S | canvas-engineer | K6 was siblings only |
| IX-6d | P1 | `canvas/elementResize.ts` (size-only by design) | `transforms.cljs:68-94` | Absolute elements: the W/N handles also write `left`/`top` so the opposite edge stays fixed | S | canvas-engineer | None |
| IX-6e | P1 | `canvas/useElementResizeDrag.ts:139-150` | `transforms.cljs:296-305` | Snap the moving edge (`computeSnap` on one edge) | M | canvas-engineer | None |
| IX-7 | P1 | `store/slices/selectionTraversalActions.ts:53-64`; `canvas/useCanvasSelectionKeyboard.ts:115` | `data/workspace.cljs:891-947` | ↵: text → inline edit; container → all children; ⇧↵ → parents of all selected | S | canvas-engineer + store-engineer | viewport-01 shipped the first-child variant |
| IX-8 | P1 | `panels/AssetsPanel/AssetCard.tsx:49` | `ui/workspace/viewport/actions.cljs` (on-drop) | Drag Assets → canvas through `useCanvasInsertionDrag`; lands at the cursor at the flow index; one `insert` edit | M | canvas-engineer + panel-designer | canvas-dnd.md "DS-4b follow-up" |
| IX-9 | P1 | `spotlight/keybindings.ts:249-273` | `shortcuts.cljs:206-224` | ⌘⇧]/⌘⇧↑ bring to front (last index), ⌘⇧[/⌘⇧↓ send to back; ⌘↑/⌘↓ aliases; document the z-order vs flow-order meaning | S | canvas-engineer | K4 did ±1 only |
| IX-10 | P1 | — | `shortcuts.cljs:271-283`; `data/workspace/shape_layout.cljs` | ⇧A: container → `display:flex` (inline or class via the inspector's write-target); N adjacent siblings → group then flex | M | canvas-engineer + parser-surgeon | None |
| IX-12 | P1 | `canvas/useCanvasToolShortcuts.ts:271-365` | `data/workspace/drawing/box.cljs:92-153`; `drawing/common.cljs:40-98` | Armed R/O/F/T/E tools: hover preview, click inserts at the pointer's flow index, drag also writes `width`/`height`, T opens edit | L | canvas-engineer + store-engineer | K4 chose immediate insert; needs owner decision |
| IX-15 | P1 | `hooks/useCanvas.ts:359-470` | `ui/workspace/viewport/hooks.cljs:170-177` | Zoom keys onto the dispatcher `global` rung; add ⇧0, `_`; widen the single-dispatcher gate to `hooks/` | S | canvas-engineer | K1 left it (documented third path) |
| IX-16 | P1 | `canvas/BoardFramesLayer/useMarqueeSelection.ts:186` | `selection.cljs:59-127`; `actions.cljs:111-112` | In-frame marquee from a press on the frame root; intersect over the candidate index; ⇧ adds | M | canvas-engineer | Parity D3 says marquee is "present" (board-only) |
| IX-17 | P1 | — (K5 paints bands in `MeasureLayer.tsx`) | `ui/flex_controls/{padding,gap,margin}.cljs`; `viewport.cljs:278-289,544-565` | On-canvas padding/gap handles; drag writes `padding*`/`gap` (⇧ axis pair, ⌥ all four) through the inspector's write-target | L | canvas-engineer + panel-designer | None |
| IX-18 | P1 | `canvas/canvasSelectionOverlayPositioning.ts:397` | `ui/measurements.cljs:103-128,207`; `viewport.cljs:512` | W×H size badge under the selection, live during resize and free move | S | canvas-engineer | None |
| IX-19 | P1 | `canvas/MeasureLayer.tsx:326-327` | `ui/measurements.cljs:370-381` | Alt with no or self hover measures selection → parent | S | canvas-engineer | K5 left it |
| IX-20 | P1 | `inspector/sections/AlignSection.tsx` | `shortcuts.cljs:380-418` | ⌥A/D/W/S/H/V → `resolveAlignWrite`; absolute → insets | S | canvas-engineer + panel-designer | None |
| IX-21 | P1 | `canvas/canvasFreeMove.ts:148-180,342-350` | `common/src/app/common/geom/shapes/constraints.cljc` | Free move keeps the anchoring: an element anchored by `right`/`bottom` writes those; a `translate(-50%)` centring is refused or adjusted | M | canvas-engineer | None |
| IX-24 | P1 | `canvas/canvasDragPainter.ts` | `transforms.cljs:752-761` (target frame highlight) | Outline `target.parentId` during a before/after drop | S | canvas-engineer | None |
| IX-props | P1 | `spotlight/keybindings.ts` | `shortcuts.cljs:113-121` | ⌘⌥C / ⌘⌥V copy and paste style (inline bag + className) onto N nodes | M | store-engineer + canvas-engineer | None |
| IX-img | P1 | — | `shortcuts.cljs:343-346` | ⇧K file picker → `asset-drop` → `<img>` beside the selection | S | canvas-engineer | G15 did the drop path only |
| IX-5c | P2 | `canvas/boardSnapping.ts:149` | `main/snap.cljs` (guides) | Element free move snaps to ruler guides | M | canvas-engineer | Parity D1 (guides exist; elements do not use them) |
| IX-5d | P2 | — | `ui/workspace/viewport/snap_distances.cljs`; `snap.cljs:145-250` | Equal-spacing snap plus distance pills | M | canvas-engineer | None |
| IX-5e | P2 | — | `shortcuts.cljs:432-475` | Snap / guide / ruler toggles | S | canvas-engineer | None |
| IX-6f | P2 | — | Figma only | Double-clicking an edge handle → Hug | S | canvas-engineer | None |
| IX-6g | P2 | `CanvasResizeHandles.tsx:34` | `transforms.cljs:151` (group resize) | Multi-select resize | L | canvas-engineer | None |
| IX-13 | P2 | `canvas/BoardFramesLayer/AddPagePicker.tsx` | `shortcuts.cljs:286-289`; `drawing/common.cljs:82-96` | B draws a board: picker at the pointer, frame takes the drawn rect | M | canvas-engineer + server-engineer | None |
| IX-22 | P2 | `canvas/canvasFreeMove.ts:184` | `transforms.cljs:668` | Multi-select free move | M | canvas-engineer | None |
| IX-23 | P2 | `canvas/canvasDomGeometry.ts:339` | `transforms.cljs:651-660` | Grid drops to a cell (write `grid-column`/`grid-row`) or at least a rect-derived axis | M | canvas-engineer + parser-surgeon | canvas-dnd.md names it |
| IX-25 | P2 | — | `transforms.cljs:485-553` | Rotation handles; `rotate:` inline; ⇧ 15° | M | canvas-engineer | Parity D3 names it |
| IX-26 | P2 | `panels/DomPanel/LayerNodeContextMenu.tsx` | `ui/workspace/context_menu.cljs` (select-layer) | "Select layer" submenu from `elementsFromPoint` | S | canvas-engineer | None |
| IX-27 | P2 | `panels/DomPanel/LayerNodeContextMenu.tsx` | `ui/workspace/context_menu.cljs` | Context menu gains front/back, add/remove flex, copy CSS, lock | S | panel-designer | None |
| IX-misc | P2 | `spotlight/keybindings.ts` | `shortcuts.cljs` passim | Opacity 0–9, flip ⇧H/⇧V, E/⌥N/⇧G aliases, ⌘⇧E export, \ hide UI, ⌥L/⌥I panels, g-d/g-v, Z lens, font-size/bold keys, ⇧Enter on multi-select, ⌘D offset memory for absolute elements | S each | canvas-engineer | None |

---

## 4. Suggested order

1. **Wave A — "hands" (P0, all S except IX-1/6b; one PR each, disjoint files):**
   - IX-2 (`useCanvasNodeInteraction`)
   - IX-3 + IX-4 + IX-11 (`keybindings.ts` plus new node-rung handlers; the iframe Tab bridge)
   - IX-6a + IX-6c (resize)
   - IX-1 (new `useCanvasNodeNudge.ts`; coalescing with store-engineer)
   - IX-6b (resize × `elementSizing.ts`)
   - IX-15 (dispatcher)

   `keybindings.ts` is the collision point: serialise the three PRs that touch it, or have one agent own it.
2. **Wave B — "precision" (P1 S/M):** IX-5a/5b, IX-6d/6e, IX-18, IX-19, IX-7, IX-9, IX-20, IX-24, IX-img,
   IX-props, IX-21.
3. **Wave C — "Figma-grade tools" (P1 L, needs owner decisions):**
   - IX-12: armed insert tools vs immediate insert.
   - IX-16: the in-frame marquee trigger.
   - IX-17: on-canvas padding/gap handles.
   - IX-8: Assets drag.
   - IX-10: ⇧A.
4. **Wave D — P2 backlog.**

## 5. Landmines this audit found (for the handoff, not yet in STATE.md)
- **Resize × box-sizing (IX-6a).** `getBoundingClientRect` is the border box and CSS `width` is not (unless
  `border-box`). Any gesture that measures a rect and writes a size must convert.
- **Resize × flex (IX-6b).** A `width` on a flex-grow child is a dead write. `resizeOffer.ts` does not model it,
  so today the handles are offered and then snap back — the exact failure that file names.
- **Keyboard × focus.** `hooks/useCanvas.ts` still carries three key paths outside the dispatcher: the Space and
  ⌘0 `document` listeners, and the React `onKeyDown` for +/−/⇧1/⇧2. `keybindings-single-dispatcher.test.ts`
  scans `canvas/` only, so they pass the gate unseen.
- **Events × Tab.** The iframe bridge swallows Tab (`useIframeEventForwarding.ts:257`). Any Tab binding
  (IX-3) needs the bridge to forward a clone instead, and must stay inactive inside panels.
- **⌘A leak.** With a node selected, no scope claims ⌘A, so the browser selects admin text. The dispatcher's
  fall-through design makes an unclaimed chord a native action, so every Penpot key Studio does not bind
  behaves natively (⌘F opens browser find, ⌘H hides the window on macOS).
- **Selection semantics.** Canvas ⇧-click = tree range (`selectionSlice.ts:199-215`). Any future marquee or
  Tab work must decide range vs toggle first.

## 6. Verification performed
Read-only. No code changed, no tests run, no Playwright, no server.
