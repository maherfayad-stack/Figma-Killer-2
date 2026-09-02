# Canvas Drag-and-Drop

How drag-and-drop works in the visual editor: dropping new modules from the picker / library, moving existing nodes around the page tree, wrap-to-container, multi-select moves, and the drop-zone overlay.

**Four independent, incompatible DnD mechanisms coexist in Studio** — this is
tracked architectural debt (`STUDIO-FIGMA-PARITY-PLAN.md` Track D2 proposes a
single-engine unification), not a design choice. Do not assume `@dnd-kit/core`
is present on a surface just because it is present on another — check the
topology below first.

---

## TL;DR

- **Canvas node reorder** (moving an existing element) is **raw pointer
  events + a cross-iframe relay** (`useCanvasReorderDrag.ts`), NOT
  `@dnd-kit/core`. dnd-kit cannot reach across the canvas's iframe boundary —
  each breakpoint frame is a real `<iframe>` (see
  `docs/features/canvas-iframe-per-frame.md`) — so this drag was hand-rolled.
  It is armed from the selection toolbar's hand-grab button
  (`SelectionToolbar.tsx`), not by pressing the node itself:
  `NodeRenderer.tsx`'s only pointer hook is `onPointerDownCapture` for
  selection, not `useDraggable`.
- `@dnd-kit/core` genuinely IS used — but only on surfaces that never cross
  an iframe: the **DOM panel / layer tree** (`DomPanel.tsx`'s `<DndContext>`)
  and the **Site Explorer** (`useSiteExplorerDnd.ts`, its own separate
  `<DndContext>`). `CanvasRoot.tsx` mounts no `<DndContext>` at all.
  `src/__tests__/architecture/single-drag-mechanism.test.ts` contains
  `@dnd-kit/core` (and native HTML5 `dataTransfer`) to an explicit allowlist
  of exactly these files — a new surface reaching for either fails that gate.
- **Module-picker and media-canvas-insertion** drags are a third mechanism —
  raw pointer events with no `DndContext` (`ModuleInserterDialog.tsx`,
  `useMediaCanvasInsertionDrag.ts`), sharing the canvas's drop-zone resolver
  through `canvasInsertionDrop.ts`.
- The **Media workspace** (folders/assets — not the canvas) is a fourth
  mechanism: native HTML5 drag-and-drop (`draggable`, `dataTransfer` —
  `useMediaDnd.ts`, `mediaDragDrop.ts`, `mediaDnd.ts`). `dataTransfer` is
  unreadable during `dragover` (HTML spec "protected mode"), so legality
  there is judged from a same-document session mirror
  (`readActiveMediaDragPayload`), not `getData()`.
- Drop targets on the canvas are **drop-zones** — rectangles between nodes
  ("before X", "after X", "into X"). Computed per-frame from node geometry.
- Drop resolution: `resolveCanvasDropTarget(...)` in
  `src/admin/pages/site/canvas/canvasDnd.ts` maps
  `(activePoint, frameGeometry, zoom) → { parentId, index, axis }`. The edge
  band is authored in SCREEN pixels and divided by the live canvas zoom
  before comparison, because `candidate.rect` / `point` are frame-space
  (unscaled) coordinates — a screen-space constant compared to them directly
  shrinks to nothing at low zoom (was a real bug; see `MIN_EDGE_HIT_ZONE_SCREEN_PX`).
- New insert sources that are not moving an existing node use `resolveCanvasPointerInsertionDrop(...)` in `src/admin/pages/site/canvas/canvasInsertionDrop.ts` so module-picker and media-library drops share viewport lookup, target resolution, and preview geometry.
- Mutation: `mutateActiveTree((tree) => moveNode(tree, nodeId, parentId, index))` — page-mode and VC-mode both work.

---

## The DnD topology

```text
Canvas node reorder (move an existing node) — RAW POINTER, not @dnd-kit
─────────────────────────────────────────────────────────────────────────
  SelectionToolbar hand-grab button         ← arms the drag; NodeRenderer
    │  onPointerDown                          itself is not draggable
    ▼
  useCanvasReorderDrag.ts                   ← window pointermove/up/cancel
    │  measures candidates once, from the      listeners
    │  iframe's contentDocument, at
    │  pointerdown (measureCanvasDropCandidates)
    ▼
  canvasDnd.ts (resolveCanvasDropTarget)    ← pure resolver, zoom-aware
    │
    ▼
  moveNodes(draggedIds, parentId, index)    ← store action, on pointerup

  Cross-iframe relay: pointermove/up/cancel over an iframe don't bubble to
  the parent window. `canvasPointerRelay.ts` flags the parent document while
  a drag is in flight; each `IframeFrameSurface` forwards its pointer events
  back to the parent so the window listeners above keep receiving them.

DOM panel / layer tree reorder — the ONE real @dnd-kit/core canvas-adjacent surface
─────────────────────────────────────────────────────────────────────────
  <DndContext>  (DomPanel.tsx, autoScroll={false} — see useDomPanelDnd.ts)
    <TreeNode>  useDraggable/useDroppable, one SortableContext per parent group
  onDragEnd → useDomPanelDnd.ts → the same `moveNodes` store action

Site Explorer (page tree / folders) — its OWN separate @dnd-kit context
─────────────────────────────────────────────────────────────────────────
  <DndContext>  (useSiteExplorerDnd.ts) — isolated from the DOM panel's.

New-module / media insertion — raw pointer, no DndContext at all
─────────────────────────────────────────────────────────────────────────
  ModuleInserterDialog.tsx / useMediaCanvasInsertionDrag.ts
    own pointer listeners, own ghost element. Both call
    canvasInsertionDrop.ts's resolveCanvasPointerInsertionDrop, which shares
    canvasDnd.ts's resolver with the canvas reorder drag above.

Media workspace (folders/assets) — native HTML5 DnD, a FOURTH mechanism
─────────────────────────────────────────────────────────────────────────
  draggable + onDragStart/onDragOver/onDrop, dataTransfer payloads
  (useMediaDnd.ts, mediaDragDrop.ts, mediaDnd.ts). Unrelated to the canvas —
  documented here only so its existence isn't mistaken for a canvas pattern.
```

Drag sources (canvas + DOM panel — the Media workspace is a separate topology, above):

| Source                              | Origin                           | Drop result                                                                |
|--------------------------------------|-----------------------------------|-----------------------------------------------------------------------------|
| Selection toolbar hand-grab button   | Canvas — the selected node/group | Move the node(s) to the drop target (raw pointer, `useCanvasReorderDrag.ts`) |
| Module inserter item                 | Module picker / inserter dialog  | Insert a new node of the picked module at the drop target (raw pointer, `ModuleInserterDialog.tsx`) |
| Media Explorer asset                 | Site editor Media panel          | Image asset inserts `base.image`; video asset inserts `base.video` (raw pointer, `useMediaCanvasInsertionDrag.ts`) |
| DOM panel tree row                   | The DOM panel tree               | Move the node to the drop target (`@dnd-kit/core`, `useDomPanelDnd.ts`)     |

Existing-node canvas moves and DOM-panel moves both resolve through the same
tree-mutation math but are driven by two different event systems — see the
topology above. Module-picker / media-insertion sources start outside the
frame tree entirely and use pointer listeners plus
`resolveCanvasPointerInsertionDrop(...)` because they need the same drop
zones but carry no existing node id.

---

## Drop zones

A drop zone is a thin rectangle that resolves to **"insert at this position"**. There are three kinds:

```text
┌────────────────────────────┐
│ ─── before sibling A ───── │   ← "insert at index 0"
│ ┌────────────────────────┐ │
│ │   node A (container)   │ │   ← node A's "into" zone
│ │                        │ │
│ │  child 1               │ │
│ │  child 2               │ │
│ └────────────────────────┘ │
│ ─── between A and B ─────  │   ← "insert at index 1"
│ ┌────────────────────────┐ │
│ │   node B (text)        │ │
│ └────────────────────────┘ │
│ ─── after sibling B ────── │   ← "insert at index 2"
└────────────────────────────┘
```

| Zone kind | Position    | Resolves to                            |
|-----------|-------------|----------------------------------------|
| Before    | Top edge of a sibling | `{ parentId, index }` (sibling's index)|
| After     | Bottom edge | `{ parentId, index + 1 }`              |
| Into      | Body of a `canHaveChildren` node | `{ parentId: target.id, index: target.children.length }` (append) |

The axis (`'vertical' | 'horizontal'`) depends on the parent's layout — resolved by `resolveCanvasAxisFromStyle` / `resolveCanvasInsertionAxis` (`canvasDomGeometry.ts`). Vertical for normal block flow; horizontal for `display: flex; flex-direction: row` (and `flex-direction: row-reverse`, and a `grid` container under the default `row` autoflow — see the next paragraph). Every `CanvasDropCandidate` also carries a `reversed` flag: true when the parent lays out children in the REVERSE of DOM child order along that axis (`row-reverse` / `column-reverse`, or a plain `row` flex container under `direction: rtl` — visual-left is the logical end there). `getCanvasDropZone` flips its `before`/`after` labels when `reversed` is set, so a pointer near the visual-left edge of an RTL row still resolves to the correct DOM-order side.

**Grid is a CSS-only heuristic, not sibling-geometry-derived.** `gridAutoFlow: column` (dense-column placement) resolves `vertical`; the default `row` autoflow resolves `horizontal`. This is a real improvement over the previous unconditional `'vertical'` (which drew horizontal insertion bars across a side-by-side card gallery), but it is still wrong for a `grid-template-columns` layout whose items aren't auto-placed — the fully correct fix compares actual sibling rect overlap (row vs. column) and hasn't landed. See `resolveCanvasAxisFromStyle`'s own doc comment.

---

## `resolveCanvasDropTarget`

```ts
resolveCanvasDropTarget({
  tree,                                // the page/VC tree the candidates belong to
  draggedId, draggedIds,               // pivot + full multi-drag set
  candidates,                          // CanvasDropCandidate[] — measured node rects (frame-space, unscaled)
  point,                               // pointer in frame-space (viewport-local, unscaled) coordinates
  zoom,                                // live canvas zoom (1 = 100%); defaults to 1
  canHaveChildren,                     // (moduleId) => boolean
}): CanvasDropResolution             // { target: CanvasDropTarget | null; invalid: CanvasInvalidDropTarget | null }
```

The resolver:

1. Finds every candidate whose rect contains `point`, and picks the deepest / smallest-area one — the innermost match wins (a point inside a child beats the parent's "into" zone).
2. Classifies the hit into `'before' | 'inside' | 'after'` via `getCanvasDropZone(candidate, point, zoom)`.
3. Resolves that zone against the tree (`resolvePageTreeDropTarget` in `@core/page-tree`), which rejects invalid drops (self into self, cycle, locked node, no-op).

`getCanvasDropZone(candidate, point, zoom)` is the helper that classifies a
single candidate's hit. Its edge band is authored in SCREEN pixels
(`MIN_EDGE_HIT_ZONE_SCREEN_PX` / `MAX_EDGE_HIT_ZONE_SCREEN_PX` in
`canvasDnd.ts`) and divided by `zoom` before comparing against
`candidate.rect`, which is frame-space (unscaled). Omitting `zoom` (or
passing `1`) is only correct at 100% canvas zoom — every real call site
(`useCanvasReorderDrag.ts`, `canvasInsertionDrop.ts`) recovers the live zoom
via `getViewportZoom(viewport)` (`canvasDomGeometry.ts`) and passes it
through. Getting this wrong is a **silent** bug, not a crash: at low zoom
almost every drop resolves `'inside'` instead of `'before'`/`'after'`
because the on-screen edge band shrinks to a couple of pixels.

---

## Source-writeback refusal preview (G5)

A structurally valid drop target (real container, real index) can still be
one the store's own structural gate would refuse to write to source — e.g.
dragging a shared component's inlined markup, or reordering across a route
layout boundary (`struct-01`, `docs/agent-refs/conventions-quickref.md` §7).
Before this preview existed, the resolver only checked TREE SHAPE (root,
locked, cycle, non-container), so the drop line rendered as confidently valid
right up to the moment of a post-hoc refusal toast on `pointerup` — true for
roughly half of all drags on a real imported project (`shared-component` is
the single largest refusal bucket).

`previewStructuralMove(tree, nodeIds, newParentId, newIndex)`
(`@core/page-tree`, `src/core/page-tree/sourceStructure.ts`) is a **pure**
preview of that same gate: given a tree and a candidate move, it returns
`{ ok: true; commit }` or `{ ok: false; refusal }` using the identical
refusal vocabulary (`list-row` / `shared-component` / `route-chrome` /
`code-placed` / `reparent` / `no-sibling-anchor` / `cross-file` /
`multi-select`) the store's own post-drop gate already shows.

`resolveCanvasDropTarget` (canvas) and `resolveDomDropTarget` +
`previewDomDropRefusal` (DOM panel — `domPanelDnd.ts`) both call it AFTER the
tree-shape check passes: a refused move now resolves as an `invalid`/
`invalidReason` result — the SAME red "can't drop here" indicator a
locked-node rejection already renders — instead of a valid drop line. The
canvas overlay (`BreakpointSelectionOverlay.tsx`) carries the refusal message
on `reorderDrag.invalid.refusalMessage` but does not yet render it as visible
text (the indicator element is `pointer-events: none`, so a native `title`
never fires; a real cursor-following label is future work). The DOM panel
row DOES show it — `TreeNode.tsx` sets a real `title` on the row, which
fires natively since tree rows aren't `pointer-events: none`.

**This is a preview, never a replacement for the store's own gate.** The
store (`nodeActions.ts`'s `moveNodes`) still re-checks on `pointerup` and is
the sole commit-time authority — this only makes the SAME verdict visible
while the pointer is still down instead of after release. `previewStructuralMove`
is presently a **hand-kept-in-sync duplicate** of the store's own
`structuralSourceEdits.ts`'s `planSourceMove` (that module lives under
`store/**`, owned separately) — not yet a shared call, a disclosed gap for
whoever collapses them.

---

## Keyboard reorder (G12, partial)

`Alt+↑` / `Alt+↓` (`layers.moveUp` / `layers.moveDown` in the keybindings
registry, `src/admin/spotlight/keybindings.ts`) move the selected node one
position among its siblings — wired in `useCanvasKeyboardShortcuts.ts`,
calling the same `moveNode` store action every drag surface already commits
through, so a keyboard move rides the identical structural-refusal gate a
mouse drag does. Single-node only (a multi-selection may not share a parent,
so "move up" has no single meaning for it — silently no-ops rather than
guessing). These same commands already existed as spotlight palette entries
(`spotlight/commands/layers.ts`'s `layers.moveUp`/`layers.moveDown`); this
closes the keyboard-shortcut half.

**Still missing:** no `KeyboardSensor` on either `<DndContext>` (DOM panel,
Site Explorer), so a `@dnd-kit` drag itself still has no keyboard path — only
the plain reorder command above does. No indent/outdent (reparent) keyboard
commands — reparenting a source-derived node refuses unconditionally today
regardless of trigger, so there is little for one to do yet.

---

## Drop overlay

The overlay highlights the resolved drop position. Geometry comes from the resolver or, for insert sources, from `canvasInsertionDrop.ts`'s fixed preview helpers:

- **Before / After** — a thin sky-tinted line (`--accent-3` at 0.6 alpha) at the zone position.
- **Into** — a sky-tinted dashed outline inset 4px from the target's bounding box.
- **Invalid** — a danger-tinted outline (`--danger`) + a tooltip explaining why (`'cannot drop into self'`, `'target is locked'`).

The overlay is a separate React tree positioned with absolute coordinates derived from the canvas zoom/pan transform.

---

## DOM panel ⇄ canvas parity

The DOM panel resolves drops with the **same shape of math** as the canvas —
`resolveDomDropTarget` (`domPanelDnd.ts`) mirrors `resolveCanvasDropTarget`'s
before/inside/after zone logic — except its geometry comes from row
positions (`DomDropRowMeta`), not measured node rects. A node dragged in the
DOM panel resolves the same `{ parentId, index }` shape as a node dragged on
the canvas, and both commit through the same `moveNodes` store action.

**The two surfaces do NOT share a `<DndContext>`, and a drag cannot start in
one and end in the other.** They are two entirely different event systems —
see "The DnD topology" above: the DOM panel's `<DndContext>` (`DomPanel.tsx`)
is local to that panel; the canvas reorder drag is raw pointer events with no
`DndContext` at all. Starting a drag in the DOM panel and releasing it over
the canvas (or vice versa) is not a supported gesture today.

---

## Mutation

**Canvas reorder** commits on `pointerup`, once the pointer travelled past
the activation threshold (`DRAG_ACTIVATE_PX`), in
`useCanvasReorderDrag.ts`'s `handleWindowPointerUp`:

```ts
const target = latestResolutionRef.current.target
resetDrag()
if (!target) return
useEditorStore.getState().moveNodes(target.draggedIds, target.parentId, target.index)
```

**DOM panel reorder** commits on `@dnd-kit/core`'s real `onDragEnd`
(`DomPanel.tsx` → `useDomPanelDnd.ts`), against the same resolved target
shape.

**Module-picker / media insertion** (`ModuleInserterDialog.tsx`,
`useMediaCanvasInsertionDrag.ts`) resolve through
`resolveCanvasPointerInsertionDrop` on every pointer move and commit
`insertNode` on pointerup — see the Cookbook below.

All of `insertNode`, `moveNode`, and `moveNodes` go through
`mutateActiveTree` — they work in page-mode and VC-mode the same way. See
[docs/reference/page-tree.md](page-tree.md).

---

## Multi-select drag

The DOM panel + canvas support multi-select via shift / cmd-click. When the user drags one of the selected nodes:

- All selected nodes move together.
- They're moved to the drop target via `moveNodes(tree, nodeIds, parentId, index)` — the mutation preserves relative order.
- If any selected node can't be moved (locked, would create a cycle), the whole drop is invalid.

`moveNodes` is the multi-version of `moveNode`. Both live in `src/core/page-tree/mutations.ts`.

**Target-index normalization (`normalizeIndexAfterRemoval`, `core/page-tree/dnd.ts`) must discount every dragged sibling, not just the pivot (G10).** `moveNodes` detaches the WHOLE `draggedIds` set before splicing, so a raw drop index computed against the pre-removal children array has to be reduced by however many dragged siblings sit below it TODAY, or the group lands too far to the right. The no-op check (`noOpTarget`) has the same requirement for the same reason — it simulates the actual post-move child order (mirroring `moveNodes`' own detach-then-splice arithmetic) rather than comparing a single pivot index, which can accidentally coincide with the correct target index for one specific n>1 drag and false-positive-cancel a real move.

---

## Wrap-to-container

A common drag pattern: select two nodes, drag them onto a "wrap in container" affordance, and they become children of a new container at the original position.

Implemented as `wrapNodes(tree, nodeIds, 'base.container')` in `mutations.ts`. The drag source is the multi-select group; the drop target is a "wrap" affordance (shown in the toolbar / context menu, not as a canvas drop zone).

Gated by `task414-wrap-to-container.test.ts` and `multiWrapDefaults.test.ts` — wrapper nodes are created with module defaults and keep the wrapped tree structure valid.

---

## Board furniture drag + snap-to-peer guides (Studio)

Studio-mode board furniture — frames (`BoardFramesLayer`), sticky notes (`BoardNotesLayer`), and doc blocks (`BoardDocsLayer`) — is a drag system **separate from all four mechanisms above**. Each furniture view (`BoardFrameView`, `StickyNoteView`, `DocBlockView`) drags itself via raw pointer-capture on its own header/body (`setPointerCapture` + `screenDelta / zoom`), not `useDraggable`. Do not migrate this onto `@dnd-kit` — pointer-capture is correct here for the same cross-iframe / performance reasons the canvas node-reorder drag (`useCanvasReorderDrag.ts`) is also hand-rolled rather than dnd-kit-based; see that hook's module doc.

**Snap-to-peer alignment (Phase 6B).** While dragging a frame/note/doc, its move handler snaps the raw new position to the closest aligned edge/center of every OTHER piece of furniture on the active board, and draws the alignment guide(s) it snapped to:

- **`computeSnap(dragged, peers, threshold)`** — the pure core, `src/admin/pages/site/canvas/boardSnapping.ts`. For each axis (x, y) independently, it checks the dragged rect's start/center/end against every peer's start/center/end, picks the closest pair within `threshold` board units (closest wins; at most one snap per axis), and returns the adjusted top-left position plus a `SnapGuide` per matched axis. No peers, or no match within threshold, leaves that axis untouched. Pure — no React, no DOM — unit-tested in `src/__tests__/canvas/boardSnapping.test.ts` the same way `frameResize.ts`/`frameVirtualization.ts` are.
- **`collectPeerRects(board, dragged)`** — flattens a board's frames/notes/docs into the flat `SnapRect[]` peer list, excluding whichever object is being dragged. Frames without a saved size fall back to `FRAME_WIDTH`/`FRAME_HEIGHT`, mirroring `BoardFramesLayer`'s own render-time fallback.
- **Threshold:** `SNAP_THRESHOLD_BOARD_UNITS = 8` — a fixed board-unit distance, not a screen-pixel feel divided by zoom. Simpler, and board furniture rarely sits near the threshold at extreme zoom in practice.
- **Guides are transient, not persisted.** `boardSnapGuides` (`boardSlice`) is a top-level store field holding the active drag's `SnapGuide[]`, separate from `boards`/`BoardsFile` — it never reaches `serializeBoardsFile` or the boards auto-save effect, and `setBoardSnapGuides` never flips `boardsDirty`. Each move handler calls `setBoardSnapGuides(snapped.guides)`; pointer-up/cancel clears it (`setBoardSnapGuides([])`).
- **`BoardGuidesLayer`** (`canvas/BoardGuidesLayer/`) renders the active guides as thin lines, mounted last inside `CanvasTransformLayer` so it paints above every furniture layer and inherits the pan/zoom transform for free. `pointer-events: none` throughout — guides are purely visual. Line color is the `--canvas-snap-guide-color` token (globals.css) — a fourth canvas-affordance identity distinct from the selection/hover/selector rings.

**Deferred from this pass** (see the plan's backlog): multi-select drag for board furniture (marquee/shift-click, moving several objects together), and drop-precision improvements to the tree-reorder system (`useCanvasReorderDrag.ts`) — a different drag system, out of scope here.

---

## Cookbook

### Drop a new module from the picker

```ts
const drop = resolveCanvasPointerInsertionDrop({
  canvasPage,
  clientX,
  clientY,
  label: 'Drop',
})
if (drop) insertModule(module, drop.location)
```

The module inserter keeps its own pointer drag state, but target resolution and preview geometry are shared through `canvasInsertionDrop.ts`.

### Drop media from the Site editor Media panel

`mediaCanvasInsertionForAsset(asset)` maps image assets to `base.image` defaults (`{ src: asset.publicPath }`) and video assets to `base.video` defaults (`{ videoUrl: asset.publicPath }`). Other asset types are not canvas insert sources. The drag hook then calls `useInsertModule(mod, drop.location, { defaults })`, so the created node is selected and routed through the same page/Visual Component insertion path as module-picker drops.

### Drop an existing node

On the **canvas**, the drag is armed from the selection toolbar's hand-grab
button (`SelectionToolbar.tsx` → `onDragPointerDown` → `useCanvasReorderDrag`'s
`handlePointerDown`), not by pressing the node itself — `NodeRenderer.tsx`
registers no `useDraggable`; its only pointer hook
(`onPointerDownCapture`) is for selection. Select the node first, then use
the toolbar's hand-grab handle to drag it. The same drop-zone resolution
(`resolveCanvasDropTarget`) applies regardless.

In the **DOM panel**, any row is directly draggable (`useDraggable` via
`@dnd-kit/core`) — no separate arming gesture needed there.

### Drop INTO a container

Drop zones for `canHaveChildren` nodes include an "into" zone covering the body. The resolver picks it when the pointer is inside the body (and not on a child's before/after zone). The new node is appended as the last child.

### Disable drops on a node

Set `locked: true` on the node. The resolver rejects drops on locked nodes (and drops of locked nodes themselves).

`base.slot-instance` nodes are always locked — the user can edit their **contents** but not move / delete the instance itself.

### Inserting a node programmatically

```ts
useEditorStore.getState().insertNode(
  createNode('base.text', { content: 'New text' }),
  parentNodeId,
  0,                  // index — at the start
)
```

Bypasses DnD entirely. Same mutation as a drop.

### Listening for drop events

**On the DOM panel / Site Explorer** (the real `@dnd-kit/core` surfaces):
don't add raw `dragstart` / `dragend` listeners — `@dnd-kit` owns those. Put
drop-reaction logic in `onDragEnd` (in the page that owns that `<DndContext>`).

**On the canvas** (reorder, module-picker, media-insertion — none of them
`@dnd-kit`): there is no `onDragEnd` to hook into. React to the resolved
target in `handleWindowPointerUp` (`useCanvasReorderDrag.ts`) or the
pointerup handler that closes the gesture (`ModuleInserterDialog.tsx`,
`useMediaCanvasInsertionDrag.ts`).

**On the Media workspace** (native HTML5 DnD): react in `onDrop` on the
target element (`useMediaDnd.ts`'s `handleDrop`), same as any native
drag-and-drop consumer. Don't try to route it through `@dnd-kit` — it isn't
present on that surface.

---

## Forbidden patterns

| Pattern                                                                                             | Use instead                                                                                                    |
|--------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| Adding a NEW native HTML5 DnD surface outside the Media workspace                                     | Reuse the canvas pointer-drag pattern (`useCanvasReorderDrag.ts`) or `@dnd-kit/core` (DOM panel / Site Explorer). Native HTML5 DnD is scoped to the Media workspace only — and even there, legality checks during `dragover` must go through `readActiveMediaDragPayload()` (the session mirror), never `dataTransfer.getData()`, which the HTML spec mandates return `""` in "protected mode" |
| `react-dnd`                                                                                             | Not used anywhere in this codebase — don't introduce it                                                            |
| Adding `@dnd-kit/core` (or native HTML5 `dataTransfer` DnD) to a NEW file  | Both are pinned to an explicit allowlist in `src/__tests__/architecture/single-drag-mechanism.test.ts` — a new surface reaching for either fails that gate. Use the canvas's raw-pointer-event pattern instead |
| Computing drop targets ad-hoc per surface                                                              | `resolveCanvasDropTarget(...)` / `resolveCanvasInsertionTarget(...)` (canvas) or `resolveDomDropTarget(...)` (DOM panel) — same zone math, same zoom handling |
| Skipping the cycle check on a `moveNode`                                                                | `moveNode` already guards. Use it.                                                                                 |
| Inserting into a locked node                                                                            | Resolver rejects. Don't bypass.                                                                                    |
| Reading from the iframe's `document` to find drop targets in a NEW surface                              | Reuse `measureCanvasDropCandidates` (`canvasDomGeometry.ts`) — it already handles the iframe-to-editor coordinate translation and zoom recovery |
| Comparing a screen-space pixel constant against `CanvasDropCandidate.rect` / a resolver `point` without dividing by zoom | `candidate.rect` / `point` are frame-space (unscaled); see `MIN_EDGE_HIT_ZONE_SCREEN_PX` in `canvasDnd.ts` and `getViewportZoom` in `canvasDomGeometry.ts` |
| Assuming a canvas node is `useDraggable` because DOM panel rows are                                     | Canvas nodes are not draggable directly — see "Drop an existing node" above |
| Dispatching a different mutation per drag source kind, deeply                                           | Two cases: picker → `insertNode`, node → `moveNode`/`moveNodes`. Keep it that simple.                              |

---

## Related

- [docs/editor.md](../editor.md) — canvas overview
- [docs/reference/page-tree.md](page-tree.md) — `moveNode`, `moveNodes`, `wrapNode`, `wrapNodes`, `insertNode`
- [docs/features/visual-components.md](../features/visual-components.md) — slot-instance is locked
- [docs/features/canvas-iframe-per-frame.md](../features/canvas-iframe-per-frame.md) — why the canvas can't just use `@dnd-kit` for node reorder
- Source-of-truth files:
  - `src/admin/pages/site/canvas/canvasDnd.ts` — `getCanvasDropZone`, `resolveCanvasDropTarget`, `resolveCanvasInsertionTarget` (zoom-aware edge bands)
  - `src/admin/pages/site/canvas/canvasDomGeometry.ts` — `measureCanvasDropCandidates`, `getViewportZoom`, iframe↔editor coordinate translation
  - `src/admin/pages/site/canvas/canvasInsertionDrop.ts` — pointer-to-canvas insertion target + fixed preview geometry shared by module and media insert sources
  - `src/admin/pages/site/canvas/CanvasRoot.tsx` — mounts NO `<DndContext>`; the canvas reorder drag is raw pointer events
  - `src/admin/pages/site/canvas/useCanvasReorderDrag.ts` — the canvas reorder drag-state hook (raw pointer, not dnd-kit)
  - `src/admin/pages/site/canvas/canvasPointerRelay.ts` — cross-iframe pointer relay the reorder drag depends on
  - `src/admin/pages/site/panels/DomPanel/DomPanel.tsx` — the DOM panel's own `<DndContext>` (`autoScroll={false}` — see `useDomPanelDnd.ts`'s own auto-scroll)
  - `src/admin/pages/site/panels/DomPanel/useDomPanelDnd.ts` — DOM panel drag-state hook (real `@dnd-kit/core`)
  - `src/admin/shared/media/hooks/useMediaDnd.ts` / `src/admin/shared/media/utils/mediaDragDrop.ts` / `src/admin/shared/media/utils/mediaDnd.ts` — Media workspace native HTML5 DnD, incl. the `dragover` protected-mode session mirror
  - `src/admin/pages/site/panels/MediaExplorerPanel/mediaCanvasInsertion.ts` — media asset → base module/defaults mapping
  - `src/admin/pages/site/store/insertLocation.ts` — `InsertLocation` shape
  - `src/core/page-tree/mutations.ts` — `insertNode`, `moveNode`, `moveNodes`, `wrapNode`
  - `src/admin/pages/site/canvas/boardSnapping.ts` — `computeSnap`, `collectPeerRects` (Studio board furniture snap-to-peer, Phase 6B)
  - `src/admin/pages/site/canvas/BoardGuidesLayer/` — renders the active snap guides
  - `src/admin/pages/site/store/slices/boardSlice.ts` — `boardSnapGuides` / `setBoardSnapGuides` (transient, not persisted)
  - `src/core/page-tree/sourceStructure.ts` — `previewStructuralMove` (G5's pure preview), `refusePlacement`/`refuseStructuralEdit` (the refusal vocabulary)
  - `src/admin/pages/site/panels/DomPanel/domPanelDnd.ts` — `previewDomDropRefusal`
  - `src/admin/spotlight/keybindings.ts` — `layers.moveUp` / `layers.moveDown` (G12's keyboard reorder)
- Gate tests:
  - `src/__tests__/architecture/task414-wrap-to-container.test.ts`
  - `src/__tests__/architecture/canvas-aware-selectors.test.ts`
  - `src/__tests__/architecture/single-drag-mechanism.test.ts` — DnD mechanism containment (D2): `@dnd-kit/core` and native HTML5 DnD are each pinned to an explicit allowlist; NOT yet a true "one mechanism" assertion, see its own module doc
  - `src/__tests__/canvas/canvasDnd.test.ts` — includes the zoom-scaled edge-band regression cases and the G5 refusal-preview cases
  - `src/__tests__/canvas/canvasInsertionAxis.test.ts` — G9: grid / `*-reverse` / RTL axis resolution
  - `src/__tests__/core/pageTreeDnd.test.ts` — G10: multi-drag index normalization + the companion `noOpTarget` false-positive regression
  - `src/__tests__/dom-panel-dnd/target-resolution.test.ts` — includes the G5 refusal-preview cases
  - `src/__tests__/media/mediaDragDrop.test.ts` — the `dragover` protected-mode session-mirror regression

**Fixed this pass** (see `src/__tests__/core/pageTreeDnd.test.ts`,
`src/__tests__/canvas/canvasDnd.test.ts`,
`src/__tests__/canvas/canvasInsertionAxis.test.ts` for the regression
coverage): multi-node drag index math (`normalizeIndexAfterRemoval` — was off
by `dragged-siblings − 1`, discounting only the pivot) — AND a companion
latent bug the fix exposed, `noOpTarget` false-positive-canceling a real
multi-drag by comparing indices from arrays of different lengths; the axis
resolver now handles `row-reverse`/`column-reverse`/RTL correctly and grid
via a `gridAutoFlow`-based heuristic (see "Drop zones" above — grid is
still not sibling-geometry-derived); structural source-writeback refusal now
previews WHILE the pointer is down for the canvas and DOM-panel surfaces (see
"Source-writeback refusal preview (G5)" above — the store's own post-drop
gate is unchanged and remains authoritative); `Alt+↑`/`Alt+↓` keyboard
reorder (see "Keyboard reorder (G12, partial)" above).

**Known remaining gaps, not yet fixed** (see `STUDIO-FIGMA-PARITY-PLAN.md`
Track D2 / `docs/audits/2026-08-06/07-drag-and-drop.md` for the full audit):

- **A canvas drag can never leave the frame it started in** (silent no-op if
  released over a different frame) — `useCanvasReorderDrag.ts` still measures
  candidates once, from one iframe, at `pointerdown`. This needs the
  board-wide `frameCandidateIndex` the target architecture describes below;
  not built this pass.
- **You still cannot drag an element on the canvas by pressing it** — the
  only trigger remains the selection toolbar's hand-grab button
  (`SelectionToolbar.tsx`). `NodeRenderer.tsx` still has no drag-arming
  pointer hook of its own.
- **Insertion drags (module picker, media→canvas) still re-measure the whole
  frame on every `pointermove`** — no RAF coalescing, no candidate caching.
- **Insertion drags can still resolve against the wrong page** when the
  pointer is over a non-active board frame (`canvasInsertionDrop.ts` picks
  the viewport geometrically but resolves against `selectActiveCanvasPage`).
- **Board furniture** (frames/notes/docs) still writes the store twice per
  `pointermove`, has no multi-frame drag, no Escape-to-cancel, and variants
  don't snap to each other (`boardSnapping.ts` keys peers by `pageId`).
- **No file drop** onto the canvas or the Studio importer.
- **No `KeyboardSensor`** on either `@dnd-kit/core` `<DndContext>` — a
  `@dnd-kit`-driven drag itself still has no keyboard path (only the new
  `Alt+↑`/`Alt+↓` plain-reorder command does).
- **The target `dragSession` singleton + board-wide `frameCandidateIndex` +
  one source-aware `resolveDrop` do not exist yet.** Three incompatible
  mechanisms (raw pointer, `@dnd-kit/core`, native HTML5 `dataTransfer`)
  still coexist — see the topology at the top of this doc. `@dnd-kit/core`
  is NOT removed; `src/__tests__/architecture/single-drag-mechanism.test.ts`
  contains it (and native HTML5 DnD) to an explicit allowlist so the
  fragmentation cannot silently spread further while the real unification
  is pending.
