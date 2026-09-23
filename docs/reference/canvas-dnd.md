# Canvas Drag-and-Drop

How drag-and-drop works in the visual editor: dropping new modules from the picker / library, moving existing nodes around the page tree, wrap-to-container, multi-select moves, and the drop-zone overlay.

**Four independent, incompatible DnD mechanisms coexist in Studio** — this is
tracked architectural debt (see "The D2 target architecture, and how much of it
exists" near the end of this doc), not a design choice. Do not assume `@dnd-kit/core`
is present on a surface just because it is present on another — check the
topology below first.

---

## TL;DR

- **Canvas node reorder** (moving an existing element) is **raw pointer
  events + a cross-iframe relay** (`useCanvasReorderDrag.ts`), NOT
  `@dnd-kit/core`. dnd-kit cannot reach across the canvas's iframe boundary —
  each breakpoint frame is a real `<iframe>` (see
  `docs/features/canvas-iframe-per-frame.md`) — so this drag was hand-rolled.
  It has **two activation points**, both landing in the same
  `beginDrag` session:
  1. the selection toolbar's hand-grab button (`SelectionToolbar.tsx` →
     `onDragPointerDown`), a React handler in the PARENT document; and
  2. **a press on the element's own body**, a native capture-phase
     `pointerdown` listener on the frame's own `contentDocument` (the
     `bodyDragEnabled` effect in `useCanvasReorderDrag.ts`).

  `NodeRenderer.tsx` is still not `useDraggable` and still owns no drag
  handler — its only pointer hook remains `onPointerDownCapture`, for focus
  and authored-form-control suppression. The body drag deliberately lives on
  the document instead of on every node: it must run BEFORE `NodeRenderer`'s
  capture handler, it must see a press on any node without threading a
  callback through every module's prop bag, and it adds no element to the
  canvas DOM.
- **The canvas node reorder is a SESSION (S2, D2's `dragSession`), not a
  re-render.** `pointerdown` measures everything the gesture needs once;
  every `pointermove` writes a ref; ONE `requestAnimationFrame` resolves the
  drop target and paints the indicator straight into the DOM; `pointerup`
  writes the store once. **Per pointermove: zero React commits and zero forced
  layout reads** — the gesture commits React exactly twice, at its two edges.
  See "[The drag session](#the-drag-session-s2)" below.
- **Alt+drag drops a copy** — for canvas elements (one source write through
  `duplicateJsxElement`'s destination form) and for board frames (a cheap
  `boards.json` copy). Refuses for exactly the reasons the same drag without
  Alt would. See "[Alt+drag duplicates (K2)](#altdrag-duplicates-k2)".
- **A drag that crosses into another FRAME moves the element between FILES**
  (D2 G3). One `transplant` edit (`transplantJsxElement`) removes the markup
  from one `.tsx` and writes it into the other, carrying whatever imports it
  needs; Alt copies instead. Refuses — while the pointer is still down, as the
  same chip a same-frame refusal shows — when the element reads a binding local
  to the component it is leaving (`captured-scope`), when the destination
  already means something else by a name it would carry
  (`binding-conflict`), when it reads a helper or local component the origin
  declares but does not export (`unexported-binding`, `sec-17` — the import it
  would carry would resolve to nothing), or for any of the four reasons a
  same-frame move refuses on either end. **Two frames of the same PAGE are not cross-frame** —
  a "duplicate as variant" sibling keeps going through `moveNodes`. See
  "[Dragging an element BETWEEN frames](../agent-refs/canvas-internals.md)" in
  canvas-internals.
- **A drag SHOWS THE REFLOW it would cause.** While an element is in flight,
  the siblings that would make room for it slide aside — ghost boxes in the
  frame's own drag layer, travelling by the exact distance the real siblings
  would (`canvasReflowPreview.ts` decides, `canvasDragPainter.ts` animates).
  Nothing in the user's own DOM is touched, nothing is written until
  `pointerup`, and the preview stands down entirely for the three layouts its
  packing model does not describe. See
  "[The reflow preview (K6)](#the-reflow-preview-k6)".
- **An image file dropped from the OPERATING SYSTEM onto a frame becomes an
  `<img src alt>`** (D2 G15) — one upload into the project's own `public/`,
  then one structural insert at the drop point. **The verdict arrives before
  release**: over a frame, the same drop line an element drag shows plus a
  cursor chip naming the format; over the empty board, a chip saying
  "Drop onto a frame"; for a non-image, the refusal, while the file is still in
  the air. See "[The file-drag preview (G15)](#the-file-drag-preview-g15)". This is the canvas's one
  native-HTML5 gesture, by necessity: a file from outside the browser is only
  ever delivered through `DataTransfer.files`. Dropping on the empty board, or
  dropping a non-image, is a refusal toast and no write. Inside a design
  frame's document every native drag is cancelled, files or not
  (`canvasFrameDragRelay.ts`, `sec-17`): the browser's default is to navigate
  the document that received the drop, and a dropped link would replace the
  rendered page with an arbitrary site inside the editor's own chrome.
- **⌘/Ctrl+drag places by coordinates** instead of reordering — an inline
  `left`/`top` (or `inset-inline-start` in RTL) on one element, snapped to its
  siblings' edges and centres. Refuses, with a one-click remedy, when the
  container is `position: static`. See
  "[Free movement (K6)](#free-movement-k6)".
- `@dnd-kit/core` genuinely IS used — but only on one surface that never
  crosses an iframe: the **DOM panel / layer tree** (`DomPanel.tsx`'s
  `<DndContext>`). The Site Explorer used to be the second such surface; its
  panel was CMS-only chrome and has been deleted along with
  `useSiteExplorerDnd.ts`. `CanvasRoot.tsx` mounts no `<DndContext>` at all.
  `src/__tests__/architecture/single-drag-mechanism.test.ts` contains
  `@dnd-kit/core` (and native HTML5 `dataTransfer`) to an explicit allowlist
  of exactly these files — a new surface reaching for either fails that gate.
- **Insert-at-a-point** drags are a third mechanism — raw pointer events with
  no `DndContext` (`useCanvasInsertionDrag.ts`), sharing the canvas's drop-zone
  resolver through `canvasInsertionDrop.ts`. Its one live source is the canvas
  notch's Text / Div / Span primitives; the insert dialog that used to drag
  module cards is deleted, and dragging from the Assets panel is a deliberate
  follow-up (DS-4b). A media-asset counterpart
  (`useMediaCanvasInsertionDrag.ts`) used to ride the same resolver from the
  Media Explorer panel; that panel was CMS-only chrome and both are gone.
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
- New insert sources that are not moving an existing node use `resolveCanvasPointerInsertionDrop(...)` in `src/admin/pages/site/canvas/canvasInsertionDrop.ts` so notch-primitive and media-library drops share viewport lookup, target resolution, and preview geometry.
- Mutation: `mutateActiveTree((tree) => moveNode(tree, nodeId, parentId, index))` — page-mode and VC-mode both work.

---

## The DnD topology

```text
Canvas node reorder (move an existing node) — RAW POINTER, not @dnd-kit
─────────────────────────────────────────────────────────────────────────
  SelectionToolbar hand-grab button   ─┐    ← parent-document React handler
    │  onPointerDown                   │
                                       ├──▶ beginDrag(origin)
  Press on the element's own body    ─┘     ← native capture pointerdown on
    │  (iframe contentDocument)               the frame's own document; the
    │                                         local point is translated to
    │                                         PARENT client coords first
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
    <LayerRowList>  flattens the tree and mounts only the visible row slice
      <TreeNode>    useDraggable per MOUNTED row; there is no droppable and no
                    SortableContext — the drop target is resolved from
                    measured row rects (`measureRows` + `findDomDropRow`)
  onDragEnd → useDomPanelDnd.ts → the same `moveNodes` store action

  Windowing consequences, both deliberate:
   - only mounted rows register a rect, so an off-screen row is never a drop
     target. It is also off screen, and the pointer is inside the viewport.
   - dnd-kit's own auto-scroll stays off. `useDomPanelDnd`'s `runAutoScroll`
     drives the nearest SCROLLABLE ancestor (`findScrollContainer`), which is
     `StudioPagesTree`'s page list — the panel's own `.treeArea` is
     `overflow: visible`, so scrolling it moved nothing.

New-module insertion — raw pointer, no DndContext at all
─────────────────────────────────────────────────────────────────────────
  useCanvasInsertionDrag.ts (canvas notch primitives)
    own pointer listeners, own ghost element. Calls
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
| The element's own body               | Canvas — the pressed node, or the whole selection when the press lands inside it | Same move, same session. Selects the pressed node on ACTIVATION (not on pointerdown, so a press that stays a click leaves `NodeRenderer`'s Cmd/Shift-aware click-to-select alone) |
| Notch primitive (Text / Div / Span)  | Canvas notch                      | Insert a new node of that module at the drop target (raw pointer, `useCanvasInsertionDrag.ts`) |
| DOM panel tree row                   | The DOM panel tree               | Move the node to the drop target (`@dnd-kit/core`, `useDomPanelDnd.ts`)     |

Existing-node canvas moves and DOM-panel moves both resolve through the same
tree-mutation math but are driven by two different event systems — see the
topology above. Insert-at-a-point sources start outside the
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

## The drag session (S2)

`useCanvasReorderDrag.ts` runs one gesture as one session. Three files:

| File | Owns |
|---|---|
| `useCanvasReorderDrag.ts` | The session: listeners, activation distance, the single rAF, the one store write |
| `useCanvasBodyDragTrigger.ts` | The second activation point — "does this press mean a drag at all" |
| `canvasDragSession.ts` | `frameCandidateIndex` — the measurements, and when they go stale |
| `canvasDragPainter.ts` | Everything the drag draws, written straight into the DOM |

**The two React commits.** `dragging` flips on when the press clears the
activation distance and off at release / Escape / cancel — and never in
between. It stays React state rather than a ref because a consumer genuinely
renders from it: the selection overlay's measurement scheduler keeps measuring
while a continuous gesture is in flight, and a ref would leave that loop off
for the whole drag.

**The session also holds a `canvasGesture`** (`beginCanvasGesture` at
`pointerdown`, `endCanvasGesture` in the reset). Not because a reorder mutates
the page — it writes nothing until `pointerup` — but because the two things
that gesture flag freezes, the frame's **auto-height refit** and the
parent-document **selection anchor**, are exactly the two that would otherwise
reflow the frame mid-drag and invalidate the candidate index from underneath a
pointer the user has not moved. The `ResizeObserver` below and the frozen
auto-height are therefore cooperating, not racing: the observer exists for
reflows the drag does not control (an image finishing, an HMR patch), and the
one reflow source the editor DOES control is held still.

**What is measured, and when it is re-measured.** `beginDrag` builds a
`frameCandidateIndex`: every `[data-node-id]` rect in the frame (in
viewport-local/frame-space coordinates), plus the viewport's client origin
and the live canvas scale. Both are constant for the length of an ordinary
drag, so both are measured exactly once. Two things invalidate them, and
only two:

- **A real reflow** — a `ResizeObserver` on the frame body sets
  `index.stale`, and the next rAF rebuilds the candidate rects. Nothing
  polls.
- **A real transform change** — the index remembers the `CanvasTransform` its
  origin was measured under and compares against D1's **live `transformRef`**
  (`CanvasViewportActionsContext`), never the store's `zoom`/`panX`/`panY`,
  which are the ~100 ms-debounced commit values and lag a gesture by design.
  Auto-pan is the case that makes this necessary: it moves the layer under a
  stationary pointer.

Candidate rects themselves survive a pan or a zoom untouched — they are
stored in frame space, and a pure translate/scale of the transform layer
cancels out of both terms of `(clientLeft - viewportClientLeft) / scale`.
Only the POINTER's conversion needs a fresh origin.

**One rAF does the whole visual half**: refresh the index, resolve the drop
target, compute the auto-pan delta (READ phase), then paint (WRITE phase).
Reads and writes are never interleaved. The frame re-arms itself only while
auto-pan is still moving the canvas, so a stationary pointer costs nothing.

**Escape cancels**, because the tree was never touched — cancelling is just
dropping the session. Listened for on the parent document AND the frame's own
document, since a keystroke raised inside an iframe never reaches the parent
window. **Shift constrains the axis** (`constrainToDragAxis`), applied in
client space before the frame-space conversion so the locked axis is the one
the user sees. **The ghost follows the cursor exactly**, painted from the same
pointer position the resolution used, in the same frame.

**`pointerup` resolves any still-pending frame synchronously** before
committing, so a flick whose last move and release land inside one animation
frame commits the position the user actually pointed at.

---

## Alt+drag duplicates (K2)

Hold Alt and the same drag drops a **copy**. Two surfaces, one gesture,
different mechanics because they write to different places.

### Elements

Alt is read off **every pointer event**, never latched at `pointerdown`:
release it mid-drag and the drop is a move again; press it mid-drag and the
same drop becomes a copy. The ghost shows a `+` while it is held, which is
therefore an honest readout rather than a decoration. The commit reads the
modifier state at **release**.

`pointerup` routes to `duplicateNodesTo(ids, parentId, index)` instead of
`moveNodes`. On a studio-imported tree that is **one source write**:

```
duplicateNodesTo
  └─ writeDuplicateToSource(ids, { parentId, index })
       ├─ deferWhileStructuralCommitInFlight(…)      ← same store-14 queue as ⌘D
       ├─ planSourceDuplicateTo(tree, ids, parentId, index)
       └─ commitStudioDuplicate([nodeId], { parentNodeId, anchorNodeId, position })
            └─ POST /studio/save  { kind: 'duplicate', nodeId, parentNodeId, … }
                 └─ duplicateJsxElement({ …, destinationLine, destinationCol, anchorLine, … })
```

`planSourceDuplicateTo` composes the two questions the gesture is made of, so
**Alt+drag refuses for exactly the reasons the same drag without Alt would**:

| Question | Answered by | Refusals it carries |
|---|---|---|
| May this element be copied at all? | `refuseStructuralEdit({ kind: 'duplicate' })` — the identical question ⌘D asks | `list-row`, `shared-component`, `route-chrome`, `code-placed` |
| May it land *there*? | `previewStructuralMove` — the identical question a plain drag asks | `cross-file`, a container that is not an ordinary element, `insert` |

Plus one of its own: a **multi-node** Alt+drag refuses as `multi-select` — the
session resolves one drop target, and N copies dropped at one position would
have to be ordered against each other inside a child list each of them is
shifting. All of these reach the user through `RefusalDialog` (or the toast,
for the remedy-less reasons) — the same channel a refused move uses.

The **commit** is an insert's, not a move's. `previewStructuralMove` resolves
its anchor from the child list with the dragged node *removed*, because that is
what a move does to it; a copy removes nothing, so the same index names a
different neighbour. `resolveContainerAnchor` — `planSourceInsert`'s own
resolver — is the honest one here, and a duplicate-to is precisely an insert of
markup that already exists.

`duplicateJsxElement` grew a second form to match (`destinationLine` /
`destinationCol`, mirroring `moveJsxElement`'s reorder/reparent split). It is
**one text edit**, not two — there is nothing to remove, so no last-first
`applyTextEdits` ordering and no `exclude` range for the placement to step
around. It refuses `into-own-descendant` (the copy would land inside itself)
and `out-of-scope` (markup lifted out of a `.map` callback loses the row it
read) — the latter through the same `freeVariablesOutOfScopeAt` a reparent
uses, because a copy landing where its bindings do not exist breaks the file
exactly as a move would.

On a CMS / Visual Component tree there is no file to disagree with, so
`duplicateNodesTo` degrades to "duplicate in place, then move the copies" —
reusing `duplicateNodes` (which already owns per-node scoped-class cloning and
the one-outlet guard) rather than re-implementing either.

### Board frames

Alt is **latched at `pointerdown`**, not read live — a frame copy is a real
object in `boards.json` the moment it exists, so letting the modifier toggle
mid-gesture would mean creating and destroying a board frame on every keypress.

The copy is spawned on the **first pointermove**, not at `pointerdown`, so a
plain Alt+click that never travels leaves no stray frame. From then on the
drag moves the copy (`DragState.movingFrameId`) and the original never hears
about the gesture again. Escape removes the copy outright.

`duplicateFrameAt(sourceFrameId, x, y)` is a cheap `boards.json` write through
the same pure `duplicateFrame` transform "duplicate as variant" uses — it
never touches the user's source. It is coalesced under the copy's own move key
so the spawn and every subsequent move collapse into one undo entry: ⌘Z after
an Alt+drag removes the copy rather than walking it back across the board
first.

The gesture is documented in the `?` sheet as a virtual, never-matching
`keybindings.ts` entry (`canvas.altDragDuplicate`) — that array *is* the sheet,
and documenting a gesture anywhere else would fork the registry's
single-source-of-truth gate.

---

## Free movement (K6)

§15 decision 3 of the parity plan stands: **Studio does not fake absolute
placement of flow elements.** Dragging an ordinary element still reorders it,
and the canvas still shows the reflow that implies. What §6 decision 6 of the
feel plan grants is narrower and explicit — a gesture may write `left`/`top`
as an INLINE STYLE, which is one JSX element's `style={{…}}` and therefore one
honest target, in exactly two cases. `canvasFreeMove.ts` owns the whole thing.

| The element is… | ⌘/Ctrl held? | What happens |
|---|---|---|
| `position: absolute \| fixed` | not needed | the drag writes `left`/`top` — that is already the property deciding where it is, so dragging it into the child order would be the surprising behaviour |
| in flow, parent is positioned | yes | the drag writes `position: absolute` **and** `left`/`top`. Writing the offsets alone would do nothing at all on a static element, and a declaration with no effect is exactly the silent no-op this codebase refuses |
| in flow, parent is `position: static` | yes | **refuses** — see below |
| in flow | no | ordinary reorder |

**The refusal, and its remedy.** Absolutely positioning an element inside a
static parent hands it to the nearest *positioned* ancestor, or to the
viewport — not to the container the user dropped it in. So a ⌘-drag there
refuses through `RefusalDialog`, with the one remedy that is actually true:
make that container `position: relative`. This is the only
`EditConstraintAction` whose handler is a **write** rather than a navigation
(`position-parent-relative`), and therefore the only one the engine cannot
run: the handler is injected by `ConstraintActionButtons`, the same way
`jump-to-source`'s `openSource` already is, because `constraintActions.ts`
sits inside the store's own import graph and may not import the composed store
back. It is also the one refusal in `editConstraint.ts` that is NOT a
source-writability question: the file would take the write; the CSS would not
do what was pointed at.

**RTL.** In a right-to-left element the physical `left` is the wrong property:
a drag to the right must DECREASE the distance from the inline start. The
write is `inset-inline-start`, with the horizontal delta negated. `top` is
unaffected — RTL mirrors the inline axis only, never the block axis.

**Snapping.** The moved rect snaps to its SIBLINGS' edges and centres through
`computeSnap` — the same pure resolver board furniture already uses, at the
same "closest wins, at most one snap per axis" contract, at
`FREE_MOVE_SNAP_PX` in frame space. Guides are painted by the same imperative
painter as everything else the drag draws, from a pool of at most two
elements. Peers are read once from the drag session's candidate index, because
siblings do not move while one element is being positioned.

**Preview, then commit.** The step is written straight onto the element's own
`style` during the drag — no store round trip, so it tracks the pointer at
frame rate and the selection ring (which re-measures the real element) follows
for free. The preview is dropped BEFORE the store commit, never after: they
are the same DOM property, so clearing it afterwards would delete exactly what
React just wrote. Same shape, and the same reasoning, as
`useElementResizeDrag`.

**A free move resolves no drop target and runs no auto-pan.** The two are
different gestures: one places inside a container, the other looks for a
position in a child list.

**Modifier state is read per event, not latched**, exactly like Alt — press ⌘
mid-drag and a reorder becomes a placement, release it and it goes back. The
resolution itself is cached on the session (it reads computed style, which is
a layout read) and re-taken only when the modifier flips.

---

## Drop overlay

The overlay highlights the resolved drop position. Geometry comes from the resolver or, for insert sources, from `canvasInsertionDrop.ts`'s fixed preview helpers:

- **Before / After** — a thin sky-tinted line (`--accent-3` at 0.6 alpha) at the zone position.
- **Into** — a sky-tinted dashed outline inset 4px from the target's bounding box.
- **Invalid** — a danger-tinted outline (`--danger`) + a tooltip explaining why (`'cannot drop into self'`, `'target is locked'`).

**For the canvas node reorder the overlay is NOT a React tree.** React renders
one empty, click-through layer per frame (`CanvasDropIndicators`, in the
breakpoint viewport — already inside `CanvasTransformLayer`, which is why the
frame-space rects go in unconverted) and never gives it children.
`canvasDragPainter.ts` creates, positions, and hides the drop line, the
refused-position box, the refusal chip and the drag ghost inside it, through
the `--canvas-drop-*` custom-property channel, skipping every write whose
value is unchanged. Same division of labour as the selector-affinity ring
pool (`syncSelectorHighlightRings`), for the same reason: a pointermove must
not cost a React commit. Insert-source overlays (`useCanvasInsertionDrag`)
still render from React — they are not in a per-pointermove path.

There is a SECOND, board-level layer: `CanvasFileDropHint`, a sibling of
`CanvasTransformLayer` in untransformed parent-document space. It exists for
exactly one case — an OS file drag over the empty board, where there is no
frame and therefore no frame layer to put a chip in, and where a chip painted
into some frame's layer would be clipped by that frame's `overflow: hidden`
viewport. It declares `--canvas-zoom: 1` in its own rule because the ghost the
painter creates counter-scales by `1 / var(--canvas-zoom)` and there is nothing
to counter outside the transform.

---

## The reflow preview (K6)

While an element drag is in flight, the siblings that would MAKE ROOM for the
drop slide out of the way. `canvasReflowPreview.ts` decides which and how far;
`canvasDragPainter.ts` moves them.

**The real siblings never move.** What travels is a pooled ghost box drawn over
each one, in the frame's own drag layer — the parent document, not the iframe.
Writing a `transform` onto the user's own element would create a containing
block and a stacking context inside their page mid-gesture (changing what their
`%` chains and `backdrop-filter`s resolve against), and an abandoned gesture
would leave it behind. Same reasoning `smartAnimateFlip.ts` records for the
prototype player's own FLIP.

**Zero layout reads.** Every rect comes from the drag session's
already-measured `frameCandidateIndex`, and the answer is recomputed only when
the resolved `(parent, index)` actually changes — a pointer moving inside one
drop zone costs nothing. Zero React commits, like everything else the drag
draws.

**The packing model.** A container's children are packed along ONE axis with a
uniform gap (read off the first pair). The final order is computed the way
`moveNode` computes it — remove the dragged run first, then splice at
`newIndex`, which is what that index counts — and each remaining child is
re-packed from the container's content start using its OWN extent. Heterogeneous
child sizes are therefore exact. Both containers are previewed for a same-frame
reparent (the destination opens, the origin closes); a cross-frame drop previews
the DESTINATION only, because the origin frame's layer is not the one being
painted. Alt opens without closing: a copy removes nothing.

**Three silences, all deliberate.** It returns nothing — no animation, no
guess — when a child has no measured box (`display: contents`, a fragment),
when the children are not monotonic along the axis (a wrapped flex line, a
multi-row grid, an absolutely-positioned child), or when the parent is
`reversed` (`row-reverse` / `column-reverse` / an RTL row, where DOM order and
visual order disagree). The drop line still says exactly where the element
lands; no sibling claims to move somewhere it would not.

**The animation.** WAAPI, ~120ms, `translate` only. WAAPI rather than a CSS
transition because a transition interpolates from the previous computed style,
which an element created in the same task does not have and which nothing in
the write phase may read anyway; retargeting mid-travel reads the eased
`getComputedTiming().progress` off the running animation instead of off the
DOM. `translate` rather than `transform` because `transform` is the rect
channel — sharing them would make a re-measure slide the box across the frame.
The pool is fixed (`REFLOW_SHIFT_LIMIT`) and created with the rest of the drag
chrome; boxes hide with `opacity` and `data-shifting`, never `display: none`,
because a `display: none` element cannot travel. `prefers-reduced-motion` is
asked in script (`playbackMotion.ts`'s `prefersReducedMotion`), since the
global CSS clamp cannot see a scripted animation.

---

## The file-drag preview (G15)

An OS file drag answers before release, through the same painter and the same
layers an element drag uses. `canvasFileDragPreview.ts` decides;
`useCanvasFileDrop` runs one rAF per `dragover` and paints. Zero React commits
— the hook holds no state at all.

| Where the pointer is | What is drawn |
|---|---|
| Over a container in a frame | The drop line an element drag would show, plus a cursor chip naming the format ("PNG image") |
| Over a frame, nothing can hold a child | The refused-position box and "Nothing here can hold an image" |
| Over the empty board | "Drop onto a frame", in the board-level hint layer |
| A non-image, anywhere | The refusal naming the declared type, and NO drop line |
| More than one file | "One image at a time" |

**One verdict, two moments.** Every refusal comes from `canvasFileDrop.ts` —
`refuseDroppedFile` for the file itself, `CANVAS_FILE_DROP_REFUSAL` for the two
that need geometry. The preview is not a second rule that agrees; it is the
same rule asked earlier, so the chip and the toast cannot drift. A
`CanvasFileDropRefusal` carries both a one-line `headline` (the chip) and the
whole `message` (the toast).

**The chip cannot name the file, and must not pretend to.** Before `drop` the
drag data store is in the HTML spec's *protected mode*: `DataTransfer.files` is
empty and `DataTransferItem.getAsFile()` returns `null`. Only `items[i].kind`
and `items[i].type` are readable — a count and a declared MIME type, **no name
and no size**. `DroppedFileFacts` is that reduced shape, and both halves of the
gesture are written against it.

**The board machinery is the element drag's own.**
`measureBoardDropSurfaces` / `refreshBoardDropSurfaces` /
`resolveForeignFrameDrop` answer exactly the questions a file drag asks and
already cache on the right signals; a file drag has no origin frame to be
foreign to, so it passes `originPageId: null`. There is no second viewport test.

**Three teardown events, not one.** `drop` ends a gesture that landed,
`dragleave` with `relatedTarget === null` one that left the window, and
`dragend` one the source abandoned (Escape, or a release outside the browser).
Miss any and the chip is left painted over the board.

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

**Insert-at-a-point insertion** (`useCanvasInsertionDrag.ts`) resolves through
`resolveCanvasPointerInsertionDrop` on every pointer move and commits
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
- **One store write per pointermove, not two (D2 G8).** A furniture drag calls `setBoardSnapGuides` alongside `setFramePosition` on every move, and on the overwhelming majority of those events the guide list is identical to the last one (usually empty). `setBoardSnapGuides` now no-ops when `snapGuidesEqual(current, next)` — so the second write costs nothing until the guides actually change.
- **Escape cancels a frame drag (D2 G8).** Unlike the element drag (which writes nothing until `pointerup`), a frame drag writes its position live, so cancelling restores the position captured at `pointerdown` (`DragState.frameX/frameY`), clears the guides, and closes the `store-09` coalescing burst. The listener is on `window`, not the header: the pointer is captured but keyboard focus is not.
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

**On the DOM panel** (the real `@dnd-kit/core` surface): don't add raw
`dragstart` / `dragend` listeners — `@dnd-kit` owns those. Put drop-reaction
logic in `onDragEnd` (in the page that owns that `<DndContext>`).

**On the canvas** (reorder, insert-at-a-point — neither of them `@dnd-kit`):
there is no `onDragEnd` to hook into. React to the resolved target in
`handleWindowPointerUp` (`useCanvasReorderDrag.ts`) or the pointerup handler
that closes the gesture (`useCanvasInsertionDrag.ts`).

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
  - `src/admin/pages/site/canvas/canvasInsertionDrop.ts` — pointer-to-canvas insertion target + fixed preview geometry for pointer-driven insert sources
  - `src/admin/pages/site/canvas/CanvasRoot.tsx` — mounts NO `<DndContext>`; the canvas reorder drag is raw pointer events
  - `src/admin/pages/site/canvas/useCanvasReorderDrag.ts` — the canvas reorder drag-state hook (raw pointer, not dnd-kit)
  - `src/admin/pages/site/canvas/canvasPointerRelay.ts` — cross-iframe pointer relay the reorder drag depends on
  - `src/admin/pages/site/panels/DomPanel/DomPanel.tsx` — the DOM panel's own `<DndContext>` (`autoScroll={false}` — see `useDomPanelDnd.ts`'s own auto-scroll)
  - `src/admin/pages/site/panels/DomPanel/useDomPanelDnd.ts` — DOM panel drag-state hook (real `@dnd-kit/core`)
  - `src/admin/shared/media/hooks/useMediaDnd.ts` / `src/admin/shared/media/utils/mediaDragDrop.ts` / `src/admin/shared/media/utils/mediaDnd.ts` — Media workspace native HTML5 DnD, incl. the `dragover` protected-mode session mirror
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

## The D2 target architecture, and how much of it exists

The drag-and-drop audit of 2026-08-06 (`docs/audits/2026-08-06/07-drag-and-drop.md`) found sixteen drag surfaces, four incompatible mechanisms, six drop resolvers and three index-normalisation implementations. The target it set, which `src/__tests__/architecture/single-drag-mechanism.test.ts` points to when it fails:

- **One drag session** per gesture, replacing the `data-studio-canvas-dragging` global attribute and the inline pointer loops. Pointer moves write a ref; one `requestAnimationFrame` resolves and paints; React state is committed **once**, on `pointerup`. The pattern to copy is `src/admin/shared/FloatingWindow/useDraggablePanel.ts`, which writes CSS custom properties during the move.
- **A candidate index measured once per drag**, board-wide, so a drop can land in another frame and no `pointermove` forces layout.
- **One source-aware drop resolution** that calls `previewStructuralMove`, so a refusal shows **while the pointer is still down**.
- **Three thin adapters** over that core: canvas, tree row, board furniture.
- **`@dnd-kit/core` removed.** It cannot cross the iframe boundary, which is why the canvas drag was hand-rolled beside it; under the no-old-and-new rule, one mechanism survives.

What exists today:

| Target piece | State | Where |
|---|---|---|
| Canvas reorder as one session, zero React commits and zero forced layout per move, Escape cancels, Shift locks the axis | built | `useCanvasReorderDrag.ts`, `canvasDragSession.ts`, `canvasDragPainter.ts` ("The drag session (S2)" above) |
| Pressing an element body starts the same session as the hand-grab | built | `useCanvasBodyDragTrigger.ts` ("Body drag" below) |
| A drag that crosses into another frame moves the markup between files | built | "The reflow preview (K6)" and the cross-frame transplant (`transplantJsxElement.ts`) |
| Insertion drags measure each frame's candidates once per drag, resolve per animation frame, against the frame under the pointer (static or live) | built | `useCanvasInsertionDrag.ts`, `canvasInsertionDragSnapshot.ts` |
| Refusal preview while the pointer is down (G5) | built | "Source-writeback refusal preview (G5)" above |
| Board furniture: Escape abandons a frame drag | built | `BoardFramesLayer/useBoardFrameMoveDrag.ts` |
| File dropped from the operating system onto the canvas | built | "The file-drag preview (G15)" above |
| A tree-row adapter on the same session core | **not built**: the DOM panel's layer tree still runs its own `@dnd-kit/core` drag (`useDomPanelDnd.ts`) | |
| `@dnd-kit/core` removed | **not built**: `AdminCanvasEditorBody.tsx` and the DOM panel still import it; `single-drag-mechanism.test.ts` pins every user to an allowlist | |
| No `KeyboardSensor` on the `@dnd-kit` context | **gap**: a `@dnd-kit` drag has no keyboard path; `Alt+↑`/`Alt+↓` reorder is the keyboard alternative | `keybindings.ts` |

Native HTML5 drag-and-drop stays where it is the only API that works: a file or folder dragged in from the operating system (`DataTransfer.files`, `webkitGetAsEntry()`), and the media picker's folder tree. Each such file is on the gate's allowlist with its reason.

---

## Body drag: what stands down, and why

The body-drag listener is a *global* gesture on the frame document, so it has
to hand the pointer back to every other gesture that shares the same button.
It bails, in this order, on:

| Condition | Whose gesture it is |
|---|---|
| `bodyDragEnabled` false | No `site.structure.edit` capability, or this is not the active breakpoint frame |
| `overlayRoot` is `null` | Not a design frame. `CanvasSelectionOverlayInjector` is design-mode-only, so a live / prototype frame never has one and a press there must behave exactly like the published page |
| `event.button !== 0`, or space held | The canvas PAN gesture (`shouldStartCanvasPointerPan`) |
| `activeInlineEdit` is set | The contentEditable inline text editor owns the pointer — a press-and-drag there is selecting text. Same stand-down the keyboard bridge makes (`useIframeEventForwarding`'s `onKeyDown`) |
| target inside `[data-studio-canvas-overlay-root]` | Editor chrome portaled into this same document (WS-5.1). In practice the resize handles — `useElementResizeDrag`'s gesture |
| target inside `[data-canvas-interactive="true"]` | An editor control rendered by a module |
| target inside `[contenteditable]` | The caret is the user's target |
| no `[data-node-id]` ancestor | Frame background — marquee / body context menu |
| the node is the tree root, locked, or absent from the ACTIVE tree | Nothing honest to move (`resolveDraggedIds`) |

Two more properties are load-bearing:

- **The origin is translated to parent client coordinates**
  (`iframeLocalPointToParentClientPoint`) before the session stores it. A press
  inside an iframe reports iframe-local coordinates, but every subsequent
  `pointermove` reaches the hook's `window` listeners in parent coordinates —
  natively once the cursor leaves the frame, or minted by
  `IframeFrameSurface`'s relay while it is inside. An untranslated origin makes
  the first move look like a jump of the whole iframe offset, which clears the
  4px activation distance instantly and turns every click into a drag.
- **`preventDefault()` on the pointerdown, but nothing else.** Canceling
  `pointerdown` suppresses the compatibility MOUSE events (and with them native
  text selection and the browser's image/link drag) — `click` still fires, so
  `NodeRenderer`'s click-to-select is untouched and a press that never travels
  4px is still an ordinary click. Focus is unaffected because `NodeRenderer`
  focuses the node explicitly (`focusNodeWithoutScrolling`) rather than relying
  on the default action.
