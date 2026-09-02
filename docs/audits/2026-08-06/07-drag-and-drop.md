# Audit 07 — Drag and Drop

Read-only audit. Repo: `c:\Users\Admin\Documents\GitHub\Figma Killer 2`, branch `feat/alm-figma-killer-studio-shell`.
Scope: every DnD surface in the tree. No code written, no browser tests run.

---

## Surface matrix

| # | DnD surface | Mechanism | Works? | Main defect |
|---|---|---|---|---|
| 1 | Canvas node reorder (element move) | **Raw pointer events** + window listeners + cross-iframe relay (`useCanvasReorderDrag.ts`) | Partially | Only draggable from the selection-toolbar hand-grab button — you cannot grab the element itself. Confined to ONE frame. Refusal is post-hoc. |
| 2 | Layer tree / DOM panel reorder | **@dnd-kit/core** `DndContext` + `useDraggable`, custom geometry (`useDomPanelDnd.ts`) | Yes | Double auto-scroll (dnd-kit's + the hook's) makes drops near the scroll edge un-resolvable; refusal post-hoc; no keyboard sensor. |
| 3 | Board frame move + resize | **Raw pointer capture** (`BoardFramesLayer.tsx`) | Yes | 2 Zustand writes per `pointermove`; no multi-frame drag; no Escape; snap peers keyed by `pageId` so variants never snap. |
| 4 | Sticky notes / doc cards | **Raw pointer capture** (`StickyNoteView.tsx`, `DocBlockView.tsx`) | Yes | Same per-move store-write cost; identical code triplicated. |
| 5 | Module palette → canvas | **Raw pointer events**, own ghost (`ModuleInserterDialog.tsx`) | Partially | Re-measures EVERY node in the frame on EVERY pointermove; resolves against the *active* page while the pointer may be over a different frame. No auto-pan, no Escape. |
| 6 | Media asset → canvas | **Raw pointer events** (`useMediaCanvasInsertionDrag.ts`) | Partially | Byte-for-byte the same defects as #5 (copy of the same loop). |
| 7 | Site Explorer rows / folders | **@dnd-kit/core** via `useDndMonitor` on the outer `DndContext` (`useSiteExplorerDnd.ts`) | Yes | Isolated context; no keyboard sensor; index math duplicated a third time. |
| 8 | Media workspace (folders/assets) | **Native HTML5 DnD** + `dataTransfer` (`useMediaDnd.ts`, `mediaDragDrop.ts`) | Partially | `getData()` is unreadable during `dragover` in real browsers → illegal drops highlight as valid, then silently no-op. |
| 9 | Dashboard grid + block library (dormant CMS) | **@dnd-kit/core** `useDraggable`/`useDroppable` | Yes | Separate `DndContext`, separate collision model, unrelated to the other three. |
| 10 | Floating panels (Properties, Agent, Code editor, Media viewer) | **Raw pointer capture, ref/CSS-var driven** (`useDraggablePanel.ts`) | Yes | **The only well-implemented drag in the repo** — position written to CSS vars during move, state committed once on pointerup. Use as the model. |
| 11 | Panel/list resize handles (`StudioBoardsList`, `CanvasLiveSurface`, block library) | Raw pointer capture | Yes | `onHeightChange` fires per move (React state), no ref path. |
| 12 | Marquee frame selection | Raw pointer events on canvas root (`useMarqueeSelection.ts`) | Yes | `setState` + `setSelectedFrameIds` per pointermove, no RAF. |
| 13 | Image file drop → Properties panel | Native HTML5 (`ImageSourceSection.tsx:114-133`) | Yes | Fine, but it is the ONLY file drop target in Studio. |
| 14 | File drop → canvas / board | **Does not exist** | No | Dropping an image/zip on the board does nothing (browser default). |
| 15 | File drop → Studio import dialog | **Does not exist** (`ImportProjectDialog.tsx` has no `onDrop`) | No | The dormant CMS `SiteImport/steps/DropStep.tsx` has one; the live Studio importer does not. |
| 16 | Drag between two frames / pages | **Does not exist** | No | Structurally impossible in the current design (see G3). |

**Four mechanisms, six independent drop-target resolvers, three separate index-normalisation implementations.**

---

## Findings

### G1 — Four incompatible DnD mechanisms coexist, and the reference doc is materially false
**Severity: High (architectural)**

`docs/reference/canvas-dnd.md:11` states:
> "`@dnd-kit/core` is the only DnD library. No `react-dnd`, no native HTML5 drag-and-drop."

and `:12`:
> "The canvas's `<DndContext>` lives at `CanvasRoot.tsx`. Every `BreakpointFrame` is inside it."

and `:221`:
> "The canvas's `NodeRenderer` registers each node as `useDraggable({ id: \`node:${nodeId}\` })`"

All three are false:
- `CanvasRoot.tsx` contains no `DndContext` (grep for `DndContext` across `*.tsx` returns only `AdminCanvasEditorBody.tsx:94`, `DomPanel.tsx:493`, `DashboardGrid`/`BlockLibrary`, and test files).
- `NodeRenderer.tsx` contains no `useDraggable` — its only pointer hook is `onPointerDownCapture` at line 334 (selection, not drag).
- Native HTML5 DnD is live in the Media workspace: `src/admin/shared/media/utils/mediaDragDrop.ts:39-50` (`dataTransfer.setData`, `effectAllowed`), `MediaCanvas.tsx:205/213/228`, `MediaFolderPanel.tsx:201`, `ImageSourceSection.tsx:127-132`, `DropStep.tsx:89-92`.

The doc's "Forbidden patterns" table (`:253-261`) bans exactly what ships. **There is no architecture gate for it** — `src/__tests__/architecture/` has no DnD rule test (only `bundle-size-budgets`, `button-primitive-usage`, `site-editor-shell-lazy-body` mention the string).

**Root cause:** the doc describes a design that was replaced by `useCanvasReorderDrag.ts` (pointer-based, for cross-iframe reasons) and never updated. Nothing enforced it.

**Fix:** rewrite `docs/reference/canvas-dnd.md` against reality, and add `src/__tests__/architecture/dnd-single-engine.test.ts` asserting the allowed mechanisms per directory.
**Effort: S** (doc + gate). Depends on G-Arch decision below.

---

### G2 — You cannot drag an element on the canvas; only a toolbar button
**Severity: High (product)**

The canvas reorder drag is armed exclusively by the selection toolbar's hand-grab button:

`src/admin/pages/site/canvas/SelectionToolbar.tsx:74-83`
```tsx
<Button variant="secondary" size="xs" iconOnly
  aria-label="Drag selected layers" tooltip="Drag selected layers"
  className={cn(styles.selectionToolbarButton, styles.dragToolbarButton)}
  onPointerDown={onDragPointerDown}>
  <HandGrabSolidIcon size={13} color="var(--text)" />
</Button>
```
`BreakpointSelectionOverlay.tsx:539-540` is the only wiring of `reorderDrag.handlePointerDown`.

So the Figma gesture — press an element, move it — does nothing. The user must (1) click to select, (2) find the floating toolbar, (3) press a specific 13px button, (4) drag. And the toolbar itself is placed by parent-doc geometry that `canvas-internals.md:429-431` documents as the known "menu far from the element" drift defect, so the handle can be visually detached from the thing it moves.

**Root cause:** the drag was bolted onto the toolbar because `NodeRenderer` lives inside an iframe and the original dnd-kit design could not reach across the boundary.

**Fix:** move drag arming into the iframe. `EditorChromeInjector`-styled `data-node-id` elements already receive `onPointerDown` for selection (`NodeRenderer.tsx:334`); promote that to a press-and-move gesture with the same `DRAG_ACTIVATE_PX` threshold, and emit a synthetic drag-start to the parent through the existing relay. Keep the toolbar handle as a secondary affordance.
**Effort: M.** Files: `NodeRenderer.tsx`, `useCanvasReorderDrag.ts`, `IframeFrameSurface.tsx`, `SelectionToolbar.tsx`.

---

### G3 — A drag can never leave the frame it started in (silent no-op)
**Severity: High**

Drop candidates are measured once, from ONE iframe, at pointerdown:

`useCanvasReorderDrag.ts:295-307`
```ts
sessionRef.current = {
  pointerId: event.pointerId,
  draggedId, draggedIds,
  candidates: measureCanvasDropCandidates(viewport, tree, iframeElement),
  originX: event.clientX, originY: event.clientY,
  active: false,
}
```
`iframeElement` is the prop of the single `BreakpointSelectionOverlay` instance that owns this drag, and `BreakpointSelectionOverlay` is mounted **per frame** (`BreakpointFrame.tsx:264`). `tree` is `selectActiveCanvasPage(...)` — one page.

Consequences on a Studio board (many frames, many pages):
- Drag a node from frame A and release it over frame B → `findCanvasDropCandidate` (`canvasDnd.ts:249-261`) finds no containing rect → `{target: null}` → `handleWindowPointerUp` returns at `useCanvasReorderDrag.ts:248` (`if (!target) return`). **Nothing happens and nothing is said.** Indistinguishable from a bug the user will report as "drag is broken".
- Drag between two variant frames of the SAME page (WS-10 Phase 2 "duplicate as variant") — same failure.

**Root cause:** the drop-candidate model is frame-scoped by construction (`measureCanvasDropCandidates(viewport, tree, iframe)` takes exactly one of each).

**Fix:** hoist the drag session to a board-level singleton that measures candidates per frame lazily (on first hover of that frame), keyed by `(frameId, pageId)`, and resolves the target against the tree that frame renders (`selectCanvasPageFor(s, pageId, frameId)` already exists in `store.ts`). Cross-page moves must additionally consult `refuseStructuralEdit` (G5) — they will refuse, but they must refuse *audibly*.
**Effort: L.** Files: new `canvas/boardDragSession.ts`, `useCanvasReorderDrag.ts`, `BreakpointSelectionOverlay.tsx`, `BoardFramesLayer.tsx`, `canvasDomGeometry.ts`.

---

### G4 — The cross-iframe relay is a global document attribute + a duplicated event stream
**Severity: Medium**

`canvasPointerRelay.ts:9-19`
```ts
export function markCanvasPointerRelay(pointerId: number): void {
  document.documentElement.dataset.studioCanvasDragging = '1'
  document.documentElement.dataset.studioCanvasDraggingPointerId = String(pointerId)
}
```
Every `IframeFrameSurface` polls that flag and re-dispatches:

`IframeFrameSurface.tsx:574-583`
```ts
const dragSignal = isCanvasDragActive()
if (dragSignal && (e.type === 'pointermove' || e.type === 'pointerup' || e.type === 'pointercancel')) {
  forwardPointer(e, dragSignal.pointerId)
  return
}
```
`forwardPointer` (`:523-545`) mints a new `PointerEvent` and dispatches it **on the iframe element**, so it bubbles to the parent `window` where `useCanvasReorderDrag`'s listeners sit.

Problems:
1. **The parent stream is not suppressed.** `handlePointerDown` also calls `setPointerCapture` on the toolbar button (`useCanvasReorderDrag.ts:286-293`). Pointer capture retargets the pointer to the capturing element *in the capturing document*, so while the cursor is over an iframe the parent frequently still receives its own `pointermove` **and** the relayed one → `resolveAtClientPoint` runs twice per physical move. The code's own comment (`:203-211`) admits it cannot reconcile the two and treats the session as a singleton instead.
2. **Singleton by design.** `handleWindowPointerMove` (`:212-214`) accepts *any* pointermove while a session exists — it never checks `session.pointerId`. A second pointer (touch, pen, a second mouse) drives the drag.
3. **Global mutable state.** Three unrelated modules set/clear the same attribute: `useCanvasReorderDrag.ts:316/198`, `ModuleInserterDialog.tsx:394/350`, `useMediaCanvasInsertionDrag.ts:112/108`. If two ever overlap, the first `clearCanvasPointerRelay()` kills the other's relay.
4. **No cleanup on unmount mid-drag** for `ModuleInserterDialog` — its `Escape` handler (`:215`) closes the dialog, unmounting it while `window` still holds `move`/`up`/`cancel` listeners registered at `:395-397`; only a subsequent pointerup clears them.

**Fix:** replace the attribute with a module-level singleton `dragBus` object exposing `begin(session)/end()` and a subscriber list; have `IframeFrameSurface` subscribe rather than poll a DOM attribute, and have the bus own suppression of the duplicate parent stream (release pointer capture once the pointer enters an iframe).
**Effort: M.** Files: `canvasPointerRelay.ts` → `canvasDragBus.ts`, `IframeFrameSurface.tsx`, the three drag hooks.

---

### G5 — Structural refusal happens AFTER the drop, never before
**Severity: High (UX)**

The drop-target resolver knows nothing about source writability. `src/core/page-tree/dnd.ts:34-117` checks only: root, missing node, `locked`, self/descendant cycle, VC-ref/slot rules, and no-op. It never calls `refuseStructuralEdit`.

The refusal fires only inside the store, after `pointerup`:

`src/admin/pages/site/store/slices/site/nodeActions.ts:548-565`
```ts
moveNodes: (nodeIds, newParentId, newIndex) => {
  if (nodeIds.length === 0) return
  const tree = readTree()
  const plan = tree ? planSourceMove(tree, nodeIds, newParentId, newIndex) : null
  if (plan && !plan.ok) {
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, plan.refusal)
    return
  }
  ...
```
`planSourceMove` refuses reparenting outright (`structuralSourceEdits.ts:88-97`), and refuses a reorder whose anchor is a `.map` row / inlined component / shared component (`:110-123`).

So the user sees a crisp, confident drop indicator (`BreakpointSelectionOverlay.tsx:656-664`), releases, the element does not move, and a toast appears. This is the shipped, *tested* behaviour: `tests/e2e/structural-writeback.e2e.ts` test 2 asserts "dragging an element into a DIFFERENT parent surfaces `role="alert"` with the reparent reason, the layers tree is unchanged". `STATE.md:3903` confirms.

Per `STATE.md:3894`, `shared-component` is "the biggest bucket (48.5%)" of refusals — so on a real imported project roughly half of all drags end in a post-hoc toast.

**Root cause:** the gate lives in the store (correct — it is the chokepoint for every surface) but nothing exposes it to the *preview* path.

**Fix:** extract a pure `previewStructuralMove(tree, nodeIds, parentId, index): StructuralRefusal | null` from `planSourceMove` (it is already pure apart from the commit), call it from `resolveCanvasDropTarget`/`resolveDomDropTarget`, and return `{invalid: {..., reason}}` instead of a valid target. Render the existing `.invalidDropIndicator` (`BreakpointSelectionOverlay.module.css:293-297`) plus the reason string next to the cursor. The toast then only fires for genuinely stale targets.
**Effort: M.** Files: `structuralSourceEdits.ts`, `core/page-tree/dnd.ts`, `canvasDnd.ts`, `domPanelDnd.ts`, `BreakpointSelectionOverlay.tsx`, `TreeNode.tsx`.

---

### G6 — Palette/media insertion drags re-measure the whole frame on every pointermove
**Severity: High (perf)**

`ModuleInserterDialog.tsx:354-368`
```ts
const move = (moveEvent: PointerEvent) => {
  if (!started) { if (Math.hypot(...) < 6) return; started = true; ... }
  const resolved = resolvePointerDrop(moveEvent.clientX, moveEvent.clientY)
  setDrag({ item, x: moveEvent.clientX, y: moveEvent.clientY, preview: resolved?.preview ?? null })
}
```
`resolvePointerDrop` → `resolveCanvasPointerInsertionDrop` (`canvasInsertionDrop.ts:58-102`), which on **every single move**:
1. `document.querySelectorAll('[data-breakpoint-id]')` + `getBoundingClientRect()` per viewport (`:42-53`),
2. `viewport.getBoundingClientRect()` twice more (`:69`, and inside `getViewportLocalPoint`),
3. `measureCanvasDropCandidates(viewport, canvasPage, iframe)` — `iframe.contentDocument.querySelectorAll('[data-node-id]')` and `nodeVisualRect()` (`getBoundingClientRect`, recursing up to 4 levels for box-less nodes) for **every node in the frame** (`canvasDomGeometry.ts:100-157`),
4. `viewport.getBoundingClientRect()` again once per candidate inside `clientRectToViewportRect` (`:253-272`),
5. `window.getComputedStyle(parent)` once per candidate in `inferCanvasDropAxis` (`:278-292`) — a forced style resolution per node.

For the eSIM test corpus (`STATE.md:3946` cites 802 nodes on one page) that is ~800 `getBoundingClientRect` + ~800 `getComputedStyle` + ~800 more rect reads **per pointermove**, all in the parent document reading across an iframe boundary. Then a React `setState` re-renders the dialog. No RAF, no throttle, no caching.

`useMediaCanvasInsertionDrag.ts:53-76` is a verbatim copy of the same loop.

By contrast the canvas reorder drag measures once at pointerdown (`useCanvasReorderDrag.ts:301`) — correct — but *it* then calls `setDragState` per move (`:110-118`), re-rendering `BreakpointSelectionOverlay` (which also runs a RAF overlay tick) on every move.

**Fix:** measure candidates once per (frame, gesture) into the shared drag session (G3), invalidate on `MutationObserver`/`ResizeObserver` rather than per move; drive the ghost and the drop indicator by writing CSS custom properties to refs (the `useDraggablePanel.ts:136-144` pattern) and commit React state only on `pointerup`; coalesce resolution into one `requestAnimationFrame` per frame.
**Effort: M.** Files: `canvasInsertionDrop.ts`, `canvasDomGeometry.ts`, `ModuleInserterDialog.tsx`, `useMediaCanvasInsertionDrag.ts`, `useCanvasReorderDrag.ts`.

---

### G7 — Insertion drags resolve against the active page, but target the frame under the cursor
**Severity: High (silent wrong write)**

`ModuleInserterDialog.tsx:120` / `useMediaCanvasInsertionDrag.ts:24`
```ts
const canvasPage = useEditorStore(selectActiveCanvasPage)
```
but `canvasInsertionDrop.ts:64` picks the viewport geometrically:
```ts
const viewport = findCanvasViewportAtPoint(clientX, clientY)
```
and measures candidates from **that** viewport's iframe (`:79-81`) while resolving them against `canvasPage` — a different page's tree when the pointer is over a non-active board frame. Node ids from frame B are not keys in page A's `tree.nodes`, so `resolvePageTreeInsertionTarget` returns `null` (`canvasDnd.ts:184`), and the code then falls back:

`canvasInsertionDrop.ts:89-95`
```ts
if (!target) {
  return {
    location: { parentId: canvasPage.rootNodeId, index: undefined },
    preview: fixedPreviewForViewport(viewport, 'inside', `${label} at page root`),
    breakpointId,
  }
}
```
The preview highlights **frame B**, the label says "Drop at page root", and the insert lands in **page A**. On a Studio board every frame carries the same synthetic breakpoint id (`'studio'`, per `canvas-internals.md:207-211`), so `setActiveBreakpoint(resolved.breakpointId)` does not correct it either.

**Fix:** thread `frameId` out of `findCanvasViewportAtPoint` (add `data-frame-id` to the frame wrapper — `BoardFramesLayer.tsx` already knows it) and resolve against `selectCanvasPageFor(state, pageId, frameId)`. Then route the insert through the store scoped to that page.
**Effort: M.** Files: `canvasInsertionDrop.ts`, `BoardFramesLayer.tsx`/`BreakpointFrame.tsx`, `ModuleInserterDialog.tsx`, `useMediaCanvasInsertionDrag.ts`, `useInsertModule.ts`.

---

### G8 — Board furniture drag writes the store twice per pointermove
**Severity: Medium (perf) / Medium (feature gaps)**

`BoardFramesLayer.tsx:469-485`
```ts
const handleHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
  const drag = dragRef.current
  if (!drag || drag.pointerId !== e.pointerId) return
  const dx = (e.clientX - drag.startClientX) / zoom
  ...
  const snapped = computeSnap({ x: rawX, y: rawY, width, height }, peers, SNAP_THRESHOLD_BOARD_UNITS)
  useEditorStore.getState().setBoardSnapGuides(snapped.guides)
  onMove(snapped.x, snapped.y)
}
```
`onMove` → `setFramePosition` (`boardSlice.ts:494-499`):
```ts
setFramePosition: (frameId, x, y) => {
  const { boards, activeBoardId } = get()
  const board = getActiveBoard(boards, activeBoardId)
  if (!board) return
  set({ boards: upsertBoard(boards, moveFrame(board, frameId, x, y)), boardsDirty: true })
},
```
So each move: `collectPeerRects` walks every frame/note/doc on the board, `computeSnap` runs O(peers), then **two** `set()` calls each producing a new `boards` array — waking every subscriber of `boards` (`BoardFramesLayer`, `BoardNotesLayer`, `BoardDocsLayer`, `BoardGuidesLayer`, the boards persistence effect) — plus `boardsDirty` flips, re-arming the autosave debounce every frame of the gesture. `StickyNoteView.tsx:69-91` and `DocBlockView.tsx:79-95` are the same code a second and third time.

Missing capabilities on this surface:
- **No multi-frame drag** — `useMarqueeSelection.ts` selects several frames but `handleHeaderPointerDown` (`:443-467`) only ever moves `frame.id`. `docs/reference/canvas-dnd.md:195` confirms it is "deferred".
- **No Escape-to-cancel** — no `keydown` listener in any of the three views; `endDrag` (`:487-493`) only fires on pointerup/cancel. There is no start position to restore to anyway (the store was mutated in place).
- **Variants never snap.** `boardSnapping.ts:144-147` types `DraggedFurniture` for a frame as `{ kind: 'frame'; pageId: string }`, so `collectPeerRects` excludes **every** frame of that page — all "duplicate as variant" siblings. Documented at `STATE.md:2719-2721`.
- **Frame drags are outside undo** (`STATE.md:3230`, `:3437`) — by design, but it means a mis-drag is unrecoverable.

**Fix:** one shared `useFurnitureDrag({ kind, id, x, y, w, h, onCommit })` hook that writes `--frame-x/--frame-y` (and guide positions) to refs during the gesture and calls the store exactly once on pointerup; key `DraggedFurniture` for frames by `frameId`; add multi-select translation and Escape restore in the same hook.
**Effort: M.** Files: new `canvas/useFurnitureDrag.ts`, `BoardFramesLayer.tsx`, `StickyNoteView.tsx`, `DocBlockView.tsx`, `boardSnapping.ts`, `boardSlice.ts`.

---

### G9 — Insertion axis is flex-only; grid, `*-reverse`, and RTL are all wrong
**Severity: Medium (correctness) — and it directly contradicts a Studio feature**

`canvasDomGeometry.ts:278-292`
```ts
function inferCanvasDropAxis(target: HTMLElement): CanvasDropAxis {
  ...
  const style = window.getComputedStyle(parent)
  if (style.display.includes('flex') && style.flexDirection.startsWith('row')) {
    return 'horizontal'
  }
  return 'vertical'
}
```
Failure modes:
- **`display: grid` → `'vertical'`.** A grid gallery gets horizontal insertion lines drawn as horizontal bars and top/bottom edge bands, so inserting between two side-by-side cards is a coin flip. Figma and Penpot both show orientation-aware lines here.
- **`flex-direction: row-reverse` → `startsWith('row')` is `true` → `'horizontal'`,** but `getCanvasDropZone` (`canvasDnd.ts:89-93`) maps the *left* band to `'before'`. In `row-reverse` the leftmost item is the LAST child, so every before/after is inverted.
- **`column-reverse` → `'vertical'`,** same inversion on the Y axis.
- **RTL is entirely unhandled.** Studio ships an RTL preview axis (`previewAxesFrameEffect.ts` sets `dir` on the frame `<html>` — `canvas-internals.md:128-131`). With `dir=rtl` + `flex-direction: row`, visual-left is the logical END, so dropping at the visually-leftmost gap inserts at index 0 instead of index n.
- **`flex-wrap: wrap`** multi-row flex is treated as one horizontal run.
- `window.getComputedStyle` is the *parent* window's, called on an element inside the iframe realm — works in Chrome but is not a contract, and it is the single most expensive call in the per-move loop (G6).

**Fix:** replace `inferCanvasDropAxis` with a `resolveInsertionAxis(parent)` that reads `display`, `flexDirection`, `gridAutoFlow`, `writingMode` and computed `direction`, returns `{ axis, reversed }`, and have `getCanvasDropZone` flip `before`/`after` when `reversed`. For grid, derive the axis from the *sibling rects* (compare row/column overlap) rather than from CSS, which handles wrap and auto-placement for free. Use the frame's own `defaultView.getComputedStyle`.
**Effort: M.** Files: `canvasDomGeometry.ts`, `canvasDnd.ts`, `canvasSelectionOverlayPositioning.ts` (`lineStyle`), + a unit test beside `src/__tests__/canvas/canvasDnd.test.ts`.

---

### G10 — Multi-node drag lands at the wrong index (off by n−1)
**Severity: Medium (correctness)**

`core/page-tree/dnd.ts:119-131`
```ts
function normalizeIndexAfterRemoval(tree, draggedId, parentId, rawIndex) {
  const currentParent = getParent(tree, draggedId)
  if (!currentParent || currentParent.id !== parentId) return rawIndex
  const currentIndex = currentParent.children.indexOf(draggedId)
  if (currentIndex === -1 || currentIndex >= rawIndex) return rawIndex
  return rawIndex - 1
}
```
It compensates for the removal of **one** node — the pivot `draggedId`. But `moveNodes` detaches **all** of them before splicing:

`core/page-tree/mutations.ts:580-587`
```ts
for (const id of topLevel) {
  const oldParent = getParent(tree, id)
  if (oldParent) oldParent.children = oldParent.children.filter((childId) => childId !== id)
}
```
Dragging 3 same-parent siblings from indices 0,1,2 to "after index 5": `rawIndex = 6`, pivot at 0 → normalized `5`. After detaching 3, the node that was at index 5 sits at index 2, so the correct insert index is `3`. The group lands 2 slots too far right.

This affects both DnD surfaces (`useDomPanelDnd` passes `draggedIds`, `useCanvasReorderDrag.ts:250` calls `moveNodes(target.draggedIds, ...)`). `src/__tests__/core/pageTreeDnd.test.ts:31` tests same-parent normalisation only for the **single**-drag case; `:57` tests multi-drag *rejection*, not multi-drag index.

**Fix:** normalize by counting how many of `draggedIds` sit in `parentId` at an index `< rawIndex`, not just the pivot. Add a regression test in `pageTreeDnd.test.ts`.
**Effort: S.** Files: `core/page-tree/dnd.ts`, `src/__tests__/core/pageTreeDnd.test.ts`.

---

### G11 — DOM panel auto-scrolls twice; drops near the edge never resolve
**Severity: Medium**

`DomPanel.tsx:493-499` mounts `<DndContext>` with **no `autoScroll` prop**, so dnd-kit's built-in auto-scroll is on. `useDomPanelDnd.ts:183-212` implements a *second* auto-scroll:
```ts
container.scrollBy({ top: speed })
measureRows()
resolveTargetAtPoint(draggedId, point)
scrollFrameRef.current = requestAnimationFrame(() => runAutoScrollRef.current())
```
`AUTO_SCROLL_EDGE_PX = 32` (`:38`) and dnd-kit's default threshold overlap, so near an edge the list scrolls at roughly double speed, and dnd-kit's scroll happens without a matching `measureRows()`.

This is already recorded as real product fragility, not a test artifact — `STATE.md:3947`:
> "BOTH dnd-kit and `useDomPanelDnd` auto-scroll when the pointer comes within 32px of an edge; rows are measured once at drag start, so a drag begun on a row near the bottom scrolls the list out from under those rects and **no drop target ever resolves** — indistinguishable from a refused drop."

**Fix:** pass `autoScroll={false}` to the `DndContext` (the hook's version is the one that re-measures) — one line — or delete the hook's version and add a `scroll` listener that calls `measureRows()`. Do not keep both.
**Effort: S.** Files: `DomPanel.tsx`.

---

### G12 — Zero keyboard path, on any surface
**Severity: High (accessibility)**

- No `KeyboardSensor` anywhere. The only sensors in the repo are `useSensor(PointerSensor, { activationConstraint: { distance: 5 } })` at `AdminCanvasEditorBody.tsx:77` and `DomPanel.tsx:225`.
- No custom `announcements` / `screenReaderInstructions` on either `DndContext` (dnd-kit's English defaults apply to those two surfaces only).
- The canvas reorder, board furniture, palette, media-insert and floating-panel drags are raw pointer handlers with **no keyboard equivalent at all** and no ARIA. `SelectionToolbar.tsx:77` gives the handle `aria-label="Drag selected layers"` but no `aria-grabbed`/`aria-dropeffect` and no key handling.
- **There is no command alternative either.** Grepping `move up|move down|bring forward|send backward|reorder` across `src/admin/pages/site` returns only `useCanvasReorderDrag` identifiers — no "Move up"/"Move down" in the layer context menu, the selection toolbar, the spotlight palette, or the keyboard shortcut map. **Reordering a node is only possible with a mouse.**
- `IframeFrameSurface.tsx:507-511` deliberately blocks `Tab` inside canvas frames, so canvas content is not keyboard-reachable in the first place.

**Fix (two layers):**
1. Ship `moveNodeUp`/`moveNodeDown`/`indentNode`/`outdentNode` store commands (thin wrappers over `moveNodes`, so they inherit the same refusal gate) bound to `Alt+↑/↓/←/→` in `useCanvasSelectionKeyboard.ts` and exposed in the layer context menu + spotlight. This is the highest value-per-effort item in the whole audit and unblocks a11y immediately.
2. Add `KeyboardSensor` + `announcements` to both `DndContext`s.
**Effort: S** for (1), **M** for (2). Files: `nodeActions.ts`, `useCanvasSelectionKeyboard.ts`, `LayerNodeContextMenu.tsx`, `DomPanel.tsx`, `AdminCanvasEditorBody.tsx`.

---

### G13 — Escape does not cancel any drag; no alt-drag copy
**Severity: Medium**

Grepping `Escape` across `useCanvasReorderDrag.ts`, `useDomPanelDnd.ts`, `BoardFramesLayer.tsx` returns nothing; the only hit in `ModuleInserterDialog.tsx:215` closes the dialog (and leaks the window listeners, G4). Cancellation exists only via `pointercancel` (`useCanvasReorderDrag.ts:256-260`), which the browser fires for context-menu/pointer-loss, not for user intent.

Grepping `altKey` in the drag paths returns only event-cloning in `IframeFrameSurface.tsx:403/473/541` and an unrelated inspect-mode check in `CanvasTreeLadderOverlay.tsx:117`. **No alt-drag-to-duplicate anywhere** — which is consistent, since `duplicateNode` refuses on every studio-imported node (`structuralSourceEdits.ts:249-261`).

**Fix:** add a `keydown` listener in the shared drag session (G-Arch) that on `Escape` restores the pre-drag state and calls the session's `cancel()`. For board furniture this needs the pre-drag `x/y` retained (currently thrown away because the store is mutated live — fixed for free by G8's ref-driven rewrite).
**Effort: S**, after G8/G-Arch.

---

### G14 — Reparent, duplicate, wrap all refuse; nothing warns beforehand
**Severity: High (product), Low (fix — this is roadmap, not bug)**

`refuseStructuralEdit` refuses `reparent` unconditionally on a source-derived node (`structuralSourceEdits.ts:88-97`), and `planSourceCopy` refuses `duplicate` and `wrap` (`:249-261`). `PROJECT-BRIEF.md:152-154` lists "**reparent / duplicate / wrap** (all still refuse)" under "What does NOT work today".

The DnD problem is not the refusal — it is that **the UI advertises the gesture as available** (a valid drop indicator, an enabled duplicate button) right up to the moment it fails. Combined with G5, roughly half of all drag gestures on a real imported project are advertised-then-refused.

`docs/reference/canvas-dnd.md:174-179` further documents a "wrap-to-container" drag affordance and `moveNodes`/`wrapNodes` multi-select behaviour that does not exist as a drag target in the code.

**Fix:** G5's preview gate is the whole fix for the *feedback* half. The capability half is `STUDIO-IMPORT-V2-PLAN.md` work.
**Effort: covered by G5.**

---

### G15 — No file drop onto the canvas or the Studio importer
**Severity: Medium (product gap)**

Grepping `onDrop|onDragOver|dragover|'drop'` across `src/admin/pages/site/canvas`, `.../toolbar`, `.../sidebars` returns **zero handlers** (only the unrelated identifiers in `canvasInsertionDrop.ts`). Likewise `ImportProjectDialog.tsx` — the live Studio import surface — has no drop zone; only the dormant CMS `SiteImport/steps/DropStep.tsx:89-92` does.

So: dragging a PNG onto the board does nothing (the browser navigates to the file, since no ancestor calls `preventDefault` on `dragover`); dragging a project `.zip` onto the Studio import dialog does nothing.

The server side is ready — `POST /admin/api/studio/asset-upload` + `landAssetBytes` exist and `ImageSourceSection.tsx:114-119` already uses the upload client. Only the drop target is missing.

**Fix:** add a canvas-level `onDragOver`/`onDrop` in `CanvasRoot.tsx` that resolves the frame under the cursor (G7's `frameId` plumbing), uploads via `uploadStudioAsset.ts`, and inserts a `base.image` at the resolved location — reusing `resolveCanvasPointerInsertionDrop`. Add the same to `ImportProjectDialog.tsx` reusing `importUploadProject.ts`.
**Effort: M.** Files: `CanvasRoot.tsx`, `canvasInsertionDrop.ts`, `ImportProjectDialog.tsx`.

---

### G16 — Edge hit-bands are in unscaled frame pixels, so they shrink with zoom
**Severity: Medium**

`canvasDnd.ts:74-100`
```ts
const MIN_EDGE_HIT_ZONE = 8
const MAX_EDGE_HIT_ZONE = 20
const EDGE_ZONE_RATIO = 0.26
...
const edgeBand = Math.max(MIN_EDGE_HIT_ZONE, Math.min(MAX_EDGE_HIT_ZONE, size * EDGE_ZONE_RATIO))
```
`candidate.rect` is in **viewport-local, unscaled** coordinates (`canvasDomGeometry.ts:253-272` divides by `getViewportScale`), and `point` is converted the same way (`:11-22`). That makes the *resolution* zoom-correct — good, and the drop indicator inherits the canvas transform so it renders correctly at any zoom (`BreakpointSelectionOverlay.tsx:652-664` + `.overlayLayer { position:absolute; inset:0 }`).

But the **band is a constant in frame pixels**, so its on-screen size is `8 × zoom`. At the 25% zoom typical for surveying a board, the before/after bands are 2 screen pixels wide — effectively unhittable, and every drop resolves as `'inside'`. At 400% zoom they are 32px, so a leaf node has almost no `'inside'` region.

**Fix:** compute `edgeBand` in *screen* pixels and divide by the live zoom before comparing: `const band = clamp(SCREEN_EDGE_PX / zoom, ...)`. `getViewportScale` already computes the zoom; pass it into `getCanvasDropZone`.
**Effort: S.** Files: `canvasDnd.ts`, `canvasDomGeometry.ts`, `src/__tests__/canvas/canvasDnd.test.ts`.

---

### G17 — Media (native HTML5) DnD cannot judge legality while hovering
**Severity: Medium**

`useMediaDnd.ts:31-40`
```ts
function handleDragOver(event, targetFolderId) {
  if (!enabled) return
  if (!hasMediaDropData(event.dataTransfer)) return
  const payload = readMediaDropPayload(event.dataTransfer)
  if (!canAcceptDrop(workspace, payload, targetFolderId)) return
  event.preventDefault(); event.stopPropagation()
  event.dataTransfer.dropEffect = 'move'
  setDropTargetKey(folderDropKey(targetFolderId))
}
```
Per the HTML drag-and-drop spec, `DataTransfer` is in *protected mode* during `dragover` — `getData()` returns `""`. So `readMediaDropPayload` returns `null` on every real browser, and `canAcceptDrop(workspace, null, …)` short-circuits to `true` (`mediaDnd.ts:44`). Net effect: **every** folder highlights as a valid drop target, including the folder being dragged and its own descendants. The drop then hits the real guard (`commitDropPayload`, `:58-61`) and does nothing, with no toast.

`hasMediaDropData` works (it reads `dataTransfer.types`, which IS readable in protected mode), so the "is this a media drag at all" check is sound — only the legality check is dead. The unit test `src/__tests__/media/mediaDnd.test.ts` tests `canAcceptDrop` directly with a real payload, so it never exercises the protected-mode path.

**Fix:** encode the legality-relevant facts in the drag *type string* rather than the payload — e.g. `application/x-studio-media-folder+<folderId>` as a `dataTransfer.setData` **type** — which stays readable during `dragover`; or hold the active drag payload in a module-level ref set on `dragstart` (same document, so this is safe) and read it in `dragover`. Add a toast for an illegal drop.
**Effort: S.** Files: `mediaDragDrop.ts`, `useMediaDnd.ts`, `mediaDnd.ts`.

---

### G18 — Test coverage is resolver-only; every integration risk is untested
**Severity: Medium**

What exists:

| Test | Asserts |
|---|---|
| `src/__tests__/canvas/canvasDnd.test.ts` (5 cases) | `getCanvasDropZone` band mapping; deepest-candidate pick; invalid metadata; insertion into containers/after leaves. Pure function, synthetic rects. |
| `src/__tests__/canvas/canvasInsertionDrop.test.ts` (2) | One resolved target+preview from a pointer position; page-root fallback. |
| `src/__tests__/canvas/canvasReorderDragActivation.test.tsx` (3) | Only the 4px activation threshold: no drag on pointerdown; jitter is a click; clears threshold → drag. |
| `src/__tests__/dom-panel-dnd/target-resolution.test.ts` (5) | Row zone mapping; before/after; inside-append; same-parent index normalisation (single); rejections. |
| `src/__tests__/core/pageTreeDnd.test.ts` (3) | Single-drag index normalisation; multi-drag *rejection*; slot-instance rules. |
| `src/__tests__/canvas/boardSnapping.test.ts` | `computeSnap` pure math. |
| `src/__tests__/media/mediaDnd.test.ts` (6) | `canAcceptDrop`/`commitDropPayload` with real payloads only. |
| `tests/e2e/structural-writeback.e2e.ts` (2) | Layers-tree drag rewrites `Home.tsx` byte-exact; reparent drag surfaces `role="alert"` and leaves the file identical. |

What is **not** tested anywhere: the cross-iframe pointer relay; drag correctness at zoom ≠ 100%; cross-frame / cross-page drags; the multi-drag index (G10); the double auto-scroll (G11); board frame / note / doc drag at all; palette and media insertion drags end-to-end; `inferCanvasDropAxis` for grid/reverse/RTL; media DnD's protected-mode `dragover`.

**Fix:** add `src/__tests__/canvas/` cases for the axis resolver and the zoom-scaled band as part of G9/G16; add a `pageTreeDnd` multi-index case (G10); the relay and cross-frame behaviour belong in `tests/e2e` alongside `structural-writeback.e2e.ts`. Note repo trap #13: no browser tests from agents — write the specs, let the human dogfood.
**Effort: M**, distributed across the other fixes.

---

## PROPOSED UNIFIED DND ARCHITECTURE

One engine, three adapters, one gate. Concretely:

### 1. `src/admin/pages/site/canvas/drag/dragSession.ts` — the single gesture owner

A module-level singleton (not React state, not a DOM attribute) replacing `canvasPointerRelay.ts`, `useCanvasReorderDrag.ts`'s session, and the two inline pointer loops in `ModuleInserterDialog.tsx` / `useMediaCanvasInsertionDrag.ts`.

```ts
type DragPayload =
  | { kind: 'nodes'; nodeIds: string[]; sourceFrameId: string; sourcePageId: string }
  | { kind: 'newModule'; moduleId: string; defaults?: Record<string, unknown> }
  | { kind: 'asset'; assetRef: string; moduleId: string; defaults: Record<string, unknown> }
  | { kind: 'files'; files: File[] }

interface DragSession {
  payload: DragPayload
  begin(origin: { x: number; y: number; pointerId: number }): void
  subscribe(fn: (s: DragSnapshot) => void): () => void   // for chrome that must re-render
  cancel(): void                                          // Escape / pointercancel
}
```

Responsibilities, all in one place:
- **Activation threshold** — the existing `DRAG_ACTIVATE_PX = 4` (`useCanvasReorderDrag.ts:78`), applied uniformly (today the palette uses 6, dnd-kit uses 5, board furniture uses 0).
- **Event ownership** — `pointermove/up/cancel` on `window`, plus `keydown` for Escape. Releases pointer capture the moment the cursor crosses into an iframe so the parent stream and the relayed stream never both fire (G4).
- **Per-frame RAF coalescing** — at most one `resolve()` per animation frame regardless of pointermove rate (G6).
- **Ref-driven visuals** — the ghost, the drop indicator and the board-furniture translate are written as CSS custom properties on cached element refs; React state is committed exactly once, on drop. This is the `useDraggablePanel.ts:136-144` pattern, which is already the one correct drag in the repo (G8, G6).

### 2. `src/admin/pages/site/canvas/drag/frameCandidateIndex.ts` — measurement, cached and board-wide

Replaces `measureCanvasDropCandidates`'s per-gesture, single-frame model.

- Keyed by `frameId`. Built **lazily on first hover of that frame**, then cached for the gesture; invalidated by a `MutationObserver` + `ResizeObserver` on the frame body, never per pointermove (G6).
- Each entry: `{ nodeId, frameId, pageId, depth, rect (viewport-local, unscaled), axis, reversed }`.
- `axis`/`reversed` come from the new `resolveInsertionAxis(parentEl)` — `display`/`flexDirection`/`gridAutoFlow`/computed `direction`/`writingMode`, with grid orientation derived from sibling-rect overlap rather than CSS (G9). Resolved with the **frame's own** `defaultView.getComputedStyle`.
- Lookup is board-wide: `candidateAt(clientX, clientY)` walks frames by hit-test, then that frame's index. This is what makes a cross-frame drag possible at all (G3), and it is what lets an insertion drag know which *page* it is over (G7).

### 3. `src/core/page-tree/dropResolution.ts` — one resolver, source-aware

Absorbs `core/page-tree/dnd.ts`, `canvas/canvasDnd.ts` and `panels/DomPanel/domPanelDnd.ts` into one function:

```ts
resolveDrop({
  candidate,            // from the index (canvas) OR a row rect (layer tree)
  point, zoom,
  payload,              // from the session
  treeFor: (pageId, frameId) => NodeTree<PageNode>,
}): DropResolution
// DropResolution = { ok: true; target: DropTarget } | { ok: false; overRect; reason: string }
```

Three changes to its behaviour:
- **Edge bands in screen pixels**, divided by `zoom` before comparison (G16); `before`/`after` flipped when `candidate.reversed` (G9).
- **`normalizeIndexAfterRemoval` counts every dragged sibling**, not just the pivot (G10).
- **It calls `previewStructuralMove` / `previewStructuralInsert`** — pure functions extracted from `structuralSourceEdits.ts`'s `planSourceMove`/`planSourceInsert`. A drop that the store would refuse resolves as `{ ok: false, reason }` **while the pointer is still down** (G5, G14). This is the single most important change in the proposal: the store gate stops being a post-hoc apology and becomes live feedback.

The store keeps its own gate exactly as it is — `nodeActions.ts:554` remains the authority for stale targets and for non-DnD callers (agent, plugins, spotlight). The preview is an optimisation of honesty, never a replacement for the gate.

### 4. Three adapters, no more

| Adapter | Provides to the session | Replaces |
|---|---|---|
| `canvasDragAdapter` | candidate index from `frameCandidateIndex`; commits `moveNodes` / `insertNode` | `useCanvasReorderDrag.ts`, `canvasInsertionDrop.ts`, the two inline loops |
| `treeRowDragAdapter` | row rects instead of node rects; identical resolver | `useDomPanelDnd.ts`, `useSiteExplorerDnd.ts` |
| `furnitureDragAdapter` | board-space translate + `computeSnap`; commits `setFramePosition`/`moveNote`/`moveDoc` once on drop; `DraggedFurniture` keyed by `frameId` | `BoardFramesLayer.tsx`, `StickyNoteView.tsx`, `DocBlockView.tsx` |

`@dnd-kit/core` is **removed**. It cannot cross the iframe boundary — which is why `useCanvasReorderDrag.ts` was written by hand in the first place — and keeping it means two activation models, two auto-scroll implementations (G11), and two accessibility stories. Its one genuine asset, `DragOverlay`, is ~30 lines of portal to reimplement. Deleting it also removes the dashboard's third `DndContext` (dormant CMS — port `DashboardGrid`/`BlockLibrary` to `treeRowDragAdapter` or leave them on a frozen local copy; do not build on them).

### 5. Capabilities the unified engine gets, that no current surface has

- **Auto-pan at canvas edges for every drag** — `useCanvasReorderDrag.ts:142-175` already has `AUTO_PAN_EDGE_PX`/`AUTO_PAN_MAX_SPEED`; the session owns it, so the palette and media drags inherit it (they have none today).
- **Escape cancels, always** — the session holds the pre-drag state, so board furniture becomes cancellable for the first time (G13).
- **Multi-node and multi-frame drag** — one payload shape, one commit call.
- **Cross-frame / cross-page drag** — resolves, previews, and refuses *visibly* when the write has no honest target (G3 + G5).
- **File drop** — `payload.kind === 'files'` routes through the same target resolution to `uploadStudioAsset` + `insertNode` (G15).
- **Keyboard** — `moveNodeUp/Down/indent/outdent` store commands land first (G12, ship independently of everything above), then a keyboard drag mode over the same session.

### 6. Recommended landing order

| Step | Items | Effort | Depends on |
|---|---|---|---|
| 1 | G11 (`autoScroll={false}`), G10 (multi index), G16 (zoom band), G17 (media dragover) | S each | none |
| 2 | G12 step 1 — keyboard move/indent commands | S | none |
| 3 | `previewStructuralMove` extraction + wire into both resolvers (G5, G14) | M | 1 |
| 4 | `dragSession` + `frameCandidateIndex`; port canvas reorder + both insertion drags (G4, G6, G7, G13) | L | 3 |
| 5 | `furnitureDragAdapter` (G8) | M | 4 |
| 6 | Drag arming inside the iframe (G2), cross-frame drag (G3), file drop (G15) | L | 4 |
| 7 | Remove `@dnd-kit`, port tree rows + dashboard; rewrite `docs/reference/canvas-dnd.md`; add `dnd-single-engine.test.ts` (G1, G18) | M | 4, 5, 6 |

Steps 1 and 2 are independently shippable and fix four real defects plus the entire accessibility gap for under a day of work.
