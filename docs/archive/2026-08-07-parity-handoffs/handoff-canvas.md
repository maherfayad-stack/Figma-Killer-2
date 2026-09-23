# canvas-engineer — Phase 0 handoff (items 0.8, 0.9, 0.10)

All three items landed. Nothing committed / staged — working tree only, per instructions.

## 0.8 — MAJOR: drop-edge hit zones collapse at low zoom — FIXED

**Root cause confirmed exactly as diagnosed.** `MIN_EDGE_HIT_ZONE`/`MAX_EDGE_HIT_ZONE`
(8 / 20) in `src/admin/pages/site/canvas/canvasDnd.ts` were compared directly
against `CanvasDropCandidate.rect`, which is **frame-space (unscaled)**
coordinates — already divided by the live canvas zoom
(`canvasDomGeometry.ts`'s `clientRectToViewportRect` / `getViewportLocalPoint`).
A screen-space constant compared to a frame-space quantity without dividing
by zoom shrinks to ~2 on-screen px at 25% zoom (unhittable — nearly every
drop resolved `'inside'`) and balloons to ~80px at 400% zoom (swallowing most
of a leaf node's `'inside'` region).

**Mechanism of the fix.**
- `src/admin/pages/site/canvas/canvasDnd.ts:96-129` — renamed the constants
  `MIN_EDGE_HIT_ZONE_SCREEN_PX` / `MAX_EDGE_HIT_ZONE_SCREEN_PX` (unchanged
  values, 8/20) to make the unit explicit, and added a `zoom: number = 1`
  third parameter to `getCanvasDropZone`. The screen-space min/max are now
  divided by `zoom` (guarded against 0/negative zoom) before clamping
  `size * EDGE_ZONE_RATIO`. `EDGE_ZONE_RATIO` itself is left alone — it's
  proportional to the candidate's own frame-space size, so it's already
  zoom-invariant (a fraction of the node's own screen size scales correctly
  with zoom on its own).
- `resolveCanvasDropTarget` / `resolveCanvasInsertionTarget`
  (`canvasDnd.ts:131-198`) gained an optional `zoom?: number` input field
  (default `1`), threaded straight into `getCanvasDropZone`. Default `1`
  keeps every existing caller/test that omits it byte-identical to the old
  (zoom-1) behaviour — no breakage.
- `src/admin/pages/site/canvas/canvasDomGeometry.ts` — added and exported
  `getViewportZoom(viewport: HTMLElement): number`, a thin wrapper around the
  file's existing (now-reused) private `getViewportScale` helper. This is
  the SAME measurement `getViewportLocalPoint` already uses internally to
  convert screen coordinates into frame-space — using it here keeps "what
  zoom means" defined in exactly one place.
- `src/admin/pages/site/canvas/useCanvasReorderDrag.ts:121-139` (canvas
  node-reorder drag) — `resolveAtClientPoint` now calls
  `getViewportZoom(viewport)` and passes `zoom` into
  `resolveCanvasDropTarget`.
- `src/admin/pages/site/canvas/canvasInsertionDrop.ts:79-95`
  (`resolveCanvasPointerInsertionDrop` — module-picker / media-insertion
  drags) — same pattern: `getViewportZoom(viewport)` computed and passed to
  `resolveCanvasInsertionTarget`.

**Coordinate-space note (as requested):** `candidate.rect` / `point` are
**frame-space** (a.k.a. "viewport-local, unscaled" in the existing code
comments) — i.e. already divided by zoom, NOT screen pixels. The bug was
treating a screen-space UX constant (an 8px physical hit target) as if it
were already in that frame-space unit. The fix divides the screen constant
by zoom before the comparison, which is the correct direction (small zoom →
divide by <1 → band grows in frame-space → stays ~8 screen px).

**Tests written** — `src/__tests__/canvas/canvasDnd.test.ts`, two new cases:
1. `'scales the edge-hit band by the live zoom (0.8 — collapsed drop-edge
   hit zones)'` — direct `getCanvasDropZone` assertions at zoom 1, 0.25, and
   4, including a same-physical-point comparison that resolves `'inside'`
   at zoom 1 but `'before'` at zoom 0.25 (documents the exact bug), and the
   inverse at zoom 4. Also covers zoom `0` (guards divide-by-zero).
2. `'threads zoom through resolveCanvasDropTarget so a whole-drop resolution
   is zoom-correct at low zoom'` — exercises the full resolver (not just the
   zone classifier) at zoom 1 vs 0.25 against a real page tree, confirming
   the `position` flips from `'inside'` to `'before'`.

**Result:** `bun test src/__tests__/canvas/canvasDnd.test.ts` → 6 pass / 0
fail / 25 expect() calls. Also ran the full `src/__tests__/canvas` directory
(574 pass / 0 fail) and every other canvas/dom-panel/media suite touched
below — all green, no regressions.

## 0.9 — MAJOR: DOM panel double auto-scroll — FIXED

**Confirmed exactly as diagnosed, one-line fix as the plan predicted.**
`src/admin/pages/site/panels/DomPanel/DomPanel.tsx`'s `<DndContext>` mount
(originally lines 493-499, now 493-508) had no `autoScroll` prop, so
dnd-kit's built-in auto-scroll ran alongside the hand-rolled one in
`useDomPanelDnd.ts:183-212` (`runAutoScroll` — re-measures rows via
`measureRows()` and re-resolves the drop target on every scroll tick;
dnd-kit's own scroll does neither). Matches `STATE.md:3989` verbatim.

**Fix:** `src/admin/pages/site/panels/DomPanel/DomPanel.tsx` — added
`autoScroll={false}` to the `<DndContext>` (with an explanatory comment
inline), leaving `useDomPanelDnd.ts`'s auto-scroll as the sole implementation.
No changes to `useDomPanelDnd.ts` itself — it was already correct, just
racing against dnd-kit's default.

**Tests:** no new test written (a one-line prop change with an existing
resolver-level regression suite already covering `resolveDomDropTarget`
correctness; the "two auto-scrollers race" defect is a runtime/scroll-timing
interaction that isn't practically unit-testable without a real scroll
container and rAF loop — matches the audit's own note that this belongs in
`tests/e2e` alongside `structural-writeback.e2e.ts`, which is out of scope
for a unit-test-only wave). Ran the existing suites instead to confirm no
regression:
- `src/__tests__/dom-panel-dnd/target-resolution.test.ts` → 5 pass
- `src/__tests__/panels/domPanel.test.tsx` → 39 pass
- `src/__tests__/dom-panel/*` (context menu, slot lockdown, background menu) → all pass (part of the 697-pass sweep below)

Confirmed `autoScroll?: boolean | AutoScrollOptions` exists on `@dnd-kit/core`'s
`DndContext` props (`node_modules/@dnd-kit/core/dist/components/DndContext/DndContext.d.ts:18`),
so `autoScroll={false}` type-checks.

## 0.10 — MAJOR: illegal media drops highlight as valid, then no-op — FIXED

**Confirmed exactly as diagnosed.** `useMediaDnd.ts`'s `handleDragOver`
called `readMediaDropPayload(event.dataTransfer)`, which calls
`dataTransfer.getData()` — the HTML DnD spec mandates this return `""`
during `dragover` ("protected mode"; only `dragstart`/`drop` can read real
data). So `payload` was always `null` during `dragover`, and
`canAcceptDrop(workspace, null, targetFolderId)` short-circuits to `true`
(`mediaDnd.ts:46`) — every folder (including the dragged folder itself, its
own parent, its own descendants) highlighted as a valid drop target, then
silently no-opped on drop (`commitDropPayload` re-checks `canAcceptDrop`
with the REAL payload, which is readable at `drop` time, and correctly
rejects — but nothing tells the user why).

**Mechanism of the fix (Option B from the plan — module-scoped drag-session
descriptor set on `dragstart`):**
- `src/admin/shared/media/utils/mediaDragDrop.ts` — added a module-scoped
  `activeDragPayload: MediaDropPayload | null`, plus
  `readActiveMediaDragPayload()` / `clearActiveMediaDragPayload()`.
  `writeMediaAssetDragData` / `writeMediaFolderDragData` (already called
  from every drag source's `onDragStart` — `MediaFolderPanel.tsx:201`,
  `MediaCanvas.tsx:205/213`) now ALSO set `activeDragPayload` alongside their
  existing `dataTransfer.setData()` call.
- `src/admin/shared/media/hooks/useMediaDnd.ts` — `handleDragOver` now reads
  `readActiveMediaDragPayload()` instead of `readMediaDropPayload(event.dataTransfer)`.
  `handleDrop` is UNCHANGED — it still uses the real `readMediaDropPayload`
  (getData is readable at `drop`), which remains the authoritative check at
  commit time.
- Cleanup: added a `document`-level `dragend` listener inside `useMediaDnd`
  (mounted via `useEffect`) that unconditionally calls
  `clearActiveMediaDragPayload()`. `dragend` fires on the drag source
  regardless of whether the drop succeeded, was rejected, or was cancelled
  (Escape / dropped outside any target) — the one event guaranteed to end
  every drag session — so this is robust without needing to touch every
  `onDragEnd` wiring across `MediaFolderPanel.tsx` / `MediaCanvas.tsx` /
  `MediaCanvasItems.tsx` individually.

**Why not the type-string option (Option A)?** Browsers lowercase
`dataTransfer` MIME type strings on `setData`/read-back (verified: this is
documented Chrome/Firefox behaviour), so embedding a case-sensitive folder
id directly in the type string is fragile if ids ever contain uppercase
characters. The module-scoped mirror has no such constraint and Media DnD
never crosses a document/iframe boundary (unlike the canvas), so same-module
state is safe here — explicitly one of the two workarounds the plan itself
offered.

**Tests written** — new file
`src/__tests__/media/mediaDragDrop.test.ts` (6 cases), using a
`ProtectedModeDataTransfer` test double whose `getData()` always returns
`""` (matching the real spec, unlike happy-dom's default `DataTransfer`
which does NOT enforce protected mode — this is exactly why the bug shipped
without a failing test):
1. `getData()` unreadable during dragover, `types` still readable.
2. `readActiveMediaDragPayload` recovers the real payload when `getData()`
   can't.
3. **Documents the bug's exact mechanism** — asserts
   `canAcceptDrop(target, readMediaDropPayload(dataTransfer), 'b')` (the OLD
   path) returns `true` for an illegal self-drop, then asserts the NEW path
   (`readActiveMediaDragPayload()`) returns `false` for the same drop.
4. A legal folder move still resolves `true` under the fix.
5. Asset drags mirror their payload the same way.
6. `clearActiveMediaDragPayload` resets the session.

**Result:** `bun test src/__tests__/media` → 34 pass / 0 fail (includes the
new file plus the pre-existing `mediaDnd.test.ts` and
`mediaWorkspaceFolders.test.tsx`, both still green — the pure
`canAcceptDrop`/`commitDropPayload` contract is untouched).

**Not done / out of scope:** did not add a toast for a rejected drop (audit
G17's "Fix" note mentions one). The 0.10 scope as given ("highlight as
valid, then no-op" → fix the highlight) is now closed on its own terms: an
illegal drop simply never highlights as a valid target in the first place,
so there's no silent-no-op moment left to toast about. If product wants an
explicit toast for the OS-file-drop / other-genuinely-rejected-at-drop-time
cases, that's a separate, additive UX decision — flag to `panel-designer` or
a follow-up if wanted.

## Doc drift — `docs/reference/canvas-dnd.md` — CONFIRMED FALSE, FIXED

Verified all three flagged claims directly against current source (not just
trusting the audit):
- `:11` "`@dnd-kit/core` is the only DnD library. No react-dnd, no native
  HTML5 drag-and-drop." — **FALSE.** Native HTML5 DnD is live in the Media
  workspace (`mediaDragDrop.ts`, `useMediaDnd.ts`) and canvas node-reorder
  uses raw pointer events, not dnd-kit at all.
- `:12` "The canvas's `<DndContext>` lives at `CanvasRoot.tsx`." — **FALSE.**
  `grep DndContext src/admin/pages/site/canvas/CanvasRoot.tsx` → zero matches.
  `CanvasRoot.tsx` mounts no `DndContext`.
- `:221` "The canvas's `NodeRenderer` registers each node as
  `useDraggable({ id: ... })`." — **FALSE.** `grep useDraggable
  NodeRenderer.tsx` → zero matches. Its only pointer hook is
  `onPointerDownCapture` at line 334 (selection, not drag).

Rewrote the doc (`docs/reference/canvas-dnd.md`) in the same change:
- New opening callout stating four incompatible mechanisms coexist, pointing
  at `STUDIO-FIGMA-PARITY-PLAN.md` Track D2 for the proposed unification
  (did NOT implement D2 — out of scope for this wave, explicitly flagged as
  a collision risk in my task brief).
- Rewrote the TL;DR to state the real per-surface mechanism for each of the
  four (canvas reorder = raw pointer + iframe relay; DOM panel / Site
  Explorer = real separate `@dnd-kit/core` contexts; module-picker/media-
  insertion = raw pointer, no `DndContext`; Media workspace = native HTML5
  DnD), and added the zoom-aware edge-band behavior from 0.8.
- Rewrote "The DnD topology" ASCII diagram to show all four mechanisms
  accurately instead of the fictional single shared `<DndContext>`.
- Rewrote `resolveCanvasDropTarget`'s documented signature to match the real
  one (`tree`/`draggedId`/`draggedIds`/`candidates`/`point`/`zoom`/
  `canHaveChildren`, not the old fictional `activePoint`/`frameGeometry`/
  `activeNodeId`/`moduleRegistry`), and documented the zoom-division
  requirement.
- Rewrote "DOM panel ⇄ canvas parity" — it previously claimed "The two
  surfaces share `<DndContext>` so a drag can start in one and end in the
  other," which is also false (confirmed: DOM panel's `<DndContext>` is
  local to `DomPanel.tsx`; canvas reorder has no `DndContext` at all). Now
  states plainly that cross-surface drag is not a supported gesture today.
- Rewrote "Mutation" to show the two REAL commit paths (canvas reorder
  commits on raw `pointerup`; DOM panel commits on real dnd-kit `onDragEnd`)
  instead of one fictional shared `onDragEnd`.
- Fixed the "Drop an existing node" cookbook entry (was the `:221` false
  claim) to describe the real gesture: select, then use the selection
  toolbar's hand-grab button.
- Fixed the "Board furniture" section's claim that "the tree-reorder system
  stays on dnd-kit" (false — it's raw pointer too).
- Rewrote "Forbidden patterns" — the old table literally banned what ships
  (native HTML5 DnD, assuming `@dnd-kit` "everywhere"). New table bans
  adding a NEW native-HTML5-DnD surface outside Media, documents the
  protected-mode `dragover` gotcha as a first-class forbidden pattern, and
  adds the zoom-division forbidden pattern from 0.8.
- Updated "Related" source-of-truth + gate-test lists to include
  `canvasDomGeometry.ts`, `canvasPointerRelay.ts`, the DOM panel files, the
  media DnD files, and the new/updated test files.
- Added a closing "Known remaining gaps, not yet fixed" line pointing at the
  audit doc for the defects this wave did NOT fix (cross-frame drag is a
  silent no-op, structural refusal is post-hoc, no keyboard path, multi-drag
  index math, grid/RTL axis inference) — so the doc doesn't silently imply
  those are solved either.

## Files touched (all under my owned paths)

- `src/admin/pages/site/canvas/canvasDnd.ts` — 0.8 fix (zoom-aware edge band)
- `src/admin/pages/site/canvas/canvasDomGeometry.ts` — 0.8 fix (`getViewportZoom` export)
- `src/admin/pages/site/canvas/useCanvasReorderDrag.ts` — 0.8 fix (thread zoom through)
- `src/admin/pages/site/canvas/canvasInsertionDrop.ts` — 0.8 fix (thread zoom through)
- `src/__tests__/canvas/canvasDnd.test.ts` — 0.8 regression tests (2 new cases)
- `src/admin/pages/site/panels/DomPanel/DomPanel.tsx` — 0.9 fix (`autoScroll={false}`)
- `src/admin/shared/media/utils/mediaDragDrop.ts` — 0.10 fix (session mirror)
- `src/admin/shared/media/hooks/useMediaDnd.ts` — 0.10 fix (read session mirror on dragover, clear on dragend)
- `src/__tests__/media/mediaDragDrop.test.ts` — NEW, 0.10 regression tests (6 cases, protected-mode DataTransfer double)
- `docs/reference/canvas-dnd.md` — doc drift fix (rewrite against reality)

## Verification run

```
bun test src/__tests__/canvas src/__tests__/dom-panel-dnd src/__tests__/dom-panel \
  src/__tests__/media src/__tests__/panels/domPanel.test.tsx src/__tests__/core/pageTreeDnd.test.ts
```
→ **697 pass / 0 fail / 1705 expect() calls** across 88 files. (Console noise
from `projectCssInjector.test.tsx` — pre-existing, unrelated to this change,
not in my owned files, tests still pass.)

Did **not** run `bun run build` or `bun run lint` per the task's explicit
instruction (concurrent siblings collide on `dist/`/`.tsbuildinfo`). All
edits are additive/optional-parameter changes (no signature became
required, no export removed) so I judge `tsc` risk low, but the orchestrator
should still run the full gate once after the wave lands.

## What the human must dogfood

Standing rule `standing-02` carve-out for canvas/geometry work — these are
computed-layout/gesture defects that need a real browser, not just unit
assertions on pure functions. Concretely:

1. **0.8 (zoom-scaled drop-edge hit zones).** Open any Studio project with a
   page that has a container with several sibling children (e.g. a
   list/gallery). At **25% zoom** (`Cmd/Ctrl -` a few times, or the zoom
   control), drag a node near the top or bottom edge of a sibling container
   and confirm the blue **before/after** line appears (not just the dashed
   "into" outline) when the cursor is genuinely near the edge — before this
   fix it almost never did at this zoom. Repeat at **100% zoom** (should
   feel unchanged from today) and at **400% zoom** (the before/after band
   should be a normal, tight strip near the edge — not ballooned to consume
   most of a small leaf node's body).
2. **0.9 (DOM panel double auto-scroll).** Open a page with a DOM/layer tree
   long enough to scroll (30+ rows). Start dragging a row near the TOP of
   the visible list toward the very top edge of the panel (within ~32px) so
   auto-scroll kicks in, hold there for 1-2 seconds, then move the pointer
   onto a row that has scrolled into view and release. Confirm the drop
   resolves (row moves) instead of silently doing nothing. Repeat near the
   BOTTOM edge. Before this fix, drops attempted right after an auto-scroll
   run frequently failed to resolve.
3. **0.10 (illegal media drops).** Open the Media workspace, expand the
   folder tree so a folder has at least one subfolder. Drag a folder onto
   ITSELF (or onto its own direct child) in the sidebar tree and confirm it
   does **NOT** highlight as a valid drop target (no blue/active ring) —
   before this fix it would light up as if it were a legal drop, then do
   nothing on release. Also confirm dragging a folder onto a genuinely
   different, legal destination folder still highlights and still moves it
   correctly (regression check that the fix didn't over-restrict).
