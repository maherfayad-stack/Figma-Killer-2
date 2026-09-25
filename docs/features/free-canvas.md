# Free canvas — loose layers on the empty board
> **Purpose:** how loose layers work: storage, load, render, gestures, exclusion, security · **Read when:** touching the empty board, `.studio/canvas/`, `Board.layers`, or a drag that leaves or enters a frame · **Trust:** current (P5-G, FC-1…FC-6 partial) · **Owner:** canvas-engineer · **Verified:** not yet

The owner's ask (OD-14, 2026-09-23): *"right in the canvas I want a free canvas
that I can drag an element/component or an image in, and it's not part of the
pages, and it's still there, just not part of the live preview."*

The empty board around the frames holds **loose layers**: an element, a
component instance or an image, placed anywhere. A loose layer persists across
reloads, but it is **never** part of a page, the live preview, a publish, a
deploy, a share, a prototype flow or a download. It can be dragged into a frame
(it becomes real JSX in that page) and an element can be dragged out of a frame
onto the board (it becomes a loose layer).

Design and the full work-order list: [`docs/audits/2026-09-23-studio-audit/10-free-canvas.md`](../audits/2026-09-23-studio-audit/10-free-canvas.md).
This page describes what is built.

---

## Two halves, two stores

| | Lives in | Written by |
|---|---|---|
| **Content** — the element itself | `.studio/canvas/<layerId>.tsx`, one default-exported component returning one root element | A `/save` batch (`canvas-layer-*` edit kinds) |
| **Placement** — board x/y, optional host width `w`, `z`, name, lock, hide | `.studio/boards.json` → `Board.layers[]` | The board autosave |

Content in code and position in board metadata is the split a frame already
has. A move never touches source; dragging into a frame never carries board
coordinates into the page.

A layer module always looks like this (`buildCanvasLayerModule`, the ONLY
producer):

```tsx
/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.
import { Card } from '../../components/Card'

export default function CanvasLayer() {
  return (
    <Card title="Hello" />
  )
}
```

The header keeps the scratch file out of the user's `eslint .` (ESLint's flat
config lints dot-directories).

### Ids and paths

`@core/studio-board`'s `canvasLayers.ts` is the one module that spells the
path. A layer id is `cl` + ten lowercase base-36 characters
(`mintCanvasLayerId`); `canvasLayerRelPath(id)` builds `.studio/canvas/<id>.tsx`
from a validated id; `canvasLayerIdFromRel` accepts only that exact spelling
(no `..`, no nesting, no backslash, no other extension, no case variant). A
layer's parsed tree is stored under page id `canvas:<id>`, a shape no route id
can take. `canvas-layer-isolation.test.ts` holds the literal to that module.

---

## Load (FC-1)

`studioPageLoad.ts` parses every layer module with `parseRouteFileThroughCache`
(`studio/routeEntryParse.ts`) — the same per-file parse, evaluator budget,
local-component inlining and P6-B parse cache a file-per-page route gets, under
the cache route `canvas-layer:<id>` (`studio/canvasLayerLoad.ts`). Layers
join the load's style pass, so a CSS Module a layer imports is registered.

They are returned in **`StudioLoadResult.canvasLayers`, never in `pages`**. A
narrowed load (`?pageIds=`) still returns every layer. The load memo stamps each
layer file (`studioLoadMemo.ts`), and `reload-scope` maps a touched layer file
straight to its `canvas:<id>` page id (`reloadScope.ts`), so a write to a layer
narrows instead of reloading the whole board.

On the client, `canvasLayerSlice.ts` holds the parsed layers in
`canvasLayerPages` — **not** in `site.pages`. `selectCanvasPageFor` is the one
reader that consults it, which is how a `NodeRenderer` inside the free-canvas
surface resolves its node. Every page list, the publisher, the prototype panel
and every agent page tool read `site.pages` and never see a layer.

### Heal

The two halves are written by two writes, so they can disagree (a crash, a
failed autosave, an outside edit). Whenever both are loaded,
`healCanvasLayerPlacements` reconciles silently: a placement whose module is
gone is dropped; a module with no placement is placed on the active board to
the right of its content. A layer whose own gesture is still on the wire is
left alone (`canvasLayerPending.ts`). Nothing is shown as an error, and a heal
never deletes a file.

---

## Edit kinds (FC-2)

`server/handlers/studioCanvasLayerWriteback.ts`, folded into the ordinary
`/save` batch — no new route.

| kind | writes | reports |
|---|---|---|
| `canvas-layer-create` `{ layerId, element }` | a new module from `insert`'s element spec (exclusive create) | the root in `createdNodeIds` |
| `canvas-layer-delete` `{ layerId }` | removes the module | its bytes in `removed` |
| `canvas-layer-restore` `{ layerId, text }` | writes removed bytes back (exclusive; ≤ 512 KB) — an undo, never a gesture | — |
| `canvas-layer-place` `{ nodeId: root, layerId, parentNodeId, anchorNodeId?, position?, copy? }` | the layer root into a page container, imports carried (`placeCanvasLayerRoot`); the module is removed unless `copy` | the element in `createdNodeIds`; the module bytes in `removed` |
| `canvas-layer-lift` `{ nodeId, layerId, copy? }` | a page element into a new module, imports re-specified from `.studio/canvas/` (`liftJsxElementToCanvasModule`); cut from the page unless `copy` (the batch's prune pass takes an orphaned import) | the new root in `createdNodeIds` |

`place` and `lift` reuse the frame-to-frame transplant's destination half and
scope rule (`transplantJsxElement.ts`): markup that reads a prop, a hook result
or a `.map` row refuses `captured-scope` by name. A lift then place back into
the same slot is byte-exact (`transplantJsxElement.canvas.test.ts`,
`studioCanvasLayers.test.ts`).

---

## Security (FC-1) — needs security-guard review

- **The write path.** `studioEditRouting.ts`'s `STUDIO_AUTHORED_SOURCE_PATTERNS`
  holds exactly one pattern, `CANVAS_LAYER_REL_PATTERN`
  (`^\.studio/canvas/(cl[a-z0-9]{10})\.tsx$`). Every other `.studio` path stays
  refused; `studioWritebackExcludedDirs.test.ts` pins both halves (the
  acceptance failed before FC-1; a widened pattern fails nine near-miss rows).
  `canonicalSourceRel` still re-checks the real path. **The opening is opt-in**
  (security review of #260, B1): `studioEditLocation` / `canonicalSourceRel` /
  `isWritableSourceRel` refuse a layer path by DEFAULT, and admit it only
  under `SourceTargetScope` `{ canvasLayers: 'allow' }`, which only the editor's
  `/save` batch passes (threaded through every helper that batch calls). A
  caller that decodes a node id on its own — `studio_codemod`,
  `/extract-component`, `nodeJsxSource` — therefore cannot reach a layer, with
  no check of its own to forget. `reloadScope` opts in only to NAME a layer
  file (it maps to `canvas:<id>`, never read or written).
- **Files.** Only `studio/canvasLayerFiles.ts` touches `.studio/canvas/`. It
  builds paths from validated ids, refuses a `.studio` or `.studio/canvas` that
  is a link (a cloned repo can carry one) and any real path that is not the
  exact spelling, creates exclusively (`lstat` probe + `wx`), and only unlinks a
  regular file. The loader skips a linked directory and any file that is not
  exactly `<id>.tsx`.
- **Execution.** Nothing new runs. Tier 0 parses; the surface never mounts
  runtime scripts at any tier (gate (d)); the Tier-2 live frames never load a
  layer (nothing imports `.studio/`).
- **The agent** (P4-C's gate, decided deliberately): the agent's native
  `Write`/`Edit` stay refused in all of `.studio/` (`agentWriteRefusal`,
  unchanged). A batch run for an agent — `studio_apply_edits` — refuses every
  `canvas-layer-*` kind AND any edit whose target, anchor or destination is a
  layer module, by name (`canvas-layer-agent`): only the editor's `/save`
  passes `canvasLayers: 'allow'`. Loose layers are the human's scratch; the
  agent gets narrow tools for them in FC-8.

---

## Rendering (FC-4)

`canvas/BoardCanvasLayer/`:

- **One surface per board** (`CanvasLayerSurface.tsx`): a single same-origin
  `IframeFrameSurface` with `sizing: 'fixed'` and no runtime scripts. Every
  layer is a `CanvasLayerHost` in it.
- **A window, not the whole board** (`canvasLayerGeometry.ts`): the surface
  covers the viewport plus one margin, snapped to a 512-unit grid, re-fit on the
  store's settled pan/zoom. A host sits at `placement − window origin`, and the
  origin is one pair of custom properties on the surface body.
- **The host** (`CanvasLayerHost.tsx`) stands where `<body>` stands for a
  page's root: absolutely positioned, `display: flow-root`, `w` wide or
  `max-content`. It renders the layer page root's CHILDREN — the page root is a
  `base.body` that would claim the shared document's `<body>`. The one
  fidelity difference from a frame is a selector naming `body` itself. Only
  this file renders the host (gate (c)).
- **Below the frames.** `BoardCanvasLayer` mounts first in
  `StudioBoardLayers`, so the surface paints under frames and annotations
  (OD-FC-2); `BoardCanvasLayerChrome` mounts after the frames and draws the
  selection and hover rings above them, sized from each host's measured box.
- **No input to the iframe.** The surface is `pointer-events: none`; see below.

---

## Gestures (FC-5, FC-6)

| Gesture | What happens | Undo |
|---|---|---|
| Drop image files on the empty board | Each file's bytes land in `public/` (the frame drop's own route, which also reads the intrinsic size); one `canvas-layer-create` per image with `<img src alt width height>`, the first centred on the drop point and each further one cascaded 24 px; non-images are left out and named in one toast; modifiers do not apply | one ⌘Z per layer: module deleted, placement removed |
| Press a loose layer | Selects it (⇧ toggles). A fourth selection list beside nodes, frames and annotations | — |
| Drag a loose layer on the board | Moves it; snaps to frames, notes, docs and other layers (`computeSnap`); zero React commits per move; one board undo entry | board undo |
| Drag a loose layer over a frame and release | Placed into the frame at the drop line (`canvas-layer-place`); ⌥ copies | one ⌘Z: element deleted from the page, module and placement back |
| Drag an element out of a frame and release over the empty board | Lifted (`canvas-layer-lift`), keeping the grab offset; ⌥ copies | one ⌘Z: placed back into its old slot, module and placement gone |
| Delete / Backspace | `canvas-layer-delete` for the selection, one write | one ⌘Z: exact bytes and placements back |
| Arrow keys | Nudge the selection (board undo, one entry per key-hold) | board undo |

**Hit-testing from the board.** The surface iframe would swallow every press
over it, gaps between layers included. Instead of forwarding gap presses back
out (design §4.4), `useCanvasLayerPointer` claims a press on the canvas root
only when it lands on a loose layer's measured box, in the capture phase; every
other press reaches the marquee and the pan unchanged. Layers under a frame are
not pressable (the frame is on top) — reach them by moving the frame.

**Three rules the e2e found, each load-bearing:**
- *Board coordinates come from ONE read.* `BoardCanvasLayer`'s `.layer`
  (`data-studio-board-origin`) is 1000 px wide and zero tall at board (0, 0);
  its client rect gives the board origin AND the painted zoom
  (`readBoardOrigin`). The drop, the hit test and the lift all use it — never a
  transform ref or the store's debounced zoom beside it.
- *"On the empty board" is what is under the pointer* (`isEmptyBoardTarget`:
  the canvas root or the transform layer). A frame's registered drop viewport
  can extend past its clipped box (the iframe grows to content), so the
  registry's rects over-report frames. An OS file drop relayed out of a frame
  is never a free-canvas drop, even if that frame's surface is not registered.
- *Pressing a loose layer activates the board breakpoint* (`'studio'`): a frame
  offers itself as a drop target only while it is the active breakpoint
  (`BreakpointSelectionOverlay`), which only a click INTO a frame used to set.
- *A site-root image renders on a design canvas through the asset route* —
  P5-B2's `canvasProjectAssetUrl.ts`, which every portal document (frames and
  the free-canvas surface) resolves node props through at render time.

**One history entry holds both halves.** A create, place, lift or delete is a
structural source gesture (`canvasLayerCommits.ts` → `commitStructural`) whose
entry also carries the placement change (`StructuralSourceGesture.placements`).
Undo and redo re-issue the write AND put the placement on the matching side
(`structuralSourceHistory.ts`); a write that does not land takes the placement
back (its rollback).

---

## Not built yet

| Work order | Missing |
|---|---|
| FC-2 | `canvas-layer-duplicate`; `bakeCapturedBindings` (a `captured-scope` lift refuses instead of becoming a copy with values baked) |
| FC-3/FC-7 | Editing a loose layer's content in the inspector (a loose layer is selected as a whole; its nodes are not selectable); Layers-panel "Canvas" section; Measures X/Y on a placement; context menu |
| FC-4 | Registering layers as drop targets for an ELEMENT drag (drop into a loose layer's children) |
| FC-5 | Marquee selection of loose layers; resize handles; z-order keys; lock/hide UI (the placement fields exist and are honoured) |
| FC-6 | Assets-panel drag, paste and armed-tool drawing onto the empty board (P5-A / P5-D / P5-E call `createCanvasLayer`); a multi-file drop as ONE undo step (today one per layer) |
| FC-8 | `studio_list_canvas_layers` / `studio_canvas_layer` MCP tools; a digest section |
| FC-9 | Group / ungroup loose layers |
| FC-10 | The 50-layer perf budgets |
| design §6.1 | Tailwind content scan of `.studio/canvas/` (a class used only on a loose layer is not generated) |
