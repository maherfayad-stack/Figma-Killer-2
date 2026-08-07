# Canvas rulers and guides (D1)

Top/left rulers and persisted, draggable ruler guides for the design canvas —
Figma-parity tracking item D1. Two independent halves: rulers (chrome, never
persisted) and guides (`board.guides`, persisted to `boards.json`).

---

## The `useCanvas()` `transformRef` API

`useCanvas()` returns `transformRef: RefObject<CanvasTransform>` — the LIVE
canvas transform (`{ zoom, panX, panY }`), mutated in place on every rAF tick
during an active gesture. This is a **published, shared contract**, not a
rulers-only concern: the store's `zoom`/`panX`/`panY` are intentionally
debounced 100ms behind the real DOM transform (`useCanvas.ts`'s own module
doc explains why — avoiding a React re-render on every pan/zoom frame), so
**anything that needs to track pan/zoom live** — mid-gesture, not 100ms
later — must read this ref instead of subscribing to the store. `CanvasRulers`
is the first consumer; D2 (unified drag/drop) and a future Alt-hover
measurement HUD are expected to be the next two.

`CanvasViewportActionsContext` (`canvas/CanvasContexts.ts`) carries
`transformRef` alongside its existing `canvasRootRef`/`panBy`, so a component
that isn't a direct child of `CanvasRoot`'s own JSX (e.g. `RulerGuidesLayer`,
several levels down through `CanvasTransformLayer` → `StudioBoardLayers`) can
read it via `useContext` instead of a prop-drilled chain.

**Never write to `transformRef.current` from outside `useCanvas`.** It is
read-only everywhere else.

---

## Rulers (`canvas/CanvasRulers/`)

```
CanvasRulers.tsx              composition: corner square + RulerH + RulerV + guide-creation preview
RulerH.tsx / RulerV.tsx       <canvas>-painted tick rulers (NOT per-tick DOM)
rulerGeometry.ts              PURE: niceTickStep, boardToScreen/screenToBoard, computeRulerTicks, resolveRulerOriginBoard
rulerPaint.ts                 2D canvas paint step (not pure, not unit-tested — see its own doc)
useRulerCanvasPaint.ts        persistent rAF repaint loop, polls transformRef
useRulerGuideCreation.ts      drag-from-ruler → new persisted guide
```

**Mount point.** `CanvasRulers` mounts as a **sibling of `CanvasTransformLayer`,
inside `.canvas`** (`CanvasRoot.tsx`) — the same untransformed-chrome tier as
`CanvasNotch`/`CanvasModeToggle`. It must never sit inside the transformed
subtree, or the ruler ticks would scale/pan with the board instead of staying
fixed screen-space chrome. Design mode only — live mode has no pan/zoom to
rule against.

**The 80px offset.** `.transformLayer` (`CanvasTransformLayer.module.css`) sits
at a static `top: 80px; left: 80px` relative to `.canvas`. A ruler measuring
board→screen therefore needs `screen = board * zoom + pan + 80`, NOT the
`frameVirtualization.ts`-style `board * zoom + pan` (that formula deliberately
omits the offset — harmless there, a 600px viewport-culling margin absorbs
it; fatal for a pixel-exact ruler tick). `rulerGeometry.ts` exports
`CANVAS_TRANSFORM_LAYER_OFFSET_PX = 80` and pins it with a dedicated
regression test (`__tests__/rulerGeometry.test.ts`).

**Tick density.** A nice-number ladder (1/2/5/10/25/50/100/250/500/1000);
`niceTickStep(zoom)` picks the smallest step whose on-screen spacing is at
least ~60px, falling back to the ladder's max at extreme zoom-out (ticks
render closer together than ideal rather than not at all).

**Origin.** Board `(0, 0)` normally. When the active Studio board has
**exactly one** frame, the origin shifts to that frame's own `(x, y)` —
`resolveRulerOriginBoard`, matching Figma's single-frame-in-view convention.
Outside board mode (CMS/breakpoint editing, no `BoardFrame.x/y` concept) the
origin is always `(0, 0)`.

**Paint, don't mount DOM nodes.** `rulerPaint.ts` draws directly to a
`CanvasRenderingContext2D` — a 4000px ruler at fine tick spacing would be
thousands of DOM nodes otherwise. `useRulerCanvasPaint` runs a persistent
`requestAnimationFrame` loop (required, not optional — `transformRef` mutates
with no change event) but only actually repaints when zoom/pan/length/origin
changed since the last tick.

**Landmine: canvas `font` can't read CSS custom properties.** `ctx.font =
'10px var(--font-mono)'` is invalid canvas font syntax and silently falls
back to the browser default — `rulerPaint.ts` uses a literal font stack
instead. Colors (`--bg-surface-2`, `--text-subtle`, `--text-muted`,
`--canvas-ruler-guide-color`) ARE resolved correctly, but only because
`useRulerCanvasPaint` reads them via `getComputedStyle(canvasEl)` in JS
first and hands `paintRuler` literal resolved strings — canvas 2D never sees
a `var(...)` token itself.

**Scoped out of this M** (deliberately, not an oversight): the pixel grid at
high zoom, and the Alt-hover measurement HUD.

---

## Guides — `BoardGuide` (D1)

⚠️ **Name collision.** `BoardGuidesLayer`/`boardSnapGuides`
(`canvas/BoardGuidesLayer/`, `store/slices/boardSlice.ts`) are a **different,
pre-existing concept**: transient, computed-on-every-drag alignment lines
that never persist. `RulerGuidesLayer`/`BoardGuide` are the **persisted**
ruler guides this feature adds. Do not conflate them, and do not extend the
transient ones to add persistence — they're named and shaped for a
fundamentally different lifecycle.

**Shape.** `BoardGuide` (`@core/studio-board`, TypeBox-schema-first —
`BoardGuideSchema` / `type BoardGuide = Static<typeof BoardGuideSchema>`):
`{ id: string; axis: 'x' | 'y'; position: number }`. Lives on `Board.guides?:
BoardGuide[]` (**optional**, unlike its `notes`/`docs` siblings — see the
field's own doc in `types.ts` for why: every OTHER place in the codebase that
constructs a `Board` object literal predates this field). Rides
`.studio/boards.json` autosave for free — no new server route.
`serialize.ts`'s `coerceGuide` mirrors `coerceNote`/`coerceDoc`'s tolerant
shape (missing/malformed → `[]`, never a parse failure).

**Pure transforms.** `@core/studio-board/boardsModel.ts`: `upsertGuide` /
`moveGuide` / `removeGuide` — same `Board -> Board` shape as the sibling
note/doc transforms.

**Store wiring.** `store/slices/boardGuideActions.ts` (pure `Board -> Board`
wrapper, mints the id) + three thin `boardSlice.ts` actions (`addGuide`,
`moveGuide`, `removeGuide`) — one-lined to stay under the
module-size-budget ceiling (see that file's inline comment).

**Rendering + interaction.** `canvas/RulerGuidesLayer/RulerGuidesLayer.tsx`
mounts inside `CanvasTransformLayer` (via `StudioBoardLayers`, last — paints
above frames/notes/docs/snap-guides), so it inherits the pan/zoom transform
the same way `BoardGuidesLayer` does. Each guide line drags to reposition
(commits via `moveGuide` on pointerup; live feedback is a direct
`--guide-position` custom-property write during the drag, never `setState`
per pointermove) and double-click deletes it (`removeGuide`).

**Creation.** Drag out from a ruler (`useRulerGuideCreation.ts`, in
`CanvasRulers/`) — gated on an active Studio board (`BoardGuide` only exists
on `Board`, so there's nowhere to persist a guide outside board mode; the
rulers themselves still render everywhere design mode does).

**Known rough edge:** a persisted guide's clickable hit-target is exactly its
1px visual width — no invisible wider hit-padding yet. Worth widening in a
follow-up if dogfooding finds it fiddly.

**Scoped out, deliberately:** node-level (inside-a-frame) snap-to-guide.
Canvas nodes are real DOM elements in flow, not freely-positioned vector
objects — an architectural mismatch, not an oversight.

**Guide↔frame snapping — pure primitive only, NOT wired up.**
`canvas/boardSnapping.ts`'s `guideSnapRects(guides)` turns a guide list into
`computeSnap`-compatible peer rects (a guide is a single-coordinate infinite
line on one axis — represented as a zero-size point placed far off-screen on
the OTHER axis, so it can never spuriously match there). Unit-tested
(`boardSnapping.test.ts`), but **no live drag handler** (`BoardFrameView.tsx`
etc.) calls it yet — `collectPeerRects`'s own result and `guideSnapRects`'s
result are meant to be concatenated by whichever future change wires this
in. See `STATE.md`'s D1 handoff for why this stopped at the pure-function
level.

---

## Related

- `docs/agent-refs/canvas-internals.md` — the broader canvas architecture this feature sits inside.
- `docs/features/canvas-iframe-per-frame.md` — why the canvas DOM is real iframes (the invariant rulers respect by staying untransformed chrome).
- Source: `src/admin/pages/site/canvas/CanvasRulers/`, `src/admin/pages/site/canvas/RulerGuidesLayer/`, `src/admin/pages/site/hooks/useCanvas.ts`, `src/core/studio-board/`.
- Tests: `CanvasRulers/__tests__/rulerGeometry.test.ts`, `src/core/studio-board/__tests__/boardsModel.test.ts`, `src/__tests__/canvas/boardSnapping.test.ts`, `src/__tests__/canvas/canvasRulersMounted.test.tsx`.
