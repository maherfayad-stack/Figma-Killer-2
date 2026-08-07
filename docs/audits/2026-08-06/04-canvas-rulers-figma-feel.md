# Audit: Rulers + De-Studio-ify the canvas surface

Scope read in full: `src/admin/pages/site/canvas/**`, `src/admin/pages/site/toolbar/**`,
`src/admin/pages/site/sidebars/**`, `src/core/studio-board/**`, plus
`useCanvas.ts`, `canvasSlice.ts`, `boardSlice.ts` and its sibling action modules.

---

## PART A — Rulers

### A1. The exact transform math

Single source of truth: `src/admin/pages/site/canvas/math.ts` (comment at top of file)
and `CanvasTransformLayer.module.css`.

```
transform: translate(panX, panY) scale(zoom)     // CSS list order = matrix mult order
transform-origin: 0 0
```

For a point at **local content coordinates** `(lx, ly)` inside `.transformLayer`
(i.e. board-space for Studio boards, or the flex-laid-out breakpoint position for
CMS mode), the on-screen point is:

```
screenX = lx * zoom + panX
screenY = ly * zoom + panY
```

confirmed by `canvasToScreen()` / `screenToCanvas()` in `math.ts:70-81` and by
`frameVirtualization.ts:8-13`'s own module doc for board frames specifically:

```
screenX = panX + bx * zoom
screenY = panY + by * zoom
```

**This is relative to `.transformLayer`'s own static (pre-transform) box
position**, not to `.canvas`'s (the outer viewport) top-left. `.transformLayer`
itself is positioned via plain CSS (`CanvasTransformLayer.module.css:17-30`):

```css
.transformLayer {
  position: absolute;
  top: 80px;
  left: 80px;
}
```

So the full screen-space formula, relative to `.canvas`'s own `getBoundingClientRect()`
(`CanvasRoot.tsx`'s outer `canvasRef` div, `data-testid="canvas-root"`), is:

```
screenX_in_canvas = 80 + panX + lx * zoom
screenY_in_canvas = 80 + panY + ly * zoom
```

and in true viewport (`clientX/clientY`) space, add `canvasRootRect.left/top`.

**Landmine for ruler-tick math (V1 below):** `frameVirtualization.ts`'s documented
formula omits the `+80` static offset entirely. That's a deliberate, harmless
simplification for its own use (culling with a 600px margin — `FRAME_VIEWPORT_MARGIN`,
`frameVirtualization.ts:42`), but it is NOT accurate enough for a ruler tick or a
"32px" dimension label, which must be pixel-exact. A ruler implementation must
either (a) read the true origin from a live DOM measurement
(`transformLayerRef.current.getBoundingClientRect()`, which already bakes in the
static offset + the current transform), or (b) import the same `80` constant the
transform layer's CSS encodes today as a magic number — option (a) is strictly
safer since nothing then depends on that number staying `80`.

Zoom bounds: `MIN_ZOOM = 0.1`, `MAX_ZOOM = 4`, `INITIAL_ZOOM = 0.5`, `RESET_ZOOM = 1`,
preset steps `ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]` (`math.ts:11-25`).
Pan bounds: `MAX_PAN = 50_000` (`math.ts:23`).

**Store shape** (`canvasSlice.ts:38-95`): `zoom: number`, `panX: number`, `panY: number`,
committed by `setCanvasTransform`/`setPan`/`setZoom`, all clamped through
`clampZoom`/`clampPan`. **During an active gesture the store is NOT the live
value** — `useCanvas.ts` keeps a `transformRef` (a plain `useRef`, not React
state) that leads the store by up to ~100ms (the debounced `scheduleStoreCommit`,
`useCanvas.ts:213-218`) and writes the DOM transform directly via
`applyTransformToDOM` (`useCanvas.ts:134-176`), batched into `requestAnimationFrame`
(`scheduleTransformWrite`, `useCanvas.ts:198-205`). **A ruler that reads `zoom`/
`panX`/`panY` from `useEditorStore` via a normal selector will lag the actual
on-screen transform by up to ~100ms during a pan/zoom gesture** — visibly wrong
tick positions mid-drag. The ruler must either (a) subscribe the same way
`useCanvas.ts` does — an imperative `useEditorStore.subscribe` + a ref, writing
its own tick positions to the DOM directly, same rAF-batched pattern — or (b) be
handed the same `transformRef`/an equivalent live subscription from `useCanvas`'s
return value (currently `useCanvas` returns `{ bind, handleKeyDown, panBy,
centerOnBreakpointFrame, isDragging }` — no live transform getter is exposed
today; this is the one hook change rulers need).

### A2. Board-space vs screen-space conversion — where it lives today

- `src/admin/pages/site/canvas/math.ts` — pure, generic `screenToCanvas`/`canvasToScreen`/`applyZoom`/`applyPan` (canvas-local, i.e. relative to `.canvas`'s own top-left, NOT accounting for the `.transformLayer`'s `80,80` static offset — callers that need board-space vs `.canvas`-space must add it themselves; today only `useCanvas.ts`'s wheel-zoom origin and `getViewportCenter()` do this, both computing screen-relative-to-`.canvas` points, never board-space).
- `src/admin/pages/site/canvas/canvasDomGeometry.ts` — cross-iframe measurement: `getViewportLocalPoint`, `clientPointToEditorDoc` (iframe-local → editor-doc, used for context menus), `panToCenterBreakpointFrame` (screen-space centering math), `nodeVisualRect` (box-less element fallback), `measureCanvasDropCandidates`.
- `src/admin/pages/site/canvas/BoardFramesLayer/frameVirtualization.ts` — the one place that documents board-space → screen-space explicitly for board frames (see A1); reuse its `ViewportState` shape for the ruler's own viewport read.
- `src/admin/pages/site/canvas/canvasOverlayGeometry.ts` — `measureIframeLocalRect` (WS-5.1 in-iframe overlay geometry) — NOT board-space, iframe-internal; not directly reusable for rulers, which need board-space.

There is **no existing board-space ↔ screen-space helper module** a ruler can
import wholesale — closest is `frameVirtualization.ts`'s inline formula. Proposed:
extract a tiny `boardScreenGeometry.ts` (see spec below) so the ruler,
`frameVirtualization.ts`, and any future consumer share one implementation
instead of a third copy of `panX + x * zoom` appearing.

### A3. DOM layering today — where rulers must mount

```
CanvasRoot.tsx
  <div ref={canvasRef} class="canvas">          ← outer viewport, position:relative, overflow:clip
    <style> (reduced-motion override)
    <CanvasNotch/>                              ← untransformed chrome, position:absolute
    <CanvasModeToggle/>                         ← untransformed chrome
    <CanvasContextSelector/>                    ← untransformed chrome (conditionally)
    <ErrorBoundary>
      <CanvasTransformLayer ref={transformLayerRef}>   ← THE div useCanvas mutates .style.transform on
        (design mode) BreakpointFrame × N
        (board mode, lazy)  <StudioBoardLayers>
                               <BoardFramesLayer/>       ← position:absolute;top:0;left:0 inside transformLayer
                               <BoardNotesLayer/>
                               <BoardDocsLayer/>
                               <BoardGuidesLayer/>       ← transient snap-guide LINES (not persisted rulers)
    </ErrorBoundary>
    <PluginCanvasOverlayLayer/>                  ← untransformed, design+editable only
    <BoardNotesToolbar/>                         ← untransformed "+ Sticky note" button
    <CanvasLayerContextMenu/> / <CanvasRenameDialog/>
    <AgentSnapshotFrame/> (offscreen)
```

Everything that is a **sibling of `CanvasTransformLayer`, inside `.canvas`**
(`CanvasNotch`, `CanvasModeToggle`, `CanvasContextSelector`, `BoardNotesToolbar`,
`PluginCanvasOverlayLayer`) is chrome that does NOT get the pan/zoom transform —
this is precisely the mount point rulers need: **two new sibling components,
`CanvasRulerH`/`CanvasRulerV` (or one `CanvasRulers` bundling both), rendered
inside `<div ref={canvasRef}>` but outside `<CanvasTransformLayer>`**, exactly
where `CanvasNotch`/`CanvasModeToggle` already sit in `CanvasRoot.tsx`'s JSX
(`CanvasRoot.tsx:560-592`).

Precedent for "untransformed chrome reading transformed content's geometry":
`CanvasNotch`/`CanvasModeToggle` don't need geometry, but `BreakpointSelectionOverlay`
does — it already solves exactly this class of problem (see `canvas-05`/`canvas-06`
STATE.md entries + this file's `A1` landmine) via two different strategies:
mount INSIDE the iframe when possible (rings), or subscribe to a rarely-recomputed
anchor channel when not (toolbar/inspector). Rulers should follow the SECOND
pattern (parent-doc chrome, anchored via a live-updated channel), not the first —
a ruler is chrome, not per-node UI, and has no natural home inside any one iframe
(it spans the whole board).

---

## RULERS IMPLEMENTATION SPEC

### Component tree

```
CanvasRoot.tsx
  <div ref={canvasRef} class="canvas">
    ...
    {!isLive && rulersEnabled && (
      <CanvasRulers
        canvasRootRef={canvasRef}
        transformLayerRef={transformLayerRef}
      />
    )}
    <CanvasTransformLayer ref={transformLayerRef}>...</CanvasTransformLayer>
    ...
```

New files, all under `src/admin/pages/site/canvas/CanvasRulers/`:

- `CanvasRulers.tsx` — mounts `RulerH` + `RulerV` + the corner square + the
  measurement-readout tooltip. Self-gates: `null` in live mode (`isLive`) and
  `null` when the user preference `showRulers` is off (new preference, see
  below). Reads `activeBoard` (`selectActiveBoard`) only to decide the origin
  mode (A4) — otherwise geometry-agnostic.
- `RulerH.tsx` / `RulerV.tsx` — the two ruler strips (`position: absolute`,
  `top: 0` / `left: 0`, `height: 24px` / `width: 24px`, `z-index` above
  `CanvasTransformLayer` but the CORRECT side of the existing stacking
  contract — see `CanvasRoot.module.css:9-17`'s z-index comment; rulers are
  chrome, so they belong at the SAME z-index band as `CanvasNotch`, i.e.
  above rings (51) — rulers must never be covered by anything rendered on
  the board). Ticks are drawn as a single `<canvas>` 2D-context element per
  strip, NOT one DOM node per tick — a 30-frame board at 10% zoom can need
  hundreds of ticks across a huge pan range, and DOM nodes per tick would be
  the single most expensive thing on this surface. `<canvas>` also sidesteps
  the "no wrapper divs" rule entirely since it paints, it doesn't insert
  elements into anyone's layout.
- `rulerGeometry.ts` — pure functions, the ONE new shared board↔screen module
  (closes the gap in A2): `boardToScreen(lx, ly, transform, staticOffset)`,
  `screenToBoard(...)`, and `TRANSFORM_LAYER_STATIC_OFFSET = { x: 80, y: 80 }`
  imported by both this module and (as a follow-up cleanup, not required for
  rulers to ship) `frameVirtualization.ts`, so the `+80` constant has exactly
  one owner. Exports `tickStep(zoom): number` (A5) and
  `visibleTickRange(originPx, lengthPx, zoom, panPx): number[]`.
- `useLiveCanvasTransform.ts` — the ONE hook change needed in `useCanvas.ts`'s
  orbit: subscribes to the SAME `useEditorStore.subscribe(selectCanvasTransformSnapshot)`
  channel `useCanvas.ts:403-421` already uses, PLUS taps `useCanvas`'s own
  rAF-batched writes. Cleanest implementation: export `transformRef` itself
  from `useCanvas()`'s return value (currently private,
  `useCanvas.ts:104`) and have `CanvasRulers` read `transformRef.current`
  inside its OWN `requestAnimationFrame` loop (mirroring
  `applyTransformToDOM`'s pattern) rather than re-deriving a second
  subscription — one ref, two consumers (`CanvasTransformLayer`'s own DOM
  write, and the ruler's canvas repaint), both driven by the same rAF tick
  `useCanvas.ts` already schedules. This avoids a SECOND independent
  rAF loop racing the first.
- `BoardGuideLine.tsx` — one draggable guide line (vertical or horizontal),
  rendered as a **sibling of `CanvasTransformLayer`** (untransformed chrome)
  but POSITIONED via the same `boardToScreen` conversion — a guide is a
  board-space concept (persisted in board units) but must render in screen
  space like the ruler ticks. Drag updates position via the same
  screen-delta/zoom pattern `BoardFrameView`'s header drag already uses
  (`BoardFramesLayer.tsx:469-485`).
- `MeasurementReadout.tsx` — the Alt-hover distance HUD (A6). Portaled into
  `document.body` like `CanvasLayerContextMenu`, positioned via
  `clientPointToEditorDoc` (already exists, `canvasDomGeometry.ts:48-65`).

### A4. Origin: board 0,0 vs selected-frame origin

Figma's ruler origin is **per-frame when a frame is selected** (0 sits at the
frame's own top-left), and falls back to the page/canvas origin otherwise.
Recommended default for Studio, matching that:

- **No frame active / nothing selected:** origin at board-space `(0, 0)` —
  i.e. wherever `BoardFrame.x/y === 0` would render, NOT the top-left of the
  first frame (frames can have negative x/y after a drag).
- **A single frame is active** (`activePageId` resolves to exactly one
  `BoardFrame`, `selectedFrameIds.length <= 1`): origin shifts to that
  frame's own `(frame.x, frame.y)` — ruler zero-marks line up with the
  frame's left/top edge, matching Figma's per-frame ruler behavior and
  matching what a user measuring padding/margins inside one screen actually
  wants.
- Toggle between the two is automatic (frame activation already exists —
  `openPageInCanvas`/`activePageId`), not a separate user setting.
- CMS / non-board mode (breakpoint frames): origin is the ACTIVE breakpoint
  frame's own left edge, same reasoning, one frame at a time by construction.

### A5. Adaptive tick density per zoom

Same "nice numbers" algorithm Figma/most drawing tools use — powers of a
1-2-5 sequence scaled by zoom, so ticks never crowd or thin unreasonably:

```ts
// rulerGeometry.ts
const NICE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000] as const
const MIN_TICK_SPACING_PX = 48 // don't draw major ticks closer than this on screen

export function tickStep(zoom: number): number {
  for (const step of NICE_STEPS) {
    if (step * zoom >= MIN_TICK_SPACING_PX) return step
  }
  return NICE_STEPS[NICE_STEPS.length - 1]
}
```

Minor ticks at `tickStep/5` or `tickStep/2` (whichever keeps minor spacing
≥ 8px on screen — compute the same way, just with a smaller `MIN_TICK_SPACING_PX`).
Labels render only at major ticks, formatted as plain board-unit integers
(`"120"`, never `"120px"` — Figma's own convention, keeps labels short).

### A6. Guides — draggable, persisted, snapping

- **Create:** drag off either ruler strip (mousedown on `RulerH`/`RulerV`,
  drag into the board) — the same interaction Figma/Sketch/XD all share.
  Alternatively (v1, cheaper): a "+" button in each ruler's context menu
  that drops a guide at the current mouse position.
- **Persisted, board-scoped** (not per-frame) — see A7 schema below.
- **Drag to move / drag off the board to delete** (dropped below/left of the
  ruler strip, mirroring the universal convention).
- **Snapping:** two SEPARATE systems already exist and must stay separate,
  not be unified into one "snap engine" — see A8:
  - `boardSnapping.ts`'s `computeSnap`/`collectPeerRects` — frame-to-frame
    and frame-to-note/doc snapping during a FRAME drag. Guides are a THIRD
    peer type this same function should learn to snap against (extend
    `collectPeerRects` to also emit one `{ axis, position }` candidate per
    guide) — reuses the existing `SNAP_THRESHOLD_BOARD_UNITS` and the
    existing `boardSnapGuides` visual (`BoardGuidesLayer`), so a frame
    dragged near a guide snaps to it and shows the same highlight line
    frame-to-frame snapping already shows. This is the ONE piece of new
    logic that touches existing snap code; everything else above is new
    modules.
  - NODE-level snapping (an element inside one frame's iframe snapping to a
    guide) is explicitly OUT OF SCOPE for v1 — nodes are real DOM elements in
    normal document flow (not freely positioned), so "snap this button to a
    guide" has no coherent meaning without first deciding what CSS property
    the snap would even write (`margin-left`? `left` only if already
    `position: absolute`?). Flag this as a real architectural difference from
    Figma's vector canvas, not an oversight — see Part B's framing note.

### A7. Guide persistence — schema addition

Confirmed home: `.studio/boards.json`, alongside frames/notes/docs — same
board-scoped, per-project persistence every other piece of board furniture
already uses (`src/core/studio-board/boardsModel.ts`, `types.ts`, `serialize.ts`;
server route `server/handlers/studio.ts:457-479`; client
`src/admin/pages/site/studio/boardsApi.ts`). NOT per-frame (`BoardFrame`) —
guides are board-global rulers, matching A4's "board origin, shifts per active
frame at RENDER time only" — the STORED guide position is always board-space,
regardless of which frame happens to be active when you look at it.

`src/core/studio-board/types.ts` — add to `Board`:

```ts
export interface BoardGuide {
  id: string
  axis: 'vertical' | 'horizontal'
  /** Board-space coordinate: x for a vertical guide, y for a horizontal one. */
  position: number
}

export interface Board {
  id: string
  name: string
  frames: BoardFrame[]
  notes: StickyNote[]
  docs: DocBlock[]
  guides: BoardGuide[]   // NEW — additive, same "missing = []" tolerance docs/serialize as `docs`
}
```

`src/core/studio-board/boardsModel.ts` — mirror the note/doc pure-transform
trio exactly (`upsertGuide`/`moveGuide`/`removeGuide`), same shape as
`upsertNote`/`moveNote`/`removeNote` (`boardsModel.ts:46-64`).

`src/core/studio-board/serialize.ts` — add `coerceGuide` mirroring
`coerceDoc` (`serialize.ts:75-85`) exactly (id/axis/position validation,
default-to-empty-array when missing, same "old boards.json files round-trip
unchanged" contract every other coercer in this file follows). Wire into
`coerceBoard`'s `guides` field the same way `docs` is wired in
(`serialize.ts:100-107`).

`src/admin/pages/site/store/slices/boardSlice.ts` — add `addGuide`/`moveGuide`/
`removeGuide` actions, same one-liner-over-a-pure-transform pattern as
`addNote`/`moveNote`/`removeNote` (`boardSlice.ts:428-463`), each setting
`boardsDirty: true` so the existing `AdminCanvasLayout` autosave effect picks
them up for free — **no new persistence plumbing needed**, this is the single
biggest reason `.studio/boards.json` is the right home over inventing a
separate guides file.

No server-side schema change needed — `boardGeometry.ts`'s
`readBoardsFileOrEmpty` and the existing GET/POST routes are already generic
over whatever `parseBoardsFile`/`serializeBoardsFile` produce.

### A8. Pixel grid at high zoom

A `<canvas>`-painted dot/line grid, same rendering vehicle as the ruler ticks
(reuse `rulerGeometry.ts`'s `tickStep`), drawn as a background layer INSIDE
`CanvasTransformLayer` (it must scale/pan WITH the content, unlike rulers) —
practically, a new sibling `<canvas>` positioned absolutely at board `(0,0)`
sized to cover the current viewport-in-board-space, redrawn on the same
rAF tick the transform updates on. Only enable above a zoom threshold (e.g.
zoom ≥ 2, where a 1px board unit is ≥ 2 screen px and a grid is legible
rather than noise) — gate behind the SAME `rulersEnabled`/`showRulers`
preference so both ship as one "precision mode" toggle, or a separate
preference if product wants them independent. Effort-wise this is the
cheapest, most optional item in this spec — ship it last if at all.

### A9. Preference + toolbar affordance

New editor preference `showRulers: boolean` (default OFF — matches "no
existing surface area regressed", and rulers add visual noise most users
don't want always-on) in the same preferences registry `dimInactiveBreakpoints`
lives in (`src/admin/pages/site/preferences/editorPreferences.ts`) — Canvas
category. Toolbar toggle: a new icon button beside `ZoomControls` (or inside
`CanvasModeToggle`'s pill, matching the "Run scripts" toggle's own placement
pattern) — `Cmd/Ctrl+Shift+R` shortcut via the keybindings registry
(`getKeybindingForCommand`, same registry every other canvas shortcut in this
file already goes through — do not hand-roll a new listener).

### A10. What already overlaps (do not duplicate)

| Existing | File | Relationship to rulers |
|---|---|---|
| Snap guides (transient) | `BoardGuidesLayer.tsx`, `boardSnapping.ts` | Name COLLIDES with "guides" in the Figma sense — these are drag-time alignment lines (frame-to-frame/note/doc), never persisted, cleared on pointerup (`boardSlice.ts:59-65`'s own doc). Reuse the SAME visual/computation for guide-to-guide snapping (A6) but do NOT rename or repurpose this layer — name the new persisted feature `BoardGuideLine`/`board.guides`, distinct from `boardSnapGuides`. |
| Zoom/pan pure math | `math.ts` | Reuse directly — `tickStep`/`visibleTickRange` are the only new math. |
| Board↔screen formula | `frameVirtualization.ts:8-13` | Extract to `rulerGeometry.ts` (A3), fold `frameVirtualization.ts` onto it as a follow-up so the `+80` offset has one owner (A1). |
| Align/distribute | `frameAlign.ts`, `boardBulkFrameActions.ts` | Frame-to-frame alignment (WS-7.2 "Align selected frames to a shared edge") — complementary to guides, not overlapping; a future "snap to guide" could reuse `FrameAlignEdge`'s edge vocabulary but this is not required for v1. |
| Pixel/dot grid | none found | Confirmed absent — `grep` for `background-image`/`radial-gradient`/`dot-grid` across every canvas `.module.css` returns nothing related to a board grid (only unrelated radial-gradient decorations in `CanvasContextSelector.module.css`/`CanvasNotch.module.css`). A8 is greenfield. |
| Measurement/distance HUD | none found | Confirmed absent — no `altKey` handling anywhere in `src/admin/pages/site/canvas/*.tsx` besides `CanvasTreeLadderOverlay.tsx:117` (unrelated: Alt+arrow reorders the tree-ladder menu, not a canvas measurement gesture) and `IframeFrameSurface.tsx`'s event-forwarding (which merely relays `altKey` on cloned events, doesn't act on it). A6/`MeasurementReadout.tsx` is greenfield. |

### Rulers effort summary

| Piece | Effort | Depends on |
|---|---|---|
| `rulerGeometry.ts` (pure math) | S | — |
| `useCanvas.ts` exposing `transformRef` | S | — |
| `RulerH`/`RulerV` canvas-painted strips + preference/toggle | M | `rulerGeometry.ts`, `transformRef` |
| Guide schema + boardSlice actions + serialize coercion | S | — (independent, can ship before the visual ruler) |
| `BoardGuideLine` drag/create/delete UI | M | guide schema, `rulerGeometry.ts` |
| Guide snapping in `computeSnap`/`collectPeerRects` | S | guide schema |
| `MeasurementReadout` (Alt-hover distance) | M | `nodeVisualRect`/`canvasOverlayGeometry.ts` (existing) |
| Pixel grid at high zoom (A8) | S | `rulerGeometry.ts` |

Total: **M** as a coherent feature (rulers + guides + snapping), ship the HUD
and pixel grid as follow-ups — they're independently useful but not required
for "rulers exist and guides persist," which is the actual feature-gap this
audit was asked to close.

---

## PART B — De-Studio-ify / Figma-ify

Findings below are numbered V1..Vn with Severity, Evidence, Root cause,
Proposed fix, Effort.

### V1 — `frameVirtualization.ts`'s screen-space formula omits the transform layer's static `+80,+80` offset

- **Severity:** Low (currently harmless — a 600px culling margin absorbs an
  80px error) but a real correctness trap for anything built against this
  file's documented formula, including the ruler spec above.
- **Evidence:** `frameVirtualization.ts:8-13` (doc comment) vs.
  `CanvasTransformLayer.module.css:17-30` (`position: absolute; top: 80px;
  left: 80px;`).
- **Root cause:** The formula was written to describe the TRANSFORM only,
  correctly, but never accounted for the transform layer's own static layout
  position — fine for the 600px-margin culling test it's used for, silently
  wrong for anything needing exact pixels.
- **Proposed fix:** Extract `rulerGeometry.ts`'s `boardToScreen` (A3/A10) as
  the one true implementation; have `isFrameOnScreen` call it instead of
  re-deriving the formula inline. Update the module doc comment.
- **Effort:** S. Depends on rulers work (or can be done standalone first).

### V2 — `CanvasContextSelector` (breakpoint/condition switcher) renders — and functions as a live control — inside Studio board mode, where it is a no-op

- **Severity:** Medium — actively misleading, not just unused chrome. A user
  can open the switcher, pick "Tablet," and nothing happens.
- **Evidence:** `CanvasRoot.tsx:590-592` renders `<CanvasContextSelector/>`
  unconditionally whenever `!isLive && rightSidebarExpanded && (canEditStyle
  || canEditStructure)` — no `activeBoard`/board-mode gate. Meanwhile every
  studio board frame is built with one hardcoded synthetic breakpoint
  (`STUDIO_BREAKPOINT_BASE`, `BoardFramesLayer.tsx:146-156`, `id: 'studio'`)
  that ignores `activeBreakpointId`/`site.breakpoints` entirely —
  `buildStudioBreakpoint(width)` only varies by the frame's OWN
  width/height (Phase 6E), never by which "context" is selected in this
  dropdown. `setActiveBreakpoint(id)` (what clicking a row calls,
  `canvasSlice.ts:166`) has no rendering effect on any board frame.
- **Root cause:** `CanvasContextSelector` is CMS-era chrome (per-viewport
  style-override editing, `setBreakpointOverride`/`activeConditionId` —
  a real, still-used mechanism in CMS mode, where breakpoints ARE the canvas
  frames) that was never taught to self-gate off in Studio board mode, where
  breakpoints and board frames are unrelated concepts.
- **Proposed fix:** Add `const activeBoard = useEditorStore(selectActiveBoard)`
  gate in `CanvasRoot.tsx` alongside the existing render condition — hide
  entirely when `activeBoard` is truthy (mirrors how `StudioBoardLayers`
  itself self-gates, and how `CanvasTransformLayer.tsx:78` already branches
  `activeBoard ? <StudioBoardLayers/> : ...`). If per-context STYLE editing
  is later wanted inside Studio (editing a real `@media` query in the user's
  actual CSS, not a CMS breakpoint override), that is a different, new
  feature — not a reason to keep this control visibly live today.
- **Effort:** S.

### V3 — `BreakpointFrame.tsx` is NOT dead weight in Studio mode (verify, don't assume)

- **Finding, not a defect:** Confirmed by reading `BoardFramesLayer.tsx:658-667` —
  every board frame's BODY is literally one `<BreakpointFrame>`, given a
  synthetic per-frame breakpoint (`buildStudioBreakpoint(width)`). It is
  fully shared infrastructure (iframe boot, injectors, selection overlay,
  inline-edit, activation hints all live here) between CMS breakpoint-frame
  mode and Studio board-frame mode. **Keep as-is** — this is the opposite of
  the audit brief's suspicion; flagging explicitly so no future agent
  "cleans up" what looks like CMS-only naming but is a dual-purpose primitive.
  The ONLY genuine CMS-flavored leftover riding along inside it is the
  activation-hint / dim-inactive-breakpoints machinery (`isDimmed`,
  `activationHintEnabled`) — these ARE exercised in board mode too (dimming
  non-active viewport contexts), so even that is not dead.

### V4 — Dead `workspace?: 'site' | 'content' | 'media'` prop threading in `LeftSidebar`/`PanelRail`

- **Severity:** Low (cosmetic/dead-code, not a UX defect).
- **Evidence:** `LeftSidebar.tsx:50`, `PanelRail.tsx:74` — both type
  `workspace?: 'site' | 'content' | 'media'`, used only to build a rail-item
  color-identity hash (`railIdentity`, `PanelRail.tsx:134-136`). Per
  `PROJECT-BRIEF.md` §1 and `docs/agent-refs/path-index.md`'s "Not ours"
  section: `src/admin/pages/{content,data,media}/` **do not exist on disk**.
  Studio never built separate Content/Media workspaces.
- **Root cause:** Leftover typing from the CMS-fork era where these
  sidebars really were shared across Content/Data/Media workspace routes.
- **Proposed fix:** Confirm no live caller ever passes `'content'`/`'media'`
  (`grep -rn "workspace=\"content\"\|workspace=\"media\"" src/admin` — not
  run in this audit, quick to verify), then collapse the type to a single
  implicit `'site'` and delete the prop + its threading, or leave the prop
  but narrow the type to `'site'` only if some CMS-half caller still needs
  the parameter shape. Not urgent; bundle with any future pass through these
  two files.
- **Effort:** S.

### V5 — `ZoomControls`' Shift+1 binding is a Figma false-friend

- **Severity:** Low — works, but sets the wrong expectation for anyone who
  knows Figma.
- **Evidence:** `ZoomControls.tsx:17-21`'s own doc comment: `Shift+1 → reset
  to 100% (legacy muscle-memory)`; `useCanvas.ts:377-380` implements it as a
  literal alias for `resetCanvasView()`. In Figma, Shift+1 is
  "zoom to fit," Shift+2 is "zoom to selection" — neither exists here at all
  (confirmed: no `zoomToFit`/`zoomToSelection`/fit-to-content-canvas action
  in `canvasSlice.ts`, `useCanvas.ts`, or any keybinding definition found by
  grep for `fit` across `src/admin/pages/site/canvas`).
- **Root cause:** An intentional legacy-shortcut alias from a pre-Figma-
  parity era of this product, never revisited once "Figma-grade" became the
  explicit target.
- **Proposed fix:** Implement real zoom-to-fit (frame the whole board's
  frame bounding box) and zoom-to-selection (frame `selectedFrameIds`'/
  `selectedNodeId`'s bounding box) as NEW actions in `canvasSlice.ts`
  (`zoomToFit`, `zoomToSelection`), rebind Shift+1/Shift+2 to them via the
  keybindings registry, and either drop the "reset to 100%" muscle-memory
  alias or move it to a different, non-Figma-colliding binding. Reuse
  `panToCenterBreakpointFrame`'s pattern (`canvasDomGeometry.ts:80-98`) —
  extend it to fit-to-bounds (compute zoom from the ratio of viewport size to
  content bounding box, not just center at current zoom).
- **Effort:** M (new store actions + geometry + keybinding rewire).

### V6 — Publish / Save-draft chrome is ALREADY correctly hidden in Studio mode

- **Finding, not a defect:** `AdminCanvasLayout.tsx:249-272` — the toolbar's
  right slot explicitly branches `studioMode ? <StudioToolbarActions/> :
  <PublishButton .../>`, with an inline comment explaining exactly why
  (`Publish targets the CMS publish pipeline … meaningless in Studio`).
  **No action needed** — flagging so this audit doesn't recommend "fixing"
  something already fixed. `StudioToolbarActions` (Import / Preview-axes /
  Download-code) is the correct, already-Figma-appropriate replacement set.

### V7 — `runScripts` / "Run scripts" toggle is a legitimate Studio feature, not CMS residue

- **Finding, not a defect:** `CanvasModeToggle.tsx:107-136`,
  `canvasSlice.ts:65-71`. Genuinely required by Studio's "parse real code"
  model (opt-in execution of the actual project's runtime scripts inside the
  editable iframe) — has no CMS equivalent and no Figma equivalent either
  (Figma has no user JS). Keep as-is; it belongs to the "canvas is the real
  app" thesis, not the CMS-feel category this audit is hunting for.

### V8 — Selection overlay: no alt-hover measurement, no padding/margin visualization, no distance-to-siblings

- **Severity:** Medium — named explicitly in the audit brief as a Figma
  table-stakes affordance; genuinely absent.
- **Evidence:** `grep -n "distance\|padding\|margin"` across
  `BreakpointSelectionOverlay.tsx` and `canvasSelectionOverlayPositioning.ts`
  returns zero matches. The overlay (post `canvas-05`/`canvas-06` fixes,
  `STATE.md`) already does rings, the node-name+dimension badge, and
  positions correctly at any zoom (`standing-03` item 1 is FIXED — verify
  this before reporting it as an open defect; it is closed per
  `BreakpointSelectionOverlay.tsx:14-33`'s own doc comment and the `canvas-05`
  handoff). What is missing is Figma's Alt-hover mode: hovering a sibling
  while Alt is held shows the pixel distance between the selected node and
  the hovered one, and hovering a PARENT while Alt is held shows padding
  values as filled bands.
- **Root cause:** Never built — this is a feature gap, not a regression.
- **Proposed fix:** New `MeasurementReadout.tsx` (already scoped in the
  rulers spec, A3, since it shares `nodeVisualRect`/`canvasOverlayGeometry.ts`
  machinery) — listen for `Alt` held + hover inside `BreakpointSelectionOverlay`'s
  existing hover-tracking effect, compute the gap between the selected node's
  `nodeVisualRect` and the hovered node's, render a portal-based readout with
  the pixel distance, styled via `EditorChromeInjector`'s stable `data-*`
  convention if drawn inside the iframe, or the parent-doc portal pattern
  (`SelectionToolbar`'s precedent) if not.
- **Effort:** M. Depends on nothing new (existing geometry primitives are
  sufficient) — independent of the rulers feature, can ship separately.

### V9 — Node-level interactions that do NOT map to Figma 1:1 — architectural note, not a bug list

The audit brief asks for resize handles, rotation, alt-drag duplicate, and
arrow-key nudge at the NODE level (inside one frame). These are Figma
affordances for a **vector canvas of freely-positioned objects**. Studio's
canvas renders **real DOM elements in normal document flow** (the whole
point — "the canvas DOM must be the DOM React renders," `CLAUDE.md`). Most of
these gestures have no coherent 1:1 mapping without first answering "what CSS
property does this write":

- **Resize handles on a node:** would need to decide whether to write
  `width`/`height`, `flex-basis`, or nothing (a flex child with no explicit
  size can't be "resized" by dragging without first opinion-ing a layout
  model). Today this is correctly the Properties panel's job
  (`SizeSection.tsx`), not a canvas drag handle. **Not a gap — a deliberate
  difference**, but worth a product decision either way rather than silent
  non-parity.
- **Rotation:** CSS `transform: rotate()` on an arbitrary DOM element is
  legitimate and could genuinely get a rotate handle without any of the
  above ambiguity. This IS a clean, low-risk Figma-parity gap — confirmed
  absent (`grep -rn "rotate" src/admin/pages/site/canvas` finds nothing
  interaction-related). **Real gap**, Effort M (new drag handle +
  `transform: rotate()` write path via the existing style-write plumbing).
- **Alt-drag duplicate / arrow-key nudge (position):** meaningful for FRAMES
  (already free-form-positioned, `x`/`y` in `boards.json`) and NOT
  meaningful for a normal-flow node without first adding `position:
  absolute`/margin math. Frame-level: **confirmed genuinely absent** — no
  `altKey` handling in `BoardFrameView`'s drag handler
  (`BoardFramesLayer.tsx:443-461`, `handleHeaderPointerDown`) and no arrow-key
  frame-nudge listener anywhere in `BoardFramesLayer.tsx`/`useCanvasSelectionKeyboard.ts`.
  **Real, scoped gap at the FRAME level**: add Alt-drag-to-duplicate (clone
  via `duplicateFrameAsVariant`'s sibling-positioning pattern, but a plain
  page-identical duplicate, not an axis-variant one — needs a new
  `duplicateFrameAtPosition` action) and arrow-key frame nudge (1px / 8px
  Shift, mirroring `numericNudge.ts`'s existing step constants) to
  `BoardFramesLayer.tsx`. Effort S–M each.

### V10 — Marquee selection, frame multi-select, and Escape-to-deselect ARE already implemented — do not re-report as gaps

- **Verification, not a finding:** `STATE.md`'s `board-02`/`board-03` entries
  and this audit's own read of the source confirm all three genuinely ship
  today:
  - Marquee: `useMarqueeSelection.ts` (full file read above), wired from
    `BoardFramesLayer.tsx:216`.
  - Frame multi-select: `selectedFrameIds` (`boardSlice.ts:271-285`),
    Shift-click toggle (`BoardFramesLayer.tsx:452`), ⌘/Ctrl+A
    (`CanvasRoot.tsx:434-452`), bulk actions (`boardBulkFrameActions.ts`:
    align/distribute/tidy/apply-size-to-all).
  - Escape ladder (deselect, step out of instance, leave VC mode):
    `useCanvasSelectionKeyboard.ts`, document-level, intent-scoped (not
    focus-scoped) — explicitly engineered to survive focus leaving the
    canvas for a panel, which is exactly the failure mode a naive
    `onKeyDown` implementation would have.
  - Cmd-click / Ctrl-click toggle and Shift-click range select at the NODE
    level: `CanvasRoot.tsx:280-291`'s `onNodeClick` mode resolution
    (`shiftKey → 'range'`, `metaKey||ctrlKey → 'toggle'`).
  - Right-click context menu: `CanvasLayerContextMenu.tsx` +
    `LayerNodeContextMenu` (delete/duplicate/rename/wrap/copy/cut/paste/
    paste-HTML) — present and reasonably complete.
  - Space+drag pan, wheel pan/zoom, pinch: all in `useCanvas.ts`, confirmed
    working as designed (A1's live-transform-ref caveat is about ruler
    consumption of this state, not a defect in the pan/zoom itself).

  **What's genuinely still missing**, confirmed by grep and by absence in
  the files read above:
  - Cmd-click "deep select" (Figma: click always selects the outermost
    group first; Cmd-click drills to the exact leaf under the cursor
    regardless of grouping). Studio's click model already selects the exact
    DOM element under the cursor on a plain click (real elements, no
    artificial grouping to drill through) — so this Figma affordance may be
    **N/A by construction** rather than missing; worth a product call, not
    engineering work, unless Visual Component instances want "click selects
    the instance, Cmd-click drills into its slot content" — that already
    exists via the separate Enter/Escape instance ladder
    (`useCanvasSelectionKeyboard.ts`), just on a different gesture (Enter,
    not Cmd-click).
  - Zoom-to-fit / zoom-to-selection: confirmed absent, see V5.
  - Node-level rotation: confirmed absent, see V9.
  - Node-level resize handles / alt-drag duplicate / arrow nudge: confirmed
    absent, architecturally ambiguous, see V9 (frame-level versions of the
    last two ARE clean, scoped gaps).

### V11 — Frame chrome for a 30-frame board: names/hover/ordering exist; no collapse, no outline/list view

- **What exists:** per-frame title (rename via double-click or context menu,
  `BoardFramesLayer.tsx:548,580`), activation ring (`data-active`), selection
  ring (`data-selected`), virtualization so 30 offscreen frames don't cost an
  iframe each (`frameVirtualization.ts`, poster placeholders,
  `FramePosterPlaceholder.tsx`), drag-to-reposition, resize handles,
  right-click "Remove from board," "Duplicate as variant."
- **What's missing for a 30-frame board specifically:** no way to COLLAPSE a
  frame to a title-only chip (CMS breakpoint frames have
  `collapsedBreakpointIds`/`toggleBreakpointCollapsed` in `canvasSlice.ts:79,178-182`
  — board frames have no equivalent), no board-wide outline/list view (a
  DomPanel-style flat list of every frame on the board, for jumping around
  without hunting visually), no frame ordering/z-index control beyond
  creation order. These are real, scoped gaps but were not central to this
  audit's Part A/B split — flagging for a future frame-chrome-specific pass
  rather than designing them here (out of the requested scope: rulers +
  de-Studio-ify inventory).
- **Effort:** Frame collapse M (mirrors existing breakpoint-collapse
  mechanism almost exactly — `canvasSlice.ts` → `boardSlice.ts`). Outline/
  list view L (new panel).

---

## Summary table

| ID | Area | Severity | Effort |
|---|---|---|---|
| V1 | `frameVirtualization.ts` missing `+80` offset | Low | S |
| V2 | `CanvasContextSelector` live-but-no-op in board mode | Medium | S |
| V3 | `BreakpointFrame.tsx` — confirmed NOT dead weight | — (verification) | — |
| V4 | Dead `workspace` prop in sidebars | Low | S |
| V5 | Shift+1 ≠ Figma zoom-to-fit | Low | M |
| V6 | Publish chrome — confirmed already hidden in Studio | — (verification) | — |
| V7 | `runScripts` — confirmed legitimate, not CMS residue | — (verification) | — |
| V8 | No alt-hover measurement / padding viz | Medium | M |
| V9 | Node-level resize/rotate/nudge — architectural note + real rotation gap | Medium | M (rotation), S–M (frame nudge/alt-drag) |
| V10 | Marquee/multi-select/Escape — confirmed shipped; real remaining gaps enumerated | — (verification) + Medium (fit/selection zoom) | see V5 |
| V11 | Frame chrome at 30-frame scale — collapse + outline view missing | Low–Medium | M (collapse), L (outline view) |


