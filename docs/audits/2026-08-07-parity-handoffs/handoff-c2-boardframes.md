# Track C2 handoff — `BoardFramesLayer` O(frames×pages) subscription

## The defect (confirmed before fixing)

`BoardFramesLayer.tsx` subscribed to the WHOLE `s.site?.pages` array:
`const pages = useEditorStore((s) => s.site?.pages ?? EMPTY_PAGES)`. Mutative
mints a new top-level `pages` array reference on ANY page edit anywhere in
the document (copy-on-write: even though sibling `Page` objects keep their
own references, the array that holds them is new), so this subscription
re-rendered the layer on every keystroke on every page — not just the pages
curated onto the active board. `resolveFramesWithPages.ts` then did a nested
`board.frames.map(frame => pages.find(p => p.id === frame.pageId))` on every
one of those unnecessary re-renders — O(frames × site.pages).

## C1's cache: reused as-is, not generalised, not duplicated

C1 (already landed, uncommitted, on disk before I started) added a
sweep-scoped `Map` memo in `store.ts` — `_canvasPageForCache` /
`lookupCanvasPageById(site, pageId)` — for `selectCanvasPageFor`'s own
O(pages) lookup. That function was module-private. I checked its shape
against what C2 needs (a per-`pageId`, sweep-scoped `Page | null` lookup,
invalidated on `site` identity change) and it is EXACTLY what
`BoardFramesLayer` needs too — not a superficially similar shape that would
need adapting, the literal same lookup. So I did not build a fourth memo: I
added `export` to `lookupCanvasPageById` and call it directly from
`BoardFramesLayer`'s new selector. This means a board frame's lookup and
`NodeRenderer`'s two-per-node lookups for that same page now hit the SAME
`Map` slot within one sweep — genuine cache sharing, not just shape reuse.
I did not rename it or move it to a new "primitive" module: it already lives
in the one file (`store.ts`) that owns Zustand selector-level memoization
conventions for this store, and only two call sites exist. If a THIRD
caller shows up later, that's the trigger to extract it into its own module
— not before.

`store.ts` diff (my delta only — C1's own addition is not mine, already on
disk): `export function lookupCanvasPageById(...)` (was unexported), plus a
short doc paragraph noting C2 as the second caller.

## The fix

1. **`resolveFramesWithPages.ts`** — signature changed from
   `(board: Board, pages: readonly Page[])` doing an O(frames) `.find()` per
   frame, to `(frames: readonly BoardFrame[], pages: readonly (Page | null)[])`
   doing a plain O(1)-per-index zip (`pages[i]` matches `frames[i]` by
   construction — no `.find()` at all). The O(pages) lookup is now entirely
   the caller's responsibility, done once via the shared cache.

2. **`BoardFramesLayer.tsx`** — replaced the whole-array `pages` subscription
   with a `useShallow`-wrapped selector:
   ```ts
   const relevantPages = useEditorStore(
     useShallow((s) => {
       const activeBoard = selectActiveBoard(s)
       const site = s.site
       if (!activeBoard || !site) return EMPTY_PAGES
       return activeBoard.frames.map((frame) => lookupCanvasPageById(site, frame.pageId))
     }),
   )
   ```
   This returns an array of the ACTUAL `Page` object references (not fresh
   wrapper objects — `useShallow` only helps if the elements themselves are
   stable, so I deliberately kept this as a flat `(Page | null)[]` parallel
   to `board.frames`, zipped into `{frame, page}` pairs afterward in the
   render body via `resolveFramesWithPages`, rather than building
   `{frame, page}` objects INSIDE the selector where `useShallow`'s
   elementwise `Object.is` check would see a fresh object every call and
   never short-circuit). Identity survives a keystroke on any page not
   referenced by this board's frames; it changes exactly when a frame's own
   page content changed, or the frame list itself changed.

3. **`EMPTY_PAGES`** — retyped from `Page[]` to `(Page | null)[]` (frozen
   module-level constant, satisfies `selectorStability.test.ts`'s ban on
   inline `?? []` fallbacks — unchanged convention, just a widened type for
   the new selector's return shape).

## Module-size gate forced a genuine split, not just comment-trimming

Editing `BoardFramesLayer.tsx` in place pushed it to 714 lines — over the
700-line `module-size-budgets` ceiling (it wasn't grandfathered). Comment
trimming alone only got it to 706. Per that gate's own stated intent
("adding lines forces you to extract first") and CLAUDE.md's default
disposition toward the cleaner multi-file split, I extracted the entire
`BoardFrameView` component (header/drag/resize/rename/context-menu/body —
previously ~370 lines bolted onto the bottom of the file) into its own
module, **`BoardFrameView.tsx`** (new file, same folder), with zero
behavior change — every prop, hook, and JSX node moved verbatim. Also moved
`buildStudioBreakpoint`/`STUDIO_BREAKPOINT_BASE`/`RESIZE_HANDLES`, which were
only ever used inside `BoardFrameView`, into the new file with it.

Result: `BoardFramesLayer.tsx` 694 → 286 lines (now just board-level
concerns: frame membership, virtualization sizing, marquee, multi-selection
bounding box). `BoardFrameView.tsx` — new, 444 lines. `store.ts` 373 → 378.
`resolveFramesWithPages.ts` 19 → 29. All comfortably under 700;
`module-size-budgets.test.ts` passes.

**Scope note for the DnD-unification sibling working across `canvas/`:** my
work order named only `BoardFramesLayer.tsx` / `resolveFramesWithPages.ts`
as mine to touch; the split forced a new file in the same folder
(`BoardFrameView.tsx`). No other file under `canvas/` was touched. If this
collides with in-flight DnD work on board-frame dragging, the pointer-capture
drag/resize handlers that used to live in `BoardFramesLayer.tsx` now live in
`BoardFrameView.tsx` — same code, verbatim, new file.

## A gate that broke as a direct consequence, and how I fixed it (not worked around)

`src/__tests__/canvas/overlayRafDiscipline.test.ts` — `'Board object drags
stay off the overlay RAF loop'` statically greps
`'canvas/BoardFramesLayer/BoardFramesLayer.tsx'` for `setPointerCapture`
(asserting board-frame drag doesn't use `requestAnimationFrame`). Since the
drag/resize pointer-capture code moved to `BoardFrameView.tsx` verbatim, the
assertion now needs to point at the file that actually contains it. Updated
the `boardDragFiles` list entry from `BoardFramesLayer.tsx` to
`BoardFrameView.tsx` with a comment explaining the extraction. Verified this
test file is NOT in my excluded list (`src/__tests__/architecture/**` and
`src/__tests__/site-explorer/**` are excluded; `src/__tests__/canvas/**` is
not) — in scope for me to fix since I caused the drift.

## Measured before/after (Profiler-instrumented, both directions proven)

New test: `src/__tests__/canvas/boardFramesLayerRenderScope.test.tsx`.
Mounts `BoardFramesLayer` directly (Profiler-wrapped — Bun's test runtime
does not run the app's Vite/Babel React Compiler transform, so a re-render
of the component only happens if one of ITS OWN zustand subscriptions fired;
no confound from independently-re-rendering descendants). Board curates 2 of
3 site pages (`page-a` active, `page-b` non-active-but-on-board,
`page-off-board` not on the board at all).

| Step | Pre-fix (measured, scoped stash) | Post-fix (measured) |
|---|---|---|
| Mount | renderCount = 1 | renderCount = 1 |
| Edit `page-off-board` (off-board, `activePageId` untouched) | **2** (spurious re-render) | **1** (unchanged — the exact regression this file exists to catch) |
| Edit `page-b` (on-board, NOT active) | n/a (already failed above) | **2** (correctly re-renders — proves the fix didn't over-narrow) |
| Real `updateNodeProps` on `page-a` (on-board, active) | n/a | **3** (real store-action end-to-end path still works) |

**Proof method, both directions, per the task's requirement:** ran the new
test against a scoped stash of only the fix files (`BoardFramesLayer.tsx`,
`resolveFramesWithPages.ts`, `store.ts`, and — since it's an untracked new
file, moved aside rather than stashed — `BoardFrameView.tsx`), confirmed
`FAIL: Expected 1, Received 2` at the off-board-edit assertion (i.e. the bug
reproduces), then restored all four files and confirmed the test passes.
Also independently re-ran the FULL relevant suite (`canvas` + `store` +
`editor-store` + 5 architecture files) against that same scoped pre-fix
baseline to distinguish pre-existing flakiness from anything I introduced —
see below.

The middle case (`page-b`, on-board but not active) is the most surgical
proof of the C2 fix specifically: it can't be explained by any OTHER
existing subscription (`activePageId` didn't change, no store action ran) —
only `relevantPages`'s `useShallow` output changing because `page-b`'s own
object reference changed. This directly matches the plan's stated budget:
"≤ 1 re-render per visible frame, not per mounted frame" — an edit to a
frame's OWN page always flows through; an edit to any other page never does.

## Verification run

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json     # clean, zero errors
./node_modules/.bin/eslint <every file below>          # clean, zero warnings/errors

bun test src/__tests__/canvas src/__tests__/store src/__tests__/editor-store \
  src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts \
  src/__tests__/architecture/module-size-budgets.test.ts \
  src/__tests__/architecture/canvas-aware-selectors.test.ts \
  src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts \
  src/__tests__/architecture/centralized-site-mutation-history.test.ts
# => 1033 pass / 4 fail (all 4 confirmed pre-existing — see below)
```

The 4 remaining failures, each independently reproduced against the SAME
scoped pre-fix baseline (i.e. present with or without my change):
- `boardFrameVariantSelection.test.tsx` — both `'selection does not leak
  between two board frames...'` cases. Pass 100% of the time standalone
  (`bun test src/__tests__/canvas/boardFrameVariantSelection.test.tsx` → 2/2
  pass); fail only in certain large multi-file combined runs — a pre-existing
  cross-file store-singleton test-isolation flake, not something my diff
  touches (confirmed: `git diff --stat` shows I never touched this file, and
  the same failure reproduces against the stashed pre-fix baseline run
  through the identical combined command).
- `selectionToolbar.test.tsx` — `'moves a multi-selection as one ordered
  batch...'` — an ordering assertion unrelated to board frames; reproduces
  identically pre-fix.
- `selectorStability.test.ts` — flags `PropertiesPanel/InstanceCallSiteView.tsx:115`,
  a file I never touched (confirmed via `git diff --stat`) — a pre-existing
  violation from a sibling's in-flight work, already flagged as such in C1's
  own handoff.

## Files touched

- `src/admin/pages/site/canvas/BoardFramesLayer/BoardFramesLayer.tsx` —
  narrowed subscription (`relevantPages` via `useShallow` + shared cache),
  extracted `BoardFrameView` out. 694 → 286 lines.
- New: `src/admin/pages/site/canvas/BoardFramesLayer/BoardFrameView.tsx` —
  verbatim extraction, zero behavior change. 444 lines.
- `src/admin/pages/site/canvas/BoardFramesLayer/resolveFramesWithPages.ts` —
  signature changed to a pure O(1)-per-index zip over parallel arrays,
  no more `.find()`.
- `src/admin/pages/site/store/store.ts` — exported `lookupCanvasPageById`
  (was module-private under C1), added a doc paragraph noting the second
  caller. Did not touch `_canvasPageForCache`'s own logic.
- `src/__tests__/canvas/overlayRafDiscipline.test.ts` — updated the
  board-drag-file gate list to point at `BoardFrameView.tsx` (where the
  pointer-capture drag/resize code now actually lives) instead of
  `BoardFramesLayer.tsx`.
- New: `src/__tests__/canvas/boardFramesLayerRenderScope.test.tsx` — the
  Profiler-based regression gate (both directions), proven to fail pre-fix
  and pass post-fix via scoped stash/restore.

Working tree only — nothing committed, staged, or pushed, per the absolute
constraints. `STATE.md` not touched.

## For the human to dogfood (per `standing-02` — no new browser infra built)

Open a Studio project with a board that curates a SUBSET of the project's
pages (not all of them). With the board view open, edit text on a page that
is NOT one of this board's frames (e.g. via the Explorer → open that other
page in a single-page CMS-style view, or via an agent edit) while the board
tab stays visually open in another area — confirm the board's frames do not
visibly flicker/reflow, and that editing a page that IS shown as a frame on
the board still updates that frame's canvas content live. This exercises the
exact real-world "keystroke anywhere on a big multi-page project" scenario
the fix targets; my automated test proves the mechanism (render counts) but
not perceived frame-rate on a real 40-page project.
