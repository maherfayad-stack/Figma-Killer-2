# Positioning model: Figma auto-layout / constraints <-> real CSS
> **Purpose:** the design for Figma auto-layout and constraints mapped onto real CSS (bundles PA-1..PA-8, decisions OD-P1..OD-P7) · **Read when:** before starting or reviewing a bundle of this plan · **Trust:** live design, not built (2026-10-10; STATE.md says which bundles are in flight) · **Owner:** studio-architect; studio-scribe folds shipped bundles out · **Verified:** 2026-10-10 (design read against the code, nothing run)

Status: design only. No repo file edited, no STATE.md entry written (the task said do not edit repo files; the first implementer must write the Stage: design entry from this).
ROADMAP: not a bundle. Extends P2-C (arrow keys), P5-E (IX-21 authored offsets), P5-F (IX-22 multi-select free move), P5-G (draw on board), W8-4 (Hug/Fill, constraints). Settled and not re-opened: OD-7 (this-instance-only), OD-14 (loose layers), OD-15/16 (arrows, bulk).

## 0. What already exists (do not rebuild)

| Figma concept | Already in the tree |
|---|---|
| Hug / Fill / Fixed | `core/studio-runtime/elementSizingRules.ts` (`sizingAxisRole`: flex-main / flex-cross / grid / block; `sizingPatch`, `currentSizingMode`), `SizeSection.tsx`, `useSizingParentLayout.ts` |
| Layout mode row (none / V / H / grid), padding, gap, wrap, clip | `inspector/sections/LayoutSection*`, `layoutMode.ts` |
| Constraints (5 modes, crosshair, refusals) | `panels/PropertiesPanel/constraintMapping.ts`, `useConstraintAxes.ts`, `PositionConstraints.tsx`, `ConstraintsDiagram.tsx` |
| Absolute move, authored-offset aware, snap, RTL, multi-select | `canvas/canvasFreeMove.ts` (only with the cmd modifier, or if already absolute) |
| Nudge: flow in auto-layout reorders, abs nudges, flow in non-AL promotes to `relative` | `canvasNodeArrowMove.ts` (`isAutoLayout`, `planFlowNudge`, `resolveArrowSelectionMove`) |
| Resize keeps the authored anchor (right/bottom) | `elementResizeAnchoring.ts` (portal frames only; live frames still write `left`) |
| Group / ungroup (cmd G) | `ast-codemods/wrapJsxElements.ts`, `groupActions.ts` |
| "Add auto layout" (shift A) | `layers.toggleFlexLayout` in `keybindingLayerCommands.ts` / `layerCommands.ts`: sets display:flex in the direction children already run, groups several first |
| Draw R/O/T | `canvasDrawTool.ts` (`drawInsertStyles` = width/height only, flow insert); `placeDrawOnBoard.ts` for the empty board |

Gaps this design closes: (a) no single definition of "which kind of parent is this", so five files each re-derive it; (b) a drawn/dropped/dragged layer into a frame loses its position unless cmd is held; (c) there is no "Ignore auto layout" control, only the cmd-drag and a refusal when the parent is static; (d) no Frame selection (opt cmd G); (e) shift A infers direction only (no gap, padding, alignment, and does not convert absolute children); (f) Fill/Hug on an absolute child writes the in-flow answer, which fights the Left-and-right constraint; (g) absolute offsets are computed from `offsetLeft` against `offsetParent`, which is the likely seat of the `left:-421px` bug (to confirm: scout must reproduce before PA-1 is cut).

## 1. The one idea: three parent kinds, derived from computed style, never marked in source

`parentPlacementKind(parentComputed, childrenComputed)` in `@core/studio-runtime` (pure, structural input, unit-testable like `FreeMoveStyleInput`):

| Kind | Computed-style test | Figma analogue | Child placement |
|---|---|---|---|
| `auto-layout` | parent display is flex / inline-flex / grid / inline-grid | Auto-layout frame | parent places in-flow children; abs children are "ignore auto layout" |
| `free-frame` | parent position != static, display not flex/grid, and NO in-flow element child (all element children are absolute/fixed, or it is empty) | Frame without auto layout | every child positioned by its own insets (constraints) |
| `flow` | everything else (block flow with in-flow children) | closest Figma analogue is a vertical auto-layout with no gap | in-flow; reorder |

Why derived: the user's JSX stays free of Studio markers (invariant 2: one honest target), and a hand-written `position: relative` hero with absolute badges is correctly seen as a free frame. A free frame is also what the Frame tool (F) / R-O-T draw into an empty frame produce, so Figma's "empty frame = canvas" works naturally. `isAutoLayout` in `canvasNodeArrowMove.ts` is deleted; it becomes `kind === 'auto-layout'`.

## 2. Mapping table (Figma property <-> CSS)

Auto layout container (write target: the container's own style/class, existing property writers):
| Figma | CSS | Notes |
|---|---|---|
| Horizontal / Vertical | `display:flex; flex-direction:row|column` | reverse stays in the gear |
| Wrap | `flex-wrap:wrap` | counter-axis spacing -> `row-gap` (gap becomes two values) |
| Grid auto layout | `display:grid` + tracks | existing GridTrackControl |
| Gap (fixed) | `gap` | |
| Gap "Auto" | `justify-content:space-between`, gap kept as min | |
| Padding | `padding` | exists |
| 3x3 alignment | `justify-content` (main), `align-items` (cross); baseline -> `align-items:baseline` | |
| Clip content | `overflow:hidden` | exists |
| Hug | in block: `width:fit-content`; in flex main: `flex:none` + width auto; cross: `align-self:flex-start` + width auto | existing `sizingPatch` |
| Fill | block: `width:100%`; flex main: `flex:1 1 0`; flex cross: `align-self:stretch` + clear size; grid: `justify-self/align-self:stretch` | existing; new role below |
| Fixed | literal length | |
| Min/Max W/H | `min-*` / `max-*` | exists |

Absolute child:
| Figma | CSS |
|---|---|
| Ignore auto layout (inside AL) | `position:absolute` on the child + `position:relative` on the AL parent (else the box silently reparents to a distant ancestor, the existing static-parent refusal) |
| Reinstate | clear `position`, `left/right/top/bottom/inset`, `translate` written by centre; DOM order already is layer order, so nothing else moves |
| Left / Top | `left:Npx` / `top:Npx` |
| Right / Bottom | `right:Npx` / `bottom:Npx` |
| Left and right (stretch) | `left` + `right`, width cleared. Equals "Fill" on an absolute axis |
| Centre | `left:50%` + standalone `translate:-50%` (existing); offset from centre -> `left:calc(50% + Npx)` |
| Scale | insets as percentages of the containing block, size cleared (needs a measurement; refuses without one, existing) |
| Frame (no AL) | `position:relative` (+ size). Padding is irrelevant: offsets measure from the padding box, so border width must be subtracted when converting from a measured rect |
| z-order | source order (cmd [ and ]); never write `z-index` unless one already exists |

Constraints are honest because the browser implements them: resizing the parent in the canvas re-lays children with no simulation code.

## 3. Gesture rules (one table, one resolver)

| Gesture | auto-layout parent | flow parent | free-frame parent | modifier (cmd/ctrl) |
|---|---|---|---|---|
| Drag existing layer | reorder (insert indicator) | reorder | absolute move (writes authored offsets, existing `planFreeMoveOffsets`) | in auto-layout/flow: ignore the reorder and move freely (writes `position:absolute`; auto-positions the parent per OD-P2); in free-frame: no inverse (z-order is cmd [ ]) |
| Drag a layer INTO a frame (from elsewhere, library, other frame) | reorder-insert at pointer | reorder-insert | absolute at the pointer position (offsets relative to the containing block) | as above |
| Draw R/O/T/text in a frame | flow insert with drawn size (today) | flow insert with drawn size (today) | absolute at the drawn rect | cmd: absolute at the drawn rect (parent made positioned if static) |
| Draw on the empty board | loose layer at the rect (P5-G, unchanged) | | | |
| Nudge (arrows) | reorder | flow nudge via `relative` (canvas-48, unchanged) | nudge offsets | none |
| Resize | Fixed/Hug/Fill switch per axis | same | anchored resize (`anchorResizePatch`); extend to live frames | |
| Frame selection (opt cmd G) | wrapper replaces members in place (stays an in-flow child of the auto-layout parent) | same | wrapper absolute at the union rect; members rebased | |
| Add auto layout (shift A) | inner layout inferred | same | free-frame becomes AL; absolute children converted to flow | |

Property: `placement = f(parentKind, childPositionIsFree, modifier)` lives in one function `resolvePlacement` next to the classifier; `resolveFreeMove`, `resolveArrowSelectionMove`, the insert/drop/draw paths and the inspector toggle all call it. Today they each re-derive it.

## 4. Offsets: one containing-block function (fixes the class of bug behind `-421px`)

`containingBlockOffsets(rectInFrameSpace, element, view)` -> `{ left, top, right, bottom }` in CSS px, computed from the element's real containing block (nearest positioned ancestor's PADDING box, border and scroll offset subtracted, zoom and any ancestor transform divided out), not `offsetLeft` against `offsetParent`. Refuses (named reason) when the containing block is not the node's tree parent or sits across a `transform`/`contain` boundary that the tree does not show. Used by free-move start (`planFreeMoveOffsets`), draw, image drop (`canvasImageDropPlacement`), cross-frame drop. Guard: never write a negative inset the drop did not intend (a drop whose centre is outside the containing block clamps to the nearest edge and says so via the snap chip, no toast).

## 5. Codemods and store actions

1. `frameJsxElements` — not a new engine: `wrapJsxElements` gains an optional `props` (wrapper style) argument (remove nothing; it already owns tag choice by content model and the contiguity checks). Store: `frameSelection(nodeIds)` in `groupActions.ts` next to `groupNodes`. Wrapper styles by member kind: free-frame members -> `position:absolute; left; top; width; height` (union rect) and members rebased to wrapper-relative offsets, all in ONE transaction (`setNodesInlineStylesPerNode`), ONE undo; flow members -> bare `<div>` (D3), no pixel freezing.
2. `inferAutoLayout(childRects, parentRect, parentPadding)` pure -> `{direction, gap (uniform within 1px, else cleared), padding, justify, align}`; used by shift A. Extends `layers.toggleFlexLayout` (replace its direction-only inference; no second path).
3. `convertToFlow(nodeIds)` — when adding AL to a free-frame: clear `position/left/top/right/bottom/translate` on each absolute child in one transaction, children ordered by position along the inferred axis (source reorder via existing `moveNodes`). Refuses the whole gesture, by name, if any child is a `.map` row, shared-component markup or another file (OD-7 detach-then-replay applies).
4. `freezePositions(nodeIds)` ("Remove auto layout, keep positions"): measure each child, write absolute + insets, parent `position:relative`. Reverse of 3. Optional (PA-8).
5. `setIgnoreAutoLayout(nodeIds, on)` — writes child position + (if the parent is static and the parent's style site is single and unshared) parent `position:relative` in one transaction; otherwise the existing refusal with its remedy.
All write through existing inline-style / class writers; no new server route, no new codemod file except `inferAutoLayout.ts` (pure) and the `props` parameter.

## 6. Inspector controls

- Position section, child of an auto-layout parent: **Ignore auto layout** toggle button (Button primitive, icon, tooltip naming the parent will become `position:relative`). When on: constraints block (exists) enables.
- Layout section: a read-only **Free frame** hint chip when `kind === 'free-frame'` (so the user knows children are placed by constraints), and a menu item **Add auto layout** (calls the same command as shift A) and **Remove auto layout (keep positions)** (PA-8). The 4-button mode row stays; `none` keeps meaning flow. No fifth mode.
- Size section: `sizingAxisRole` gains `'absolute'`. Fill on an absolute axis = Left-and-right constraint (both insets, size cleared); Hug = size cleared with one inset; Fixed = size literal. One write path with the constraints crosshair (it calls `constraintMapping`'s planner, not a second one). Mode shown stays consistent between the two controls.
- Frame tool (F) and R/O: the draw spec gains `placement: 'parent-decides'`.

## 7. Bundles (each leaves the tree building; one PR each, base feat/canvas-excellence)

| Id | Change | Files | Tests | Size |
|---|---|---|---|---|
| PA-1 | `containingBlockOffsets` + repro and fix of the negative-inset write | create `core/studio-runtime/containingBlockOffsets.ts`; modify `canvasFreeMove.ts` (`planFreeMoveOffsets` -> box from it), `canvasImageDropPlacement.ts`; scout first reproduces `-421px` | `__tests__/studio-runtime/containingBlockOffsets.test.ts` (padding, border, scroll, zoom 0.5/1/2, transformed ancestor, RTL); e2e computed-rect spec: dropped rect == pointer rect +-1px | M |
| PA-2 | `parentPlacementKind` + `resolvePlacement`; delete `isAutoLayout`; free-move works without cmd inside a free-frame | create `core/studio-runtime/placementKind.ts`; modify `canvasFreeMove.ts` (`resolveMember`), `canvasNodeArrowMove.ts`, `canvasDnd.ts` consumers | placementKind table test; free-move test in a free frame; arch gate `placement-kind-single-source` (no other file tests `display.includes('flex')` for placement) | M |
| PA-3 | Draw / drop / insert into a free frame lands absolute; cmd-draw in a flow/AL parent | modify `canvasDrawTool.ts` (`drawInsertStyles` takes offsets), `CanvasDrawToolLayer.tsx`, `canvasInsertionDrop.ts`, `canvasFileDrop.ts` | draw test extension; e2e: draw in free frame, reload, computed position equals drawn rect | M |
| PA-4 | Ignore auto layout / Reinstate (store action + inspector toggle) | create `store/slices/site/ignoreAutoLayoutActions.ts`; modify `PositionControls` section, `PositionConstraints.tsx` visibility | action test (one undo entry, parent+child), refusal tests (shared, map row), panel test | M |
| PA-5 | Absolute sizing role so Fill/Hug and constraints agree | modify `elementSizingRules.ts` (`'absolute'` role), `SizeSection.tsx`, `constraintMapping.ts` (shared planner) | `elementSizingRules` table extension; panel parity test (Fill == stretch) | S/M |
| PA-6 | Frame selection (opt cmd G) | modify `wrapJsxElements.ts` (`props`), `groupActions.ts` (`frameSelection`), `keybindings.ts`, `keybindingLayerCommands.ts`, spotlight `layers.ts` | codemod test (indent, content-model, props), store test (rebase in one undo), keybinding table test | L |
| PA-7 | Add auto layout, full inference + `convertToFlow` | create `core/studio-runtime/inferAutoLayout.ts`; modify `layerCommands.ts` (`toggleFlexLayout`), `LayerArrangeMenuItems.tsx` | inference pure tests (uniform gap, mixed gap, padding, baseline), conversion refusal tests, e2e | L |
| PA-8 | Remove auto layout keep positions (`freezePositions`) + docs + live-frame anchored resize | modify `resizeHandles.ts`/`resizeTargetContext.ts` (send authored offsets), `docs/features/inspector.md`, `docs/agent-refs/canvas-internals.md` | freeze test; live resize e2e | M |

Order: PA-1 -> PA-2 -> PA-3 -> PA-4 -> PA-5 -> PA-6 -> PA-7 -> PA-8. PA-1 and PA-2 are the foundation and independently shippable; PA-3/4 deliver the user-visible "place anywhere"; PA-6/7 are the Figma-parity codemods. Specialists: canvas-engineer (1, 2, 3, 8), store-engineer (4, 6), panel-designer (4, 5, 7 UI), parser-surgeon (6, 7 codemod), test-engineer (e2e computed-layout specs). Per BRIEF trap 13 the human dogfoods; static gates plus the computed-layout e2e where the rect math is the claim.

## 8. Risks

- Free-frame detection flips when the user adds the first in-flow child (the frame then reads `flow`). Accepted and honest: the behaviour follows the CSS. The Layout chip makes the state visible.
- `contain`/`transform` ancestors change the containing block: `containingBlockOffsets` refuses by name rather than guess.
- Converting 20 children writes 20 elements: all-or-nothing refusal (OD-7 path) and one undo.
- Percent/Scale on non-measurable parents: existing refusal stands.
- Live (Tier 2) frames cannot yet read authored offsets: PA-8 closes; until then live resize of a right-anchored layer still writes `left` (already documented in `elementResizeAnchoring.ts`).

## 9. Owner decisions (recommendations)

| Id | Question | Recommendation |
|---|---|---|
| OD-P1 | Free-frame detected from computed style, or marked in source? | Derived, no marker |
| OD-P2 | Ignore auto layout / cmd-drag when the AL parent is static: refuse with remedy (today) or write `position:relative` on the parent automatically? | Auto-write as part of the same undo step when the parent style site is single and unshared; refuse (with remedy) otherwise |
| OD-P3 | Frame selection on in-flow members | Bare `<div>`, members unchanged; only absolute members get a positioned wrapper. Never freeze flow children into pixels |
| OD-P4 | Drawing in a plain flow (block) frame: Figma places freely | Keep flow insert (honest), cmd places freely |
| OD-P5 | Fifth "Free" layout mode button? | No; a derived chip and the Add/Remove auto layout menu items |
| OD-P6 | Default unit for a newly absolute layer | px; % only through the Scale constraint |
| OD-P7 | Modifier key | Keep cmd/ctrl (already shipped, K6); no Alt (Alt = copy) |
