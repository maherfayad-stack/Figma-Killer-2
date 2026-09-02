# D2 (drag and drop) + D3 (de-Studio-ify) — handoff

Agent: canvas-engineer. Repo: `c:\Users\Admin\Documents\GitHub\Figma Killer 2`,
branch `feat/alm-figma-killer-studio-shell`. Nothing committed, nothing staged,
`STATE.md` not touched, per constraints.

## TL;DR — what actually landed vs. what did not

**Landed and tested:** G10 (+ a companion bug it exposed), G16 was already
done by Phase 0 (confirmed, not re-touched), G9 (partial — CSS-only, not
sibling-geometry grid), G5 (partial — preview wired into canvas + DOM-panel
resolvers only), G12 (partial — plain reorder only, no `KeyboardSensor`), the
`UndoRedoButtons.tsx` inline-matcher drift routed to me, a genuine circular
import the architecture-gate repair surfaced, and all of D3.

**Explicitly NOT done — be honest about this:** G2 (drag the element itself),
G3 (cross-frame drag), G6 (RAF/candidate-cache throttling for insertion
drags), G7 (insertion-drag wrong-page resolution), G8 (board furniture —
also owned by a concurrent C2 agent), G15 (file drop), the `dragSession`
singleton, the board-wide `frameCandidateIndex`, the unified `resolveDrop`,
and `@dnd-kit/core` removal. **D2 is the single largest item in the plan for
a reason — this pass shipped the independently-valuable slice, not the
rewrite.** See "What's deferred" below for the precise remaining shape.

---

## Files touched (all under my ownership)

**Core (`src/core/page-tree/`):**
- `dnd.ts` — G10 fix (`normalizeIndexAfterRemoval`) + the `noOpTarget`
  companion fix it exposed.
- `sourceStructure.ts` — new `previewStructuralMove` / `StructuralMoveCommit`
  / `StructuralMovePreview` (G5's pure preview, the published D2→F2
  contract — see below).
- `index.ts` — barrel re-exports for the above.
- `__tests__/sourceStructure.test.ts` — `previewStructuralMove` test suite.

**Canvas (`src/admin/pages/site/canvas/`):**
- `canvasDnd.ts` — `CanvasDropCandidate.reversed` (G9), `getCanvasDropZone`
  before/after flip, G5 wiring in `resolveCanvasDropTarget`.
- `canvasDomGeometry.ts` — `resolveCanvasAxisFromStyle` / `resolveCanvasInsertionAxis`
  replace `inferCanvasDropAxis` (G9); realm-correct `getComputedStyle` (reads
  from the candidate's own document view, not ambient `window`).
- `canvasZoomFit.ts` (new) — pure `computeZoomToFitTransform` (D3 zoom-to-fit
  / zoom-to-selection).
- `math.ts` — `CanvasTransform` moved here from `useCanvas.ts` (breaks a
  circular import — see "Landmines").
- `useCanvasKeyboardShortcuts.ts` — `Alt+↑`/`Alt+↓` reorder (G12).
- `BreakpointSelectionOverlay.tsx` — invalid-drop indicator carries
  `data-refusal-reason` + the message (not yet rendered as visible text).
- `CanvasRoot.tsx` — D3: `CanvasContextSelector` hidden when `activeBoardId`
  is set.
- `UndoRedoButtons.tsx` — removed the inline `e.key === 'y'` matcher (routed
  fix; folded into `editor.redo`'s own registry `match`).

**DOM panel (`src/admin/pages/site/panels/DomPanel/`):**
- `domPanelDnd.ts` — new `previewDomDropRefusal` (G5, tree-row side).
- `useDomPanelDnd.ts`, `DomPanelDndContext.ts`, `TreeNode.tsx` — wire
  `invalidReason` through; `TreeNode.tsx` renders it as a real `title`
  (rows aren't `pointer-events: none`, so it actually fires).

**Toolbar / hooks / spotlight:**
- `src/admin/pages/site/hooks/useCanvas.ts` — `zoomToFit()`/`zoomToSelection()`,
  `Shift+1`/`Shift+2` routed through the keybindings registry.
- `src/admin/pages/site/toolbar/ZoomControls.tsx` — doc-comment update only
  (no behavior change — see "What's deferred" for why no button was added).
- `src/admin/spotlight/keybindings.ts` — `canvas.zoomToFit`,
  `canvas.zoomToSelection`, `layers.moveUp`, `layers.moveDown`; `editor.redo`'s
  `match` now also accepts Ctrl/Cmd+Y.

**D3 (dead prop, board-mode gate):**
- `src/admin/pages/site/sidebars/LeftSidebar/LeftSidebar.tsx`,
  `src/admin/pages/site/sidebars/PanelRail/PanelRail.tsx` — deleted the dead
  `workspace?: 'site'|'content'|'media'` prop. `railIdentity`'s hash STRING
  keeps a hardcoded `'site:'` prefix (not removed) to avoid silently
  reshuffling rail accent colors — see the comment in `PanelRail.tsx`.
- `src/admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx` — the one
  caller, updated to match (not in my ownership list, but the sole caller of
  a prop I deleted — mechanical, one line).

**New tests:**
- `src/__tests__/core/pageTreeDnd.test.ts` — G10 fix + regression, and the
  `noOpTarget` false-positive regression.
- `src/core/page-tree/__tests__/sourceStructure.test.ts` — `previewStructuralMove`.
- `src/__tests__/canvas/canvasDnd.test.ts` — G9 reversed-flip, G5 refusal
  preview (shared-component case), G5 no-false-positive-on-CMS-nodes case.
- `src/__tests__/canvas/canvasInsertionAxis.test.ts` (new) — G9: flex
  row/row-reverse/column/column-reverse × RTL, grid row/column autoflow × RTL.
- `src/__tests__/canvas/canvasZoomFit.test.ts` (new) — zoom-to-fit pure math.
- `src/__tests__/canvas/canvasContextSelectorBoardMode.test.tsx` (new) —
  D3 board-mode gate, real render.
- `src/__tests__/dom-panel-dnd/target-resolution.test.ts` — G5 refusal
  preview (tree-row side).
- `src/admin/spotlight/__tests__/keybindings.test.ts` (new) — the 4 new
  bindings' `match` predicates.
- `src/__tests__/toolbar/toolbar.test.ts` — updated the redo-alias test to
  assert behavior via the registry instead of grepping a literal that moved.
- `src/__tests__/architecture/single-drag-mechanism.test.ts` (new, the ONE
  file I was told to create in the siblings' territory) — see below.

**Docs:** `docs/reference/canvas-dnd.md` — rewritten sections: axis (G9),
new "Source-writeback refusal preview (G5)" section, new "Keyboard reorder
(G12, partial)" section, "Multi-select drag" section extended with G10, and
the "Known remaining gaps" footer split into "Fixed this pass" / "Known
remaining gaps" with the exact deferred list.

---

## G10 — multi-drag index off by n−1: FIXED, and a companion bug found

`normalizeIndexAfterRemoval` (`core/page-tree/dnd.ts`) now counts how many of
`draggedIds` sit below the raw target index in `parentId`'s children TODAY,
not just the pivot. Test-first: `pageTreeDnd.test.ts`'s new case reproduces
the audit's exact "3 siblings dropped after index 5" scenario, fails against
the old code (verified: index 5 instead of 3), passes against the fix.

**A second, more subtle bug was hiding behind the first.** `noOpTarget`
compared only the PIVOT's own pre-move index against the computed target
index — correct ONLY for a single-node drag, because that's the one case
where "pivot's original slot number" and "pivot's post-removal target slot
number" are the same bijection. For an n>1 drag those are indices into
arrays of DIFFERENT length, and can coincide NUMERICALLY by accident on a
real move. **G10's fix, by making the index finally correct, made this
collision REAL** for a case that shipped tests already exercised
(`selectionToolbar.test.tsx`'s multi-drag test): dragging 2 middle siblings
of a 4-item list to the end computed target index `2`, which happened to
equal the pivot's own original index `2` — `noOpTarget` returned `true`, the
whole group silently failed to move, and `selectionToolbar.test.tsx` started
failing (confirmed: reverting only the `!activeBoardId` D3 change did NOT
fix it; reverting my whole session via `git stash` did — isolated the cause
correctly before shipping the fix). Fixed by rewriting `noOpTarget` to
simulate the WHOLE group's actual post-move order (same detach-then-splice
arithmetic `moveNodes` itself runs) rather than comparing one index.
Regression: `pageTreeDnd.test.ts`'s "does not false-positive a real
multi-drag as a no-op" + "still recognises a genuine multi-drag no-op".

**If you touch `noOpTarget`/`normalizeIndexAfterRemoval` again:** they must
stay consistent with `moveNodes`' own arithmetic (`mutations.ts:580-591`) —
detach ALL dragged ids first (in `draggedIds` order, not children order),
THEN splice at the clamped index. Any future change to `moveNodes`' order-of-
operations needs a matching change here or these three functions will
disagree about what "no-op" and "target index" mean.

---

## G5 — `previewStructuralMove`: the published D2→F2 contract

**This is the part of the handoff F2 will actually read, so I'm being
precise.**

```ts
// @core/page-tree (src/core/page-tree/sourceStructure.ts)
export interface StructuralMoveCommit {
  nodeId: string
  anchorNodeId: string
  position: 'before' | 'after'
}

export type StructuralMovePreview =
  | { ok: true; commit: StructuralMoveCommit | null }
  | { ok: false; refusal: StructuralRefusal }

export function previewStructuralMove(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  newParentId: string,
  newIndex: number,
): StructuralMovePreview
```

- **Pure.** No store, no HTTP, no side effects. Answers the identical
  refusal vocabulary `refuseStructuralEdit`/`refusePlacement` already answer
  (`list-row` / `shared-component` / `route-chrome` / `code-placed` /
  `reparent` / `no-sibling-anchor` / `cross-file` / `multi-select`).
- **Call ONLY after tree-shape resolution already passed** — i.e. after
  `resolvePageTreeDropTarget` (`core/page-tree/dnd.ts`) returned a non-null
  target. `previewStructuralMove` does not re-check root/locked/cycle/
  non-container; that's the earlier function's job. Pass that target's own
  `parentId`/`index` straight through.
- **Ordinary CMS (nanoid) nodes always get `{ ok: true }`** — the same
  short-circuit `refuseStructuralEdit` already has (`!isSourceDerivedNodeId`
  → `null`) fires before any of the structural checks. Verified explicitly
  (`sourceStructure.test.ts`'s stale-target case, `canvasDnd.test.ts`'s "does
  not invent a refusal for an ordinary CMS node").
- **Wired into `canvasDnd.ts`'s `resolveCanvasDropTarget` and
  `domPanelDnd.ts`'s new `previewDomDropRefusal`** — those are the only two
  call sites. A refused move now resolves as `invalid`/`invalidReason`
  instead of a valid `target`, so the drop line for a doomed move never
  renders in the first place (was: confident valid line → post-hoc toast on
  release).
- **Confirmed consumed correctly by F2's `editConstraint.ts` already in the
  tree** — its own doc comment says "the function already lands with the
  exact signature this wrapper expects", `explainGestureConstraint(preview:
  StructuralMovePreview, node)` compiles clean against my types, `tsc
  --noEmit` is clean across the whole repo. This is the E2.1 → me → F2
  serialization working as intended — no coordination gap.

**Known, disclosed duplication — real, not an oversight.** The store's
`src/admin/pages/site/store/slices/site/structuralSourceEdits.ts` still has
its OWN, near-identical `planSourceMove` (the commit-time authority
`nodeActions.ts`'s `moveNodes` calls). I could not collapse it into a thin
wrapper over `previewStructuralMove` because `structuralSourceEdits.ts` is
under `src/admin/pages/site/store/**`, explicitly off-limits to me this
task. **Whoever owns that directory next should do this**: replace
`planSourceMove`'s body with a call to `previewStructuralMove`, keeping only
the store-specific bits (`refuseCanvasOnlyNodeIntoSource`'s UI-facing
message, which I deliberately left reason-only in the core copy —
`previewCanvasOnlyNodeIntoSourceRefusal` in `sourceStructure.ts` — since a
"click here to fix it" sentence pointing at the picker UI doesn't belong in
a pure core module). Until that happens, a change to one must be mirrored by
hand in the other — I left an explicit doc comment on both pointing at each
other.

**What I explicitly did NOT build for G5:** a visible cursor-following label
showing the refusal reason on the canvas (the invalid-drop box carries
`refusalMessage` in its data but the DOM element is `pointer-events: none`,
so a native `title` never fires — needs a small positioned label component).
The DOM panel side DOES show it (`TreeNode.tsx`'s `title`, since tree rows
accept pointer events).

---

## G9 — axis resolution: partial, and honestly scoped

`resolveCanvasAxisFromStyle` (pure, `canvasDomGeometry.ts`) now correctly
handles:
- `flex-direction: row-reverse` / `column-reverse` (flips `reversed`).
- `direction: rtl` on a `row` flex container (visual-left is the logical
  end — `reversed: true`), and correctly does NOT double-flip
  `row-reverse` + `rtl` together (the two cancel out — tested explicitly).
- Reads from the candidate's OWN document view (`ownerDocument.defaultView`),
  not the ambient parent `window` — the audit flagged this as "works in
  Chrome but not a contract"; now correct by construction.

`grid` support is a **CSS-only heuristic, not the sibling-geometry-derived
axis** the audit's own proposed fix describes (compare actual sibling rect
overlap). What ships: `gridAutoFlow: column` → vertical, default `row`
autoflow → horizontal. This is a real, positive improvement over the
pre-existing unconditional `'vertical'` (which drew horizontal insertion
bars across every side-by-side grid gallery, 100% of the time) but is still
wrong for an explicit `grid-template-columns` layout whose items aren't
auto-placed. **Doing the sibling-geometry version needs
`measureCanvasDropCandidates` to thread sibling rects into the axis
resolver — a real plumbing change, deferred.** Say this plainly to whoever
picks it up next: the current grid answer is a heuristic, not a fix.

`CanvasDropCandidate.reversed` is optional (`reversed?: boolean`) rather than
required, specifically so the existing `candidate(...)` test-fixture helper
in `canvasDnd.test.ts` didn't need touching everywhere it's called —
`getCanvasDropZone` treats `undefined` as falsy (not reversed), which is the
correct default for every pre-existing test.

Tests: `src/__tests__/canvas/canvasInsertionAxis.test.ts` (14 cases: block,
flex × 4 directions × RTL, grid × 2 autoflows × RTL, inline-flex,
inline-grid) + `canvasDnd.test.ts`'s new reversed-flip case for
`getCanvasDropZone` itself.

---

## G12 — keyboard reorder: partial

`Alt+↑` / `Alt+↓` (registry ids `layers.moveUp`/`layers.moveDown`, matching
the SAME command ids the spotlight palette already exposed — I found those
commands already existed in `spotlight/commands/layers.ts`, uncommitted, from
earlier work; only the KEYBOARD binding was missing) now move the selected
node one position among its siblings, wired in
`useCanvasKeyboardShortcuts.ts`, calling the store's existing `moveNode`
action — the same one every drag surface commits through, so a keyboard
move rides the identical structural-refusal gate a mouse drag does.
Single-node only; a multi-selection silently no-ops (no well-defined "up"
when the selection may not share a parent).

**Chose `Alt+↑`/`Alt+↓` deliberately, not a bare arrow** — `CanvasTreeLadderOverlay.tsx`
already owns Arrow keys while its Alt-HOLD hover-inspect ladder is showing
(a genuinely different, pre-existing gesture: hold Alt, hover a node, tap
arrows to walk the ancestor/descendant chain). The two do not collide in
practice — the ladder's own `handleKeyDown` only intercepts Arrow keys when
`showTreeLadder` is true (Alt held AND hovering a valid node), and falls
through untouched otherwise — but it's worth knowing this boundary exists
before reaching for a different modifier combo later.

**What I did NOT build:** `KeyboardSensor` + `announcements` on either
`@dnd-kit/core` `<DndContext>` (DOM panel, Site Explorer) — a `@dnd-kit`-
driven drag itself still has zero keyboard path; only the new plain-reorder
command does. Indent/outdent (reparent) commands do not exist — reparenting
a source-derived node refuses unconditionally regardless of trigger today,
so there's little for a keyboard command to accomplish there yet.

---

## What's deferred — precise, not vague

**G2 (drag the element itself)** — not touched. Still only the selection
toolbar's hand-grab button. Would need `NodeRenderer.tsx`'s existing
`onPointerDownCapture` promoted to a press-and-move gesture, with a synthetic
drag-start relayed to the parent through the existing cross-iframe channel.

**G3 (cross-frame drag)** — not touched. `useCanvasReorderDrag.ts` still
measures candidates once, from one iframe, at `pointerdown`
(`measureCanvasDropCandidates(viewport, tree, iframeElement)`); a drop over a
different frame still hits `if (!target) return` — silent no-op. This is the
one that genuinely needs the board-wide `frameCandidateIndex` from the
target architecture; there's no cheap partial fix for it.

**G6 (insertion-drag throttling)** — not touched.
`resolveCanvasPointerInsertionDrop` still re-measures the whole frame
(`querySelectorAll` + `getBoundingClientRect` + `getComputedStyle` per node)
on every `pointermove`, no RAF coalescing, no caching.

**G7 (insertion drag wrong-page)** — not touched.
`canvasInsertionDrop.ts` still resolves the viewport geometrically but the
tree against `selectActiveCanvasPage`, so hovering a non-active board frame
during an insertion drag can still target the wrong page's tree.

**G8 (board furniture)** — not touched, and `BoardFramesLayer/` is owned by
a concurrent C2 agent this task explicitly told me not to edit. Its own
double-store-write-per-pointermove, no-multi-frame-drag, no-Escape, and
snap-peers-keyed-by-pageId issues are all exactly as the audit found them.

**G15 (file drop)** — not touched. Zero `onDrop`/`onDragOver` in
`canvas/` or `ImportProjectDialog.tsx`.

**The `dragSession` singleton + board-wide `frameCandidateIndex` + one
`resolveDrop`** — none of this exists. `canvasPointerRelay.ts`'s global
`data-studio-canvas-dragging` attribute is unchanged; the three inline
pointer loops (canvas reorder, module inserter, media insertion) are
unchanged. This is the actual "L effort, biggest item in the plan" work and
it did not fit in this pass alongside everything else above.

**`@dnd-kit/core` removal** — NOT done. Still exactly 3 `<DndContext>`s:
`DomPanel.tsx` (layer tree), `useSiteExplorerDnd.ts` (Site Explorer),
`DashboardGrid.tsx`/`BlockLibrary.tsx` (dormant CMS dashboard — I found this
THIRD surface during the audit; the plan's prose only names two). Native
HTML5 `dataTransfer` DnD is also unchanged (media workspace + the two file-
drop targets it shares).

---

## `src/__tests__/architecture/single-drag-mechanism.test.ts` — what it actually asserts

Per the explicit instruction to create only this one file in the
architecture-gates directory (owned by a concurrent agent this session): it
does **NOT** assert "one drag mechanism" — that would be false today. It
asserts **containment**: `@dnd-kit/core` and native HTML5 `dataTransfer` DnD
are each pinned to an explicit allowlist of the exact files that use them
right now (verified against the real tree — I grepped every current import
site, not the plan's prose, and found the dashboard's `@dnd-kit` usage and
`AnalyzeStep.tsx`'s native DnD that neither the plan nor my first grep pass
caught). A NEW file reaching for either mechanism fails the gate. Two
"no stale entries" tests keep the allowlists honest if a listed file stops
using the mechanism it's allowlisted for.

Detection signals, chosen to avoid a false positive against `<DndContext
onDragStart=…>`'s coincidentally-same-named prop: `@dnd-kit/core` gate scans
for the literal import specifier; native-DnD gate scans for the bare word
`dataTransfer` (a real `DragEvent` property dnd-kit's synthetic events don't
have) OR React's `DragEvent<` type (for components like `MediaCanvasItems.tsx`
that only forward native drag callbacks as props without touching
`.dataTransfer` themselves). Both signals were verified NOT to appear
anywhere in the `@dnd-kit` allowlist's files (zero collision).

**When D2's real unification lands: delete the allowlists, not just empty
them, and tighten this gate to a flat ban.** Said explicitly in the file's
own module doc.

---

## D3 — all four items done

1. **`CanvasContextSelector` killed in board mode.** `CanvasRoot.tsx`'s
   render condition gained `&& !activeBoardId` (the same signal
   `CanvasTransformLayer` already uses to decide whether to render
   `BoardFramesLayer`). Real-render regression test
   (`canvasContextSelectorBoardMode.test.tsx`) confirmed meaningful by
   temporarily reverting the fix and watching the test fail identically
   (then restored). Did not touch `BoardFramesLayer.tsx` — read it, didn't
   edit it, per the ownership carve-out.
2. **Dead `workspace` prop deleted** from `LeftSidebar.tsx`/`PanelRail.tsx`
   (only ever called with `'site'`; no test referenced `'content'`/`'media'`).
   `railIdentity`'s hash string keeps a hardcoded `'site:'` literal — I did
   NOT drop it from the string, because `assignRailAccents` hashes that exact
   string per rail item and several accent colors are already deliberately
   pinned to today's hash output (see the "Explorer keeps the 'gold' accent"
   comment in `PanelRail.tsx`); dropping the prefix would have silently
   reshuffled colors for users with nothing left to explain why.
3. **`Shift+1` rebound to zoom-to-fit; `Shift+2` added for zoom-to-selection.**
   Both keyboard-only (via the registry, wired in `useCanvas.ts`) — NOT
   wired to a toolbar button. `ZoomControls.tsx` renders outside
   `CanvasRoot`'s `CanvasViewportActionsContext` provider tree (it lives in
   `AdminCanvasLayout`, a sibling of the canvas, per its own existing doc
   comment), so a button would need either that context threaded out to a
   file I don't own, or a second independent DOM-measurement implementation
   duplicating `useCanvas.ts`'s. Left as keyboard-only rather than
   duplicating logic; documented as a named follow-up in `ZoomControls.tsx`'s
   own comment.
   - `computeZoomToFitTransform` (`canvasZoomFit.ts`) is pure and unit-tested
     (8 cases: empty, degenerate rect, grow-to-fit, shrink-to-fit, multi-rect
     union, zoom-independence, MIN_ZOOM clamp, padding).
   - `zoomToFit()` measures `[data-breakpoint-id]` elements (one per frame,
     exact match — NOT `[data-testid^="canvas-frame-"]`, which also matches
     each frame's activate/live/collapse buttons that share that prefix; a
     real trap I hit and fixed before shipping).
   - `zoomToSelection()` measures the ALREADY-POSITIONED selection ring(s)
     (`[data-canvas-selection-ring="true"]`) rather than re-deriving node
     geometry — reuses the exact cross-iframe, zoom-aware rect the selection
     overlay computes every RAF tick anyway. Multi-select unions automatically.
4. **`Shift+1` UndoRedoButtons/redo-alias drift** (routed to me mid-task):
   `UndoRedoButtons.tsx:49`'s inline `(e.metaKey || e.ctrlKey) && e.key ===
   'y'` moved into `editor.redo`'s own `match` predicate in
   `keybindings.ts` (accepts EITHER Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y, display
   label stays the canonical Shift+Z). `keybindings-registry-single-source.test.ts`
   (now live/repaired) passes. Updated `toolbar.test.ts`'s matching test to
   assert the registry's `match` behavior instead of grepping for a literal
   that moved.

**Not touched (verified already correct, per the work order):**
`BreakpointFrame.tsx`, the `runScripts` toggle, publish/save-draft chrome
hiding.

---

## Landmine found and fixed: a genuine circular import

`useCanvas.ts` → `canvasZoomFit.ts` (value import of
`computeZoomToFitTransform`) → `useCanvas.ts` (type import of
`CanvasTransform`) was a real cycle, introduced by my own D3 work, caught by
the sibling repairing the architecture gates
(`no-circular-dependencies.test.ts`). **Fixed by moving `CanvasTransform`'s
definition into `math.ts`** (the pure, zero-dependency coordinate-math
module both files already import from) and having `useCanvas.ts` re-export
it — every existing `from '@site/hooks/useCanvas'` import site (7 files,
including `CanvasRulers/` which is D1's territory, untouched) keeps working
unchanged. Same shape the ruler code used for a comparable problem, per the
coordinator's own suggestion. Verified: `no-circular-dependencies.test.ts`
passes, `tsc --noEmit` clean, all touched tests still pass.

**If you add a new pure helper under `canvas/` that needs `CanvasTransform`'s
shape:** import it from `./math`, never from `../hooks/useCanvas` — the hook
module pulls in React, Zustand, and gesture libraries; anything meant to stay
pure and unit-testable without a DOM should reach past it to `math.ts`.

---

## Verified NOT mine (checked explicitly per the coordinator's warning)

- `canvas-aware-selectors.test.ts` (now live, retargeted from a nonexistent
  `src/editor` root) — 2 failing assertions naming `TemplateModeControl.tsx`,
  `useActiveLivePath.ts`, `BindingPickerPopover.tsx`, `UserStylesheetInjector.tsx`.
  None touched by me (`git diff --stat` confirms only `UserStylesheetInjector.tsx`
  is modified in the tree, and not by me — it was already modified before my
  session started).
- `ui-primitives-location.test.ts` — 1 failure naming
  `AddCustomFontDialog.tsx`. Not touched by me.
- `direct-icon-imports.test.ts` — 1 failure naming 5 files including
  `ModuleInserterDialog.tsx`. That file IS modified in the working tree, but
  not by me (confirmed via `git diff --stat` before I ever opened it — it was
  already dirty at session start).
- `editConstraint.test.ts` (F2's own, brand-new/untracked file) — 4 failures
  in `structuralActions()`'s reason→action mapping, unrelated to my
  `previewStructuralMove` contract (confirmed by reading the failing
  assertions and F2's own doc comment, which says my function "already lands
  with the exact signature this wrapper expects"). Not touched.

---

## Verification run

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json     — clean
./node_modules/.bin/eslint <every file I touched>      — clean (0 warnings/errors)
bun test <every file I touched/added, run together>    — 201/201 pass (17 files)
bun test src/__tests__/architecture/single-drag-mechanism.test.ts    — 4/4
bun test src/__tests__/architecture/no-circular-dependencies.test.ts — 1/1
bun test src/__tests__/architecture/keybindings-registry-single-source.test.ts — 2/2
```

Did NOT run `bun run lint` / `bun run build` (siblings collide on
`dist`/`.tsbuildinfo`, per instruction). Did NOT run Playwright — no new
browser infra built; see "What the human must dogfood" below.

One pre-existing, whole-directory flakiness note: `bun test
src/__tests__/canvas` (the full 80-file directory, not my individual files)
shows 2 intermittent failures in `boardFrameVariantSelection.test.tsx` when
run as part of the FULL directory sweep, but 0 failures when run in
isolation. Confirmed pre-existing and order-dependent, not mine: with my
entire session's changes `git stash`ed, running the same full-directory
sweep showed a DIFFERENT set of 6 failures (including
`userStylesheetInjectorRenderScope.test.tsx`, which I never touched). This is
cross-file test pollution in that directory under full-sweep concurrency,
not a regression from this session.

---

## What the human must dogfood

Per `standing-02` — geometry/layout work is exactly the carve-out category,
and I did not build new Playwright infrastructure (none was there to reuse
for these specific interactions). Route: `/admin/site?studio`, an imported
project with at least one Studio board containing 2+ frames.

1. **D10/multi-drag** — In the DOM panel (layer tree), select 2-3 sibling
   rows (shift-click) and drag them to a new position among their OTHER
   siblings (not to the very top or bottom, and not back to where they
   started). Confirm the group lands EXACTLY where the drop indicator showed,
   not shifted. Try dragging exactly 2 middle siblings to just past the last
   sibling — this is the specific case that was silently landing as a no-op
   before this fix.
2. **G9/axis** — Find (or add) a CSS grid gallery on the canvas and drag an
   existing element near a sibling; confirm the insertion line is now
   VERTICAL between side-by-side grid items (was always horizontal before).
   If the project has an RTL preview axis toggle, flip it and confirm
   before/after insertion lines still land on the visually-correct side.
3. **G5/refusal preview** — On an imported project with shared/reused
   components, try to drag one instance of a repeated component (button,
   card) next to another instance of a DIFFERENT shared component. Before
   this fix: a confident drop line, then nothing + a toast on release. After:
   the drop position should show the SAME red "invalid" box a locked-node
   drag already shows, DURING the drag, before you release. In the DOM
   panel, the same case should show a native tooltip (hover long enough)
   with the refusal reason.
4. **G12/keyboard reorder** — Select a single node (canvas or DOM panel),
   press `Alt+↑` / `Alt+↓` a few times, confirm it moves among its siblings
   the same way a drag would, and that Undo (Cmd/Ctrl+Z) reverts each step.
5. **D3/board-mode context selector** — Open a Studio board with 2+ frames.
   Confirm the top-right breakpoint/condition selector (`CanvasContextSelector`)
   does NOT appear at all while a board is active. Switch to a non-board
   page (an ordinary CMS/VC page) and confirm it DOES appear there, unchanged.
6. **D3/zoom-to-fit + zoom-to-selection** — On a board with several frames
   scattered around, pan/zoom somewhere off-center, then press `Shift+1`.
   Confirm every frame becomes visible, centered, with reasonable padding.
   Select one node inside a frame, press `Shift+2`, confirm the view zooms
   tightly to that node. Select 2+ nodes (shift-click) and press `Shift+2`
   again — confirm it fits the UNION of both selections. Confirm `Cmd/Ctrl+0`
   still resets to a plain 100%, unchanged from before.
7. **Redo alias** — Confirm both `Ctrl+Shift+Z` and `Ctrl+Y` (Windows/Linux)
   still redo.

---

## For F2 (previewStructuralMove) and whoever migrates `planSourceMove`

Read the "G5 — `previewStructuralMove`" section above in full — it's the
part of this handoff written for you specifically. Short version: the
contract is stable, `tsc` proves your `editConstraint.ts` already compiles
against it, and the one open action item is collapsing
`structuralSourceEdits.ts`'s `planSourceMove` into a thin wrapper once
someone owns that directory in a future pass.
