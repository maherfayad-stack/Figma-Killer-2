# Studio speed plan — the live canvas must feel instant

Owner decision, 2026-09-21: speed is non-negotiable. Every item below carries a
measured "today" number, a hard target, the exact cause with file references, and
a work order an agent can pick up. Measurements were taken on the `_scratch-undo`
copy of test4 through the headless browser on a healthy Tier 2 stack (after
`live-16`, PR #204, which stopped frame dev servers from dying on API restarts —
the single largest cause of "flicker every ten seconds" and "elements only appear
after a reload" before today).

## What the user feels, and what it measures as

| Interaction | Morning of 2026-09-21 | After wave 1 (measured on the running stack, same evening) | Target |
|---|---|---|---|
| Type a number in the properties panel, live frame | 2.18 s | **75 ms** visible (in-frame preview); source written at 44 ms (`speed-01` PR #207, `speed-02` PR #206) | ≤ 50 ms visible, write ≤ 300 ms |
| Scrub a number in the panel, live frame | no feedback until the write | previews through the same in-frame rule (`speed-01`) | live at pointer rate |
| Click an element in a live frame | 17 ms warm, 235 ms cold | 17 ms warm, **123–143 ms cold** across three fresh board loads (`speed-04` PR #213) | ≤ 30 warm, ≤ 100 cold |
| Press Delete on a refused node | 393 ms long task | dialog opened in a transition; 44–57 ms keydown→dialog on the perf fixture (`speed-05` PR #210) | ≤ 50 ms |
| Move the mouse over a live frame | 1 message + 1 store write per pointermove | **240 moves → 1 message**, no store write when unchanged (`speed-03` PR #208) | ≤ 1 write per frame |
| Drag a component over a live frame | no drop line, ghost froze at the edge; asset cards not draggable | asset cards drag; the box tracks inside the frame and shows before/after lines against real containers (`speed-06` PRs #212 + #214) | drop line at 60 fps |
| Click a design-system Button in a live frame | selected the page container | selects the Button (`live-17` PR #209) | — |
| Double-click text in a live frame | nothing | editable in 87 ms, Enter commits, written to source (`live-18` PR #211) | — |
| Open a project | `/load` 1.05 s | unchanged — `speed-07` not started | ≤ 300 ms warm |

## Work orders, in the order they should ship

### speed-01 — Optimistic style application in live frames (biggest perceived win)

**Cause.** `src/core/studio-runtime/optimisticDomOps.ts` implements insert, delete,
move and text, but no style. A properties-panel commit ends in
`setNodeInlineStyles` (`inspector/commitApi.ts:194-212`), an in-memory mutation
with no in-frame effect; the frame only changes when the file write reaches Vite.
The resize handle already previews in-frame through a stylesheet
(`studio-runtime/resizeHandles.ts`, `#studio-runtime-resize-preview`), which is
the mechanism to generalise.

**Change.**
- New wire message `optimistic.style { ref, patch }` in `messages.ts` (bounded:
  ≤ 64 properties, values ≤ 256 chars, property names validated against a CSS
  identifier pattern). Runtime applies it as a stylesheet rule keyed by the node's
  stamp (never `el.style`, so React reconciliation is untouched), reverts on
  `hmr:before`, and drops it on `hmr:after` (the real source now carries it).
- Class-target writes (`updateClassStyles`) get the same treatment: a temporary
  rule on the class selector inside the frame.
- `commitApi.ts` `writeToTarget` and `previewToTarget` broadcast to every bridge
  adapter for the node (`optimisticStructuralBroadcast.ts` pattern), so scrubbing
  previews live and the commit shows before the write.
- `FrameDocumentAdapter.optimistic.style` on both adapters; the portal adapter's is
  a no-op because the portal tree already re-renders from the store.

**Gate.** `runtime.test.ts` (apply / revert on `hmr:before` / drop on
`hmr:after` / bounds rejected), `BridgeFrameAdapter.test.ts`, a
`useBridgeSelectionChrome` case that the ring follows a previewed width, and an
e2e budget: panel edit → frame computed width changes within 50 ms.

### speed-02 — Autosave cadence for source-backed projects

**Cause.** `STUDIO_AUTOSAVE_DELAY_MS = 2_000` (`studio/fsCodemodAdapter.ts:188`)
with a 4× deferral cap (`hooks/usePersistence.ts:218-231`). The save is diff-based
and costs 36 ms; the two seconds are pure waiting.

**Change.** 250 ms trailing debounce, 1 s deferral cap, and an immediate flush on
blur/Enter of a panel field and on pointerup of a scrub. Keep one save per burst.
With speed-01 in place the wait is invisible anyway; this makes the file — and
therefore HMR and git — catch up within a third of a second.

**Gate.** `usePersistence` tests for the new cadence; e2e: panel edit → file on
disk changed within 400 ms.

### speed-03 — Hover and pointer traffic

**Cause.** `gestureForwarding.ts:106` forwards every native pointermove
(ancestor walk + rect + `postMessage`); `useBridgeFrameInteraction.ts:138` calls
`onNodeHover` on each, and `selectionSlice.ts:250` `hoverNode` is an unconditional
`set()` that fans out to every mounted selector (overlays × frames, panel sections,
layer rows).

**Change.** Runtime: coalesce `move` to one message per animation frame carrying
the last position, and skip when the resolved node and its rect are unchanged.
Parent: `hoverNode` returns early when id, breakpoint and frame are unchanged.

**Gate.** Runtime test: 100 synthetic moves in one frame → 1 message; store test:
same-id hover → no subscriber notification; e2e hover budget.

### speed-04 — Cold selection: one overlay per frame, one anchor measure per commit

**Cause.** `LiveBoardFrame.tsx:132-164` mounts a portal fallback `BreakpointFrame`
and the bridge `BreakpointFrame` together until ready; each runs its own
`BreakpointSelectionOverlay`, whose `tickOnce` does a `querySelector` plus
`createCanvasOverlayMeasureSession` (two forced `getBoundingClientRect` reads)
per frame per selection (`BreakpointSelectionOverlay.tsx:388-392, 513-533`).
Up to 8 live frames are pooled (`framePool.ts:24-25`).

**Change.** Do not mount a selection overlay for the hidden bridge frame until it
is ready, nor for the fallback once a poster exists. Cache the iframe and canvas
root rects per pan/zoom commit and `frame:resize`, not per selection. Measure only
frames that contain a selected or hovered node.

**Gate.** e2e budget: click → ring ≤ 100 ms cold on the 12-frame perf fixture.

### speed-05 — Refusals answer inside the keydown budget

**Cause.** `structuralSourceEdits.ts:615-625` opens a modal `RefusalDialog` for
five reasons; the first mount is the 393 ms.

**Change.** Preload the dialog module on idle after board mount; present the
refusal in a `startTransition` so the keydown task ends immediately; keep the
toast path for reasons with no actions. Record the wall time from keydown to the
dialog's first paint in the e2e budget slice.

### speed-06 — Drag and drop into live frames, with a drop line (`live-15`, extended)

**Cause.** `useIframeEventForwarding.ts:190` installs the pointer relay only for
portal adapters, so `useCanvasInsertionDrag`'s `window` listeners stop the instant
the cursor enters a live iframe; `measureCanvasDropCandidates`
(`canvasDomGeometry.ts:124`) falls back to the parent wrapper, finds no
`[data-node-id]`, and the resolver returns nothing to draw. Asset cards are
click-to-insert only (`AssetsPanel/AssetCard.tsx:42-57`). Even in portal frames the
resolver runs a full `querySelectorAll` plus one `getBoundingClientRect` per node on
every unthrottled pointermove.

**Change.** The three `live-15` pieces (asset-card drag start; bridge pointer relay
during a parent drag; a bounded `dropCandidates` request/reply with a per-drag
snapshot), plus: resolve at most once per animation frame, and take the candidate
rect snapshot once per drag (refreshed on `hmr:after`, `frame:resize`, scroll) for
portal frames as well.

**Gate.** Unit tests per piece; e2e: drag a card over a container inside a live
frame, the drop line is inside that container within one frame of the pointer.

### speed-07 — Project open

**Cause.** `/load` at 1.05 s: `loadStudioStyles` rebuilds the CSS registry per
call (`studioPageLoad.ts:76, 492`), thumbnail capture is queued, and the page parse
is mtime-cached but the CSS registry is not (scout could not confirm the
`pageParseCache.ts` boundary — verify first).

**Change.** Cache the CSS registry by stylesheet mtimes; return the first page
before the rest streams (`?stream=1` exists — make the board use it by default);
never block load on git or thumbnails.

**Gate.** server bench: warm `/load` ≤ 300 ms on test4-sized projects.

### speed-08 — Budgets that would have caught all of this

Nothing today measures click-to-ring, keydown-to-dialog, panel-edit-to-frame,
hover store writes, or load time. Add them to the e2e budget slice
(`studio-board-perf`, `studio-feel`) with the targets in the table, and make the
CI `e2e-budgets` job fail on regression. `standing-02` applies: happy-dom cannot
measure any of this.

### speed-09 — Frame pool and posters (`perf-06` Phase B)

Unify `frameMountPool.ts` and `liveFramePool.ts`, keep bridge frames alive across
page switches, and prefer posters over a second live document while booting.
Lower priority than the above because it improves cold cases, not the per-action
loop.

## Status after wave 1 (2026-09-21 evening)

Shipped and measured: speed-01, 02, 03, 04, 05, 06, plus `live-17` (component
instance selection) and `live-18` (inline text editing), all stacked on
`fix/live-frame-selection-chrome` (#203) and
`fix/live-dev-server-survives-api-restart` (#204) and integrated on
`tmp/speed-integration`, which the owner's running stack serves. Not started:
speed-07 (project open), speed-08 (CI budgets — partial: e2e budgets exist for
cold click and the refusal dialog), speed-09 (frame pool).

## Sequencing

1. speed-01, speed-02, speed-03 together (one PR each, small): the per-action loop
   becomes instant.
2. speed-06 (drag and drop) and speed-04 (cold selection).
3. speed-05, speed-07, speed-08, speed-09.

Every PR adds its own budget in speed-08's slice; no item is done until the
number in the table moves to its target on the perf fixture.
