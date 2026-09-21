# Studio speed plan — the live canvas must feel instant

Owner decision, 2026-09-21: speed is non-negotiable. Every item below carries a
measured "today" number, a hard target, the exact cause with file references, and
a work order an agent can pick up. Measurements were taken on the `_scratch-undo`
copy of test4 through the headless browser on a healthy Tier 2 stack (after
`live-16`, PR #204, which stopped frame dev servers from dying on API restarts —
the single largest cause of "flicker every ten seconds" and "elements only appear
after a reload" before today).

## What the user feels, and what it measures as

| Interaction | Today | Cause (short) | Target |
|---|---|---|---|
| Type a number in the properties panel, live frame | **2.18 s** until the frame changes (save request fires at +2008 ms, takes 36 ms, HMR lands ~140 ms later; parent does no long task) | Fixed 2 s autosave debounce; no optimistic in-frame style op | **≤ 50 ms** visible, source written ≤ 300 ms after the last keystroke |
| Scrub a number (drag) in the panel, live frame | no feedback until the write lands | scrub preview goes only to the portal `NodeRenderer` | live preview at pointer rate |
| Click an element in a live frame | 17 ms warm, **235 ms cold** | cold: two documents per Tier 2 frame both running a selection overlay + forced-layout anchor measure per frame per selection | ≤ 30 ms warm, ≤ 100 ms cold |
| Press Delete on a node that gets refused | **393 ms** long task | refusal itself is O(1); the cost is a cold `RefusalDialog` mount inside the keydown task plus store fan-out | ≤ 50 ms to visible response |
| Move the mouse over a live frame | 1 cross-frame message + 1 unconditional store write per native pointermove (≈120/s) | no throttle in the runtime, no dedup in `hoverNode` | ≤ 1 store write per animation frame, none when the hovered node is unchanged |
| Drag a component over a live frame | **no drop line**, ghost freezes at the frame edge | parent `window` pointer listeners go silent inside a cross-origin iframe; the relay is portal-only; the resolver scans an empty scope | drop line at 60 fps inside live frames; asset cards draggable |
| Open a project | `/load` **1.05 s** for test4 | CSS registry rebuild per load, thumbnail, full page parse on cold cache | ≤ 300 ms warm |

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

## Sequencing

1. speed-01, speed-02, speed-03 together (one PR each, small): the per-action loop
   becomes instant.
2. speed-06 (drag and drop) and speed-04 (cold selection).
3. speed-05, speed-07, speed-08, speed-09.

Every PR adds its own budget in speed-08's slice; no item is done until the
number in the table moves to its target on the perf fixture.
