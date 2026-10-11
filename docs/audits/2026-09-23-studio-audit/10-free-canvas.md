> **Purpose:** design for the free canvas (OD-14) · **Read when:** before any FC-n work order · **Trust:** current design, 2026-09-23 · **Owner:** studio-architect

# 10: The free canvas (OD-14, bundle P5-G)

The owner's words (2026-09-23): *"right in the canvas I want a free canvas that I can drag an
element/component or an image in it and it's not part of the pages, and it's still there just not
part of the live preview, so it's figma like free canvas"*.

## 0. Summary and recommendation

The empty board gets **loose layers**. A loose layer is an element, a component instance, an
image or an SVG, placed at any board x/y. It persists, it can be selected with frames, and it
can be edited with the same inspector a page node uses. It is **never** part of a page, the live
preview, a publish, a deploy, a share, a prototype flow or a download. Dragging one into a frame
turns it into real JSX in that page. Dragging an element out of a frame makes it loose.

Today the board refuses an image dropped on empty space with *"The empty board is not a file, so
there is nowhere for Studio to write the element"* (`canvas/canvasFileDrop.ts:148`). The whole
design is about giving the empty board a file without letting that file become part of the app.

**Recommendation, in one line per decision:**

1. **Storage: one real TSX module per loose layer, at `.studio/canvas/<layerId>.tsx`.** It holds
   the layer's content: one default-exported component returning exactly one root element. It is
   parsed by the same pipeline as a page, and its components and images resolve through ordinary
   imports. The layer's board **placement** (x, y, optional host width, z, name, lock, hide) goes in
   `.studio/boards.json` as a new `Board.layers` array, beside frames and notes. Content lives in
   code and position lives in board metadata, the same split a frame already has.
2. **Rendering: one shared "canvas-layer surface" document per board.** Loose layers do not get
   one iframe each. The surface is a single same-origin portal iframe that renders every loose
   layer of the board, each inside a Studio-owned **host** box that stands where `<body>` stands for
   a page root. The surface is windowed to the viewport, paints **below** frames, and registers each
   layer with the drop registry as a **virtual frame**, so the whole in-frame drag, drop, select,
   resize and transplant machinery works on it unchanged. It is always a static (Tier 0/1)
   document, even when the project runs at Tier 2.
3. **Drag in / drag out are transplants.** The existing `transplantJsxElement` gains two
   endpoint shapes: a **new-module destination** (lift, page to canvas) and a **module-root
   origin** (place, canvas to page). A lift or place is one edit and one write, and it gets one
   undo through P3-F's restore journal.
4. **Exclusion holds by construction.** Loose layers never enter `StudioLoadResult.pages` or the
   client's `site.pages`, because they travel in separate collections (`canvasLayers` /
   `canvasLayerPages`). Nothing in the app imports `.studio/`. The only new permission is one
   narrow exception in the write-path predicate for `.studio/canvas/<id>.tsx`. Gates prove each
   surface.
5. **No new HTTP route.** Loads ride `/load`, and writes ride `/save` as new `canvas-layer-*` edit
   kinds. The agent gets two MCP tools.

Effort: **L**, in ten work orders (§9). It lands after the P1 barrier, P3-D (transplant planner)
and P3-F (restore journal). The creation entry points ride P5-A, P5-B, P5-D and P5-E, and do not
fork them.

---

## 1. Decision table

### 1.1 Storage model

| | (a) TSX modules under `.studio/canvas/` **(chosen)** | (b) JSON node trees in `boards.json` (the sticky-note precedent) | (c) A scratch folder in the app tree (`studio-canvas/`) |
|---|---|---|---|
| Component instances stay live (a change to `Card.tsx` shows on the canvas) | Yes. The layer imports `Card`, and `inlineLocalComponents` expands it like on any page | **No.** It would be a frozen snapshot of an inlined tree, stale the moment the component changes | Yes |
| Drag into a frame | An ordinary cross-file transplant. Bytes move verbatim, and imports are carried | Needs JSON→JSX **code generation**, which loses expressions and bindings and breaks "the repository is the document" | Transplant |
| Drag out of a frame | Transplant into a new module | Needs JSX→JSON, which destroys every binding | Transplant |
| Inspector, value writeback, text edit, class/CSS edits | Unchanged: the node ids are `rel:line:col` in a real file | A second writeback path for every edit kind | Unchanged |
| Visible to the user's `tsc`, `eslint`, `vite`, tests, Tailwind | tsc's default `include` wildcard skips dot-directories. Vite only serves imported modules, and nothing imports these. fast-glob `**` skips dot dirs. ESLint v9 flat config *does* lint dotfiles, so every layer module is written with `/* eslint-disable */` (§6.3) | Invisible | **Visible everywhere.** A layer that imports a deleted component breaks the user's `tsc` and CI. Rejected on this row alone |
| Git | `.studio/` is in Studio's scaffolded `.gitignore` and filtered from Studio's staging (`gitOperations.ts:162`). Local, exactly like `boards.json` | Local | Committed into the user's app |
| Security | No execution: Tier 0 parses and never runs. A narrow write-path exception is added (§6.2) | None added | None added, but it pollutes the app |
| Atomicity of content and placement | Two stores (file + `boards.json`), reconciled on load (§3.4) | One store | Two stores |

**Why (a) and not (b), in one sentence:** the owner asked to drag *components* onto the canvas and
back into pages. Only real source keeps an instance live and keeps the round trip byte-exact. A
JSON tree would make the canvas a second, lossy document format.

**Why one file per layer, not one file per board:** a file per layer gives the layer a **stable
identity** (its filename) with nothing written into its markup. A per-board file would need a
`data-studio-layer="…"` marker on every root (which a drag-in would carry into the user's page) or
positional identity (which changes on every edit). Create and delete become file create and file
delete, and a delete never leaves `return ()` behind.

**Why position is not written into the JSX:** a loose root with `style={{ position: 'absolute',
left: 2400 }}` would carry board coordinates into the page on drag-in. Moves are frequent, and each
would also be a source write, a reparse and a memo miss. Position is board metadata, as it is for
frames.

### 1.2 Rendering model

| | One iframe per loose layer (frame pool + posters) | **One shared surface document per board (chosen)** | Render in the parent document in board space |
|---|---|---|---|
| Project CSS, fonts, design-system CSS | Yes, per document (vendor CSS is 122 KB, parsed again in every doc) | Yes, once per board | **No.** The parent is the admin document, and the user's classes would not apply while admin CSS would bleed in. Rejected |
| Cost with 50 on-screen layers | 50 documents. Zoom-out admits 50 mounts (~12 ms iframe + ~15–25 ms injectors each, S1 table). One commit that inserts them breaks the 250 ms zoom budget, and PERF-13 multiplies selection chrome by 50 | **1 document.** 50 small React subtrees. No posters | n/a |
| Pan/zoom | Compositor-only, but with 50 extra composited layers and pool evictions that capture posters (PERF-5, 85–350 ms each) | Compositor-only, 1 layer | n/a |
| Reuse of in-frame machinery | Total | High: each layer registers as a **virtual frame** (document + host element + page id). Rings, hover, inline edit, resize handles, candidate index and transplant all work per document | None |
| Fidelity of the root's containing block | Exact (`<body>`) | The host box plays `<body>`'s role. Only selectors that name `body` directly (`body > :first-child`) differ (§4.3) | n/a |
| z-order against frames | Interleaves | Below frames. The dragged layer lifts above during a drag (§4.4, **OD-FC-2**) | n/a |

**Why the shared surface:** the owner's first ask is "not lag". The moodboard case (dozens of
images and components on the board) is exactly where per-layer documents fail: 50 CSS parses, 50
overlays, and a poster queue. The surface costs one document per board. It does need new
machinery: a surface window, gap forwarding, virtual-frame registration and a drag-time lift.
That machinery is contained in one folder and one registry change.

### 1.3 Where each geometric fact lives

| Fact | Lives in | Written by | Why there |
|---|---|---|---|
| Board x, y (host top-left) | `boards.json` → `layers[].x/y` | Board autosave (800 ms), board history pair | Moves are frequent and must not touch source |
| Host width `w` (the layer's containing-block width) | `layers[].w` (optional; absent = hug) | Board write | It stands in for a *parent*, which a loose layer does not have in code. A fill-width root keeps its fill semantics and round-trips back into a page byte-identical |
| Root's own width / height when fixed | The root element's own style/class, in the layer module | Existing element resize (`elementResize.ts`, P2-D `sizingPatch`) | It is the element's property and must travel with it on drag-in |
| Rotation | Root element `rotate` (P5-F: the CSS `rotate` property, never `transform`) | Source write | Figma rotation belongs to the layer, so it travels |
| z among loose layers | `layers[].z` | Board write | Paint order is board furniture (same `BoardStacked` rule as notes) |
| Name, lock, hide | `layers[].name/locked/hidden` | Board write | Editor facts, not code facts |

**One honest target per resize gesture.** The inspector's sizing resolver answers `fill`, `hug` or
`fixed` for the root's width.
- Horizontal-only resize of a `fill` root writes `layers[].w`, a board write.
- Any other resize writes the element through `sizingPatch('fixed')`, a source write. This matches
  Figma's "resizing makes it fixed".

A gesture never writes both.

---

## 2. Glossary (add to `docs/agent-refs/glossary.md` in FC-1)

| Term | Meaning |
|---|---|
| **free canvas** | The empty board around frames, where loose layers live |
| **loose layer** | One item on the free canvas: a layer module plus its placement |
| **layer module** | `.studio/canvas/<layerId>.tsx`: a default-exported component returning exactly one root element. Studio-owned, never imported by the app |
| **placement** | The layer's `boards.json` entry (`Board.layers[]`) |
| **canvas-layer surface** | The one static iframe document per board that renders its loose layers |
| **host** | The surface's per-layer containing block (`<div data-studio-canvas-host>`). The only Studio box allowed around authored markup, and only inside a surface (§4.3) |
| **lift** | Page element → new loose layer |
| **place** | Loose layer → into a page |

---

## 3. Architecture

### 3.1 Data shapes (TypeBox sketches)

```ts
// src/core/studio-board/canvasLayers.ts  (NEW: the ONE module that knows the path shape)
export const CANVAS_LAYER_DIR = '.studio/canvas'
export const CanvasLayerIdSchema = Type.String({ pattern: '^cl[a-z0-9]{10}$' })
export type CanvasLayerId = Static<typeof CanvasLayerIdSchema>
export function mintCanvasLayerId(): CanvasLayerId            // crypto-random, lowercase base36
export function canvasLayerRelPath(id: CanvasLayerId): string  // '.studio/canvas/<id>.tsx'
export function canvasLayerIdFromRel(rel: string): CanvasLayerId | null  // exact-shape match only
export function canvasLayerPageId(id: CanvasLayerId): string   // 'canvas:<id>' (no page slug contains ':')

// src/core/studio-board/types.ts  (schema-first, like BoardGuideSchema)
export const CanvasLayerPlacementSchema = Type.Object({
  id: CanvasLayerIdSchema,
  x: Type.Number(),                                   // board-space host top-left
  y: Type.Number(),
  w: Type.Optional(Type.Number({ minimum: 1 })),      // host width; absent = hug (max-content)
  z: Type.Optional(Type.Number()),                    // among loose layers only (BoardStacked rule)
  name: Type.Optional(Type.String({ maxLength: 120 })),
  locked: Type.Optional(Type.Boolean()),
  hidden: Type.Optional(Type.Boolean()),
})
export type CanvasLayerPlacement = Static<typeof CanvasLayerPlacementSchema>
// Board gains:  layers?: CanvasLayerPlacement[]   (optional, read as `board.layers ?? []`, like `guides`)
```

The layer module is always produced in this shape. The comment header matters (§6.3).

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

**Load envelope** (`studioLoadContract.ts` / `studioLoadResponse.ts`):

```ts
StudioLoadResult.canvasLayers: CanvasLayerLoad[]      // NEVER merged into `pages`
const CanvasLayerLoadSchema = Type.Object({
  layerId: CanvasLayerIdSchema,
  pageId: Type.String(),                              // canvasLayerPageId(layerId)
  page: Type.Optional(PageSchema),                    // absent when unreadable
  status: Type.Union([Type.Literal('ok'), Type.Literal('unreadable')]),
})
```

**Edit kinds** (`server/handlers/studioEditSchemas.ts`; all go in the existing `/save` batch):

```ts
{ kind: 'canvas-layer-create',    layerId, element: InsertElementSpecSchema }        // same spec `insert` takes, incl. children/importSpecifier/designSystemImport; N in one batch = one write
{ kind: 'canvas-layer-lift',      nodeId, fingerprint, layerId, copy: boolean }       // page element → new module (transplant: element origin, new-module destination)
{ kind: 'canvas-layer-place',     layerId, nodeId /* dest container */, fingerprint,
                                  anchorNodeId?, position?, copy: boolean,
                                  absolute?: { left: number; top: number } }          // module root → page (K6 ⌘ = absolute)
{ kind: 'canvas-layer-duplicate', layerId, newLayerId }
{ kind: 'canvas-layer-delete',    layerId }
{ kind: 'canvas-layer-group',     layerIds, newLayerId, offsets: { layerId, left, top }[] }  // FC-9
{ kind: 'canvas-layer-ungroup',   layerId, newLayerIds }                                     // FC-9
```

Every kind derives the path from `layerId` via `canvasLayerRelPath`. **No edit carries a
client-supplied path into `.studio/`.** Every kind records a P3-F pre-image, so ⌘Z is a
compare-and-swap `restore`.

### 3.2 Files

| | Path | What |
|---|---|---|
| create | `src/core/studio-board/canvasLayers.ts` | Path, id and page-id predicates (§3.1). The only literal `.studio/canvas` in the tree (gated) |
| modify | `src/core/studio-board/types.ts`, `serialize.ts`, `index.ts` | `CanvasLayerPlacementSchema`; `Board.layers`; `coerceLayer` so **every** read and write keeps `layers` (server-side `writeBoardsFile` callers in `boardFrames.ts` included; otherwise `studio_create_page` would silently drop all loose layers) |
| create | `server/handlers/studio/canvasLayerLoad.ts` | Discover `.studio/canvas/*.tsx` (exact id shape only), parse each like a standard route entry (shared ts-morph project, parse cache, `inlineLocalComponents`), convert to `Page` |
| modify | `server/handlers/studioPageLoad.ts` | `computeStudioPages` feeds layer entries into `loadStudioStyles` (their CSS is registered) and returns `canvasLayers`, **never** in `pages` |
| modify | `server/handlers/studio/studioLoadContract.ts`, `studioLoadResponse.ts` | `canvasLayers` field |
| modify | `server/handlers/studio/studioLoadMemo.ts` | Fingerprint includes `.studio/canvas/*.tsx` stats explicitly (it already names `.studio/meta.json` the same way) |
| modify | `server/handlers/studio/styleCompile.ts` | Studio's own compile content scan adds `.studio/canvas/` (never the user's config), so a Tailwind class used only on a loose layer still gets generated |
| modify | `server/handlers/studioEditRouting.ts` | `isWritableSourceRel` rejects every `EXCLUDED_WORKSPACE_DIR_NAMES` segment **except** a path `canvasLayerIdFromRel` accepts. This also closes a latent gap: today `.studio/anything.tsx:1:1` passes the shape check |
| modify | `server/handlers/studioEditSchemas.ts`, `studioStructuralWriteback.ts`, `studioWriteback.ts` | The seven kinds |
| modify | `server/handlers/studio/reloadScope.ts` | A touched layer file maps to its layer page id for a narrowed reload |
| modify | `src/core/ast-codemods/transplantJsxElement.ts` (+ split per the 700-line budget) | Endpoint unions: `origin: element \| module-root`, `destination: container \| new-module`. One scope analysis, one import carry, byte-exact splices |
| create | `src/core/ast-codemods/canvasLayerModule.ts` | Builds a layer module's text from (i) an insert spec or (ii) a transplanted subtree plus carried imports. Relative specifiers are recomputed from `.studio/canvas/`, and aliases are kept |
| create | `src/core/ast-codemods/bakeCapturedBindings.ts` | Copy-with-values (§7). Substitutes captured identifiers with their **server-resolved** static values from the parse cache. Shares the substitution engine P1-E/P5-C build for detach |
| create | `server/ai/mcp/tools/studio/canvasLayerTools.ts` | `studio_list_canvas_layers`, `studio_canvas_layer` (§5.3) |
| modify | `server/ai/tools/studio/liveDigest.ts` | A separate "Free canvas (not in any page)" section |
| modify | store: `store/slices/site/types.ts`, `nodeIndex.ts`, `helpers.ts` (`resolveActiveTreeTarget`), `lifecycleActions.ts` (load/patch), `dirtyTracking.ts` / save diff, `store/store.ts` (`lookupCanvasPageById`, `selectCanvasPageFor`) | `canvasLayerPages: Record<pageId, Page>` on the site slice **state**, not inside the persisted `SiteDocument`. Every node→page lookup consults it |
| create | `store/slices/site/canvasLayerActions.ts` | `createCanvasLayers`, `liftToCanvas`, `placeCanvasLayer`, `duplicateCanvasLayers`, `removeCanvasLayers`, all on `structuralCommitQueue` |
| modify | `store/slices/boardSlice.ts`, `boardHistory.ts`, `boardsSaveGuard.ts`, `site/historyTypes.ts` | Placements; one history entry carrying **both** a `source` restore token and a `board` pair; layer ids join the save-guard baseline |
| create | `canvas/BoardCanvasLayer/` (`CanvasLayerSurface.tsx`, `CanvasLayerHost.tsx`, `canvasLayerWindow.ts`, `useCanvasLayerMove.ts`, `canvasLayerGapForwarding.ts`, `index.ts`) | The surface, hosts, windowing, move gesture and gap forwarding |
| modify | `canvas/StudioBoardLayers.tsx` | Mount `<BoardCanvasLayer/>` **before** `<BoardFramesLayer/>` (paints below) |
| modify | `canvas/canvasDropSurfaceRegistry.ts`, `canvasDragBoard.ts`, `canvasDragFrame.ts` | A registry entry is `(document, host element, pageId, frameId)`. A board frame's host is its viewport; a loose layer's host is its `CanvasLayerHost`. A release over no entry, with a loose-capable drag, becomes a **lift** |
| modify | `canvas/BoardFramesLayer/useMarqueeSelection.ts`, `canvas/boardSnapping.ts`, `canvas/useIframeEventForwarding.ts`, `canvas/useIframeCursorBridge.ts` | Marquee includes loose roots. Snapping peers include layer rects. Gap forwarding and armed-tool cursor on the surface |
| modify | `canvas/canvasFileDrop.ts`, `canvas/useCanvasFileDrop.ts`, `CanvasFileDropHint.tsx` | The empty-board refusal becomes "Place on canvas" |
| modify | `panels/DomPanel/…` (Layers) and `panels/PropertiesPanel/…` Measures | A "Canvas" section. X/Y on a loose root edits the placement |
| modify | `docs/features/board-annotations.md` → sibling `docs/features/free-canvas.md` (create), `docs/agent-refs/canvas-internals.md`, `studio-pipeline.md`, `editor-store.md`, `path-index.md`, `glossary.md` | Docs track code |

### 3.3 Routes

**None added.** `/load` carries `canvasLayers`, and `/save` carries the edit kinds. Board
placements ride the existing `/boards` autosave. The asset bytes for an image drop ride the existing
`asset-drop` route. `routeCapabilities.ts` and `subRouters.ts` are therefore unchanged, and
`studio-routes-capability-declared.test.ts` needs no new line. If a later need invents a route,
it is two edits (`subRouters.ts` plus `routeCapabilities.ts`) with capability `studio.write`.

### 3.4 Content and placement are two stores: how they stay honest

`boards.json` is **client-owned** (the 800 ms autosave overwrite pattern). The server must not
write it from a `/save` edit, or the next autosave reverts it (the `store-02` hazard). So:
- **Create, lift and duplicate.** The client mints `layerId` and adds the placement to board
  state as part of the same history entry. Then it posts the edit. If the post refuses or never
  reaches disk, the placement is rolled back with no history entry (the `commitStructuralBody`
  rollback path `perf-10` already has).
- **Place and delete.** The placement is removed in the same entry. If the write refuses, it is
  restored.
- **Load reconciliation (heal, silent).** A placement with no file is dropped. That is a confirmed
  removal, so `boardsPendingExplicitRemoval` is set for the guard. A file with no placement
  (a crash between the two writes, or an agent tool) gets a placement on the active board: the
  first free slot to the right of the board's content box. Both write through the autosave.
  **Nothing is ever shown as an error, and no file is ever deleted by a heal.**
- **Server-side writers (the MCP tool).** They write both stores and push the existing live
  reload, exactly as `studio_set_frames` does today.

---

## 4. Rendering, geometry and perf

### 4.1 The surface

- `CanvasLayerSurface` is built on `IframeFrameSurface` with `interaction: 'canvas'`. It runs the
  injector chain for editor chrome, project CSS, authored CSS, class overlay, user stylesheets and
  animation freeze. It never mounts:
  - scroll-unroll (a loose layer has no app shell);
  - auto-height (hosts hug by themselves);
  - `RuntimeScriptInjector` ("Run scripts"). This is **unconditional**. The free canvas never runs
    code.
- It is **always a portal (static) document**. At Tier 2, frames become `LiveBoardFrame`, and the
  surface does not. A component with hooks renders its static parse, exactly as a Tier-0 frame
  would. At Tier 1 the package components it imports are bundled through `componentBundle.ts`, the
  same as a portal frame. There is no new execution surface.
- Board default axes only (direction, colour scheme, locale). Loose layers have no per-frame axes.
- `html, body { background: transparent }` is set in the unlayered chrome sheet. Without it a
  project's `body { background: #fff }` would paint an opaque slab over the board. The surface's
  `color-scheme` is set to match the editor's. A mismatch makes the browser paint an opaque
  backdrop behind a transparent iframe.

### 4.2 Windowing

The surface is **not** sized to the bbox of all layers, because two layers 40,000 px apart would
make a 40,000 px document. The surface is a **window**:
- It covers the viewport plus one screen of margin, in board units, the same margin
  `frameVirtualization.ts` uses.
- It is re-fitted on viewport **settle**, the signal `BoardFramesLayer` already virtualizes on,
  never per pan tick.
- Re-fitting writes two things: the iframe's rect and one custom property, `--canvas-origin-x/y`,
  that every host's `left/top` is computed against. That is two style writes, no React commit, and
  a cheap layout (the hosts are absolute).
- Only layers whose placement rect intersects the window render. A layer is a small subtree, so
  remounting one costs microseconds, and there are no posters.
- During a layer drag, the window also includes the dragged layer's rect (style write only).

### 4.3 The host, and why it is not the §6.1 trap

`PROJECT-BRIEF.md` §6.1 forbids a wrapper **between authored elements**, because it breaks `%`/flex
chains and `>`/`+`/`:nth-child` combinators. A loose root has **no authored parent**: in a frame its
parent is `<body>`, which is also Studio's. The host is that `<body>`:
- `position: absolute; left/top` from the placement;
- `width: w` when set, otherwise `max-content`;
- `display: flow-root`, so the root's margins do not collapse out.

A fill-width root therefore fills `w` exactly as it filled its page container. The one fidelity
difference is a selector that names `body` itself (`body > :first-child`). It is documented, and it
cannot affect a page.

**The exception is scoped by a gate:** `data-studio-canvas-host` is rendered only by
`CanvasLayerHost.tsx`, and `IframeFrameSurface` frames never contain one (§8, gate 3).

### 4.4 Paint order and input

- The surface paints **below** frames and annotations. Frames catch their own pointer events
  directly. In the surface, a `pointerdown` whose target is `body`/`html` (a gap between layers) is
  forwarded to the board as an empty-board press, so it can start a marquee, deselect, space-pan or
  draw with an armed tool. It re-arms `markCanvasPointerRelay` for the stream, which is the relay the
  reorder drag already uses.
- **During a move-drag** of a loose layer, the surface's `z-index` is raised above frames for the
  gesture. The layer stays visible while you aim it at a frame, and hit-testing is geometric
  (`canvasDragBoard` rects), not DOM. It drops back on pointerup.
- A loose layer that sits wholly under a frame is reachable from the Layers panel. That is the
  visible cost of "below frames": **OD-FC-2**.

### 4.5 Coordinates

- The board rect of a layer is `placement.(x, y)` plus the host's measured size. The **visual**
  rect (ring, snapping, marquee) is the root's `nodeVisualRect`, projected through the surface
  iframe's board origin. That is the same `frame origin + element rect` arithmetic
  `BoardPrototypeLayer` uses (08-svg §4.2(c)). It is pixel-exact because iframe content is unscaled.
- Rotation (P5-F) is on the root, so the ring uses the rotated visual rect. The host does not
  rotate.

### 4.6 Perf budgets (FC-10 gates them; all on the e2e runner `studio-board-perf.e2e.ts` uses)

| Budget | Target |
|---|---|
| Pan with 50 on-screen loose layers (30 `<img>`, 10 DS components, 10 boxes) + 12 frames | worst frame < 40 ms; layer mutations < 10; mean within 10% of the same board with 0 layers |
| Zoom-out that brings all 50 into view | worst < 250 ms, mean < 35 ms; **iframe count grows by exactly 1** (`iframe[data-studio-canvas-surface]` count = boards with layers) |
| Move-drag of a loose layer | **0 React commits per pointermove** (commit counter); ≤ 1 host style write per rAF; 0 `/save` during the drag; exactly 1 board autosave after |
| Drag in / drag out / Alt copy | exactly **1** `/save` POST per gesture; **1** history entry |
| Surface mount with 50 layers | < 60 ms to content-ready |
| `/load` warm with 50 layer files | + < 50 ms over the same project without layers |
| Selection → ring on a loose layer | < 32 ms (01 §3 item 3) |

---

## 5. Gestures, panels and the agent

### 5.1 Gesture table (gesture → write)

"Board" means a placement change on the board autosave, recorded as a history `board` pair.
"Source" means one `/save` batch. Every row is **one gesture = one write = one history entry**.
A row that has both is one entry holding both.

| # | Gesture | Write | Undo |
|---|---|---|---|
| G1 | Drag a card from the Assets panel onto empty board (DS-4b) | Source `canvas-layer-create` + board placement at the drop point (fill roots get `w = 360`) | restore + board pair |
| G2 | Drop image file(s) from the OS onto empty board | Bytes via the existing `asset-drop` (P5-B landing contract) → source `canvas-layer-create` × N in **one** batch, laid out in a row at the pointer; `<img src width height alt>` with intrinsic size | restore (the bytes stay; P5-B's asset ledger owns unused files) |
| G3 | ⌘V with the pointer over empty board and no frame selection | P5-A pipeline. Copied nodes → `canvas-layer-lift {copy:true}` from their origin ids (P3-D's clipboard contract); an image or SVG on the OS clipboard → G2 / G5 | restore |
| G4 | Armed R / O / F / T (P5-E): click or drag starting on empty board | `canvas-layer-create` (`div` / text) with the drawn width/height inline. T starts the inline edit when the resync lands (`pendingCreatedSelection.ts`) | restore |
| G5 | Pen / pencil / line / arrow (P5-D SVG-7) finishing on empty board | `canvas-layer-create` with the `<svg>` subtree (SVG-5 subtree spec) at the drawn bbox origin | restore |
| G6 | Drag a loose layer's root; arrow-nudge a selected loose root | Board x/y only. Zero React commits (host `translate` per rAF), committed on pointerup. Snaps to frame edges and centres, other layers and guides (`boardSnapping.ts`) | board pair |
| G7 | Drag a **child** inside a loose layer | Existing same-document reorder (same file) or cross-virtual-frame transplant (another layer or a frame) | existing |
| G8 | Release a dragged loose layer **over a frame** | Drop resolved in that frame (`resolveCanvasPointerInsertionDrop`, drop line painted there) → source `canvas-layer-place` (module deleted, root spliced into the page file, imports carried) + board placement removed. **⌘** = K6: adds `absolute {left, top}` in the same edit (K6's refusal and remedy if the parent is static). **⌥** = copy: the layer stays | restore of both files + board pair |
| G9 | Drag an element **out of a frame** and release over empty board | Source `canvas-layer-lift` (origin spliced out, new module written) + placement at the element's current top-left under the grab offset; `w` = the measured width if the element was `fill`. **⌥** = copy | restore + board pair |
| G10 | Drag an element out of a loose layer onto empty board | Same as G9 (lift from a layer module into a new module) | same |
| G11 | ⌥-drag a loose layer on the board; ⌘D | Source `canvas-layer-duplicate` + placement at the drop point / diagonal step (the annotation ladder rule) | restore + board pair |
| G12 | Resize handles on a loose root | §1.3: horizontal-only on a `fill` root → board `w`; otherwise → element `sizingPatch('fixed')` (P2-D) | one or the other |
| G13 | Rotate (P5-F) | Source: root `rotate` | existing |
| G14 | Marquee from empty board or a surface gap | Selects frames, annotations **and loose roots** (loose roots join `selectedNodeIds` with `clearOthers = false`, the annotation marquee rule). A board move of a mixed selection moves frames and loose layers together as one board pair | board pair |
| G15 | Delete / Backspace | Loose roots → `canvas-layer-delete`. Page nodes in the same selection → `delete`, **in the same batch**. Placement removed | restore + board pair |
| G16 | Bring to front / send to back / `]` `[` | Board `z`, among loose layers only | board pair |
| G17 | ⌘G on ≥ 2 loose layers; ⇧⌘G on a canvas group | FC-9: `canvas-layer-group`. The new root is `div` with `position: relative` and the union size, and the members become `position: absolute; left; top` children (their positions survive). Ungroup reverses. Mixing frames or page nodes in the selection → one-line refusal | restore + board pair |
| G18 | Lock / hide; rename in Layers | Board `locked` / `hidden` / `name` | board pair |
| G19 | Double-click text in a loose layer | Existing inline edit | existing |
| G20 | Delete a board that holds loose layers | `canvas-layer-delete` × N in the board-delete gesture | restore + board pair |

**Why the root drag is a board move and a child drag is a reorder.** It is the same split Penpot
makes. Penpot's move stream picks the target frame under the pointer every tick
(`transforms.cljs:755`, `top-nested-frame` then `get-drop-index`). The release relocates the shapes
in one change set (`move-shapes-to-frame`, `transforms.cljs:1180`), and a target of the root frame
(`uuid/zero`) means "loose". Studio's version: the pressed node **is** a layer root → board move with
a frame hit-test each rAF. Otherwise → the existing element drag, whose "release over no frame"
becomes a lift.

### 5.2 Panels

- **Layers (`DomPanel`).** A "Canvas" section at the top, per active board. It lists loose roots
  in z order (top first), and each is expandable into the ordinary `Tree*` rows of its subtree.
  The row label is `placement.name`, otherwise the root's component or tag name. Lock and hide
  toggles write the placement. It never lists frames' pages, and the page sections never list it.
- **Inspector.** It is unchanged for every node, because a loose node is a node in a page
  (`canvasLayerPages`) with the same `isPropWritableToSource` answers. One routing rule: on a
  **loose root**, the Measures X/Y fields read and write the placement, not `left/top`.
  `resolveMeasureTarget` decides this in one place. W/H follow §1.3.
- **Context menu on a loose root:** Move into frame… (a list of on-screen frames: place as last
  child), Duplicate, Bring to front / Send to back, Group, Lock, Hide, Delete.

### 5.3 Agent and MCP

- **Pages stay pages.** `studio_list_pages` reads `loadStudioPages().pages` and never sees a layer
  (gate). `studio_read_file` already rejects `.studio` segments (`projectTools.ts:474`), and the
  agent's Edit scope excludes `.studio` (`agentWriteScope.ts`). So the agent cannot write a layer
  module except through the tools below.
- `studio_list_canvas_layers { boardId? }` → `[{ layerId, boardId, x, y, w?, z, name, root: { tag
  | component, nodeId } }]`. Read, `site.read`.
- `studio_canvas_layer { op: 'create' | 'move' | 'delete' | 'place' | 'lift', … }`. Write,
  `studio.write`. It writes the module and the placement server-side, then pushes the live reload
  (the `studio_set_frames` pattern). `create` takes the same element spec as `studio_apply_edits`'s
  `insert`. `place` takes a destination container node id.
- The live digest lists loose layers under **"Free canvas (not in any page, not in the app)"**. The
  prompt gains one line: *"loose layers are scratch; they are never shipped. Put final UI in a
  page."*
- `studio_screenshot` / `studio_export_frames` capture frames only. Loose layers are out of scope
  for capture in this bundle.

---

## 6. Exclusion proof, security and hygiene

### 6.1 Exclusion table

| Surface | Code path that picks what it shows | Why a loose layer cannot appear | Gate (§8) |
|---|---|---|---|
| Live preview (Tier-2 dev server, live frames) | `prototypeShell/registryFile.ts` imports `discoverPageFiles(projectPagesDir)` and emits a whitelist (`frames`, `notes`, `docs`) per board. `LiveBoardFrame` iterates `board.frames`. Vite serves only modules reachable from `index.html` | Nothing imports `.studio/canvas/`. The registry never emits `layers`. `studioRuntimeIdPlugin` skips `.studio` (`vitePlugin.ts:60`). The surface is never a live frame | G-EX-1, e2e |
| Publish (CMS publisher) | Reads the DB `SiteDocument` | `canvasLayerPages` is slice state, **not** a `SiteDocument` field, so nothing serializes it | G-EX-2 |
| Deploy (`deploy.ts`, Tier 2) | The user's own build from `index.html` | Same as the live preview: unreachable | G-EX-1 |
| Share (`shareSnapshot.ts:110`) | `input.board.frames` | Reads frames only | G-EX-3 |
| Prototype flows / flow map (`prototypeCodeFlow.ts`, `prototypeNavScan.ts`, `prototypeRouteIndex.ts`) | Page files via `listWorkspaceFiles` / pages dir | `.studio` is in `EXCLUDED_WORKSPACE_DIR_NAMES` | G-EX-3 |
| Download zip (`studioDownload.ts`) | `listWorkspaceFiles` minus `.studio` | Excluded by design | G-EX-3 |
| Typecheck (`typecheck.ts`, `studio_typecheck`) | The project's own `tsc` + tsconfig | tsc's default wildcard skips dot-directories. The tool layer also drops any `.studio/` diagnostic path | G-EX-4 |
| Page list UI, frame picker, Add-page, Prototype panel | `site.pages` | Layers live in `canvasLayerPages` | G-EX-2 |
| `studio_list_pages`, digest page list, `studio_compare`, fidelity tools | `loadStudioPages().pages` | Layers are in `canvasLayers` | G-EX-2 |
| Git panel staging / commit | `gitOperations.ts:162` | `.studio` is filtered and unreachable (`gitPaths.ts`) | existing |
| Component catalog / Assets panel | `componentSources.ts:58` globs exclude `.studio` | A layer module is never a project component | existing |
| Project probe (pages-dir heuristic) | `NON_PAGES_DIR_SEGMENTS` + the walk | `.studio` excluded | existing |

### 6.2 Security

- **Write path.** `isWritableSourceRel` gains one exception, `canvasLayerIdFromRel(rel) !== null`
  (the exact `^\.studio/canvas/cl[a-z0-9]{10}\.tsx$` shape), and **rejects every other excluded
  segment**. That is stricter than today. Create and lift build the path from a validated
  `layerId`, never from a client path. The containment and realpath checks are unchanged.
  **security-guard reviews FC-1 and FC-2.**
- **Execution.** Nothing new runs. Tier 0 parses. Tier 1 bundles package components exactly as it
  does for portal frames. Tier 2 never loads a layer module (§6.1 row 1). The surface never mounts
  `RuntimeScriptInjector`.
- **Agent.** Tool-only access (§5.3). Raw `.studio` stays unreadable and unwritable to the agent's
  file tools.

### 6.3 Hygiene in the user's repo

- Every layer module starts with `/* eslint-disable */` and a one-line "not part of your app"
  comment. ESLint v9 flat config lints dot-directories, and a scratch file must never fail the
  user's `eslint .`.
- `.studio/` is already in Studio's scaffolded `.gitignore`. For a cloned repo whose own
  `.gitignore` lacks it, Studio's panel still never stages it. A terminal `git add -A` would, which
  is the same exposure `boards.json` has today.
- P1-D's watcher ignores `.studio/`. It must still watch `.studio/canvas/`, so an outside edit to a
  layer module reloads the layer (collision note §10).

---

## 7. Refusals and their automatic resolutions

The bar is "zero visible errors; magically solve it". A resolution below is automatic only where it
destroys nothing. Otherwise it is one honest sentence with a one-click remedy.

| Case | Resolution |
|---|---|
| A component with hooks or state on the canvas | **No refusal.** It renders statically, like any Tier-0 frame. At Tier 2 the surface stays static, and nothing says "error" |
| **Lift (move) of markup that reads page scope** (`captured-scope`: a prop, a hook result, a `.map` row parameter) | Moving the markup would either destroy the binding (bake it into literals) or break the file. So the gesture **automatically becomes a copy with values baked**: the server substitutes each captured identifier with its statically resolved value from the parse cache (`bakeCapturedBindings.ts`). The original stays untouched in the page. Quiet notice: *"Placed a copy: it reads `title` from the page, so the original stays."* Undo. An attribute whose value cannot be baked (a function, an unresolved value) is left off the copy and named in the notice. Nothing in the user's source changes |
| Lift of a `.map` row (`list-row`) | Same: a copy of that row with that row's values baked |
| Lift from inside a shared component (`shared-component`) | OD-7: this instance only. It goes through P3-D's `planSourceTransplant` (detach, then lift, as one gesture). If detach refuses, it becomes a copy (`copyEscapesOriginRefusal`) |
| Lift of route chrome (`route-chrome`: layout markup every page renders) | A copy, with the notice *"Copied: this is part of the layout every page shares."* |
| Lift of `code-placed` markup (a spread, a slot fill, an SVG built in code) | Refuse, because there is no source range to move: *"This is built by code, so there's no markup to move. Drag its parent instead."* Button: *Select parent* |
| Place into a page where a carried import name collides | P1-E aliasing (`styles` → `cardStyles`), automatic |
| ⌘-place into a `position: static` container | K6's existing refusal, with its one-click "make the parent `position: relative`" remedy |
| A layer imports a component that was deleted or moved | If exactly one project component exports that name, **relink automatically** (the existing `set-import-specifier` codemod on the layer module, which is Studio's own file and touches no user code), with a quiet status line. Otherwise the layer renders a neutral placeholder at its last size, labelled with the component's name, and its Layers row offers *Relink…* (the component picker) or *Delete* |
| A layer module no longer parses (edited outside Studio) | Render the **last good parse** from the parse cache. The Layers row shows a quiet "can't read" dot with *Open file*. No toast |
| A placement without a file / a file without a placement | Silent heal (§3.4) |
| Tailwind classes used only on a loose layer | Handled by FC-1's compile source, so nothing to refuse |
| Group across frames and loose layers | *"Frames and canvas layers can't be grouped together."* One line, no dialog |

---

## 8. Gates

| # | Test | Asserts |
|---|---|---|
| 1 | `src/core/studio-board/__tests__/canvasLayers.test.ts` | Id minting shape; `canvasLayerIdFromRel` accepts only the exact shape (it rejects `..`, other extensions, nested dirs, uppercase, `.studio/canvas/../x.tsx`) |
| 2 | `server/handlers/__tests__/studioEditRouting.test.ts` (extend) | `.studio/meta.tsx`, `.studio/x/y.tsx`, `node_modules/a.tsx` are **refused**; `.studio/canvas/cl0123456789.tsx` is accepted |
| 3 | `src/__tests__/architecture/canvas-layer-isolation.test.ts` (NEW) | (a) The string `.studio/canvas` appears only in `@core/studio-board/canvasLayers.ts`. (b) `canvasLayerPages` / `canvasLayers` are read only by an allowlist (site slice, `canvas/BoardCanvasLayer/`, Layers "Canvas" section, `canvasLayerLoad.ts`, `studioPageLoad.ts`, the MCP tools, the digest). (c) `data-studio-canvas-host` is rendered only by `CanvasLayerHost.tsx`. (d) `CanvasLayerSurface` never imports `RuntimeScriptInjector` |
| G-EX-1 | `server/handlers/studio/prototypeShell/__tests__/registryFile.test.ts` (extend) | The generated registry is **byte-identical** with and without `board.layers`, and contains no `.studio` |
| G-EX-2 | `server/handlers/__tests__/studioPageLoad.canvasLayers.test.ts` (NEW) | Layers appear in `canvasLayers`, never in `pages`. Their stylesheets are registered. Touching a layer file invalidates the memo. `studio_list_pages` output is unchanged by adding layers. A `SiteDocument` serialized from a store holding layers equals the one without |
| G-EX-3 | `shareSnapshot` / `studioDownload` / `prototypeNavScan` tests (extend) | A fixture with layers yields identical outputs to one without |
| G-EX-4 | `server/ai/mcp/tools/studio/typecheck.test.ts` (extend) | `.studio/` diagnostic paths are dropped |
| 4 | `src/core/studio-board/__tests__/serialize.test.ts` + `server/handlers/studio/__tests__/boardFrames.test.ts` (extend) | `layers` round-trips through every server-side boards writer (page create or delete keeps them) |
| 5 | `src/core/ast-codemods/__tests__/transplantJsxElement.canvas.test.ts` (NEW) | New-module destination and module-root origin: byte-exact subtree, carried and re-specified imports, both files or neither, copy leaves the origin byte-identical, every refusal leaves both files byte-identical |
| 6 | `src/core/ast-codemods/__tests__/bakeCapturedBindings.test.ts` (NEW) | Props, text, `.map` row params baked from server-side values; functions dropped and named; origin never touched |
| 7 | `store/__tests__/canvasLayerActions.test.ts`, `boardsSaveGuard.test.ts` (extend) | One history entry holds restore + board pair. Rollback on refusal. Heal rules. Layer ids join the guard baseline |
| 8 | `tests/e2e/studio-free-canvas.e2e.ts` (NEW) | Uses **computed layout**. (i) Assets drop on empty board → after a reload, the host's measured client rect = placement × zoom (± 1 px). (ii) Drag into a frame → the element's measured rect is inside the frame's iframe rect, the module file is gone, and 1 `/save` fired. (iii) Drag out → the reverse. (iv) ⌘Z restores both files byte-identically. (v) ⌥ copy. (vi) On `__vite-live-fixture` at Tier 2, the live frame's network log has no `/.studio/` request and its DOM has no layer markup. (vii) An OS image drop on empty board lands an `<img>` whose natural size equals its rendered size |
| 9 | `tests/e2e/studio-board-perf.e2e.ts` (extend with a 50-layer variant) | The §4.6 budgets |

Architecture gates to update: `studio-routes-capability-declared.test.ts` (none, no route).
`no-core-barrel-deep-imports.test.ts` (none; `canvasLayers.ts` is exported through
`@core/studio-board`'s barrel). `single-drag-mechanism.test.ts` (none; pointer events only).
`module-size-budgets` (the `transplantJsxElement.ts` split).

---

## 9. Work orders

Each order leaves the tree building. Verification per ROADMAP §3: canvas/geometry orders run their
e2e specs, and UI-only orders stop at static gates plus an owner dogfood checklist.

| Order | What | Files (main) | Owner | Tests | Effort | Depends on |
|---|---|---|---|---|---|---|
| **FC-1** Storage, load, exclusion | `canvasLayers.ts`; placement schema + `coerceLayer`; `canvasLayerLoad.ts`; `canvasLayers` in the load result (styles included, never in `pages`); memo fingerprint; Tailwind compile source; `isWritableSourceRel` tightening; glossary. **No UI**: layers load and are ignored by the client | §3.2 rows 1–9 | server-engineer + parser-surgeon; **security-guard review** | 1, 2, 3(a), G-EX-1…4, 4 | M | P1 barrier (P1-A fingerprint) |
| **FC-2** Codemods + edit kinds | Transplant endpoint unions; `canvasLayerModule.ts`; `bakeCapturedBindings.ts`; `canvas-layer-create/lift/place/duplicate/delete` in the save batch, each recording a P3-F pre-image; `reloadScope` mapping | `transplantJsxElement.ts` (+ split), `studioEditSchemas.ts`, `studioStructuralWriteback.ts`, `studioWriteback.ts`, `reloadScope.ts` | parser-surgeon + server-engineer; **security-guard review** | 5, 6, server batch tests | L | FC-1, P3-D (planner), P3-F (journal), P1-E (substitution engine) |
| **FC-3** Store | `canvasLayerPages` + node index + lookups + save diff; placements in `boardSlice`; history entry with restore + board pair; `canvasLayerActions.ts` on `structuralCommitQueue`; load heal; save guard | §3.2 store rows | store-engineer | 7, `selectCanvasPageFor.test.ts` (extend: a loose node costs O(1)) | M/L | FC-2 |
| **FC-4** Surface | `BoardCanvasLayer/`: surface, hosts, windowing, transparent body, below-frames paint, gap forwarding, virtual-frame registry entries, one selection overlay per surface document | `canvas/BoardCanvasLayer/*`, `StudioBoardLayers.tsx`, `canvasDropSurfaceRegistry.ts`, `useIframeEventForwarding.ts`, `useIframeCursorBridge.ts` | canvas-engineer + perf-hunter | 3(c)(d); e2e 8(i); perf 9 (pan/zoom rows) | L | FC-3, P2-I (selector sweep; so the surface's nodes do not add to PERF-1) |
| **FC-5** Board gestures | G6 move with snapping and frame hit-test; G8 place (flow / ⌘ absolute / ⌥ copy); G9–G10 lift; G11 duplicate; G12 resize routing; G14 marquee + mixed board move; G15 delete; G16 z; G18 lock/hide; keyboard (Delete, ⌘D, arrows) | `useCanvasLayerMove.ts`, `canvasDragBoard.ts`, `canvasDragFrame.ts`, `useMarqueeSelection.ts`, `boardSnapping.ts`, `useCanvasSelectionKeyboard.ts` | canvas-engineer + store-engineer | e2e 8(ii)–(v); perf 9 (drag rows) | L | FC-4, P2-C/P2-D/P2-E (arrows, resize, snapping) |
| **FC-6** Creation entry points | G1 Assets → board (closes DS-4b); G2 OS image drop replaces the empty-board refusal (`canvasFileDrop.ts`, `CanvasFileDropHint`); G3 paste; G4 armed tools; G5 SVG draw. **Each piece lands inside its own P5 bundle's PR** (see §10), not as a fork of it | `canvasFileDrop.ts`, `useCanvasFileDrop.ts`, `useCanvasInsertionDrag.ts`, `useCanvasToolShortcuts.ts`, `BoardVectorLayer` | canvas-engineer + server-engineer | e2e 8(vii); each bundle's own spec gains an "on empty board" case | M | FC-5 + P5-A / P5-B / P5-D / P5-E |
| **FC-7** Panels | Layers "Canvas" section; Measures X/Y → placement; rename; context menu | `panels/DomPanel/…`, `panels/PropertiesPanel/…` Measures | panel-designer | Static gates; unit test for `resolveMeasureTarget`; dogfood checklist | M | FC-5 |
| **FC-8** Agent | `studio_list_canvas_layers`, `studio_canvas_layer`; digest section; prompt line; docs | `canvasLayerTools.ts`, `liveDigest.ts`, `index.ts` | mcp-tooling | Tool tests; digest snapshot shows the separate section; `studio_list_pages` unchanged | S/M | FC-3 |
| **FC-9** Group / ungroup | G17 codemods and gestures | `canvas-layer-group/ungroup` in FC-2's files; canvas ⌘G routing | parser-surgeon + canvas-engineer | Codemod tests (positions survive a round trip); e2e measured member rects unchanged after ⌘G | M | FC-5 |
| **FC-10** Budgets + docs | The §4.6 perf variant; the full e2e; `docs/features/free-canvas.md`; updates to `canvas-internals.md`, `studio-pipeline.md`, `editor-store.md`, `path-index.md`, `board-annotations.md` (cross-link) | `tests/e2e/*`, docs | perf-hunter + test-engineer; studio-scribe for docs | 8, 9 | M | FC-5 (budgets), FC-7 |

**Deletions:**
- The empty-board refusal branch in `canvasFileDrop.ts` and its "Drop onto a frame" hint copy (FC-6).
- The note in `canvas-internals.md` that the empty board "is not a file" (FC-10).

Nothing else is superseded. This is a new capability, not a replacement.

---

## 10. Collisions with ROADMAP bundles

| Bundle | Collision | Rule |
|---|---|---|
| **P1-A** fingerprint | Lift and place carry the origin/destination fingerprint | FC-2 after P1-A |
| **P1-D** watcher | The watcher ignores `.studio/`, and must still watch `.studio/canvas/` | P1-D's owner adds the one exception, citing this doc; if P1-D has already landed, FC-1 adds it |
| **P1-E** writer correctness | `bakeCapturedBindings` reuses detach's symbol-based substitution; carried imports alias on collision | FC-2 after P1-E; one substitution engine, not two |
| **P2-I** selector sweep | The surface adds nodes to the per-node selector sweep | FC-4 after P2-I |
| **P3-D** transplant | P3-D's `planSourceTransplant`, clipboard with verbatim JSX, cross-file reparent → transplant | FC-2 builds on P3-D's planner; **`transplantJsxElement.ts` is serial between P3-D and FC-2** |
| **P3-F** restore journal | Every `canvas-layer-*` records a pre-image, and ⌘Z is `restore` | FC-2 after P3-F; `.studio/undo-journal/` is already excluded like `.studio/canvas/` |
| **`studioEditSchemas.ts` / `studioWriteback.ts`** (ROADMAP §11) | FC-2 adds seven kinds | Joins the serial queue after P5-D SVG-4 / P5-C DET-7, or before them; never in parallel |
| **P5-A** paste | G3 consumes P5-A's `paste` event and copy marker | FC-6 does **not** edit `useCanvasNodeShortcuts.ts` (the §11 rule); it adds the "pointer over empty board" branch in P5-A's dispatcher |
| **P5-B** images | G2 uses P5-B's landing contract (one server-derived `src`, intrinsic size, multi-file = one batch). IMG-2's sibling insert defines the multi-node shape `canvas-layer-create` × N mirrors | G2 ships inside P5-B's PR (item 1 or 4) |
| **P5-D** SVG | 08-svg's `BoardVectorLayer` already draws over empty board. On finish over empty board it calls `createCanvasLayers` with the SVG-5 subtree spec. OD-10 D1 is superseded by OD-14, so "pin where drawn" is unnecessary on the canvas | G5 ships inside SVG-7 |
| **P5-E** armed tools | IX-12's hover preview: over empty board, the preview is a ghost rect at the pointer (no drop line) | G4 ships inside P5-E; `keybindings.ts` is untouched by FC |
| **P5-F** rotation, multi-select resize | G13 uses P5-F's `rotate` write | No FC work beyond routing |
| **`NodeRenderer.tsx`, `selectionSlice.ts`** | FC-3/FC-4 touch lookups, not these files | If a change there proves necessary, it goes after P2-B and P2-I |

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| The surface's gap forwarding misses a board gesture (a marquee starting in a gap does nothing) | FC-4 e2e presses at a gap for each of marquee, deselect, space-pan and armed tool, and asserts the board-level effect |
| Paint-below-frames surprises the owner (a layer disappears under a frame) | OD-FC-2; drag-time lift; Layers row always reachable |
| The `transplantJsxElement.ts` generalization regresses D2 G3 | The existing transplant suite runs unchanged; unions are additive endpoint shapes with one shared scope analysis |
| `boards.json` and the module diverge (crash between writes, agent tool) | §3.4 heal: silent, never deletes, gated by test 7 |
| A server-side boards writer drops `layers` (data loss) | `coerceLayer` in `serialize.ts` and gate 4 across every writer |
| The windowed surface shows an empty region during a very fast long pan | Same behaviour and margin as frame virtualization; re-fit on settle; budget-gated |
| The write-path exception widens | Exact-shape regex in one module; gate 2 asserts the other `.studio` paths are now refused (stricter than today) |
| Tailwind, CSS-in-JS or CSS-module classes on a loose-only element do not render | FC-1 adds `.studio/canvas/` to Studio's own compile scan; gate G-EX-2 asserts a loose-only class's rule is in `authoredCss` |
| ESLint in the user's CI flags layer modules | `/* eslint-disable */` header written by the only module builder (`canvasLayerModule.ts`), asserted in test 5 |

---

## 12. Owner decisions still open (only the necessary ones)

- **OD-FC-1: should loose layers sync across machines through git?** The recommendation is
  **no, same as `boards.json`**: both live in `.studio/`, which Studio gitignores. "Still there after
  reload and restart" is satisfied either way. If the owner wants boards to sync, that is one
  decision covering `boards.json` and `.studio/canvas/` together, and it does not change this
  design.
- **OD-FC-2: loose layers paint below frames.** This is the cost of one shared surface per board,
  which is the perf decision. While you drag a layer it lifts above frames, and a layer hidden under
  a frame is always selectable from Layers. Figma interleaves root shapes and frames in one z-order.
  Matching that exactly needs one iframe per layer, which fails the 50-layer budget (§1.2). The
  recommendation is **accept below-frames**.

Decided here (with the reason recorded above, so a later agent does not silently reverse them):
- TSX modules in `.studio/canvas/`, one per layer; placement in `boards.json` (§1.1).
- A shared, windowed, always-static surface with a per-layer host (§1.2, §4).
- Position and host width are board metadata; the root's own size and rotation are source (§1.3).
- A `captured-scope`, list-row or route-chrome lift becomes a copy with values baked. Never a
  binding-destroying move (§7, invariant 2).
- No new route (§3.3).
