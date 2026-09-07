# STATE

Shared memory for every agent working on this repo. **Read before working, write
before stopping.** Format and rules: [`docs/agent-refs/handoff-protocol.md`](docs/agent-refs/handoff-protocol.md).

Entry ids are `<area>-<nn>`. Areas in use: `parser`, `canvas`, `store`, `panel`,
`server`, `mcp`, `perf`, `sec`, `test`, `docs`, `meta`, `style`, `asset`, `struct`.

Landed entries older than the newest ~10 live in
[`docs/state-archive/2026-Q3.md`](docs/state-archive/2026-Q3.md), verbatim. The
Archive section at the bottom of this file indexes them.

---

## Now

**M1 — "It opens" is complete.** Every WS-1.x/WS-8.x work order for M1 has
landed: WS-1.1/1.2/1.4/8.1/8.2 (`meta-04`) and WS-1.3 (`server-04`, below).
M2 is now in progress: WS-2.1/WS-2.2 (styles) landed, see `style-01` below.
WS-2.3 (package CSS injection) and WS-2.4 (computed-`className` variant probe)
are the remaining WS-2 items, not yet dispatched. See
`STUDIO-IMPORT-V2-PLAN.md`'s workstreams 2–9 for other M2 candidates.

### store-09 — ⌘Z now undoes a frame drag and a sticky-note move: one stack, two domains
- **Agent:** store-engineer · **Stage:** done (targeted store tests + full `src/__tests__/editor-store` + `src/__tests__/architecture` + `tsc -p tsconfig.app.json` + eslint green; draft PR open) — **needs human dogfood**
- **Branch:** `feat/board-state-undo` off `origin/main` (`7d9a8de`, i.e. after `store-07`/#77 and `store-08`/#79). User report, verbatim: "when moving sticky notes, and elements in the canvas and click ctrl + z it doesn't get back to that position", against the standing rule "it should work on every action".

**This is `store-08`'s own named cut, closed.** Its handoff said, verbatim: *"Board state is not undoable at all — frame move/resize, board CRUD, guides, annotations, `prototypeSlice` links… That is a second history domain, not a patch; audited and named, not attempted."* It is now attempted, and it is a second domain **on the same stack** — because there is only one ⌘Z, and the user does not know that a sticky note and a padding value are stored in different files.

**Design — SNAPSHOT PAIRS, not patches, and that is the load-bearing choice.** `HistoryEntry` grows an optional `board: { before, after }` where each end is `{ boards: BoardsFile; activeBoardId: string | null }`. Every board mutation is already a pure `Board -> Board` transform republished through `upsertBoard`, so `boards` is a persistent immutable structure and a "snapshot" is TWO OBJECT REFERENCES sharing everything the mutation did not touch. O(1) to store, O(1) to restore, and — unlike a patch path into `boards.boards[0].frames[2].x` — nothing to go stale when a board or frame index shifts. Exactness rests on undo being strictly LIFO: the stack is only read from the top, so at undo time the live state IS the entry's `after`.

**Slices touched:** `board` (`boardSlice.ts`, `boardAnnotationSliceActions.ts`, `boardBulkFrameSliceActions.ts`, `boardFrameSelectionActions.ts`, + new `boardFrameSliceActions.ts`, + new `boardHistory.ts`) and `site` (`types.ts`, `undoRedoActions.ts`, `lifecycleActions.ts`, `helpers.ts`, + new `historyStack.ts`). **No new selector** — nothing here reads state in a render path; `restoreBoardSnapshot` prunes a dangling annotation selection inside the same `set`.

**New mutations, with their coalesce keys and history behaviour.** All go through ONE funnel, `commitBoardChange(set, get, coalesceKey, nextBoards, extras)` — the board-domain counterpart to `runHistoricMutation`. It applies the mutation AND records the entry in a single `set`; `extras.also` writes editor-local fields (selection, clipboard, `frameDefaults`) live but UNRECORDED, exactly the rule `runHistoricMutation` applies to editor fields a site recipe touches.

| Action | Coalesce key | Entry |
|---|---|---|
| `setFramePosition` | `board:frame-move:<frameId>` | one per drag |
| `setFrameRect` | `board:frame-rect:<frameId>` | one per resize drag |
| `nudgeSelectedFrames` | `board:frame-nudge` | one per key-HOLD |
| `moveNote` / `moveDoc` | `board:annotation-move:<kind>:<id>` | one per drag |
| `resizeAnnotation` | `board:annotation-resize:<kind>:<id>` | one per drag |
| `nudgeSelectedAnnotations` | `board:annotation-nudge` | one per key-HOLD |
| `updateNoteText` | `board:note-text:<noteId>` | one per editing SESSION |
| `updateDocHtml` | `board:doc-html:<docId>` | one per editing SESSION |
| `moveGuide` | `board:guide-move:<guideId>` | one per drag |
| `setFrameSize`, `addFrame`, `removeFrame`, `removeFrameById`, `setFrameAxes`, `duplicateFrameAsVariant`, `addBoard`, `renameBoard`, `removeBoard`, `addGuide`, `removeGuide`, `clearGuides`, all annotation add/delete/recolor/duplicate/paste/reorder, all six bulk frame actions | `null` | one each |

**Why a coalesce key alone was not enough.** A frame drag calls `setFramePosition` on EVERY `pointermove` (that position is real board state the snap guides, the peer-rect collection and the autosave read, so it cannot be deferred to pointer-up), and nothing in the stack ever ended the burst — so two consecutive drags of the same frame would have folded into one entry and ⌘Z would have jumped the frame back past a position the user deliberately stopped at. New store action `endBoardGesture()` (nulls `_historyCoalesceKey`, no-op when no burst is open) is called from the pointer-up of every board drag (`BoardFrameView` move + resize, `useAnnotationInteraction` move + resize, `RulerGuidesLayer`), from `keyup` in both nudge hooks, and from the end of a sticky-note / doc-card editing session.

**Persistence.** Board state is Studio's own state on disk, never the user's `.tsx`, so undo is plain replay + re-persist. `restoreBoardSnapshot` re-raises `boardsDirty` (the signal `AdminCanvasLayout`'s 800ms autosave watches) AND re-raises `boardsPendingExplicitRemoval` when the restore shrinks the frame set — without that, undoing an "add frame" would be refused by `boardsSaveGuard.ts` and never reach disk.

**Reload boundaries get OPPOSITE answers, deliberately:**
- A **site** reload/patch that fails `historySurvivesReload` now calls `retainBoardOnlyEntries` instead of `= []`. A `.tsx` reparse says nothing about `.studio/boards.json`. `historyNodeIdRemap`'s `remapHistoryEntries` needed no change — it spreads the entry and a board entry has no patch paths and no `structural` tag, so it returns the same reference untouched (verified by test, per the task's ask).
- A **boards** READ (`loadBoards`, `markBoardsLoadFailed`) calls `dropBoardHistory`. A snapshot references the object graph the store held at the time; once the server hands back a different graph, replay would resurrect a whole boards file rather than undo a gesture. Entries that also carry site patches keep those and lose only their board half.

**Refactors done in the same change (not optional cleanup — the design needed them):**
- `commitHistory` + `foldIntoCoalescedEntry` moved out of `helpers.ts`'s closure into module-level `site/historyStack.ts` as `commitHistoryEntry`. Two domains now push onto the stack; duplicating the push/evict/coalesce logic would have been the "two ways to do one thing" the rule book forbids.
- Frame mutation wiring extracted from `boardSlice.ts` to `boardFrameSliceActions.ts` (689 → 578 lines), the same module-size split its three siblings already use. Without it `boardSlice.ts` sat at 696/700 with zero headroom.

**Named cuts (still NOT undoable, deliberately):**
- **`prototypeSlice` links** (add/remove/edit). Unlike board state, every link op is a SERVER round trip (`applyPrototypeOp` → `adoptPrototype` in `prototypeActions.ts`) — undo has to re-issue an async write and handle its failure, which is `structuralHistory.ts`'s shape, not `boardHistory.ts`'s. Real work, its own PR.
- **`seedFramesForActiveBoard`.** The one-time default-board hydration, not a gesture. Recording it would put an undo entry on the stack before the user has touched anything.
- Board/annotation SELECTION, `setActiveBoard` on its own, snap guides, `frameDefaults` — editor-local, same rule as node selection. (Undo does PRUNE an annotation selection pointing at something the restore removed.)
- No browser dogfood (agents don't drive the browser here).

**Test/comment updated in the same change:** `inlineEditSlice.test.ts` — (a) its "a frame with NO locale override" case mutated the loaded `Board` in place, which `loadBoards` now freezes (it became a Mutative recipe so it can purge board history); it builds a fresh board instead. (b) Its comment justifying the localized-preview undo exemption cited "`boardSlice.ts`'s frame drags are the same 'real edit, no undo entry' precedent" — that precedent is gone, so the comment now states the exemption's own merits (a per-frame PREVIEW overlay, `applyInlineEditValue` writes `localizedPages` only).

**Dogfood checklist for the human** (at `/admin/site`, on a real project):
1. Drag a frame by its header to a new spot, ⌘Z once — it must return to exactly where the drag started, in ONE step. ⇧⌘Z puts it back.
2. Drag the SAME frame twice. Two ⌘Z presses = two distinct positions, not one jump to the origin.
3. Drag a sticky note, ⌘Z. Same for a doc card, and for a card RESIZE handle.
4. Move a frame, wait ~1s for the autosave, then ⌘Z and wait again — reload the page. The undone position must have PERSISTED (this is the `boardsDirty` re-raise).
5. Add a frame to the board, ⌘Z, wait for the autosave, reload. The frame must stay gone (this is the `boardsPendingExplicitRemoval` re-raise; without it the save guard silently refuses).
6. Edit a style value, then drag a frame, then ⌘Z twice — frame first, style second.
7. Type in a sticky note and press ⌘Z mid-typing — that is NATIVE text undo (`pendingTextEdit.ts`, `store-07`), the board must not move. Click out, THEN ⌘Z — now the note's text reverts.
8. Arrow-nudge a selected frame with the key held down, release, ⌘Z once — the whole hold reverts as one step.

**Landmines:**
- **The whole-file snapshot is only exact because undo is LIFO and every board write goes through `commitBoardChange`.** A new board mutation that writes `state.boards` directly with a plain `set` will be silently skipped over by an undo of an EARLIER entry (the restore assigns a `before` that predates it). If you add a board action, route it through `commitBoardChange` or purge history the way `loadBoards` does. There is no gate test for this yet — that is the obvious follow-up.
- `endBoardGesture` is called from SIX UI sites. A new board drag gesture that forgets it will silently merge with the next drag of the same entity.
- `loadBoards` is now a Mutative recipe, so `boards` is frozen after a load. Any test that mutated a loaded `Board` in place will throw `Attempted to assign to readonly property`.
### capture-modules — the PNG export drew every design-system component as `Unknown module: alm.Button`; the editor and the capture page kept two module lists
- **Agent:** canvas-engineer · **Stage:** done (targeted tests + `tsc -p tsconfig.app.json --noEmit` + eslint green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/capture-registers-package-modules` off `origin/main` (`7d9a8de`). User report: exporting a page as PNG (inspector Export section) produced an image where every design-system component was the dashed "Unknown module: alm.Button" placeholder while text/images/icons rendered fine — and the SAME page rendered its buttons correctly on the editor canvas.

**Root cause is not the renderer. It is the module SET.** `NodeRenderer` resolves every node through the GLOBAL module registry (`registry.get(node.moduleId)`), so any surface that renders a page is only as faithful as what was registered before it painted. `/admin/agent-capture` is a **second Vite HTML entry** (`agent-capture.html` → `src/admin/agentCapture/main.tsx`) and therefore inherits none of the editor's imports. It listed `@modules/base` and stopped. The editor's `AdminCanvasEditorBody.tsx` listed `@modules/base` + `@modules/alm/register` + `@core/loops/sources` AND mounted `useRegisterProjectModules()`. Two independently maintained lists; one was short. PR #80's investigation named the `pkg.*` half; the user's actual screenshot was the `alm.*` half, which was a plain missing import.

**The fix — one entry, used by both.** New `src/admin/pages/site/studio/canvasModuleSet.ts` is now the only definition of "which modules must be registered before a Studio page renders":
- built-in packs as **import side effects** (`@modules/base` — which pulls in `@modules/studio/slot` — plus `@modules/alm/register` and `@core/loops/sources`), so there is no "forgot to call it" state;
- `mountCanvasModuleSet(dir)` for the project's own `pkg.*` components, and `useRegisterProjectModules()` (moved here out of `registerProjectModules.ts`) for the editor, which drives the same call off `adminUi.studioProject.dir` + the trust-tier external store.

`AdminCanvasEditorBody.tsx` dropped its three side-effect imports and now gets them via this file. `agentCapture/main.tsx` imports this file instead of `@modules/base`; `CaptureApp` calls `mountCanvasModuleSet(payload.dir)` once the payload lands.

**Trust tier: the gate stayed on the SERVER, deliberately.** `componentBundle.ts` refuses at Tier 0 (`trust-tier-required`) *before* parsing or bundling anything, so neither surface re-implements the check and neither can get it wrong. The capture's client-side trust store defaults to `'static'`, which is exactly what `PackageComponentPlaceholder` needs to draw the Tier-0 placeholder the editor draws. Nothing of the user's executes at Tier 0 on either path.

**A capture is photographed ONCE, so registration became a settle phase.** An editor frame re-renders through `registry.subscribe` (`NodeRenderer.tsx`) whenever a module lands, however late; a capture frame has one shutter. `canvasCaptureSettle.ts` gained a `modules` phase that runs FIRST, bounded by `MODULE_REGISTRATION_BUDGET_MS` (10 s, inside the 20 s outer deadline), degrading — like images and fonts — to a **named warning on a good capture**, never a refusal: *"This project's package components had not finished registering after Nms; any design-system component on this screen was captured as a placeholder."* `CaptureFrame` takes the promise as a prop and passes it into `settleCaptureDocument`.

**`agent-capture.html` gained a React-only import map.** A component bundle is built with `react`/`react-dom`/both JSX runtimes EXTERNAL (`componentBundle.ts`'s `EXTERNAL_SPECIFIERS`), so `import(bundleUrl)` on a page with no import map throws on a bare specifier and every `pkg.*` component photographs as a placeholder regardless of registration. The four entries point at `public/runtime/*.js`, which re-export the page's own React off `globalThis.__studio` — one React instance, so hooks work. index.html's `@studio/*` entries are deliberately NOT copied: plugin canvas module packs are still never loaded on this page.

**Other headless consumers — checked, all covered.** `AgentSnapshotFrame.tsx` and `studioExportFrames.ts` run inside the LIVE editor (live-bridge path), so the editor already registered everything: fixed for free, no change. `server/handlers/studio/projectThumbnail.ts` (#58) and share snapshots go through `captureFrames` → `withSettledCapture` → the same `/admin/agent-capture` page: fixed for free. `src/admin/shareViewer/` renders stored images, not the canvas — not affected.

**Canvas files touched:** `src/admin/pages/site/studio/canvasModuleSet.ts` (new), `src/admin/pages/site/studio/registerProjectModules.ts` (hook → `registerProjectPackageModules(dir)` + `projectPackageModulesSettled()`), `src/admin/pages/site/canvas/canvasCaptureSettle.ts` (`modules` phase + `MODULE_REGISTRATION_BUDGET_MS`), `src/admin/agentCapture/CaptureApp.tsx`, `src/admin/agentCapture/CaptureFrame.tsx`, `src/admin/agentCapture/main.tsx`, `src/admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx`, `agent-capture.html`, `src/__tests__/canvas/captureCanvasModuleSet.test.tsx` (new), `src/admin/pages/site/canvas/__tests__/canvasCaptureSettle.test.ts` (+3 cases), `docs/features/mcp-connectors.md`, `docs/agent-refs/canvas-internals.md`, `docs/agent-refs/path-index.md`.

**Landmines (height ⇄ injectors ⇄ events — plus a fourth that now joins them):**
- **Module registration is a fourth actor in the settle machine, and it runs BEFORE the others on purpose.** A frame whose components are unregistered goes DOM-quiet around its placeholders and would be declared settled — the quiet phase cannot tell "finished" from "finished rendering the wrong thing". Anything added to the settle loop that can change the DOM asynchronously has the same property; put it ahead of `dom-quiet`, not after.
- **The `modules` phase takes `Math.min(MODULE_REGISTRATION_BUDGET_MS, remainingMs(deadline))`.** With a small outer `timeoutMs` it can consume the whole deadline and the report then carries BOTH the module warning and `stalledPhase: 'dom-quiet'`. That is honest, and it is why `canvasCaptureSettle.test.ts`'s never-arrives case asserts the warning rather than `settled: true`. Do not "fix" it by letting the phase overrun the deadline.
- **Never re-declare a module pack outside `canvasModuleSet.ts`.** A second list is invisible to every gate except `captureCanvasModuleSet.test.tsx`, and it fails as a *rendered placeholder in an exported image* — which downstream visual-audit tooling (`studio_compare`, `studio_diff_frames`, thumbnails) treats as evidence of a design problem rather than a tooling one.
- **`agent-capture.html`'s import map is load-bearing for `pkg.*` and must stay React-only.** Adding `@studio/*` there would make plugin bundles resolvable inside a capture, which the entry exists to prevent.
- The trust check lives in `componentBundle.ts`, not in either client. If you ever add a client-side tier gate, the capture page's tier is `'static'` by default (it hydrates the store directly, not through `fsCodemodAdapter.loadSite`) and you will silently disable package rendering for every capture of a Tier-1 project.

**Cut, named:** the capture payload does NOT carry the project's trust tier. At Tier 0 the capture already renders the editor's exact Tier-0 placeholder (the client store defaults to `'static'`). The one remaining divergence is cosmetic and only inside a placeholder: a **Tier-1** project whose bundle was REFUSED (e.g. `react-version-mismatch`) shows the editor the server's refusal message but shows the capture "promote this project". Adding `trust` to `AgentCapturePayloadSchema` would need a third copy of the 3-literal `TrustTier` union in `@core/studio-capture`; worth doing when that union gets a shared home.

**Dogfood (human):** open `/admin/site` on the eSIM project at 100% zoom with the board showing at least 3 frames. Select the `Onboarding` frame → Properties panel → **Export** → PNG. The exported image must show real design-system buttons, identical to what the canvas shows behind the dialog — zero dashed "Unknown module" boxes and zero "needs this project promoted" placeholders (that project is Tier 1). Then set the project back to Tier 0 (`.studio/meta.json` `"trust": "static"`), reload, and export the same frame: the PNG must now show the SAME promote placeholder the canvas shows — not a component, and not a blank. Third check: project thumbnails on `/admin/dashboard` (#58) should render components too, since they ride the same page.

### proto-back — the prototype link and the component's own click: you got one or the other, never both, and never on the first press
- **Agent:** canvas-engineer · **Stage:** done (targeted canvas tests + `tsc -p tsconfig.app.json` + eslint + architecture gates green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/prototype-back-first-click` off `origin/main` (`c068b3d`). User report, verbatim: "in the prototype, and also in live mode the back interaction (when wiring prototype) doesn't work on first click for some reason and gets interrupted by the hover, click effects of the component — it should have both".

**Two root causes, both in the canvas event layer. The stack machine and the link resolver are clean** — `applyPlayAction`, `linkForClick`, `resolvedLinkSourceIds` and `playNavigation.ts` all do the right thing on the first call; a repro that drives `back` straight through `followPrototypeLinkAt` pops the stack on click #1. The failure is upstream, in which events ever reach them.

**RC1 — the component's own `onClick` never ran, anywhere.** `NodeRenderer.tsx`'s `onClickCapture` called `e.stopPropagation()` unconditionally. A design-system / package component's editor bag goes on a `display: contents` HOST (`src/modules/alm/register.tsx:582`, `src/admin/pages/site/studio/registerProjectModules.ts:316`) and the component's own `<button>` is a DESCENDANT of it — so the canvas swallowed the click in the capture phase, above the component, and the authored handler was never dispatched. Proven with a test before any fix: `componentClicks === 0`. That is the "it should have both" half, and it was true in live mode and in play mode alike.

**RC2 — the player waited for a `click` that a re-rendering component prevents the browser from dispatching.** A `click` is dispatched at the nearest common ancestor of the mousedown and mouseup targets. When the mousedown target has LEFT the document by the time the button comes up there is no common ancestor and **no click is dispatched at all**. A component whose hover/press effect re-renders under the finger does exactly that on the FIRST press — the pointer arrives, `mouseenter`/`:hover` state swaps the element, the click never happens — and has settled by the second press. From the outside that is precisely "doesn't work on first click ... gets interrupted by the hover, click effects of the component".

**The fix.**
- The player now reads the **press/release pair on the node**, not the click. `onPointerDownCapture` latches the innermost node under the pointer; `onPointerUpCapture` over that same node follows the link. The node's host element is rendered by `NodeRenderer` and survives whatever the component does to its own DOM. A `click` that does arrive is swallowed by the same latch (`PlayGesture` in `useCanvasNodeInteraction.ts`), so one press is one navigation — including when the click is reported against an ANCESTOR node, which would otherwise have followed a second, wrong link.
- **A live frame no longer stops propagation.** `ownsAuthoredEvents` (`interaction !== 'live'`) gates the `stopPropagation()`; `preventDefault()` stays in both, because an authored `<a href>` must not navigate the frame away. Design frames are unchanged.
- New `canvas/canvasNodeGestureLatch.ts` holds the two module-level latches that collapse `pointerdown` → compatibility `mousedown` → `click` into ONE activation (the pre-existing suppressed-control latch moved here, plus the new activated-click one). Extracted because `NodeRenderer.tsx` was at 702 lines against the 700 ceiling; it is now 674.
- The editor **hover ring stands down while the player is armed** (`useCanvasNodeInteraction.onNodeHover` returns early; `setPlayMode(true)` clears `hoveredNodeId`/`hoveredBreakpointId`/`hoveredFrameId`). It is editing chrome, and it was writing to the store on every pointer arrival mid-playback.

**Canvas files touched:** `canvas/NodeRenderer.tsx`, `canvas/useCanvasNodeInteraction.ts`, `canvas/CanvasContexts.ts` (two new context callbacks), `canvas/canvasNodeGestureLatch.ts` (new), `store/slices/prototypeSlice.ts`, `@core/module-engine/types.ts` (`NodeWrapperProps.onPointerUpCapture`), `src/__tests__/canvas/prototypePlayFirstClick.test.tsx` (new, 5 cases), `docs/features/studio-prototype.md`, `docs/agent-refs/canvas-internals.md`.

**FOR THE EXPORT-GENERATOR AGENT — the same two bugs are in the generated runtime.** `studio-workspace/test4/prototype/` (do not edit; regenerate):
- `ScreenFrame.jsx`'s delegated listener is `doc.addEventListener('click', onClick, true)` and calls `event.stopPropagation()` — same RC1 and RC2 as Studio had. It needs the same press/release pair, and it must not stop propagation.
- `Player.jsx`'s `resolveLinkElement(doc, link)` walks `doc.body.children[index]` from the raw `indexPath` on **every click**, so any element the component's own interaction adds or removes above the link's index silently re-points the link at a different element. Studio's own resolver does not have this problem (it matches node ids from the page tree, not live DOM indexes) — the exported one should resolve once and cache, or match a stable attribute.
- `Player.jsx`'s `back` calls `onPageChange(previous)` from INSIDE the `setHistory` updater — a render-phase update of another component, double-invoked under StrictMode.

**Named cuts:**
- Double-click and context-menu still `stopPropagation()` in live frames. Only CLICK was in the report; an authored `ondblclick` in a live frame is still swallowed. Same one-line `ownsAuthoredEvents` gate when someone wants it.
- The board's design frames are untouched — play mode only ever exists in live view (`canvasSlice.ts:224` arms it from `setCanvasView`), so a click on a board frame while armed still resolves against the play screen and does nothing. Left alone deliberately.
- No browser dogfood (agents don't drive the browser here). The press/release rule is asserted against the browser's documented common-ancestor behaviour, modelled in the test, not observed in Chrome.

**Dogfood checklist for the human** (at `/admin/site`, one project, live view, ONE frame):
1. Wire a `navigate` link from a design-system button on screen A to screen B, and a `back` link on a button on screen B that has a visible hover/pressed state.
2. Switch to Live. Play arms automatically. Move the pointer onto the A button — the component's own hover state should show, and NO blue editor hover outline.
3. Click it once. Exactly ONE navigation to B, with its transition.
4. Move onto B's back button and click it ONCE — from a cold pointer position, so the first `mouseenter` and the click are the same gesture. It must go back on that first press.
5. On a screen with a component that does something of its own on click (a tab bar, an accordion), click a tab that also carries a prototype link: the tab must change AND the link must follow, from one press.
6. Turn Play off. Clicking an element must select it again, and clicking an authored `<input>` in live mode must still focus and type.

**Landmines (height ⇄ injectors ⇄ events — the three that fight each other):**
- **Match the NATIVE event, never the synthetic one, when de-duplicating across capture and bubble.** React dispatches each phase from its own root listener and mints a SEPARATE `SyntheticEvent` for each, so a synthetic-identity comparison never matches. This cost a debugging round trip: the first version latched `e` and every link fired twice.
- **`stopPropagation()` in a capture-phase handler on a canvas node is a decision about the USER'S components**, not just about the editor. Every module that carries `nodeWrapperProps` on a `display: contents` host has the authored element BELOW the handler, so anything stopped there is stopped for them.
- The `onPointerUpCapture` gesture and `useCanvasFormControlSuppression`'s document-level `pointerdown`/`mousedown` cancels are on the same events but never in the same frame — the suppression hook is `enabled: !isLive` (`IframeFrameSurface.tsx:199`) and the player only exists in live. If anyone ever enables suppression in a live frame, they will fight.
### store-08 — Ctrl+Z on a MOVE: the stack was renumbered out from under it
- **Agent:** store-engineer · **Stage:** done (targeted tests + `tsc -p tsconfig.app.json` + eslint + architecture gates green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/undo-structural-moves` off `origin/main` (`c068b3d`, i.e. after `store-07`/#77). User report, verbatim: "why ctrl z don't work on moving items in the canvas or in layers around it works in values and other stuff — it should work on every action."

**`store-07` was right that the panel was the problem for VALUE edits, and it explicitly did not investigate this. Two separate root causes, both structural.**

**RC1 — the reload renumbered every id the stack was addressed by.** A studio-imported node's id IS its source location (`rel:line:col`). `moveNodes` (`store/slices/site/nodeActions.ts:509`) mutates the tree optimistically, then `commitStudioMove` writes the `.tsx`, then `resyncBoardAfterWrite` re-reads it — and every element below the edit comes back at a NEW line. `historyPreservation.ts`'s `historySurvivesReload` could only ask "does every id a stored patch names still exist?", so `loadSite`/`patchPages` wiped `_historyPast`/`_historyFuture` wholesale. **One drag cost the undo history of every unrelated edit before it** — including the value edits the user says "work". Worse, when the shift PERMUTED line numbers rather than vacating them (three same-size siblings reordered: b→3, c→4, a→5), every old id still "existed", the check said safe, and undo replayed the patch **against whichever element had inherited that address**. Silent wrong-element edit.

New `store/slices/site/historyNodeIdRemap.ts` re-addresses instead of wiping. The correspondence `historyPreservation.ts`'s doc says the client does not have is real for the one case that matters: a reparse triggered by the editor's OWN structural write is a re-read of a tree the store already holds in its post-gesture shape, so the two are isomorphic and a parallel walk from each page root gives an exact old→new id map. Strict by design (same page SET, same `moduleId` and child count at every node, no conflicting mapping for a shared `layout.tsx` id) — a wrong remap is worse than a wipe, so anything the walk cannot match falls through to `historySurvivesReload` exactly as before. Wired into BOTH `loadSite` and `patchPages`; skipped entirely when the stack is empty.

**RC2 — a patch-replay undo of a move is a lie waiting to happen.** `saveSite` diffs node VALUES and has no notion of parent, order or child list — that is precisely why `struct-01` gave structural gestures their own one-shot source commits. So replaying a move's inverse patch moves the element on the canvas, leaves the `.tsx` saying the opposite, and the next reparse silently wins. New `store/slices/site/structuralHistory.ts`: `moveNodes` tags its history entry with the pre-move `(parentId, index)` — the only moment that is still known — and `undo` **re-issues `moveNodes`** back to it, re-planned against the live tree so it rides every refusal gate and writes to source exactly once. Redo is symmetric. Tagged ONLY when a source write was actually issued, so a CMS/Visual-Component tree keeps plain patch replay.

**Slices touched:** `site` only (`nodeActions.ts`, `deleteNodesAction.ts`, `undoRedoActions.ts`, `lifecycleActions.ts`, `types.ts`, + the two new modules). No board/canvas/selection slice changed. **No new selector.** No new mutation — `moveNodes`/`deleteNodes` keep their existing shape and their existing (null) coalesce key; the new `tagStructuralGesture` additionally forces `_historyCoalesceKey = null` so a drag can never fold into a typing burst.

**Now undoable that was not:** canvas body drag reorder + reparent (#76's path), Layers-panel drag (`DomPanel.tsx:161`) — both route through `moveNodes` — and every value/style/rename/lock/hide entry recorded BEFORE any structural gesture, which used to die with the stack.

**Named cuts (still not undoable, deliberately):**
- **Undo of a source `delete`.** Its entry is now tagged `gesture: 'delete'` and `undo` REFUSES with a toast instead of replaying: no `StudioEdit` kind carries a subtree's source text (`insert` names a component plus literal props), so re-adding the nodes in memory would be a canvas that disagrees with the file. Making this work needs a new writeback kind that round-trips the removed range — real work, its own PR.
- **`duplicate` / `wrap` / `insert` on a studio tree produce no history entry at all** (W4-1: the store deliberately does not mutate the tree; the source grows and the board re-reads). Undo has nothing to see. Same remedy as delete.
- **Board state is not undoable at all** — frame move/resize (`boardSlice.ts:548` `setFramePosition` / `:555` `setFrameSize` / `setFrameRect`), board create/rename/delete, guides, annotations, and `prototypeSlice` links. All of it lives outside `site`, and `runHistoricMutation` records only `site`-scoped patches. That is a second history domain, not a patch; audited and named, not attempted.
- Multi-node drag: only `nodeIds[0]` is tagged, because `previewStructuralMove` already resolves the source commit off `nodeIds[0]` — the tag is faithful to what is actually written, not to what the canvas moved.
- No browser dogfood (agents don't drive the browser here).

**Gate test updated in the same change:** `patchPages.test.ts`'s "wipes … when the patch removes a node id a stored entry references" asserted the OLD contract for exactly the case this fixes. Split into "RE-ADDRESSES a stored entry when the patch is a faithful re-read" + "still wipes when the patch is NOT a faithful re-read".

**Dogfood checklist for the human** (at `/admin/site`, on a real imported project):
1. Edit a style value, then drag an element to a new position on the canvas. Press ⌘Z once — the element must go back AND the `.tsx` must change back (watch the file / `git diff`). Press ⌘Z again — the style edit must revert too.
2. Same with a Layers-panel drag.
3. Drag an element into a DIFFERENT parent, ⌘Z, then ⇧⌘Z. Both directions must land in the source.
4. Delete an element, press ⌘Z — expect the "Undo can't restore this yet" toast, and the canvas must NOT resurrect it.
5. Undo a move, switch to another page, press ⌘Z again — expect the "no longer open" toast, never a wrong-element move.
6. Move a board FRAME and press ⌘Z — nothing happens. Known and named, not a regression.

**Landmines:**
- **`buildReparseNodeIdRemap` matches by POSITION.** It is only sound because the store's tree is already in the post-write shape when the resync arrives (optimistic mutation first, then commit, then reload). If any future path reloads BEFORE the optimistic mutation — or writes to source without mutating the tree while keeping the same node count — the walk will happily map the wrong pair. The same-page-SET gate and the moduleId/child-count checks are what keep the current paths honest; do not loosen them.
- **`runStructuralStep` snapshots BOTH stacks before the re-issue and assigns them wholesale.** The re-issued `moveNodes` is an ordinary mutation: it pushes its own entry and `commitHistory` clears `_historyFuture`. Computing the new stacks from post-gesture state drops the rest of the redo chain — gated by `keeps the rest of the redo chain when it re-issues a move`.
- `_historyPast` entries are now mutated in place by `tagStructuralGesture` (a `set` immediately after the mutation). It is the only writer of `HistoryEntry.structural`.
### png-export — PNG export stopped refusing to photograph a screen it could see, and ⌘⇧C copies it
- **Agent:** panel-designer · **Stage:** done (targeted tests + both tsconfigs + eslint + architecture gates green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/png-export-settle-and-copy-shortcut` off `origin/main` (`c068b3d`).

**Two user asks, one PR.**

**1. Bug, verbatim: "fix this error when exporting the page or element as png".**
The toast read `PNG export failed — "onboarding" did not finish rendering within
20000ms — its preview data, fonts, or images never settled.`

**Root cause — the settle predicate had no bounded phases and no honest failure mode.**
`CaptureFrame.tsx`'s `waitForFrameSettled` looped `previewReadiness.waitUntilIdle
→ waitForDocumentQuiet → fonts.ready → waitForDocumentQuiet`, every wait
unbounded, with ONE 20 s `AbortController` over the whole thing. Any wait that
never resolved rode that abort and the frame reported `ok: false` — a REFUSAL,
which `exportNodePng` turned into a failed export. The screen was fully painted
on the canvas at the time.

Evidence gathered, and what it ruled out:
- **Not a hanging image.** Probed real Chromium (`chromium_headless_shell-1234`)
  against a 404 image and an unroutable host: both report `complete: true,
  naturalWidth: 0` after `load`. Nothing in the old loop waited on images at
  all — the error message named "images" without ever checking one.
- **Not `document.fonts.ready`.** Same probe with a `@font-face` pointing at a
  404: `fonts.ready` resolved in 0 ms. `studio-workspace/test4` has no
  `@font-face` and no `fonts.googleapis.com` link at all — its type stack is
  `'Open Sans', system-ui, sans-serif`, all system fallbacks.
- **The remaining phase is `waitForDocumentQuiet`,** which requires 32 ms with
  ZERO attribute/childList/characterData mutation anywhere under
  `documentElement`. Several injectors write into that document on a settle
  cadence (`CanvasScrollUnrollInjector`'s `data-studio-unroll` tagging,
  `useIframeFrameAutoHeight`'s `body.style.height` pin ⇄ `ResizeObserver`
  refit). On `Onboarding.tsx` — an `<img>` from an asset import, four
  `dangerouslySetInnerHTML` SVGs, and a `pkg.*` package component that the
  capture page never registers (`useRegisterProjectModules` is mounted by the
  EDITOR, not by `CaptureApp`) — that document does not go quiet inside the
  budget. **Not reproduced end-to-end**: `playwright-core@1.63` on this machine
  wants `chromium_headless_shell-1243` and only 1208–1234 are installed, so the
  headless driver cannot launch here. See "cut" below.

**Fix (the honest one, not a bigger timeout).** One shared, phase-bounded settle
machine — `settleCaptureDocument` in
`src/admin/pages/site/canvas/canvasCaptureSettle.ts` — replaces THREE hand-rolled
copies of the same loop (`CaptureFrame.tsx`, `AgentSnapshotFrame.tsx`,
`studioExportFrames.ts` — the headless page, the CMS snapshot frame, and the
live-bridge path all carried the identical defect).
- **A resource that will never load has already settled.** New
  `waitForImagesSettled`: an `<img>` is settled the moment it is `complete`, and
  an `error` event ends the wait exactly like `load`. Broken images are COUNTED
  and reported (`"2 images failed to load and are missing from this capture."`).
- Every phase gets its own 5 s bound inside the 20 s outer bound: images, fonts
  (`fonts.ready` raced, not awaited), DOM quiet. Preview data gets the remainder.
- **An expired bound is a WARNING on a successful capture, never a refusal.**
  `CaptureFrame` now always measures and reports the frame; `ok: false` is
  reserved for a frame that measured 0×0. The result names `stalledPhase`
  (`dom-quiet` / `images` / `fonts` / `preview-data`) instead of listing all
  three and shrugging.
- Removed the effect-level `setTimeout(() => controller.abort(), 20_000)` in
  `CaptureSettleReporter`: with the deadline now inside the settle function, that
  abort would have withheld the frame's report entirely and hung the run until
  the driver's longer `readyTimeoutMs`.

**2. Feature: "allow me to click ctrl + shift + C to copy as png".**
- New keybinding `export.copySelectionPng` (⌘⇧C / Ctrl+Shift+C, scope `canvas`,
  `ignoreInEditableField`). **`layers.copy` (⌘C) now rejects Shift** — it did
  not, so ⌘⇧C would have fired BOTH commands.
- `useCopyAsPngShortcut.ts` — a document-level listener (the
  `useBoardSelectAllShortcut` shape: scoped by intent, not focus, so it works
  while the caret is in the Properties panel), mounted from `CanvasRoot`. Stands
  down on `defaultPrevented`, `activeInlineEdit`, `hasPendingTextEdit(target)`
  (PR #77's rule, same as ⌘Z) and `isTextInputTarget`. One capture in flight at
  a time.
- `resolveCopyAsPngTarget` (`copyAsPngTarget.ts`) is the pure routing: selected
  node → that element; exactly one selected board frame → that frame; nothing
  selected → the open screen. Refuses a multi-frame selection, an empty board,
  and a Visual Component document by name.
- `POST /admin/api/studio/node-png` now takes `nodeId` as OPTIONAL — omitted
  returns the whole frame uncropped. A page has no addressable root element
  (`page.rootNodeId` is a `base.body` node whose children ARE the iframe body),
  so there is nothing to crop to for the nothing-selected case.
- `copyPngToClipboard` in `nodeExportClient.ts`
  (`navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`),
  built on a new shared `fetchNodePngBlob` that `downloadNodePng` now also uses.
  Feature-detects and refuses by name rather than throwing a bare `TypeError`.
- Discoverability: a **Copy as PNG** entry in the Export section's `+` menu,
  carrying the ⌘⇧C hint resolved from the keybindings registry. The Shortcuts
  help sheet renders from that registry, so it picks the row up for free.

**Files touched.** `src/admin/pages/site/canvas/canvasCaptureSettle.ts`
(rewritten), `copyAsPngTarget.ts` + `useCopyAsPngShortcut.ts` (new),
`CanvasRoot.tsx`, `src/admin/agentCapture/CaptureFrame.tsx`,
`canvas/AgentSnapshotFrame.tsx`, `agent/studioExportFrames.ts`,
`spotlight/keybindings.ts`, `panels/PropertiesPanel/{ExportSection.tsx,
ExportSection.module.css, nodeExportClient.ts, nodeExportModel.ts}`,
`server/handlers/studio/{nodeExportRoutes.ts, nodeExportCapture.ts}`.
Tests: `canvas/__tests__/{canvasCaptureSettle,copyAsPngTarget}.test.ts` (new, 26
cases), updated `nodeExportModel.test.ts` + `nodeExportRoutes.test.ts`.
Docs: `docs/features/mcp-connectors.md` (the settle table + the phase bounds),
`docs/features/inspector-disclosure.md` §G11.
**Tokens added to `globals.css`: none** — the one new rule (`.menuShortcut`)
uses existing `--text-subtle`, `--text-2xs`, `--inspector-caption-gap`.

**Cuts, named:**
- **No end-to-end reproduction of the 20 s timeout against `test4/onboarding`.**
  This machine's playwright browser revision does not match `playwright-core`,
  so the headless driver cannot launch (`bunx playwright install chromium` would
  fix it; not run — it mutates a cache shared with other agents). The root cause
  above is from a Chromium probe of the individual primitives plus static
  analysis of the loop, not from a captured failure. The fix is
  cause-independent: whichever phase stalls, the export now succeeds with that
  phase named.
- **No fix for whatever keeps that document mutating.** Making the injectors
  converge is a separate change with a separate blast radius; this PR makes a
  non-converging document produce a picture instead of an error.
- **CSS `background-image` is not waited on**, only `<img>`. Nothing waited on
  it before either, and it cannot stall the capture.
- **Copy as PNG is fixed at @2×**, matching the Export section's default. No
  density submenu on the shortcut.
- **`server/ai/mcp/capture/` had 8 pre-existing failures** on `origin/main`
  (`c068b3d`) and still has exactly 8 — verified against a clean detached
  worktree. Same for `direct-icon-imports`' `chevron-left` catalog case. Neither
  is mine.

**Human action needed (dogfood at these four selection states):**
1. **`test4` → `onboarding`, select the `.hero` `<img>` element** → Export
   section `+` → PNG @2× → run. It must DOWNLOAD, not toast "did not finish
   rendering". If the screen was still settling the file still arrives.
2. **Same screen, nothing selected, press ⌘⇧C** → toast "Copied as PNG ·
   Onboarding @2×", then ⌘V into Figma/Slack and confirm the whole screen
   pasted.
3. **Select one element, press ⌘⇧C** → only that element's rectangle is on the
   clipboard, and the layer clipboard is UNCHANGED (⌘V on the canvas afterwards
   must not paste a duplicated node — that is the `layers.copy` Shift guard).
4. **Click into a Properties-panel field, type a value WITHOUT pressing Enter,
   press ⌘⇧C** → nothing copies (the draft owns the keystroke), and the field
   keeps its text.

### store-07 — "ctrl z doesn't work": two root causes, both in the panel, plus one half-revert
- **Agent:** store-engineer · **Stage:** done (targeted tests + `tsc -p tsconfig.app.json` + eslint + architecture gates green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/undo-after-wave7` off `origin/main` (`71060a8`). User report, verbatim: "ctrl z ... doesn't work properly" / "if ctrl z it doesn't work" — nothing changes when the key is pressed.

**The store was never the problem.** `src/__tests__/editor-store/undo-redo.test.ts` and `historyCoalescingFold.test.ts` are 27/27 green on `origin/main`; `commitHistory`'s coalescing requires key EQUALITY, so a single-node edit cannot fold into an unrelated burst (suspect 3, checked, clean). Both real causes were in the Properties panel, and PR #73 (prefill) is what turned each from latent into everyday.

**RC1 — every panel click pushed a phantom undo entry.** `TokenAwareInput.commit()` (`property-controls/TokenAwareInput.tsx`) called `onCommit` UNCONDITIONALLY from `onBlur`. That was harmless while an undeclared property rendered as an empty box. Since #73 an unset field DISPLAYS the element's real computed value, so clicking into a padding side / gap / position inset and clicking away wrote `paddingTop: 16px` into the user's `.tsx` for real and pushed a history entry that reverts nothing visible. `styleFieldDisplay.ts`'s own doc asserts the guard that made prefill safe ("every field's commit path compares against what it was displaying") — `ScrubInput` had it, `TokenAwareInput` never did. It now compares the RESOLVED value against `value` (so a token round-trip `var(--space-md)`→`md` reads as unchanged) and treats a MIXED field's baseline as empty (so blurring one untouched no longer flattens the selection).

**RC2 — the editor's undo was unreachable from the keyboard whenever the caret was in a panel field.** `UndoRedoButtons.tsx` guarded with a blanket "target is INPUT / TEXTAREA / contentEditable → return". Both field primitives deliberately KEEP focus after a commit (Figma: Enter commits and re-selects), and after #73 the panel is wall-to-wall populated inputs — so the ⌘Z pressed right after an edit landed on a React-CONTROLLED input whose native undo stack has nothing to give, and died there. New `canvas/pendingTextEdit.ts` tracks the honest fact instead: an `input` event marks its target pending; a focus change, Escape, or Enter on a single-line `<input>` clears it (Enter in a `<textarea>` is a newline, not a commit). Rule: **whoever has an edit in progress owns the keystroke** — no draft, or focus outside a field, and ⌘Z is the editor's.

**RC3 (suspect 4, real) — one gesture cost 2-8 undo entries.** `SizeSection.handleModeChange`, `LayoutSection.applyLayoutMode`, both `AlignGrid` handlers and `AnimationsSection.applyPatch` all looped the per-property `onChange`. Width→Fill writes `flex` and clears `width`; one Ctrl+Z restored `width` and left `flex` behind. New `StyleSectionsEditor` prop `onChangeMany(patch)` (`null` clears) is the one multi-property write channel; all three composers implement it over a store action that already took a whole patch, so one call is one `runHistoricMutation` transaction.

**Slices touched:** none. No store file changed — `setNodeInlineStyles`/`setNodesInlineStyles`/`updateClassStyles` already had the right shape and the panel simply wasn't using it. **No new selector, no new mutation, no new coalesce key.**

**Named cuts:**
- `onClearProperties` stays alongside `onChangeMany`. It is NOT a duplicate write path: on a class target it purges a property from the base rule AND every context override, which a patch aimed at the active context cannot express. Consequence: `LayoutSection`'s mode switch still costs 2 entries when the switch also has to purge dependent properties (down from 4). Fixing it properly means a purge-aware patch shape on the class writers — follow-up, not this PR.
- Not investigated further: whether `resyncBoardAfterWrite` widening to `loadSite` wipes a still-valid history stack in practice. `historyPreservation.ts` guards it and `loadSite` only wipes when a stored patch names a node id the reload no longer has — plausible after a line-shifting structural write, but I could not reproduce it and did not want to speculate a fix into the reload path.
- No browser dogfood (agents don't drive the browser here).

**Dogfood checklist for the human** (at `/admin/site`, on a real project):
1. Click into a padding/gap/position field WITHOUT typing, click elsewhere. Nothing should be written (no dirty marker, no new declaration in the file) and Undo should stay disabled if it was.
2. Change a width, press Enter (focus stays in the field), press ⌘Z / Ctrl+Z. The change must revert.
3. Type into a field and press ⌘Z BEFORE committing — the text should revert, the canvas must not.
4. Switch Width to Fill on a flex child, press ⌘Z once. Both `flex` and `width` must return to their prior state together.
5. Click a cell in the align 3×3, press ⌘Z once — both axes revert.
6. Type in the Agent prompt box and press ⌘Z — native text undo, the canvas must not change.

**Landmine:** `pendingTextEdit.ts` installs three capture-phase `document` listeners once, lazily, and never removes them. That is deliberate (cheaper than reference-counting across mounts) but it means the module is global state: a test that asserts routing must either drive real `input`/`focusin` events or call `clearPendingTextEdit()`.

### canvas-dnd — pressing an element on the canvas now drags it
- **Agent:** canvas-engineer · **Stage:** done (targeted tests + `tsc -p tsconfig.app.json` + eslint + the two touched gates green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/canvas-drag-drop-after-wave7` off `origin/main` (`71060a8`).
  Verbatim report: "dragging elements in canvas and dropping doesn't work
  properly" / "when clicking an element and dragging (not from the icon) it
  doesn't drag".

**Root cause — a missing affordance, NOT a Wave 7 regression.** The canvas
reorder drag had exactly one activation point: the selection toolbar's
hand-grab icon (`SelectionToolbar.tsx:101` → `onDragPointerDown` →
`useCanvasReorderDrag.handlePointerDown`). Nothing anywhere listened for a
press on a node in order to move it — `NodeRenderer.tsx`'s only pointer hook is
`onPointerDownCapture`, for focus + authored-form-control suppression. So a
press on an element body opened no session and every `pointermove` after it was
inert. `docs/reference/canvas-dnd.md` documented this as the intended state
("armed from the selection toolbar's hand-grab button … not by pressing the
node itself"), and `git log -- src/admin/pages/site/canvas` has no commit since
`#59`, so none of PRs #62–#74 touched it.

**Fix.** A second activation point that funnels into the SAME session. Both
entry points now call one `beginDrag(origin)` in `useCanvasReorderDrag.ts`, so
activation distance, candidate measurement, the cross-iframe relay flag and the
commit path cannot drift between the two gestures. The body path is a native
capture-phase `pointerdown` listener on the frame's own `contentDocument`
(keyed on `overlayRoot.ownerDocument`, so a frame reload re-attaches it) — not
a React handler on the node, because it must run before `NodeRenderer`'s
capture handler, must see a press on any node without threading a callback
through every module's prop bag, and must add no element to the canvas DOM.

- Pressing inside the current selection drags the whole selection; pressing
  outside it drags just that node and selects it **on activation**, never on
  pointerdown (a press that stays a click leaves `NodeRenderer`'s Cmd/Shift-aware
  click-to-select alone).
- `preventDefault()` on the pointerdown kills native text selection and the
  browser's image/link drag. `click` is NOT suppressed by canceling
  `pointerdown`, so click-to-select and double-click-to-inline-edit are intact.
- Stand-downs, in order: `bodyDragEnabled` (structure cap + active breakpoint),
  `overlayRoot === null` (design frames only — a live/prototype frame has no
  injector root), space/middle-button pan, `activeInlineEdit`,
  `[data-studio-canvas-overlay-root]` (resize handles),
  `[data-canvas-interactive="true"]`, `[contenteditable]`, no `[data-node-id]`
  ancestor, and root/locked/absent nodes via the existing `resolveDraggedIds`.

**Files touched:** `src/admin/pages/site/canvas/useCanvasReorderDrag.ts`,
`src/admin/pages/site/canvas/BreakpointSelectionOverlay.tsx`,
`src/__tests__/canvas/canvasBodyReorderDrag.test.tsx` (new, 10 cases),
`docs/reference/canvas-dnd.md`, `docs/agent-refs/canvas-internals.md`.

**Landmines (height ⇄ injectors ⇄ events — the three that fight each other):**
- **`overlayRoot` is now load-bearing for EVENTS, not just geometry.** It was a
  rendering detail (WS-5.1: portal rings into the iframe). It is now also the
  design-frame gate and the document handle for the body-drag listener. If
  `CanvasSelectionOverlayInjector` ever mounts in a live frame, press-and-drag
  starts working in live mode — which would be wrong. If it ever stops creating
  a root in design mode, body drag silently dies with no error.
- **The drag origin must be in PARENT client coordinates.** A press inside an
  iframe reports iframe-local coordinates, but every subsequent `pointermove`
  arrives at the `window` listeners in parent coordinates (natively when the
  cursor is outside the frame, minted by `IframeFrameSurface`'s relay when it is
  inside). Storing the raw local point makes the first move read as a jump of
  the whole iframe offset, clearing the 4px activation distance instantly and
  turning every click into a drag. Gated by the
  `translates the press from iframe-local to parent client coordinates` case.
- **`pointerdown` is the one pointer type the relay must keep NOT forwarding.**
  `useIframeEventForwarding`'s `maybeForward` excludes it from the drag branch;
  the body path opens the session locally instead. Forwarding it would open a
  second session for the same gesture.
- **`BreakpointSelectionOverlay.tsx` is at exactly 700 lines**, the ceiling. Two
  redundancies were collapsed to make room (`anyEditCap`/`showRings` were the
  same value; `showToolbar` now derives from a new `canEditStructureHere`). The
  next line added to that file must be paid for by a real extraction.

**Ruled out, with evidence (so nobody re-runs these):**
- **`studioLoadMemo.ts` mtime granularity (the "drop doesn't stick" theory).**
  The fingerprint is `size:mtimeMs` per file, and a pure sibling reorder can
  leave `size` identical — so it reduces to `mtimeMs`. Probed under Bun on this
  machine (APFS): 8 same-size writes in a tight loop produced 8 distinct
  `mtimeMs` values with sub-microsecond resolution. Not a viable stale-memo
  path on macOS. It WOULD be on a filesystem with 1s mtime granularity (some
  Linux/ext3, some network mounts); if a Linux dogfooder ever reports a drop
  that snaps back, this is the first place to look.
- PR #64 (`translate` vs `transform`), #63 (Fill/Hug), #65 (panel width 290 /
  `--inspector-*`): the canvas reorder drag writes **no inline style at all** —
  it commits `moveNodes(draggedIds, parentId, index)`, a pure tree mutation.
  There is no `left/top` or `translate` write in this path to conflict with, and
  no consumer of the old panel-width constant in the drop geometry.

**CUT — named:**
- **No free-position drag.** Dragging still means *reorder / reparent*, never
  "write `left/top` on an absolutely-positioned element". That is a separate
  feature with a separate honest-single-target question and is not in this PR.
- **No drag cursor change or ghost preview for the body drag** — it reuses the
  existing `CanvasDropIndicators` only.
- **No auto-scroll of a scrollable region inside a frame** during a body drag
  (canvas-level auto-pan is unchanged and still works).

- **Dogfood script (human, `bun run dev` → `/admin/site`, one board, 2+ frames, 100% zoom):**
  1. Press an **unselected** element and drag it 40px+ — it must select on the
     way and show the drop indicator; release over another container and confirm
     it lands there and survives a reload.
  2. Press a selected element and *release without moving* — it must stay a
     plain click (selection unchanged, nothing moved).
  3. Multi-select two siblings (Cmd-click), press one of them, drag — both must
     move; the selection must not collapse to one.
  4. Double-click a text layer to inline-edit, then drag across the text — it
     must select TEXT, not move the element. Cmd+Z must still undo the typing.
  5. Drag a corner resize handle — it must resize, not reorder.
  6. Hold **space** and drag over an element — it must pan, not drag the element.
  7. Zoom to 50% and repeat (1); the drop indicator must track the cursor (this
     is the coordinate translation).
  8. Switch to **live** view and press-and-drag an element — nothing must move,
     and links/buttons must behave like the published page.
  9. The toolbar hand-grab icon must still work exactly as before.

### apply-variable — Figma's "Apply variable": every inspector field can bind to a project CSS custom property
- **Agent:** panel-designer · **Stage:** done (typecheck + touched tests + gates green; draft PR open) — **needs human dogfood**
- **Branch:** `feat/inspector-apply-variable` off `origin/main` (`ee5bc9c`). Worktree `.tmp/wt-apply-variable`.

**What shipped.** A hover-revealed variable button at the trailing edge of
every inspector field, a searchable picker anchored to it, and a
leading-edge chip when the field's value IS a `var()` reference. The
variables offered are the **open project's own CSS custom properties**, not
only the framework scales.

**New shared primitive — `src/ui/components/VariableField/`**
- `varBinding.ts` — `parseVarBinding` / `formatVarBinding` / `variableChipLabel`. Bound = the value is EXACTLY one `var()` call (a fallback arg is fine). `calc(var(--x) * 2)` is deliberately not bound.
- `variableKind.ts` — `classifyVariableValue` (colour / length / number / other) from the RESOLVED value, never the name. `filterVariablesByKind`, `LENGTH_VARIABLE_KINDS`, `COLOR_VARIABLE_KINDS`.
- `VariableSourceContext.ts` — how a portable `src/ui/` field learns the catalog without importing `src/admin`. Empty outside a provider → no icon at all.
- `useVariableAffordance.tsx` — returns `{ bound, displayValue, chip, trigger }`. A hook, not a wrapper element, so no caller's layout `className` moves a level.
- `VariablePickerPopover.tsx` — `InspectorPopover` + `SearchBar` + rows grouped Project / Package / Framework, swatch for colours. Clamps to the viewport for free.
- `VariableField.module.css`, `index.ts`, `varBinding.test.ts`, `VariableField.test.tsx`.

**Admin wiring**
- `src/admin/pages/site/property-controls/projectVariables.ts` — scans `studioRawCssStores.ts`'s `authoredCss` + `vendorCss` (already on the client for the canvas) plus a locally generated `generateFrameworkRootCss` block. Resolves `var()` chains (bounded, cycle-safe). **No server change and no new wire format** — the catalog cannot disagree with what the canvas renders, because it is what the canvas renders.
- `ProjectVariablesProvider.tsx` — mounted on the panel's root `<aside>`, same altitude as `data-field-skin="inspector"`.
- `projectVariables.test.ts`.

**Files touched**
- `src/ui/components/ScrubInput/ScrubInput.tsx` — chip + trigger + `data-variable-host`; empty-commit-on-bound is a no-op.
- `src/ui/components/Input/Input.tsx` + `.module.css` — new `leadingSlot` prop (INTERACTIVE leading content; `prefix` stays decorative/`aria-hidden`/`pointer-events: none`).
- `src/admin/pages/site/property-controls/TokenAwareInput.tsx` — same, plus hook reordering so the affordance is read before `display`.
- `src/admin/pages/site/property-controls/TokenizedColorField.tsx` — trigger only (see cuts).
- `src/admin/pages/site/panels/PropertiesPanel/PropertiesPanel.tsx` — provider mount.
- `docs/features/inspector-disclosure.md` — new §10.

**Tokens added to `globals.css`: NONE.** Everything reuses `--inspector-*`,
`--bg-surface-3`, `--radius-sm`, `--overlay-5/20`, `--text-*`.

**Icon: `braces` (`{}`), not a hexagon.** The vendored `pixel-art-icons`
subset has no hexagon/diamond variable glyph and the upstream private repo is
not checked out on this machine, so `bun run icons:sync` could not add one.
`braces` is already vendored (gate stays green) and reads as "variable" in
every dev tool. **Swap it the moment the upstream checkout is available.**

**Cuts, named**
1. **No per-variable source FILE.** The client receives the project's
   stylesheets already concatenated (`studioCss.ts`'s `authoredCssParts.join`),
   so there is no honest file attribution. The picker groups by bundle
   (Project / Package / Framework) instead of inventing one.
2. **Colour fields get the trigger, not the chip.** `TokenizedColorField`'s
   leading edge is already occupied by the absolutely-positioned swatch
   button, and the text field already shows `var(--x)` in full.
3. **The spacing box's per-side 38px fields show no trigger.** In
   `TokenAwareInput`'s `overlay` mode the wrapper is `display: contents`, so
   there is no containing block to anchor to. Those fields still show the
   chip and reach the picker by clicking it.
4. **A binding to the field's OWN framework scale step is not chipped** —
   `displayTokenValue` already round-trips it to the short `md`, and
   replacing that would regress the spacing/typography autocomplete.
5. **Bound colour fields don't recolour the swatch** from the project
   catalog (`swatchValue` still resolves framework tokens only). The picker
   row and chip carry the swatch.

**Verification run:** `bun test src/ui/components/VariableField
src/admin/pages/site/property-controls/projectVariables.test.ts
src/admin/pages/site/panels/PropertiesPanel/__tests__/ src/ui/components/{ScrubInput,Input,AddablePropertyField}`
(521 pass), the four gates (`css-token-policy`,
`button-primitive-usage`, `no-css-var-fallbacks`, `ui-primitives-location`,
plus `css-token-vocabulary` and both admin token-policy gates),
`tsc -p tsconfig.app.json --noEmit` clean, `eslint` clean on every changed file.

**Pre-existing failure, NOT mine:** `inspectorGeometryBudget.test.tsx` →
"inspector CSS modules use the frozen scale" reports three `var(--space-*)`
hits in `MultiSelectionInspector.module.css`. That file is untouched in my
diff and already carried them at `ee5bc9c`; another agent owns it.

**Human action needed — dogfood at these selection states:**
1. Select any node with a `padding`/`width` set. Hover a Size or Spacing
   field: the `{}` button should fade in at its right edge with the tooltip
   "Apply variable". Tab to the field — it should appear on focus too.
2. Click it. The picker should list only length/number variables from the
   project's stylesheets, grouped Project / Package / Framework, and clamp
   to the viewport when opened from the LAST row of a tall panel.
3. Pick one. The field should show a chip with the bare name (e.g.
   `space-4`), the rest of the field empty, the resolved value as the chip's
   tooltip. Undo should restore the literal in one step.
4. On that bound field: try to scrub the `W` label — it must do nothing.
   Click the chip — the input should focus empty with the picker open. Press
   Escape — the binding must survive. Click the chip, then click away
   without typing — the binding must STILL survive.
5. Hover the chip → detach ×. Clicking it must write the resolved literal
   (e.g. `16px`), not an empty value.
6. Select TWO nodes with different widths. The field reads "Mixed", shows
   NO chip, and applying a variable must write `var(--x)` to both.
7. Select a node and open a colour field (Fill / Stroke). The `{}` button
   should offer only colour variables, each with a swatch.
8. Confirm no inspector row got taller — compare the Size section against
   `main`.
### gate-fixes — two Wave 7 architecture gates back to green
- **Agent:** studio-implementer · **Stage:** done (targeted tests + `tsc -p tsconfig.node.json` + eslint green; draft PR open) — no dogfood needed (no behaviour change).
- **Branch:** `fix/wave7-gate-regressions` off `origin/main` (`ee5bc9c`). Two regressions, nothing else: (1) `MultiSelectionInspector.module.css:87-133` still reached for the fluid `--space-3xs/2xs/xs` scale — swapped 1:1 to the frozen `--inspector-space-*` tokens, `inspectorGeometryBudget.test.tsx` 10/10 pass; (2) `qualityAudit.ts` was 757 lines against the 700 ceiling — the W9-3 composition audit moved to `server/handlers/studio/compositionAudit.ts` (253 lines) with its tests in `compositionAudit.test.ts`, leaving `qualityAudit.ts` at 550. Shared finding types stay in `qualityAudit.ts`; its four scan primitives (`RULE_BLOCK_RE`, `DECLARATION_RE`, `RAW_PX_RE`, `lineAt`) are now exported so the two audits scan identically instead of restating each other.
- **Landmine:** `MIN_TYPE_HIERARCHY_RATIO` is imported by `variantSeeds.ts` (the generator and the grader agree by construction) — it moved with `auditCompositionQuality`, so that import now points at `compositionAudit.ts`.

### panel-prefill — Typography first on a text layer, and every field prefilled with what the element renders
- **Agent:** panel-designer · **Stage:** done (typecheck + touched tests + gates green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/inspector-typography-first-and-prefill` off `origin/main` (`a865eb7`).
  Two verbatim user asks: "when I select a text the typography controls are at
  the top, and when selecting anything overall the panel should be prefilled
  already with the current values even if inline styles".

**1. Typography first (new `PropertiesPanel/styleSectionOrder.ts`)**
`CLASS_STYLE_SECTIONS` is untouched — it stays the fixed registry. Ordering is
a function of the SELECTION: `orderStyleSections(sections, textFirst)` lifts
Typography to the front and leaves every other section's relative order alone.
`isTextNode` = no element children AND (the module declares `inlineTextEdit` —
the same registry fact `inlineEditSlice.ts` asks — OR the host `tag` is in
`TEXT_HOST_TAGS`). `isTextSelection` requires a non-empty selection where
EVERY node passes. Threaded as a `textFirst` prop:
`StyleSurface` (single) and `MultiInlineStyleComposer` (multi) compute it;
`StyleRuleComposer` / `InlineStyleComposer` / `StyleSectionsEditor` /
`StyleCategoryRail` pass it through. The rail follows the same order as the
scroll list deliberately — they read the same ordered array.

**2. Prefill (new `PropertiesPanel/styleFieldDisplay.ts`)**
One rule, one module: `resolveStyleFieldDisplay({ storedValue, currentValue,
fallback })` → `{ value, placeholder, isSet, inherited }`. Stored value wins;
else the CURRENT value (the frame's `getComputedStyle` reading, which already
folds in inline `style={{}}`) becomes the field's VALUE, muted, with the row
still `data-state="unset"`; else the spec default stays a placeholder. `MIXED`
in either bag short-circuits — a disagreeing selection is never prefilled.

**Root-cause note (the investigation asked for):** there is no null-`computedValues`
bug on the inline path. `node.inlineStyles` does reach the Element target's
stored bag (`StyleSurface` → `InlineStyleComposer`), and both composers already
folded `{ ...computedValues, ...stored }` into `currentStyles`.
`useFrameComputedStyleValues` returns `null` only when no canvas element is
resolvable (tests, pre-mount). The panel *looked* empty because that merged
value was only ever rendered as a grey `placeholder` behind an empty box. That
was the whole bug, and it is fixed at the display rule.

**Files touched**
- New: `styleSectionOrder.ts`, `styleFieldDisplay.ts`,
  `__tests__/styleSectionOrder.test.ts`, `__tests__/styleFieldDisplay.test.tsx`.
- Ordering: `StyleSectionsEditor.tsx`, `StyleCategoryRail.tsx`,
  `StyleSurface.tsx`, `StyleRuleComposer.tsx`, `InlineStyleComposer.tsx`,
  `MultiInlineStyleComposer.tsx`.
- Prefill: `ClassPropertyRow.tsx` (+ `.module.css`) — the single seam that
  covers every generic row and the four grid-backed sections (Typography,
  Fill, Effects, Interaction) via `StackedPropertyGrid.tsx`; plus the bespoke
  fields in `SizeSection.tsx`, `PositionSection.tsx`,
  `SpacingBoxControl/SpacingBoxControl.tsx` (+ `.module.css`),
  `LayoutSection/{SingleSideField,LinkedAxisField,GapInput}.tsx`,
  `StrokeSection.tsx`, `AppearanceSection.tsx`, `RotationRow.tsx`.
- Primitives: `ScrubInput.tsx` (+ `.module.css`), `AddablePropertyField.tsx`
  (both `AddablePropertyField` and `RevealedField`),
  `LayoutSection/ScrubTokenField.tsx` (+ `.module.css`) gained an `inherited`
  presentation flag → `data-inherited` + `--text-muted`.
- Doc: `docs/features/inspector-disclosure.md` §5.0 and §5.0a.
- **No new tokens.** Everything uses existing `--text-muted`.

**Deliberately unchanged**
- Law 1 (`collapsedWhenEmpty`) is judged on the STORED bag and is untouched —
  prefill only applies inside an OPEN section. `__tests__/emptySectionLaw.tsx`
  still green.
- `isSet` semantics: the indicator dot, the "N set" meta, the remove button and
  `data-state` all still mean "declared on the active target".
- `backgroundImage` keeps the raw stored value (its computed form is always
  `none` — noise inside a gradient field).

**Side fix required by the rule:** the two generic row builders
(`StyleSectionsEditor`'s fallback branch and `StackedPropertyGrid`) now pass
`MIXED` as the row VALUE via `isMixedStyleValue` instead of leaning on
`resolveStylePlaceholder` turning it into the literal string `"Mixed"` — that
string would otherwise have been prefilled into the field.

**Cuts (named, not hidden)**
- `FillSection` / `EffectsSection` / `AnimationsSection` bespoke sub-controls
  (colour swatches inside the fill list, shadow-layer popover fields) were not
  converted — their grid rows ARE prefilled through `ClassPropertyRow`, but the
  popover-internal fields still use the old placeholder shape.
- `PositionConstraints.tsx` and `FrameSizePanel` / `FrameBulkInspector` (board
  frames, not element styles) were left alone.
- No integration test that renders the whole panel on a `base.text` node and
  asserts the DOM order of sections — the ordering is unit-tested instead.

**Verification run:** `bun test src/admin/pages/site/panels/PropertiesPanel
src/__tests__/panels` (1179 pass / 1 fail), `bun test src/ui src/__tests__/ui`
(340 pass), the five CSS/primitive architecture gates,
`tsc -p tsconfig.app.json --noEmit` (clean), `bunx eslint` on every changed file
(clean).
**Pre-existing failure I did not cause:** `inspectorGeometryBudget.test.tsx` →
`MultiSelectionInspector.module.css` uses `--space-3xs/2xs/xs`; that file was
last touched by PR #68 and is not in my diff.

**Human action needed (dogfood, in this order):**
1. Select a heading (`<h1>`/`<p>`) on the canvas → **Typography must be the
   first section**, and the category rail's first CSS button must be the
   Typography glyph. Select a `<div>` → order back to Position-first.
2. Select any element with NO class and NO inline styles → every open section's
   fields **read filled** with the element's real values in a dimmed tone, and
   every row still shows its unset state (no dot, no remove `x`, muted caption).
3. Select an element styled with an inline `style={{ width: '320px' }}` → the
   Element target's Width field reads `320px` in NORMAL tone (it is set there),
   while e.g. Font size reads the inherited value dimmed.
4. Drag the Width label on a prefilled-but-unset field → it must commit a real
   `width` declaration starting from the displayed number. Focus and blur the
   same field without typing → **nothing must be written** (check the class rule
   / the file on disk).
5. Multi-select two elements with different widths → Width still says "Mixed",
   NOT a prefilled number.
6. Collapse everything: a section with nothing set (e.g. Effects) must still be
   a one-line header with a `+`, not an expanded grid of prefilled values.

### store-06 — W8-3 phases 2 + 3, and phase 1's bespoke-section Mixed gap
- **Agent:** store-engineer · **Stage:** done (typecheck + touched tests + gates green; draft PR open) — **needs human dogfood**
- **Branch:** `feat/multi-select-mixed-and-class-bulk` off `origin/main` (`b56ff12`).
  Goal: `STUDIO-WAVE7-PLAN.md` §W8-3 phases 2 and 3, plus the phase-1 leftover
  `inspector-w8-3-p1` handed over (its cut (a), (b), (c) — all three closed).

**Slices touched**
- `store/slices/site/nodeActions.ts` — one new action, `setNodesInlineStylesPerNode`.
- `store/slices/site/helpers.ts` — `mutateTreesForNodeIds` grew an optional
  `{ coalesceKey }`, forwarded to `runHistoricMutation` on BOTH its paths
  (single-tree and cross-page). No behaviour change for existing callers.
- `store/slices/site/types.ts` — the two declarations above.
- No new selector, no new index, no new slice. Nothing walks a page.

**New mutation**
| Action | Coalesce key | History |
|---|---|---|
| `setNodesInlineStylesPerNode(patches, opts)` | caller-supplied; Selection colours passes `selection-color:<colour being replaced>` | ONE transaction across every touched page (rides `mutateTreesForNodeIds`), so a recolour is one undo entry. Per-node all-or-nothing via `isStylePatchWritableToSource`; a stale id or a refusing node is skipped, never aborting the rest. |

**Phase-1 leftover — all eight bespoke sections now say "Mixed"**
Two helpers in `styleValueUtils.ts` do the work: `pickMixedString` (a cell read
that PRESERVES the sentinel — replaces the two local `pickString` copies in
`AppearanceSection` and `StrokeSection`) and `isMixedStyleValue` (stored cell
mixed, or effective cell mixed when nothing is stored). Wired: Spacing +
Layout-padding (through `SingleSideField`/`LinkedAxisField` → `ScrubTokenField`'s
new `mixed`), Layout (mode row `data-mode="mixed"`, flex direction, gap, grid
tracks), Position (switcher `data-position-value="mixed"` + each TRBL offset),
Size (W/H + revealed constraints + `GenericSizeRow`), Typography (both alignment
groups), Appearance (opacity + all five radius fields), Fill (the entry no longer
VANISHES — `readString` returned undefined so `showColorEntry` was false — and
reads "Mixed"), Stroke (weight, colour, style, position).
**A real latent bug was fixed on the way:** `hasStyleValue` is true for a Symbol,
so Position's `DirectionInput` and Size's axis/constraint fields would have
printed `Symbol(studio-mixed-value)` into the input via `String(storedValue)`.

**Phase 2 — the lock carries a count**
`StyleWriteLockContext` is now three-state (`null` / `blocked` / `partial`).
`partial` NEVER disables — it carries a `StyleWriteReach` (`styleWriteReach.ts`)
and each row states its own count via `resolveRowWriteLock` +
`describeReach`: *"Writes to 3 of 5 selected layers — 2 are set from an
expression in code."* The reach is per PROPERTY on purpose: a node whose `width`
is an expression takes a `color` edit fine, and a selection-wide count would be
wrong on every property but one. Rows carry `data-write-partial="true"`.
`StyleSurface` wraps its existing string reason in `blockedStyleWriteLock(...)`.

**Phase 3 — class-target bulk behind a gate, and Selection colors**
- `multiSelectClassTarget.ts` (pure): `no-shared-class` / `allowed` /
  `needs-confirmation`, counting through the O(1) `_classIdToNodeCount` index
  (no page walk). Tie-break = the LAST shared class in the anchor's `classIds`.
- `MultiSelectionStyleArea.tsx` (new) owns the chip + gate + which composer
  mounts; `MultiSelectionInspector` now delegates to it. The gate is INLINE
  under the chip (no `window.confirm` — banned; no modal — the question is
  about the surface on screen), remembers its answer per class id, and mounts
  `StyleRuleComposer` under the same pre-flight `StyleWriteLockContext` the
  single-node surface provides, so a compiled class is unwritable here too.
- `StyleTargetChip` gained `onSelectClass` + `classActive`: the class chip
  becomes a real `Button` ONLY where switching is a real action. The single-node
  surface is byte-identical (it passes neither).
- `SelectionColorsSection` + `selectionColors.ts`: distinct colours across the
  selection's INLINE bags, bucketed by authored text, with "N uses" and a
  one-undo-step recolour. Inline-only (a class colour's honest target is the
  class) and literal-text matching (`#fff` ≠ `rgb(255,255,255)` — bucketing them
  would rewrite text the user never asked us to touch).
- `multiSelectNodes.ts` — the selection→nodes resolution lifted out of
  `MultiInlineStyleComposer` so both consumers share one set of rules.

**CUT, deliberately, and named:** `AlignGrid`'s 3×3 and Clip content's checkbox
have no indeterminate affordance in their primitive; inventing one for a 9-cell
grid is a design decision, not a wire-up, so both still render unset. Same for
Appearance's eye/blend-mode header buttons (a two-state toggle). Documented in
`inspector-disclosure.md` §9.3.

**Needs human dogfood** (no e2e for UI): at `/admin/site`, select 2+ layers.
1. Set `padding` differently on two layers → the padding fields read **Mixed**,
   not blank. Repeat for width, position, corner radius, stroke weight, fill.
2. Give both layers the same class → the chip's class pill is now a BUTTON.
   Click it: with the class only on those two, it switches straight to the class
   composer; with a third element carrying it elsewhere, an inline gate says
   *"…is used by 1 other element outside this selection…"* — Cancel keeps
   Element, Edit switches.
3. With differing colours set inline, a **Selection colors** list appears under
   the sections; recolour a swatch → every layer that used it changes and ONE
   Ctrl+Z reverts all of them.
4. A layer whose `style` prop is code-valued: the affected row should read
   *"Writes to 1 of 2 selected layers…"* and stay editable.

**Verification:** `tsc -p tsconfig.app.json --noEmit` clean; `eslint` clean on
all 39 touched paths; `bun test src/admin/pages/site/panels/PropertiesPanel/__tests__
src/__tests__/panels src/__tests__/editor-store` = 1451 pass / 0 fail; gates
`no-full-site-scan-in-selectors`, `no-vc-mode-branches-in-mutations`,
`centralized-site-mutation-history`, `css-token-policy`, `no-css-var-fallbacks`,
`button-primitive-usage`, `no-native-browser-dialogs`, `admin-spacing/typography-token-policy`,
`css-token-vocabulary`, `module-size-budgets` all pass. Did NOT run the full
`bun run build` / `bun run lint` (parallel-worktree `tsc` contention — per the
wave preamble).
**New tests:** `styleWriteReach`, `multiSelectClassTarget`, `selectionColors`
(pure); `multiSelectionStyleArea`, `bespokeSectionsMixed` (component);
`multiSelectInlineStyles` extended with four `setNodesInlineStylesPerNode` cases.
**One existing test updated, not broken:** `classPropertyRowWriteLock.test.tsx`
passed a bare string to the provider, which is now an object.
### perf-04 — W9-5: speed levers 1-3 (one load per turn, no live-reload wait on headless captures, Chromium prewarm)
- **Agent:** perf-hunter · **Stage:** done (typecheck + touched tests + architecture gates green; draft PR open) — **needs human dogfood**
- **Updated:** 2026-09-07 · **Branch:** `perf/agent-loop-speed-levers` off `origin/main` at `b56ff12`.

**Before/after — real numbers.** Fixture: `studio-workspace/__canonical-fixture`
scaled to **36 pages / 100 fingerprinted files**, copied to a temp dir, measured in
one Bun process (the same process shape the admin server has). Cold Chromium
measured separately with `playwright-core` on this machine.

| Measurement | Before | After |
|---|---|---|
| `loadStudioPages` cold (first call in the process) | 515 ms | 509 ms |
| `loadStudioPages` **repeat, nothing changed** | 24–32 ms (5 runs, avg 27.5) | **2.3–3.0 ms (avg 2.5)** |
| `loadStudioPages` after ONE page file edited | 163 ms | 174 ms (memo miss → full recompute; unchanged in substance) |
| workspace fingerprint check (the memo's own cost) | — | 0.7 ms / 100 files |
| `structuredClone` of a 36-page load result | — | 1.8 ms |
| live-reload bridge round trips per `studio_screenshot` / `studio_compare` / `studio_measure_element` when headless answers | **1** | **0** |
| Chromium launch paid by the first capture of a session | 251–281 ms warm-page-cache, **1486 ms** truly cold | 0 (paid on project open instead) |

**Mechanisms changed (three, one per lever):**
1. **`server/handlers/studio/studioLoadMemo.ts` (new).** A whole-result memo in
   front of `loadStudioPages`, keyed on a `relPath:size:mtimeMs` fingerprint of
   every source-relevant file `listWorkspaceFiles` walks, plus `.studio/meta.json`
   (which `EXCLUDED_WORKSPACE_DIR_NAMES` hides from that walk). `pageParseCache.ts`
   already cached the per-route ts-morph parse; this caches everything AROUND it —
   `createWorkspaceProject`, `compileProjectStyles`, the page/story directory
   walks, `loadStudioStyles`' site-wide registry, the per-page convert — which is
   the ~26 ms an agent turn was paying 4+ times over (live digest, `studio_compare`,
   `studio_screenshot`, `studio_quality_check`, the fidelity tools). Results are
   `structuredClone`d in and out: two tools holding the same `Page` graph would be
   a correctness bug, and 1.8 ms is an order of magnitude under what it saves.
   A **narrowed** load (`options.pageIds`) is served from a stored full result by
   filtering, but never stored.
2. **The live-reload wait moved to where it is actually needed.**
   `awaitStudioLiveReload` was awaited up front by `compare.ts`, `screenshot.ts`
   and `measureElement.ts` on every call. It only ever mattered to an open editor
   tab, and headless (the default since W4-2A) re-parses from disk on every
   navigation. `capture/captureFrames.ts` now owns it and pays it ONLY in the
   live-bridge fallback, behind the caller's `reloadBeforeLiveFallback` flag —
   never on the headless path and never for an explicit `source: 'live'` capture,
   whose whole point is the tab as it stands (unsaved edits included).
   `studio_measure_element` dropped it outright: `inspectFrameHeadless` has no
   live path at all, so the round trip was pure waste.
3. **`prewarmCaptureBrowser()` in `capture/browserPool.ts`,** called from
   `GET /admin/api/studio/load` (full loads only — a targeted reload is not a
   project opening). Fire-and-forget, at most one in-flight launch, skipped when
   already warm or when `rememberedLaunchFailure()` is fresh, and it arms the same
   `BROWSER_IDLE_MS` teardown a real capture does.

**Budgets added (tests, not comments):**
- `server/handlers/studio/studioLoadMemo.test.ts` — 9 cases pinning INVALIDATION:
  edited page, added page, deleted page, edited local component (the case
  `pageParseCache`'s documented one-level limit misses), changed
  `.studio/meta.json` `pagesDir`, caller mutation not leaking, and a narrowed load
  neither poisoning nor being poisoned by the memo.
- `server/ai/mcp/capture/captureFrames.test.ts` — three new cases pinning that the
  reload wait is `[]` on headless and on `source: 'live'`, and exactly one call on
  the live fallback.
- `server/ai/mcp/capture/browserPool.test.ts` (new) — prewarm launches at most one
  browser, the following capture reuses it, and a launch failure is swallowed +
  memoized so a host with no Chromium loads the board unchanged.
- `measureElement.test.ts`'s ritual test now asserts `reloadCalls` is **empty** —
  that zero is the thing that would silently regress.

**Structural change that came with it:** `StudioLoadResult`/`StudioLoadOptions`
moved to `server/handlers/studio/studioLoadContract.ts` (re-exported from
`studioPageLoad.ts`). Without it the memo and the pipeline import each other and
`no-circular-dependencies.test.ts` fails; it also put `studioPageLoad.ts` back
under the 700-line `module-size-budgets` ceiling (722 → 650).

**CUT — named, not forgotten:**
- **Lever 4 (live-reload nudge from the `PostToolUse` hook).** Needs a new
  loopback endpoint, a per-turn token mint/validate/expire lifecycle, and a new
  env var carrying origin + token into every hook subprocess — a genuine auth
  surface, not a perf tweak. `recordToolWrite.ts` has no HTTP convention to
  borrow: `stopGateCheck.ts` makes no requests either. Screens still appear at
  turn end, as before.
- **Lever 5 (warm-session effort pin)** and **lever 6 (cross-project DS guide
  cache + `DS_FILE_MAX_BYTES`)** — neither was trivially cheap; not started.
- **On-disk parse cache for the Stop-hook subprocess.** The hook is a separate
  process, so it pays the full 509 ms cold load and the in-process memo cannot
  help it. Explicitly optional in the plan row ("cut if slow"); it is the highest
  remaining win in this row.

**Landmines / what did NOT help:**
- **The memo does not help the "one file just changed" case, and cannot.** 163 ms
  before → 174 ms after. That path is a genuine recompute; the +11 ms is the
  fingerprint plus the clone. Do not try to make the memo partial — a per-page
  merge would have to re-derive the site-wide class-id registry, which is exactly
  the `canvas-14` failure.
- **`awaitStudioLiveReload` was already free when NO tab is open** (it returns
  early on a null bridge). The win in lever 2 is entirely in the dogfood case
  where the human HAS the board open — which is also the only case where the
  agent's captures were mysteriously slow. Reported as a round-trip count, not a
  millisecond number: putting a duration on a browser round trip needs a browser,
  and agents do not run Playwright for this.
- **Chromium cold launch is bimodal:** 1486 ms on a genuinely cold binary, then
  251–281 ms once the OS page cache is warm. Quote the range, not one number.
- **Batch-run test isolation:** `compare.test.ts` run ALONE fails on
  `SyntaxError: Export named 'editorBridgeScope' not found` — its
  `mock.module('../../editorBridge')` factory omits that export and only a sibling
  file's mock supplies it in a batch. Pre-existing on `origin/main`; verified by
  running the same file in a clean `origin/main` worktree.
- **22 failures in `bun test server/handlers/studio server/ai/mcp/capture
  server/ai/tools/studio server/ai/mcp/tools/studio` are identical, test-for-test,
  on `origin/main`.** Mine adds 15 passes and 0 failures. Do not chase them.

**Dogfood script (human, ~5 min):** `bun run dev`, open a project with ≥10 screens
at `/admin/site`. (1) Watch the server log/process list right after the board
loads — a `chromium` process should appear within a second or two and disappear
about five minutes later if you never capture. (2) Ask the agent to screenshot a
screen: the first capture should feel immediate rather than pausing ~1.5 s before
anything happens. (3) With the board OPEN, ask the agent for a `studio_compare` on
2–3 screens — the canvas should NOT flicker/re-read on the way into the capture
any more (that flicker was the live-reload push). (4) Then edit a file yourself
outside Studio and ask the agent to screenshot it — the new content must appear,
which is the memo invalidation working. If it shows the OLD content, that is the
fingerprint and it is a correctness bug, not a perf one: reproduce and file it.
### panel-19 — W8-4: Hug/Fill stops writing `100%` into a flex row
- **Agent:** panel-designer (`hug-fill`) · **Stage:** done (targeted tests + `tsc -p tsconfig.app.json` + eslint green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/inspector-parent-aware-sizing`, off `origin/main` at `b56ff12`.
- **The defect:** `elementSizing.ts` wrote `fit-content` / `100%` for Hug/Fill on
  every element in every container. `width: 100%` on a flex child resolves
  against the container's *content box* and ignores `gap`, so a "Fill" item in a
  gapped row overflowed the row and shoved its siblings out. The control said
  one thing; the source did another.
- **Shipped:**
  - `elementSizing.ts` is now parent-aware and its read-back is the exact mirror
    of its write. One classifier, `sizingAxisRole(axis, parent)` →
    `flex-main | flex-cross | grid | block`, and every other function takes its
    answer instead of re-deriving it. Fill writes `flex: 1 1 0` (main),
    `align-self: stretch` (cross), `justify-self`/`align-self: stretch` (grid),
    `100%` (block — the only case the old value was right). Hug writes
    `fit-content` plus `flex: 0 0 auto` on a main axis only (every other role
    stretches by default and `fit-content` alone already stops that).
  - `sizingPatch` returns a **patch**, not a single string — Fill on a flex main
    axis has to clear the axis length as well as set `flex`. `SizeSection`
    commits each entry through the same per-property `onChange` the rest of the
    section uses, so no second write path was opened.
  - **It only ever touches the axis property and the one companion its own role
    owns**, and it only clears a companion whose value is a marker this model
    itself writes — a hand-authored `align-self: center` survives a switch to
    Fixed.
  - `useSizingParentLayout.ts` (new) resolves the parent's *computed*
    `display`/`flexDirection` off a live canvas frame — same source and same
    shape as `SingleNodeAlignRow`'s `ParentLayoutInfo` (G10). Called **once**
    in `StyleSectionsEditor` and threaded to `SizeSection`, not per section.
  - Parent unresolvable → the axis stays Fixed and the Hug / Fill menu rows
    render **disabled with a named reason as their tooltip** (new
    `AddablePropertyFieldMode.disabledReason`), never hidden. Three distinct
    reasons: nothing selected, parent lives outside this file (the cross-file
    component root case), no live frame yet.
- **Decisions a future agent must not re-litigate:**
  - **`width: 100%` on a flex child reads back as `Fixed`, deliberately.** It IS
    a literal length there. Reporting it as Fill would re-create the lie in the
    read direction.
  - **`SizeSection` takes `parentLayout` as a PROP; it does not call the store.**
    That is what keeps the section unit-testable against all four parent
    layouts without a live iframe. Don't "simplify" it by moving the hook inside.
  - **The parent layout is a computed read, never a stored declaration.** Only
    `getComputedStyle` knows what a class, the cascade, and a media query
    resolved `display` to.
- **Cut (deliberate, for speed):** a mode switch that writes two properties
  files **two** undo entries, not one — `onClearProperties`-style batching for
  the mixed set+clear case does not exist and building it was out of scope for
  this row. Also cut: no `PositionConstraints`, `globals.css`, `Button` or
  `Select` changes (other agents own those this wave); no new CSS/tokens at all
  — the disabled row reuses `Button`'s existing `disabled` + `tooltip` path.
- **Files:** `src/admin/pages/site/panels/PropertiesPanel/elementSizing.ts`,
  `useSizingParentLayout.ts` (new), `SizeSection.tsx`, `StyleSectionsEditor.tsx`,
  `src/ui/components/AddablePropertyField/AddablePropertyField.tsx`,
  `__tests__/elementSizing.test.ts` (new, 46 cases incl. a full
  mode × axis × parent-layout write→read round-trip matrix),
  `__tests__/sizeSection.test.tsx`, `docs/features/inspector-disclosure.md` (G2).
- **No CSS modules touched and no tokens added.**
- **Human action needed — dogfood script:**
  1. In `studio-workspace/test4`, select a child of a **flex row with a `gap`**.
     Set Width → **Fill container**. The row must not overflow and siblings must
     not be shoved out; the source must gain `flex: 1 1 0` and lose `width`.
     Re-select the node: the Width field must still read **Fill**.
  2. Same node, Height → **Fill container** → expect `align-self: stretch`, and
     the field reads Fill on re-selection.
  3. A child of a **grid** container: Width → Fill must write `justify-self:
     stretch`, Height → Fill must write `align-self: stretch`.
  4. A child of a plain **block** container: Fill must still write `100%`.
  5. Hand-write `width: 100%` on a **flex** child. The Width field must read the
     literal `100%`, **not** the word "Fill" — that is the point of the change.
  6. Select a **component root whose parent is a call site in another file**.
     Open the Width chevron menu: *Hug contents* and *Fill container* must be
     visible, greyed, and hovering one must explain that the parent lives
     outside this file. Clicking must write nothing.
  7. Set Height → Hug, then back to **Fixed**: the box must keep the size it was
     rendering at, and a hand-written `align-self: center` on the same element
     must survive that round trip.
### panel-19 — W7: inspector ⚙ popovers ran off the bottom of the screen
- **Agent:** panel-designer (`popover-clamp`) · **Stage:** done (targeted tests + `tsc -p tsconfig.app.json` + eslint green; draft PR open) — **needs human dogfood**
- **Branch:** `fix/inspector-popover-viewport-clamp`, off `origin/main` at `b56ff12`.
- **The bug (user screenshot):** "Typography settings" opened from a ⚙ low in the Properties panel and
  its last rows (`margin-block`…) were cut off past the bottom edge of the display.
- **Root cause:** `useAnchoredFloating`/`computeFloatingPosition` only choose a *side* and clamp
  `y` against the **measured** height. For a panel taller than the available viewport there is no `y`
  that fits, so the clamp collapses to the top margin and the tail simply overflows. Two aggravators:
  the CSS ceiling was a blanket `max-height: calc(100vh - 16px)` unrelated to where the panel actually
  sits, and the measurement used `getBoundingClientRect()`, which is transform-aware and reads ~3% short
  during the `scale(0.97)` enter animation (so the panel also landed ~3% too low).
- **Shipped:**
  - `src/ui/lib/floatingViewportFit.ts` — new pure, DOM-free `fitFloatingToViewport(...)`:
    `{x, y, width, height, viewportWidth, viewportHeight, margin} → {x, y, maxHeight}`. Height stops being
    an input the layout must accommodate and becomes an output it dictates.
  - `src/ui/lib/floatingViewportFit.test.ts` — 9 unit tests for the geometry (fits / shifted up off a low
    trigger / oversized pinned + capped / negative-top guard / both horizontal edges / tiny viewport).
  - `src/ui/components/InspectorPopover/InspectorPopover.tsx` — measures its own `offsetHeight` +
    viewport into one `PopoverMetrics` state (layout effect, `ResizeObserver`, window `resize` + capture
    `scroll`; a `samePopoverMetrics` guard stops a re-render per keystroke), runs the fit, and publishes
    `--inspector-popover-x/y` **and the new `--inspector-popover-max-height`**.
  - `src/ui/components/InspectorPopover/InspectorPopover.module.css` — `max-height` now reads
    `var(--inspector-popover-max-height)`, declared in the same rule as its pre-measure default
    (`calc(100vh - 24px)`) exactly like `--inspector-popover-z-index`. **Not** a `var()` fallback.
  - Docs: `docs/features/inspector-disclosure.md` §3.1 and `docs/reference/ui-primitives.md`.
- **No new `globals.css` tokens.** The 12px edge margin is a TS constant (`VIEWPORT_MARGIN`) because it is
  positioning maths JS owns, not a themeable surface value. It is deliberately wider than
  `computeFloatingPosition`'s own 8px `viewportMargin`, so this pass always wins.
- **Cut, deliberately:** (1) `useAnchoredFloating` and `ContextMenu` were left alone — the `offsetHeight`
  vs `getBoundingClientRect()` fix is applied only in `InspectorPopover`, since switching the shared hook
  would break the rect-stubbing in `ContextMenu`'s and `InspectorPopover`'s existing tests and this PR is
  one fix. (2) A tabbed popover's `TabList` lives inside `.body`, so it scrolls away with the content
  instead of sticking under the header. Cosmetic, not the reported bug.
- **Human action needed — dogfood (~1 min):** `/admin/site`, select a text element, and **scroll the
  Properties panel so the Typography section's ⚙ sits in the bottom ~quarter of the screen**, then open
  it. The popover must sit fully on screen with ~12px clear below it, and its content must scroll inside
  rather than being clipped. Repeat once with the browser window shortened to ~600px tall (the panel
  should fill the viewport height and scroll), and once with a ⚙ near the top (position must be
  unchanged from before). Also open a nested colour popover from a Fill row to confirm neither closes the
  other.

### look-pass — W8-2: the inspector's look pass + a geometry gate that can outlive happy-dom
- **Agent:** panel-designer · **Stage:** done (typecheck + touched tests green; draft PR open) — **needs human dogfood**
- **Branch:** `feat/inspector-look-pass`, off `origin/main` at `b56ff12`.
- **Shipped (`STUDIO-WAVE7-PLAN.md` W8-2, "Look pass"):**
  - **Panel default width 360 → 290.** `PROPERTIES_PANEL_DEFAULT_WIDTH` in `uiSlice.ts`. Figma's 240
    plus this panel's rail (`--inspector-rail-w`) and a scrollbar gutter. The two-up cells go from
    ~161px to ~104, which was the loudest visual delta. `SIDEBAR_MIN_WIDTH`/`MAX` (260/520) already
    bracket 290 and are unchanged, so the drag handle still reaches the old roominess.
  - **Inspector spacing is frozen.** Eight new `--inspector-space-*` tokens in `globals.css`, pinned to
    the `--space-*` clamp FLOORS (2/3/4/5/6/8/10/12px). 310 `var(--space-*)` reads across 38 CSS modules
    under `panels/PropertiesPanel/` + `property-controls/`, plus `ui/components/Section/Section.module.css`
    and the `[data-field-skin='inspector']` rules in `Input.module.css`, now read the frozen scale.
    Chose the floor, not the max, on purpose: it is both frozen AND never larger than what shipped, so
    no section can get taller from this change alone.
  - **`Button` inspector skin.** `[data-field-skin='inspector']` squares `size="xs"`/`size="sm"` icon-only
    buttons to `--inspector-row-h` at `--inspector-field-radius`; ghost hover is `--inspector-field-bg`
    (the fill a resting field already has). `size="micro"` is deliberately exempt — it is the mark inside
    a class pill and growing it to 24 would burst the pill.
  - **`Select` inspector skin gains `font-size: var(--text-xs)`** to match `Input`. A select and an input
    share a row in nearly every two-up pair; `--text-s` beside `--text-xs` read as a misalignment.
  - **`PROPERTY_FIELD_GLYPHS` 6 → 11**: `gap`, `columnGap`, `rowGap`, `borderWidth`, `borderRadius`.
    One new hand-drawn `RowGapIcon` in `InspectorIcons` (`GapIcon` transposed) so the row/column-gap PAIR
    in the layout-settings popover differs along the axis it actually differs on. Note the table also
    grants the drag-scrub gesture, so those five are now scrubbable.
  - **The gate: `__tests__/inspectorGeometryBudget.test.tsx`** (10 tests).
- **The measurement substitution, named.** The order asked for `scrollHeight <= clientHeight` at a 900px
  viewport. **happy-dom does not lay out** — a probe of a 100px box holding a 500px child reports
  `clientHeight 0, scrollHeight 0`, so that assertion would pass for an empty panel. CSS Modules also
  resolve to `""` under `bun test`, so class-based structural queries are blind too. The substitute gates
  the two inputs a height is computed FROM: (1) every `--inspector-*` token is a literal px, no `clamp()`,
  no `vw`, and no inspector module reaches back into the fluid small steps; (2) row-count budgets — the
  rendered `<label>` count for a text node's resident panel (a `<label>` is emitted by exactly the
  caption-bearing `ControlRow` layouts and never by `bare`, so it is an exact, layout-free caption count;
  today 1, budget 2) plus a per-section caption-capable ceiling. When CI gets a real layout engine, keep
  part 1 and replace part 2 with the measurement.
- **Cut, deliberately:**
  - **The persistent chevron for collapsed sections was DROPPED mid-task** on a user-level course
    correction that asked for the opposite. Verified the requested behaviour already ships: `Section`'s
    `empty` mode renders a plain `<div>` header — no `<button>`, no chevron, no `aria-expanded`, no hover
    cross-fade — and `StyleSectionsEditor`'s `showsAsEmptyHeader` branch already passes it. Already gated
    by `__tests__/emptySectionLaw.test.tsx` case (e). **No code change was needed or made.**
  - **`bun run icons:sync` not run** — no vendored `pixel-art-icons` import was added. `RowGapIcon` is
    hand-drawn under the `icon-catalog-integrity` Gate 3 exemption for `src/ui/`.
  - **`workspaceLayout.ts:12-13` untouched.** The order named those lines, but they are
    `SIDEBAR_MIN_WIDTH`/`SIDEBAR_MAX_WIDTH`, which already bracket 290. Changing them would have narrowed
    the resize range for no reason.
  - No `--space-*` → frozen swap outside the inspector's own modules.
- **Pre-existing failures I did not cause and did not fix:**
  - `icon-catalog-integrity.test.ts` Gate 2 — `node_modules/pixel-art-icons/dist/icons/chevron-left.js`
    missing. Absent in the main checkout's vendor dist too; needs `bun run icons:sync` by whoever owns it.
  - `inspectorNumericFields.test.tsx` "corner radius" ×2 — passes per-file, fails only in the combined
    `PropertiesPanel/__tests__` + `__tests__/panels` batch. **Verified pre-existing**: reverted my
    `cssPropertyIcons.ts` change and the two still failed. This is the documented batch-run isolation flake.
- **Human action needed — dogfood at these selection states:**
  1. **Select any node.** The right panel should open at **290px**, not 360. Drag the handle: still
     260–520.
  2. **Select a text node** (a `.map` row's text, or any `<p>`). Confirm section headers, the fields under
     them, and the header icon buttons all sit on ONE 24px rhythm — the "+" / gear / eye buttons should be
     24×24 squares with a 5px radius, not 26×22 pills, and hovering one should give it the same quiet fill
     an unset field already has.
  3. **Resize the browser window wide and narrow with the panel open.** Section padding and field gutters
     must NOT change. Before this change they breathed with the viewport.
  4. **Select a flex or grid container, open the Layout settings popover (the gear).** `row-gap` and
     `column-gap` should show as two glyph-prefixed fields with NO captions above them, and the two glyphs
     must be visibly different (bars stacked vs. side by side). Drag either glyph — it should scrub.
  5. **Open Border → Advanced.** `border-width` and `border-radius` should carry in-field marks instead of
     captions, and both should scrub.
  6. **Confirm the cut:** Border / Effects / Animations with nothing set should be a STATIC title row —
     no chevron, no hover cross-fade, not clickable — with only its "+" on the right.

### panel-18 — W7-5: fact-driven onboarding checklist, empty-canvas hint, sample project
- **Agent:** studio-implementer · **Stage:** done (typecheck + touched tests green; draft PR open) — **needs human dogfood**
- **Branch:** `feat/launcher-onboarding`, off `origin/main` at `342c67d` (W7-2 / PR #51).
- **Shipped, all of `STUDIO-WAVE7-PLAN.md` §W7-5:** a `docs/design.md` "UI copy" section derived from
  `StyleCompileConsentBanner` + `DeleteProjectDialog`; `OnboardingPanel` + the ported `LiquidProgressRing`
  above the launcher grid, five steps off one TypeBox-validated `GET /admin/api/studio/onboarding`
  (`server/handlers/studio/onboardingFacts.ts`, `Promise.allSettled`, each probe soft-fails to `false`);
  per-user `localStorage` dismissal (`onboardingDismissal.ts`) and auto-hide at 5/5; `CanvasEmptyPageHint`
  over an empty frame body; `examples/studio-sample-project/` + `sampleProject.ts` +
  `POST /admin/api/studio/sample`, offered as a third path in the no-projects empty state.
- **Nothing was cut.** Two things grew beyond the letter of the order, both deliberate:
  `?mode=prototype` (consumed once and stripped by `useSiteEditorUrlSync`) so step 5's CTA really enters
  prototype mode, and `listStudioProjectDirs` extracted out of `listStudioProjects` so the facts route
  skips the per-project pages walk.
- **Decisions a future agent must not re-litigate:**
  - **Step 3's fact is git-status OR a page-verification cache, not either alone.** `pageVerification.json`
    is written ONLY by `studio_compare` (agent visual audits), so it can confirm an edit and never rule one
    out; a scaffolded project is not a git repo, so IT can never be dirty. Both are checked, cheap first
    (`existsSync` before any subprocess), capped at 5 `git status` spawns. Both cache paths are globbed —
    today's `.studio/cache/` and the `.studio/cache/agent/<hash>/` W10 moves it to.
  - **A failed facts read renders NO panel**, rather than defaulting to all-false: telling a finished user
    they have done nothing is worse than showing no checklist.
  - **Dismissal is `localStorage` keyed by user id**, not a `user_preferences` row — Studio state is not
    CMS DB state, and the launcher must decide whether to draw its largest surface without a round trip.
  - **The sample is never auto-created**, and a second click makes `Sample project 2` rather than
    overwriting the first. `sample: true` in its meta is what lets the launcher treat it as disposable.
- **Pre-existing, NOT mine:** `node_modules/pixel-art-icons/` is absent in this worktree, so
  `icon-catalog-integrity`'s 18 tests fail on icons I never touched (`plus`, `search-solid`). Every icon I
  import exists in `vendor/pixel-art-icons/icons/`.
- **Dogfood script (human, ~4 min):** `bun run dev` → `/admin/dashboard`. (1) With no projects: the empty
  state offers three paths; click "Start with the sample project" — it lands on a three-page board.
  (2) Back on the launcher the checklist shows 2/5 with "Edit an element's style" as Next. (3) Click
  "Open prototype mode" — the board must arrive in prototype mode and the URL must come back clean.
  (4) Draw a link, return, confirm step 5 ticks. (5) Dismiss, reload — it must not come back.
  (6) Delete every element on a page and confirm the empty-canvas hint appears over that frame only.

### server-20 — W7-4: drag-and-drop import, import progress + summary, trash restore/purge
- **Agent:** general-purpose · **Stage:** done (gates green; draft PR open) — **needs human dogfood**
- **Updated:** 2026-09-07 · **Branch:** `feat/launcher-import-trash-ux` off `origin/main` at `342c67d` (PR #51).
- **Shipped:** (1) drop a folder or `.zip` anywhere on the launcher →
  `LauncherDropZone.tsx` + `droppedFolderWalk.ts` (pure decider, unit-tested; prunes
  `EXCLUDED_WORKSPACE_DIR_NAMES`, refuses whole past 8k files / 200 MB rather than
  truncating), reusing `uploadProjectArchive({ kind: 'directory' })` unchanged.
  (2) `import-github` is now a POLLED JOB (`studio/githubImportRoutes.ts`, the
  `installDeps.ts` shape, no disk sidecar) + a post-import summary step shared by both
  import paths (`studio/importSummary.ts`), surfacing `pagesDirCandidates` as a picker
  that writes through the new `POST /admin/api/studio/pages-dir`.
  (3) Trash: `GET /admin/api/studio/trash`, `.../restore`, `.../purge` (`trashRoutes.ts`,
  both writes `studio.write`-gated), a "Trash (N)" launcher affordance, and
  `DeleteProjectDialog` no longer tells anyone to run `mv` in a terminal.
- **Cut, deliberately:** no SSE (the job carries four phase changes — a poll needs no
  reconnection story); no durability sidecar for an import job (the project directory IS
  the outcome, so a forgotten job 404s and the launcher listing is the honest answer); no
  browser/e2e coverage — **needs human dogfood**.
- **Dogfood script:** `bun run dev` → `/admin/dashboard`. (a) drag a real repo folder onto
  the grid, confirm the overlay, then the summary step naming framework + pages dir;
  (b) drag a folder containing `node_modules` and confirm it is not uploaded; (c) import a
  GitHub URL and watch the phase line + MB counter; (d) import a repo with no routing
  framework and switch `pagesDir` in the picker — the page count must change; (e) delete a
  project, open Trash (N), Restore it, delete again, Delete forever (two clicks).
- **Landmines:** `parseTrashEntryName` is the trash's whole manifest — it reads the slug
  and deletion instant back OUT of the `<slug>-<ISO stamp>` folder name `availableTrashPath`
  writes. Changing either half breaks Restore silently, so they live in one file. A restore
  REFUSES on a slug collision (409) rather than merging; `purgeTrashedProject` holds the
  feature's only `rmSync` and every verb re-runs the parent-comparison containment check.
  `GithubImportBodySchema`'s `pagesDir` field was DELETED (no caller, no UI, and the answer
  is unknowable at that moment) — the choice now happens post-import.
- **Pre-existing, not mine:** icon-catalog Gate 1/2 (vendored `pixel-art-icons/dist/` absent
  in this worktree), `bundle-size-budgets` skipped without a `dist/`.

### server-20 — W7-3: the launcher tile shows the project, not a folder glyph
- **Agent:** server-engineer
- **Stage:** done (gates green; draft PR open) — **needs human dogfood**
- **Updated:** 2026-09-07
- **Branch:** `feat/launcher-project-thumbnails`, off `origin/main` at `342c67d` (W7-2 / PR #51).
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W7-3 — capture each project's first screen
  headlessly, serve it with mtime caching, and rebuild the card around it.
- **Scope:** NEW `server/handlers/studio/{projectDirGuard,projectThumbnailFile,projectThumbnail,projectThumbnailQueue,projectThumbnailRoute}.ts`
  + `studio/__tests__/projectThumbnail.test.ts`; edited
  `server/handlers/{studioProjects,studioWriteback}.ts`,
  `server/handlers/studio/{projectRoutes,projectTrash,projectDuplicate}.ts`;
  NEW `src/admin/pages/dashboard/hooks/useProjectThumbnail.ts`; edited
  `src/admin/pages/dashboard/{ProjectCard.tsx,ProjectCard.module.css,DashboardPage.module.css,DashboardPage.test.tsx,hooks/useStudioProjects.ts}`;
  docs `agent-refs/{path-index,glossary}.md`, `features/studio-import.md`.
  **`server/handlers/studio.ts` was deliberately NOT touched** — it is at 699 of
  `module-size-budgets`' 700-line ceiling, which is why `GET /thumbnail` is
  registered inside `projectRoutes.ts` rather than as a new `STUDIO_SUB_ROUTERS`
  entry. Do not "tidy" that by adding an import there.
- **Done so far:**
  - `captureProjectThumbnail(dir)` → `captureFrames({ source: \'headless\' })`,
    `sharp` to 480×360, written to `.studio/thumbnail.png`. `source` is
    explicit: `auto`\'s fallback is the LIVE editor tab, and hijacking whatever
    project a user has open to refresh someone else\'s thumbnail is not a trade
    a background job gets to make.
  - **No new `CapturePurpose` was needed** and nothing under
    `server/ai/mcp/capture/` or `src/core/ai/` was touched (two other agents
    are editing those). The plan allowed for a `purpose: \'thumbnail\'` scale;
    it would have been dead weight — the capture asks for `dpr: 1`, which the
    `\'vision\'` cap never binds on, and the downscale is `sharp`\'s job after
    the fact.
  - `GET /admin/api/studio/thumbnail?dir=` — mtime+size `ETag`,
    `Last-Modified`, `must-revalidate`, 304 on a match; 404 + `no-store` while
    the capture is queued. A same-origin `<img src>`, NOT `apiBlobRequest`:
    the browser\'s own HTTP cache is the entire point of the validators.
  - `StudioProjectSummary` gains `hasThumbnail` + `thumbnailUpdatedAt` (one
    `stat`, in the single `studioProjectSummary(dir)` builder).
  - Triggers: `GET /projects` backfills every project without one; a debounced
    (15 s) refresh fires from `applyStudioEditBatch` — the single engine BOTH
    `/save` and MCP `studio_apply_edits` run through, so the agent\'s writes
    count too. Both fire-and-forget. `projectThumbnailQueue` serialises them
    (the browser pool is ONE Chromium) and memoises failures per process; a
    save clears that memo for its project.
  - `ProjectCard` is the Figma-file-tile shape now: 4:3 preview on top, name +
    badges below, ⋯ moved to the bottom row (it used to float over what is now
    a screenshot), name back to `--text-m` from W7-1\'s `--text-xl`.
- **Next step:** none for this PR. Merge after `git fetch && git merge origin/main`
  (W7-4/W7-5 also touch `DashboardPage.*`).
- **Decisions:**
  - `PROJECTS_TRASH_DIR_NAME` + the parent-comparison containment check MOVED
    out of `projectTrash.ts` into a new `projectDirGuard.ts`, because a third
    caller (`/thumbnail`) would have made three copies of a security check.
    `/delete`, `/duplicate` and `/thumbnail` all call
    `resolveWorkspaceProjectDir` now. **W7-4 (trash UX) will conflict here** —
    resolve by keeping the guard.
  - The thumbnail lives in the project\'s own `.studio/` sidecar, not a server
    cache: a duplicated, moved or un-trashed project carries its picture.
- **Landmines:**
  - `bun run build` / `tsc -b` time out in a worktree whose `node_modules/` is
    an empty shadowing directory — run `bun install` in the worktree first.
    Per-project `tsc -p tsconfig.{app,node}.json --noEmit` is the fast check.
  - A project with no `.studio/boards.json` frames short-circuits before any
    browser work. That is what makes enqueueing every project on every launcher
    render cheap, and what keeps the test suite from launching Chromium.
- **Verification:** `tsc -p tsconfig.app.json --noEmit` ✅,
  `tsc -p tsconfig.node.json --noEmit` ✅, `eslint` on every touched file ✅,
  283 tests across the 18 touched suites ✅ (17 new). Architecture gates ran:
  `css-token-policy`, `css-token-vocabulary`, `no-css-var-fallbacks`,
  `module-size-budgets`, `button-primitive-usage` all pass; the icon-catalog
  cluster and the `ai-driver-isolation` timeouts are the standing pre-existing
  failures. Full `bun run build` NOT run — see landmines.
- **Human action needed:** dogfood — open `/admin/dashboard` with two or more
  projects, confirm each tile\'s folder glyph swaps to a real screenshot within
  ~40 s, edit a screen on the board and confirm the tile updates ~15 s after
  the last save, and check the ⋯ menu + inline rename still work on the new
  card shape.
### panel-14 — W8-4: Fill edits `background-image` as N layers, honestly
- **Agent:** studio-implementer
- **Stage:** done (gates green; draft PR open) — **needs human dogfood**
- **Updated:** 2026-09-07
- **Branch:** `feat/fill-background-layers` off `origin/main`.
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W8-4, the *Fill as N layers* bullet only.
  Nothing from W8-1/2/3 or the other three W8-4 bullets (Hug/Fill, Constraints,
  Export) — they own overlapping files.
- **Scope:** new `src/admin/pages/site/panels/PropertiesPanel/backgroundLayers.ts`
  (+ its `__tests__/backgroundLayers.test.ts`); rewritten `FillSection.tsx`,
  `FillSectionParts.tsx`, `__tests__/fillSection.test.tsx`; edits to
  `fillModel.ts`, `classStyleSections.ts`, `cssControlTypes.ts`,
  `styleFamilyClassifier.ts`, `src/core/page-tree/cssPropertyBag.ts`,
  `docs/features/inspector-disclosure.md` (G6.5).
- **Done so far:**
  - **`backgroundLayers.ts` (532 lines, pure, 36 unit tests).** Applies the
    `boxShadowLayers.ts` pattern to `background-image`: quote- and depth-aware
    comma split → `{ spine, satellites }` model → byte-identical re-join via
    `backgroundModelPatch`, **or refuse** with a named reason. Refusals: a
    top-level `var()` (could expand to any layer count), unbalanced parens or an
    unterminated string, an empty segment, and any value that would be
    reformatted. `url("a,b.png")` does NOT split — the splitter tracks quotes,
    which `boxShadowLayers.ts`'s does not.
  - **Satellites are per-layer** (`backgroundSize/-Position/-Repeat/
    -Attachment/-Origin/-Clip/-BlendMode`), following CSS Backgrounds 3 §2.1:
    a shorter list repeats cyclically (`backgroundLayerSatellite` returns
    `shared: true`, and the control is labelled `"Size (all layers)"` so the
    edit that splits the list is not a surprise), a list with MORE values than
    layers is refused **per
    property** with its own reason (CSS ignores the extras, a per-layer write
    would delete them). A refusal in one satellite never hides the layer rows.
  - **`backgroundColor` is pinned bottom-most** — CSS paints it below every
    layer, so the old "Solid fill above Image fill" row order was wrong. Row
    order is now Text → Content fit → layer 1…N → Solid fill → `background`
    shorthand.
  - **`objectFit`/`objectPosition` split out** of the old
    `IMAGE_SATELLITE_PROPS` into `CONTENT_FIT_PROPS` + their own "Content fit"
    row. They size the element's own replaced content and were never background
    properties; bundling them was the conflation that made "remove the image
    fill" have to clear six unrelated things.
  - Add (prepends at index 0 = top, Figma's behaviour) / remove / reorder
    (`Alt+↑/↓`, clamped to the layer block) all carry every satellite in step.
    Removing the last layer clears every satellite; satellites left with no
    layer get a **"Background sizing"** row rather than vanishing.
  - Four properties added to `CSSPropertyBag` + `classStyleSections`'s `fill`
    entry: `backgroundAttachment`, `backgroundOrigin`, `backgroundClip`,
    `backgroundBlendMode`. Publisher emission is generic (regex allowlist in
    `classCss.ts`), so nothing else needed changing there.
- **Next step:** none for this PR. Follow-ups worth a work order: pointer
  drag-reorder for `PropertyList` (blocked on the dnd-kit migration, already
  recorded in the plan's Deferred list), and image fill via `MediaLibraryControl`
  instead of the plain URL field.
- **Decisions:**
  - **Refusal granularity is per property, not per section** — a satellite that
    cannot be split does not stop the layer rows rendering. A whole-section
    refusal for one odd `background-size` would hide six things the user can
    edit.
  - **No visibility eye, still.** §8 decision 1 in
    `docs/features/inspector-disclosure.md` is unchanged: CSS has no honest
    "disabled declaration", and neither UI-only state nor commenting out the
    user's CSS is better than omitting the eye. The work order's
    "toggle-visibility rows like Effects" is satisfied by matching Effects,
    which passes no `onToggleVisible` either. Do not "fix" this by turning the
    eye on — it would need a storage model that does not exist.
  - **A one-value satellite list is left alone** on add/remove/reorder. It
    already applies to every layer by CSS's repetition rule and stays correct at
    any layer count; expanding it would churn the user's source for nothing.
  - **Writing a satellite expands to one value per layer**, filling the others
    with the CSS initial (`auto`, `0% 0%`, `repeat`, …) — there is no CSS syntax
    for "layer 2 only". Once every layer is back at the initial the whole
    declaration is cleared, so an edit-then-undo leaves no `auto, auto, auto`.
  - Keyword lists for the satellite selects come from `getEnumOptions`
    (`cssControlTypes.ts`), not a second copy in `backgroundLayers.ts`.
  - **`writeBackgroundModel` diffs before/after and emits only the declarations
    that changed.** `onChange` is one store mutation (and one AST writeback) per
    call, so naively re-emitting all eight `background-*` properties on every
    gradient keystroke would have put seven no-op writes in the user's undo
    history. Locked by a test (`writes ONLY the declarations that changed`).
- **Landmines:**
  - `boxShadowLayers.ts`'s `splitTopLevel` is **not** quote-aware. Do not reuse
    it for anything with `url()` in it. `backgroundLayers.ts` has its own
    splitter for exactly this reason; the two are deliberately separate.
  - The layer ROW order is CSS order (first = topmost). Reversing the list for
    display would invert paint order silently — the section renders the parsed
    array as-is.
  - `insertBackgroundLayer` on a **refused** spine returns the model unchanged;
    the "Add gradient fill" button is `disabled` with a reason in that state
    rather than looking clickable and doing nothing.
  - `restructureSatellites` no-ops when the pre-edit layer count is 0. Without
    that guard, adding the first layer to an element carrying
    `background-size: cover, contain` would have deleted the declaration.
- **Verification:** `bun test` on the two touched test files: 36 + 35 pass.
  `bun run build`, full `bun test`, `bun run lint` — see the PR body for the
  end-of-task run and its triage.
- **Human action needed:** dogfood — open `/admin/site`, select a frame with a
  multi-layer background and check the six things e2e cannot:
  1. A `.tsx`/CSS class with `background-image: url(...), linear-gradient(...)`
     shows TWO Fill rows, the url one on top, and the canvas is unchanged after
     opening and closing each popover (nothing rewritten on read).
  2. `Alt+↓` on the top layer reorders the paint on the canvas, and the written
     CSS is the two layers swapped — nothing else touched.
  3. Set Size on the SECOND layer only: the source becomes
     `background-size: auto, cover`, and the first layer still renders as before.
  4. A class whose `background-image` is `var(--something)` shows ONE raw row
     with the var() reason, and "Add gradient fill" is disabled with a tooltip.
  5. `background-size: cover, contain` on a one-layer background shows a raw
     "Size" field inside the layer popover, with the extras reason — and the
     other satellites still edit per layer beside it.
  6. `backgroundColor` + layers: the solid fill row is BELOW the layers, and
     removing the last layer leaves the solid fill and the section alive.

### panel-15 — W8-2 (scrub half): one scrub engine, every numeric scrubs
- **Agent:** studio-implementer
- **Stage:** done (gates green; draft PR open) — **needs human dogfood**
- **Updated:** 2026-09-07
- **Branch:** `feat/inspector-scrub-everywhere` off `origin/main` (`0d05e1c`,
  i.e. on top of `panel-13`/PR #47).
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W8-2, the *Scrub unification* paragraph
  ONLY. The look pass (panel width 290, Button/Select inspector skins, fixed
  `--inspector-*` spacing, `PROPERTY_FIELD_GLYPHS` extension) is the other half
  of W8-2 and is **not** in this PR.

**1. One scrub engine.** `useScrubDrag`
(`src/ui/components/ScrubInput/useScrubDrag.ts`, new) is now the whole gesture:
the keyword/token refusal, the 1/10/0.1 per-pixel ladder resolved through
`nudgeStepFor`, `min`/`max`, the empty-field unit, rAF-coalesced previews, the
unmount cancel, click-with-no-movement → focus the field, and the final value
computed fresh from `pointerup`'s `clientX`. `ScrubInput` and `ScrubTokenField`
both call it.

**Why a hook and not "ScrubTokenField renders a ScrubInput"** (the work order's
literal wording): a token-aware field is an `Input` **plus an autocomplete
dropdown**, so a component that renders `ScrubInput` cannot also be
`TokenAwareInput`. The two field kinds share the state machine, not the markup.
Extracting the markup-shaped thing would have meant either killing token
autocomplete on padding/margin/gap/insets or growing `ScrubInput` a
`renderField` slot — a thin adapter hiding the wrong seam. **If you revisit
this, revisit it here; do not "finish the job" by making one render the other.**

`ScrubTokenField` lost ~55 lines of drifted copy in the process: it had **no
rAF coalescing** (a fast padding drag fired one editor-store write per
`pointermove`, i.e. per breakpoint-iframe style re-derivation, instead of one
per frame), no `min`/`max`, and its own inline `altKey ? 0.1 : shiftKey ? 10 : 1`.

**2. The ladder moved down one layer.** `BASE_NUDGE`/`SHIFT_NUDGE`/`FINE_NUDGE`
and `nudgeStepFor` are now DEFINED in `scrubMath.ts` and re-exported from
`numericNudge.ts` (whose header still explains them). Forced: `src/ui` cannot
import `src/admin`, and the gesture lives in `src/ui` — leaving the numbers in
admin guaranteed a second copy, which is precisely how the ±8 drift happened
the first time. Admin call sites are unchanged.

**3. The rule that decides which fields scrub: THE MARK IS THE HANDLE.** A
numeric row draws a scrub field when it has an in-field glyph/letterform, and a
plain typed field when it does not — because a row whose only visible name is a
caption in a column the row does not own has nothing honest to drag (and
`ControlRow` is off-limits this PR). Consequence worth knowing: **adding a
property to `PROPERTY_FIELD_GLYPHS` now gives it the scrub gesture for free** —
that is the look pass's glyph-extension task delivering scrub as a side effect,
by design, not by accident.

**4. What gained the gesture.** TRBL insets (`PositionSection`), constraint
offsets (`PositionConstraints`), `gap`, all five corner radii
(`AppearanceSection`), `opacity`, `zIndex`, `fontSize`, `lineHeight`,
`letterSpacing` (`ClassPropertyRow`). `fontSize` needed a mark to grab, so it
got one: `FontSizeIcon` (new `InspectorIcons` glyph) registered in
`PROPERTY_FIELD_GLYPHS`. The TRBL/constraint direction arrows **moved from a
column beside the field into the field** — one fewer grid column, and the arrow
is now both the name and the handle (`LayoutSection.module.css`'s
`.directionIcon` and its two `data-state` rules are gone with it).

**5. Two correctness bugs found and fixed on the way** — these are the reason
to read this entry even if you don't care about scrubbing:
  - **`line-height: 1.5` was about to become `1.5px`.** Routing the generic
    numeric row through `resolveCommitValue` with a `px` default would have
    silently rewritten every ratio line-height in the user's stylesheet into a
    *different declaration* (a ratio couples to `font-size`; a length does
    not). New `isUnitlessNumberProp` (`cssControlTypes.ts`) names the three
    properties whose field unit is `''`: `opacity`, `zIndex` and `lineHeight`.
    `letterSpacing` is deliberately NOT one — `letter-spacing: 1.5` is invalid
    CSS. This also fixes a pre-existing W8-1 hole where nudging an empty
    `lineHeight` produced `1px`.
  - **Glyphless numeric rows never coerced at all.** `TextControl` committed
    raw text, so typing `50` into a border-width row emitted the invalid
    `border-width: 50` and `100/2` was written literally — the exact bug W8-1
    fixed for `ScrubInput` but not for this path. `nudgeEmptyUnit` is now
    `numericUnit`, and it drives both the nudge and a `resolveCommitValue` on
    blur, plus Enter-keeps-focus. One prop, both halves of §5.

**6. Deliberate non-implementations** (say so rather than leaving a silent gap):
  - **Grid tracks do NOT scrub.** `GridTrackControl` is a segmented count
    picker writing `repeat(N, 1fr)`, and its custom field holds a free-form
    template (`200px 1fr 200px`). A single number is not the whole value, and
    scrubbing one term of a multi-term value is rewriting CSS we only partly
    understood. `NUDGE_PROPS` has excluded grid templates since W8-1 for the
    same reason; W8-2 did not change that. Documented in §5.5.
  - **`opacity`'s drag saturates.** It is clamped to `0..1` (an improvement —
    it was unbounded), but the field is unitless `0`–`1` rather than Figma's
    `0`–`100%`, so at the shared 1-per-pixel base step a plain drag hits an end
    stop immediately; only Alt (0.1) is fine enough to be useful. The honest
    fix is the **percentage presentation**, which the look pass owns — not a
    bespoke ladder for one field, which is the thing §5.3 forbids. Flagged in
    §5.5.

- **Docs:** `docs/features/inspector-disclosure.md` §5 — §-numbers unchanged;
  §5.1 gained the `fieldUnit` paragraph, §5.3 the "where the numbers live" note,
  and a **new §5.5** ("One scrub engine, and the mark is the handle") sits after
  §5.4 and before §6. `STUDIO-FIGMA-PARITY-PLAN.md` §0a has a W8-2 row.
- **Tests:** `src/__tests__/panels/scrubTokenField.test.tsx` (11, new — real
  `PointerEvent`s against the wrapper: ladder, Alt-beats-Shift, min/max, empty
  start unit, token refusal, click-to-focus, no-op round trip, live display,
  rAF coalescing) and `src/__tests__/panels/inspectorNumericFields.test.tsx`
  (18, new — the commit path of every previously-unscrubbed field; `opacity`
  and `zIndex` are asserted to commit as **unitless numbers**, `lineHeight`'s
  ratio to survive, `letterSpacing` to still get `px`).
  `appearanceSection.test.tsx` was updated, not patched around: the radius DOM
  genuinely changed shape. **Convention worth knowing before you write the next
  panel test** — `ScrubInput` puts `data-testid` on the field WRAPPER (the shell
  that also carries the draggable mark), and gives the `<input>` `-field` and
  the mark `-label`. `Input` puts it straight on the `<input>`. So converting a
  row from `Input` to `ScrubInput` moves every existing test id up one element,
  and the edit itself now needs a blur/Enter because a scrub field commits on
  commit, not per keystroke (§5.4).
- **Verification:** `bun run build` ✅, `bun test` ✅ apart from the documented
  pre-existing set. **Two triage notes for whoever runs the gates next:**
  `no-circular-dependencies` FAILS as a 60s **timeout**, not a cycle — `bun x
  madge --circular …` run directly on this branch prints *"No circular
  dependency found"* after **82s** on this machine, i.e. the test's hang guard
  is now under the real cost of a 3 494-file graph. Not caused by this PR
  (+2 files) but it will keep firing; someone should raise the budget.
  `no-core-barrel-deep-imports` times out only inside a 163-file parallel run
  and passes on its own. Plus the known `chevron-left` icon-catalog failure.
- **NEEDS HUMAN DOGFOOD** (no e2e; happy-dom has no layout engine, so nothing
  here proves the fields *look* right). Script, ~4 minutes at `/admin/site`:
  1. Select any element. In **Position**, set `position: relative`, then drag
     the ▲/▶/▼/◀ arrow inside each inset field — the number should track the
     pointer 1:1, the canvas should follow smoothly (not stutter), and ONE undo
     should take back the whole gesture.
  2. Switch to `position: absolute` — the X/Y constraint rows appear. Drag the
     arrow in each; flip the side picker (Left→Right) and confirm the arrow
     glyph flips with it and the value MOVES rather than duplicating.
  3. **Appearance**: drag the corner-radius mark left past zero — it must stop
     at `0px`, never go negative. Expand to four corners; each drags too.
  4. **Layout**: drag the gap mark; same zero floor.
  5. **Typography**: drag `fontSize`'s new "Aa" mark, and `lineHeight` /
     `letterSpacing`. Then TYPE `1.5` into line-height and confirm the
     stylesheet gets `line-height: 1.5` — **not** `1.5px`. Type `100/2` into
     letter-spacing and confirm `50px`.
  6. Type `50` into a border-width row (Stroke → advanced) and confirm `50px`.
  7. Anywhere: hold **Shift** while dragging (10x), then **Alt** (0.1x), then
     both (Alt should win). Press **Enter** in any field — the caret must stay
     put with the text re-selected.
  8. Multi-select two nodes and confirm a `Mixed` field still refuses to drag.
### mcp-20 — W9-6: the last three bridge-bound tools go headless, and the agent gets a ruler
- **Agent:** studio-implementer
- **Stage:** done (gates green; draft PR open)
- **Updated:** 2026-09-07
- **Branch:** `feat/headless-bridge-tools` off fresh `origin/main`.
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W9-6 exactly — `studio_computed_styles`,
  `studio_set_frame_axes` and `studio_duplicate_frame_as_variant` work with no
  editor tab open; `studio_upload_asset` stays browser-side; add
  `studio_measure_element`.
- **Scope:** NEW `src/core/studio-capture/{frameInspectWire,frameInspector}.ts`,
  `src/core/ai/studioFrameToolSchemas.ts`,
  `src/admin/agentCapture/frameInspectBridge.ts`,
  `server/ai/mcp/capture/{captureSession,headlessFrameInspect}.ts`,
  `server/ai/mcp/tools/studio/{computedStyles,measureElement,frameAxesTools,uploadAssetTool}.ts`
  (+ tests). MODIFIED `headlessCapture.ts`, `editTools.ts`, `boardFrames.ts`,
  `agentToolNames.ts`, `parityMatrix.ts`, `systemPrompt.ts`, `frameGrid.ts`,
  `boardSlice.ts`, `executor.ts`, `CaptureFrame.tsx`, `main.tsx`,
  `docs/features/{agent,mcp-connectors}.md`. DELETED
  `server/ai/mcp/tools/studio/browserBridgeTools.ts`; RENAMED
  `studioBrowserBridgeTools.ts` → `studioUploadAsset.ts` (both halves).
- **Done so far:**
  - **A second wire contract on the capture page.**
    `window.__studioAgentCaptureInspect(requestJson) -> responseJson`, installed
    beside `__studioAgentCapture`, TypeBox-validated in both directions. One
    global with a discriminated request (`computedStyles` | `measure`) rather
    than two globals and two settle paths.
  - **One reader, two documents.** `@core/studio-capture`'s
    `inspectFrameDocument` is the measurement; the capture page AND the live
    canvas both run it. Two readers would mean the number
    `studio_computed_styles` reports depends on which path answered.
  - **`captureSession.ts`** extracts the five steps both drivers share (mint
    grant → warm page → navigate → settle → validate report). `headlessCapture.ts`
    keeps only the photography; `captureFrames.ts` was NOT touched (W10 owns it)
    because `headlessCapture.ts` re-exports the moved types.
  - **`studio_computed_styles`** is `execution:'server'`, headless-first with
    the live tab as fallback; `readVia` says which answered and a both-paths
    failure names BOTH reasons. **It now also works for a page with NO board
    frame at all** — `capturePayload.ts` defaults frame geometry, so the live
    path's "place a frame first" precondition is gone on the headless path.
  - **`studio_set_frame_axes` / `studio_duplicate_frame_as_variant`** are
    `execution:'server'` and write `.studio/boards.json` through
    `boardFrames.ts`'s now-exported `readBoardsFile`/`writeBoardsFile`, then
    `pushStudioLiveReload({ boardsChanged: true })` so an open tab re-reads.
    `VARIANT_GAP` moved to `@core/studio-board`'s `frameGrid.ts`, shared with
    `boardSlice.ts`.
  - **NEW `studio_measure_element`** — rendered boxes, padding/margin/border,
    and the measured gap to siblings **beside the parent's declared
    row-gap/column-gap**. That pair is the diagnosis: agreeing means the gap
    value is wrong, disagreeing means a margin is in play. Follows
    `studio_screenshot`'s three-step ritual (sync board → await live-reload →
    read) so it measures a screen the agent just wrote. Registered in the
    barrel, `agentToolNames.ts`, `parityMatrix.ts` and the system prompt.
  - **`studio_upload_asset` deliberately did not move** — it posts as the
    signed-in user, which is the one authority a server tool cannot hold.
- **Next step:** none for this entry.
- **Decisions:**
  - **One inspect global, not two.** Both new reads are "run a DOM read against
    a settled capture frame and return validated JSON". A discriminated
    request keeps one settle path, one schema pair and one driver helper.
  - **`studio_measure_element` has no live-tab fallback**, unlike
    `studio_computed_styles`. The tab is authoritative only for an unsaved
    in-progress edit; a measurement of layout the agent itself just authored
    has no such state, so a fallback would only be a slower read of the same
    file.
  - **`mutates: true` on a measurement.** It runs `syncBoardFramesFromDisk`,
    which is a write — the same trade `studio_screenshot` makes, and for the
    same reason: an agent that has to remember a placement call first will skip
    it and measure nothing.
  - **The three moved tools' schemas gained an optional `dir`.** They are
    server tools now, so they need the same `resolveToolProjectDir` fallback
    chain every other Studio tool has. The bridge relay deliberately does NOT
    forward `dir` — the tab already knows which project it has open.
- **Landmines:**
  - **`bun test src/__tests__/architecture/module-size-budgets.test.ts` fired on
    my own diff.** Adding the `studio_measure_element` schema pushed
    `src/core/ai/toolSchemas.ts` from 688 → 745 lines. Extracted the five
    frame-addressing schemas to `src/core/ai/studioFrameToolSchemas.ts`
    (629 + 129) rather than grandfathering. Anything else added to
    `toolSchemas.ts` will hit this again within ~70 lines.
  - **`editTools.ts`'s `studio_set_frames` was silently resizing nothing.** It
    called `resizeFrame(next, frame.pageId, …)`, but `resizeFrame` keys on
    `f.id` — and every frame written since WS-10 Phase 2 has a `crypto.randomUUID()`
    id. It still reported `resized: N` and success. Fixed to `frame.id` in this
    PR (same file, same family; it also lost its private third copy of
    `writeBoardsFile`). It only ever worked for legacy files where `coerceFrame`
    synthesised `id = pageId`.
  - **`createScaffoldedPage(dir, nameInput)` takes a STRING, not an options
    object**, and it already places a board frame — a test asserting the
    "no frame yet" path must delete `.studio/boards.json` after scaffolding.
  - **`safeParseValue` returns `{ ok: false, errors: [{path, message}] }`, not
    `.error`.** `safeParseJson` DOES return `.error`. Easy to mix up.
  - **`mock.module` replaces a module for EVERY file in the same `bun test`
    run**, and a factory that omits an export makes any sibling importing it
    die with `SyntaxError: Export named 'x' not found`. `measureElement.test.ts`
    and the pre-existing `compare.test.ts` both mock `./liveReloadPush`;
    completing both factories (added `pushStudioLiveReload` +
    `STUDIO_LIVE_RELOAD_TOOL_NAME`) fixed `frameAxesTools.test.ts` in a batch.
  - **`liveReloadPush.test.ts` is broken by ANY batch containing a suite that
    mocks `../../editorBridge`** — it imports the real
    `createEditorBridgeStream`. That is PRE-EXISTING (`compare.test.ts` on
    `origin/main` already does it) and `computedStyles.test.ts` follows the same
    established pattern rather than inventing a new one. **Do not "fix" it by
    stubbing more exports into the factory** — I tried; it converts a module
    error into three behavioural failures, which is worse. Rewriting
    `computedStyles.test.ts` to register a REAL bridge stream was also tried and
    times out against `awaitEditorBridgeForUser`'s reconnect windows. The real
    fix is for `liveReloadPush.test.ts` (or the mockers) to stop sharing that
    module path in one run — out of scope here, and part of the documented
    batch-isolation cluster.
- **Verification:** `bunx tsc -b` ✅ exit 0 (`bun run build`'s vite half cannot
  run in a worktree — `standing-08`). `bun run lint` ✅ clean.
  New suites: `frameInspector.test.ts` 17 pass · `headlessFrameInspect.test.ts`
  9 pass · `frameAxesTools.test.ts` 9 pass · `computedStyles.test.ts` 6 pass ·
  `measureElement.test.ts` 7 pass. `bun test src/__tests__/ai src/__tests__/agent`
  → 482 pass / 0 fail. `bun test src/admin/pages/site/agent src/core/studio-capture
  src/core/studio-board` → 163 pass / 0 fail. `bun test src/__tests__/architecture`
  → 18 fail, all the pre-existing `icon-catalog-integrity` cluster
  (`standing-01`). `bun test server/ai/mcp server/ai/tools` → 8 fail, all the
  pre-existing browser-dependent `captureFramesHeadless` / W4-2A `studio_compare`
  batch-isolation cluster; `bun test server/ai/mcp/capture/headlessCapture.test.ts`
  alone is 10 pass / 0 fail.
- **Human action needed:** **dogfood — no e2e covers any of this.** With the
  editor tab CLOSED, ask the agent to (1) `studio_computed_styles` a page and
  confirm `readVia: "headless"` with real rows; (2) `studio_measure_element` a
  page with a flex column and confirm `gapAfterPx` vs `parent.rowGapPx` read
  sensibly; (3) `studio_set_frame_axes` to RTL, then reopen `/admin/site` and
  confirm the frame is in RTL. Then with the tab OPEN, call
  `studio_duplicate_frame_as_variant` and confirm the new frame appears on the
  live board without a reload (the `boardsChanged` live-reload push). Needs
  `bunx playwright install chromium`.
### panel-14 — W7-2: the launcher card says what a project IS, and every verb that acts on it
- **Agent:** studio-implementer
- **Stage:** done (gates green; draft PR open) — **needs human dogfood**
- **Updated:** 2026-09-07
- **Branch:** `feat/launcher-card-data-verbs`, branched off `origin/main` at
  `e702497` (W7-1 / PR #44) and merged forward to `2901afe` (PR #49).
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W7-2 exactly — card data, rename from the
  launcher, duplicate, a card context menu, and ⌘K "Open project …". Nothing
  from W7-3 (thumbnails), W7-4 (import/trash) or W7-5 (onboarding), which are
  other agents' waves and all edit these same three launcher files.
- **Scope:** `server/handlers/studioProjects.ts`, `server/handlers/studio.ts`,
  `server/handlers/studio/{projectDuplicate.ts (new),projectRoutes.ts,studioMeta.ts,projectProfileSchema.ts,styleCompile.ts,styleCompileConsent.ts}`
  (+ `studio/__tests__/projectDuplicate.test.ts`, `handlers/__tests__/studio.test.ts`),
  `src/admin/pages/dashboard/{ProjectCard.tsx,ProjectCard.module.css,editedAgo.ts,editedAgo.test.ts}` (new)
  + `{DashboardPage.tsx,DashboardPage.module.css,DashboardPage.test.tsx,hooks/useStudioProjects.ts}`,
  `src/admin/pages/site/studio/styleCompileConsent.ts` (one doc pointer),
  `src/admin/spotlight/{providers/projectsProvider.ts,__tests__/projectsProvider.test.ts,scopes/rootScope.ts}`,
  `src/__tests__/architecture/button-primitive-usage.test.ts`,
  `docs/agent-refs/path-index.md`.
- **Done so far:**
  - **Card data.** `StudioProjectSummary` gains `platform`, `framework`,
    `trust`, `styleToolchains` and `editedAt`. Every field comes from reads
    `listStudioProjects` was ALREADY doing per entry and discarding (the
    `.studio/meta.json` read, the pages-dir walk) plus one `statSync` per file
    in that same walk. Nothing here probes — a probe per project on a launcher
    render is not a cost a listing should carry, so an unprobed project simply
    has no `framework` and no `styleToolchains`, and the card badges nothing.
  - **`studioProjectSummary(dir)` is the ONE builder** of that shape. The
    listing, `/create`, `/rename` and `/duplicate` all return one, so a card
    redrawn from a mutation's answer can never carry less than a card drawn
    from the listing. It also fixes a live bug: `/rename` hand-built its
    summary and recomputed `pageCount` with a bare `discoverPageFiles`, which
    reports the wrong number for a `next-app` project (that directory is full
    of `layout.tsx`/`route.ts` files that are not routes).
  - **`ProjectCard`** renders the badges + `N pages · Edited 2 days ago`, and
    carries an Open / Rename / Duplicate / Delete `ContextMenu` opened either
    from a hover/focus-revealed ⋯ button or by right-clicking the tile. Delete
    moved off the hover-only trash ghost — it was the most reachable control
    on the launcher and the most destructive verb in the product; it is still
    behind `DeleteProjectDialog`.
  - **Rename is inline**, and is the toolbar's `StudioProjectLabel` gesture
    verbatim: the name becomes an `<input>`, Enter/blur commits, Escape
    reverts, with the same `committingRef` latch (Enter blurs to commit, so
    without it the blur handler commits a second time).
    `renameStudioProject` had existed in `useStudioProjects.ts` since it was
    written, with zero launcher callers.
  - **`POST /admin/api/studio/duplicate`** (`projectDuplicate.ts`) — `cpSync`
    of the whole project minus `node_modules`, `dist`, `.next`, `.turbo` and
    `.git`, under the first free DISPLAY name, `lastOpenedAt` cleared, project
    guide regenerated. Capability-gated `studio.write` alongside `/delete`.
  - **⌘K.** `projectsProvider` on the root scope: "Open <project>" from
    anywhere in the admin, performing the launcher's own three steps
    (`requestCmsSiteReload()` → `setStudioWorkspaceDir` → navigate) rather
    than bouncing the user through `/admin/dashboard`.
  - **`lastOpenedAt`** is stamped into `.studio/meta.json` by
    `GET /admin/api/studio/load` (`recordProjectOpened`) — W7-5 step 2's
    stated dependency.
  - **`compilableStyleToolchains` moved** from `styleCompile.ts` to the
    `projectProfileSchema.ts` leaf, so the launcher can ask "will this
    project's styles render?" without importing the Tier-1 subprocess
    machinery for a six-line pure predicate. Three callers now share it.
- **Next step:** W7-3 (thumbnails), W7-4 (import/trash) and W7-5 (onboarding)
  are unblocked and may run in parallel with each other — but W7-3 redesigns
  the card around a preview image, so it owns `ProjectCard.tsx` and must not
  run beside anything else touching it.
- **Decisions:**
  - **`editedAt` stats every file under the pages dir, not the directory.**
    The plan suggested "one `statSync`", and one stat of the pages DIRECTORY
    would have been cheaper — but writing an existing file does not touch its
    parent's mtime, so that number reports the last time a page was ADDED or
    REMOVED and the card would call that "Edited". Studio's most common write
    (an inline style into a `.tsx`, a rule into a co-located `.module.css`)
    would never move it. The walk already happens for `pageCount`; the added
    cost is one `stat` per file in the pages dir, the same order as the
    `readdir` that produced the list.
  - **The trust badge is `trust === 'static' && styleToolchains.length > 0`,
    not the tier.** Every project defaults to Tier 0, so a bare "Tier 0" badge
    on every card is noise. The fact worth surfacing is the one W7-2's own
    plan text names: a project whose Tailwind/Sass/PostCSS has not run opens
    unstyled. Above Tier 0 the compile happens, so the badge would be false
    and is not rendered.
  - **The framework comes from the CACHED probe only.** `resolveProjectProfile`
    would give a better answer and also probe (and write) N projects on every
    launcher render. An absent badge is honest; a slow launcher is not.
  - **Duplicate leaves `.git` behind, and says so in the toast.** A copied
    `.git` is not a fork — it is a second working copy pointing at someone
    else's remote, and pushing from it pushes to the original's origin. The
    `.studio/` sidecar IS copied, because it is the board.
  - **The duplicate's display name is chosen BEFORE the folder slug.**
    `displayName` is what the launcher sorts and renders and the slug is a
    stable id assigned once (that split is why `/rename` exists at all).
    De-duplicating the folder first and deriving the name from it would show
    the user `acme-copy-2` as a project title.
  - **`formatEditedAgo` is its own function, not AgentPanel's
    `formatRelativeTime`.** Same input, deliberately different sentence: that
    one is a terse chip in a 290px panel ("3h"), this is a clause on a
    home-surface card. A card reading "Edited 3h" reads as truncated. Sharing
    one formatter would give one of the two call sites the wrong voice.
  - **Duplicate is capability-gated, `/create` still is not.** `/delete`'s
    module doc already calls its ungated neighbours a real gap and not a
    precedent; duplicating writes an entire second repository to the user's
    disk, so it follows `/delete`, not `/create`.
- **Landmines:**
  - **`generateStudioProjectGuide` is not read-only.** It calls
    `healMissingDesignSystem`, which applies the design-system SEED to any
    project with no `package.json` — writing `package.json` and
    `node_modules/@alm-design` into the target. The first version of
    `projectDuplicate.test.ts`'s "nothing regenerable was copied" case failed
    because of exactly this, and the `cpSync` filter was innocent. Any fixture
    in that file needs a real `package.json`.
  - **`DashboardPage.test.tsx`'s `useStudioProjects` stand-in is still a real
    hook** (`panel-12`'s landmine, still true) — and its project fixtures now
    have to carry `trust`, `styleToolchains` and `editedAt`, because the
    client schema validates them as REQUIRED. They are required deliberately:
    the server always sends them, and an optional field here would let a
    silently-changed wire shape through as `undefined`.
  - **Delete is no longer reachable by `getByRole('button', { name: 'Delete X' })`.**
    Any future test (or e2e) aiming at it must open the card's action menu
    first — `Actions for <name>` — and then click the `Delete` **menuitem**.
  - **The worktree had no `node_modules`** (`panel-12` saw the same). `bun run
    build` and the whole `icon-catalog-integrity` gate fail wholesale before
    `bun install`. Not icon drift.
- **Verification:** `bun run build` ✅, `bun run lint` ✅ (both re-run after
  merging `origin/main` up to `2901afe`). Targeted, all green:
  `server/handlers/__tests__/studio.test.ts` → 85 pass;
  `server/handlers/studio/__tests__/projectDuplicate.test.ts` → 10 pass;
  `src/admin/pages/dashboard` + `src/admin/spotlight` → 121 pass;
  `src/__tests__/architecture` → 509 pass / 1 fail (`icon-catalog-integrity`'s
  `chevron-left` sample, `standing-01`-class pre-existing).
  Full `bun test` on the pre-merge tree → 11467 pass / 39 fail, every failure
  in the two clusters `STUDIO-WAVE7-PLAN.md`'s global rules name as
  pre-existing (headless-capture / canvas batch-isolation, which pass per
  file, and the `chevron-left` icon sample). Nothing under `dashboard/`,
  `spotlight/`, `studioProjects` or `studio/` fails.
- **Human action needed:** **dogfood — every change here is visual and e2e
  covers none of it.** At `/admin/dashboard`:
  1. Confirm each tile shows its badges and an "Edited …" line, and that the
     numbers are right (rename a page file in one project, reload, and check
     the line moves — this is the claim `editedAt` makes).
  2. Open a Tier-0 project that uses Tailwind or Sass and confirm the amber
     "… not compiled" badge is there BEFORE you open it, and that it
     disappears after promoting the project from the board's consent banner.
  3. Hover a tile → ⋯ → confirm Open / Rename / Duplicate / Delete. Then
     right-click the tile and confirm the same menu appears at the pointer.
  4. Rename from the menu: the name becomes a field, Enter commits, Escape
     reverts, and the grid re-sorts under the new name after the refetch.
  5. Duplicate a REAL imported repo (one with `node_modules`) and check:
     the copy appears as "<name> copy", opening it shows the same board and
     frames, and `studio-workspace/<slug>-copy/` has no `node_modules`, no
     `.git`, and a fresh `CLAUDE.md`.
  6. Delete from the menu and confirm the dialog still names the project.
  7. ⌘K from inside the editor, type a project name, press Enter — you should
     land on that project's board with ITS pages, not the previous project's
     tree under the new directory (that is the `requestCmsSiteReload()` this
     provider makes; it is the one thing worth checking twice).
  8. Check both themes — the badges use `--bg-surface-4`/`--warning-20`, which
     are re-tuned in light.

### panel-13 — W8-1: one field model for every number in the inspector
- **Agent:** studio-implementer
- **Stage:** done (gates green; draft PR open) — **needs human dogfood**
- **Updated:** 2026-09-07
- **Branch:** `fix/inspector-field-ergonomics` off `origin/main`, merged forward
  to `f65c4ef`.
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W8-1, all six items, one PR. Nothing from
  W8-2/3/4 — they own overlapping files and must not run beside this.
- **What landed, per item:**
  1. **The bare-number bug (correctness).** `ScrubInput.commit()` wrote raw
     text, so typing `50` into Width emitted `width: 50` — not a declaration;
     the browser drops it and the user's stylesheet keeps a dead line. Commit
     now goes through `resolveCommitValue` (`scrubMath.ts`): keyword →
     untouched, number/arithmetic → evaluated and given the field's own `unit`,
     **anything else → the literal, unchanged**. `unit=''` means a genuinely
     unitless field (`FrameBulkInspector`, the frame W/H inputs).
  2. **One nudge model.** `numericNudge.ts` is now the only place the numbers
     live: 1 / 10 / 0.1, Alt beating Shift. The ±8 "8px design scale" variant
     and `FrameSizePanel`'s hand-rolled ±8 ladder are gone; `RotationRow` and
     the gradient angle dropped their bespoke ±15. `isLengthNudgeProp` →
     **`isNudgeableProp`** (the set is no longer only lengths) and gained
     `opacity` + `zIndex`, whose empty-field unit is `''` so a nudge cannot
     invent `opacity: 1px`.
  3. **Maths.** New `src/ui/components/ScrubInput/numericExpression.ts` — a
     recursive-descent evaluator for `100/2`, `100+8`, `100*2`, `(80+20)/2`,
     TypeBox-validated on the way out. `scrubMath`, `numericNudge` and
     `tokenUtils.resolveTokenValue` all call it, so one grammar serves every
     numeric field. It **refuses** mixed units (`100px + 8em`) and division by
     zero rather than guessing, and every refusal keeps the literal.
  4. **Enter keeps focus** in all three field kinds (`ScrubInput`,
     `TokenAwareInput`, `FrameSizePanel`), re-selecting the text. Found and
     fixed a real latent bug on the way: Escape's `blur()` fires before React
     re-renders the reverted draft, so the blur handler committed the very text
     Escape discarded. Both fields now guard it with a `revertingRef`. (It was
     invisible to tests because `fireEvent.focus` never sets `activeElement`,
     so the `.blur()` raised no event.)
  5. **Flip H/V** on the rotation row, writing the standalone `scale` property
     (`flipValue.ts`) for the same reason rotation writes standalone `rotate`.
     Two refusals, both disabled-with-a-reason: `transform` already carrying a
     scale-family function, and a `scale` outside the plain-number space
     (`50%`, `var()`, a z component). Rotation stays live through both.
  6. **G9 finished.** `color` → Fill (a new **Text** row, topmost, plus an "Add
     text colour" header button); `textShadow` → Effects (rows through the same
     `boxShadowLayers.ts` parser under a new `TEXT_SHADOW_GRAMMAR` — three
     lengths, no `inset` — and `EffectEditorPopover`'s `variant: 'text'`, which
     omits Spread and Inset). `TypographySection` is now literally F23's four
     rows.
- **Two things worth knowing:**
  - `rotate` and `scale` are now **real `CSSPropertyBag` members** and claimed
    by the `position` section. `RotationRow` had been writing `rotate` through
    an `as keyof CSSPropertyBag` cast, which left it invisible to the style
    search and counted as a "custom property".
  - `FillSection.tsx` hit the 700-line ceiling, so it split three ways:
    `FillSection.tsx` (which rows exist), `FillSectionParts.tsx` (swatches +
    popover bodies, components-only for `react-refresh`), `fillModel.ts` (the
    pure value model).
- **Verification:** `bun run build` ✅ · `bun run lint` ✅ · `bun test` — the
  only failures left are the two documented pre-existing ones (icon-catalog
  `chevron-left`; the canvas + headless-capture batch-isolation cluster, which
  passes per-file) plus a `flowRouting.ts` module-resolution error that is on
  `main` and untouched by this diff. New tests:
  `numericExpression.test.ts` (evaluator + commit coercion), `flipValue.test.ts`,
  the `TEXT_SHADOW_GRAMMAR` block in `boxShadowLayers.test.ts`, and the Text
  fill entry in `fillSection.test.tsx`.
- **Docs:** `docs/features/inspector-disclosure.md` gained **§5 "The field
  model"** — written into the previously-empty §5 slot precisely so no existing
  number moved (~50 files cite these by number) — plus G9.4, G10.2 and a
  refreshed status table. `STUDIO-FIGMA-PARITY-PLAN.md` §0a has a new
  "Waves 7–10" table with the W8-1 row.
- **Next step:** W8-2 (scrub unification + the look pass) is unblocked and is
  the natural follow-on — it wires scrubbing into every numeric this PR taught
  to nudge and do maths. W8-3 and W8-4 also list W8-1 as their blocker.
### panel-15 — the inspector at narrow width: the rail is no longer paved over, and an empty section is no longer an accordion
- **Agent:** panel-designer
- **Stage:** done (gates green; draft PR open; **needs a human dogfood pass**)
- **Updated:** 2026-09-07
- **Branch:** `fix/inspector-narrow-overlap-empty-sections`, cut from `origin/main`
  at `f65c4ef` and rebased onto `342c67d` (W8-1 / PR #50 and W7-2 / PR #51 landed
  mid-flight). W8-1 owns `ScrubInput`, `numericNudge`, `RotationRow` and
  `TypographySection`; this branch deliberately touches none of them.
- **Goal:** three bugs the user hit dogfooding the properties panel — (1) section
  row-end buttons drawing on top of `StyleCategoryRail` at narrow width, (2) the
  accordion affordance on sections with nothing applied, (3) W/H in Size not
  reading as equal halves.
- **Scope:** `src/styles/globals.css` (one new token),
  `src/ui/components/Section/{Section.tsx,Section.module.css}`,
  `src/ui/components/ExpandableFieldCluster/ExpandableFieldCluster.module.css`,
  `src/ui/components/AddablePropertyField/AddablePropertyField.module.css`,
  `src/admin/pages/site/panels/PropertiesPanel/{StyleSurface.module.css,PropertiesPanel.module.css,LayoutSection.module.css,SizeSection.tsx,SizeSection.module.css,StyleSectionsEditor.tsx,SpacingBoxControl/SpacingSection.module.css,__tests__/emptySectionLaw.test.tsx}`,
  `docs/{design.md,features/inspector-disclosure.md,reference/ui-primitives.md}`,
  `STUDIO-WAVE7-PLAN.md` (one W8-2 bullet corrected).
  **Does not touch** `ScrubInput`, `numericNudge`, `RotationRow`, `TypographySection` —
  W8-1 owns those.
- **Done so far:**
  - **Bug 1 — measured, not guessed.** Drove the real editor at
    `127.0.0.1:5173/admin/site` at a 260px panel (`SIDEBAR_MIN_WIDTH`) and read
    geometry back with `getBoundingClientRect`/`scrollWidth`. Four sections were
    horizontally overflowing their 217px content column: **Spacing 379px**,
    **Layout 347px**, **Stroke 295px**, **Typography 218px**. The rail is a real
    grid column (`minmax(0, 1fr) 32px`, `StyleSurface.module.css:10`) — it never
    floated — but `.surface` clips on x at the *panel* edge, so the overflow
    painted straight across the rail's icons. One CSS fact, not four bugs: a grid
    track sized `auto` takes its minimum from its items, and a grid item's own
    minimum is its content unless it says `min-width: 0`.
  - The clamp is now declared once per intrinsic-sizing wrapper:
    `Section.module.css`'s `.sectionBody` **and `.sectionBody > *`** (every section
    body passes through it), `LayoutSection`'s `.layoutSection` + `.flexBlock > *`,
    `SpacingSection`'s `.spacingSection`, and — the one that mattered most —
    `ExpandableFieldCluster`'s `.root`, which padding AND margin both mount and
    which reported a 339px minimum on its own.
  - `--inspector-rail-w: 32px` replaces the literal `32` in both surfaces that
    draw the rail (`StyleSurface`, `SelectorInspector`).
    `.surfaceContent` gains `overflow-x: clip` as the standing guarantee that the
    NEXT such control truncates instead of eating the rail. `clip`, not `hidden`:
    it must not become a second scroll container, and the Y axis stays visible.
    Every floating surface in the panel portals (ContextMenu, InspectorPopover,
    Select, Tooltip) and the sticky search bar is positioned against `.panel`, so
    nothing that must escape is caught.
  - **After:** every `[data-style-section]` has `scrollWidth === clientWidth` at
    260px and at 290px, and the rightmost content pixel is exactly the rail's
    left edge (1237 = rail `left`).
  - **Bug 2.** `Section` gains **`empty`**: no chevron, no toggle, no body,
    `children` ignored — a static header whose only control is `actions`.
    `StyleSectionGroup`'s Law-1 branch passes it instead of `children={null}`.
    Measured before: clicking an empty Animations header set `aria-expanded=true`
    and rendered a `.sectionContent` with **0 bytes of HTML**, growing the section
    33px → 43px. Measured after: no chevron, no `sectionContent`, height stays 33px.
  - The header "+"s that write a real value (Fill, Effects, Animations) now route
    through `addAndReveal` so adding the first item OPENS the section. Without it a
    user with `propertiesSectionsExpanded` off would click "+", write a fill, and
    be shown a closed section.
  - **Bug 3.** Size's W/H were always `1fr 1fr` and always equal — the mis-sizing
    was the mode chevron sitting BESIDE the field, in flow, spending ~20px of an
    82px cell on chrome next to Layout's padding row where the whole cell is field.
    The chevron is now drawn inside the field's trailing edge (the idiom
    `RevealedField`'s "−" in the same module already used), with the input padded
    clear of it. Measured at 290px: W and H are `97px` each and the ScrubInput
    shell is the full 97 (was 61 of 82).
- **Next step:** nothing required. If someone picks up W8-2, the width invariant
  now written into `docs/features/inspector-disclosure.md` §6
  (`scrollWidth === clientWidth` for every `[data-style-section]` at 260px) is
  ready to be turned into a real gate beside the §6 height gate.
- **Decisions:**
  - **`empty` on `Section`, not a chevron variant per section.** The primitive is
    told the fact ("nothing is applied"); it decides the presentation. This is
    also why `STUDIO-WAVE7-PLAN.md` W8-2's "persistent chevron for collapsed
    `collapsedWhenEmpty` sections" was rewritten in this change rather than left
    to contradict the code: a persistent chevron now belongs to a collapsed
    section that HAS content.
  - **`min-width: 0` at the source AND `overflow-x: clip` as a backstop.** Either
    alone is wrong — the clip alone would hide the bug, the clamps alone leave the
    next section free to reintroduce it silently.
  - **The chevron overlays the field rather than moving into `ScrubInput`.**
    Putting it in ScrubInput's shell means a trailing slot on ScrubInput, which
    W8-1 is actively editing. The overlay is scoped entirely to
    `AddablePropertyField.module.css` (which already styles the inner `input`
    for `.wordMode`) and only `SizeSection` consumes that component.
- **Landmines:**
  - `min-width: 0` on a flex/grid CONTAINER does not shrink its intrinsic
    contribution to whatever sizes it — it only removes its own automatic minimum.
    `ExpandableFieldCluster`'s `.row`/`.cell` both already had it and the cluster
    still reported 339px; the fix was `min-width: 0` on `.root` itself. Expect to
    walk the whole chain, not one node of it.
  - `STUDIO-WAVE7-PLAN.md` is not valid UTF-8 (`file` reports `data`) — plain
    `grep` silently matches nothing in it. Use `grep -a`.
  - Full-suite `bun test` shows the known batch-isolation cluster (~28 fails,
    canvas + architecture gates timing out at 5s under load). Per-directory they
    are green: `src/__tests__/architecture` alone = 509 pass / 1 fail (the
    pre-existing `chevron-left` icon-catalog gate).
- **Verification:** `bun run build` ✅ · `bun test src/admin/pages/site/panels/PropertiesPanel
  src/ui/components/AddablePropertyField src/ui/components/ExpandableFieldCluster
  src/__tests__/panels` → 880 pass / 0 fail · `bun test src/__tests__/architecture`
  → 509 pass / 1 pre-existing fail · `bun run lint` ✅ · live geometry measured in
  a headless Chromium at 260px and 290px (numbers above).
- **Human action needed:** dogfood `/admin/site` → select a node → drag the right
  sidebar to its 260px minimum. Check: (a) no section control touches the icon
  rail, in either theme; (b) an untouched Fill / Stroke / Effects / Animations /
  Typography header shows only its title and `+`, and hovering it offers no
  chevron; (c) clicking Fill's `+` writes a fill AND opens the section — turn
  "Expand style sections by default" OFF in Settings first, that is the case the
  reveal exists for; (d) Size's W and H read as equal halves against Layout's H/V
  padding row underneath, and each chevron still opens Fixed/Hug/Fill.

### panel-12 — W7-1: the launcher sorts, fails, and redraws honestly
- **Agent:** studio-implementer
- **Stage:** done (gates green; draft PR open)
- **Updated:** 2026-09-06
- **Branch:** `fix/launcher-polish` off `origin/main` (`8c41a40`).
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W7-1 exactly — the launcher's correctness
  bugs and its look, nothing from W7-2..W7-5. It unblocks the rest of W7, which
  all edit the same three files.
- **Scope:** `server/handlers/studioProjects.ts` (+ `server/handlers/__tests__/studio.test.ts`),
  `src/admin/pages/dashboard/{DashboardPage.tsx,DashboardPage.module.css,DashboardPage.test.tsx,hooks/useStudioProjects.ts}`,
  `src/styles/globals.css`, `docs/{design.md,reference/design-tokens.md,reference/use-async-resource.md}`.
- **Done so far:**
  - **Sort bug.** `listStudioProjects` sorted the *dirents* by folder slug and
    then mapped them to `displayName`. Rename a project and it sorts under its
    original slug forever. Now it maps first and sorts the summaries by
    `name` — the string the launcher actually renders. New test:
    "sorts by display name, not by folder slug".
  - **Infinite skeleton.** `useStudioProjects` returned `StudioProject[] | null`
    with `swallowErrors: true`, so a failed fetch rendered six skeletons
    forever. It now returns `{ projects, loading, error, refresh }`, errors are
    not swallowed, and the page renders an `EmptyState role="alert"` naming the
    failure with a "Try again" button on `refresh`. Skeletons 6 → 3.
  - **Refetch handle.** `DashboardPage`'s `created[]`/`removed[]` optimistic
    reconciliation is gone; delete awaits the server and calls `refresh()`.
    `deleteStudioProject` now resolves `void` (it still validates the
    `{ projects }` envelope) — the list on screen has exactly one origin.
  - **Look.** `.cardMeta` `--text-disabled` → `--text-subtle` (the old value is
    ~2.3:1 on `--bg-surface-2`, and it is the card's only metadata).
    `.cardName` `--text-m` → `--text-xl` + `--text-bright`. Grid track
    `minmax(200px → 240px, 1fr)`; tile padding `--space-l` → `--space-3xl`;
    hardcoded `16px` radii → `--card-radius`. Hover gains a real lift
    (`translateY(-2px)` + new `--shadow-card-hover` token, both themes) on top
    of the `-2 → -3` tone step, with `:active` putting it back down.
  - **a11y.** `aria-live="polite"` + `aria-label="Projects"` on the grid, so a
    create/import/delete redraw is announced.
- **Next step:** W7-2 (card data + project verbs). It owns the same launcher
  files plus `projectRoutes`, so it must not run beside another W7 task.
- **Decisions:**
  - **`refresh()` after delete, not the delete response's list.** The endpoint
    answers with the refreshed listing and that answer is still schema-validated,
    but handing it back to the caller invites a second, parallel copy of the
    truth — precisely the shape W7-1 was sent to delete. One extra directory
    read is cheaper than two lists that can disagree.
  - **The error state replaces the grid only when there is nothing to show**
    (`projects === null && error !== null`). A refresh that fails while a list is
    already on screen keeps the stale list rather than blanking it.
  - **New `--shadow-card-hover` token rather than a raw shadow.** Module CSS
    cannot carry rgb/hex, and `--shadow-panel-drop` is tuned for a panel
    floating far above the surface. Light theme re-tunes it: the `--scrim-*`
    family stays pure black in both themes, and 0.4-alpha black under a white
    card is a smudge. Documented in `docs/design.md` §1 and the token catalog.
- **Landmines:**
  - `DashboardPage.test.tsx`'s `useStudioProjects` stand-in is now a **real hook**
    (it holds `useState` for the redraw). A constant-returning mock cannot
    exercise a page that redraws by refetching — if you replace it with one, the
    delete test will pass for the wrong reason and then rot.
  - **The worktree had no `node_modules`.** `bun run build` and the whole
    `icon-catalog-integrity` gate fail wholesale before `bun install` — the gate
    resolves `node_modules/pixel-art-icons/dist/icons`, not `vendor/`. 18
    "failures" evaporated after installing. Do not diagnose that as icon drift.
- **Verification:** `bun run build` ✅ (after `bun install`). `bun run lint` ✅.
  `bun test` → **11445 pass / 28 fail**, every failure in the two clusters
  `STUDIO-WAVE7-PLAN.md`'s global rules name as pre-existing: the
  headless-capture / canvas batch-isolation group (`captureFramesHeadless`,
  NodeRenderer VC lock-down, breakpoint activation, pin⇄unroll, `studio_compare`
  5-page) and `icon-catalog-integrity`'s `chevron-left` sample. Nothing under
  `dashboard/` or `studioProjects` fails. Targeted:
  `bun test src/admin/pages/dashboard/DashboardPage.test.tsx` → 6 pass;
  `bun test server/handlers/__tests__/studio.test.ts` → 81 pass.
- **Human action needed:** **dogfood — every change here is visual and e2e
  covers none of it.** At `/admin/dashboard`: (1) confirm the cards are visibly
  larger and the name reads as a title, not panel chrome; (2) hover a card and
  check the 2px rise + shadow reads as pickable without feeling springy, in BOTH
  themes (the light-theme shadow is a separate value); (3) rename a project from
  the Studio toolbar, return to the launcher, and confirm it now sorts under its
  new name; (4) stop the server (or block `/admin/api/studio/projects` in
  devtools) and reload — you should get "Could not load your projects." with a
  working "Try again", never a shimmering grid; (5) delete a project and confirm
  the tile leaves after the refetch and a screen reader announces the change.
### mcp-18 — W9-1(2): `studio_computed_styles` read the frame HOST, so it returned zero rows in every real canvas
- **Agent:** studio-implementer
- **Stage:** done (gates green; draft PR open)
- **Updated:** 2026-09-06
- **Branch:** `fix/computed-styles-iframe` off fresh `origin/main`.
- **Goal:** the tool the system prompt calls the arithmetic half of the fidelity loop actually returns rows.
- **Scope:** `src/admin/pages/site/agent/studioComputedStyles.ts`, `src/admin/pages/site/agent/studioComputedStyles.test.ts`. Nothing else — the schema, the executor dispatch and the MCP bridge definition were already correct.
- **Done so far:**
  - The executor now resolves `frame.querySelector('iframe')?.contentDocument` and queries `[data-node-id]` on THAT document, and calls `getComputedStyle` on the iframe's own `defaultView`. It previously ran `frame.querySelectorAll` on the host element and read `frame.ownerDocument` — the host holds no page nodes at all, so every call since the tool shipped returned `nodeCount: 0`.
  - A missing/unmounted iframe document is now its own honest refusal ("has not finished mounting its document yet … this is NOT an empty page. Take a studio_screenshot to force the frame to settle"), in the same shape as `studio_page_diagnostics`'s `no-frame`/`no-collector` notes.
  - The test suite mounts a REAL iframe and puts the fixture nodes in its `contentDocument`. One new case (`reads the nodes inside the frame iframe, not the host document`) also plants a decoy `[data-node-id]` in the HOST viewport and asserts it is not reported; a second new case pins the not-ready refusal.
- **Next step:** none for this entry. W9-1's other three items (reference drift, the bench harness, the docs/hygiene sweep) are separate PRs.
- **Decisions:**
  - **`getComputedStyle` comes from the IFRAME's window, not the host's.** Not cosmetic: `resolvedFontFamily` walks the stack against `doc.fonts.check`, and the admin document knows nothing about the fonts the user's project loaded. Reading fonts off the host would report "Open Sans did not load" for a page where it did.
  - **Kept synchronous.** `waitForAgentRenderFrame` exists and polls, but this tool is dispatched synchronously from `executor.ts:669` and the caller already has `studio_screenshot` as the settle gesture. An honest refusal beats a silent 5s stall.
  - **No `studio_page_diagnostics`-style shared iframe helper was extracted.** Two call sites, three lines each, and the two want different things out of the iframe (a `contentWindow` for the buffer vs. a `contentDocument` + `defaultView` pair for measurement). `captureAgentRenderSnapshot` in `renderEvidence.ts` is a third, with its own `doc.body` readiness rule.
- **Landmines:**
  - **The old test passed because its fixture had no iframe** — it mounted `data-page-id > data-breakpoint-id > [data-node-id]` directly, a shape that exists nowhere in the product. Verified the rewritten suite FAILS against the unfixed executor first: **8 of 9 fail, every failure a zero-row read.** Any future fixture in this folder must mount an iframe; `studioPageDiagnostics.test.ts` was already doing it right and is the model.
  - `bun test src/__tests__/architecture` is 18 red on this base — all of them the pre-existing `icon-catalog-integrity` cluster (`standing-01`), untouched by this diff.
- **Verification:** `bunx tsc -b` ✅ exit 0 (`bun run build`'s vite half cannot run in a worktree — `standing-08`). `bun run lint` ✅ clean. `bun test src/admin/pages/site/agent` → 18 pass / 0 fail. `bun test src/__tests__/ai src/__tests__/agent` → 488 pass / 0 fail. `bun test src/__tests__/architecture` → 478 pass / 18 fail, all `icon-catalog-integrity`.
- **Human action needed:** **dogfood.** Open a project at `/admin/site`, ask the agent to call `studio_computed_styles` on a page with a board frame, and confirm it now reports real `fontSizePx`/`fontFamily` rows instead of `nodeCount: 0`. (Same-origin access is not the risk — `renderEvidence.ts` and `studioPageDiagnostics.ts` already read the same `srcDoc` iframe in production. What only a browser can show is whether the frame is settled at the moment the agent calls, i.e. how often the new not-ready refusal fires in practice.)
### test-02 — W9-1.3: `bench:agent-turn` measured one function against a fixture that no longer exists; it now measures the whole turn
- **Agent:** studio-implementer
- **Stage:** done (gates green; PR open as draft)
- **Updated:** 2026-09-06
- **Branch:** `test/agent-turn-bench` off `origin/main` (`8c41a40`).
- **Goal:** W9-1 item 3 — three shipped agent optimisations (warm CLI session pool, headless capture, the compare verdict cache) had no after-number. Extend the bench to warm-vs-cold turn, capture latency, a 5-page compare, and the per-turn MCP round-trip count, and record baselines here.
- **The corpus drift, concretely:** the bench preferred `studio-workspace/untitled` and fell back to `studio-workspace/__canonical-fixture`. `untitled` was deleted some waves ago, so every run since has silently measured the fallback while the module doc, the headline and `scripts/bench/README.md` all described the other project. The README additionally still named `generateStudioAgentRoster`, a function deleted with the subagent roster. Both are corrected; `__canonical-fixture` is now the only fixture and is named as such.
- **Scope:** `scripts/bench/benches/agent-turn.ts` (rewritten), `scripts/bench/lib/fakeClaudeCli.ts` (new), `scripts/bench/lib/captureHost.ts` (new), `scripts/bench/README.md`, `eslint.config.js`.
- **What it measures now, in the order a turn pays for it:**
  1. **Project guide** — `generateStudioProjectGuide` cold/warm, `resolveProjectProfile` uncached/cached, the design-system digest warm (unchanged from before, minus the drift).
  2. **Turn → first stream line** — the REAL `streamClaudeCli` with a fake `claude` at its `spawn` seam, cold-spawned vs. served from the warm pool.
  3. **MCP attachment per turn** — spawns, connector mints, config writes and servers-per-config, read off the real `--mcp-config` file each spawn was handed, at spawn time (the driver deletes it in its own `finally`).
  4. **Headless capture + `studio_compare`** — real Chromium, real capture route, real ts-morph parse, real `sharp` clamp, real `pixelmatch` diff.
- **BASELINE, 2026-09-06, darwin arm64 Apple M1 Pro, Bun 1.3.13, full (non-`--quick`) run, 14.4s wall:**

  | measurement | value |
  |---|---|
  | `generateStudioProjectGuide` cold | mean 24.96ms · p50 25.98ms · p95 29.53ms (n=5) |
  | `generateStudioProjectGuide` warm | mean 653µs · p50 526µs · p95 963µs (n=30) |
  | `resolveProjectProfile` uncached → cached | p50 ~3.4ms → ~35µs |
  | design-system digest warm | p50 ~320µs |
  | turn → first stream line, **cold** | mean 2.93ms · p50 1.91ms · p95 7.06ms (n=12) |
  | turn → first stream line, **warm** | mean 1.10ms · p50 930µs · p95 1.53ms (n=12) — **2.1x** |
  | warm session's own spawning turn | 3.03ms (paid once per conversation) |
  | MCP handshakes/turn, cold → warm | **3.00 → 0.23** (3 servers: `studio`, `design-system`, `figma`; 12 spawns/12 turns → 1 spawn/13 turns) |
  | Studio tool surface per `tools/list` | 47 tools · 103.7 KB of schema |
  | capture, first call (5 frames @dpr2, incl. Chromium launch) | 2.19s |
  | capture, single frame, warm browser | mean 465ms · p50 456ms (n=5) |
  | capture, 5-page batch, warm browser | mean 749ms · p50 751ms (n=5) → **150ms/frame** |
  | `studio_compare` 5 pages, cache bypassed | mean 1.69s · p50 1.67s (n=3) |
  | `studio_compare` 5 pages, verdict cache | mean 7.55ms · p50 7.77ms (n=3) — **~215x** |

- **Decisions:**
  - **The turn number is Studio's overhead, not a turn's wall time, and the module says so twice.** A fake CLI answers instantly, so what is left is guide regeneration, containment + turn routing, config dir, session-id derivation and the transcript probe, connector mint, MCP config file and argv. The real cold-path costs a fake cannot model — process startup and N MCP handshakes — are exactly what section 3 counts instead of pretending to time.
  - **"Per-turn MCP round-trip count" is measured as `spawns x servers-per-config`, off the real config file.** Standing up a real MCP client to count JSON-RPC frames would need a real connector token and a real DB for a number that is already determined by those two integers.
  - **Capture and compare run with a REAL browser or not at all.** A fake rasteriser (what `headlessCapture.test.ts` injects) would have made the section always-on and its numbers meaningless — the browser is most of what is being measured. Without `dist/agent-capture.html` or a launchable Chromium the two sections report `skipped` with the reason, the posture `benches/browser.ts` and `studioBoard.bench.ts` already take. Groups 1–3 stay fully offline.
  - **The capture route is served IN-PROCESS (`lib/captureHost.ts`), not by a spawned server.** A capture grant lives in the memory of the process that minted it, so a token minted by the bench is a bare 404 to a separately spawned server. One `Bun.serve` hands the capture namespace to the real `tryServeAgentCapture` and serves `dist/` for the entry's assets.
  - **The five compare references are sized from a probe capture, not from authored geometry.** A frame renders to its CONTENT height (390x500 authored → 390x900 rendered), and a reference of the wrong aspect makes `studio_compare` refuse the page on aspect instead of measuring it — which is what the first working draft did, five errors and zero timings.
  - **The references are solid white, so all five pages legitimately FAIL.** That is deliberate: a failing page walks the whole diff + region-scoring + worst-region path. `errorCount` is the number that must stay 0, and the report says so.
- **Landmines / handed on:**
  - **`bun run bench:agent-turn` needs `bun run build` and `bun run bench:browser:install` for its last two sections.** This machine had Playwright's chromium-headless-shell **1223** missing (1208/1228/1234 were present) — the pinned build is exact, so `bunx playwright install chromium` is a real prerequisite, not a formality.
  - **`.tmp` was not in eslint's `globalIgnores`, and running any bench then `bun run lint` failed on the FIXTURE's source.** `__canonical-fixture` contains `Math.random()` in a render path on purpose (it is what the parser's auto-select branch is tested against), and copying it into `.tmp/benchmarks/` made it lintable. `.tmp` + `.tmp-lint` are now ignored for the same reason `studio-workspace` and `.data` already are.
  - **The compare numbers are for a 5-page batch of SMALL screens on one machine.** They are a floor, not a budget — nothing gates on them yet, and nobody should turn them into a gate without a second machine's run.
- **Verification:** `bun run build` ✅ · `bun run lint` ✅ · `bun test` — see the entry's PR body for the run; failures are the standing pre-existing set (`standing-01`), none in `scripts/`.
- **Human action needed:** none. Re-run `bun run bench:agent-turn` after W9-2/W9-5 land and diff against the table above.

### server-05 — W10: agent sessions are per (account, project), and the `dir` escape is closed
- **Agent:** studio-implementer (picked up a killed agent's uncommitted worktree)
- **Stage:** done — gates green on the files touched; **UI needs human dogfood**
- **Updated:** 2026-09-07
- **Branch:** `feat/per-project-agent-sessions`, merged with `origin/main` at `f65c4ef` (#43/#44/#45). No merge conflicts — `studioProjects.ts` touched on both sides but in different functions.
- **Shipped:** migration 022 (`ai_conversations.project_key`, both dialects, nullable, no backfill, `(user_id, project_key, updated_at desc)` index) · list `?dir=` + create stamp + `chat.ts` 409/adopt · `resolveProjectDir` realpath containment throwing `ProjectDirOutsideWorkspaceError` answered once by the router, with `rethrowProjectDirRefusal(err)` first in every route-local catch-all · bound connectors refused a foreign `dir` (`ProjectDirMismatchError`) · warm pool keyed `(userId, conversationId)` + per-user cap 2 + userId in the fingerprint + hashed attachment root · `.studio/cache/agent/<userKeyHash>/{turnWrites,pageVerification}.json` with the key passed to hook subprocesses via `STUDIO_AGENT_USER_KEY` · `agentSession.effort` → `byUser` · bridge scope `site:${projectKey}` · `agentProjectDir()` as the ONE client-side project answer (bridge, create, chat) · `ConversationHistory` scoped list + collapsed "Not in this project" group.
- **Cut / not done:** no e2e or browser dogfood of the popover or the bridge reconnect (UI changes are not e2e-covered here — see the wave-train rule); `bun run lint` and the FULL `bun test` were not run to completion at the end (20 parallel `tsc` processes on this box made every long run time out) — both tsconfig projects typecheck clean (`tsc -p tsconfig.node.json --noEmit`, `tsc -p tsconfig.app.json --noEmit`) and all ~35 touched test files pass.
- **Landmines:** (1) the suite now declares `STUDIO_WORKSPACE_DIR = os.tmpdir()` once in `src/__tests__/setup.ts`, because ~50 server test files build their fixture with `mkdtempSync(join(tmpdir(), …))` and containment would otherwise refuse every one; a file needing its own root still sets and restores the variable itself (`withOutsideWorkspaceDir` in `server/handlers/__tests__/outsideWorkspaceDir.ts` does exactly that for the routes that must REFUSE an outside dir). (2) `componentBundle.test.ts` pins the root back to the repo's own `studio-workspace/` because its React-version checks need a `node_modules` above the fixture. (3) In THIS worktree `node_modules/` is essentially empty (deps resolve from the primary checkout), so `componentBundle`'s five React-version cases and `devWorkflow`'s vite-binary case fail environmentally — they are not code failures. (4) `module-size-budgets` forced three extractions: `agentConversationReset.ts`, `server/handlers/studio/studioRouteBodies.ts`, `server/siteCss.ts`.
- **Human action needed:** open two projects in two tabs, run a turn in each, and confirm (a) each tab's history shows only its own threads plus a collapsed "Not in this project", (b) a tool call in tab A never lands in tab B, (c) continuing a project-A thread from project B is refused with the 409 message rather than silently re-pointed.
### mcp-20 — W9-1(1): a pasted screenshot was silently the design spec; references now have roles, and an ambiguous page is refused
- **Agent:** studio-implementer (resumed — the first agent was killed on a session limit near the end; its uncommitted worktree was picked up, not redone)
- **Stage:** done (gates green; draft PR open)
- **Updated:** 2026-09-07
- **Branch:** `fix/design-reference-resolution`, merged up to `origin/main` (#43/#44/#45 fast-forwarded in clean, then #46/#47).
- **Goal:** W9-1 item 1 exactly — labelled/explicit references beat chat attachments, an ambiguous page is refused instead of guessed, a chat image is *context* until an explicit gesture promotes it, and `mode`/`passScore`/`maxRegionCoverage` land on the persisted shape for W9-2 to consume.
- **Scope:** `server/ai/mcp/tools/studio/{referenceResolve.ts,referenceResolve.test.ts (new),designReferenceTools.ts}`, `server/handlers/studio/{designReferenceSchema.ts,designReferenceStore.ts,turnDesignReferences.ts,referenceUpload.ts,pageWriteVerification.ts}` + their tests, `server/ai/tools/studio/{liveDigest.ts,systemPrompt.ts}`, `src/core/ai/{designReferenceImage.ts,toolSchemas.ts,designReferenceToolSchemas.ts (new),index.ts}`, `docs/features/{agent.md,mcp-connectors.md}`.
- **The bug, concretely:** `resolveDesignReference` picked the most recently registered reference while `registerTurnDesignReferences` registered EVERY chat-attached image durably. A screenshot pasted to ask a question outranked the Figma frame the page was built from. Live in `studio-workspace/test4`: the `sms` page's 375x800 frame is shadowed by a 943x294 chat crop, so `studio_compare` refuses on aspect ratio and the Stop gate can never pass again — the real design still on disk, correct, unreachable.
- **Done so far:**
  - **`role` on the persisted shape** (`designReferenceSchema.ts`): `'spec' | 'context'`, optional. `designReferenceRole()` derives it from `source` for rows written before the field (`chat-attachment` → `context`, anything else → `spec`). **No rewrite pass runs** — a row gains an explicit role only when next written. `CHAT_ATTACHMENT_REFERENCE_SOURCE` moved here from `turnDesignReferences.ts`: reading a legacy row's role back is a property of the persisted shape, not of the turn pipeline.
  - **Four-tier precedence, role first** (`referenceResolve.ts`): page-scoped `spec` → unscoped `spec` → page-scoped `context` → unscoped `context`. First non-empty tier decides; **>1 candidate in it is a refusal naming every id, its dimensions and label**, plus the `referenceId` argument that ends it. A reference scoped to a *different* page is never a candidate and gets its own message. Failures are now typed (`ResolveReferenceFailure`: `unknown-id`/`ambiguous`/`other-pages-only`/`none`).
  - **A chat attachment registers `role:'context'`**; the composer's DESIGN REFERENCE upload route and `studio_register_design_reference` both default to `'spec'`.
  - **The write-verification gate stopped giving the wrong instruction.** An ambiguous page resolves to no reference, so it used to fall into `describeUnverifiedPage`'s unarmed branch — the Stop hook blocked the turn and told the agent to *register* a design, i.e. add a third candidate to a set it already could not choose from. `PageWriteVerificationEntry.referenceAmbiguity` carries the refusal, and `describeUnverifiedPage` has a third branch ending in `studio_compare({pages:[…], referenceId:"…"})`. Same sentence in the gate and the digest, as before.
  - **`mode`/`passScore`/`maxRegionCoverage`** added to `DesignReferenceSchema`, the `@core/ai` mirror, the register tool schema and the upload route (which converts and *rejects* an unparseable numeric multipart field rather than coercing to `NaN`). Nothing reads them yet — that is W9-2.
  - **The digest and system prompt carry the role** on every `Design references registered:` entry, because the roles are what decide which entry a comparison would use. `figmaReferenceNudge` now checks for a page-scoped **spec**, not merely "a reference" — a pasted crop no longer suppresses the nudge on exactly the pages that need it.
  - Reads that must not be truncated (`resolveDesignReference`, `findDesignReferenceByContentHash`, the digest) go through the new uncapped `readAllDesignReferences`; `listDesignReferences`' cap exists to bound a tool RESULT and was silently bounding decisions.
- **Next step:** none for this entry. W9-1 item 4 (docs/hygiene) landed separately as #46.
- **Decisions:**
  - **Role outranks page scope.** Scope says which screen an image is ABOUT; role says whether it is a design at all. The composer's DESIGN REFERENCE control registers unscoped by design, so scope-first would make the deliberate control lose to any crop that happened to name the page.
  - **Ambiguity is a refusal, not a tie-break.** "Newest" is precisely the rule that shipped this bug; "oldest" fails the user who registers a corrected export. The agent holds the fact that settles it, and the refusal costs one tool call against a whole project measured against the wrong picture.
  - **A lone `context` image still resolves.** Demoting attachments must not un-arm the ruler for the paste-a-comp-and-build flow `turnDesignReferences.ts` exists to serve. What it can no longer do is outrank a spec or win a page silently.
  - **No durable "promote to spec" tool was added.** The two gestures that exist — a `referenceId` argument per call, and registering as `role:'spec'` — cover the plan's requirement, and `studio_delete_design_reference` clears a crowded page. A promote-in-place tool is a real gap only if refusals turn out to repeat across turns; deferred rather than guessed at.
  - **`toolSchemas.ts` was split, not grandfathered.** The new optional fields pushed it to 705 lines (ceiling 700). The design-reference family moved to `src/core/ai/designReferenceToolSchemas.ts` — that file documents itself as "site WRITE-tool input schemas" and these are headless server tools, so the split is by responsibility, not by line count. `DIR_INPUT_DESCRIPTION` is exported (not re-exported from the barrel) so `dir` means one thing on every Studio tool.
- **Landmines:**
  - **`registerDesignReference` is NOT idempotent** — only `registerTurnDesignReferences` de-dupes, by content hash, before calling it. Registering the same bytes twice through the tool creates a second entry and therefore an ambiguous page. This is why the ambiguity message names `studio_delete_design_reference`'s subject matter rather than suggesting a re-register.
  - **`role` is optional on disk on purpose.** An entry with no `role` is exactly the legacy shape the derivation reads; writing a speculative `'spec'` default at registration would erase the distinction. `designReferenceStore.test.ts` pins the omission.
  - **The list and read tools project `designReferenceRole(r)` onto every returned entry** so `role` is never missing in a tool result. Do not "simplify" that away — a listing showing role on some rows and not others reads as "unknown" rather than the settled fact it is.
- **Verification:** `bun run build` ✅ · `bun run lint` ✅ · `bun test` → 11467 pass / 29 fail before the split, all pre-existing (`standing-01`): the `icon-catalog-integrity` `chevron-left` case, the seven `captureFramesHeadless` + two `studio_compare` browser tests ("No Chromium available"), the canvas batch-isolation cluster, and a `flowRouting.ts` `routePrototypeLinks` export error from a parallel session. The one failure that WAS mine — `module-size-budgets` at 705 lines — is fixed by the split above; re-run green. `bun test src/core/ai src/__tests__/architecture server/handlers/studio/{designReferenceStore,pageWriteVerification}.test.ts server/ai/mcp/tools/studio/referenceResolve.test.ts` → 550 pass / 1 fail (`chevron-left`). `entryStylesheetCache.test.ts` passes in isolation, confirming its batch failure is the known flake.
- **Human action needed:** **dogfood.** Open `test4` at `/admin/site`, ask the agent to compare the `sms` page, and confirm it now measures against the 375x800 Figma frame rather than refusing on the 943x294 chat crop's aspect ratio. Then paste a second screenshot on a page with no registered design and confirm the refusal names both ids instead of picking one.

### struct-07 — W6-5: the code the wave train orphaned is deleted
- **Agent:** studio-implementer
- **Stage:** done (gates green; PR open as draft)
- **Updated:** 2026-09-06
- **Branch:** `chore/dead-code-sweep` off `origin/main` (last commit `52b0e40`, i.e. after #38/#39).
- **Goal:** delete what the workspace-deletion and prototype-reconciliation waves left behind, verified candidate by candidate rather than by running `fallow fix`.
- **`fallow:health` before → after:** score **66 C both times**. `686,032 → 684,912` LOC · dead files `10.6% → 10.3%` · unused deps `4 → 3` · dead-files deduction `-2.1 → -2.1` · unused-deps deduction `-0.5 → -0.4`. `fallow dead-code`: `421 files · 380 exports · 304 types · 1 class member` → `407 files · 373 exports · 305 types · 0 class members` (1153 → 1130 issues). **The score does not move because ~93% of the dead-file mass is `studio-workspace/` — the user's own React projects, which are data, not code.** Anyone trying to move this number should add `studio-workspace/` to `ignorePatterns` in `.fallowrc.jsonc` FIRST; until then `dead files %` is not measuring this repo.
- **Note:** `bun run fallow:health` **cannot complete on this repo today** — it is `bun run test:coverage && npx fallow health`, and `test:coverage` exits 1 on the pre-existing failures, so the `&&` short-circuits and the health report never runs. Run the two halves separately (`bun run test:coverage; bun run scripts/lcov-to-istanbul.ts; npx fallow health --coverage .coverage/coverage-final.json`).
- **Deleted (files):** `src/admin/state/useWorkspaceLayoutPersistence.ts` · `src/admin/shared/AdminSectionNavigation/{AdminSectionNavigation.tsx,index.ts}` · `src/admin/shared/fieldIcons.ts` · `src/admin/pages/site/property-controls/systemSources.ts` · `src/ui/components/FloatingActionBar/{FloatingActionBar.tsx,FloatingActionBar.module.css,index.ts}` · `src/ui/components/Image/{Image.tsx,index.ts}` · `src/ui/lib/useDelayedUnmount.ts` · `src/admin/pages/site/canvas/{BoardCommentsLayer,BoardFlowLayer,BoardGuidesLayer}/index.ts`.
- **Deleted (symbols in live files):** `workspaceLayout.ts`'s `RIGHT_SIDEBAR_DEFAULT_WIDTH`, `WorkspacePanelState`, `rightPanel`/`setRightPanel`, `dataSidebarCollapsed`/`setDataSidebarCollapsed`, `hydrateWorkspaceLayout`, `initialNonSiteLayout` (both `workspace === 'data'` branches went with them) · `workspaceLayoutStorage.ts`'s `StoredWorkspaceLayout.leftOpen` (written by the site workspace, read by nobody since the hook died — `activeLeftPanel` already carries the same fact) · `schemas.ts`'s `MediaListResponseSchema`/`DataTablesListResponseSchema`/`DataSearchResponseSchema` (their three spotlight providers are gone; only `pagesProvider`/`pluginPagesProvider`/`serverProvider`/`siteFilesProvider` remain) · `ClaudeCliWarmSession.startedAt` · devDependency `@floating-ui/dom` (Tooltip's own doc says "no @floating-ui dependency"; nothing imports it).
- **Downgraded from `export` to file-private:** `flowRouting.ts`'s `frameRect` and `usePrototypeEndpoints.ts`'s `measureNodeFrameRect` — **these two are the FRESH-ORPHAN find.** PR #38's reconciliation deleted `routePrototypeLinks` and dropped the branch's `codeLinks` approach; both helpers were exported for it and are now used only inside their own file. `siteLayoutFromSelection` likewise.
- **Stale comments corrected:** `src/admin/workspace.ts` (`'dashboard'` is the Studio launcher, not a CMS widget grid), `useSiteEditorUrlSync.ts` (nothing writes `?table=&row=` any more — the READ path stays, it is pinned by `siteEditorDataDeepLink.test.tsx` and shared with `usePersistence.ts`), `OpenLivePageButton.tsx`, `useAsyncResource.ts` (named five hooks that no longer exist), `core/data/schemas.ts` (cited a gate test that was deleted), `useDeferredClose.ts`, `useEditorLayoutPersistence.ts`. Docs: `docs/editor.md`, `docs/design.md`, `docs/reference/{ui-primitives,use-async-resource}.md`.
- **Next step:** none for this entry. Three follow-ups are named under Landmines; each is somebody else's PR.
- **Decisions:**
  - **Verified every candidate by grep before cutting; `fallow fix` was never run.** Four of the eleven files fallow called unreachable are load-bearing and were KEPT: `src/admin/agentCapture/*` and `src/admin/shareViewer/*` are real Vite entries (`agent-capture.html`, `share.html`), `server/handlers/studio/hooks/{recordToolWrite,stopGateCheck}.ts` are SPAWNED by path from `projectGuide.ts`, and `src/core/design-system-manifest/index.ts` is imported by `scripts/gen-alm-manifest.mjs` (itself flagged, itself a real build script). `server/plugins/quickjs/bootstrap/src/*` and `src/types/alm-design-system.d.ts` were never in scope. `knip` independently produced the same eleven, which is why the tool agreeing with itself is not evidence.
  - **The ~373 remaining "unused exports" were left alone deliberately.** The bulk are `export *` barrel re-exports from `@core/*`, and CLAUDE.md makes the barrel the canonical entrypoint — an unconsumed re-export there is a published API surface, not dead code. The rest is a long tail of TypeBox sub-schemas sitting next to the composite that uses them, and constants exported for symmetry. Cutting them would be a large, risky diff with no reason behind it.
  - **`workspaceLayout.ts` was reduced, not deleted.** `MediaSidebar` (inside `MediaPickerModal`, still live) reads `leftSidebarWidth`/`setLeftSidebarWidth`, and `SidebarResizeHandle` / `uiSlice` / `siteEditorLayoutPersistence` all import the width constants + `clampSidebarWidth` from it. What is gone is everything only the dead persistence hook drove.
  - **`EditorWorkspaceId` keeps `'content' | 'data' | 'media'`.** Only `'site'` is ever passed now, but the union is a *storage-key* space with values sitting in real users' `localStorage`, `workspaceFromPathname` is still called by `store.ts`, and `workspaceLayoutStorage.test.ts` pins the namespacing. Collapsing it is a separate change with its own reason.
- **Landmines / handed on:**
  - **The e2e drift W6-4 flagged is NOT mechanically fixable and was not touched.** `tests/e2e/admin-navigation.e2e.ts`, `ai.e2e.ts` and `visual-builder.e2e.ts` do not merely `goto('/admin/content')` / `/admin/users` — they drive the deleted Content workspace's UI (`content-explorer-panel`, "New post", the section-nav switcher this PR just deleted the component for) and the deleted Users route. Repointing the URLs would leave every assertion failing. Rewriting them IS writing new e2e coverage, which W6-5 was told not to do. Whoever owns e2e has to decide: rewrite against `/admin/site` + the Settings modal, or delete the specs.
  - **`src/__tests__/layout/editorLayoutPersistence.test.tsx`'s rail assertion was stale on `main` and is fixed here.** PR #22 (`a90c3fc`, W4-3) added the `git` / "Version control" item to `PRIMARY_RAIL_ITEMS`; the test's expected id/icon/accent arrays were last written by PR #18 and never updated, so it had been failing since. Diagnosed, then fixed in this PR because a red gate in a cleanup PR reads as the cleanup's fault. It is the one change here that is not dead-code removal.
  - **Three devDependencies stay flagged and were NOT removed:** `@babel/preset-typescript` (used as a string preset in three test files), `@babel/types` (never imported directly, but `@babel/core`'s own declarations resolve through it — dropping it risks a subtle `tsc` break for no gain), `@types/pixelmatch`. `@floating-ui/dom` was the only one provably safe.
  - **`fallow dead-code` still reports 3 unresolved imports and 1 unlisted dependency**, all pre-existing: `server/handlers/studio/projectMcpApprovals.test.ts` imports `./agentRosterMcpTools` and `./agentRosterTypes`, neither of which exists — that test file is broken on `main` and is a real bug, not a tooling artefact.
- **Verification:** `bunx tsc -b` ✅ (exit 0). `bun run lint` ✅ (exit 0). `bun test` (via `test:coverage`, `--parallel=4`) → **11451 pass / 5 fail**, against a baseline on the same tree of **11448 pass / 8 fail**. The three named failures after are all pre-existing: `icon-catalog-integrity`'s `chevron-left` sample (`standing-01`), and two of the canvas batch-isolation cluster (`canvasScrollUnrollPinInteraction`'s body-pin case, the selection-toolbar bubble case). The rail case that was failing before is fixed. `bun run build`'s vite half was not run (see `standing-08` for why `tsc` is invoked as `bunx`, not `npx`).
- **Human action needed:** **dogfood the two surfaces this touched that tests do not cover well.** (1) Open a media picker anywhere in the editor (e.g. an image property's "Choose from library"), drag the Folders sidebar wider and narrower, and confirm it still resizes and clamps — that sidebar is the ONLY consumer of the store this PR gutted. (2) Open the Site editor, move panels around, reload, and confirm the layout comes back — `StoredWorkspaceLayout.leftOpen` was removed from the persisted shape, and the restore path should be unaffected because `activeLeftPanel` carries it.

### panel-11 — the launcher could open a project but never remove one; now it can, recoverably
- **Agent:** studio-implementer
- **Stage:** done
- **Updated:** 2026-09-06
- **Goal:** restore the delete-a-project control the user built on the unmerged `feat/prototype-mode` branch (`801db45`). Every tile carries a delete control behind a confirmation that names the project; nothing is erased.
- **Scope:** `server/handlers/studio/projectTrash.ts` (+ `__tests__/projectTrash.test.ts`), `server/handlers/studio/projectRoutes.ts`, `server/handlers/studio.ts`, `server/handlers/studioProjects.ts`, `src/admin/pages/dashboard/{DashboardPage.tsx,DashboardPage.module.css,DashboardPage.test.tsx,DeleteProjectDialog.tsx,DeleteProjectDialog.module.css,hooks/useStudioProjects.ts}`, `docs/agent-refs/path-index.md`.
- **Done so far:**
  - `POST /admin/api/studio/delete` moves `studio-workspace/<project>/` into `studio-workspace/.trash/<folder>-<timestamp>/` with an atomic `renameSync` (same filesystem by construction), and returns the refreshed `{ projects }` so the launcher redraws from the server's answer.
  - `listStudioProjects` skips `.trash`. Without it the trash lists itself as a project, and opening that points Studio at a directory of deleted projects.
  - The dialog states where the files GO rather than promising an undo the dashboard does not have — the recovery is a `mv` the user can perform themselves.
- **Next step:** none for this entry. The branch also carried a per-PAGE trash (`pageTrash.ts` + a Trash list in the explorer) that replaced `pageDelete.ts`; that is a bigger, separate change and is NOT ported here — `main`'s `DELETE /admin/api/studio/page` is untouched.
- **Decisions:**
  - **Move, never `rmSync`.** `studio-workspace/<project>/` is the user's own repository with no other copy, and there is no undo anywhere in this stack to reach for. A trash is a PLACE the files go, not a flag on a record.
  - **No manifest, unlike `pageTrash`.** A project is one directory moved whole, and its `.studio/meta.json` travels inside it, so the moved folder is already self-describing. A manifest would record only what the folder name says and be a second thing to keep in step.
  - **`dir` is REQUIRED and never goes through `resolveProjectDir`**, whose no-dir fallback resolves to the first project on disk — on a delete that turns a client bug into deleting a project nobody named.
  - **Validation compares the resolved PARENT to the projects root**, which rejects `..`, a nested path like `<project>/pages`, and the workspace root itself in one check, and cannot be fooled by a sibling root whose name merely shares a prefix (a `startsWith` test can).
  - **Capability-gated (`studio.write`), which makes it the odd one out.** `/admin/api/studio/*` is otherwise unauthenticated. Shipping an ungated delete was not defensible; the gate here is NOT evidence the neighbours have one, and gating them is its own change.
  - **The delete control is a SIBLING of the project card**, not a child: the card is itself a `<button>` (§8.11 of the button-primitive allowlist), and a button inside a button is invalid HTML browsers silently un-nest.
- **Landmines:**
  - `tryServeStudioProjectRoutes` now takes a `runtime` and is called OUTSIDE the `STUDIO_SUB_ROUTERS` loop, next to `tryServeStudioComments` — the loop's `(req, url, pathname)` shape carries no `DbClient`, and a capability needs a session to hang off. Adding a route to this file that needs neither is still fine; adding it back to the loop is not.
  - `PROJECTS_TRASH_DIR_NAME` is deliberately NOT in `EXCLUDED_WORKSPACE_DIR_NAMES`: that set names directories to skip INSIDE a project (`node_modules`, `dist`), and this one is a sibling OF projects. Same word, different level.
- **Verification:** `bun run build` ✅. `bun run lint` ✅. `bun test server/handlers/studio/__tests__/projectTrash.test.ts` → 11 pass. `bun test src/admin/pages/dashboard/DashboardPage.test.tsx` → 4 pass. `bun test src/__tests__/architecture` → 509 pass / 1 fail (`icon-catalog-integrity`'s `chevron-left` sample, `standing-01`-class pre-existing). `bun test server/handlers/studio` → 546 pass / 1 fail in batch (`remoteAssetFetch`, which passes on its own — the known server batch flake).
- **Human action needed:** **dogfood.** Open `/admin/dashboard`, hover a project tile, press its delete control, confirm the dialog names the project and its page count, delete it, and check that `studio-workspace/.trash/<folder>-<timestamp>/` holds the folder intact and the launcher no longer lists it. Then move the folder back and reload to confirm it returns.
### canvas-12 — three features the user built were stranded on an unmerged branch; they are back on main
- **Agent:** studio-implementer
- **Stage:** done
- **Updated:** 2026-09-06
- **Goal:** restore element resize, authored prototype links + playback, and design-frame interaction suppression from the local `feat/prototype-mode` branch (19 commits, never merged), reconciled with the code-derived flow map PR #25 landed on main in the meantime.
- **Scope:** `src/admin/pages/site/canvas/{CanvasResizeHandles.tsx,resizeOffer.ts,elementResize.ts,useElementResizeDrag.ts,canvasGesture.ts,hoverSuppression.ts,CanvasHoverSuppressionInjector.tsx,useCanvasNodeInteraction.ts,usePrototypePlayback.ts,usePrototypeLinkKeyboard.ts,playbackMotion.ts,PrototypeOverlay.tsx,PrototypeScreenStack.tsx,BoardPrototypeLayer/}`, edits to `{BreakpointSelectionOverlay,CanvasSelectionOverlayInjector,CanvasContexts,CanvasFrameContexts,IframeFrameSurface,NodeRenderer,CanvasRoot,CanvasLiveSurface,CanvasModeToggle,SelectionToolbar,StudioBoardLayers,canvasNodeLookup,useIframeFrameAutoHeight,BoardFlowLayer/}`, `store/slices/{prototypeSlice,prototypeSelectors,canvasSlice}`, `studio/{prototypeActions,playNavigation,fsCodemodAdapter}`, `panels/PrototypePanel/`, `@core/{studio-prototype/playback.ts,page-tree/sourceWritability.ts}`, `src/styles/globals.css`, docs.
- **Done so far:**
  - **Element resize.** Eight handles portalled into the iframe overlay root, positioned by `BreakpointSelectionOverlay`'s RAF tick off the SAME measured rect as the selection ring. `canOfferResize` gates them on three independent refusals; `useElementResizeDrag` previews onto the element's own `style` and commits through `setNodeInlineStyles` (main's current write path, which already runs the per-property writability pre-flight). `canvasGesture` freezes the overlay anchor session and the frame auto-height refit for the length of a drag.
  - **`canWriteInlineStyleForModule` widened to `alm.*`**, and `fsCodemodAdapter` now shares it as its single gate instead of an inline `startsWith('base.')`. `src/modules/alm/register.tsx` already passes the node's inline styles to the design-system component for the CANVAS, so refusing the WRITE was the two halves disagreeing about the same node. Without this, resize is offered on almost nothing in a real (design-system-based) project.
  - **Interaction suppression.** `CanvasHoverSuppressionInjector` rewrites `:hover` to an unworn class token in the four page-content stylesheets, design frames only. `CanvasInteractionContext` gives `NodeRenderer` the frame's mode so live frames stop blurring their own fields. The activation latch is armed by the press and cleared by the click, so one press is one activation.
  - **Prototype authoring + playback.** `BoardPrototypeLayer` (element-anchored connectors, `+` handle, drag/pick, `back`/`close` chips), `usePrototypeLinkKeyboard`, the link inspector + outgoing-link list in `PrototypePanel`, `playback.ts`'s stack machine, `PrototypeScreenStack`/`PrototypeOverlay`/`playbackMotion`, and `setCanvasView` arming/disarming the player.
- **Next step:** the launcher's delete-a-project-into-a-workspace-trash (branch commits `801db45`/`30a968f`) is still unported — it is a dashboard/server concern, not a canvas one, so it wants its own PR. Everything it needs is readable at `git show feat/prototype-mode:<path>` for `server/handlers/studio/{projectTrash,pageTrash,trashRoutes}.ts`, `src/admin/pages/dashboard/DeleteProjectDialog.tsx`, `src/admin/pages/site/panels/ExplorerPanel/StudioTrashList.tsx`, `src/admin/pages/site/studio/studioTrashRequests.ts`.
- **Decisions:**
  - **Two board layers, one feature.** `BoardFlowLayer` keeps the DERIVED edges frame-to-frame (a claim about two pages, covering every page at once — measuring an element per edge is the stutter machine its own doc warns about); `BoardPrototypeLayer` draws the AUTHORED links element-anchored, because the user placed each one on a specific thing and the `+` handle has to sit beside it. One store slice, one mode, one inspector, one file on disk — this is not two prototype systems.
  - **Main's link MODEL wins over the branch's.** No `origin` discriminator on `PrototypeLink`: a derived edge has no anchor, no chosen transition and nowhere to put `evidence`, so it stays a separate `CodeFlowEdge`. The branch's `codeLinks.ts` is dropped rather than merged — main's `prototypeNavScan` + `prototypeRouteIndex` is the better answer to the same question.
  - **`createTargetlessLink` deleted rather than ported.** Main's `saveLink` already authors a `back`/`close` link when the action select says so; a second entry point for it would be two ways to do one thing.
  - **`CanvasRoot` hit the 700-line ceiling**, so the four node-interaction handlers it already bundled into one context value moved to `useCanvasNodeInteraction`.
- **Landmines:**
  - `CanvasHoverSuppressionInjector` MUST take its `requestAnimationFrame` / `MutationObserver` from the frame's window **defensively** (`view?.requestAnimationFrame?.bind(view) ?? requestAnimationFrame`, the `CanvasScrollUnrollInjector` shape). An unguarded `view.requestAnimationFrame(...)` throws in the test realm and takes every SIBLING injector's mount down with it — the symptom was `canvasScrollUnrollPinInteraction` failing on a completely unrelated assertion.
  - `applyPlayAction` must not hand back pieces of its argument: the store passes it a Mutative DRAFT, and an object assigned into a draft while still referencing that draft does not survive finalization. The symptom is precise and awful — scalars stick, the stack silently does not, and the player shows a sheet that will not close.
  - Two source-assertion gates in `inlineTextEditingWiring.test.ts` pointed at files that no longer hold the rule. One was mine (`CanvasRoot` → `useCanvasNodeInteraction`); the other (`IframeFrameSurface` → `useIframeEventForwarding`) was already stale on `main` from the perf wave's own extraction, and is fixed here because it is the same file.
  - `defaultViewportApplied` / `projectDefaultViewport.ts` from branch commit `be5c7ee` ("a mobile project opened on desktop") is deliberately NOT ported — it is an editor-preferences change with its own reason, and belongs in its own PR.
- **Verification:** `bun run build` ✅ (tsc -b + vite, exit 0). `bun run lint` ✅. `bun test src/__tests__/architecture` → 509 pass / 1 fail (`icon-catalog-integrity`'s `chevron-left` sample, `standing-01`-class pre-existing — the vendored `dist/icons` only carries the synced icons). `bun test src/__tests__/canvas` → 731 pass / 15 fail in BATCH; every failing file passes on its own (the known batch-isolation flake), verified file by file. `bun test src/core/studio-prototype src/__tests__/studio` → 228 pass / 0 fail.
- **Human action needed:** **dogfood.** Open a Studio board and check: (1) select an element, drag a corner and an edge, confirm the size lands in the `.tsx` and survives a reload; (2) confirm no handles appear on a `pkg.*` component or a component call site; (3) move the pointer across the board and confirm buttons/cards no longer light up; (4) switch to prototype mode, drag the `+` from a button onto another frame, confirm the connector; (5) click the connector, change its animation, press Delete; (6) switch to live, confirm Play is armed, click the button and confirm ONE navigation with the right motion, then Back; (7) switch back to the board and confirm clicks select again without a reload.

### panel-10 — the repo importer was unreachable from the launcher; it is now a peer of "New project"
- **Agent:** studio-implementer
- **Stage:** done
- **Updated:** 2026-09-06
- **Goal:** a user landing on `/admin/dashboard` can import an existing React repository (GitHub / `.zip` / local folder) without first scaffolding a throwaway project to reach the Studio toolbar.
- **Scope:** `src/admin/pages/dashboard/DashboardPage.{tsx,module.css}`, `src/admin/pages/site/toolbar/ImportProjectButton.tsx`, moved `src/admin/pages/site/studio/ImportProjectDialog.{tsx,module.css}` → `src/admin/shared/dialogs/ImportProjectDialog/` (+ new `LazyImportProjectDialog.tsx`, `index.ts`), `docs/agent-refs/path-index.md`, `docs/editor.md`.
- **Done so far:**
  - `ImportProjectDialog` **moved** (not copied) to `src/admin/shared/dialogs/ImportProjectDialog/`. It imports its wire clients from `@site/studio/{importGithubProject,importUploadProject,studioWorkspaceDir}` — those stay put; only the dialog changed home. `src/admin/shared/` already imports from `@site/*` in nine other places, so this is the established direction.
  - New `LazyImportProjectDialog.tsx` is the ONE `lazy()` boundary, exported through `index.ts` (which deliberately does NOT re-export `ImportProjectDialog` itself — that would pull its chunk back into both callers' eager graphs). Same pattern as `LazyModuleInserterDialog`.
  - `DashboardPage.tsx:127-136` builds both CTAs once and renders them in two places: the toolbar row (`:152-153`) and the empty state's `action` slot (`:181-182`). `DashboardPage.tsx:219-223` mounts the dialog with `onImported={() => navigate('/admin/site')}`.
  - `ImportProjectDialog`'s new optional `onImported` fires after `setStudioWorkspaceDir` + `requestCmsSiteReload`, before `onClose`. The toolbar omits it (already in the editor); the launcher passes the navigation.
  - Loading state: a `.grid` of six `.cardSkeleton` tiles wrapping `<SkeletonBlock>` (was a bare `<p>Loading projects…</p>`). Empty state: `<EmptyState variant="centered" size="large">` with both CTAs, and a separate no-search-match variant (was a bare `<p>`). `.state` deleted from the CSS module.
- **Next step:** none for this entry. If someone wants the launcher to also accept a drag-and-dropped `.zip`, `docs/audits/2026-08-06/07-drag-and-drop.md:404` already specs it against `importUploadProject.ts`.
- **Decisions:**
  - **`shared/dialogs/`, not `site/studio/`** — importing a repository is how a user *reaches* Studio, so the dialog cannot live inside the surface it is the entry to. `pages/dashboard/` would have been equally wrong in the other direction (the toolbar would then import from the dashboard).
  - **`onImported` is optional, not required** — the toolbar has genuinely nothing to do after the dialog's own workspace switch. Passing it a no-op would be the shim, not the honest shape.
  - **Kept the launcher's own toolbar row** rather than moving the CTAs into `AdminPageLayout`'s `actions` slot: the search field belongs beside them, and `actions` sits in the page header away from it.
- **Landmines:**
  - `AdminPageLayout`'s `loading` prop renders `SkeletonCards` *in place of children*, which would take the search field and both CTAs off screen during the fetch. The skeleton here is inline on purpose so the header stays stable.
  - The project tiles are a bare `<button>` by design — `button-primitive-usage.test.ts`'s §8.11 allowlist entry covers `DashboardPage.tsx`. Do not "fix" it into a `Button`.
- **Verification:** `bun run build` ✅ (tsc -b + vite, exit 0). `bun run lint` ✅ (exit 0). `bun test` → 10204 pass / 80 fail; all 80 are `standing-01`-class pre-existing (claudeCli driver suite, canvas/NodeRenderer/VC suites, `icon-catalog-integrity`'s `chevron-left` sample — the vendored `dist/icons` only carries the 244 synced icons). Confirmed pre-existing by re-running `icon-catalog-integrity` with my diff stashed: identical failure. `bun test src/__tests__/architecture` → 496 pass / 1 fail (that same icon gate). `bun test src/__tests__/architecture/bundle-size-budgets.test.ts` after a real build → 14 pass.
- **Human action needed:** **dogfood.** Open `/admin/dashboard` and check: (1) both "Import project" and "New project" sit beside the search field; (2) with zero projects, the empty state shows both CTAs; (3) hard-reload and confirm the skeleton grid appears (throttle the network if the fetch is instant) with the header stable; (4) import a small GitHub repo from the launcher and confirm it lands you in `/admin/site` with that project open; (5) open a project, then import from the Studio toolbar and confirm it still swaps the workspace in place without navigating.
### meta-07 — the first three screens a new user sees still spoke in the CMS's voice
- **Agent:** studio-implementer
- **Stage:** done
- **Updated:** 2026-09-06
- **Goal:** nothing on a first-contact surface calls this product a CMS, or calls it "ALM Figma Killer". The product is **Studio**, and the thing that fails to load is the user's React project.
- **Scope:** `src/admin/preauth/AdminPreAuthForm.tsx`, `src/admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx`, `src/admin/pages/site/toolbar/SettingsButton.tsx`, `src/admin/modals/{SiteImport/SiteImportModal,ImportHtml/ImportHtmlModal}.tsx`, `src/admin/shared/ExportDialog/ExportDialog.tsx`, `src/admin/spotlight/commands/help.ts`, `src/admin/AppLoadingScreen.tsx`, `src/ui/components/AlmLogo/AlmLogo.tsx`, `server/handlers/cms/me.ts`, `index.html`, `src/admin/pages/site/preferences/{catalog,editorPreferences}.ts`, `docs/design.md`, and the tests/e2e helpers that pinned the old strings.
- **Done so far:**
  - **Pre-auth** (`AdminPreAuthForm.tsx:41-42`): "Set Up CMS"/"Create Admin" → "Set up Studio"/"Create account"; "Admin Login"/"Sign In" → "Sign in to Studio"/"Sign in". `:128` brand fallback `'ALM Figma Killer'` → `'Studio'`.
  - **Canvas load failure** (`AdminCanvasEditorBody.tsx:222`): "Could not load CMS site" → "Could not open this project". What failed is a directory of `.tsx` under `studio-workspace/`, not a CMS document.
  - **Settings gear** (`SettingsButton.tsx:31`): `openSettings('general')` → `openSettings('preferences')`. 'general' is the CMS site's meta tags — site name, description, favicon. Both source-reading gates updated (`settingsModal.test.tsx`, `toolbar.test.ts`).
  - **Product name unified to "Studio"** in four `eyebrow=` props, the spotlight "About …" command + its copied env-info block, `AlmLogo`'s `aria-label`, `AppLoadingScreen`'s label, `index.html`'s `<title>` and pre-hydration loader label, and the TOTP `issuer` in `server/handlers/cms/me.ts:188`.
  - **Bonus, landed:** a third `theme` option, **System**. `catalog.ts:183` adds it; `editorPreferences.ts:260` adds `resolveEditorTheme(theme, prefersLight)` and a `matchMedia('(prefers-color-scheme: light)')` subscription, so `useEditorAppearancePreferences` now returns the RESOLVED theme.
- **Next step:** none for this entry. The setup form's "Site name" field (and the `setupCms({ siteName })` call under it) is still CMS-shaped — left alone deliberately, it is a data-model question, not a copy one.
- **Decisions:**
  - **`resolveEditorTheme` collapses three states into two before the stamp.** `globals.css` gates the light palette on `[data-editor-theme='light']`, and `AdminPageLayout.tsx:125` / `AdminCanvasLayout.tsx:231` each mirror the same attribute onto their own roots. Stamping a literal `system` would match no token block anywhere. The raw preference is what gets persisted and what the Select shows; only the stamp is resolved.
  - **Renamed the TOTP issuer.** The issuer is provisioning-time only — it is not an input to TOTP verification — so an already-enrolled authenticator entry keeps working; only new enrolments get the new label. Confirmed against `server/auth/mfa.ts:17-20`.
  - **No identifier renames.** `AlmLogo`, `setupCms`, `loginCms`, `CMS_API_PREFIX` are untouched. This is user-facing voice, not a refactor.
- **Landmines:**
  - The pre-auth headings are **e2e selectors**, not just copy: `tests/e2e/helpers/auth.ts` drives setup and login by accessible name. Changing this copy without changing that helper silently breaks every authenticated e2e spec. Updated here (`accessibility.e2e.ts`, `auth.e2e.ts`, `helpers/auth.ts`) but **not run** — see `standing-02`.
  - `resolveEditorTheme` deliberately falls back to dark for an unrecognised stored value. A newer build could write a theme this one has never heard of, and the old behaviour stamped it verbatim, which would have matched neither palette. Pinned by a test.
  - `src/__tests__/canvas/canvasScrollUnrollPinInteraction.test.tsx` is **timing-flaky**, not broken: consecutive runs of that one file gave 2 fails then 1 fail with an identical tree. Do not chase it as a regression.
- **Verification:** `bun run lint` ✅ (exit 0). `tsc -b` ✅ (exit 0). `bun test` → 10209 pass / 80 fail; diffed the failing-test set against a run on `feat/dashboard-import-entry` — identical except the one flaky canvas-unroll case above. All are `standing-01`-class (claudeCli driver suite, canvas/NodeRenderer/VC suites, `icon-catalog-integrity`'s `chevron-left` sample). `bun test src/__tests__/{settings,toolbar,app,admin,spotlight}` → 289 pass / 0 fail after updating the three copy-pinning gates. **Playwright not run** (`standing-02`).
- **Human action needed:** **dogfood.** (1) Log out and confirm the login heading reads "Sign in to Studio" and the button "Sign in"; on a fresh DB the setup screen reads "Set up Studio" / "Create account". (2) Click the toolbar gear and confirm it opens on **Preferences**, not General. (3) Settings → Preferences → Theme → **System**, then flip macOS between Light and Dark with the modal open and confirm the chrome repaints live, with no reload — and that reopening the modal still shows "System" selected. (4) Confirm the browser tab title reads "Studio". (5) If anyone has TOTP enrolled, confirm their existing code still verifies (it should — the issuer is not part of the algorithm).

### board-27c — canvas silently drops `color-mix()`, system colours, slash-alpha `rgb()` from a project's own CSS
- **Agent:** studio-architect
- **Stage:** design — **implemented, see `board-27e` below (this entry's design shipped unchanged from what's written here).**
- **Updated:** 2026-08-31
- **Goal:** a project's own `.css` (plus WS-2.1's compiled Tailwind/Sass/PostCSS/CSS-Modules output) renders on the canvas byte-faithful to what a real browser/build would produce — no declaration happy-dom's CSSOM can't parse (`color-mix()`, `Canvas`/`CanvasText` system colours, `rgb(0 0 0 / .2)`) silently vanishes.
- **Scope:** `server/handlers/studioCss.ts`, `server/handlers/studioPageLoad.ts`, `server/handlers/studio.ts`, `src/admin/pages/site/studio/{studioLoadStreamSchema.ts,fsCodemodAdapter.ts,styleRuleWriteback.ts}`, `src/admin/pages/site/canvas/{canvasClassCss.ts,IframeFrameSurface.tsx}`, new `src/admin/pages/site/canvas/AuthoredCssInjector.tsx`, new `src/core/page-tree/styleRuleOrigin.ts`. Deliberately does **not** touch `ClassStyleInjector.tsx`/`ProjectCssInjector.tsx`/`UserStylesheetInjector.tsx` — those are mid-edit by another agent right now (confirmed live: `ClassStyleInjector.tsx` changed on disk mid-research, adding an `isStudioMode` import); the filtering this design needs lives one level down, in `canvasClassCss.ts`'s `buildCanvasClassCSS`, specifically so it does not collide with that work.
- **Done so far:** full design only, written up below and in the assistant's final response of this session. No files created or edited except this entry.
- **Next step:** hand the work order below to `parser-surgeon` (server half: `studioCss.ts`/`studioPageLoad.ts`/`studio.ts`) and `canvas-engineer` (client half: the new injector + `canvasClassCss.ts` filter + `IframeFrameSurface.tsx` mount). Start with `src/core/page-tree/styleRuleOrigin.ts` (step 1 below) — it has no dependents yet and unblocks both halves.
- **Decisions:**
  - **Render from raw text; keep `StyleRule` for editing.** `UserStylesheetInjector.tsx` already proves the exact pattern needed (raw CSS string → `resolveViewportUnitsForCanvas` → `rewritePrefersColorScheme` → `@layer user-authored`) — this is not a new mechanism, it's applying an existing, working one to a new CSS source.
  - **The overlay renders only session-edited rules, not the full registry**, using a NEW shared predicate (`styleRuleNeedsCanvasOverlay`) built from two signals already in the codebase: the `sc-` id prefix (`styleRuleId()` in `studioCss.ts`, already independently reimplemented once in `styleRuleWriteback.ts`'s `isEditorAuthoredRuleId` — this change gives both a single shared source) and `updatedAt > 0` (already bumped by every edit action on an existing rule — verified across `propertyActions.ts`, `conditionActions.ts`, `crudActions.ts`). Full-registry overlay was considered and rejected: it would double the CSS payload for Tailwind-heavy `extraCss` and re-adds the exact CSSOM-loss risk for *unedited* rules that this fix exists to remove.
  - **Verified safe against every existing test fixture** — grepped all 14 `updatedAt: 0` `StyleRule` fixtures under `src/__tests__/canvas/`; none use an `sc-`-prefixed id, so the new filter (`!isImportedStyleRuleId(id) || updatedAt > 0`) changes nothing for any of them. This is why the id-prefix check is first in the OR, not the timestamp alone.
- **Landmines:**
  - `studioCss.ts`'s own doc comment ("Fixed at 0, the same value `parseTimestamp` falls back to") is **stale/wrong** — `parseTimestamp` (`src/core/page-tree/parseHelpers.ts:78`) falls back to `Date.now()`, not `0`. Harmless today (nothing reads it that way), but fix the comment while touching this file's `IMPORTED_RULE_TIMESTAMP` constant anyway (step 2).
  - Deleting an **imported, `kind: 'ambient'` rule** (`deleteClasses` — `src/admin/pages/site/store/slices/styleRule/registryActions.ts:168`) removes it from `site.styleRules`, but its selector's declarations are still sitting in the raw sheet (loaded once at page load) — the overlay can no longer suppress it because the rule object is gone. Named as a real, narrow gap in the RISKS section below, not fixed by the steps in this order (mitigation sketched, not required for the primary fix).
  - `canvasClassCss.ts` and `IframeFrameSurface.tsx` are shared, high-traffic files — re-diff against latest before starting; the concurrent `ClassStyleInjector.tsx` work may have touched adjacent code.
- **Verification:** design only — not run. Gate tests specified below; run `bun test`, `bun run build`, `bun run lint` once the implementer's steps land.
- **Human action needed:** none yet — dogfood note will be needed once implemented (open a project with a `color-mix()`/system-colour/slash-alpha rule and confirm it renders on canvas).

### board-27d — the CMS publisher reset was silently restyling every Studio canvas frame; scoped it to CMS pages only

- **Agent:** canvas-engineer
- **Stage:** shipped
- **Updated:** 2026-08-31
- **Goal:** `PUBLISHER_RESET_CSS` (`src/core/publisher/reset.ts`) was injected into EVERY canvas iframe by `ClassStyleInjector.tsx`, unconditionally, at `@layer reset`. It's the right baseline for a CMS-authored page (module engine, no stylesheet of its own — `render.ts`'s publish path still gets it unconditionally, untouched). It's wrong for a Studio-parsed page: "the repository is the document" means the project's own CSS, or the genuine absence of one, is the whole truth. The reset made unstyled elements — a bare `<ul>`, an unclassed heading, a table, a link — render *better* than a real browser would (UA bullets/margins/underlines silently swapped for the reset's zero-margin, no-bullet look), invisibly, for every project.
- **The discriminator:** `isStudioMode()` (`src/admin/pages/site/studio/studioMode.ts`) — read directly inside `ClassStyleInjector`'s injection effect, exactly like `BreakpointSelectionOverlay.tsx` already does. Its own doc calls it out as "the single source of truth ... used by every gate ... so they can never disagree", and it's what already decides which canvas mounts at all (`CanvasTransformLayer`: `activeBoard` truthy → `StudioBoardLayers`/multi-frame board, else → CMS breakpoint frames via `BreakpointFrame` directly) — so it's not a second, parallel signal, it's the same one everything else already reads. I considered `selectActiveBoard`/`activeBoardId !== null` (the hint in the work order) and rejected it: it's derived from `isStudioMode()` (boards only ever get loaded via `studioLiveReload.ts` once Studio mode is entered) but races it during the load window (`activeBoardId` starts `null` even inside an already-Studio-mode session, until `loadBoards()` resolves), and it's one more hop from the thing that's actually authoritative. `isStudioMode()` is a plain, non-reactive read of URL + sticky `localStorage`, same as every other studio-vs-CMS gate in this codebase (`componentizeEligibility.ts`, `PropertiesPanel.tsx`, `useModuleInsertionContext.ts`, …) — fine here because entering/leaving Studio mode is a mount-time decision (different persistence adapter, different canvas), not something that flips mid-session without a nav.
- **The fix:** `ClassStyleInjector.tsx`'s injection effect now builds `resetBlock` as `''` when `isStudioMode()`, otherwise the same `@layer ${RESET_LAYER} { ${PUBLISHER_RESET_CSS} }` as before. `CANVAS_CSS_LAYER_ORDER` (`@layer reset, vendor, user-authored;`) still opens the stylesheet either way — layer order stays pinned even with zero rules in `@layer reset`. `ProjectCssInjector` (vendor CSS) and `UserStylesheetInjector` (the project's own stylesheets) are untouched — exactly what should render in Studio mode. `src/core/publisher/reset.ts` was **not edited** — the CMS publish path (`render.ts`) still injects the same reset unconditionally into real published HTML.
- **Files touched:** `src/admin/pages/site/canvas/ClassStyleInjector.tsx` (the gate), `src/__tests__/canvas/canvasCssLayerOrder.test.tsx` (3 new tests: reset omitted under `?studio=1` and sticky `localStorage`, reset still present under `?studio=0`), `docs/agent-refs/canvas-internals.md` (frame-anatomy diagram + a new paragraph under the reset's cascade-layer explanation), `docs/features/canvas-iframe-per-frame.md` (TL;DR bullet, frame diagram, injector table row, new "The publisher reset is CMS-only" subsection).
- **Verification — real browser, not just tests** (dogfood instruction below is what to re-run, not just what I ran): logged into `http://127.0.0.1:5173/admin/login` with the local smoke account (reset its password/lockout first — see the `local-admin-login-blocked` memory), then measured computed styles via `browse js` inside the canvas iframes of the `untitled-2`/`__canonical-fixture` Studio project (`?studio=1`) and a CMS site (`?studio=0`), before and after the fix (toggled with `git stash`/`git stash pop` on just `ClassStyleInjector.tsx`, reloading between):
  - **Studio, before (bug reproduced):** `mc-classes` contained `@layer reset {`; unstyled `<body>` computed `font-family: system-ui, …` and `line-height: 24px`; a freshly-appended unstyled `<ul><li>` computed `list-style: none`.
  - **Studio, after (fixed):** `mc-classes` has NO `@layer reset {` block; unstyled `<body>` computed `font-family: Times` and `line-height: normal` (real UA defaults); a freshly-appended `<ul><li>` computed `list-style: disc`, `padding-left: 40px`; a freshly-appended `<a>` computed `color: rgb(158, 158, 255)` (UA default link blue, this project previews dark) and `text-decoration-line: underline` — i.e. genuinely unstyled, matching what a real browser renders.
  - **CMS (`?studio=0`), unchanged both before and after:** `mc-classes` still contains `@layer reset {`; body still `system-ui`/`24px`/`margin: 0`; a freshly-appended `<ul><li>` still computes `list-style: none`, `margin/padding: 0px` — the reset is fully intact for CMS pages.
- **Test/build gates:** `bun test src/__tests__/canvas/canvasCssLayerOrder.test.tsx` (7 pass), `bun test src/__tests__/canvas` (648 pass / 10 fail — the 10 failures are byte-identical on `git stash` of just my file, confirmed pre-existing: `visualComponentRefInlineBody.test.tsx`, the B3 NodeRenderer lock-down suite, `boardFrameVariantSelection`-style selection-leak tests, `canvasScrollUnrollPinInteraction.test.tsx` (named pre-existing in the work order), a canvas body context-menu test — none touch `ClassStyleInjector`/reset/layers), `npx tsc -b` clean on my files (one unrelated pre-existing error in `server/handlers/studioCss.ts`, explicitly off-limits — `board-27c` above is mid-editing that file), `npx eslint` clean on both touched source/test files.
- **Landmine for the next person touching this area:** the reset gate and `board-27c`'s planned `AuthoredCssInjector.tsx` sit right next to each other conceptually (both decide what CSS a Studio canvas frame legitimately shows) but are orthogonal — this fix decides whether the *synthetic baseline* renders at all; `board-27c` decides whether *the project's own* declarations survive happy-dom's CSSOM. Don't fold them into one gate. Also: `isStudioMode()` is a plain function, not reactive — if a future change makes Studio mode togglable WITHOUT a navigation/remount (it currently always requires one — `studioMode.ts`'s own doc), `ClassStyleInjector`'s effect deps would need `isStudioMode()`'s result added explicitly (it isn't a dependency today, matching every other non-reactive call site of this function) or the reset would go stale until some unrelated dep changed.
- **Human/dogfood action:** open `http://127.0.0.1:5173/admin/site?studio=1&project=untitled-2` (or `__canonical-fixture`) at any zoom, any of its 6 frames. Confirm: a plain `<ul>`/`<ol>` renders with real bullets/numbers if the project doesn't style it away, links render blue+underlined unless styled, and body text is NOT forced to `system-ui`/1.5 line-height (compare to a real Vite/CRA dev server for the same project — the canvas should now match it for anything the project doesn't touch). Then open a CMS page at `?studio=0` and confirm nothing changed there — no bullets, no underlines, `system-ui`, tight zero margins, same as before this change.

### board-27e — canvas silently dropped `color-mix()`/system colours/slash-alpha declarations from a project's own CSS; fixed by injecting the raw text alongside the (lossy) StyleRule registry

- **Agent:** studio-implementer
- **Stage:** done
- **Updated:** 2026-08-31
- **Goal:** `board-27c`'s work order, landed steps 1-9 together (as instructed — the order warned a partial landing between 7 and 8 ships a transient doubled-CSS-payload state).
- **Done so far (all 9 steps landed in one change):**
  1. New `src/core/page-tree/styleRuleOrigin.ts` — `IMPORTED_RULE_ID_PREFIX` (`'sc-'`), `IMPORTED_RULE_TIMESTAMP` (`0`, with the doc-comment fix the work order named: it is NOT the same value `parseTimestamp` falls back to — that's `Date.now()`), `isImportedStyleRuleId()`. Barrel-exported from `src/core/page-tree/index.ts`. `server/handlers/studioCss.ts`'s `styleRuleId` and `src/admin/pages/site/studio/styleRuleWriteback.ts`'s `isEditorAuthoredRuleId` both switched to it — no more independent `'sc-'` literals.
  2. `server/handlers/studioCss.ts`: `loadStudioStyles` now accumulates `authoredCssParts` inside `mergeParsedCss` (pushed before parsing, so extraCss-first/sheet-cascade-order is preserved for free) and returns `authoredCss: authoredCssParts.join('\n\n')` on `StudioStyles`.
  3. `server/handlers/studioPageLoad.ts`: `StudioLoadResult.authoredCss` added; both `loadStudioPages` return points (empty-pages-dir early return and the normal path) thread it through.
  4. `server/handlers/studio.ts`: the `GET /admin/api/studio/load` handler destructures `authoredCss` off `loaded` and includes it in BOTH the `?stream=1` NDJSON meta line and the buffered JSON body.
  5. `src/admin/pages/site/studio/studioLoadStreamSchema.ts`: `authoredCss: Type.String()` added to the `kind: 'meta'` line schema (required field).
  6. New `src/admin/pages/site/studio/studioRawCssStores.ts` — the `vendorCss`/`authoredCss` tiny external-store trios (mirrors `studioProjectTrust.ts`'s pattern). **Extracted this out of `fsCodemodAdapter.ts` rather than adding the trio inline** — inline would have pushed that file to 707 lines, past the 700-line `module-size-budgets` ceiling (it had already graduated off the grandfathered ledger; not adding a new entry there). `fsCodemodAdapter.ts` re-exports both pairs verbatim (`getStudioVendorCss`/`subscribeStudioVendorCss`/`getStudioAuthoredCss`/`subscribeStudioAuthoredCss`), so `ProjectCssInjector`/`AuthoredCssInjector` and every existing test import from `fsCodemodAdapter.ts` unchanged. `loadSite()` now also calls `setStudioAuthoredCss(loadedAuthoredCss)`.
  7. New `src/admin/pages/site/canvas/AuthoredCssInjector.tsx` — `UserStylesheetInjector`'s RAW pattern (`useSyncExternalStore` → `resolveViewportUnitsForCanvas` → `rewritePrefersColorScheme` → `@layer user-authored`), `id="mc-authored"`, always `insertBefore(head.firstChild)` (`ProjectCssInjector`'s prepend pattern) so it precedes `mc-classes` regardless of mount order. Mounted in `IframeFrameSurface.tsx` between `ProjectCssInjector` and `ClassStyleInjector` (the concurrent agent's files there were NOT touched).
  8. `src/admin/pages/site/canvas/canvasClassCss.ts`: new `styleRuleNeedsCanvasOverlay(rule)` predicate (`!isImportedStyleRuleId(rule.id) || rule.updatedAt > 0`), applied inside `buildCanvasClassCSS` by filtering `classes` before calling `generateClassCSS` — `mc-classes` now renders only editor-authored rules and session-edited imported rules. The existing 8-input identity memo (`createCanvasClassCssMemo`) already gates this — no second memo added, per the constraint.
  9. Docs: `docs/agent-refs/canvas-internals.md` (frame-anatomy diagram now lists `AuthoredCssInjector`; new paragraph "A Studio project's own CSS renders from TWO sources"), `docs/features/studio-import.md` (new "happy-dom's CSSOM is lossy" subsection under "CSSOM in Bun"; "Stable ids" section points at the shared `styleRuleOrigin.ts`). `docs/agent-refs/path-index.md` also updated (new files + `ClassStyleInjector`/`studioCss.ts` entries) even though not explicitly named in the work order — it's the "where does X live" index and would otherwise silently omit three new files.
  - **Not touched, as instructed:** `canvasScrollUnroll.ts`, `CanvasScrollUnrollInjector.tsx`, `iframeBodyReset.ts`, `ClassStyleInjector.tsx`, `src/core/publisher/reset.ts`, anything under `src/core/page-parser/`. Re-diffed `IframeFrameSurface.tsx`/`canvasClassCss.ts` before starting — both were still at the state the work order described.
- **The named risk (deleting an imported ambient rule leaves stale raw CSS until reload): left as a documented follow-up, not fixed.** `AuthoredCssInjector.tsx`'s own doc comment has a "Known gap" section, `canvas-internals.md`'s new paragraph names it too. Reasoning matches the work order's own framing ("mitigation sketched, not required for the primary fix") — closing it needs `deleteClasses` (`registryActions.ts`) to somehow edit the raw snapshot's text, which is a different, riskier kind of change (mutating injected CSS text rather than replacing it wholesale) than this pass's scope.
- **Also not touched (explicit scope, flagging for whoever picks it up next):** `docs/features/canvas-iframe-per-frame.md` — the deeper architecture doc for this same frame-anatomy area (injector table, "Vendor vs. user-authored ordering" section) still does not mention `AuthoredCssInjector` or the raw/overlay split. The work order named only `canvas-internals.md` + `studio-import.md`; left this one stale rather than silently expanding scope. Worth a follow-up pass — `board-27d`'s entry above already updated it for the reset-gating change, so it's actively maintained by others.
- **Gate tests built (the four):**
  1. `server/handlers/__tests__/studioCss.test.ts` — new `describe('studioCss — authoredCss (board-27, byte-fidelity against happy-dom CSSOM loss)')`. The load-bearing one: a fixture with `color-mix()`, a system colour (`Canvas`), and slash-alpha `hsl(0 0% 0% / .2)` — asserts all three survive byte-for-byte into `authoredCss` (`toBe(rawSource)` plus substring checks) and that the SAME three are absent from the parsed `StyleRule.styles` (only `padding` survives). **Landmine found while building this:** the classic example in the work order, `rgb(0 0 0 / .2)`, is empirically NOT dropped by the happy-dom version this repo currently vendors (20.9.0) — verified directly against `CSSStyleSheet.replaceSync` with several probes. `hsl(0 0% 0% / .2)` (identical slash-alpha syntax, different function) IS still dropped, so it stands in as the same class of bug without pinning the test to a happy-dom quirk. Documented in the test's own doc comment so this doesn't look like a typo later.
  2. `src/core/page-tree/__tests__/styleRuleOrigin.test.ts` — new file, `isImportedStyleRuleId`/`IMPORTED_RULE_TIMESTAMP` unit coverage.
  3. `src/__tests__/canvas/classStyleInjector.test.ts` — new `describe('generateCanvasClassCSS — board-27 overlay filter')`: an unedited imported rule (`sc-` id, `updatedAt: 0`) is dropped entirely; a session-edited imported rule (`updatedAt > 0`) is kept; an editor-authored rule (no `sc-` prefix) is always kept even unedited; mixed registries filter per-rule.
  4. `src/__tests__/canvas/authoredCssInjector.test.tsx` — new file, mirrors `projectCssInjector.test.tsx`'s pattern exactly (stub the NDJSON `/admin/api/studio/load?stream=1` meta line, assert `<style id="mc-authored">`, layer wrapper, byte-fidelity, reactivity, unmount cleanup) plus one DOM-order test asserting `mc-authored` precedes `mc-classes` regardless of which injector mounts first.
  - Fixing these schema/shape changes broke 5 existing test fixtures that hand-build the NDJSON meta line (now missing the newly-required `authoredCss` field) — all fixed in the same change: `src/__tests__/canvas/projectCssInjector.test.tsx`, `src/admin/pages/site/studio/__tests__/{studioSaveRequests,localizedPageWriteback,originBackedPropWriteback,fsCodemodAdapter}.test.ts`. `fsCodemodAdapter.test.ts`'s central flat→NDJSON translation helper now defaults `authoredCss: ''` alongside its existing `styleRuleSources: {}` default, so individual test call sites don't all need the field named.
- **Verification:**
  - `bun test src/__tests__/canvas server/handlers/__tests__` → **1353 pass / 10 fail / 5 errors** (unchanged before/after my change — all 10 confirmed pre-existing/resource-contention: `boardFrameVariantSelection`, `nodeRendererLockdown`, `bodyContextMenu`, `visualComponentRefInlineBody` all pass individually in isolation; `canvasScrollUnrollPinInteraction.test.tsx`'s 2 MutationObserver failures match the explicitly-named pre-existing issue).
  - `bun test src/core/page-tree src/admin/pages/site/studio/__tests__ src/__tests__/studio` → 233 pass / 0 fail.
  - `npx tsc -b` → clean.
  - `npx eslint` on all 22 touched/new files → 0 errors, 0 warnings.
  - `bun test src/__tests__/architecture/module-size-budgets.test.ts src/__tests__/architecture/no-core-barrel-deep-imports.test.ts` → 6 pass (confirms `fsCodemodAdapter.ts` extraction kept it at 667 lines, `IframeFrameSurface.tsx` at exactly 700 — the ceiling, not over it — and no deep-barrel-import violations).
- **Browser proof (gstack `browse`, `http://localhost:5173/admin/site?studio` — project "Untitled 2" (`untitled-2`), 5 frames):**
  - **(a)** `browse js` against the first frame's `contentDocument.head` confirmed `mc-authored` exists and precedes `mc-classes` in child order (`["mc-authored","mc-vendor","studio-editor-chrome",...,"mc-classes","mc-user-styles"]`).
  - **(b)** Edited `studio-workspace/untitled-2/pages/Home.module.css`'s `.page` rule to `background: color-mix(in srgb, red 50%, blue 50%)`, reloaded. Computed style on the real element: `background-color: color(srgb 0.5 0 0.5)` — the correctly-mixed colour, computed by the actual browser hosting the iframe. Cross-checked that `mc-classes` did NOT contain `.Home_page__d9569`/`color-mix` at all (confirms the unedited-imported-rule filter is excluding it from the overlay, as designed) while `mc-authored` did contain it. **Reverted the probe edit immediately after** — `git diff studio-workspace/untitled-2/pages/Home.module.css` confirmed clean, reload confirmed the canvas returned to its original white background and unchanged screenshot.
- **Landmines:**
  - The repo is under heavy concurrent-agent git churn right now (see `board-27b`'s entry above — HEAD moved and uncommitted work was silently wiped twice in one session). Re-verified my own files were still intact (grep for my own markers) immediately before writing this handoff, and re-ran the full test/tsc/lint pass one final time after that check — all still green. Did not commit (no instruction to).
  - `module-size-budgets`' ceiling is exact, not "under 700 with room" — `IframeFrameSurface.tsx` landed at precisely 700 lines after trimming comment prose to fit the one new import + one new JSX line. If the next change to that file adds even one more line without removing one, it will fail the gate; it is NOT on the grandfathered ledger (already graduated once).
- **Human action needed:** none required — this is a canvas-fidelity fix with no new UI surface. Optional dogfood: open any Studio project with hand-authored CSS using `color-mix()`/system colours/`light-dark()`/`oklch()`, confirm it now renders the real colour instead of transparent/unstyled.

### board-27a — scroll-unroll was overriding `overflow`/`min-height` on every element, not just scroll regions; narrowed it to a confirmed signal
- **Agent:** canvas-engineer
- **Stage:** shipped
- **Updated:** 2026-08-31
- **Goal:** `CanvasScrollUnrollInjector`'s stylesheet forced `overflow: visible !important` and (after `board-24`'s floor fix) `min-height: auto !important` on the universal `*` selector in every design frame. Make the canvas's computed CSS honestly reflect what the author wrote, without losing the reason the pass exists (making a clipped scroll region visible on the board instead of scrollable).
- **Scope:** `src/admin/pages/site/canvas/{canvasScrollUnroll.ts,CanvasScrollUnrollInjector.tsx,iframeBodyReset.ts}`, tests `src/__tests__/canvas/{canvasScrollUnroll.test.ts,canvasScrollUnrollInjector.test.tsx}`.
- **The defect, evidence-first.** A parallel read-only audit measured a live board (`untitled-2`, 5 frames): disabled the four Studio chrome stylesheets, cleared body's inline sizing, reflowed, diffed computed styles against the same read with chrome re-enabled. 87 elements diverged. Of the `overflow-y` overrides, **59 were `hidden` vs. 2 `auto`** — the blanket rule was hitting a clip mask or `text-overflow: ellipsis` container ~30x more often than an actual scroll region. Confirmed on the current `untitled-2` project: `.marketing-card--solid`, `.marketing-card__image-section`, `.seg-control--ios`, `.toggle__track` (rounded-corner clips) and `.navbar__title-text`, `.marketing-card__title/__subtitle`, `.seg-control__label` (ellipsis) all lost their clip/truncation on the canvas — visible on the Home screen today, not hypothetical. Separately, `.bottom-sheet__panel` (the alm design system's fullscreen sheet shell — `flex: 1; min-height: 0; overflow: hidden`, NOT itself the scroll region; `.bottom-sheet__content` nested inside it is) computed `min-height: auto` on canvas against an authored `0` — the exact opposite of what was written, because `authoredMinHeightFloor` only ever preserved *positive* values and treated `0` as "nothing to restore," with no check on whether the element was a scroll region at all.
- **The fix: one signal decides both.** `SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR` already recorded every element's pre-override `overflow-y` (for `collectScrollDeficits`). `buildScrollUnrollRules`'s `overflow`/`min-height` override now only matches `[data-studio-unroll-overflow-y="auto"], [...="scroll"]` — never the universal `*` selector, which now carries only `scroll-behavior: auto !important` (no rendering-correctness cost to leaving that one blanket). `snapshotAuthoredStyles` (`CanvasScrollUnrollInjector.tsx`) gates the min-height floor recording behind the same `auto`/`scroll` check — an element that isn't a scroll region is never touched by ANY of this machinery, so its authored `min-height` (`0` included) simply computes as written; nothing to snapshot, nothing to restore. This incidentally also fixes the `.bottom-sheet__panel` `min-height: 0` lie **for free** — it's gated out entirely now, not special-cased.
- **`authoredMinHeightFloor` kept its name and its `0`/`auto`-return-null behaviour** — rewrote its doc instead of its logic. It is *only ever consulted* for an element already confirmed to be a scroll region (the caller's gate), and *within* that scope `0`/`auto` really are "let the automatic content-based minimum take over," which is the whole mechanism this pass exists to invoke (CSS Flexbox §4.5: automatic min-size is content-based only when the item's own overflow is visible). A positive value on a genuine scroll region (e.g. `min-height: 300px; overflow-y: auto`) still survives — unchanged from `board-24`.
- **Two things audited, decided, and documented rather than changed (explicit ask: think it through, don't reflexively "fix"):**
  - **`position: fixed` → `position: absolute`** (`[data-studio-unroll="fixed"]`) stays. Argued both ways in the module doc now: a genuinely-`fixed` element WOULD stay faithful to the iframe's own viewport, but that viewport is not stable on a design frame — `useIframeFrameAutoHeight` grows the iframe element itself to the unrolled document's full height, so real `fixed` chrome would end up pinned to the bottom of a several-thousand-px page, nowhere near the device-screen chrome it overlays. Rewriting to `absolute` against `body` (pinned at `CANVAS_VIEWPORT_HEIGHT`, the same representative device height `resolveViewportUnits.ts` resolves `vh` against) keeps it anchored to that same representative screen instead.
  - **`explicit-height` stretching a clipping panel to its full `scrollHeight`** stays, and doesn't depend on the new overflow gate — `scrollHeight` reports an element's true content extent regardless of its own `overflow` value (only `overflow: visible` collapses it to `clientHeight`), verified against spec, so this JS-measured fallback correctly catches deficits on `overflow: hidden` elements the CSS-only scroll-region rule above deliberately leaves alone. Named, not fixed, one theoretical risk: a fixed-height `overflow: hidden` crop frame around an oversized `<img>` with no `object-fit: cover` would also present a real `scrollDeficit` and get incorrectly stretched. No live instance found — the audited project's own image-crop containers all use `object-fit: cover`, which does not inflate `scrollHeight`. Documented as a known limitation in `buildScrollUnrollRules`'s doc, with the fix shape named (scope this tag by authored overflow too) if a future project ever hits it.
- **`iframeBodyReset.ts` audit: nothing relaxed.** Went through all six `CANVAS_BODY_RESET_PROPERTIES` (`height`/`min-height`/`overflow`/`overflow-x`/`overflow-y`/`position`) against the two opposing height requirements `resolveViewportUnits.ts` documents. All six are load-bearing for one or the other and cannot be handed back to authored body CSS. `position: relative` specifically confirmed correct (not just assumed) by the same live-board measurement: every frame computes `position: relative` on canvas against `position: static` in source — it's the containing block both an app's own `position: absolute; inset: 0` overlay root AND this fix's `fixed`→`absolute` rewrite resolve against. Documentation-only change to this file; no behaviour changed.
- **Landmines:**
  - **The override is now frame-later for a genuine scroll region too**, same timing model `fixed`/`explicit-height` tags already use: the gate needs `snapshotAuthoredStyles` to have run once (it has to read the value BEFORE this file's own stylesheet can override it, so it cannot run any earlier than the injector's own rAF-scheduled pass). A scroll region therefore stays clipped for one settle before unrolling on mount/insert. `useIframeFrameAutoHeight`'s `ResizeObserver` (watches body's rendered size, not which mutation caused it) already picks this up for `explicit-height`/`fixed`, tested — same mechanism, not a new risk class, but if you ever see one frame of clipped content flash on a freshly-inserted scroll region, this is why, and it is expected.
  - **happy-dom's disabled-stylesheet quirk (`styleSheet.disabled === true` while still applying its rules to `getComputedStyle`) still makes the floor/overflow-snapshot pass untestable at the DOM level** — same as `board-24` found. Did not add a DOM test for the new gating; extended the pure-function/stylesheet-text tests in `canvasScrollUnroll.test.ts` instead (new: "does NOT force overflow/min-height on the universal `*` rule", "scopes overflow-visible + min-height-auto to a CONFIRMED scroll region only"). `canvasScrollUnrollInjector.test.tsx`'s existing comment explaining why already covers this; left as-is, still accurate.
  - **Do not try to make the overflow/min-height scope CSS-only again** (no JS tag) — a selector cannot ask "what would this element's `overflow-y` have computed to before any of OUR rules ran," which is exactly the question needed to tell a scroll region from a clip mask. This was tried in spirit by the old universal-`*` design and is the root cause this whole entry fixes.
- **Verification:** `bun test src/__tests__/canvas` → 649 pass / 10 fail, all 10 pre-existing and unrelated to these three files (selection-leak overlay tests, B3 NodeRenderer lock-down suite, a canvas body context-menu test, `visualComponentRefInlineBody`, and `canvasScrollUnrollPinInteraction.test.tsx`'s two known-flaky MutationObserver tests — reran that file standalone 3x, 1-2 failures each run, confirmed pre-existing flake, not a regression). `npx tsc -b` clean. `npx eslint` clean on all touched files. Did not run repo-wide `bun run build`/`bun run lint` — out of scope per the work order (files-only verification) and the repo has unrelated in-flight parallel work.
- **Human/dogfood action:** open `http://127.0.0.1:5173/admin/site?studio` on `untitled-2` (or any project using the alm design system), any zoom, the frame containing `Sheet2`/a fullscreen bottom sheet. Confirm the sheet's panel background fills all the way down behind its content (no undersized/mismatched background band), and separately confirm any card with rounded corners (`marketing-card`) still clips its image to those corners on canvas — it was square-cornered before this fix. A real scroll region (a tall list inside a `flex:1; overflow-y:auto` container) should still show fully unrolled with no internal scrollbar, same as before.

- **Addendum — a coordinator re-check flagged a possible regression in this same test file; investigated, disproven, both flaky tests now documented instead of one.** Reported symptom: `canvasScrollUnrollPinInteraction.test.tsx`'s **"a mutation that triggers explicit-height tagging does not collapse the body pin"** — a DIFFERENT test from the already-known-flaky "unroll tagging" one — measured 0/4 on the pre-fix files (`git checkout --` on the four touched files) vs 2/4 on mine, with a specific hypothesis: the `overflowY !== 'auto' && overflowY !== 'scroll'` gate added to `snapshotAuthoredStyles` short-circuits the same loop the `fixed`/`explicit-height` classification runs in.
  - **Hypothesis checked and disproven by code inspection first:** `snapshotAuthoredStyles` (records `SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR` + the min-height floor) and `runUnrollPass` (does the actual `fixed`/`explicit-height` classification via `classifyUnrollElement`) are two separate functions with two separate `body.querySelectorAll('*')` loops, called in sequence from `runUnrollPasses`. The new `continue` only skips the floor-recording lines within its OWN loop; it cannot reach the classification loop at all. Also confirmed `SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR` is written BEFORE the gate's `continue` on every element, unconditionally — unchanged behaviour for `collectScrollDeficits`.
  - **Then checked empirically, not just by inspection**, since intuition has been wrong before in this file's history: instrumented both functions (timing + a per-effect-instance id logged at mount/schedule/rAF-fire/MutationObserver-fire/`observer.observe()` success) and ran until a failure was captured. In every failing capture, `observer.observe()` **succeeded** (no throw) for the frame under test, but its `MutationObserver` callback **never fired** after `doc.body.appendChild(panel)` — confirmed via a temporary log in the test itself that the append landed on the exact live `doc.body` the observer was watching (`panel.parentElement === doc.body: true`, `doc.body.children.length: 3`). No exception, no stale document, no stale body reference — happy-dom's `MutationObserver` occasionally just does not deliver the record.
  - **Bisected the two candidate causes directly, both by running 15-30 reps each:** (1) shrank `buildScrollUnrollRules()`'s CSS text from ~4.9 KB to ~570 B, same selectors, same logic — **still failed at the same rate**, ruling out "bigger stylesheet, slower disable/enable toggle, timing shifted." (2) Removed the `overflowY` gate from `snapshotAuthoredStyles` entirely (the coordinator's specific hypothesis) — **still failed at the same rate**, directly disproving it.
  - **Then measured the actual baseline, at a sample size the original 4-run comparison didn't have:** `git show fb4821b:<file>` (the true pre-`board-27a` ancestor, since `git checkout --` on this branch resolves to a later commit that already contains other sessions' unrelated work) into the four files, ran the isolated test file repeatedly. **7/30 failures (23%), then a second clean run 2/20 (10%)** — the "explicit-height tagging" test is flaky ON THE BASELINE TOO, at a rate a 4-run sample has roughly a 1-in-3 to 1-in-8 chance of reading as "0/4" purely by chance (binomial: `0.90^4 ≈ 0.66`, `0.77^4 ≈ 0.35`). Then re-ran the SAME clean 20-rep measurement on the current (fixed) files: **2/20 (10%)** — statistically indistinguishable from baseline. Also reproduced the coordinator's exact 4-run method once more on the current files and got 2/4, matching their report exactly — the small sample was real, just not evidence of a regression.
  - **Root cause, to the extent it can be pinned without instrumenting happy-dom itself:** this is the same class of pre-existing flake as its sibling "unroll tagging" test (already documented in `board-24` and this file's original task brief as known-flaky) — both depend on a `MutationObserver` callback firing after a synchronous `appendChild` in happy-dom, and happy-dom's delivery of that callback is not 100% reliable under this test's timing. Not something my change introduced, narrowed, or widened.
  - **Process note for whoever measures a small-sample "before vs. after" on this file again:** 4 runs is not enough to distinguish a real regression from a ~10-20% pre-existing flake in either of this file's two MutationObserver-dependent tests. Use ≥20 reps per side, from the SAME git state read via `git show <commit>:<path>` (not `git checkout --`, which on a shared branch may resolve to a commit already carrying unrelated later work — it did here: the "baseline" `git checkout --` in the original report actually landed on a commit with other sessions' changes already in it, though for these specific four files that happened not to matter).
  - **`canvasScrollUnrollPinInteraction.test.tsx` now has TWO known-flaky tests, not one** — "a mutation that triggers unroll tagging does not collapse the body pin" (pre-existing, `board-24`) and "a mutation that triggers explicit-height tagging does not collapse the body pin" (pre-existing, confirmed by this addendum, previously undocumented because nobody had run it at high-N before). Neither was touched, weakened, or timeout-extended — per instruction, and because both are genuinely catching a real happy-dom limitation, just not one introduced here.
  - **No code changed as a result of this addendum** — `canvasScrollUnroll.ts`, `CanvasScrollUnrollInjector.tsx`, `iframeBodyReset.ts`, `canvasScrollUnroll.test.ts` are byte-identical to what `board-27a` above already shipped (re-verified: `diff <(git show HEAD:<file>) <file>` empty for all four, post-investigation). All debug instrumentation added during this investigation was fully reverted (verified against pre-investigation backups, byte-identical) before finishing.

### board-27b — an unresolvable prop/style/text expression vanished with no trace at all; that used to be a write-safety hole, not just a cosmetic one
- **Agent:** parser-surgeon
- **Stage:** shipped
- **Updated:** 2026-08-31
- **Goal:** audit every JSX attribute shape `extractProps` can meet and classify it: resolves -> `props` (already worked), a function -> `codeProps` (a recent narrow fix), everything else -> was DROPPED SILENTLY (no `props` entry, no `codeProps` entry, nothing). Close that for every shape it's honestly closeable for, and say clearly where it isn't.
- **Scope:** `src/core/page-parser/{jsxAttributeReaders,parsePageFile,types,canonicalCheck}.ts`, test `src/core/page-parser/__tests__/codeValueTracing.test.ts` (new), doc `docs/features/studio-import.md`.

**The bug was worse than "the panel looks empty."** `isPropWritableToSource` (`src/core/page-tree/sourceWritability.ts`) reads an ABSENT `codeProps` entry as "writable." `setJsxProp` (`src/core/ast-codemods/setJsxProp.ts`) has **no guard** against replacing a non-literal attribute's initializer — `existingAttribute.setInitializer(initializerText)`, unconditional. So `<Icon size={dynamicSize}/>` with `size` silently dropped looked, to the panel, like an ordinary empty numeric field. Type a value, save, and the store would happily route the edit through `updateNodeProps` -> `setJsxProp`, baking a literal straight over `{dynamicSize}` and deleting the binding — an actual instance of the "never bake a resolved value into the JSX" invariant breaking, reachable from the ordinary properties panel, not a theoretical edge case. Confirmed the panel's own gate (`propLockReason` in `PropertyControlRenderer.tsx`) has no independent check here — it trusts `codeProps` completely. The one thing that already made TEXT safe from the identical hole is `setJsxText`'s own `assertTextOnlyChildren`, which fails closed on any non-text-leaf shape regardless of what `isPropWritableToSource` says — ordinary props have no equivalent codemod-level guard, which is exactly why this was live, not latent.

**The fix — one catch-all per reader, each gated on `ctx.eval`:**

| Shape | Before | After | Locks node? | codeProps? | origin? | Panel |
|---|---|---|---|---|---|---|
| Literal (string/number/bool) | `props` | unchanged | no | no | — | ordinary control |
| Resolves via §7 (Tier A/B/C) | `props` + `codeProps` | unchanged | no (lock-01) | yes | if a literal was read through | `CodeValueControl` unless origin |
| Function (`onClick={fn}`) | `codeProps`, no value (pre-existing narrow fix) | unchanged | no | yes | no | `CodeValueControl` |
| Identifier / member chain the evaluator can't walk (hook state, prop off an undestructured param) | **dropped, no trace** | `codeProps`, no value | no | **yes (new)** | no | `CodeValueControl` |
| Template literal, unresolvable interpolation — **`className` included** | **dropped, no trace** (canonicalCheck's own doc called this "the one shape `static-class-name` cannot see at all") | `codeProps`, no value | no | **yes (new)** | no | `CodeValueControl`; `static-class-name` (advisory) now fires on it |
| Ternary/`&&`/`\|\|`/`??`, condition not statically decidable | **dropped, no trace** | `codeProps`, no value | no | **yes (new)** | no | `CodeValueControl` |
| Call outside Tier C's whitelist | **dropped, no trace** | `codeProps`, no value | no | **yes (new)** | no | `CodeValueControl` |
| JSX-valued prop on an HTML element (nonsensical but real) | **dropped, no trace** | `codeProps`, no value | no | **yes (new)** | no | `CodeValueControl` |
| JSX element/fragment value on a COMPONENT prop | materialized as a slot child (WS-3.4, pre-existing) | unchanged — my catch-all explicitly SKIPS this shape to avoid a duplicate `codeProps` entry `captureSlotProps` already adds one level up | slot child is locked (`SLOT_LOCK_REASON`) | yes (via slot capture, unchanged) | no | slot child renders as a real, if locked, node |
| JSX element reached through an ARRAY/ternary on a component prop (`tabs={[<Tab/>]}`, `icon={cond ? <A/> : <B/>}`) | **dropped, no trace** | `codeProps`, no value (still not materialized — neither `iconPropFromJsx` nor `captureSlotProps` guesses an array index or an undecidable branch) | no | **yes (new)** | no | `CodeValueControl` |
| `{...spread}` JSX attribute | node structurally locked (`SPREAD_LOCK_REASON`), value genuinely unrepresentable (keys unknown) | **unchanged, deliberately** — structural lock already IS the trace | **yes (unchanged)** | n/a (no name to record) | n/a | `SourceConstraintNotice`'s structural reason |
| Inline-style property, unresolvable or resolves to a `boolean` (never a usable CSS value) | **dropped, no trace** | `style:<property>` in `codeProps`, no `inlineStyles` entry | no | **yes (new)** | no | style row would need `CodeValueControl` (panel-designer's surface, not built here) |
| Inline-style SHORTHAND property (`{ color }`) | **silently skipped as if it were a spread** (the `!Node.isPropertyAssignment` filter caught shorthand too) | now resolves through the same identifier path as `{ color: accent }`; unresolvable case gets the trace above | no | conditionally | if resolved through a literal | ordinary control if resolved, else `CodeValueControl` |
| Spread element INSIDE `style={{...base, color:'red'}}` | **dropped, no trace, no lock either** | **unchanged, deliberately** — genuinely unrepresentable (keys unknown) AND, unlike attribute spread, sets no structural lock (a value-only gap inside one attribute says nothing about the element's own move/delete safety) | no | n/a | n/a | siblings resolve independently |
| Sole text-child expression, unresolvable (`<span>{value}</span>` off hook state) | **dropped, no trace** — indistinguishable from an element with genuinely no text (`<span className="icon"/>`) | `extractSingleText` returns `hasCodeText: true`, still no `text`; `processElement` folds it into `codeText` (same field a RESOLVED text value already sets) | no | via `codeText` -> studio-sync fold (see gap below) | no | **KNOWN GAP, see below** |
| Mixed text-and-element children (`<p>Price: {price}<strong>USD</strong> today</p>`) | **dropped, no trace** — only `<strong>USD</strong>` survives | **NOT FIXED** — confirmed by direct repro, documented, out of this change's reach | n/a | n/a | n/a | nothing; see Landmines |

**Decisions, the four questions, per new resolution:**
1. **Locks?** Never. Every one of these is a VALUE fact, not a structural one — `withResolution`'s rule (structure decided by the JSX shape alone) is untouched. The only lock in this table (`{...spread}`) is pre-existing and structural for an unrelated reason.
2. **codeProps?** Yes, for every shape with a nameable attribute/property — that is the entire fix. No for the two genuinely-unrepresentable shapes (attribute spread's resulting keys; a spread inside a style object).
3. **origin?** Never — `origin` is attached only where a LITERAL is read (per the four-question rubric in the parser-surgeon brief); every shape here is either a computation or a read that failed, neither of which has a literal behind it.
4. **Panel?** `CodeValueControl` for every new `codeProps` entry, generically — no new panel code was needed because `codeProps`/`isPropWritableToSource` is already the single predicate `PropertyControlRenderer` asks. The one exception is the unresolved-text case; see below.

**`checkLiteralProps`/`static-class-name` (canonicalCheck.ts) needed no tier change.** Both are already `tier: 'advisory'` (their own doc explains why: the underlying signal can't tell "resolved from a permitted module-scope const" from "resolved from hook state," so it was never meant to gate `isCanonical`). Widening `codeProps` makes both fire MORE on a real, non-canonical screen — which is correct, that's the rule's job — without ever turning an advisory into a violation. Verified against the committed `__canonical-fixture` corpus: `CanonicalScreen.tsx`'s `literal-props`/`static-class-name` expectations are unchanged (every prop in that fixture already fully resolves; the catch-all only fires on shapes that don't). Also restored a pre-existing `on*`-handler exclusion in `checkLiteralProps` that the mid-session revert below had wiped along with everything else — a handler prop was already being pushed to `codeProps` by the earlier narrow fix, and without the exclusion it would fire `literal-props` on every button in every real screen.

**Known gap, not closed — needs a `studio-sync` change, out of my file scope.** `codeText`'s new UNRESOLVED case (`hasCodeText`, no `text`) is set correctly at the page-parser level, but `parsedPageToSitePage.ts`'s fold into `PageNode.codeProps` (`else if (node.codeText) codeProps.push(textProp)`) only runs inside `if (node.text !== undefined) { ... }` — so with `text` absent, the fold never executes and the trace never reaches `PageNode.codeProps`. **Not a write-safety hole** — `setJsxText`'s `assertTextOnlyChildren` independently fails closed on this shape regardless of what `isPropWritableToSource` says, so no destructive write is reachable — but the panel still shows an empty, apparently-editable text field for it today. The needed change: in `parsedPageToSitePage.ts`, add an `else if (node.codeText) { const textProp = opts.resolveTextProp(moduleId); if (textProp !== null && !codeProps.includes(textProp)) codeProps.push(textProp) }` branch alongside the existing `if (node.text !== undefined)` one. **`studio-scribe`/whoever owns `src/core/studio-sync/` next: this is the top of the queue for this thread.**

**Confirmed, not fixed, out of page-parser's reach — mixed text-and-element children.** `<p>Price: {price}<strong>USD</strong> today</p>` parses to a `<p>` with exactly ONE child (`<strong>USD</strong>`); "Price: ", `{price}`, and " today" vanish completely — no `text`, no `codeText`, no `codeProps`, nothing. Root cause: `extractSingleText` only ever inspects the SOLE child (`children.length !== 1` bails immediately), and `processChildren` walks every OTHER child looking for JSX descendants only — a bare `JsxText` node or a scalar `JsxExpression` with no JSX inside it is invisible to that walk. This is a real, common React pattern (inline-formatted copy) with zero representation today. A genuine fix needs a new "text run" child-node kind with actual canvas rendering support — `resolveModuleId` (`server/handlers/studioPageLoad.ts`) and `NodeRenderer` both live outside `src/core/page-parser`, and this task's brief explicitly reserves canvas injectors for `canvas-engineer`. Documented in `docs/features/studio-import.md`'s "What still does not import" table and demonstrated by direct repro (see this entry's own investigation) rather than attempted half-fixed.

**Also confirmed, same family, smaller and already noted in the doc:** a component prop whose JSX value is reached through a TERNARY (`icon={cond ? <A/> : <B/>}`) is neither materialized by `captureSlotProps` nor resolved by `iconPropFromJsx` — both require the expression to BE the JSX element directly, not to CONTAIN one behind a branch. `selectJsxBranch` already solves exactly this for JSX CHILDREN; extending it to a component PROP's own value is the natural next step but is a second, separate change (touches `slotCapture.ts`, not just `jsxAttributeReaders.ts`) — named, not built.

**Landmines the 578-line doc didn't already say (told `studio-scribe` via this entry — the doc itself is updated in this change too, see Scope):**
- The mixed-text-and-element-children gap above — genuinely new information, not previously documented anywhere.
- The ternary-component-prop gap above.
- The `studio-sync` one-line follow-up above.
- **This session hit real, repeated data loss from concurrent git operations.** Partway through this task, `HEAD` moved forward out from under me (a parallel agent's commits — `feat(i18n)`, `feat: implement comments feature`, reflog shows `reset: moving to HEAD` entries) and every uncommitted edit I had made was silently wiped, TWICE, mid-session. Confirmed via `git show HEAD:<file> | diff - <file>` showing an exact match to a reverted, pre-edit state. Recovered by re-applying the same edits and immediately re-verifying (`grep` for my own markers) rather than trusting the Edit tool's success return alone. **If you are working in this repo and your own edits vanish mid-task, this is why — it is not you, and re-reading + reapplying is the only recovery.** Also recovered, as a byproduct: `board-23`'s `origin`-on-`Resolution` work (`nodeResolution.ts`) and the `on*`-handler `literal-props` exclusion — both pre-existing, uncommitted, uninvolved with this change — turned out to still be present in the working tree despite the resets and needed no action from me, but were at real risk of the same loss. **Whoever runs `/ship` or a final commit pass on this branch should verify `git status --short` against STATE.md's recent `board-*` entries before assuming the working tree matches what's documented as landed** — right now it plausibly does not match any single commit in history.
- **Not investigated:** whether `docs/reference/canonical-jsx.md` itself needs an update alongside `canonicalCheck.ts`'s doc-comment changes — `canonicalCheck.test.ts`'s doc-parity gate only checks the ten rules' title/description/tier against that file verbatim, and none of those three fields changed, so the gate stayed green without me touching that file. If a future change to `static-class-name`'s RULE TEXT (not just this doc comment) is made, check that file too.

**Verification:** `bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio` → 613 pass / 0 fail (up from the pre-existing suite by one new file, `codeValueTracing.test.ts`, 15 new tests). `npx tsc -b` clean (one transient, non-reproducing error in `server/handlers/studioCss.ts` observed once mid-session while another agent was actively editing that file concurrently — reran clean twice after). `npx eslint` clean on all four touched `src/core/page-parser` files plus the new test file. Did not run repo-wide `bun run build`/`bun run lint` — out of scope per this task's own VERIFY section, and the repo has extensive unrelated in-flight parallel work (see the git-churn landmine above).

### board-27f — a handler NESTED inside an object-valued prop still vanished with no trace — `toolbar.onBack` deleted a real Navbar back button, one level deeper than `board-25`'s top-level fix

- **Agent:** parser-surgeon
- **Stage:** shipped, dogfooded against the reference-render harness.
- **Updated:** 2026-08-31

Ask: `pages/Page.tsx`'s `<Navbar toolbar={{ variant: 'default', title: t.page.account, onBack: () => {} }} surface="default"/>` rendered `.glass-btn--type-back` in a plain Vite+React render of the real source, but not on the Studio canvas — `title` resolved fine, `onBack` (a function has no JSON form) was correctly dropped from the VALUE, but nothing recorded *where* it had been, so nothing could stand a no-op back up the way `board-25` already does for a TOP-LEVEL handler prop (`onClose={fn}` → `codeProps`, no value → `register.tsx` substitutes a no-op when the manifest marks that prop `kind: 'handler'`). The `@alm-design/design-system` package draws its leading `.glass-btn--type-back` only when `toolbar.onBack` is truthy — same gate class, one object level deeper, and the manifest has no per-nested-key classification to drive it from (`toolbar` itself is `tsType: 'unknown'`, no `kind` at all).

**Fix, both halves:**

- **Parser half.** `nodeResolution.ts`'s `tryResolvePropValue` now walks the resolved `StaticValue` tree (the SAME evaluation `staticValueToPropValue` already converts to JSON) with a new `collectFunctionPaths`, recording every `{kind:'fn'}` entry's location as a path relative to the top of the structure — dot for an object key, `[N]` for an array index (`'onBack'`, `'actions[0].onClick'`). `extractProps` (`jsxAttributeReaders.ts`) prefixes each with the prop's own name and files it in a **new, separate** `ParsedNode.codeFunctionPaths: string[]` field, threaded through unchanged by `parsePageFile.ts`'s three node-construction branches (plain node, `<svg>` node, `dangerouslySetInnerHTML` node — matches how `codeProps` itself is threaded).
- **Render half.** `register.tsx`'s `makeComponent` now also reads `ModuleComponentProps.codeFunctionPaths` (new field, passed straight through by `NodeRenderer`) and, for each recorded path, rebuilds ONLY the objects/arrays along that path (`withValueAtPath` — clone-on-write, never mutates the node's shared `props`) with a no-op function at the end. Same refusal discipline as the top-level case: a no-op is stood up **only** where the path says the source actually wrote one — a `Navbar` with no `onBack` at all still renders with no back button (tested).

**Companion field, deliberately not folded into `codeProps`.** Answered all four questions from this brief:
1. **Locks?** No — same as every other `codeProps`/resolution fact, this is a VALUE, not a structural fact.
2. **`codeProps`?** No, a SEPARATE field. Every path already sits under a prop name (`toolbar`) that `codeProps` already refuses wholesale — the whole object is never a writeback target regardless of what's nested inside it, so a nested path answers no NEW writability question `isPropWritableToSource` doesn't already answer. Folding it in would only double-report the same prop name to `canonicalCheck.ts`'s `literal-props` advisory (`"toolbar, toolbar.onBack resolved from…"`) for zero new information — so **`literal-props`/`static-class-name` needed no change at all**, tiering intact as instructed.
3. **`origin`?** No — never; a dropped function has no literal behind it to point at.
4. **Panel?** None needed — `codeFunctionPaths` never reaches `PropertyControlRenderer`; it's a render-time-only hint consumed exclusively by the module layer. The panel still shows `toolbar` as an ordinary `CodeValueControl` via `codeProps`, unchanged.

**`tryResolvePropValue`'s return shape changed** (`ParsedPropValue | undefined` → `{value, functionPaths} | undefined`, still `undefined` only when the caller opted out of §7). The important subtlety: `structured.value` can be `undefined` while `structured.functionPaths` is non-empty (`toolbar={{ onBack: () => {} }}` alone — `staticValueToPropValue`'s "empty object declines" rule still drops the VALUE, but the function's location is a separate fact about the same expression and must survive regardless) — tested directly (`structuredProps.test.ts`).

**`studio.instance` (local-component call sites) remap `codeFunctionPaths` into the `callSiteProps:<name>` namespace** exactly the way `codeProps`/`resolvedProps` already do (`parsedPageToSitePage.ts`) — for the one-shared-prefix reason, not because anything currently consumes it there; `inlineLocalComponents.ts` needed no change since it spreads `callSiteNode` wholesale onto the instance node, which already carries the new field through.

**Schema:** `PageNodeSchema.codeFunctionPaths: Type.Optional(Type.Array(Type.String()))` in `pageNode.ts`, `Static<>`-derived (no parallel interface), tolerant-parsed the same way as `codeProps` (`parseCodeFunctionPaths` = `parseCodeProps` verbatim, same per-entry tolerance).

**Verified against the reference-render harness, not just tests** — this bug class is invisible to unit tests that don't render a real design-system component:
- `nav.js` (scratchpad) against the live Studio canvas on `untitled-2`: `{"backBtn":true,"navbarTitle":"Account", …}` — was `false` before this fix (confirmed via the reference app at `:5199/?page=Page`, which also reports `backBtn:true`).
- Five-page structural diff (tag-name multiset, ref render vs. canvas render, CSS-module hash-agnostic): **zero tags present in the reference render and absent on canvas, for all five pages** (Home, Page, Popup, Sheet, Sheet2) — the DONE WHEN bar. Every canvas-side "extra" is a wrapper `div`/`span` (Studio's own selection/hover chrome, `display:contents` host divs — expected, pre-existing, unrelated to this fix): Home +9 div/+1 span, Page +12 div/+3 span, Popup/Sheet/Sheet2 +1 div each (the outer `NodeWrapper`). Matches the task's stated pre-fix baseline exactly (Popup/Sheet/Sheet2 unchanged, Home's 1-extra-span unchanged) with Page's previously-missing back button now present.
- New render-level test suite `src/__tests__/canvas/almNestedHandlerAffordance.test.tsx` (3 tests, `@testing-library/react` against the real registered `alm.Navbar` module): draws the button when `codeFunctionPaths` names it, draws NO button when it's absent (the refusal case), and proves the standâ€‘up never mutates the node's own shared `props.toolbar` object (a second render, or a second node sharing the resolved reference, must not leak a function onto it).

**Landmine for the next person extending `codeProps`/nested-value tracing (not already in the 578-line doc — telling `studio-scribe`):** `staticValueToPropValue`'s three rules (drop functions, decline on one bad array item, decline an empty object) all operate on the SAME converted value a sibling function now also walks for function paths — if a future change adds a FOURTH kind that needs similar side-channel tracing (e.g. an unresolved nested member expression), don't add a third parallel walk; generalize `collectFunctionPaths` into a `collect<Predicate>Paths` or make `staticValueToPropValue` itself return `{value, notes}` so there's one traversal, not N.

**Files:** `src/core/page-parser/{nodeResolution,jsxAttributeReaders,parsePageFile,types}.ts`, `src/core/page-tree/pageNode.ts`, `src/core/studio-sync/parsedPageToSitePage.ts`, `src/core/module-engine/types.ts`, `src/admin/pages/site/canvas/NodeRenderer.tsx`, `src/modules/alm/register.tsx`, tests `src/core/page-parser/__tests__/structuredProps.test.ts` (5 new cases) + new `src/__tests__/canvas/almNestedHandlerAffordance.test.tsx` (3 tests), doc `docs/features/studio-import.md` ("A function NESTED inside a structured prop" section, new).

**Verification:** `bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio` → 617 pass / 0 fail. `bun test src/__tests__/canvas src/core/studio-sync` → 703 pass / 11 fail, all 11 the documented pre-existing set (selection-leak x2, B3 NodeRenderer lock-down x5, scroll-unroll pin/unroll MutationObserver x2, canvas body context menu x1, `visualComponentRefInlineBody` x1 — matches `board-27d`'s and this file's own prior entries verbatim, none touch a file in this change's scope). `npx tsc -b` clean repo-wide. `npx eslint` clean on every touched/new file. `module-size-budgets` architecture gate green (largest touched file 664 lines). Did not run repo-wide `bun run build`/`bun run lint` as a second pass — `tsc -b` (which `build` also runs) and per-file `eslint` already came back clean, and the repo has unrelated in-flight parallel work on `STATE.md` itself (see `board-27a`'s addendum, added by another agent between my read and my write of this file — left untouched, only appended to).

### Addendum — two more findings the coordinator's own re-diff surfaced once the back button stopped hiding them. Finding 1 (extra icon wrapper + a co-located scroll-unroll misclassification) FIXED and verified. Finding 2 (a literal `className` with no matching `StyleRule` is dropped from the DOM) confirmed, root-caused, deliberately handed back rather than half-landed.

**Finding 1 — `.cell__visual--icon` cells 20px taller on canvas, `[24,44]` instead of `[24,24]`. TWO independent, co-located causes, both fixed:**

1. **`base.svg`'s own editor (`SvgEditor.tsx`) wrapped its markup in a plain `<span>` with no `display` override.** A raw `<svg width="40" height="40" …/>` reached through a JSX-element icon prop (`icon={<svg …/>}`, or the same shape nested one level inside a fragment slot) is NOT the one-level `{svg}` shortcut `iconPropFromJsx` recovers — it materializes as a real `base.svg` node instead, rendered by `SvgEditor`. That component's wrapping `<span {...nodeWrapperProps} dangerouslySetInnerHTML>` (needed to carry selection/hover identity onto markup React itself never sees as children) defaulted to `display: inline`, and an inline element's line box is taller than a same-height block child sized purely by content — the classic "extra space under an inline image" effect, compounding across nested icon spans. Fixed: `display: contents` on the span, merged with (never replacing) the node's own `nodeWrapperProps.style` — same pattern `src/modules/alm/register.tsx`'s design-system host div already uses, and `nodeVisualRect`'s box-less-node fallback (already generic, already covers that host div) picks this shape up for free — no selection/hover-geometry change needed. Measured improvement alone: `[24,44]` -> `[24,40]` — the wrapper really was contributing, just not the whole 20px.
2. **The remaining `[24,40]` (not `[24,24]`) was a SEPARATE, pre-existing, previously-documented-as-accepted `CanvasScrollUnrollInjector` limitation, not a new bug.** `classifyUnrollElement`'s `'explicit-height'` branch fired on ANY element with a positive `scrollHeight - clientHeight` deficit, with NO regard for the element's own authored `overflow-y` — unlike the sibling `auto`/`scroll`-only rule right next to it in the same file. Measured directly in a real (non-Studio) browser: a `display: flex; width: 24px; height: 24px` icon frame (`.cell__visual--icon`, `overflow-y` never set — the CSS default, `visible`) around an intrinsically-40px, un-scaled SVG reports `scrollHeight: 32, clientHeight: 24` in the REFERENCE render too — Chromium's flex layout lets an oversized flex item inflate `scrollHeight` even though nothing is actually clipped (only *visible* overflow, which never generates a scrollable region). This measurement directly falsifies a claim `buildScrollUnrollRules`'s own doc comment used to make ("only `overflow: visible` collapses `scrollHeight` to `clientHeight`") — corrected in the same change. The injector then forced `height: auto; min-height: 32px` on the box; with `height: auto` an `overflow: visible` flex container auto-sizes to its tallest item (`40px`, not the `32px` floor), which is where the observed `40` comes from. **This is exactly the "known, accepted limitation" that same doc comment already named** ("an intentionally undersized crop frame around oversized… media… both present as a real `scrollDeficit`… If a future project hits this, the fix is scoping THIS tag by authored overflow the same way the rule above was") — this session hit it and built that named fix: `classifyUnrollElement` now takes `originalOverflowY` and requires it be something other than `'visible'` before tagging `'explicit-height'`. `hidden`/`clip`/`auto`/`scroll` all stay eligible (an `overflow: hidden` crop-frame panel — the case this tag exists for — is unaffected), because only `'visible'` means "never hid anything in the first place." Doc comments in `canvasScrollUnroll.ts` and `docs/agent-refs/canvas-internals.md` updated to match.

**Verified end to end:** all seven `.cell__visual--icon` cells on `pages/Page.tsx` now measure `[24,24]` on the live canvas, matching the reference render exactly (was `[24,44]`/`[24,44]` on the two affected cells). Cross-checked with a SECOND, independent measurement script (`diverge.js` — disables Studio's own chrome stylesheets and re-measures) — no `height`/`minHeight` divergence appears for either cell any more. **No regression to the existing clean baseline**, re-measured after this fix: five-page tag-presence structural diff (Home/Page/Popup/Sheet/Sheet2) still shows **zero** tags present in the reference render and missing on canvas, same wrapper-chrome "extra" counts as before this addendum; `.bottom-sheet__content`'s genuine `overflow-y: auto` unroll on Sheet/Sheet2 is untouched — still exactly the same 3 property diffs (`overflowX`/`overflowY`/`minHeight`) on exactly that one element, nothing more, nothing less. `canvasScrollUnroll.test.ts` gained two new tests (24 pass, up from 18): one pinning the `'visible'`-excludes-`'explicit-height'` behaviour at the exact measured repro's numbers, one pinning that `hidden`/`clip`/`auto`/`scroll` all still tag normally. `canvasScrollUnrollPinInteraction.test.tsx`'s two MutationObserver tests (named pre-existing/flaky in this task's own brief) were re-measured 5 reps against the pre-this-addendum baseline (`git stash` of just the two touched scroll-unroll files) alongside 3 reps with the fix in place — fail rate statistically indistinguishable both ways (baseline: 1,2,1,1,1 of 5; with fix: 1,2,1 of 3) — not a regression, matches the documented 10-23% intrinsic flake rate.

**Finding 2 — a literal `className="text-background-base-hover"` (`pages/Page.tsx:35`) renders `class=""` on canvas. Coordinator's hypothesis CONFIRMED, root-caused precisely, deliberately NOT fixed — handed back per this task's own explicit scope-call instruction rather than half-landing a change to a foundational, safety-adjacent path.**

Verified directly against the live iframe DOM (`class` attribute literally empty on the canvas `<p>`) and traced the exact mechanism: `parsedPageToSitePage.ts` unconditionally deletes `props.className` and replaces it with `classIds` via `resolveClassIds` -> `classIdsForClassName` (`server/handlers/studioCss.ts`), which **by design** ("a dangling id would point at a rule the editor can't show or edit") drops any space-separated name with no matching `StyleRule` in the registry — and the original literal STRING is gone at that point; nothing downstream ever sees it again. One correction to the coordinator's own framing: `text-background-base-hover` isn't "defined only in the package's vendor CSS" — grepped the ENTIRE installed `@alm-design/design-system` bundle and the project's own CSS; the class is defined **nowhere at all**, almost certainly an AI-hallucinated utility-class name from page generation (matches this project's own documented pattern of an agent inventing a plausible-looking token it never verified). So this SPECIFIC instance is genuinely harmless — a real browser applies no rule to it either, matching the coordinator's own "visually harmless here" read. The MECHANISM is real and general, though: it would silently drop styling for any GENUINE hand-authored vendor/utility class the parser's `cssToStyleRules` engine can't flatten into a `StyleRule` (pseudo-class-only rules with no unqualified base selector, `@media`-only declarations, unsupported combinators, …) — even though the raw vendor CSS text is ALREADY injected into the frame (`AuthoredCssInjector`, WS-2.3/`board-27e`) and would style the element correctly the moment the class name actually reached the DOM.

**Why handed back instead of fixed:** a correct fix needs the LITERAL className string preserved somewhere past the point `parsedPageToSitePage.ts` currently discards it (a new `PageNode` field, schema change), threaded through `NodeRenderer`/`getCanvasNodeClassName` as an unconditional passthrough, and — the part that isn't just plumbing — a real, unresolved precedence decision: when a name IS matched into `classIds` (and so already gets the editor's own generated class for that rule), does the literal name render ADDITIONALLY alongside it (safe on its own, but risks the raw vendor declaration's specificity/cascade order fighting a value the user edited through the panel), or does it get excluded once matched (needs `classIdsForClassName` to expose the matched/unmatched SPLIT it currently collapses into one `string[]`, a behavior change to a function three other things already depend on)? This is exactly the "structure vs values" conflation this codebase names as its single biggest historical bug source (`classIds` was serving two jobs — "what can the editor edit" and "what actually renders" — and this finding is that same disease, one layer over from where `codeProps`/`locked` already had it). Getting the precedence question wrong risks a WORSE bug than the one being fixed (a canvas that renders styling the save path can't reproduce, or a styled edit that silently reverts to the vendor default). Documented in full in `docs/features/studio-import.md`'s "What still does not import" table (new `—` row) plus a full writeup bullet immediately after the "Computed `className`" bullet it sits beside — next agent picking this up should start there, not from this STATE.md summary.

**Files (this addendum only):** `src/modules/base/svg/SvgEditor.tsx`, `src/admin/pages/site/canvas/{canvasScrollUnroll,CanvasScrollUnrollInjector}.tsx`, test `src/__tests__/canvas/canvasScrollUnroll.test.ts` (+6 tests, 24 total), docs `docs/features/studio-import.md` + `docs/agent-refs/canvas-internals.md`. Finding 2: investigation only, **no source files changed** for it.

**Verification (this addendum):** `bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio src/__tests__/base-modules.test.ts src/__tests__/canvas src/core/studio-sync` → 1447 pass / 9 fail, all 9 the same documented pre-existing set as `board-27f`'s own first verification pass (the 2 MutationObserver flake tests happened not to fire this particular run — see the flake-rate comparison above for why that is not informative on its own). `npx tsc -b` clean repo-wide. `npx eslint` clean on every touched file. `fidelityCodes.test.ts` (gates the "What still does not import" table/registry parity) still 4/4 pass — the new `—`-coded row needed no registry entry. Line budgets: `SvgEditor.tsx` 68, `canvasScrollUnroll.ts` 380, `CanvasScrollUnrollInjector.tsx` 387 — all well under 700.

### server-19 — the wave train's four deferred fixlets, closed together (W6-4)

- **Agent:** studio-implementer
- **Stage:** verifying — built, gated, PR open for review
- **Updated:** 2026-09-06
- **Branch:** `chore/wave-cleanup-fixlets`, from `origin/main` at `4d43677`
- **Goal:** close the four small debts PRs #19/#20/#22/#32 recorded as deferred
  cleanup, in one coherent chore PR. Done means each is fixed at the source or
  honestly reported as not-applicable.
- **Scope:** `server/handlers/studioProjects.ts`, `server/handlers/studioPageLoad.ts`,
  `server/handlers/studio/{pageParseCache,storyPages,reloadScope}.ts`,
  `src/core/page-tree/styleRule.ts`, `src/admin/ai/ModelPicker/ModelPicker.tsx`,
  `src/admin/pages/site/panels/AgentPanel/ModelEffortPicker.tsx`,
  tests `server/ai/mcp/tools/studio/gitTools.test.ts`,
  `server/handlers/__tests__/reloadScope.test.ts`,
  `server/handlers/studio/__tests__/storyDiscovery.test.ts`,
  `src/__tests__/panels/agentPanel.test.tsx`, doc `docs/features/studio-import.md`.

**1 — git-tool test debris.** No `__git_tool_test_*` directory was ever
COMMITTED (checked `git ls-files` and the whole history); the debt was the
leak, not a tracked folder. `gitTools.test.ts` created its fixture projects
under `projectsRootDir()` because that path anchors every containment guard in
the feature (`assertWithinWorkspace`, `isRealpathContained`,
`GIT_CEILING_DIRECTORIES`) — so a killed run left folders in the developer's
own `studio-workspace/`, which the launcher then lists as real projects.
`projectsRootDir()` now honours **`STUDIO_WORKSPACE_DIR`**, read per call; the
test sets it to a `realpathSync`'d OS temp dir in `beforeAll` and restores it
in `afterAll`. Unset (every normal run) the root is `<cwd>/studio-workspace`,
byte-identical to before.

**2 — Storybook routes now record parse-cache dependencies.**
`buildStoryRouteEntries` takes the load's `configHash` and reads/writes
`pageParseCache` under the key `${dir}::story:<pageId>`, depending on the story
file plus its resolved local components. `localSourceAbsFiles` moved out of
`studioPageLoad.ts` into `pageParseCache.ts` so all three route producers
derive that set identically. `reloadScope.ts` drops the blanket "this project
has stories → widen"; two narrower rules replace it (a story file no cached
story route claims widens; a touched story FILE widens, because a story frame
can disappear when its materialization degrades to nothing, which is board
shape, not a page patch). Net effect: an ordinary save in a Storybook project
narrows, and a component only a story renders narrows to that story's frame.

**3 — the routed-effort chip renders.** `ModelEffortPicker` passes
`trailingLabel={agentEffort ? currentEffortLabel : routedTurnLabel(agentRoutedTurn) ?? undefined}`,
exactly the wiring `mcp-16`'s handoff prescribed. The router's reason needed
somewhere to live, so the shared `ModelPicker` gained one optional prop,
`trailingLabelTitle`, which titles the trailing span only.

**4 — `StyleRule.name`'s three meanings are documented** on the field in
`src/core/page-tree/styleRule.ts` (class-as-written · compiled CSS-Modules
class, with the source name on `displayName` · synthetic
`<Component>_sc__<hash>` for a styled template, which appears nowhere in
source), with the rule that follows: anything writing a class name into source
branches on the rule's SOURCE MAP (`styleRuleSources` vs
`styledStyleRuleSources`), never on the shape of `name`. One paragraph added
to `docs/features/studio-import.md`'s `className` write-back section.

- **Decisions:**
  - **An env override, not a test-only setter, for the workspace root** —
    because the root is real deployment configuration (`STATIC_DIR`,
    `RUNTIME_CACHE_DIR`, `UPLOADS_DIR` set the precedent) and a `set…ForTests`
    hook in production code would be the band-aid version of the same seam.
    It is deliberately NOT in `readServerConfig`: that returns a boot-time
    snapshot, and `projectsRootDir()` is called per request.
  - **A touched story file still widens.** Narrowing it would mean proving the
    story set is unchanged, which needs a re-parse — the exact work the narrow
    path exists to avoid. Everything else about a Storybook project narrows.
  - **A skipped story is not cached.** "This produced nothing" is the one
    answer worth recomputing.
- **Landmines:**
  - The story cache key's route half is `story:<pageId>`, and `reloadScope`
    reads the page id straight back out of it. That is deliberate: deriving it
    honestly would mean re-running `discoverStories`, i.e. re-parsing every
    story file to answer a question about which pages to reload. If you change
    `STORY_ROUTE_KEY_PREFIX`, `storyPageIdFromRoutePath` is its only reader.
  - With stories DISABLED (`meta.stories.enabled === false`) a stale story
    cache entry names a page that no longer exists; it is kept out of the id
    map on purpose, so anything depending on it hits rule 4 and widens.
  - `bun run build` cannot complete in a worktree — `scripts/vite.ts` resolves
    `../../node_modules/vite/bin/vite.js`, and a worktree's `node_modules` is
    empty. Its `tsc -b` half runs (bun walks up to the primary checkout's
    `node_modules`) and is clean. Verified separately with the PINNED compiler
    per `standing-08`, not `npx tsc`.
  - Three test files still create fixtures inside `projectsRootDir()`
    (`referenceUpload`, `sharePublic`, `reloadScope`). They clean up per-test,
    so they were left alone — but `STUDIO_WORKSPACE_DIR` is now the seam if
    anyone wants them out of the developer's workspace too.
- **Verification:** `./node_modules/.bin/tsc -b` (6.0.3, pinned) clean ·
  `bun run lint` clean · `bun test server/handlers/studio server/handlers/__tests__ server/ai/mcp/tools/studio`
  → 1650 pass / 10 fail, all 10 environmental (`projectSeed`/`componentBundle`/
  `projectGuide` read Studio's own `node_modules`, empty in a worktree) ·
  `bun test src/__tests__/architecture` → 478 pass / 18 fail, all 18 the
  pre-existing icon-catalog gate · `bun test src/__tests__/studio src/core/page-tree`
  → 268/0 · `bun test src/__tests__/panels/agentPanel.test.tsx` → 26/0 (3 new) ·
  `bun test server/handlers/studio/__tests__/storyDiscovery.test.ts` → 19/0
  (2 new) · `bun test server/handlers/__tests__/reloadScope.test.ts` → 21/0
  (the old "widens for a project with Storybook stories" test is replaced by
  four that pin the new rules) · `bun test server/ai/mcp/tools/studio/gitTools.test.ts`
  → 12/0, with `studio-workspace/` untouched afterwards. **Full `bun test`** →
  **11333 pass / 54 fail / 1 skip** across 1056 files (343 s); all 54 are the
  documented pre-existing clusters — 18 icon-catalog gate, ~14 canvas
  batch-isolation (B3 NodeRenderer lock-down, selection leak, pin⇄unroll,
  breakpoint activation, body context menu, form controls, inline text edit,
  VC ref), 9 that read Studio's own `node_modules` (`applyProjectSeed`,
  `componentBundle`, `projectGuide`, the dev-launcher gate), and the headless
  capture / `studio_compare` set that needs a real browser. Not one is in a
  file this change touches.
- **Next step:** review + merge the PR. Nothing is stacked on it.
- **Human action needed:** dogfood the routed-effort chip — open the AgentPanel
  against a `claudeCli` credential with no pinned effort, send a turn, and
  confirm the model trigger reads `<model> auto · <effort>` with the router's
  reason on hover.

### panel-16 — W8-4: an Export section, and what it refuses to fake
- **Agent:** studio-implementer
- **Stage:** done (gates green; draft PR open) — **needs human dogfood**
- **Updated:** 2026-09-07
- **Branch:** `feat/inspector-export-section` off `origin/main` (`0d05e1c`).
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W8-4, the *Export section* bullet, one PR.
  Nothing from W8-2/3 or the parallel scrub/fill/multi-select waves.
- **What landed.** A node-level **Export** section at the bottom of the
  inspector (`ExportSection.tsx`, mounted last in `StyleSurface`'s column,
  keyed by node id). One header line and a `+` at rest (Law 1); the typed `+`
  menu is **PNG @1×/@2×/@3×**, **SVG**, **Copy CSS**, **Copy JSX**. The image
  formats add a row (format + density + a run button); the two copies run
  immediately, because a copy has no settings to keep.
  - **PNG** — `POST /admin/api/studio/node-png`. Photographs the node's page
    through the existing `captureFrames` pipeline (untouched — consumed via
    its exported entry) and crops to the node's own rect. `resolveNodeCropBox`
    (`nodeExportCapture.ts`) derives the crop from the capture's **reported**
    `nodeRects` + `imageScale`, never the requested `dpr`, so it stays correct
    when the pipeline clamps a 3× request. Rounds outward, clamps an
    overhanging rect, and refuses two cases by name (0×0 element; entirely
    outside what was photographed).
  - **SVG** — deliberately **no route**. Whether a node has an honest vector
    form is a fact about the parse the browser already holds (`props.svg` from
    `inlineSvg.ts`, or an `<img src>` resolving to `.svg` — including the
    `?path=…svg` shape the parse rewrites local assets to). Everything else is
    refused BY NAME (`rasterized-html` / `raster-image` / `dynamic-svg`)
    rather than wrapped in an `<svg><image href="data:…">` shell. That shell
    is what "export anything as SVG" tools emit and it is a lie about the file
    the user just saved.
  - **Copy CSS** — off the `provenanceByProperty` map `StyleSurface` already
    computes. Only properties something *declares* are copied, each at its
    provenance **winner**'s value; an `ambiguous` property falls back to the
    frame's real computed value rather than picking a candidate declaration at
    random. A node with no class gets bare declarations under a comment
    header — never an invented selector.
  - **Copy JSX** — `POST /admin/api/studio/node-jsx`, located with
    `locateJsxElement.ts` (the same locator every codemod resolves its write
    target with) and returned verbatim. Never regenerated from the tree.
- **Why Export is NOT in `classStyleSections.ts`.** Three consumers read that
  registry as *CSS properties on a style target*: `StyleSectionsEditor`
  renders one copy per open target (so a node with both the Element and class
  blocks open would have shown **two** Export sections), `StyleCategoryRail`
  derives a rail button **disabled until a class is active** (Export works
  fine on an unclassed element), and the search filters by claimed properties
  (Export claims none). It follows Law 1 in its own component instead, so
  `emptySectionLaw.test.tsx` still covers exactly the seven flagged CSS
  sections — unchanged, still green. Consequence: **there is no rail icon for
  Export**; `StyleCategoryRail.tsx` belongs to the parallel inspector-fix
  agent and was not touched. If a rail entry is wanted, it needs a
  non-`CLASS_STYLE_SECTIONS` entry in that file — a follow-up, not drift.
- **Cleanups made on the way (CLAUDE.md "fix at the source"):**
  - `saveBlobAsFile` (`src/admin/shared/saveBlobAsFile.ts`) — the
    object-URL + hidden-anchor + delayed-revoke idiom existed in two verbatim
    copies (`downloadStudioCode.ts`, `agentImageActions.ts`) and this would
    have been a third. Both migrated.
  - `server/handlers/studio.ts` had grown **four** bespoke "called outside the
    loop because it needs the `DbClient`" blocks, each restating the same
    rationale. They are now one `STUDIO_SESSION_SUB_ROUTERS` array + loop,
    mirroring the existing `STUDIO_SUB_ROUTERS`. Net effect: the file is
    **698 lines** (was 692) even after gaining a route — but it is still
    within 2 lines of the 700-line ceiling. **The next agent to add a route
    there must split the file, not squeeze.** Its module doc is ~250 lines of
    prose cataloguing routes that already have their own module docs; that is
    the obvious extraction.
  - `@core/ast-codemods` now exports the shared JSX locator
    (`createProject` / `loadSourceFile` / `findJsxElementAtLocation` /
    `resolveJsxWholeElement`) through its barrel, so Copy JSX finds the exact
    span a write would land on instead of growing a second locator.
    `camelToKebabCssProperty` was reused from `@core/css-codemods` rather than
    adding a third kebab helper — see that file's own note on why the copies
    are deliberate.
- **Tests:** `nodeExportCapture.test.ts` (crop math: scaling, outward
  rounding, edge clamping, both refusals; plus the capture→crop wiring through
  the injectable `captureFrames` seam, no Chromium) · `nodeExportRoutes.test.ts`
  (path ownership, non-POST verbs ignored, **session required before the body
  is even read**, and the two body schemas — notably that a density the menu
  does not offer is a 400, not a value to clamp) · `nodeExportModel.test.ts`
  (the `+` menu registry, file naming, all three SVG refusals + all three
  accept shapes, Copy CSS winner/ambiguous/skip behaviour and its formatting).
- **Verification:** `bun run build` (tsc -b + vite) clean · `bun run lint`
  clean · new tests 44/0 · `bun test src/admin/pages/site/panels/PropertiesPanel
  src/__tests__/panels src/admin/pages/site/studio/__tests__` → 990/0 (a first
  run showed 2 fail, green on re-run — the documented batch-isolation flake) ·
  `bun test src/__tests__/architecture/module-size-budgets.test.ts` → 5/0 ·
  `bun test server/handlers/studio …` → 6 fail, all in the documented
  environmental cluster (`applyProjectSeed`, `generateStudioProjectGuide`,
  `buildStoryRouteEntries` — they read Studio's own `node_modules`, empty in a
  worktree). The architecture suite's icon-catalog and `madge`/driver-isolation
  timeouts are the same pre-existing clusters `agent-16` documents above; no
  new icon was added (`arrow-bar-down`, `image-solid`, `image-2-solid`,
  `loader`, `plus` are all already vendored, so no `icons:sync` run was needed).
- **Human action needed — dogfood script.** Open `/admin/site` on
  `studio-workspace/test4` and select a node:
  1. The **Export** section is the last block in the panel and is **one line
     with a `+`**. Confirm it is present on an element with **no class** (the
     rail's CSS icons are greyed out there — Export must not be).
  2. `+` → **PNG @2×** adds a row reading `PNG 2×`; its run button downloads a
     file named after the node with an `@2x.png` suffix. Open it: it must be
     **just that element**, not the whole frame. Needs
     `bunx playwright install chromium` — the crop is the one thing no test can
     prove on this machine.
  3. Select an **inline `<svg>`** (a design-system icon) → `+` → **SVG** → run.
     The file must open in a browser as a real vector. Then select a plain
     `<div>` and do the same: expect a **refusal toast naming the reason**
     ("rasterized HTML … export PNG instead"), not a downloaded file.
  4. **Copy CSS** on an element with two classes, then paste. Check the
     selector is the real `.a.b`, the values match what the panel shows, and
     nothing inherited leaked in. Repeat on an unclassed element: bare
     declarations, no invented selector.
  5. **Copy JSX**, paste, and diff against the element in the `.tsx` — it must
     be character-identical, comments and expressions included.
  6. Select a different node and back: the rows are gone (per-selection state,
     by design — say so if that feels wrong; persisting them means writing
     into the user's repo).
- **Next step:** review + merge the PR. Nothing is stacked on it. The
  `StyleCategoryRail` question in the bullet above is the only known follow-up.

---

## Blocked

*(nothing blocked — `meta-02`'s five decisions were called on 2026-07-31, see
`meta-03`)*

---

## Pending dogfood

Everything below **landed with green gates and was never driven in a browser.**
This is the checklist for the batched dogfood session. Per the
`dogfood-ui-before-gating` lesson, a green gate is not evidence that a surface
works — several features in this repo shipped "green" and unusable.

Entries still in "Recently landed" carry their own script inside the entry; this
list points at them. Scripts belonging to entries that moved to
[`docs/state-archive/2026-Q3.md`](docs/state-archive/2026-Q3.md) are reproduced
here **verbatim**, so archiving buries no dogfood step.

### Still in "Recently landed" below — the entry carries the full script

- **`panel-16` — W8-4 the Export section** (in `## Now`, not yet landed to
  `main`). Six-step script in the entry. The two steps no test can stand in
  for: whether the PNG crop actually lands on the selected element (needs
  `bunx playwright install chromium`), and whether the SVG refusal reads as
  helpful rather than obstructive on a plain `<div>`.
- **`panel-13` — W8-1 inspector field ergonomics** (in `## Now`, not yet landed
  to `main`). Open the Properties panel on a text node in `studio-workspace/test4`
  and, in one pass: (1) type `50` into Width, press **Enter** — the field must
  read `50px`, keep focus, and have its text selected; (2) type `100/2` into
  Height and Tab out — `50px`; (3) Shift+↑ on any length (should step 10, not 8),
  then Alt+↑ (0.1), then Shift+Alt+↑ (0.1 — Alt wins); (4) ↑ on **Opacity** and
  **Z-index**, which had no keyboard step at all before — confirm no `px` is
  appended; (5) Escape mid-edit — the old value must come back, and must NOT be
  overwritten by the blur; (6) the two **Flip** buttons beside Rotation — flip
  H, flip V, flip both, then flip back and confirm the `scale` declaration is
  removed from the file rather than left as `scale: 1 1`; then set
  `transform: scale(2)` by hand and confirm both buttons go disabled with a
  reason on hover; (7) **Fill** now carries a **Text** row for `color` and an
  "Add text colour" `+`, and **Effects** carries **Text shadow** rows with no
  Spread/Inset fields — check both write to the real `.tsx`/CSS on disk.
- **`panel-15` — inspector at narrow width** (in `## Now`, not yet landed to
  `main`). The rail-overlap fix, the empty-section header, and Size's W/H were
  all measured in a headless browser, but nobody has *used* the panel at 260px:
  drag the right sidebar to its minimum, confirm no control touches the rail in
  either theme, confirm an untouched section offers no chevron, turn "Expand
  style sections by default" OFF and confirm Fill's `+` both writes and opens,
  and confirm W/H still scrub and still open Fixed/Hug/Fill.
- **`panel-12` — W7-1 launcher polish** (in `## Now`, not yet landed to `main`).
  Card scale + hover lift in both themes, the rename-then-sort fix, the failed-
  listing retry, and the post-delete refetch. Five-step script in the entry.
- **`style-04` — Animations section.** Three things first: (1) an edited imported
  `@keyframes` renders from `ClassStyleInjector`'s overlay while
  `AuthoredCssInjector` still holds the on-disk snapshot — for `@keyframes` the
  LAST definition wins entirely, so confirm DOM order lands the overlay second;
  (2) the scrub against a real animated frame, and whether 1% steps feel right;
  (3) creating an animation end to end in a project with exactly one stylesheet,
  and again in one with several.
- **`server-18` — share links.** Create a share on `studio-workspace/test4`, copy
  the link, open it in a private window; then revoke and reload. Needs
  `bunx playwright install chromium` — the one thing no test covers is whether
  the headless capture produces frames on this machine.
- **`mcp-17` — the warm CLI session.** Open the AgentPanel, send two turns, and
  confirm (a) the second starts streaming with no `initialize` lines in the
  server log, (b) Stop cancels a turn and the NEXT turn still works,
  (c) "Restart agent session" visibly kills the process.
- **`struct-06` — duplicate / wrap / same-file reparent.** Dogfood the three
  gestures on an imported board; confirm the narrow reload brings the new
  element back selected-or-not as expected, then check `git diff` in the
  workspace repo.
- **`style-05` — styled-component write-back.** Measured on two OSS corpora, never
  driven in a browser.
- **`perf-04` — narrow save/reparse.** Dogfood at `/admin/site?studio` on a board
  with several frames sharing a component. Type in one text node, wait for the
  autosave, and confirm (a) only the frames that actually share the touched file
  flicker/re-render, (b) undo still walks back through the whole burst, and
  (c) a class edit that Studio refuses still re-attempts on your next save
  instead of going quiet.
- **`panel-11` — the left rail's colour identity.** Dogfood the left rail at
  `/admin/site?studio`. Expect: Explorer gold (unchanged), **Framework and
  Classes both mint** (they used to be two different colours — the shared tint is
  the point), Inspect sky, Content lilac, Comments lilac (unchanged), AI
  assistant violet. Also click any migrated async button (Account → Save profile,
  Settings → plugin dialogs, Export → Download bundle) and confirm the spinner
  appears **without the button changing width**.
- **`server-17` — Storybook CSF import.** Put a project with `*.stories.tsx` in
  `studio-workspace/` (or point `pagesDir` at one), open `/admin/site`, and:
  (1) confirm a second board named **Stories** appears in the board switcher and
  the project's own board's frame count is UNCHANGED; (2) open it and confirm one
  row per `meta.title` with the variants laid out left to right; (3) select a node
  INSIDE a story frame and confirm its text/style edits still write back (they
  land in the component's own file, warned as shared); (4) confirm the story
  frame's own args show in the panel as read-only rather than as live-looking
  inputs that eat keystrokes; (5) delete a story frame, reload, and confirm it
  stays deleted.

### Archived entries — script reproduced verbatim

**`mcp-19` — headless capture (agent verification with the tab closed).** The
DoD test proves the server stack; it cannot prove the PAGE renders correctly,
because that is the half Chromium was faked for. Please:

1. `bun run dev`, open a project at `/admin/site?studio`, then run a
   `studio_compare` or `studio_screenshot` from the agent panel and confirm the
   returned PNG looks like the board frame — not blank, not unstyled, fonts
   loaded, images present.
2. Do the same with the Studio tab CLOSED.
3. With the tab OPEN and a node selected, run a capture and confirm the canvas
   does NOT pan/zoom and the selection is NOT cleared.
4. Confirm `capturedVia` reads `"headless"` in both cases.

If step 1 shows an unstyled or blank frame, the suspect is store hydration in
`src/admin/agentCapture/CaptureApp.tsx` (`hydrateCaptureStore`) — specifically
whether `authoredCss`/`vendorCss` reached the injectors and whether the synthetic
`'studio'` breakpoint id matches the class CSS, not the driver.

**`mcp-18` — turn routing, and a chip nobody renders.**

1. **Dogfood the routing feel.** No amount of unit testing says whether "change
   the button colour to coral" *should* be a `medium`. Watch a few real turns:
   the failure to look for is a genuine build turn classified `question`, which
   shows up as a shallow answer rather than as an error.
2. **Render the chip — one line, blocked on file ownership.** `agentRoutedTurn`
   is on the agent slice and `routedTurnLabel` / `routedTurnTitle` are exported
   from `@site/agent`, but `panels/**` belonged to another agent this pass, so
   nothing renders them. The wiring is `ModelEffortPicker.tsx`'s
   `trailingLabel={agentEffort ? currentEffortLabel : routedTurnLabel(agentRoutedTurn)}`
   with `routedTurnTitle` as the tooltip. Until then the router is invisible —
   exactly the state its own doc argues against.

**`canvas-15` — viewport and keyboard staples** (`standing-02`):
`/admin/site?studio` on a project with ≥ 3 board frames. (a) Click the `%`
readout → 50 / 100 / 200 / Fit / Fill / Zoom to selection; Fit should frame every
frame with even margins, Fill should bleed off the short axis, and Zoom to
selection should be greyed out until you select a layer. (b) Zoom to ~40 %, click
a frame header, hold ← and → — the frame should slide 1 unit per press and 10
with Shift, and the move should persist across a reload. (c) Select a nested
node, press Enter repeatedly to walk in, ⇧Enter to walk back out, then Escape
once — it must clear the whole selection in ONE press, not walk up. (d) ⌘R on a
selected node opens the rename dialog and does **not** reload the browser.
(e) The `⌘`-ish icon left of the settings cog opens Settings → Shortcuts.

**`panel-10` — the class-CSS write lock.** Open a Studio board on a Tailwind or
`dist/`-CSS project and **select an element whose only class is a
compiled/unmapped one**. Expect: an amber "read-only here" banner naming the
selector at the top of the class block, every property row greyed with no ×
button, and a **"Style the element instead"** button that opens the Element
block. Then **select an element whose class lives in a hand-authored `.css`** and
confirm nothing is greyed. Finally, in the DB-backed editor (non-Studio page),
confirm **no** row is greyed anywhere.

**`style-03` — cleared declarations and breakpoint overrides.** Dogfood at
`/admin/site?studio` — clear a declaration on a class and an inline style and
confirm both disappear from disk and stay gone after a reload; then set a value
on a `mobile` frame and confirm an `@media (max-width: …)` block appears in the
stylesheet.

**`canvas-14` — prototype flow curves.** This is visual, please dogfood.

1. `bun run dev`, open `/admin/site?studio` on a project with more than one page
   (`studio-workspace/test-3` has four).
2. Add a `<a href="/sign-up">` or `onClick={() => navigate('/sms')}` to one page's
   `.tsx` and let it reload.
3. In the canvas chrome pill, press the **arrow** toggle (right of Design/Live —
   it only appears on a Studio board in design view).
4. Expect: a **grey dashed** curve from that frame to the target frame, with a
   monospace chip on it; hovering the chip cites the exact snippet and
   `file:line:col`.
5. Select an element, and in the right sidebar (now showing **Prototype**) pick a
   destination. Expect a **teal solid** curve to appear, and
   `.studio/prototype.json` to gain a link.
6. Delete the element you linked. Expect the teal curve to turn **red and dashed**
   rather than disappearing.
7. Zoom right out and right in: line weight, dash rhythm, arrowhead and chip
   should all stay the same size on screen.

**`style-02` — class assignment on a CSS-Modules project.** Dogfood at
`/admin/site?studio` — assign a class to an element and confirm the `.tsx` gains
`styles.<local>`, not a hash; then assign one to a page whose file does not
import that stylesheet and confirm the `css-module-import-missing` toast names
the import to add.

**`panel-10` / `mcp-17` — refusal chips, toasts, and the Layers footer** (the
same script appears in both entries). Dogfood at `/admin/site?studio` on an
imported project. (1) Drag a `.map` row or a shared-component element in the
canvas — a warning chip should follow the refused drop box with the reason,
readable at 25% and 200% zoom. (2) Let go: the toast should stay until dismissed,
and its button should open the right file; repeat the same drag twice more and
the toast should show `×3` rather than stacking. (3) Right-click that element in
the Layers panel — the footer under the greyed-out Delete/Duplicate should
explain why and offer "Open the array in code". Check the footer does not stretch
the menu.

**`mcp-17` — the style-compile banner.** This is a visual, first-run surface and
no static gate can tell you it looks right. Open a Tailwind or Sass project that
has never been promoted at `/admin/site?studio`. Expect the banner bottom-centre
on the board naming the toolchain. Click **Run the project's compiler**: the
board should reload and the frames should come back styled (a project with no
`node_modules` will instead stay unstyled — install deps from the Dependencies
panel, then reload). On a second project, click **Not now**, reload the page, and
confirm it stays gone — `.studio/meta.json` should show
`"styleCompilePromptDismissed": true` and NO `"trust"` key. Also confirm the
banner never appears on a plain-CSS project or in CMS (non-studio) mode.

**`mcp-17` — one real agent turn.** The observable wins are (a)
`cache_read_input_tokens` should now dominate `input_tokens` from round 2 onward
in the context meter, and (b) a multi-screen `studio_compare` should return in
roughly a quarter of the time it used to.

**`perf-03` — the windowed Layers tree, three things the tests cannot see.** Open
`/admin/site?studio` on a real imported project (a deep one — `esim-journey`, not
`untitled`), expand the active page in the Layers panel, then `Ctrl+E` to expand
everything.

1. **Scroll feel.** Wheel-scroll the layers list fast, top to bottom. No blank
   bands, no jitter, no scrollbar jump. Then switch Settings → density to
   *comfortable* (36px rows) and scroll again — the row height is measured, not
   assumed, so this is the case that would expose a wrong constant.
2. **Drag feel — the one real behaviour change.** Drag a layer to the top and
   bottom edges of the list and hold. It should auto-scroll (it did NOT before
   that branch), and the drop line should keep resolving onto rows as they scroll
   in. Drop somewhere far from where you started and confirm the move landed
   where the line said.
3. **Focus.** Click a row, press Tab/arrows to confirm it has keyboard focus, then
   wheel-scroll it far out of view and back. Focus must return to the same row,
   and `Enter` must still act on it. Also click a node on the CANVAS that is deep
   inside a collapsed branch — the tree should expand the path and scroll that row
   into view even though it was never mounted.

**`perf-03` — five measured hot-path fixes, dogfood the canvas.** Open a board
with **6+ frames at mixed widths** (`studio-workspace/test-3` has the 178 KB CSS
corpus these numbers came from) at **~50% zoom**, then: (a) type into a text node
and watch that the save status goes `unsaved` and stays there until you STOP
typing — it should not flip to `saving` mid-word; (b) drag a frame by its header
and watch that the other frames' content does not flicker/re-render; (c) zoom out
past the virtualization boundary so 6 → 15 frames mount and see whether the stall
is visibly shorter than the 290 ms `perf-01` recorded. (c) is the one number that
could not be measured without a browser.

**`server-12` — preview deploys.** Open Version control on a Tier-2 project with
a real linked Vercel or Netlify project, deploy, and confirm the URL opens. A
real deploy cannot run in CI. Nothing else is blocked on it.

**`server-17` — the Git panel.** Needs dogfooding against a real repository with
a real remote. Every route and refusal is covered by tests against real `git`
(including a push to a local bare remote), but nobody has driven the panel in a
browser.

**`panel-05` — inspector disclosure wave 2.** Drive `:5173`: a plain `<div>` with
no `display` should show the display switcher, a two-field padding row, a Clip
content checkbox and a resident ⚙ — open it and confirm `alignSelf` is writable.
Then `display: flex` → the 3×3 pad, gap, and container-only rows appear in the ⚙;
`display: grid` → the inverse. Check Size shows one row for a width-only element
and that "Add minimum width" writes nothing until you type. Check Typography is
four rows and its ⚙ tabs. Check Position's rotation field, and that a node with
`transform: translateX(20px)` keeps it.

**`panel-04` — inspector disclosure wave 1.** Drive `:5173`: (a) select a plain
`<div>` with an empty class and confirm Background/Border/Effects/Interaction/
Typography are single `+` lines while Position/Size/Layout/Spacing keep their
controls; (b) set a value on a non-desktop breakpoint and confirm that section
stays open with its dot lit on the Desktop tab; (c) select a div inside a flex row
and confirm the align buttons that cannot write honestly are disabled *with a
reason*; (d) set `position: absolute` and confirm the Left▾/Top▾ pickers move the
value rather than duplicating it.

---

## Recently landed

Newest first, capped at ~10. Everything older was moved **verbatim** to
[`docs/state-archive/2026-Q3.md`](docs/state-archive/2026-Q3.md) — see Archive
below for the index. When this list grows past ~10, move the overflow there in
the same shape; do not summarise it away, and hoist any un-run dogfood script
into "Pending dogfood" first.

### export-boards — every board is a tab in the downloaded code
- **Agent:** server-engineer · **Stage:** done (targeted gates green; draft PR open) · **Updated:** 2026-09-07
- **Branch:** `feat/export-boards-as-tabs` off `origin/main`.
- **User report, verbatim:** "I created another board, and don't see it in the
  exported one when download code — I should see the boards as tabs in the
  downloaded one."

**Where the generator was.** Not on `main` at all. The whole preview shell —
`server/handlers/studio/prototypeShell/` (8 modules, `ensurePrototypeShell`,
the thing that writes `registry.generated.jsx`) — lives only on the unmerged
branch `origin/feat/prototype-mode`. That is why `studio-workspace/test4/`
has a `prototype/` directory whose registry still says `Board 1` while
`.studio/boards.json` says `Test` + `Testtt`: those files were written by a
run of that branch, and nothing on `main` has regenerated them since. The
export was not dropping the second board — **nothing was regenerating at
all.**

**Brought across (the minimal coherent slice, not the branch):**
- `server/handlers/studio/prototypeShell/*` (8 modules) + its
  `__tests__/prototypeShell.test.ts` (25 tests, green as-ported).
- The three parse-side guards the shell cannot exist without —
  `PROTOTYPE_SHELL_DIR`/`isPrototypeShellPath` in
  `src/core/page-parser/workspaceFiles.ts` (+ barrel), `findEntryFile`
  (`collectPageStylesheets.ts`), `NON_PAGES_DIR_SEGMENTS` (`projectProbe.ts`),
  `extractLocalComponentCatalog` (`componentSpecExtract.ts`). Without these,
  Studio reads its own scaffold back as the user's design — `shell.css` lands
  in their style rules and `CanvasPanel` shows up in the component picker.

**Shipped on top:**
1. **Regeneration before the zip.** `buildStudioDownloadResponse` calls
   `ensurePrototypeShell(dir)` first. This is the actual fix for the report:
   the load memo (`workspaceLoadFingerprint`) covers the user's SOURCE, not
   `.studio/boards.json`, so creating a board is a memo **hit** — a
   regeneration hung off the parse alone would be skipped exactly when the
   boards it reads have changed. `loadStudioPages` also calls it, placed
   BEFORE the memo for the same reason.
2. **Boards render as tabs in both views.** The tab row was gated on
   `view !== 'canvas'` — invisible in the view a downloaded prototype opens
   on — while the canvas stacked every board as a titled row. It is now
   `BOARDS.length > 1` unconditionally, and `CanvasPanel` draws the ACTIVE
   board only.
3. **The screen row is scoped to the active board** (`boardScreens`), falling
   back to every screen for a board with no frames. Switching to a board that
   does not hold your current screen lands you on that board's first frame
   instead of stranding the flow view.
4. `LINKS` stays project-wide on purpose — a link addresses a SCREEN, not a
   board, so scoping it to the tab would break a jump to a screen the author
   put on a different board. Reasoned in the emitted comment and in the doc.

**Why bumping `App.jsx` is allowed.** `.studio/shell.json` records the SHA-256
of every static shell file Studio wrote. A file whose hash still matches is
one nobody edited and is updated; a file whose hash differs belongs to the
user and is never written again. All 11 shell files in `test4` currently hash
MATCH, so it picks up the tabs on the next open or download. That mechanism is
the contract, documented in `docs/features/prototype-export.md` §2.

**Cuts — named, not hidden.** From `origin/feat/prototype-mode` I deliberately
did NOT bring: the trash subsystem (`pageTrash.ts`, `projectTrash.ts`,
`trashRoutes.ts` and the `projectRoutes.ts`/`studio.ts` rewiring that comes
with it), the MCP `prototypeTools.ts`, the `navigationIntent.ts` parse
addition (code-derived connectors), `src/core/studio-anchor/` +
`src/core/studio-prototype/`, and every canvas/inspector change on that
branch. Also cut: `docs/features/prototype-mode.md` (it documents the LINK
model, which is a different feature) — I wrote a focused
`docs/features/prototype-export.md` instead. Not touched: the pre-existing
`buildStudioDownloadResponse` 404 body, which echoes the full workspace path
back to the client. It is a real (small) leak and it is not mine; flagging it
rather than widening this PR.

**Dogfood checklist for the human (no browser tests by agents):**
1. Open `test4` in Studio at `/admin/site`. Confirm `prototype/App.jsx` and
   `prototype/registry.generated.jsx` were rewritten and the registry now
   lists BOTH `Test` and `Testtt`.
2. Click "Download the code". Unzip. Confirm `prototype/registry.generated.jsx`
   in the ZIP has both boards, and that no `.studio/` entry is present.
3. Create a THIRD board in Studio and, without reloading, download again —
   the new board must be in that zip.
4. `bun install && bun run dev` in the unzipped copy. Confirm a **Boards** tab
   row above the canvas, that clicking a tab swaps which frames the canvas
   draws, and that a prototype link still jumps to its target screen.
5. Edit one line of `prototype/App.jsx` in `test4`, reopen the project, and
   confirm Studio did NOT overwrite it.

**Verification run:** `bun test server/handlers/studio/__tests__/prototypeShell.test.ts server/handlers/studio/__tests__/prototypeShellBoards.test.ts server/handlers/__tests__/studio.test.ts server/handlers/__tests__/projectProbe.test.ts server/handlers/__tests__/componentSpecExtract.test.ts server/handlers/__tests__/studioProjects.test.ts` (242 pass) ·
`bun test src/__tests__/studio` (177 pass) ·
`bun test src/__tests__/architecture/boundary-validation.test.ts src/__tests__/architecture/no-core-barrel-deep-imports.test.ts` (9 pass) ·
`tsc -p tsconfig.node.json --noEmit` + `tsc -p tsconfig.app.json --noEmit` clean ·
`bunx eslint` on all changed files clean. Emitted `App.jsx` / `registry.generated.jsx` / `CanvasPanel.jsx` / `Player.jsx` parse-checked through esbuild's JSX loader against a COPY of `test4` (user data untouched).

**Routes changed:** `GET /admin/api/studio/download` — unchanged request
(`?dir=<abs>`) and unchanged response (`application/zip`, or `{ error }` on
404). New behaviour only: it regenerates the shell before zipping.
**Rejections tested:** a `dir` that does not exist still 404s and writes
nothing; a corrupt `.studio/boards.json` yields a shell with no boards rather
than a throw or a 500; a frame whose page was deleted is dropped without
dropping its board; `.studio/` never appears in the archive.

### strict-teeth — W9-3: strict-mode teeth (crop reconciliation, font availability, named regions)
- **Agent:** mcp-tooling · **Stage:** done (targeted gates green; draft PR open) · **Updated:** 2026-09-07
- **Branch:** `feat/agent-strict-mode-teeth` off `origin/main`. Goal:
  `STUDIO-WAVE7-PLAN.md` §W9-3, the **strict half only** — a sibling agent
  owns the "creative substance" half (variants, composition audit, component
  coverage). Builds directly on W9-2 (`fidelityMode.ts`, `FIDELITY_THRESHOLDS`,
  the `compareGrading.ts`/`compareCapture.ts` split).
- **Shipped — three of the four items, in the plan's own priority order:**
  1. **`method: 'cropped-to-reference'`** — the third value in
     `ReferenceReconciliation` (`frameDiffEngine.ts`). A board frame captures
     its FULL scroll-unrolled content height, so a scrolling screen measured
     against a fixed-height artboard produced an aspect delta far past the 5%
     tolerance and got REFUSED — "match this artboard" was unmeasurable. It
     now compares the top `comparedHeight` band. Two guards keep it honest:
     the widths must match **exactly** (so the band is exact-pixel, never
     interpolated — `studio_recommend_export_dpr` already produces this, and
     the exact-width rule is also what keeps a landscape 400x100 reference
     against a portrait capture refused), and the direction is one-sided (a
     capture SHORTER than the reference is a missing section and is still
     refused). `cropImageTop` crops the baseline to the same band — a
     no-copy `subarray` view — in BOTH callers (`compare.ts`,
     `diffFrames.ts`); forgetting one would score every row against the wrong
     one. `gradeFrameDiff` gained a 4th param and `describeMethod` appends the
     method to the verdict: `exact` says nothing, `resampled` says
     interpolated, `cropped-to-reference` says the pixels below the band are
     **UNMEASURED** and not to report them as verified. `capture.width/height`
     now report the CAPTURE's own size (identical to the diff's for every
     other method) with `capture.comparedHeight` alongside.
  2. **`font-not-available`** — a new quality finding, detector in its OWN
     file (`server/ai/mcp/tools/studio/fontAvailability.ts`) per the work
     order, wired into `qualityCheck.ts` in two lines (a workspace-level
     `collectFontAvailability` beside the token index, and one
     `findings.push(...)` in the page loop) so the sibling agent owns that
     file's body. Only the FIRST family in a stack is judged. Availability is
     deliberately generous — `@font-face` in the page's sheets / compiled
     project CSS / vendor CSS, a `fonts.googleapis.com` link (css2 AND legacy
     `|` form), a `next/font/google` named import, or a matching font file
     under a bounded set of asset dirs — and `font-family: var(--font-display)`
     is resolved through the project's own custom properties (shared
     `collectRootScopeMaps`/`resolveVarValue`) before being judged. **Stands
     down entirely** when `next/font/local` appears in the scanned setup
     files: a generated family name cannot be judged from static text, and
     under-reporting is the correct direction (same bar that got the
     composition heuristic rejected).
  3. **Design-variable-aware region explanations** — `regionExplain.ts`, new.
     Each of the worst 5 regions on a FAILING page gets `colorExplanation`:
     the dominant colour on both sides, named as a design variable
     (`designVariableIndex`) and as a project token. Shares
     `referenceMeasure.ts`'s `countColors` (exported for this) rather than
     growing a second dominant-colour implementation. Returns `undefined`
     when both fills agree — that silence is the signal that the region MOVED
     rather than being miscoloured, and a colour sentence there would send the
     agent to recolour something already correct. Only a failing page pays for
     the project-token index (it compiles the project's styles, whose cache
     key hashes every source file, so post-write it is a real recompile).
- **CUT — named, for a follow-up:**
  - **`studio_ingest_design_text` + text diffing against captured `nodeRects`
    strings (item 4).** Not started. It is a whole new manifest store + tool +
    a text-diff pass, and it did not fit the time box. **Consequence to be
    aware of:** strict mode still says nothing about text fidelity, and — this
    is the part item 4 was supposed to add — it does not currently REFUSE to
    claim text fidelity either. A strict pass today means "the pixels in the
    measured band match", which a reader may over-read as "the copy is right".
    Whoever picks this up should ship the refusal alongside the tool.
  - **The crop path does not fire when the widths differ** (e.g. a 2x export
    against a 1x capture of a scrolling screen). Deliberate — the band would
    be interpolated, and that is a dpr question `studio_recommend_export_dpr`
    answers. If real usage hits this often, relaxing to a clean integer scale
    is the next move, with the note saying the band is interpolated.
  - **`colorExplanation` is colour only.** No type-size or spacing
    explanation, though `designVariableIndex` indexes sizes too.
- **Also fixed (it was in my way):** `compare.test.ts`'s
  `mock.module('../../editorBridge', …)` factory was missing
  `editorBridgeScope`, so the whole file failed at import. Added a per-dir
  stable double. With it, the file runs: **13 pass / 2 fail**, and I verified
  those same 2 fail identically on a clean `origin/main` worktree with only
  the mock fix applied — they need Chromium.
- **Dogfood checklist for the human (no browser tests by agents):**
  1. Register a design reference for a SCROLLING screen (a tall page whose
     board frame unrolls past the artboard height) at the frame's own width,
     then `studio_compare` it. It should return a verdict instead of the
     aspect-ratio refusal, `capture.dimensionMatch: "cropped-to-reference"`,
     and the verdict text should name the unmeasured pixels below the band.
  2. Register a reference for a screen that is SHORTER than the design (a
     missing section) — it must still refuse.
  3. Write `font-family: "Poppins", sans-serif` into a screen's stylesheet in
     a project that does not link Poppins, then `studio_quality_check` it: one
     `font-not-available` finding naming Poppins. Add the Google Fonts `<link>`
     to `index.html` and re-run: the finding should disappear.
  4. On a project with an ingested design-variable set
     (`studio_ingest_design_variables`), deliberately colour a block with the
     wrong token and `studio_compare`: `regions[0].colorExplanation` should
     name the design variable AND the token you actually wrote.
- **Pre-existing failures I did NOT cause and did not touch:** the icon-catalog
  `chevron-left` gate (`src/__tests__/architecture/`, 1 fail out of 505); the
  2 Chromium-dependent `compare.test.ts` cases above;
  `pageWriteVerification.test.ts` / `liveDigest.test.ts` pre-W10 arity;
  `bundle-size-budgets` skipped without a `dist/`.
- **Do not touch (concurrent agent):** `liveDigest.ts`, `boardFrames`,
  `AgentPanel`, `studio_import_figma_frame`, and `qualityCheck.ts`'s body
  (composition audit / component coverage) are owned by other Wave 7 agents.
### creative-substance — W9-3: coverage + composition teeth, and variants that actually differ
- **Agent:** mcp-tooling · **Stage:** done (targeted gates green; draft PR open) · **Updated:** 2026-09-07
- **Branch:** `feat/agent-creative-substance` off `origin/main`. Goal:
  `STUDIO-WAVE7-PLAN.md` §W9-3, **creative half only** (a sibling agent owns
  the strict half: `frameDiffEngine`, `compareGrading`, `fontAvailability.ts`,
  `studio_ingest_design_text`).
- **Shipped — 1. Component-coverage threshold in `studio_quality_check`:**
  - New finding `design-system-coverage-low` in `auditPageSourceQuality`
    (`server/handlers/studio/qualityAudit.ts`). Fires only when FOUR things
    hold, each one a way the rule would otherwise be noise: a catalog was
    resolved and offers >= 8 components; the screen has >= 15 JSX opening
    tags; `design-system-unused` did NOT fire (the zero-import case is
    reported once, by the stronger finding); and fewer than `min(4, catalog
    size)` distinct catalog components are actually RENDERED — imported *and*
    used as a JSX tag, since an unused import is not coverage. An aliased
    import counts under its catalog name, matched on the local tag.
  - The catalog is the SAME `resolveDesignSystemGuide` `projectGuide.ts`
    renders into the project's own `CLAUDE.md` decision table (exported for
    this; resolved once per call in `qualityCheck.ts` next to the token
    index). That is deliberate: resolving it a second way would let the
    finding name components the agent was never offered.
  - The message NAMES what the decision table offered and the screen did not
    take, capped at 12 names — "use more components" is unactionable.
- **Shipped — 2. Composition audit:**
  - `auditCompositionQuality(sheets, tokens)` in the same module, called ONCE
    per page from `qualityCheck.ts` over the page's whole stylesheet set:
    `off-scale-spacing`, `off-scale-type-size`, `flat-type-hierarchy`.
  - **Aggregates, not per-declaration** — one finding per rule per page with a
    count, a ratio and the offending `file:line` list. Per-declaration would
    double-report every value `raw-px-length` already flags, and 40 findings
    is a tool a weaker model learns to ignore.
  - **Page-level, not per-file** — this is a deliberate deviation from the
    plan's "in `auditStylesheetQuality`". A screen's type scale lives across
    every stylesheet it imports, so a `largest / body` ratio computed inside
    one `.module.css` measures a fragment and calls it a hierarchy.
  - Both scale rules run ONLY against tokens the project declares: no spacing
    tokens (GCD of its own `--space*` values) means NO spacing rule, never an
    invented 4px default. `flat-type-hierarchy` needs no tokens — largest vs.
    the modal (body) size, flat under 1.6.
  - The rejected class-name/word-overlap check was NOT resurrected; none of
    these use name similarity.
- **Shipped — 3. Variant style seeds (the seam, not the fan-out):**
  - `server/handlers/studio/variantSeeds.ts` — pure. `generateVariantSeeds`
    produces N seeds over four axes (type contrast, density, corner family,
    accent), each assigned WITHOUT replacement (Fisher-Yates over a
    caller-seeded mulberry32), every value taken from a token the project
    already declares. Deterministic for a given `rngSeed`.
  - **Two cross-checks make the generator and the grader agree by
    construction:** the type-contrast pool is bounded below by
    `MIN_TYPE_HIERARCHY_RATIO` *imported from* `qualityAudit.ts`, and the
    density multipliers are WHOLE multiples of the project's spacing base —
    so a seed can never propose a screen `flat-type-hierarchy` or
    `off-scale-spacing` would then flag. (The first draft used a 1.5x
    "regular" density and failed its own rule; that is why the multipliers
    are 1/2/3.)
  - `server/handlers/studio/variantStore.ts` — `.studio/variants.json`, a
    sibling of `boards.json` (NOT `cache/`: a seed set is user-facing intent
    nothing can reconstruct). Validated on read with
    `parseJsonWithFallback`, capped at 20 sets.
  - **`studio_plan_variants`** + **`studio_list_variant_sets`**
    (`server/ai/mcp/tools/studio/variantTools.ts`), wired into
    `studioMcpTools` and `STUDIO_AGENT_TOOL_NAMES`.
  - `MODE_BLOCK.creative` now names the tool and the fan-out shape.
- **Tool inventory (mcp-tooling handoff requirement):**
  | Tool | Class | Capabilities | Input | Failure message when the precondition is missing |
  |---|---|---|---|---|
  | `studio_plan_variants` | server-resolved | `['studio.write']` (persists `.studio/variants.json`; never touches user source, never creates a page, never runs project code) | `{ dir?, baseName, brief, count? 2..4, rngSeed? }` — no output directory anywhere in the family | A non-PascalCase `baseName` is refused by name ("it becomes a real .tsx file name — pass \"Home\", not \"home page\" or \"Home.tsx\""). An empty token index does not fail: it returns seeds with no token names, a per-axis "no token found" line in each directive, and a `note` pointing at `studio_project_profile` for the style-compile warning. |
  | `studio_list_variant_sets` | server-resolved | none (read) | `{ dir?, setId? }` | Unknown `setId` → refused with the ids that DO exist; none recorded at all → says so and names `studio_plan_variants`. |
  - `studio_quality_check` is unchanged in class/capabilities (server, read) —
    only its findings and description grew.
- **CUT — named:**
  - **The variant fan-out itself.** `studio_plan_variants` PLANS: it does not
    create `HomeA/B/C` or place them side by side on the board. Not laziness
    — page creation and `.studio/boards.json` are the orchestrator's alone
    under `docs/features/agent.md`'s subagent contract, and another agent
    owns `boardFrames` this wave. Hence `plan`, not the plan's optional
    `build`: the name says which half it owns. The agent creates the pages
    with the tools it already has and sends each `directive` verbatim.
  - **No `studio_edit_variant_seed`.** "Make B but tighter" is currently: read
    the set back, then re-run `studio_plan_variants` with the same `rngSeed`
    or hand-author the change. The seed is RECORDED (which is the property
    that makes the edit possible at all); a first-class edit verb is not.
  - **The composition thresholds are chosen, not measured** — 1.6 for flat
    type, >= 6 spacing samples, >= 15 elements for coverage, >= 8 catalog
    entries, K=4. Only the 2-of-42 observation behind K is real data. If any
    of these turn out noisy, they are all single named constants.
  - **Coverage counts JSX tags textually.** A component rendered only through
    a variable (`const C = cond ? Card : Cell`) is not counted. Under-scans
    rather than mis-scans, same posture as every other rule in the module.
- **Dogfood checklist for the human (no browser tests by agents):**
  1. Run `studio_quality_check` on a real screen in a project with a design
     system installed. A thin screen should now come back with
     `design-system-coverage-low` NAMING real component names from that
     project's `.claude/design-system-components.md` — if it names something
     that file does not list, the catalog resolution is wrong.
  2. On the same screen, check the composition findings are ONE each, not one
     per declaration, and that the `file:line` list points at real lines.
  3. In a project with NO spacing tokens, confirm `off-scale-spacing` is
     absent entirely (not "everything is off-scale").
  4. In creative mode, ask for a home screen "a few different ways" and check
     the agent calls `studio_plan_variants`, then fans out with the returned
     directives verbatim. Then ask "make B tighter" and confirm it reads
     `.studio/variants.json` rather than re-rolling.
  5. Eyeball `.studio/variants.json` — it should be small, readable, and hold
     the `rngSeed`.
- **Pre-existing failures I did NOT cause and did not touch:**
  `server/ai/tools/studio/liveDigest.test.ts` (2) and
  `server/handlers/studio/pageWriteVerification.test.ts` call
  `appendTurnWrite`/`computePageWriteVerification` with the pre-W10 arity;
  `server/ai/mcp/tools/studio/compare.test.ts` fails to import
  (`editorBridgeScope`); icon-catalog `chevron-left`; headless-capture suites
  need Chromium.
- **Merge note for the sibling strict agent:** you will add a one-line
  `fontAvailability` call in `qualityCheck.ts`. My changes there are the
  import line, the catalog resolution next to the profile probe, the extra
  `catalog` argument on the `auditPageSourceQuality` call, and the
  sheet-text collection + `auditCompositionQuality` call after the sheet
  loop. Nothing overlaps the page-source audit's call site beyond that
  argument.
### figma-pipeline — W9-4: a pasted Figma link becomes a strict, exactly-sized reference in one call
- **Agent:** mcp-tooling · **Stage:** done (targeted gates green; draft PR open) · **Updated:** 2026-09-07
- **Branch:** `feat/agent-figma-link-pipeline` off `origin/main` (db774d5). Goal:
  `STUDIO-WAVE7-PLAN.md` §W9-4, items 1-3.
- **Shipped:**
  - **`server/handlers/studio/figmaUrl.ts`** — the ONE Figma-link parser, a
    dependency-free leaf (not even TypeBox). `parseFigmaUrl(url)` ->
    `{ fileKey, nodeId, nodeIdPlaceholder }`, normalising both separators
    Figma uses (`123-456` and `%3A`) to the canonical `123:456`, and
    accepting all four URL shapes (`/design/`, `/file/`, `/proto/`,
    `/board/`) instead of only today's. `findFigmaUrlInText(text)` finds the
    FIRST figma.com URL in free text and strips the sentence punctuation
    `\S+` swallows (`…node-id=1-2.` and `](…)` both used to corrupt the node
    id). Extracted OUT of `figmaCodeConnect.ts` — `parseFigmaConnectUrl` is
    deleted, not forwarded; its call site maps to the binding field names
    inline. 13 unit tests in `figmaUrl.test.ts` (the four that moved verbatim
    out of `figmaCodeConnect.test.ts` plus the shapes the new callers meet).
  - **`StudioLiveDigest.figmaLink`** (`liveDigest.ts`) — `{ url, fileKey,
    nodeId }` for the first Figma URL in the user's message, computed
    UNCONDITIONALLY (the nudge keeps its three extra preconditions and is now
    derived from this field). `nodeId` is `null`, never the raw text, for a
    placeholder or missing `node-id`, so nothing downstream can hand a
    `REPLACE-ME` to a Figma tool. The prompt's nudge line now names the
    identifiers and points at the new tool instead of at the six-step ritual.
  - **`studio_import_figma_frame`** (`server/ai/mcp/tools/studio/
    importFigmaFrame.ts`) — `execution:'server'`, `mutates:true`,
    `requiredCapabilities:['studio.write']`. Input:
    `{ dir?, pageId, url?, exportPath?, node?, variables?, mode?, label? }`,
    TypeBox, `additionalProperties:false` at the top level, fields read by
    name (never spread). Four legs, each with its own status code:
    `frame.status` (`resized`/`already-matched`/`no-bounding-box`/
    `out-of-range`/`no-frame-for-page`/`section-not-sized`),
    `reference.status` (`registered`/`not-provided`/`failed`),
    `variables.status`, `screenDetection` (`single-frame`/
    `section-of-screens`/`no-metadata`/`no-bounding-box`). A missing export
    still resizes the frame. Defaults `role:'spec'` + `mode:'strict'`.
    **The frame sizing is the point** — it kills the resample class (test4's
    800-tall refs vs 788-808-tall frames) by setting `.studio/boards.json`
    from `absoluteBoundingBox` through `boardFrames.ts`, the same write path
    `studio_set_frames` uses, after `syncBoardFramesFromDisk` so a page the
    agent wrote moments ago is placed rather than reported missing.
  - **Section -> N screens** — a direct child counts as a screen when it is
    visible, FRAME-like, >=240x320 AND >=50% of the parent's height. That
    last clause is the whole discriminator (screens sit side by side and are
    nearly as tall as the section; a hero inside one screen is a fraction of
    its height). Two or more make it a section: **nothing is resized**, and
    `screens[]` enumerates name/nodeId/size. `detectScreens` is exported and
    unit-tested on its own.
  - **`visible:false` layers** are counted (never descended into — a layer
    under a hidden layer is not a second finding), up to 20 named back, with
    the note that says what it is for.
  - **`server/ai/mcp/tools/studio/readProjectImageBytes.ts`** — the
    containment-checked project-image read, extracted verbatim out of
    `designReferenceTools.ts` so both register paths share one
    implementation (realpath-based containment, and the "your chat
    attachment is already registered as X" refusal).
    `DesignVariableEntrySchema` + `toRawDesignVariableEntries` are now
    exported from `designVariableTools.ts` for the same reason.
  - Registered in `mcp/tools/studio/index.ts` AND in
    `server/ai/tools/studio/agentToolNames.ts` (the in-canvas agent is the
    primary consumer). Docs: `docs/features/agent.md` (tool-table row + a
    full "The Figma-link pipeline" section with the status-code table),
    `docs/features/mcp-connectors.md`.
- **Studio still never talks to Figma.** The tool fetches nothing, accepts no
  token, stores no token, logs no token and returns no token. `url` is
  provenance text only; every Figma-side input is something the AGENT already
  fetched through its OWN connector.
- **CUT — named:**
  - **W9-4 item 4, connector discoverability in the Agent Panel, is NOT
    done.** The four connector states are computed server-side
    (`buildStudioCapabilityDigest`) and reach the PROMPT only — nothing
    exposes them to the browser. Surfacing them needs a new
    `GET /admin/api/studio/...` route + schema + a panel affordance linking to
    Settings -> MCP servers; that is a whole vertical slice, not a trim, so it
    was cut rather than half-built. Next agent: the digest already computes
    `figma.status` and `loopbackAssetFetchBlocked` — only the transport and
    the UI are missing.
  - **Pages are enumerated, never auto-created** for a section. Creating N
    Studio pages from one tool call would write files the user never asked
    for under names this tool would have to invent. `studio_create_page`
    exists and is cheap; the enumeration is what was missing.
  - **The screen-detection ratio (0.5) is chosen, not measured.** It is
    deliberately conservative — a false `single-frame` is a much cheaper
    mistake than a false `section-of-screens` that sends the agent building
    four pages nobody asked for.
  - **No `imageBase64`/`url`-fetch input on the new tool.** `exportPath` is
    the route that actually works with a Figma connector (its asset-download
    tool writes real files); `studio_register_design_reference` still has the
    other two for the cases that need them.
- **Dogfood checklist for the human (no browser tests by agents):**
  1. With a Figma connector signed in, paste a frame URL into the composer
     with a page selected. The prompt nudge should now name the fileKey and
     the node id in COLON form (`53958:5861`), not the dashed URL form.
  2. Ask the agent to import it. Confirm ONE `studio_import_figma_frame` call
     replaces the register/ingest/set_frames sequence, and that
     `.studio/boards.json`'s frame for that page comes back at the Figma
     frame's exact width/height.
  3. Run `studio_compare` after. It should report an EXACT dimension match,
     not `dimensionMatch: "resampled"` — that is the whole point of the row.
  4. Paste a SECTION url (a board of screens). The tool must resize nothing
     and list the child screens with their node ids.
  5. Ask for the import with no export downloaded: the frame should still be
     resized and `reference.status` should read `not-provided` with a note.
- **Pre-existing failures I did NOT cause** (verified against a detached
  `origin/main` worktree: `bun test server/ai/mcp` is **20 fail** on baseline
  and **20 fail** with my change, +26 new passing tests):
  `compare.test.ts` still fails to import (`editorBridgeScope` not exported
  from `editorBridge.ts`) — identical at baseline; `headlessCapture`,
  `computedStyles`, `gitTools`, `liveReloadPush`, `pageDiagnostics` are
  sandbox/browser-environment. **Fixed in passing** (in scope because I
  touched the file): `liveDigest.test.ts`'s pre-W10 `appendTurnWrite` arity.
  `pageWriteVerification.test.ts` has the same class of failure and is NOT
  mine.

### fidelity-modes — W9-2: creative / balanced / strict, one control from prompt to gate
- **Agent:** mcp-tooling · **Stage:** done (targeted gates green; draft PR open) · **Updated:** 2026-09-07
- **Branch:** `feat/agent-fidelity-modes` off `origin/main`. Goal:
  `STUDIO-WAVE7-PLAN.md` §W9-2.
- **Shipped — the vertical slice, end to end:**
  - `server/handlers/studio/fidelityMode.ts` — the vocabulary
    (`FIDELITY_MODES`), the ONE precedence function (`resolveFidelityMode`:
    tool arg > per-reference `mode` > per-turn > per-project > derived), the
    threshold table (`FIDELITY_THRESHOLDS`: creative 80/12, balanced 92/6,
    strict 99/0.5 + a 400px²-at-1x area floor), and `scaledMaxRegionPixels`.
    Pure, no I/O. `designReferenceSchema.ts`'s
    `DESIGN_REFERENCE_FIDELITY_MODES` is now an alias of it — one vocabulary.
  - `server/handlers/studio/projectFidelityMode.ts` — the disk half
    (`resolveProjectFidelityMode(dir, userKey, turn?)`). Its own module
    because `studioMeta.ts` imports `fidelityMode.ts` for the vocabulary at
    module-init time, so a meta read inside that file would close a cycle.
  - **Wire:** `fidelityMode` on `AiChatRequestBodySchema`, `AiStreamRequest`,
    `ToolContextBase` and `ToolContext`. Resolved ONCE in `chat.ts` (the only
    place holding both the turn value and the account key), then fed to the
    prompt and to tools.
  - **Prompt:** `MODE_BLOCK` in `server/ai/tools/studio/systemPrompt.ts`,
    folded into the STATIC prefix (`prefix = base + MODE_BLOCK[mode]`) so each
    mode is its own cache partition. Each block ends in a DONE definition
    reachable in that mode; the numbers are interpolated from
    `FIDELITY_THRESHOLDS` so the prompt cannot state a bar the tool does not
    apply.
  - **`studio_compare`:** an optional `fidelityMode` argument; the mode is
    resolved **per page** (tier 2 is the reference's own `mode`, so two pages
    in one batch can grade differently); the mode's thresholds replace the old
    hardcoded 98/1.5; strict adds the scaled area floor AND refuses the
    project-wide reference fallback by name. Every result reports
    `thresholds.fidelityMode`. The verdict cache key gained the mode (strict
    carries a third threshold the two numbers do not encode).
  - **Stop gate, strict half:** `pageVerificationStore` records the mode each
    pass was graded at; under strict, `computePageWriteVerification` reports a
    balanced-graded pass as `staleFidelityMode` and `describeUnverifiedPage`
    gives it its own branch ("re-measure, do not rewrite"). `stopGateCheck.ts`
    and `liveDigest.ts` both resolve the mode through
    `resolveProjectFidelityMode`, so gate and digest can never disagree.
  - **UI + persistence:** third `ContextMenu` trigger in
    `AgentSessionControls.tsx` (`Project default` is a first-class option;
    store value `null` = let the server decide), persisted per project AND per
    account through the existing `GET/POST /admin/api/ai/studio-session`.
    `withAgentSessionEffort` was generalised to `withAgentSessionControls`, and
    the route's fields are now optional-and-nullable — omitted means "leave
    alone", so the two pickers never wipe each other.
  - Docs: `docs/features/agent.md` (new "Fidelity modes" section + the
    threshold and session-control paragraphs), `docs/features/mcp-connectors.md`
    (strict refuses tier 2). Tests: `fidelityMode.test.ts` (17, precedence +
    thresholds + area-floor scaling).
- **CUT — named, for W9-3:**
  - **The creative and balanced halves of the mode-aware Stop gate.** Creative's
    DONE is a passing `quality_check` since the last write, which needs a
    quality-check verification record that does not exist (the store only
    records compares); balanced's "every deviation named" is not
    machine-checkable from the gate's side. Both fall through to the pre-W9-2
    rule (any post-write passing compare) — the safe direction: it asks for a
    measurement, it never waves a page through. Only the STRICT half is real.
  - **Creative's numbers (80 / 12%) are chosen, not measured.** Balanced and
    strict are the spec's; creative's are a judgement call about what
    "directional" should mean. If a creative-mode compare turns out to pass
    junk, tighten there first.
  - **No creative-mode variant plumbing.** The prompt block asks for N
    variants; nothing in the tool surface batches or scores them.
- **Dogfood checklist for the human (no browser tests by agents):**
  1. Open a project at `/admin/site`. The composer row should show a third
     trigger reading `Fidelity` (project default). Pick `Strict`; reload the
     page — it should come back Strict. Switch projects and back.
  2. With a design reference registered for a page, ask the agent to build it
     at Strict and confirm `studio_compare` reports
     `thresholds.fidelityMode: "strict"` and 99 / 0.5.
  3. Register a reference with NO `pageId`, then compare that page at Strict —
     it must refuse by name rather than grade against the stand-in.
  4. Compare a page at Balanced (pass), then switch to Strict and try to end
     the turn: the Stop gate should ask for a re-measure at strict, NOT for a
     rewrite.
- **Pre-existing failures I did NOT cause and did not touch:**
  `server/handlers/studio/pageWriteVerification.test.ts` (3) and
  `server/ai/tools/studio/liveDigest.test.ts` (1) call
  `computePageWriteVerification`/`appendTurnWrite` with the pre-W10 arity (no
  `userKey`); `server/ai/mcp/tools/studio/compare.test.ts` fails to import
  (`editorBridgeScope` not exported from `editorBridge.ts`); `headlessCapture`,
  `computedStyles`, `gitTools`, `liveReloadPush`, `pageDiagnostics` failures are
  sandbox/browser-environment, not code.
### inspector-w8-4-constraints — Figma's crosshair, over mappings that refuse when they'd lie
- **Agent:** panel-designer · **Stage:** done (targeted gates green; draft PR open) · **Updated:** 2026-09-07
- **Branch:** `feat/inspector-constraints` off `origin/main`. Goal:
  `STUDIO-WAVE7-PLAN.md` §W8-4 **Constraints row only**.
- **Shipped:**
  - `constraintMapping.ts` — a pure module owning BOTH directions (style bag →
    current constraint per axis; constraint choice + bag → one CSS patch, or a
    named refusal). 46 unit tests in `constraintMapping.test.ts`, written
    before the UI. Mappings: start/end = one inset, opposite cleared; stretch =
    both insets, size cleared; **Scale = `%` insets** derived from the measured
    containing block; **Centre = `50%` + a `-50%` pull-back**.
  - Centring writes the **standalone `translate` property**, not
    `transform: translateX(-50%)` — same reasoning as `RotationRow`'s `rotate`
    and `flipValue.ts`'s `scale`. Two refusals, both named in the disabled
    control's tooltip: a `transform` already carrying a translate-family
    function, and a `translate` component on this axis that is somebody else's
    real value (`10px`, `calc()`, `var()`, a 3D third component). Leaving
    centre releases only a `-50%` this control itself wrote.
  - Scale refuses without a measurement (no live frame, or `position: fixed`
    whose containing block is the viewport this read does not measure) rather
    than inventing a percentage.
  - `resolvePositionedContext` gates the whole cluster: `fixed` ok, `absolute`
    ok only when the element's own parent IS its containing block (computed
    `position !== static`, or a `transform`), unverifiable → disabled with
    "Can't verify…" — `resolveAlignWrite`'s posture, reused not re-derived.
  - `ConstraintsDiagram.tsx` + `.module.css` — the crosshair: two nested 3×3
    grids, four edge bars and one centring line per axis, all `Button`
    primitives, tokens only, Figma's own toggle semantics
    (`nextModeForEdgeToggle`: second pin → stretch, un-pinning the last pin →
    Scale). Scale is drawn as dashed box edges so it is distinguishable from
    "no constraint". Mounted to the RIGHT of the existing side pickers, which
    are unchanged and still the substance.
  - Docs: `docs/features/inspector-disclosure.md` **§G10.3** (new; existing
    numbering untouched).
- **CUT — named:** (a) no drag-to-reposition inside the diagram (Figma lets you
  drag the inner box); (b) the diagram does not surface a per-axis text caption
  — the mode is in the group's `aria-label` and each control's tooltip only;
  (c) `position: fixed` gets no Scale (the viewport is not measured); (d) one
  crosshair click still lands as 2–3 undo entries — the panel's commit channel
  is per-property, and widening it means touching
  `StyleSectionsEditor`/`StyleRuleComposer`/`InlineStyleComposer`, which are
  other agents' territory this wave.
- **Files touched:** `src/admin/pages/site/panels/PropertiesPanel/` →
  `constraintMapping.ts` (new), `constraintMapping.test.ts` (new),
  `ConstraintsDiagram.tsx` (new), `ConstraintsDiagram.module.css` (new),
  `PositionConstraints.tsx`, `PositionSection.module.css`,
  `__tests__/positionSection.test.tsx`. **No new tokens added to
  `globals.css`** — the widget is built from `--overlay-*`,
  `--inspector-field-bg`, `--text-subtle`/`--text`/`--text-bright`,
  `--radius-sm`, `--space-xs`, `--inspector-field-gap`.
- **Human action needed (dogfood):** open the Position section with a node at
  `position: absolute` inside a `position: relative` parent, on a live canvas
  frame, and check: (1) the crosshair's pressed bars match the insets the side
  pickers show; (2) clicking the right bar while Left is pinned gives Left+Right
  and clears `width`; (3) the centring line writes `left: 50%` + `translate:
  -50%` and moves the element on canvas; (4) with `transform: translateX(4px)`
  already on the node, the centring line is disabled and its tooltip names that
  transform; (5) select a node whose parent is `position: static` — the whole
  crosshair should dim and every tooltip should say the parent isn't
  positioned; (6) at the panel's narrowest, confirm the 76px diagram has not
  squeezed the `Left ▾` + offset row into an unusable width (it is
  `minmax(0, 1fr) auto` — this is the one layout risk I could not check
  without a browser).

### inspector-w8-3-p1 — multi-select edits inline styles across N nodes, with Mixed
- **Agent:** studio-implementer · **Stage:** done (gates green; draft PR open) · **Updated:** 2026-09-07
- **Branch:** `feat/multi-select-inline-bulk-edit` off `origin/main`. Goal:
  `STUDIO-WAVE7-PLAN.md` §W8-3 **phase 1 only**.
- **Shipped:** `setNodesInlineStyles(nodeIds, patch)` over `mutateTreesForNodeIds`
  (one undo step for N, cross-frame; shares `applyInlineStylePatch` with the
  single-node action); `multiSelectStyleBags.ts` collapsing N nodes into the
  `storedStyles`/`currentStyles` pair `StyleSectionsEditor` already renders;
  `MultiInlineStyleComposer` mounted in `MultiSelectionInspector`;
  `StyleTargetChip` pinned to Element with the stated reason
  (`lockedToElementReason`); Mixed rendering in `SegmentedControl`, `Select`,
  `Input`, `TokenAwareInput`, `ColorValueInput` (shared `MIXED_PLACEHOLDER`),
  routed through `ClassPropertyRow` + `resolveStylePlaceholder`;
  `isSelectorMultiSelect` fixed from ≥1 to ≥2. Docs:
  `inspector-disclosure.md` **§9** (new, existing §-numbers untouched),
  `agent-refs/editor-store.md`.
- **CUT — next agent picks these up:** (a) **W8-3 phase 2** —
  `StyleWriteLockContext` carrying a COUNT ("writes to 3 of 5 — 2 are compiled")
  instead of a boolean; (b) **W8-3 phase 3** — class-target bulk behind a "this
  class is used by N other elements — continue?" gate, plus G6.4 Selection
  colours; (c) **the bespoke-section Mixed gap** — Spacing/Layout/Position/Size/
  Typography/Appearance/Fill/Border read raw cells via `readString`, which
  returns `undefined` for `MIXED`, so they render their ordinary *unset* state
  (blank field / no pressed segment) instead of the word "Mixed". The primitives
  already take `mixed`; each field is a one-line wiring change. Left undone
  deliberately — five of those sections were owned by parallel agents this wave.
- **Needs human dogfood** (no e2e for UI): open `/admin/site`, shift/⌘-click 2+
  layers on the canvas → the Properties panel should show the action bar, an
  `Editing: [Element] Class Assign` chip with Element pressed/disabled and the
  tooltip "Bulk edits write inline styles — class edits need a single
  selection", then the full style sections. Set `cursor` differently on two
  layers first (single-select each, Interaction section) → re-select both →
  the Cursor field must read placeholder **Mixed**; type a value → both layers
  change and ONE Ctrl+Z reverts both. Then tick ONE checkbox in the Selectors
  panel → the single-selector inspector (not the bulk bar); tick a second →
  the bulk bar.
- **Verification:** `tsc -p tsconfig.app.json --noEmit` and
  `tsc -p tsconfig.node.json --noEmit` clean; `eslint` clean on every touched
  path; new/updated tests green (`multiSelectInlineStyles`,
  `multiSelectStyleBags`, `mixedValueControls`, `multiInlineStyleComposer`,
  `selectorMultiSelectTrigger`, `selectorsPanel`); the gates this touches
  (`module-size-budgets`, `css-token-policy`, `no-css-var-fallbacks`,
  `button-primitive-usage`, `no-full-site-scan-in-selectors`,
  `css-token-vocabulary`, `boundary-validation`, `ui-primitives-location`) all
  pass. **Not mine:** the icon-catalog gate (whole `pixel-art-icons/dist` cluster),
  `ai-driver-isolation`, and `no-circular-dependencies` — which TIMED OUT at 60s
  under parallel `tsc` load rather than reporting a cycle. The full `bun run build`
  / `bun run lint` were killed by the same contention; both halves of `tsc -b`
  were checked individually instead.
- **Four selectorsPanel tests were updated, not broken:** they asserted the old
  ≥1 bulk trigger. One now adds a second locked utility locally (the shared
  fixture's exact contents are asserted by sibling tests, so it was not touched).

### docs-06 — W9-1.4: prose for every agent tool, plus three comment-truth fixes
- **Agent:** studio-scribe
- **Stage:** done (gates green; draft PR open)
- **Updated:** 2026-09-07
- **Branch:** `docs/agent-tool-prose` off `origin/main` (`f65c4ef`). Note: the
  branch NAME was already checked out by another worktree, so the commit was
  made on this worktree's own branch and pushed to `docs/agent-tool-prose` on
  the remote. Nothing was lost — the local branch of that name held zero
  commits ahead of `origin/main`.
- **Goal:** `STUDIO-WAVE7-PLAN.md` §W9-1 item 4, all four parts. Docs + the test
  fix + comment truth only; deliberately zero behaviour change.
- **Scope:** `docs/features/agent.md`,
  `server/handlers/studio/{projectMcpApprovals.ts,projectMcpApprovals.test.ts,remoteAssetFetch.ts}`,
  `server/ai/tools/studio/systemPrompt.ts` (one prompt paragraph), `STATE.md`.
- **Done so far:**
  - **The "19 of 31" is exactly right, and the 31 is `STUDIO_AGENT_TOOL_NAMES`,**
    not the MCP registry (which is 48 `studio_*` + `get_context` + 2 `mcp_*` +
    the 35 CMS `site_*`). The 19 with zero mentions in `agent.md` were:
    `computed_styles`, `page_diagnostics`, `quality_check`, `typecheck`,
    `fidelity_report`, `list_design_references`, `read_design_reference`,
    `ingest_design_variables`, `list_design_variables`,
    `read_design_variable_set`, `set_frames`, `list_comments`, `reply_comment`,
    `resolve_comment`, `project_profile`, `list_pages`, `list_tokens`,
    `find_component`, `install_status`.
  - `agent.md` gained a **Studio tool index** (all 31, with where each runs and
    its capability gate) + a registry-only table (17 more) + a paragraph on
    `get_context` / `mcp_list_project_servers` / `mcp_propose_server` /
    `site_read_styles` / `site_publish`, then seven new prose sections covering
    all 19. Every claim was read out of the tool's own source, not its name.
  - **`projectMcpApprovals.test.ts` fixed properly, not shimmed.** It imported
    `assertKnownAgentTools` + two others from `./agentRosterMcpTools`, a module
    deleted with the subagent roster. The two survivors moved to
    `./projectMcpApprovals`; the roster gate did not survive and has nothing
    left to gate, so its `describe` block, the `StudioAgentDef` import and the
    `agentDef` helper were deleted rather than resurrected. 7 tests pass.
  - **`remoteAssetFetch.ts:210` corrected.** It claimed Figma's Dev Mode server
    at `127.0.0.1:3845` is "the ONLY Figma server a Studio agent gets
    (`BUILT_IN_MCP_SERVERS`)". False since `figma` moved to the remote endpoint:
    `BUILT_IN_MCP_SERVERS` now ships exactly `https://mcp.figma.com/mcp`. The
    loopback escape hatch is still real and still needed — it just serves a
    server the *user* registers, which is precisely why it stays an env var.
  - **`systemPrompt.ts:274` had drifted twice.** It told the agent
    `studio_screenshot`/`studio_compare` "drive the live board in the user's
    browser" — untrue since W4-2A: `captureFrames` renders headless off disk
    FIRST and only falls back to the tab. And "waits through two full reconnect
    windows" is only true outside `RECENT_BRIDGE_MS` (60 s); inside it,
    `awaitEditorBridgeForUser` deliberately waits ONE. Rewritten to point the
    agent at `capturedVia`/`capture-unavailable` and to name
    `studio_computed_styles` + `studio_page_diagnostics` as the tools that
    genuinely need the board.
  - **Two more stale claims found and fixed in `agent.md` while there** (item 5):
    its `studio_screenshot` step 3 said "relay to the browser-side
    `studio_export_frames` handler over the live editor bridge", and
    `studio_compare` said it "captures through the live bridge". Both predate
    W4-2A's headless-first routing. Nothing describes a removed tool, and the
    "6 server-side / 29 browser-bridged" CMS counts were re-counted and are
    correct.
- **Next step:** none for this entry. If someone picks up `agent.md` again, the
  real remaining problem is length — see Landmines.
- **Decisions:** the registry-only tools got table rows with a sourced sentence
  each rather than 17 more prose sections — the doc's own established shape for
  a tool surface you reach for rather than live in, and the alternative would
  have doubled an already-oversized file. The 19 agent tools all got real prose,
  which is what the work order asked for.
- **Landmines:**
  - `docs/CONVENTIONS.md` caps a doc at ~600 lines. `agent.md` was **1226**
    before this and is **1370** after. Splitting it (the Studio tool surface
    wants to be its own doc) is a genuine follow-up, deliberately not bundled
    into a docs-accuracy PR. Do not treat the cap as satisfied.
  - `CONVENTIONS.md` rule 7 says "no history, no *we used to*". `agent.md`
    ignores that throughout, on purpose — the causal "this exists because X
    failed" framing is what stops an agent re-breaking a constraint. New
    sections match the file's voice, not the generic rule. Do not "fix" one
    without the other 1200 lines.
  - `bun run build` cannot complete in an agent worktree: `node_modules/vite`
    is absent, so `tsc -b` passes and the vite step dies on a missing module.
    Not a code failure — run the bundle half in the primary checkout.
- **Verification:** `bun test server/handlers/studio/projectMcpApprovals.test.ts
  server/ai/tools/studio/systemPrompt.test.ts
  server/handlers/studio/remoteAssetTools.test.ts` → 26 pass / 0 fail.
  `bun test src/__tests__/architecture` → 478 pass / 18 fail, **all 18 the
  known pre-existing icon-catalog `Gate 1`/`Gate 2` cluster** (`chevron-left`,
  `plus`, `undo`, …), none in a file this touched. `bun run lint` → clean.
  `bunx tsc -b` → exit 0. `bun run build`'s vite half not run (see Landmines).
- **Human action needed:** none. No UI and no behaviour changed; the one
  runtime-visible edit is a paragraph of the agent's system prompt, whose new
  claims were each read off `captureFrames.ts` and `editorBridge.ts`.

### docs-05 — W6-4: sweep `docs/` to describe the current tree

- **Agent:** studio-scribe (coordinator) + six parallel read-and-correct sweeps
- **Stage:** done (gates green; PR open as draft)
- **Updated:** 2026-09-06
- **Branch:** `docs/docs-directory-sweep` off `origin/main` (W6-4).
- **Goal:** every page indexed by `docs/README.md` either already describes the
  current tree or is corrected here; `path-index.md` reflects every file the
  waves moved/added/deleted; `glossary.md` carries the waves' new vocabulary.
- **Scope:** 38 files under `docs/` + `PROJECT-BRIEF.md` (one line) +
  `src/__tests__/architecture/no-core-barrel-deep-imports.test.ts`.
  **Deliberately NOT touched:** `docs/features/studio-prototype.md`,
  `STUDIO-PROTOTYPE-PLAN.md`, every prototype/canvas-overlay SOURCE file
  (a parallel agent owns them), `CLAUDE.md`, root `README.md`,
  `studio-workspace/`.
- **Done so far:**
  - **The gate fix.** `no-core-barrel-deep-imports.test.ts`'s
    `BARRELLED_MODULES` gained `studio-anchor` and `studio-prototype` (now
    eleven). **Zero new violations** — verified by grep before and by the gate
    after: nothing outside those directories deep-imports them today. Its
    `studio-comments` comment still named `anchorResolve.ts`; rewritten to name
    `agentGate.ts`, with a new comment explaining why the anchor model and the
    write gate are deliberately one barrel apart.
  - **The four named stale pointers, all fixed:** `path-index.md`,
    `canvas-internals.md:684` and `PROJECT-BRIEF.md` trap 10 all named the dead
    `src/admin/pages/site/canvas/__tests__/iframeCanvasQuery.ts` → real path is
    `src/__tests__/canvas/iframeCanvasQuery.ts`; `path-index.md`'s
    `studio-comments/anchorResolve.ts` row → split into `studio-comments/`
    (`agentGate.ts`) and a new `studio-anchor/` row.
  - **`path-index.md`** also gained: `studio-prototype/` + the three prototype
    handlers, `studio-capture/captureWire.ts` + `server/ai/mcp/capture/`,
    `styledStyleRuleSources.ts` + `setStyledDeclaration.ts`, the three warm-CLI
    modules, `PrototypePanel`/`CommentsPanel` + a catch-all row for the other
    seventeen panels, a catch-all row for the store slices the table omitted.
    Corrected: `colorMath.ts` → `src/core/design-tokens/`; the duplicate
    `ImportProjectDialog` row deleted; the icon-catalog `src/icons/` marked as a
    `node_modules` package path; gate count 105.
  - **`path-index.md`'s legend was incomplete** — 🔴 appeared 17 times and 🟠
    once, neither defined. 🔴 now has a definition (the security/correctness
    files); the lone 🟠 was folded into it.
  - **The "Not ours (dormant CMS)" list was wrong in two load-bearing ways**,
    exactly as `STUDIO-CMS-REMOVAL-PLAN.md`'s Trap 1 predicted: it filed
    `src/core/publisher/` (Studio's own class-CSS engine) and
    `src/admin/pages/dashboard/` (the Studio launcher) as dormant. Both
    corrected in place with the reason, not just removed.
  - **`glossary.md`:** added **Capture token**, **Code-derived connector**,
    **Share token**, **Share link**, **Styled-template writeback tier**, **Warm
    CLI session**, and a full three-value **Trust tiers** entry (0 `static` / 1
    `render-packages` / 2 `run-project`, with what each buys). Corrected six
    entries that shipped since they were written: Detach, Instance, Package
    component, Unroll (all still marked *(planned)*), `StudioEdit`'s kind list,
    and `.studio/`'s contents. **"Studio mode" is now marked historical** —
    `studioMode.ts` and `?studio` are gone; the entry says so rather than
    disappearing, because the phrase is still in circulation.
  - **`docs/README.md`:** the tree diagram was missing ten pages; the features
    list is now split Studio-first / inherited, `inspector-disclosure.md` and
    `mcp-connectors.md` are indexed, `audits/` and `assets/` are indexed **with
    an explicit warning that `audits/` is a dated historical snapshot whose
    paths were true then and are not now**, and the source-of-truth table gained
    Studio's handlers, parser/codemods and trust tier.
  - **Six parallel sweeps** corrected: `architecture.md` (opening still called
    the product a CMS; Studio absent from the layer-responsibility table),
    `server.md` (five real routers missing from the route table), `editor.md`
    (three dead workspaces in the routing table; `AdminWorkspaceCanvasLayout`
    does not exist), `design.md`/`design-tokens.md`/`ui-primitives.md` (the
    `!important` count, a `DateTimePicker` that never existed, two missing
    z-index tokens, `usePointPosition.ts` → `src/ui/lib/useAnchoredFloating.ts`),
    `admin-router.md` (six dead routes), `persistence-keys.md`,
    `editor-history.md` (six `mutate*` helpers → the real seven),
    `use-async-resource.md`, `error-boundaries.md`, `architecture-tests.md`
    (**11 gates missing, 2 rows naming deleted gates**, count 95 → 105),
    `capabilities.md` (**the whole Studio capability family was undocumented**),
    `module-engine.md`, `typebox-patterns.md`, `studio-comments.md`,
    `studio-import.md` (no `trust` row in the `.studio/meta.json` table),
    `inspector-disclosure.md` (three claims that had not actually shipped),
    `plugin-system.md`, `publisher.md`, `auth-and-access.md`, `site-shell.md`,
    `modules.md` (`studio.*` namespace absent), `spotlight.md` (three providers
    deleted), `agent.md` (warm sessions undocumented; toolset 20 → 31),
    `mcp-connectors.md` (`authProbe.ts` superseded by real OAuth),
    `site-import.md`, `html-import.md`, `conventions-quickref.md` (stale radius
    scale + missing token gates), `editor-store.md`, `canvas-internals.md`,
    `e2e/README.md` (coverage map rebuilt), `e2e/protocol.md`,
    `e2e/agent-upgrade-dogfood.md`.
  - **Verified accurate, no diff:** `CONVENTIONS.md`, `react-compiler.md`,
    `page-tree.md`, `canvas-dnd.md`, `database-dialects.md`,
    `css-class-registry.md`, `canonical-jsx.md`, `visual-components.md`,
    `editor-preferences.md`, `studio-git.md`, `studio-deploy.md`,
    `studio-share.md`, `canvas-iframe-per-frame.md`,
    `canvas-rulers-and-guides.md`, `board-annotations.md`,
    `studio-pipeline.md`, `handoff-protocol.md`, `run-log-template.md`, and all
    eight `deployment/` pages (every env var, compose service, volume and script
    re-checked against `server/config.ts`, the compose files and `Dockerfile`).
- **Next step:** none for this entry. The follow-ups it uncovered are listed
  under Landmines and are each somebody else's PR.
- **Decisions:**
  - **No doc page was deleted.** `STUDIO-CMS-REMOVAL-PLAN.md` says nothing has
    been removed at code level except the workspace routes — Tier 1 is not
    removed, Tier 2 is blocked on a product decision, Tier 3 is do-not-touch. A
    page describing still-present dormant code therefore stays, gets a
    "this is the dormant half" note if it lacked one, and gets corrected
    wherever it claimed a deleted UI. Inventing a disposition the plan does not
    state would have been the band-aid.
  - **`docs/audits/` was left uncorrected on purpose.** 31 files of dated,
    read-only audit reports naming ~25 paths that have since moved. They are a
    record of what was found on a date, and rewriting a record is worse than
    labelling it — `docs/README.md` now carries the label instead.
  - **Only the two named modules were added to the barrel gate**, though
    `studio-board`, `studio-capture` and `studio-share` all publish a barrel and
    would pass today. Widening a gate is a change with its own reason; it
    belongs in its own PR, not smuggled into a docs sweep.
- **Landmines / still owed (each needs its own PR — none are docs fixes):**
  - **The prototype-plan §1/§2/§4 rationale migration that W6-1 deferred to this
    PR is STILL DEFERRED.** `STUDIO-PROTOTYPE-PLAN.md` and
    `docs/features/studio-prototype.md` were excluded because a parallel agent
    was mid-port on the prototype/resize work. Whoever picks that up owns it.
  - **The e2e suite has real drift, not just doc drift.**
    `tests/e2e/{admin-navigation,ai,visual-builder}.e2e.ts` still
    `page.goto('/admin/content')` / `/admin/users`, which now redirect to
    `/admin/dashboard`. Those specs are very likely failing today.
  - **`docs/e2e/README.md`'s "Intentionally left agent-run only" section** (~280
    lines) still contains stale "now automated in `users.e2e.ts`" sub-clauses.
    It carries a caveat at the top rather than a line-by-line rewrite; the
    coverage table above it is the accurate source.
  - **Dead source left by the workspace deletion**, found while verifying docs:
    `src/admin/state/useWorkspaceLayoutPersistence.ts` has zero call sites;
    `src/admin/state/workspaceLayout.ts` still branches on `workspace === 'data'`
    and carries a `dataSidebarCollapsed` field; `src/admin/workspace.ts`'s own
    doc still describes `'dashboard'` as a CMS widget grid; stale comments in
    `useSiteEditorUrlSync.ts`, `OpenLivePageButton.tsx`, `useAsyncResource.ts`
    (cites a `BindingPickerPopover` that does not exist) and
    `src/core/data/schemas.ts` (cites a deleted gate test).
  - **`agent.md`'s 31-tool Studio surface is only partly explained.** Six tools
    (`studio_computed_styles`, `studio_page_diagnostics`, `studio_quality_check`,
    `studio_typecheck`, `studio_fidelity_report`, the board-comments trio) have
    real behaviour and no prose. Each needs a section, not a line fix.
  - `docs/e2e/` references four files that were never committed
    (`feature-matrix.md`, `feature-validation.tsv`, `capabilities.md`,
    `.agents/skills/studio-user-e2e/`). Flagged in place, not fabricated.
- **Verification:** `bun run build` ✅ (`tsc -b` + vite, exit 0 — needed
  `bun install` first, this worktree had none). `npx eslint` ✅ on the one
  `.ts` touched. `bun test src/__tests__/architecture` → **509 pass / 1 fail**
  (the `icon-catalog-integrity` `chevron-left` sample — `standing-01`-class).
  `bun test` → **11373 pass / 28 fail / 10 errors**; every named failure is in
  one of the three pre-existing clusters — icon-catalog, the canvas
  batch-isolation cluster (selection-leak, B3 NodeRenderer lock-down,
  breakpoint activation, body context menu, VC-ref inline body, scroll-unroll
  pin, inline-edit key forwarding, canvas form controls, panel rail), and the
  browser-dependent headless-capture suite (`captureFramesHeadless`, W4-2A
  `studio_compare`). Nothing docs- or gate-related fails.
- **Human action needed:** none. This PR ships no runtime behaviour — the only
  non-`.md` change is a gate widening that already passes.

### docs-04 — W6-1: retire the shipped plan files

- **Agent:** studio-scribe
- **Stage:** done (gates green; PR open as draft)
- **Updated:** 2026-09-06
- **Branch:** `docs/plan-file-retirement` off `origin/main` (W6-1).
- **Goal:** every root `STUDIO-*.md` either describes work still open, or is
  deleted with its load-bearing rationale folded into `docs/` and every inbound
  link retargeted.
- **Scope:** root `STUDIO-*.md`, `PROJECT-BRIEF.md`, `docs/README.md`,
  `docs/design.md`, new `docs/features/inspector-disclosure.md`, and comment-only
  edits in 47 files under `src/`. Deliberately NOT touched: `CLAUDE.md` and
  `README.md` (docs-03 owns them), STATE.md's structure (docs-02 owns it).
- **Done so far:**
  - **Deleted `STUDIO-COMMENTS-PLAN.md`** — all six phases shipped
    (`src/core/studio-comments/`, `server/handlers/studio/commentsRoutes.ts`,
    `CommentsPanel`, the three MCP comment tools), with a 467-line contract at
    `docs/features/studio-comments.md`. Its own header still read "proposed, not
    started. No comments code exists anywhere in the repo today" — false in every
    clause. Zero inbound links.
  - **Deleted `STUDIO-INSPECTOR-DISCLOSURE-PLAN.md`** — G1–G10 shipped. Folded
    §1 laws, §3 primitives, §4 goals, §6 budgets, §7 do-not-copy and §8 resolved
    decisions into the new `docs/features/inspector-disclosure.md`.
  - **Deleted `STUDIO-WAVE4-PLAN.md`** — W4-1/2A/2B/3/4A/4B and W5-2/4/5 all
    verified shipped against the tree; three tails carried forward.
  - **Kept `STUDIO-IMPORT-V2-PLAN.md`.** 9 of 10 sections shipped, but WS-3.3's
    `src/modules/alm/` deletion (deferred under `standing-07`), WS-4.4's
    package-instance detach, WS-8.1's `runScripts` default and WS-5.6's bench are
    open. Added a header banner saying it is intent, not status; corrected WS-4's
    stale "interaction layer open" claim, which `instance-ui-01` closed.
  - **Kept `STUDIO-PROTOTYPE-PLAN.md`.** Phase 5 "Play" is unstarted — `BoardMode`
    is a closed `'design' | 'prototype'` union, and `playMode`/`historyStack`/
    `runPrototype` return zero hits. It did **not** shrink to §9: §1/§2/§4 hold
    the storage and interaction-model rationale Phase 5 needs, and
    `docs/features/studio-prototype.md` does not carry it.
  - **Kept `STUDIO-CMS-REMOVAL-PLAN.md`** (not executed) and
    `STUDIO-NEXT-WORKSTREAMS.md`, which gained **WS-14** holding the five open
    code residues plus the two remaining truth-pass tasks (docs sweep, dead code).
  - `STUDIO-FIGMA-PARITY-PLAN.md` §0a now states outright that it is the single
    status ledger, and gained a waves 4–5 table verified against the tree rather
    than against PR titles.
- **Next step:** WS-14.6 (`docs/` sweep) and WS-14.7 (dead-code sweep) — both
  were blocked on W6-1..3 merging and are now unblocked.
- **Decisions:** the deletion test is **deliverables shipped**, not *plan looks
  old*. That is why the import roadmap survived a work order that named it a
  deletion candidate: it still has open deliverables, and it is the only record
  of §0's argument for the trust model and §1's ten requirements in the user's
  own words.
- **Landmines:**
  - The inspector plan was cited from **47 source files by section number**
    (`§4 G5`, `Law 3 (§1)`, `G4.9`, `G6.2`, `§3.2`). A plain delete dangles every
    one. `docs/features/inspector-disclosure.md` mirrors the plan's
    `§1/§3/§4/§6/§7/§8` numbering on purpose — **do not renumber that page.**
  - `docs/design.md` already carried the five laws in full, so only the link
    target and a stale `BorderControl` reference needed fixing (G7.6 deleted
    `BorderControl`; its `FieldRow` is gone, `LabeledControl` remains).
  - STATE.md's docs-02/docs-03 entries and `docs/state-archive/2026-Q3.md` still
    name `STUDIO-WAVE4-PLAN.md` in their `Branch:` lines. Those are historical
    records of which work order an agent ran, left as-is.
  - `docs/audits/2026-08-06/12-components-and-slots.md` cites
    `STUDIO-IMPORT-V2-PLAN.md` by **line number**; the header banner shifted those
    ~14 lines. They were already off by ~3. Not chased — dated audit archive.
- **Verification:** `bun run build` pass · `bun run lint` clean · `bun test`
  11366 pass / 27 fail / 9 errors — all 27 pre-existing (icon-catalog Gate 2, the
  canvas batch-isolation cluster, the two headless-capture tests that need a
  browser). This worktree was missing `node_modules`; after `bun install` the
  baseline dropped 54 → 27 with no change of mine involved. Every `src/` edit is
  comment-only, proven by `git diff -U0 -- src/ | grep '^+' | grep -vE '^\+\s*(\*|//|/\*)'`
  returning empty.
- **Human action needed:** none.

### docs-03 — W6-3: rule-book and identity accuracy pass (`CLAUDE.md`, README/package/index identity, the 14 agent files)

- **Agent:** studio-scribe
- **Stage:** done (gates green; PR open as draft)
- **Updated:** 2026-09-06
- **Branch:** `docs/rulebook-identity-accuracy` off `origin/main` (W6-3, `STUDIO-WAVE4-PLAN.md` §W6-3).
- **Goal:** no claim in `CLAUDE.md`, the product-identity surfaces, or `.claude/agents/*` that the tree contradicts.
- **Scope:** `CLAUDE.md` · `README.md` · `package.json` (`name`/`description`) · `index.html` (meta description) · `Dockerfile` (image description label) · `.claude/agents/{README,canvas-engineer,panel-designer,parser-surgeon,perf-hunter,server-engineer,store-engineer,studio-implementer,studio-verifier,test-engineer}.md`. **No `.ts`/`.tsx` touched.**
- **Done so far:**
  - `CLAUDE.md` entry point: `/admin/site?studio` → `/admin/site`, rendered unconditionally by `src/admin/router.tsx`; project selection via `studioWorkspaceDir.ts`. There is no `?studio` param anywhere in `src`/`server` — only in historical `docs/audits/` and archived `STATE.md` entries.
  - `CLAUDE.md` invariant 1: the "roadmap proposes… until that ships" parenthetical replaced with the shipped Tier 0 `static` / Tier 1 `render-packages` / Tier 2 `run-project` reality (`server/handlers/studio/trustTier.ts`), including that the parse executes nothing at *any* tier and that Tier 2 is not yet distinguished from Tier 1.
  - CMS-half paragraph: Content/Data/Media workspace **routes are deleted** (PR #18). `src/admin/router.tsx` now serves only `/admin/dashboard`, `/admin/site`, `/admin/account`, `/admin/plugins/:pluginId/:pageId`; everything else redirects. `data_tables`/`data_rows` still power loops/data pickers/publish.
  - MCP bullet: `EditorBridgeScope` is **`'site'` only** (`server/ai/mcp/editorBridge.ts:29`) — the "open Site **or Content** workspace" claim was dead. Also now names the `studio_*` tool family and `MCP_ENDPOINT_PATH`.
  - **The design-token section was actively harmful**: it prescribed `--editor-*`, `--rail-tint-mint/lilac/sky/peach`, `--editor-danger/warning/success/info`, `--editor-surface*`, `--editor-radius*` — every one of those families is **banned** by `css-token-vocabulary.test.ts` and none exist in `globals.css`. Rewritten to the live vocabulary (`--bg-surface-2..5`, `--accent-1..10` + `--accent-N-10`, `--danger*`/`--warning*`/`--success*`/`--info-text`, `--radius-sm`/`--radius`/`--card-radius`/`--panel-radius`/`--input-radius`, `--inspector-*`), and the two previously-unmentioned gates `admin-typography-token-policy.test.ts` / `admin-spacing-token-policy.test.ts` added.
  - `!important`: only **one** real use remains in the tree (`globals.css` `prefers-reduced-motion`). `Button.module.css` no longer uses it — the "two exceptions" claim was stale.
  - Hole runtime measured at **1060 B**, not "~668 B".
  - Repo layout: added `studio-workspace/` (user data, never `rm -rf`), `server/handlers/studio/`, `scripts/`; `src/modules/` corrected to `base/` + `studio/` + `alm/`; `src/admin/` "workspaces" → "dashboard launcher". New "Parsing + writeback" stack bullet — `ts-morph`/`postcss` were absent from a stack list for the product whose core they are.
  - Identity: `package.json` `name` `alm-figma-killer` → `studio`, `description` "Self-hosted CMS with an integrated visual editor." → the Studio one-liner; the same sentence fixed on `Dockerfile`'s `org.opencontainers.image.description`; `index.html` gained a `<meta name="description">` (its `<title>` was already `Studio`). README: trust tiers added to rule 1, "content workspaces" removed from the Stack note.
  - Agent files: `iframeCanvasQuery.ts` path fixed — it lives at `src/__tests__/canvas/`, not under `canvas/__tests__/` (canvas-engineer, test-engineer) · `SourceLockedNotice` → `SourceConstraintNotice` (panel-designer) · studio-import.md "578 lines" → ~1,300, in two places (parser-surgeon) · store-engineer + perf-hunter's "full-site scans are a live defect" → **fixed**, with `nodeIndex.ts` and `no-full-site-scan-in-selectors.test.ts` named · perf-hunter's "add a studio board benchmark" → shipped (`bun run bench:studio-board`) · server-engineer gained a table for the whole `server/handlers/studio/` subdirectory (git, deploy, share, comments, prototype, stories, trust tiers) that its flat-siblings table omitted entirely · the "~200 pre-existing failures" figure removed from **six** places (agents README ×2, studio-implementer, studio-verifier, test-engineer ×2) in favour of "read `standing-01`".
- **Next step:** none for this entry. W6-4's `docs/` sweep should carry the `iframeCanvasQuery.ts` correction into `docs/agent-refs/path-index.md` (line ~283), `docs/agent-refs/canvas-internals.md` (line ~684) and `PROJECT-BRIEF.md` trap 10 — all three still name the dead `src/admin/pages/site/canvas/__tests__/iframeCanvasQuery.ts` path.
- **Decisions:**
  - Numbers that drift (failure counts, doc line counts) are replaced with a **pointer to the authority** (`standing-01`, the doc itself) rather than a fresh number — re-pinning a number just schedules the next drift.
  - `server/ai/mcp/server.ts`'s `serverInfo.name` is still the literal `'alm-figma-killer'` (asserted by `e2e.test.ts` and `transports/http.test.ts`). **Deliberately not changed here** — it is a wire identifier external MCP clients may already have configured, and this was a docs pass. If "one product name" is meant to cover it, that is a small code PR: `server.ts:59` plus two test assertions.
  - `Dockerfile`'s `org.opencontainers.image.source`/`url`/`documentation` still point at `github.com/corebunch/studio` (the upstream fork) while `package.json` `repository` points at `MaherFayad/Figma-Killer-2`. Left alone — resolving that is an attribution call, not a docs-accuracy one.
- **Landmines:**
  - **A rule book can be worse than no rule book.** `CLAUDE.md`'s token section was instructing every agent to write `--editor-*` names that a gate test bans. `CLAUDE.md` is *not* in `css-token-vocabulary.test.ts`'s `DOC_FILES` list, so it will never fail — if you change a token family, grep `CLAUDE.md` by hand.
  - `bun run build` fails in a fresh worktree until you `bun install` (no `node_modules/vite`). Not a code error.
  - Verifying "does token `X` exist" by grep alone lies: `--rail-tint-*` appears in the tree exactly once — inside the regex that **bans** it.
- **Verification:** `bun install`; `bun run build` ✅ (tsc -b + vite, exit 0); `bun test` → **11366 pass / 27 fail**, all 27 pre-existing and in the known clusters (`icon-catalog-integrity` `chevron-left`; the canvas batch-isolation set — NodeRenderer/VC, breakpoint activation, selection leak, inline text, pin⇄unroll, body context menu, AdminCanvasLayout; the browser-dependent `captureFramesHeadless` + `studio_compare` set). `bun test src/__tests__/architecture` → 509 pass / 1 fail (that same icon gate). `bun test server/ai/mcp/{e2e,transports/http}.test.ts` → 5 pass, confirming the `package.json` rename did not touch the MCP server name. `bun run lint` **not run** — no `.ts`/`.tsx` in the diff.
- **Human action needed:** none. No UI changed.

### docs-02 — STATE.md archived per the handoff protocol (W6-2)

- **Agent:** studio-scribe
- **Stage:** done
- **Updated:** 2026-09-06
- **Branch:** `docs/state-archival` off `origin/main` (W6-2, `STUDIO-WAVE4-PLAN.md`).
- **Goal:** `STATE.md` was 15,548 lines and ~140 landed entries — read in full by
  every agent that starts work, and past any useful reading budget. Get it back
  to the protocol's shape without losing a single line of the historical record.
- **Scope:** `STATE.md` · NEW `docs/state-archive/2026-Q3.md` ·
  `docs/agent-refs/handoff-protocol.md` · `docs/README.md` (one index row).
  No source files touched.
- **Done so far:**
  - **154 entries moved verbatim** to `docs/state-archive/2026-Q3.md`, in four
    parts: the two landed-entry blocks (the untitled block that had been growing
    above `## Now`, and `## Recently landed`), the entries that were already
    under `## Archive`, and the four July/August wave narratives
    (`Where this stands` / `Where this stood` / `STOP — read this before
    resuming` / the closed standing-authorization queue).
  - `STATE.md` is **~1,980 lines** (was 15,548): `Now` (9 entries, untouched), `Blocked`,
    a new `Pending dogfood`, `Recently landed` (the newest 10), `Standing notes`
    (all 9, untouched), the live half of `Standing authorization`, and an
    `Archive` section that is now a link plus a one-line-per-entry index.
  - **Nothing was summarised or dropped.** Verified mechanically: every heading
    and every non-blank body line of the pre-change `STATE.md` is present in
    either the new `STATE.md` or the archive. The single exception is the
    `*(empty)*` placeholder that used to sit under `## Archive`.
  - `## Pending dogfood` hoists every un-run dogfood script out of the entries
    that were archived (`mcp-19`, `mcp-18`, `canvas-15`, `panel-10` ×2,
    `style-03`, `canvas-14`, `style-02`, `mcp-17` ×3, `perf-03` ×2, `server-12`,
    `server-17`, `panel-05`, `panel-04`) **verbatim**, and points at the ten
    entries that still carry their own script in place.
  - `handoff-protocol.md` gained the `## Archiving` section that names this
    convention, and `Pending dogfood` is now in its layout block.
- **Next step:** none. The next agent to push "Recently landed" past ~10 follows
  `handoff-protocol.md` → "Archiving" and appends to the same quarter file.
- **Decisions:**
  - **The archive is a file, not a section.** The protocol named a `## Archive`
    section, which is where the entries were — and keeping ~14,000 lines of it
    inside the file every agent reads first defeats the section's purpose. The
    section stays as the index and the pointer, so no entry becomes unfindable
    from `STATE.md`; the protocol now says so explicitly rather than leaving the
    next agent to re-derive it.
  - **The four wave narratives were archived, not deleted.** Every work order
    they track has landed. The two paragraphs of `Standing authorization` that
    are still live (the authorization itself, and the acceptance bar) stayed.
  - **`Pending dogfood` is a section, not a note in each entry.** The user's
    batched dogfood session needs one list, and an archived entry's script is
    invisible to it. It sits directly under `Blocked` because it is the same
    kind of thing: work that only a human can close.
- **Landmines:**
  - **Entries had been accumulating ABOVE `## Now`**, outside every section, for
    the whole W4/W5 wave — 71 of them. If you append there out of habit, the next
    archival pass has to guess at your section again. Append under
    `## Recently landed`.
  - Two one-line `### panel-10 …` headings with no body (duplicated titles) were
    in that block; they were archived as-is rather than tidied away, per rule 3.
- **Verification:** `bun test src/__tests__/architecture` — 511 pass / 2 fail,
  both pre-existing on `origin/main` (`icon-catalog-integrity`,
  `module-size-budgets`). No gate test reads `STATE.md` or the docs index.
  Content preservation verified by the line-set diff described above.
- **Human action needed:** none for this entry. The `Pending dogfood` section
  above is the standing ask.

---

### style-04 — an Animations section: timing, keyframes, and a scrub

- **Agent:** studio-implementer
- **Stage:** done (needs human dogfood)
- **Updated:** 2026-09-06
- **Branch:** `feat/animation-editing` off `main` (W5-5, `STUDIO-WAVE4-PLAN.md`).
- **Goal:** build the SURFACE for animation editing. The write path already
  existed — `insertRule` for a new rule, `setDeclaration`/`removeDeclaration`
  for timing properties, `CanvasAnimationInjector` for the freeze — and none of
  it was reachable. An imported app full of motion read as a still with no
  explanation and no control.

**The parser delivers TWO shapes, and both had to be modelled.** happy-dom's
CSSOM neither expands `animation:` into longhands nor collapses longhands into a
shorthand — whichever the author wrote is what lands in `StyleRule.styles`
(verified against the real parser, not assumed). So `animationValue.ts` resolves
either, and an edit writes back into **the shape it found**: a project that wrote
`animation: fade 300ms` gets that line rewritten, never a competing
`animation-duration` longhand appended below it whose cascade position the user
never asked about. A rule that sets BOTH is `mixed` and refused — the shorthand
resets every longhand before it and is reset by any after it, so which wins is a
source-order question this module deliberately does not model. Parsing is strict
and refusal is whole-value: one unclaimable token and the entire declaration
becomes a raw text row with the reason, never a partial read that silently drops
what it did not understand (`boxShadowLayers.ts`'s posture, verbatim).

**The eight `animation-*` longhands are now real `CSSPropertyBag` members.** They
already round-tripped through storage on the permissive `isEmittableProperty`
gate while being invisible to `keyof CSSPropertyBag` — to the style search, to a
section's "N set" count, to every typed read. The `transition-*` longhands were
deliberately NOT added: nothing edits them, and a key the panel cannot control
would put an empty row in the search results.

**`transition`/`animation` MOVED out of Effects** (registry + that section's ⚙
popover). A property may be claimed by exactly one section — `properties` drives
the "N set" count and the search — so leaving them would have counted and shown
them twice. Effects keeps `transform`/`transformOrigin`.

**`@keyframes` needed a third codemod scope.** `setDeclaration` addresses the
top level and `setDeclarationAtMedia` one level down inside `@media`; neither can
reach a keyframe step, whose container is matched by NAME and whose "selector" is
an offset. `src/core/css-codemods/keyframes.ts` is that scope, built to
`setDeclarationAtMedia`'s shape: `setDeclarationAtKeyframe`,
`removeDeclarationAtKeyframe`, `insertKeyframes`, plus the READ side
(`readKeyframeSteps`) the inspector needs because a block reaches the editor as
one opaque `rawCss` string. **`insertRule` could not have done the create** —
its docblock offers "a new `@keyframes` step" as a use case, but
`buildRuleWithDeclarations` throws unless the parsed fragment is a `rule` node,
and `@keyframes x { … }` parses to an `atrule`, so that branch was never
reachable. `insertKeyframes` is it, with the same insert-vs-merge discipline.

**The keyframes save diff is per-declaration, and that is load-bearing.**
`keyframesWriteback.ts` parses both sides of `rawCss` and compares declaration by
declaration. Sending the block text would be a rewrite: every comment, blank line,
and unparsed step gone on the first duration change. Adding or removing a whole
STEP needs no op of its own — a step that appears contributes `keyframe-set`
edits (the codemod creates the step), one that disappears contributes
`keyframe-unset` edits (the codemod drops a step it empties). Two ops, four
behaviours.

**The honest-target gate is stricter here than for a class.** A second
`@keyframes` of the same name does not merge with the first the way two rules
with the same selector do — it REPLACES it entirely — so
`analyzeKeyframesTarget` refuses `duplicate-keyframes` (a `-webkit-` twin counts)
before any writer runs.

**`freezePoint` is an axis now, not two keywords.** `'start'` and `'end'` are its
endpoints; a 0…1 number holds every animation at that fraction. The mechanism is
a negative `animation-delay` on a paused animation — and, because a negative
delay is measured against a DURATION that differs per animation and that no `*`
selector can read, the rule also forces `animation-duration: 1s`. That is
invisible (a paused animation does not advance) and it is the ONLY reason one
delay means the same fraction for a 200 ms fade and a 4 s orbit. Drop it and the
slider silently starts lying; `canvasAnimationScrub.test.tsx` pins both halves.

**The scrub state is a module store, not editor state and not a prop.** It is
ephemeral (in `site` it would be undoable, savable, and part of a diff reaching
the user's repo) and cross-cutting (the control is in the inspector, the
consumers are one injector per board frame). `animationScrubStore.ts` is
`studioRawCssStores.ts`'s pattern for `studioRawCssStores.ts`'s reasons. The
play-once phase machine lives there too: restarting a CSS animation from JS means
taking `animation` away and giving it back, and that two-phase sequence has to be
the same phase in every frame at once or a board replays raggedly. **No file
outside `CanvasAnimationInjector.tsx` was touched on the canvas side** —
`IframeFrameSurface` needed no edit.

**Refused in UI copy, on purpose:** JS animation (framer-motion/GSAP — the W8.1
freeze gap, a different fix in a different layer, not something to fake with a row
that pretends to control it); a transition's PROPERTY LIST (timing is editable,
deciding what transitions is a statement about the element's other declarations
and has no surface yet); scroll-driven animation. A compiled/unmapped animation
is not refused at all — it is the graying `StyleWriteLockContext` already applies,
from the one verdict `classCssWritability.ts` computes, and the keyframe editor
asks the same question of the `@keyframes` rule and shows the same standard
notice while still SHOWING the steps read-only (knowing what `shimmer` does is
most of why anyone opens it).

**One honest gap, documented in `studio-import.md` and in the refusal itself:** a
brand-new animation in a project with no editable stylesheet anywhere is
reported, not written. The class path answers that with `op: 'create'`, whose
machinery (`ensureStylesheetImport`'s "reachability by construction") exists to
make a CLASS reachable from JSX and means nothing for an at-rule. The first class
created in such a project creates the stylesheet and the animation is writable
from then on.

**Two cycles avoided deliberately, both would have failed
`no-circular-dependencies`:** `UnmappedStyleRule` moved to
`cssInsertDestination.ts` (beside the destination resolution that produces most
of its reasons) so `keyframesWriteback.ts` need not import its sibling; and the
`@keyframes fade` prelude parse became `keyframesNameFromSelector` in
`@core/css-codemods`, beside the matcher it has to agree with, so both the panel
and the save path read it from one place rather than each owning a copy of the
vendor-prefix spelling.

**Verified.** `bun run build` and `bun run lint` clean. New suites green:
`css-codemods/__tests__/keyframes.test.ts` (23), `animationValue.test.ts` (25),
`keyframesWriteback.test.ts` (9), `canvasAnimationScrub.test.tsx` (18).
`src/__tests__/architecture` 510/510, `src/__tests__/studio` 166/166, every
`PropertiesPanel/__tests__` file green run individually.

**Pre-existing failures, confirmed not this branch's:** the `streamClaudeCli`
cluster (54 in `server/`), `icon-catalog-integrity`, and the iframe-timeout
canvas batch flakes (11 in `src/__tests__/canvas`, none animation-related). One
worth naming because it will bite the next agent:
**`src/__tests__/studio/resolvedTextEditing.test.ts` contaminates the editor
store for any `PropertiesPanel` test file that runs after it in the same
`bun test` invocation** (every such file passes alone; run together they fail on
`state.site?.settings.fonts` with `state` undefined). Narrowed to that one file;
untouched by this branch.

**Needs human dogfood.** Nothing here has been driven in a browser. Three things
to look at first: (1) an edited imported `@keyframes` renders from
`ClassStyleInjector`'s overlay while `AuthoredCssInjector` still holds the raw
on-disk snapshot of the same block — for `@keyframes` the LAST definition wins
entirely, so confirm DOM order actually lands the overlay second (the mechanism
is the existing `styleRuleNeedsCanvasOverlay` + `updatedAt > 0` path an edited
imported class rule already takes, but a class merges declaration-by-declaration
and a keyframes block does not); (2) the scrub against a real animated frame, and
whether 1% steps feel right; (3) creating an animation end to end in a project
with exactly one stylesheet, and again in one with several.

---

### server-18 — share links: a board is now showable to someone who is not an editor (W5-2)
- **Agent:** server-engineer
- **Stage:** done (built + gated). **Needs human dogfood** — a created link must be opened in a private window, on a browser that is not signed in. Nothing here was driven in a real browser.
- **Updated:** 2026-09-06
- **Branch:** `feat/share-links`
- **Goal:** Studio's only way to show work to a non-editor was "Download code" (a zip of a React project). v1 share = a revocable `/share/<token>` URL that renders a read-only snapshot of a board — layout, frame images, page names — to a logged-out viewer.
- **Scope (all new except the four wiring edits at the end):**
  - `src/core/studio-share/{shareWire.ts,index.ts}` — the shared leaf. `SharedBoardSchema` (what a stranger may see), the management schemas, `SHARE_TOKEN_RE` / `SHARE_IMAGE_FILE_RE`, route constants.
  - `server/handlers/studio/shareStore.ts` — `.studio/shares.json`: minting, constant-time matching, revoke, the token→project scan + memo, `resolveShareFile`'s containment guard.
  - `server/handlers/studio/shareSnapshot.ts` — drives `captureFrames` (W4-2A) and writes `.studio/shares/<token>/{board.json,<id>-<n>.png}`.
  - `server/handlers/studio/sharePublic.ts` — `tryServeSharePublic`: the three public GETs.
  - `server/handlers/studio/shareRoutes.ts` — `GET/POST/DELETE /admin/api/studio/shares`, session-gated.
  - `share.html` + `src/admin/shareViewer/{main.tsx,ShareViewer.tsx,ShareViewer.module.css,ShareUnavailable.tsx}` — Vite's THIRD HTML entry.
  - `src/admin/pages/site/studio/shareLinks.ts`, `toolbar/ShareBoardButton.tsx`, `toolbar/ShareDialog.tsx(+.module.css)`.
  - Tests: `shareStore.test.ts` (13), `sharePublic.test.ts` (9), `shareSnapshot.test.ts` (8), `shareRoutes.test.ts` (2).
  - Wiring edits into files I do not own: `server/router.ts` (one route entry + handler), `server/handlers/studio.ts` (one call beside the comments call), `toolbar/StudioToolbarActions.tsx` (one component), `vite.config.ts` (third `input` + one proxy key).
  - Docs: new `docs/features/studio-share.md`, `docs/README.md` row, `docs/agent-refs/path-index.md` (6 rows).
- **Done so far:** create / list / update-in-place / revoke, the public viewer with pan+zoom, and the whole 404 surface. `bun run build` ✅, `bun run lint` ✅, `bun test src/__tests__/architecture` ✅ (1 pre-existing icon-catalog fail), my four suites 32/32 ✅. The built viewer chunk is **7.8 KB** — it ships no editor code, which was the point of the separate entry.
- **Next step:** dogfood. Create a share on `studio-workspace/test4`, copy the link, open it in a private window; then revoke and reload. The one thing no test covers is whether the headless capture actually produces frames on this machine (it needs `bunx playwright install chromium`) — with no Chromium AND no open editor tab, `createShare` fails honestly with capture's own two-part message rather than writing an empty share.
- **Decisions:**
  - **v1 is a snapshot, and the UI says so.** A live share would put the parser (and a browser) on an anonymous request path and would change under a reviewer mid-review. Every row shows "shared \<time\>" and the action is called **Update**, which re-captures IN PLACE — same link, new pictures — because "share again to update" reads as a promise that the URL is stable.
  - **`createdAt` and `snapshotAt` are separate fields.** An update must not make "this link has existed since Tuesday" false.
  - **Capture is `captureFrames`, unforked.** Headless-first with the owner's open tab as fallback. A second rasteriser would be a second thing to keep in step with the canvas; the first time they disagreed a share would stop looking like the board.
  - **Mounted on `/share/`, not under `/admin`.** A viewer must never be sent to an admin URL, and the admin session cookie is `Path=/admin` precisely so it never rides a public request. Placed before the static-asset and published-page resolvers, and it absorbs its namespace.
  - **Revoked records are KEPT, their bytes DELETED.** For the viewer, revoked and never-existed must be indistinguishable; for the owner, a link somebody may still hold must not silently vanish from the dialog.
  - **Every failure is one identical 404** (malformed / unknown / revoked / project deleted / file missing / wrong method). Distinguishing them tells a stranger whether a token was ever real.
  - **The public routes hold no `dir`.** A token resolves to its project by scanning `studio-workspace/`; the mapping is memoised (immutable for a token's life) but the RECORD is re-read per request, which is what makes revocation immediate.
  - **Frame images are `immutable`-cacheable because filenames are per-snapshot** (`<snapshotId>-<index>.png`). An update mints a new id, so the same URL can never mean two different pictures. `board.json` is `no-store` — it is the revocation check.
  - **Comments on a share are v1.5, deliberately unbuilt.** A comment carries a byline and an anonymous viewer has no honest one; that is a design question (invite links? a name box?), not wiring. The seam is that a share already resolves to `(dir, record)` — everything a comment write needs except an author.
- **Landmines:**
  - **The Vite dev proxy key is the regex `'^/share/'`, not the string `'/share'`.** A prefix string would also swallow `/share.html`, which is Vite's own entry for the viewer and must be served BY Vite in dev. If share links 404 in dev after a config edit, check this first.
  - **In dev the Bun handler 302s `/share/<token>` → `http://localhost:5173/share.html?token=…`**, because Vite's SPA fallback would otherwise answer the path with the ADMIN entry. So the viewer reads its token from EITHER the path or the query. Same two-mode dance as `captureRoute.ts`.
  - **`new Response(Bun.file(path))` does not survive the test preload.** The suite runs under happy-dom, where a `BunFile` body serialises to `[object …]`. Both file routes read `await Bun.file(p).arrayBuffer()` instead — frames are bounded PNGs, so this costs nothing and keeps the handler testable as a plain function (PR #28's handoff: you cannot start `Bun.serve` in this suite).
  - **`resolveActiveShare` scans `studio-workspace/` on a token it has never seen**, which is what a probe looks like. It deliberately does NOT use `listStudioProjects` (that walks each project's pages dir to count them) — one `readdir` plus one small file read per project. Keep it that way.
  - **Token comparison hashes both sides before `timingSafeEqual`.** That function throws on unequal lengths, which would itself be a length oracle; SHA-256 digests are always 32 bytes. The scan also does not exit early on a match.
  - **`shareSnapshot.test.ts` nearly shipped a flake:** it greps the written manifest for strings that must not leak, and `'f1'` (a fixture frame id) matched the random hex snapshot id about one run in eight. Fixture ids are now `frameIdMustNotLeak`-style. If you add a forbidden substring, make it long enough not to occur by chance.
  - **`writeShareSnapshot` takes a second `overrides` argument that the route never passes** — a test seam for the capture and the page titles, mirroring `HeadlessCaptureOverrides`. It exists because the property worth asserting (that the manifest carries no page ids or source paths) is independent of who produced the pixels.
- **Verification:** `bun run build` ✅ · `bun run lint` ✅ · `bun test src/__tests__/architecture/` ✅ (1 pre-existing: `icon-catalog-integrity` chevron-left) · my four suites ✅. Full `bun test`: the known pre-existing clusters only — the `streamClaudeCli` suite, `icon-catalog-integrity`, the canvas in-batch flakes, and `server/ai/mcp/capture/` (which fails as a BATCH and passes per-file on `main` — inherited from PR #28, not touched here).
- **Human action needed:** create a share, open the link in a private window, revoke it, reload. Confirm the frames are the board you shared and that the revoked link 404s.

---

### mcp-17 — the warm CLI session: a conversation now keeps ONE `claude` process, and the stdin shape WS-11 deferred is verified (W4-2B)
- **Agent:** mcp-tooling
- **Stage:** done (built + gated + measured on a real binary). **Needs human dogfood** — no browser drove this; every test uses a fake process.
- **Updated:** 2026-09-06
- **Branch:** `feat/warm-cli-session`
- **Goal:** stop paying a process start + an `initialize` handshake with every attached MCP server on every single turn.
- **The spike came first, and it PASSED.** Hand-drove `claude 2.1.263` outside the repo with `--input-format stream-json --output-format stream-json --verbose`. Everything below is measured, not inferred; the evidence lives in `server/ai/drivers/claudeCliStdinProtocol.ts`'s module doc, which replaces WS-11's "was never verified" deferral note.
  - **Envelope:** `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"parent_tool_use_id":null}`, one `\n`-terminated line. A sent `session_id` is ignored; unknown extra top-level fields are accepted and dropped.
  - **Turn boundary = the single `result` line.** The process then takes the next turn on the same stdin with full context in memory (verified: "remember 8241" → turn 2 answered "8241").
  - **MCP servers initialize ONCE.** A probe MCP server logged exactly one spawn, one `initialize`, one `tools/list` across three turns. This is the whole prize.
  - **Malformed stdin is FATAL** — one non-JSON line kills the process (`SyntaxError`, exit 1) mid-conversation. An unrecognised *control request* is safe (error response, process lives).
  - **`interrupt` cancels the TURN, not the session** — answered in ~1 ms, closed the turn with a normal `result` (`subtype: error_during_execution`), and the next message was answered normally.
  - **There is no `set_effort`** (probed: "Unsupported control request subtype"). `set_model`, `set_permission_mode`, `set_cwd`, `set_max_thinking_tokens` DO exist and work.
- **Measured** (real spawns, 3 stdio MCP servers, turn 2 of a conversation, to first stream-json line): **cold 840 ms / 856 ms → warm 4 ms / 4 ms**, two samples.
- **Scope:**
  - New: `claudeCliStdinProtocol.ts` (the verified wire format + the newline guard), `claudeCliWarmSession.ts` (one live process: turns, abort, death detection), `claudeCliSessionPool.ts` (the registry: reuse key, idle/lifetime/pool caps), `claudeCliWarmTurn.ts` (serving one turn: connector, registries, board-state carry), `claudeCliArgv.ts` (argv + `buildMcpConfig` + suffix extraction, lifted out of the driver).
  - Renamed `claudeCliTurnConnector.ts` → `claudeCliConnector.ts`; it now serves BOTH lifetimes and exposes `bindConnectorRegistries` + `mintConnectorOrNull`.
  - `claudeCliEvents.ts` gained `translateClaudeCliStream` + `claudeCliExitErrorMessage` (both paths share one translator). `claudeCliMcpConfigFile.ts` gained `tryWriteMcpConfigFile`. `claudeCliAttachments.ts` gained the conversation-stable staging root.
  - `subprocessRunner.ts`: `stdin` widened to `'ignore' | 'pipe' | Uint8Array`, `SpawnedProcessLike.stdin?` added — ONE spawn seam for both paths.
  - `server/ai/handlers/conversations.ts`: delete + restart-session now call `endClaudeCliConversation`.
  - Tests: 3 new files (protocol/session/pool, 34 tests) + a new `describe('streamClaudeCli — the warm session (W4-2B)')` block; `claudeCli.test.ts`'s fake spawn now answers BOTH protocols.
  - Docs: `docs/features/mcp-connectors.md` (new "warm CLI session" section + the connector's two lifetimes).
- **Verification:** `bun run build` ✅, `bun run lint` ✅, `bun test server/ai/drivers/` → **264 pass, 0 fail**. Full `bun test`: 26 failures on this branch vs **32 on `origin/main`** — `comm` diff of the two sorted failure lists shows **zero regressions**; the 6 that stopped failing are listed under Decisions.
- **Next step:** dogfood in a browser. Open the AgentPanel, send two turns, and confirm (a) the second starts streaming with no `initialize` lines in the server log, (b) Stop cancels a turn and the NEXT turn still works, (c) "Restart agent session" visibly kills the process. Nothing here has been driven by a real user.
- **Decisions:**
  - **The cold path stays, and it is not a shim — it is the crash recovery.** A dead/unusable warm process throws `ClaudeCliWarmSessionDeadError` *before yielding anything*, and the turn silently re-runs cold. Once a turn HAS streamed text, a death degrades to the same terminal error the cold path always produced; a silent retry there would duplicate the reply.
  - **The connector token became CONVERSATION-scoped.** The CLI authenticates its MCP clients once, at startup, so revoking after turn 1 leaves a warm session silently toolless for turn 2. Revoked on: idle timeout (10 min), max lifetime (60 min), fingerprint change, pool eviction, crash, conversation delete, session restart. The 1-day TTL floor is still the backstop. Its MCP config FILE follows the same lifetime, for the same reason.
  - **The two registries (permission gate, workspace binding) are re-bound EVERY turn anyway** — `bridge` is a different object after a browser reload, and `workspaceDir` changes when the user opens another project. Binding once at spawn would relay Allow/Deny down a dead socket and point writes at the previous project.
  - **`effort` is in the respawn key, and it costs us.** `--effort` is argv-only (no `set_effort`), and `turnRouting.ts` routes a plain question to `low` and everything else to `medium` — so a conversation alternating question/build respawns on each switch and gets no discount on those turns. Never *slower* than today (a respawn is the status quo), but the win is real only for runs of same-shaped turns. `set_model`/`set_permission_mode` exist and could avoid two other respawns; kept in the key deliberately, because both change what the agent may DO and both change rarely.
  - **`--add-dir` now grants the conversation's staging ROOT, unconditionally**, not the per-turn directory only when a turn staged something. `--add-dir` is argv, so a process can only read directories that existed at spawn; the first attachment sent to an already-running session would otherwise hit the exact "you haven't granted it yet" dead end that pre-authorisation exists to prevent. Not a real widening: the directory holds only this conversation's own attachments, and `--tools` (whether `Read` is granted at all) is still the ceiling.
  - **The dynamic system-prompt suffix rides the USER MESSAGE on a warm turn, and only when it changed.** It cannot ride `--append-system-prompt` past the spawn. Sending it every turn would stack a copy of the board digest into permanent history.
  - **I lifted the macOS platform gate out of `claudeCli.test.ts`'s `testOptions`** (injects `platformSupport: { supported: true }`). On a macOS host the driver refuses before any of its own code runs, so **53 of that file's tests were asserting against that one refusal event** — they measured the laptop, not the driver, and my entire warm path would have been invisible to them. The refusal itself still has its own test that injects an UNSUPPORTED result on purpose. This is what turned the "streamClaudeCli cluster" from 53 red into real coverage.
  - **The 4 remaining stale expectations I then fixed** were all one root cause: the `routing` event that `turnRouting.ts` added this week, which those tests never accounted for. Fixed in place (they are in a file I own and directly adjacent to this change's subject), not grandfathered.
- **Landmines:**
  - **Attachment cleanup lived ONLY in the cold path's `finally`.** The warm path returns early on success, so every warm turn leaked its staged files until I wrapped both paths in one `finally`. Any future early-return in `streamClaudeCli` must stay inside that wrapper — this is exactly the bug shape that will come back.
  - **`sessionFlag` (`--session-id` vs `--resume`) must NEVER enter the pool's reuse fingerprint.** It flips from establish to resume the moment the first turn writes a transcript, so including it would respawn on every second turn — silently converting the whole feature into a no-op that still looks like it works.
  - **`CLAUDE.md` is read once, at startup.** A warm session serves the guide it was born with. Handled by respawning when `generateStudioProjectGuide().written` is non-empty (it is manifest-gated, so that list is empty on the common turn) — but anything else the CLI reads only at startup has the same staleness problem and is bounded only by the 60-minute max lifetime.
  - **A test that leaves a warm session in the pool poisons the next test** that reuses a conversation id — it will be served by the previous test's fake process. `claudeCli.test.ts` and `claudeCliSessionPool.test.ts` both `disposeAllWarmSessions()` in `afterEach`; a new test file that drives `streamClaudeCli` must too.
  - **The pool is process-local, in-memory, and capped at 8 live sessions across ALL users.** A multi-worker deployment gets one pool per worker, and a 9th concurrent conversation evicts the least-recently-used idle session rather than queuing. Never evicts a mid-turn session — running over the cap briefly beats truncating someone's reply.
  - The `spawn` seam is now ONE function for both paths (`subprocessRunner.ts`'s `stdin` widened to accept `'pipe'`). A fake that models only a one-shot process (no writable `stdin`) makes `ClaudeCliWarmSession.start` throw, which correctly falls back to cold — convenient, but it means a fake missing `stdin` silently tests the cold path only.

---

### struct-06 — duplicate, wrap and same-file reparent write real code (W4-1)
- **Agent:** parser-surgeon
- **Stage:** done (built + gated). **Needs human dogfood** — nothing here was driven in a browser.
- **Updated:** 2026-09-06
- **Branch:** `feat/reparent-duplicate-wrap`
- **Goal:** the last three Figma verbs that refused now land on disk, and the shapes that still refuse say something true.
- **Scope:**
  - New codemods: `src/core/ast-codemods/duplicateJsxElement.ts`, `wrapJsxElement.ts`.
  - Extracted from `insertJsxElement.ts` (both were its private helpers, now shared): `jsxChildPlacement.ts` (WHERE a child goes + the indentation helpers + `reindentBlock`), `jsxImportEdits.ts` (`resolveImportEdits`, `conflictingBinding`).
  - `moveJsxElement.ts` — gained a destination-parent (reparent) form; `anchorLine/anchorCol/position` are now optional and a reorder without an anchor refuses `no-anchor`.
  - `subtreeFreeVariables.ts` — `freeVariablesOutOfScopeAt()`, the reparent honesty check.
  - `locateJsxElement.ts` — `findJsxElementAtLocation` is bounds-checked (see Landmines).
  - `src/core/page-tree/sourceStructure.ts` — three blanket refusals lifted; `refuseStructuralEdit` takes `destination`; `StructuralMoveCommit` gained `destinationParentNodeId` and a nullable `anchorNodeId`; `resolveSourceContainer` + `resolveContainerAnchor` lifted out of the store; new `refuseMintedNodeCopy`.
  - `src/core/page-tree/editConstraint.ts` — `explainInstanceDuplicateConstraint` DELETED (see Decisions); `cross-file` gained a jump-to-source action.
  - `src/core/page-tree/treeOperations.ts` — duplicate/wrap/cross-parent-move now gate on `refuseMintedNodeCopy`.
  - Server: `server/handlers/studioStructuralWriteback.ts` (three new schemas + dispatch, `applyStructuralEdit` takes a `destination`), `studioWriteback.ts` (decodes `parentNodeId` through the same path guard; `duplicate`/`wrap` exempt from dedupe).
  - Store: `structuralSourceEdits.ts` (`planSourceCopy` → `planSourceDuplicate`/`planSourceWrap`; `planSourceMove` is now a wrapper over `previewStructuralMove`), new `studioSourceWrites.ts`, `nodeActions.ts`, new `src/admin/pages/site/studio/studioStructuralCommits.ts` (split out of `studioSaveRequests.ts` — the six structural commits, rebased on top of `perf-04`'s `resyncBoardAfterWrite`), `deleteNodesAction.ts`, `LayerNodeContextMenu.tsx`.
  - Tests: new `src/core/ast-codemods/__tests__/copyJsxCodemods.test.ts` (23), new block in `server/handlers/__tests__/studioWriteback.test.ts` against a snapshot of a REAL imported page, rewritten gates in `sourceStructure.test.ts` / `editConstraint.test.ts` / `dom-panel/layerNodeContextMenu.test.tsx`.
  - Docs: `docs/features/studio-import.md`, `docs/agent-refs/studio-pipeline.md`, `docs/agent-refs/path-index.md`, `PROJECT-BRIEF.md`, `STUDIO-WAVE4-PLAN.md` §W4-1.
- **Done so far:**
  - Duplicate = the element's own bytes re-inserted at `range.end` (a whole-line range already carries its indentation and trailing newline, so the copy is byte-identical; an inline element joins the row with one space). No imports, no scope analysis — same file, same scope, one line down.
  - Wrap = replace the element's own range with `<div>…it…</div>`, re-hanging the subtree one indent level (`reindentBlock`, leading whitespace only). Writes the wrapper's `import` when it is a component.
  - Reparent = `resolveChildPlacement` (the SAME function an insert uses) for the destination edit + a removal edit, both measured against the original text and applied last-first.
  - `bun test src/core src/__tests__/architecture src/__tests__/studio src/__tests__/dom-panel src/admin server/handlers/__tests__` → 3127 pass, 1 fail (pre-existing icon-catalog).
- **Next step:** dogfood on a real imported board: duplicate a card, wrap it, drag it into another container, then check `git diff` in the workspace repo. The one thing no test covers is what the canvas does between the optimistic gesture and the narrow reload.
- **Decisions:**
  - **The three verbs write; the plugin/agent dispatcher still refuses.** `applyTreeOperation` persists a TREE (into a `data_row`), never a `.tsx`, so duplicating a source-derived node there would mint a nanoid child no file describes — the silent no-op `struct-01` exists to prevent. That is `refuseMintedNodeCopy`, the sibling of `refuseMintedNodeInsert`. A reorder through that path mints nothing and stays allowed.
  - **Multi-select: duplicate yes, wrap no.** A batch is ordered bottom-to-top, so N copies cannot move each other's lines. One wrapper around N elements is one write spanning N ranges — refused `multi-select` with its own sentence, not silently wrapping the first.
  - **`explainInstanceDuplicateConstraint` deleted, not reworded.** It existed to offer "duplicate the COMPONENT as a new file" because duplicating a call site refused. Duplicating `<SheetShell/>` is now an ordinary write, so the sentence had become false — and a refusal that is no longer true is worse than no refusal.
  - **`planSourceMove` collapsed into `previewStructuralMove`.** The two were line-for-line copies with a comment in each promising hand-sync. Lifting the reparent refusal in one and not the other would have made the drop line go green on a gesture the store refused.
  - **The reparent anchor is dropped when the container had to be re-resolved** (the synthetic page root → the page's root element): `newIndex` counts a different child list, and appending is an honest position while writing at an index derived from the wrong list is not.
- **Landmines:**
  - **`findJsxElementAtLocation` used to THROW** on a `line:col` past the end of the file — `ts.getPositionOfLineAndCharacter` asserts rather than returning. A stale node id (the file shrank since the board read it) therefore reached the user as an *unexplained skip* instead of "no element is written there any more". Now bounds-checked, so every codemod gets the honest `not-found` refusal. This affected the SHIPPED move/delete/insert paths too, not just the new ones.
  - **`wrapJsxElement` is the one structural codemod that rewrites bytes it did not otherwise touch** — the wrapped subtree's leading whitespace. Deliberate (the new nesting IS the change), and only leading whitespace: a line that does not start with the base indent is left exactly as it is rather than guessed at, so a template literal's continuation lines are never touched.
  - **A reparent out of an inline run leaves a whitespace hole** (`<div><a/> <b/></div>` → `<div> <b/></div>`), and JSX renders that leading space. `deleteJsxElement` has had the identical behaviour since `struct-01`; not fixed here, but it is a real rendering difference, not a cosmetic one.
  - **`refusePlacement` assumes a source-derived id.** Ask it about the synthetic page root and it answers `list-row`, which is nonsense — that is why the reparent path runs `resolveSourceContainer` first. Any new caller must do the same.
  - `studio-workspace/esim-journey` (named in the work order) **does not exist in this checkout**; the real-corpus test uses a byte-for-byte snapshot of `studio-workspace/test4/pages/Onboarding.tsx` inlined in the test, and never writes to the workspace.
  - **`studio-scribe`:** the 578-line `docs/features/studio-import.md` now carries the lifted refusals, but the two landmines above (the throwing locator, the inline whitespace hole) are worth a permanent home there.
- **Verification:** `bun run build` ✅ · `bun run lint` ✅ · `bun test` on every touched area ✅ (one pre-existing icon-catalog failure, plus the known canvas-iframe/step-up/cmsPlugins flakes in a full run).
- **Human action needed:** dogfood the three gestures on an imported board; confirm the narrow reload brings the new element back selected-or-not as expected.

---

### style-05 — a styled-component's declarations write back; its class refuses (W4-4 Phase B)

- **Agent:** studio-implementer (W4-4 Phase B, stacked on `parser-11`/PR #27)
- **Stage:** built and gated. `bun run build`, `bun run lint` clean; suites below green. **Needs human dogfood** — measured on two OSS corpora, not driven in a browser.
- **Updated:** 2026-09-06
- **Branch:** `feat/css-in-js-writeback` off `main`.

**What was wrong.** Phase A put a `styled.div` on the canvas and made every edit
to it a lie or a dead end. Two distinct failures:

1. **A class add/remove was a silent no-op** — Phase A's own landmine 1, routed
   here. The synthetic class (`Card_sc__a1b2c3`) lives in `node.classIds` and
   the DOM, and in NO `className` attribute: styled-components generates its
   name at runtime. Removing it emitted a `kind: 'class'` edit whose token
   `setJsxClassName` could not find — `{ ok: true }`, file untouched, canvas
   showing it gone. Adding it wrote Studio's own hash into the user's JSX,
   which is `style-02`'s CSS-Modules bug through a different door.
2. **Every declaration edit was refused as unmapped**, because a styled rule
   arrives through `extraCss` and gets no `StyleRuleSource`. Correct for Phase
   A, wrong permanently: the declarations ARE hand-written, in a `.tsx` three
   lines from where the user is looking.

**The design decision that everything else follows from: ONE walk.**
`cssInJsTemplate.ts` now has two readers — `flattenTemplateCss` (Phase A's
rendering) and `flattenTemplateDeclarations` (per-declaration value spans) —
off one `flattenToRules`. Re-deriving the `&`/pseudo/`@media` nesting rules in
the codemod would be a second answer to "which element does this declaration
style", and the day they disagreed the editor would write into a rule the
canvas never showed. A dropped (interpolated) declaration is now KEPT in the
walk and skipped at serialisation, flagged `interpolated: true`, so the write
side can say "set from a `${…}`" instead of the useless "not written here".

**Scope — every file touched.**

- `src/core/ast-codemods/setStyledDeclaration.ts` *(new)* — ts-morph finds the
  tagged template at the recorded `line:col`, assembles the body from each
  quasi's **raw** text plus a segment map, matches one declaration, maps the
  value span back to absolute file offsets, `replaceText`.
- `src/core/page-parser/cssInJsTemplate.ts` — the two-reader refactor +
  `containsUnresolvedSentinel`, and `isStatementPosition` moved here from
  `cssInJsExtract.ts` (both sides must place a sentinel identically).
- `server/handlers/studio/styledStyleRuleSources.ts` *(new)* — load-time
  `StyleRule.id -> (file, line, col, className, componentName)`.
- `server/handlers/studioEditSchemas.ts` — `StyledEditSchema` + `styled` in
  `StudioEditRefusal['kind']`/`isRefusingEditKind`.
- `server/handlers/studioWriteback.ts` — the `case 'styled'` dispatch, and
  `styled` added to `dedupeStudioEdits`' passthrough.
- `server/handlers/studioPageLoad.ts`, `server/handlers/studio.ts` — the map on
  `StudioLoadResult` and both response shapes.
- `src/admin/pages/site/studio/styledRuleSources.ts` *(new)* — the client
  registry, the `StyledEditPayload`, and `styledClassRefusal`.
- `src/admin/pages/site/studio/styleRuleBaseline.ts` *(new, extraction)* — see
  "Two size-budget notes" below.
- `styleRuleWriteback.ts` (styled branch + `ruleIdsByNodeId`),
  `classNameWriteback.ts` (the class refusal), `refusalToasts.ts`,
  `studioLoadStreamSchema.ts`, `studioLiveReloadFetch.ts`,
  `fsCodemodAdapter.ts`, `studioEditPayload.ts`.
- `panels/PropertiesPanel/classCssWritability.ts` + `StyleTargetChip.tsx` — a
  `styled-template` tier that WRITES and does not lock.
- Tests: `setStyledDeclaration.test.ts` (14), `styledRuleWriteback.test.ts`
  (11). Docs: `studio-import.md`'s CSS-in-JS section, `studio-pipeline.md`,
  `STUDIO-WAVE4-PLAN.md` §W4-4.

**Decisions, and why.**

| Question | Answer | Why |
|---|---|---|
| A new edit kind, or an `op` on `kind: 'css'`? | **New kind, `styled`, schema in `studioEditSchemas.ts` — NOT a sibling of `studioCssWriteback.ts`.** | `studioCssWriteback.ts` is its own module because a `css` edit shares nothing with its siblings: file+selector target, no decodable `nodeId`, postcss. A styled edit is the opposite on every count — its `nodeId` IS a `rel:line:col` (the `styled.…` tag), so it inherits `studioEditLocation`'s path guard, `studioEditFile`'s touched-file set and `orderStudioEditsForApply` for free. A sibling handler would have re-derived all three. |
| Resolve interpolations on the write side, as Phase A does on the read side? | **No — every `${…}` is a hole here.** | `padding: ${SPACING.md}` has no value written in that template. Writing there would either clobber the interpolation or (worse) edit `SPACING` and change every other template reading the token. |
| One map or two (`styleRuleSources` + `styledStyleRuleSources`)? | **Two.** | `.css` file + selector written by postcss vs `.tsx` file + `line:col` + synthetic class written by ts-morph. Every guard downstream (`.css` extension, `classifyStylesheetEditability`, `resolveContainedCssPath`) is right for one and wrong for the other. Two maps ⇒ no branch can pick the wrong engine. |
| Lock the panel rows for a styled class? | **No.** | Value edits reach disk; the ones that do not (add/clear a declaration) refuse by name at save time naming the template. Greying the whole class would be a bigger lie than the one `classCssWritability.ts` was written to remove. |
| `ruleIdByNodeId` → `ruleIdsByNodeId` (a LIST). | Every declaration in one template shares the template's node id. | One refused write there must hold back the base rule AND the `:hover` rule flattened from the same template — neither reached disk under that id. |

**Measured** (every declaration Phase A put on the canvas, replayed through
`setStyledDeclaration` with the value it already has — a true dry run,
`changed: false`, no bytes written; both clones `git status`-clean afterwards.
Cloned OUTSIDE the worktree, per the recorded `.tmp/`-breaks-ESLint landmine):

| Repo | Declarations on canvas | Writable | Refused |
|---|---|---|---|
| `bchiang7/v4` | 907 | **871 (96.0%)** | 32 `interpolated-value`, 4 `unwritable-value` |
| `react-boilerplate` | 137 | **103 (75.2%)** | 34 `declaration-not-in-template` |

`react-boilerplate`'s refusals are ONE shape: `StyledButton` is
``styled.button`${buttonStyles};` `` — all 34 declarations live in
`buttonStyles.js`. The 4 `unwritable-value` cases are probe artifacts (three
multi-line values replayed verbatim) except one genuine limit:
`cursor: url("data:image/svg+xml;utf8,…")`, whose embedded `;` cannot be
written into a template CSS value.

**Landmines for whoever takes Phase C (or touches this).**

1. **Raw quasi text, never cooked.** `getLiteralText()` resolves escapes, so
   body offsets and file offsets drift by one character per escape and the
   write lands sideways. `rawQuasiText` strips delimiters off `getText()`
   instead; `declarationValueSpan` re-asserts `body.slice(...) === value` and
   returns NO span when it fails. Do not "simplify" either.
2. **Selector spelling differs between the two sides.** The client's selector
   comes back through happy-dom's CSSOM (`cssToStyleRules`), which respaces
   combinators; the codemod's is the flattener's own string. They are compared
   on a normalised form (`normalizeSelector`), and `analyzeDeclarationTarget`
   is then handed the CODEMOD's spelling, not the client's.
3. **Only the `kind: 'class'` base rule is reachable from the class picker.**
   A template's nested-selector rules become `kind: 'ambient'` rules that never
   enter `node.classIds`, so today nothing in the panel can target
   `.X:hover`. The codemod and the wire shape both handle it; the SURFACE does
   not exist yet. That is the cheapest next win here.
4. **`@keyframes` inside a template is still dropped, not hoisted** (Phase A's
   choice — it declares a global name). W5-5's animation work will meet this.
5. **Phase A landmines 2 and 3 are untouched** — transient props still reach
   the DOM, `as` is still not honoured.

**Two size-budget notes** (`module-size-budgets`, 700-line ceiling):

- `styleRuleWriteback.ts` would have hit 778. The BASELINE half —
  `baseline`/`contextBaseline`, `commitBaseline`, `setStudioStyleRuleSources`,
  `effectiveStudioStyles`, `realContextIds`, `STUDIO_BREAKPOINT_ID` — moved
  whole to `styleRuleBaseline.ts` (650 now), which is a real seam: "changed
  since when" vs "which edits to send". Names are re-exported verbatim, so no
  import site changed — the same arrangement `cssInsertDestination.ts` has.
- `fsCodemodAdapter.ts` sat at 699 and is now 698. The styled registry is
  installed through `setStudioStyleRuleSources`' options bag
  (`{ styledSources }`) rather than a second call, so one function still
  refreshes both maps and no code path can see one stale.

**Verification.** `bun run build`, `bun run lint` clean.
`bun test src/core/ast-codemods src/core/page-parser src/admin/pages/site/studio
src/__tests__/studio src/__tests__/panels src/__tests__/architecture
server/handlers` — green except two known pre-existing failures:
`icon-catalog-integrity` (vendored icon file missing) and the documented
`bun test server/handlers` batch flake (1 failure that vanishes on re-run).
`src/__tests__/canvas` shows 11 failures on this branch AND on a clean one —
the recorded canvas batch-isolation flake, untouched by this change. The
class-refusal regression test was verified to FAIL when the refusal is reverted.

---

### parser-11 — CSS-in-JS renders (W4-4 Phase A: extract, attach, report — no writeback)

**What was wrong.** A `styled-components`/`emotion` repo was *detected* and
nothing more. `ProjectProfile.styleToolchain.cssInJs` named the package,
`styleCompile.ts` did nothing with it, and `canonicalCheck.ts` emitted one
blanket "imports a CSS-in-JS package" line. The result on the board was worse
than "unstyled", which is how the docs described it: `const Card =
styled.div\`…\`` is a `kind: 'component'` node whose local declaration
`inlineLocalComponents` can never expand (a tagged template is not a function
that returns JSX), so every styled element rendered as an opaque **"Unknown
module" placeholder** — no tag, no children, no CSS. A whole class of
repository did not open.

**Scope — every parser file touched.**

- `src/core/page-parser/cssInJsExtract.ts` *(new)* — the ts-morph half: which
  tagged templates are styled templates, interpolation resolution, the
  synthetic class name, the per-file memo, the cross-file import walk.
- `src/core/page-parser/cssInJsTemplate.ts` *(new, pure leaf)* — the CSS half:
  one template body → flattened top-level rules, via **postcss**.
- `src/core/page-parser/cssInJsAttach.ts` *(new, pure leaf)* — a JSX tag +
  its attributes → the host tag and classes it actually renders.
- `src/core/page-parser/types.ts` — `CssInJsTemplate`/`CssInJsFinding`/
  `CssInJsExtraction` + `ParsedPage.cssInJs`.
- `src/core/page-parser/parsePageFile.ts` — builds the scope once per parse;
  `processElement` rewrites a styled call site to its host tag.
- `src/core/page-parser/jsxAttributeReaders.ts` — `ParseContext.cssInJs`.
- `src/core/page-parser/inlineLocalComponents.ts`,
  `src/core/page-parser/nextAppLayout.ts` — merge an inlined component's / a
  layout's own templates into the page's (dedup by class name).
- `src/core/page-parser/canonicalCheck.ts` — per-template honesty.
- `src/core/page-parser/index.ts` — barrel.
- `server/handlers/studioPageLoad.ts` — the stylesheet joins
  `compiledStyles.css` as `extraCss`.
- `src/core/page-parser/__tests__/cssInJsExtraction.test.ts` *(new, 20 tests)*.
- Docs: `docs/features/studio-import.md` (new "CSS-in-JS — static extraction"
  section + the two "what still does not import" entries + file/test indexes),
  `docs/reference/canonical-jsx.md` (rule 7's detection),
  `docs/agent-refs/studio-pipeline.md` (known non-imports).

**Decisions — for each new resolution: locks? codeProps? origin?**

| Resolution | Locks the node? | `codeProps`? | `origin`? |
|---|---|---|---|
| The synthetic class on a styled element | **No.** This is a fact about styling, not about whether the source places the element — the element is written at a real `line:col` and moves/deletes exactly as before. | **No.** `className` is translated to `classIds` by `parsedPageToSitePage` and never reaches the panel as a prop; a call site that ALSO wrote its own non-literal `className` still lands in `codeProps` through `extractProps`' existing catch-all, unchanged. | **No** — the class name is COMPUTED (a hash of file + binding + position). There is no literal behind it, so per the origin rule it gets none. |
| A resolved interpolation inside a template | **No** — it never reaches a `ParsedNode` at all; it becomes CSS text in the registry. | No. | **No** — even where the interpolation bottoms out in a literal, the CSS declaration is a computed string. Attaching one would point a future writeback at the token's own file while the user was editing a rule, which is precisely the wrong-literal hazard `textOrigin` is scoped to text to avoid. |
| The dropped `css` prop (emotion) | No. | **Removed from it.** The prop is compiled away by emotion's babel plugin, so a `codeProps` entry would put a read-only row in the panel for an attribute the rendered element does not have. | n/a |

**What the panel shows.** Nothing new. A styled rule is an ordinary imported
`StyleRule` with an `sc-` id, `updatedAt: 0`, and **no `styleRuleSources`
entry** — so `StyleTargetChip` already says "not saved to source", the
`kind: 'css'` write-back already refuses it as unmapped, and
`styleRuleNeedsCanvasOverlay` already leaves it to the raw `authoredCss` text.
That was the point of routing through `extraCss` instead of inventing a rule
origin: the compiled/read-only presentation is inherited, not re-derived.

**Measured on two real OSS repos** (cloned to `.tmp/`, since deleted):

| Repo | Templates | Clean | Partial | Unresolvable | Declarations |
|---|---|---|---|---|---|
| `bchiang7/v4` | 48 | 20 (41.7%) | 27 (56.3%) | 1 (2.1%) | **907** |
| `react-boilerplate/react-boilerplate` | 30 | 24 (80.0%) | 6 (20.0%) | 0 | **137** |

On `bchiang7/v4`, **34 of 221 parsed nodes** now carry a real host tag plus an
extracted class where each was previously an "Unknown module" box.

**Landmines — things the 1013-line `studio-import.md` did not already say.**
Every one of these is now written into that doc's new "CSS-in-JS" section
(`studio-scribe`: they are already there; keep them there, and add the fourth
one below to the Phase B brief when it opens).

1. **A styled element's synthetic class is NOT a source token.** It exists in
   `node.classIds` and in the DOM, but there is no `className` attribute in the
   `.tsx` holding it. Removing it in the CSS Classes panel produces a
   `kind: 'class'` edit whose `remove` token `setJsxClassName` cannot find, so
   the codemod silently no-ops (`{ ok: true }`, file untouched) while the canvas
   shows it gone — a canvas that disagrees with the file. **Phase B must refuse
   a class add/remove on a styled node, by name, before it reaches the codemod.**
   Not fixed here because the whole class-writeback path
   (`classNameWriteback.ts`, `fsCodemodAdapter.ts`) is owned by another agent
   this wave.
2. **A styled component's own props reach the DOM as attributes.** `<Wrapper
   active>` becomes `<div active="true">`. styled-components v6 filters
   `$`-transient props at runtime; this pass does not, so a canvas frame can
   carry attributes a real render would not. Cosmetic today, but it is the kind
   of thing a future attribute-panel change would trip over.
3. **`as` is not honoured.** `<Wrapper as="section">` still renders the
   template's own base tag, and `as` lands in `props` as a bogus attribute. One
   line to fix if it ever matters; deliberately not guessed at here.
4. **The single biggest remaining fidelity gap is `ThemeProvider`, and it is
   NOT a CSS-in-JS problem.** All 48 `block-dropped` findings on `bchiang7/v4`
   are `${({ theme }) => theme.mixins.flexCenter}`. Resolving `theme` to the
   one `<ThemeProvider theme={…}>` in the workspace is exactly Tier B's
   existing "one provider or nothing" rule — but the value it lands on is a
   `css\`…\`` tagged template, and splicing THAT needs the evaluator to hand
   back the declaration NODE a member chain bottoms out at, not a
   `StaticValue`. That is a `staticEvalCore` change. **Do not** solve it by
   writing a second, parallel node-resolution walk inside `cssInJsExtract.ts` —
   that is the duplicate-evaluator the tier table exists to prevent.
5. **`extraCss` is parsed BEFORE the project's own `.css` files**
   (`loadStudioStyles`), so a hand-authored stylesheet rule of equal
   specificity wins over a styled rule. In a real app styled-components injects
   at runtime and usually wins. Not observed to matter (synthetic class names
   are unique), but it is a real cascade-order difference between the canvas
   and the app.

**Verification.** `bun test src/core/page-parser src/core/ast-codemods
src/core/studio-sync src/__tests__/studio src/__tests__/architecture` — all
green (808 + 616 + 281). `bun run build` and `bun run lint` clean. The full
`bun test` shows 81 failures, all pre-existing/batch-isolation: the
`streamClaudeCli` suites, `projectMcpApprovals`, `cmsPlugins`, step-up auth,
and ~30 canvas/panel tests that pass individually (the documented batch-run
isolation flake). None touch page-parser, studio-sync, or the studio handlers.

---

### perf-04 — the user's own save reparsed the whole board; the agent's writes had used the narrow path for weeks

- **Agent:** store-engineer
- **Stage:** built and gated. `bun run build`, `bun run lint` clean; targeted
  suites green (see "Verification"). **Needs human dogfood** — the numbers
  below are a synthetic corpus, not a real board.
- **Updated:** 2026-09-06
- **Branch:** `fix/narrow-save-reload` off `main` (rebased onto `a90c3fc`).

**The defect.** `fsCodemodAdapter.saveSite` answered `shifted ||
sharedComponents` with `requestCmsSiteReload()` — the full `loadSite()`:
re-parse and re-convert every page, re-stream all of them, replace the whole
document, re-render every frame. `sharedComponents` is `isInlinedNodeId(id) ||
isRouteChromeNodeId(id)`, so on a Next.js App Router board — where the layout
chrome is shared by construction — it is true for a large share of ordinary
edits. The user paid a whole-board reparse roughly two seconds after they
stopped typing. The narrow path (`/reload-scope` → `?pageIds=` →
`patchPages`) already existed, worked, and was used only by the MCP
live-reload push and the structural commits.

**Client.** One module now owns "a write landed; make the board agree" —
`src/admin/pages/site/studio/studioBoardResync.ts`
(`resyncBoardAfterWrite(touchedFiles, { refusedRuleIds })`). Both writers call
it: `commitStructural` (moved out of `studioSaveRequests.ts`, where it was
`reloadStructuralScope`) and `saveSite`. Its module doc **enumerates the cases
that keep the full `loadSite()`** — page create/delete/rename, a new component
file, a workspace switch, project-wide settings that re-derive every page, the
`asset`/`detach`/`swap`/`insert-slot` one-shots, and anything `/reload-scope`
cannot prove narrow.

**Server, half 1 — `reload-scope` stopped asking a binary question.** It used
to answer "is this file a page's OWN route file, and does no other route
depend on it?", which meant a shared component always widened and App Router
widened unconditionally. It now **inverts `pageParseCache.ts`'s recorded
per-route dependency sets**: a touched file's scope is every cached route that
recorded it as a dependency. `anyOtherRouteDependsOnFile` is replaced by
`cachedRouteDependencies(dir)`. A shared `components/Card.tsx` narrows to the
pages that inline it; an App Router `layout.tsx` narrows to every route
beneath it. Four rules keep it from ever UNDER-reloading, all widening:
cold cache · a discovered route with no cache entry · **a project with any
Storybook story file** (W5-3's `storyPages.ts` is a third route producer and
does not use the parse cache, so its routes record no dependencies at all) ·
a touched file no cached route claims (this is what covers the cache's
documented one-level-deep limit) · a cached route no longer discoverable.

**Server, half 2 — `?pageIds=` reaches the compute.**
`loadStudioPages(dir, { pageIds })` skips the per-page CONVERT
(`parsedPageToSitePage` + the asset-sentinel rewrite) for unrequested routes.
`filterStudioLoadPages` is gone; `missingStudioLoadPageIds` reports only.
Parse and style collection stay project-wide **on purpose and it is
commented**: `loadStudioStyles` builds the registry from every route's
stylesheets together, so narrowing it would ship a shrunken `styleRules`, and
the client replaces its registry wholesale — `canvas-14`'s "renders against
last minute's stylesheet" with a new cause. The parse is cached; convert is
not, which is exactly why convert is the narrowable stage.

**Measured** (synthetic corpus: shared `Header` component, one stylesheet per
page, ~100 nodes/page; warm parse cache, which a targeted reload always has;
median of 15 runs on this machine):

| | 15 pages | 40 pages |
|---|---|---|
| server compute, full | 22.5 ms | 102.9 ms |
| server compute, `?pageIds=` one page | 14.5 ms (**−36%**) | 45.5 ms (**−56%**) |
| page payload | 247 KB → 16 KB (−93%) | 659 KB → 16 KB (−97%) |
| client `JSON.parse` of pages | 0.9 ms → 0.1 ms | 4.1 ms → 0.1 ms |

Those are the *narrowed-load* numbers only. The path this replaces was
`loadSite()`, which on top of the full load also pays two more HTTP round
trips (`/framework`, `/tokens`), a whole-document `validateSite`,
`resetLoadedValues` over every page, and a full-board re-render — none of
which a `patchPages` patch pays.

**Two interleaving landmines, both fixed, both with a regression test that was
verified to FAIL when the fix is reverted** (`studio/__tests__/saveNarrowResync.test.ts`):

1. **Ordering.** A resync re-reads the touched pages and rewrites the very
   diff baselines `saveSite` advances *after* its POST
   (`commitNodeValuesBaseline`, `commitStyleRuleBaseline`,
   `commitClassIdsBaseline`). Resyncing inline — where `requestCmsSiteReload()`
   used to sit — lets the save's own commit then overwrite the fresh disk
   baseline with the PRE-reload document, and the next autosave tick re-sends
   every prop of every reloaded page as if the user had just typed it. The
   adapter therefore records `resyncTouchedFiles` and awaits the resync as the
   LAST thing `saveSite` does. `requestCmsSiteReload()` was fire-and-forget and
   hid this; an awaited narrow reload does not.
2. **The refusal baseline.** `fetchStudioPagesById` calls
   `setStudioStyleRuleSources`, which calls `commitBaseline` on the freshly
   parsed rules. Without `refusedRuleIds` that adopts, as the new baseline, a
   value the server just REFUSED to write — so the user's obvious retry (the
   same value again) diffs as "no change" and is never attempted a second
   time. That is `style-02`'s bug #3, reachable again through the reload path.
   `refusedRuleIds` is now threaded save → resync → fetch → `commitBaseline`,
   and `setStudioStyleRuleSources`'s third argument changed from `pages` to the
   full `CommitBaselineOptions`.

**Also cleaned up (in scope, not drive-by):** `studioWriteDir` /
`setStudioLoadedDir` moved from `studioSaveRequests.ts` to
`studioWorkspaceDir.ts`, which already owns "which project is active" — six
unrelated clients (icon/component/translation catalogs, page requests, the
live-reload bridge, the new resync module) were importing the save module
purely to ask that question, and the resync module would otherwise have closed
a cycle. `resolveModuleId`/`resolveTextProp` extracted from
`studioPageLoad.ts` (which my doc additions pushed to 751 lines) into
`server/handlers/studio/moduleMapping.ts` — they encode the base-module
catalogue's rules, not the pipeline's.

**Store-engineer handoff, per the contract.**

- **Slices touched: none.** No slice gained state and no selector was added or
  changed. `patchPages` (`site/lifecycleActions.ts`) is called with the same
  `PatchPagesInput` it already accepted, from one more caller. Nothing new is
  stored, nothing new is derived, nothing new needs to survive reload.
- **New selectors: none.** (So: no O(n) selector was introduced; the "never
  put a tree walk in a selector" rule is untouched by this change.)
- **New mutations: none.** No history entry, no coalesce key. `patchPages`
  keeps its deliberate posture — bypasses `mutateSite`/`runHistoricMutation`,
  never flips `hasUnsavedChanges`, never pushes undo history, because the
  content came FROM disk.
- The one store-adjacent behaviour change is *which* store action a save-
  triggered reload ends in: `patchPages` instead of `loadSite`. That is
  strictly gentler — `loadSite` replaces the whole document; `patchPages`
  upserts by page id and leaves other pages' unsaved edits alone.

**Landmines for the next agent.**

1. **Narrowing may never UNDER-reload.** Every widening rule in
   `reloadScope.ts` is load-bearing. If you make one of them narrower, the
   failure mode is a board silently showing stale content with no error
   anywhere — the hardest class of bug in this system to notice.
2. **Storybook projects do not narrow at all right now**, on purpose (rule 2).
   The named follow-up is to have `buildStoryRouteEntries` record its parses
   in `pageParseCache` like the other two route producers do; then delete the
   `storyFilesIn` gate and its test.
3. **`fsCodemodAdapter.ts` is at 699 of the 700-line ceiling.** The next
   feature in it has to extract first. `studioSaveRequests.ts` (552) and
   `studioBoardResync.ts` (158) are where the extractions have been going.
4. **A narrow resync drops an editor-authored rule that was never written to
   disk** — `patchPages` replaces `styleRules` wholesale and never merges
   (a merge would resurrect a rule the edit deleted, `canvas-14`). This is
   PARITY with `loadSite`, not a new hazard, and it is documented in
   `studioBoardResync.ts`. Do not "fix" it by making the narrow path merge:
   the two reload paths would then give different answers for the same
   document, which is worse than the thing it fixes.
5. **If you add a field to the load stream's `meta` line, apply it in
   `fetchStudioPagesById` too** — `canvas-14`'s standing rule, now on a hotter
   path than it was.

**Verification.**

- `bun run build` ✅, `bun run lint` ✅.
- `bun test src/__tests__/architecture src/__tests__/editor-store
  src/__tests__/studio src/admin/pages/site/studio server/handlers` — 2582
  pass, 2 fail. Both pre-existing and outside this change:
  `icon-catalog-integrity` (`chevron-left` missing from `node_modules`) and
  `server/handlers/studio/projectMcpApprovals.test.ts` (`Cannot find module
  './agentRosterMcpTools'`).
- Full `bun test` on the pre-rebase tree: 10837 pass / 73 fail, every failure
  in the documented pre-existing set (`streamClaudeCli` cluster,
  `icon-catalog-integrity`, `stopGateCheck`, and the canvas iframe-rendering
  suites that pass in isolation and fail only in a batch run).
- New tests: 6 in `reloadScope.test.ts` (shared-component narrowing, App
  Router route + layout-chain narrowing, and four widening cases), 5 in
  `studioPageLoadNarrow.test.ts` (the narrowed compute keeps the project-wide
  registries byte-identical, including rules only an unrequested page
  imports), 4 in `pageParseCache.test.ts` (the dependency map, incl. that it
  reads recorded keys and never mtimes), 8 in `saveNarrowResync.test.ts`
  (routing + the two interleaving guards).
- NOT run: browser/e2e.

**Human action needed:** dogfood at `/admin/site?studio` on a board with
several frames sharing a component. Type in one text node, wait for the
autosave, and confirm (a) only the frames that actually share the touched file
flicker/re-render, (b) undo still walks back through the whole burst, and
(c) a class edit that Studio refuses still re-attempts on your next save
instead of going quiet.

---

### struct-05 — two modules crossed the 700-line ceiling on `main`; both split, neither grandfathered

- **Agent:** studio-implementer
- **Stage:** done
- **Updated:** 2026-09-06
- **Branch:** `refactor/split-oversize-modules` off `main`.

Recent merges pushed `IframeFrameSurface.tsx` (707) and `server/ai/drivers/claudeCli.ts`
(716) past `module-size-budgets`' 700-line CEILING, failing the gate on `main`.
Fixed the way every prior crossing in this file was: **extraction, not a
`GRANDFATHERED` entry** — the ledger gained nothing and should stay as it is.
`IframeFrameSurface.tsx` (707 → 444) finally performed the split its own
graduation note had named and deferred: the cross-iframe wheel + pointer +
keyboard forwarding — every event that fires inside the frame but belongs to the
editor's parent-document layers (canvas pan/zoom, the cross-frame drag relay, the
global shortcut listeners) — moved verbatim to `canvas/useIframeEventForwarding.ts`,
alongside its sibling `useIframeCursorBridge`/`useIframeFrameAutoHeight` hooks;
the hook is called at the exact position the two effects occupied, so effect
order, injector mount order, and dep arrays are unchanged (the extracted deps
gained only `iframeRef`, a stable ref object, because it is now a parameter and
`exhaustive-deps` demands it). The component is left owning the iframe document
alone. `claudeCli.ts` (716 → 655) gave up the one part of itself that has nothing
to do with running a turn: the static `FALLBACK_MODELS` catalogue plus
`claudeCliCapabilities()` — pure data and one pure function, changing when
Anthropic ships a model alias, not when the turn machinery changes — now
`drivers/claudeCliModels.ts`, exporting `CLAUDE_CLI_FALLBACK_MODELS`. This was
deliberately kept clear of the streaming body, the argv assembly, and the session
flags so the **planned warm-process rework** of `streamClaudeCli` lands on an
unmoved file with ~45 lines of headroom. Pure moves throughout: no re-export
shims, no behaviour change, no runtime logic touched. Verified: the gate passes,
`bun run build` and `bun run lint` clean, `src/admin/pages/site/canvas` 90/90,
and `claudeCli.test.ts` is **bit-identical to its `origin/main` baseline (24 pass
/ 53 fail)** — that cluster and `icon-catalog-integrity` were already failing
before this branch and are not this change's.


---

### panel-11 — the unreachable CMS explorer panels are gone; Button has a `loading` state; rail colour means something

- **Agent:** studio-implementer
- **Stage:** done
- **Updated:** 2026-09-06
- **Goal:** delete the dead CMS chrome the Explorer panel's own header comment
  already declared unreachable, and land two design-system fixes that were
  blocking consistent async UI.
- **Scope:** `panels/SiteExplorerPanel/**` + `panels/MediaExplorerPanel/**`
  (deleted) · `shared/dialogs/{SiteCreateDialog,TemplateSettingsDialog,VCDeletionConfirmDialog}`
  (deleted, except `SiteCreateDialog.module.css`) · `store/slices/uiSlice.ts` ·
  `layout/siteEditorLayoutPersistence.ts` · `state/workspaceLayoutStorage.ts` ·
  `spotlight/commands/panels.ts` · `sidebars/LeftSidebar` + `sidebars/PanelRail` ·
  `src/ui/components/Button/**` · `src/ui/railAccent.ts` · fourteen async-button
  call sites · `docs/{design,editor}.md`, `docs/reference/{canvas-dnd,page-tree,persistence-keys,design-tokens}.md`.
  Three commits on `refactor/dead-cms-chrome-and-ui-polish`, one draft PR.
- **Done so far:**
  - **Deleted** `SiteExplorerPanel/` (15 files) and `MediaExplorerPanel/` (8),
    their four test files, and the three dialogs only they mounted. Every
    importer was traced first: the sole survivors were their own tests, two
    architecture allowlists, and docs.
  - `VCDeletionConfirmProvider` was still wrapped around the whole left sidebar
    (`LeftSidebar.tsx:136`) with zero consumers of `useVCDeletionConfirm` once
    `SiteExplorerPanel` went — deleted with it.
  - Killed the dead three-tab state end to end: `ExplorerPanelTab` /
    `explorerPanelTab` / `setExplorerPanelTab` (`uiSlice.ts`), its
    `SiteLayoutSelection` slot and `explorerTab()` reader
    (`siteEditorLayoutPersistence.ts`), its storage-schema field
    (`workspaceLayoutStorage.ts:82`), and the three spotlight commands that set
    it (`panels.showSite` / `showCode` / `showMedia`).
  - **`Button` now has `loading`** (`src/ui/components/Button/Button.tsx:47`):
    native `disabled` + `aria-busy` + a spinner absolutely centred over the
    resting label, which stays in flow under `visibility: hidden` inside a
    wrapper that inherits the button's own `gap`/`justify-content`. The width
    does not move. `.loading` also resets the `:disabled` 38% opacity.
    Fourteen hand-rolled busy states migrated.
  - **Rail accents are semantic** (`src/ui/railAccent.ts`): `RailAccentGroup` —
    `navigate` gold · `style` mint · `inspect` sky · `content` lilac · `assist`
    violet — declared per item in `PanelRail.tsx`'s `PRIMARY_RAIL_ITEMS`. The
    FNV hash survives only for plugin panels and the import/export dialogs'
    open-ended category lists.
- **Next step:** none for this entry. Two follow-ups are listed in the PR body:
  (1) rename `shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css` to
  something honest once the in-flight `ImportProjectDialog` move lands — the
  component is deleted, the stylesheet has ten live importers, and one of them
  is a file this task was told not to touch; (2) ~18 remaining ternary-label
  busy buttons that live in files this task could not touch
  (`toolbar/DownloadCodeButton`, `studio/ImportProjectDialog`,
  `PropertiesPanel/{ImageSourceSection,FormSettingsPanel,InstanceCallSiteView}`,
  `canvas/PackageComponentPlaceholder`) plus a handful it could
  (`ContentPanel`, `MfaSettingsCards`, `McpServersSection`,
  `MediaStoragePanel`, `FrameworkManagerDialog`, the two font dialogs).
- **Decisions:**
  - **`src/admin/shared/media/` is kept in full** — the audit flagged its folder
    panel / canvas / viewer window / picker modal as deletion candidates. They
    are not dead: `MediaPickerModal` transitively owns `MediaSidebar` →
    `MediaFolderPanel` + `MediaStoragePanel`, `MediaCanvas`, `useMediaWorkspace`,
    `useMediaDnd`, and it is opened by Settings → General (favicon), `SvgControl`,
    and `MediaLibraryControl`. `MediaViewerWindow` (→ `TagEditor`,
    `ReplaceFileDialog`) is opened by `MediaLibraryControl`.
  - **`SiteCreateDialog.module.css` is kept where it is** — see Landmines.
  - **`assignRailAccents` no longer de-duplicates explicit accents** — two
    surfaces in the same `RailAccentGroup` are *supposed* to match. Repeat
    avoidance now applies only to the hashed fallback.
  - **`SplitButton.busy` was deliberately not folded into `Button.loading`** —
    it spins the caller's own leading icon and does NOT disable. Different
    contract, left alone.
- **Landmines:**
  - `SiteCreateDialog/` looked like a clean leaf delete. Its `.module.css` is
    imported as `dialogStyles` by **ten** live surfaces (`ImportProjectDialog`,
    `DesignImportDialog`, `SelectorDialogs`, `CreateColorDialog`,
    `ClassRenameDialog`, `ExplorerRenameDialog`, `UserDialog`, `RoleDialog`,
    `McpServersSection`, `McpTab`). Deleting the folder wholesale breaks the
    build. The `.tsx` / `index.ts` / `siteItemNames.ts` are gone; the stylesheet
    stays with a header comment saying why the folder name is now historical.
  - `single-drag-mechanism.test.ts` has a **stale-entry** assertion — deleting
    an allowlisted file fails the gate until you also delete its allowlist line.
    Same shape in `component-system-placement.test.ts` (its G2 gate read a file
    that no longer exists). Both fixed in the same commit.
  - **`git stash` is shared across all worktrees.** Using it to A/B a `fallow`
    baseline raced another agent and popped *their* canvas/perf WIP into this
    worktree (13 tracked + 5 untracked files). Recovered by re-stashing exactly
    those paths with `git stash push -u -m "RECOVERED: …"` — it is back on the
    stack under that label, at `stash@{0}` as of this entry. **Do not use
    `git stash` for baseline comparisons here.** Use a throwaway worktree or
    `git checkout HEAD~n` instead.
  - `fallow dead-code`'s headline counts are useless as a before/after signal:
    95% of "unused files" are `studio-workspace/` fixture projects, and the
    number went *up* (409 → 411 src+workspace files, 1026 → 1041 issues) because
    deleting `SiteExplorerPanel` orphaned ~8 `@core/page-tree` barrel
    re-exports. Diff the JSON file list, not the summary line.
- **Verification:** rebased twice while verifying (`main` moved three times);
  final base is `da2c862`, and build/lint were re-run there.
  - `bun run build` — exit 0.
  - `bun run lint` — exit 0.
  - `bun test` (full, at base `42712cd`) — 10774 pass / 74 fail. Triaged: 55
    `claudeCli` + 1 `icon-catalog-integrity` (the known set); 3 batch-only
    timeouts (`moduleInserterFavorites`, `publicSdkExports`,
    `stepUpSecondaryActions`) that pass 12/12 in isolation; 15
    canvas-iframe/happy-dom. `src/__tests__/canvas` was A/B'd at base and HEAD
    — base 10 failures, HEAD 11, the single difference being one arm of
    `canvasScrollUnrollPinInteraction.test.tsx`. That suite was then run four
    times per side: base 0/2/1/1, HEAD 1/2. A 5000 ms-timeout flake; this PR
    touches no file under `canvas/`.
  - `bun test src/__tests__/{architecture,ui,layout,panels,site-explorer,media,toolbar}`
    at the final base — 1373 pass / 2 fail, both pre-existing on `origin/main`
    itself (`icon-catalog-integrity`, and `module-size-budgets` naming
    `IframeFrameSurface.tsx` 707 + `claudeCli.ts` 716, both from upstream).
- **Human action needed:** **dogfood the left rail at `/admin/site?studio`.**
  This is a deliberate visual-identity change. Expect: Explorer gold
  (unchanged), **Framework and Classes both mint** (they used to be two
  different colours — the shared tint is the point), Inspect sky, Content lilac,
  Comments lilac (unchanged), AI assistant violet. Also worth a look: click any
  migrated async button (Account → Save profile, Settings → plugin dialogs,
  Export → Download bundle) and confirm the spinner appears **without the button
  changing width**.

---

### server-17 — Storybook CSF stories import as board frames, on a board of their own

- **Agent:** studio-implementer
- **Stage:** done (needs human dogfood — see "Human action needed")
- **Updated:** 2026-09-06
- **Branch:** `feat/storybook-import`, rebased on `main`.
- **Goal:** W5-3. A project's `*.stories.{tsx,ts,jsx}` become board frames — one
  per accepted story — parsed statically through the EXISTING pipeline, with
  every refusal named. Done means: zero cost for a project without stories,
  measured acceptance on real OSS Storybook repos, no parser internals touched.
- **Scope:** NEW `server/handlers/studio/{storyDiscovery,storyLiterals,storyPages,routePageEntry,storiesRoutes}.ts`
  + their two test files. EDITED `server/handlers/studioPageLoad.ts` (a third
  route-entry producer), `studio/boardFrames.ts` (`syncStoryBoardFrames`),
  `studio/studioMeta.ts` (`stories` field), `studio/studioLoadResponse.ts` (one
  `Omit`), `studio.ts` (sub-router + one call), `docs/features/studio-import.md`,
  `docs/agent-refs/{path-index,studio-pipeline}.md`, `PROJECT-BRIEF.md`.
  **`src/core/page-parser/**` was NOT touched** — stories flow through
  `parseJsxTree` / `getReturnedJsxRoots` / `resolveComponentSources` /
  `inlineLocalComponents` exactly as they are.
- **Done so far:**
  - `storyDiscovery.ts:1` states the accepted subset in the module header. Two
    shapes: **args-only** (CSF3 object + `meta.component`) and **jsx-only** (a
    function body that is nothing but JSX — as `render:`, as
    `export const X = () => <Y/>`, and as `export function X()`).
  - `storyPages.ts:157` builds the args-only shape as a synthesized ONE-NODE
    `ParsedPage` whose `kind:'component'` call site is handed to the real
    `inlineLocalComponents`. That resolves the identifier through the story
    file's own imports, parses the component's file, substitutes the args, and
    yields a `studio.instance` with the component's real subtree — every
    descendant carrying a composite id anchored in the COMPONENT's file, as
    editable as any inlined component's.
  - `storyPages.ts:118` builds the jsx-only shape through the ordinary page
    path, so those nodes get real, WRITABLE `relFile:line:col` ids in the
    `.stories.tsx` itself.
  - 13 named refusal reasons (`StoryRefusalReason`), reported by
    `GET /admin/api/studio/stories` (`storiesRoutes.ts`). Nothing is ever
    half-rendered and nothing is silently dropped.
  - `boardFrames.ts:171` (`syncStoryBoardFrames`) places frames on a board of
    their OWN named "Stories", one row per `meta.title`. Called from the
    `/load` route (`studio.ts`), never from `loadStudioPages` — the parse
    pipeline stays a pure read.
  - Zero-cost gate: `storyFilesIn` is a filename filter over the directory walk
    the load already does. No ts-morph work happens unless it matches.
  - `studioPageLoad.ts` extracted its private `RoutePageEntry` into
    `studio/routePageEntry.ts` (a pure type leaf) so `storyPages.ts` can produce
    them without an import cycle.
  - Docs: a full "Storybook stories as pages (W5-3)" section in
    `docs/features/studio-import.md` — accepted subset, refusal table, measured
    rates, the board rule, and the writeback blocker below.
- **Next step:** none for this PR. Two follow-ups, both in files this wave's
  other agents own: (1) lift the args writeback blocker in `fsCodemodAdapter.ts`
  (below); (2) a "Stories" affordance in the UI if the board-switcher entry
  proves too quiet in dogfood.
- **Decisions:**
  - **Stories get their own board, not the project's** — because a design
    system routinely has more stories than screens (Polaris: 664 stories, 87
    files), and folding those in would multiply the frame count of a board the
    author curated on a load they asked nothing of. The board switcher already
    makes it discoverable. This is the "toggle or section" the task asked for,
    expressed as the section the board model already has. I could not build a
    panel toggle — `panels/**` is owned by another agent this wave.
  - **Placement is ONE-TIME, never reconciled.** `.studio/meta.json`'s
    `stories.placedPageIds` is a ledger of every story frame ever placed, so a
    frame the user deleted never returns while a NEW story still appears; and
    once `stories.boardId` no longer resolves (they deleted the board),
    nothing is placed again. `stories.enabled: false` is the explicit off
    switch (`POST /admin/api/studio/stories`).
  - **An args-only story's synthesized call site is `locked` and every arg is
    in `codeProps`** — see Landmines.
  - **Refusals do NOT ride the `/load` envelope.** That is an NDJSON contract
    the client mirrors by hand (`fsCodemodAdapter.ts`'s
    `StudioLoadStreamLineSchema`); `GET /admin/api/studio/stories` is the
    surface instead. `StudioLoadResult.stories` is `Omit`ted from
    `studioLoadStreamLines`' parameter type for exactly this reason.
- **Landmines:**
  - **Args writeback does NOT fall out naturally, and forcing it would corrupt
    files.** An arg IS an ordinary string literal at a known `rel:line:col` —
    exactly the `textOrigin`/`setStringLiteral` shape — so recording
    `resolvedProps[arg].origin` is enough for `fsCodemodAdapter.saveSite`'s
    FLAT prop loop (`fsCodemodAdapter.ts:417`, which emits `kind:'literal'`
    aimed at the origin). It is **not** enough for a `studio.instance`: the
    adapter's `callSiteProps` branch (`fsCodemodAdapter.ts:450`) has NO origin
    case — it asks `isPropWritableToSource` (which an origin makes say YES) and
    then emits `kind:'prop'` at the call site, which here is the
    `export const Primary` identifier. So an origin today would authorise
    precisely the mis-aimed write the rule exists to prevent. This module
    therefore records `source` and no `origin`. Fixing it is one branch in
    `fsCodemodAdapter.ts` (mirror the flat loop's origin case). Phase B.
  - The synthesized call site's `loc` is a REAL position (the `export const`
    identifier) because trap #2 forbids inventing one — but no JSX lives there,
    which is why the node also carries `locked: true` +
    `STORY_CALL_SITE_LOCK_REASON` so `refuseStructuralEdit` answers
    `code-placed` rather than letting a delete/move reach a codemod.
  - `resolveComponentSources` classifies a same-file `declare const X` as a
    LOCAL component, so `meta.component: X` on an ambient declaration is
    accepted (and then renders "Unknown module" when inlining declines) rather
    than refused. Same behaviour a page's call site already has — not a story
    bug.
  - Two repos, two nearly-opposite CSF dialects. Primer is render-function-heavy
    (732 jsx / 7 args), Polaris is args-object-heavy (651 args / 13 jsx). Do not
    tune the subset against one repo.
  - **`git clone`ing an OSS repo into `.tmp/` breaks `bun run lint`** —
    ESLint 10 walks into the clone and tries to load ITS `eslint.config.mjs`
    (`Cannot find package '@eslint/compat'`). Clone measurement corpora
    OUTSIDE the worktree.
- **Verification:**
  - `bun run build` (tsc -b && vite build) — pass, before and after the rebase.
  - `bun run lint` — clean.
  - `bun test server/handlers/studio/__tests__/story{Discovery,BoardFrames}.test.ts`
    — 25 pass / 0 fail.
  - `bun test server/handlers` — 1280 pass / 1 fail. The failure is
    `projectMcpApprovals.test.ts` (`Cannot find module './agentRosterMcpTools'`),
    pre-existing and outside this diff.
  - `bun test src/__tests__/architecture` — 512 pass / 1 fail after rebasing on
    `main`. The failure is `module-size-budgets` naming
    `src/admin/pages/site/canvas/IframeFrameSurface.tsx` (707) and
    `server/ai/drivers/claudeCli.ts` (716) — **both arrived from upstream
    `main`, neither is in this diff.** It passed 511/0 on the pre-rebase base,
    and my own `storyDiscovery.ts` was split (`storyLiterals.ts`) to get under
    the same ceiling when it tripped at 722.
  - **Measured acceptance on real OSS Storybook repos** (cloned to a scratch
    dir outside the repo, never `studio-workspace/`):

    | Repo | Story files | Accepted | Refused | Rate | Refusals |
    |---|---|---|---|---|---|
    | `primer/react` (`packages/react`) | 247 | 739 (732 jsx, 7 args) | 360 | **67.2 %** | `render-logic` 338, `decorators` 20, `no-jsx` 1, `not-a-story` 1 |
    | `Shopify/polaris` (`polaris-react`) | 87 | 664 (651 args, 13 jsx) | 15 | **97.8 %** | `play-function` 15 |

    Discovery cost: ~5.4 s for 87 files, ~7.7 s for 247 (one-off per load, and
    only for a project that HAS stories).
- **Human action needed:** dogfood. Put a project with `*.stories.tsx` in
  `studio-workspace/` (or point `pagesDir` at one), open `/admin/site`, and:
  (1) confirm a second board named **Stories** appears in the board switcher and
  the project's own board's frame count is UNCHANGED; (2) open it and confirm
  one row per `meta.title` with the variants laid out left to right; (3) select
  a node INSIDE a story frame and confirm its text/style edits still write back
  (they land in the component's own file, warned as shared); (4) confirm the
  story frame's own args show in the panel as read-only rather than as
  live-looking inputs that eat keystrokes; (5) delete a story frame, reload, and
  confirm it stays deleted.

---

## Standing notes

### standing-08 — NEVER type-check with `npx tsc`. It is the wrong compiler.

**This repo pins `typescript@~6.0.3`. `npx tsc` resolves and downloads
`5.9.3` instead**, because there is no `tsc` on PATH for npx to prefer. The two
disagree about `lib` defaults and about discriminated-union narrowing, so the
old compiler invents **~100–200 errors that do not exist**:

- `error TS2488: Type 'NodeList' must have a '[Symbol.iterator]()' method`
  (×14) — reads like a missing `DOM.Iterable` in `tsconfig.app.json`.
- `error TS2339: Property 'error' does not exist on type '{ ok: true; … }'`
  (×91) — reads like a broken `SchemaResult` narrowing across the whole repo.

**Both are phantoms.** With the pinned compiler the same tree is `exit 0`,
zero errors:

```sh
./node_modules/.bin/tsc -b     # correct — this is what `bun run build` runs
npx tsc -b                     # WRONG — silently a different compiler
```

`bun run build` is `tsc -b && bun run scripts/vite.ts build`, and bun resolves
`tsc` from `node_modules/.bin`, so **`bun run build` has always been right.**
Use it, or the explicit `./node_modules/.bin/tsc` path.

Recorded because **two agents on 2026-07-31 hit this independently and both
misdiagnosed it** — one as "a tsconfig `lib`/`target` regression from a
concurrent session", one as "another agent's in-flight refactor". Either
would have sent the next person hunting a bug that does not exist. If you are
about to report a large, cross-cutting `tsc` breakage in files nobody touched,
**check `npx tsc --version` against `package.json` before you write it down.**

### standing-01 — the full suite runs now: 34 pre-existing failures, not ~200
**Rewritten 2026-07-31 by `test-infra-01`. The old numbers are dead — do not
quote "~200 failures" or "never run the full suite" any more.**

`bun test` now **completes** in ~300 s and reports **7618 pass / 34 fail /
1 skip** across 772 files on this Windows machine. Measured before/after on the
same tree, same machine:

| | pass | fail |
|---|---|---|
| before `test-infra-01` | 7436 | **215** |
| after | 7618 | **34** |

**181 of the 215 were one bug** — `EBUSY` unlinking temp SQLite databases under
`%TEMP%\cms-test-*`. Root cause and fix are in the `test-infra-01` entry:
`DbClient` had no `close()`, and bun's own statement cache evicts prepared
statements that only the GC finalizes, so `sqlite3_close_v2` closed into a
zombie that kept the file locked. Both halves are fixed; the EBUSY class is
**gone, not reduced** (`grep -c EBUSY` over a full run: 0).

The suite also used to **wedge forever** — nobody could finish a full run. Cause
was not load: `sqlite-transaction-concurrency.test.ts` deadlocked in
`expect(...).rejects` (see `test-infra-01`). Also fixed.

**The 34 that remain are genuinely not yours** (unchanged before → after, zero
new failures introduced). They are:

- **Windows path/separator gates** — `codemirror-lazy-only`,
  `dispatcher-html-pipeline`, `error-boundary-coverage`,
  `keybindings-registry-single-source`, `selectorStability`,
  `siteExplorerPanel`, `plugin-sdk/lintCli`, `cacheLayout` (×2),
  `cmsMigrations`. These join or compare paths and lose on `\` vs `/`. Nobody
  has fixed them; they are still the honest "not my failure" bucket.
- **Plugin QuickJS/worker suites** — `pluginServerRuntime` (×7),
  `pluginWorkerRpcTimeout` (×3).
- **In-flight work from parallel agents** — `fsCodemodAdapter` (×12),
  `layerNodeContextMenu`, `agentBreakpointCapture`.

**Triage rule (updated):** run the full suite — it works and it is fast enough.
Diff your failures against the 34 above. Anything else is yours. `tsc -b`
currently reports ~108 errors, all in `src/core/*` from another agent's
in-flight refactor; that number is *not* a `test-infra-01` regression.

### standing-02 — verification split: browser for layout, static gates elsewhere
**Amended 2026-07-31.** The original rule was "never run a browser pass, the
human dogfoods everything." That rule shipped a real bug: WS-8.2's frame-height
defect passed `canvasScrollUnrollPinInteraction.test.tsx` because **happy-dom
has no layout engine** and structurally cannot decide whether an out-of-flow
element contributes to `scrollHeight`. A green test that cannot fail on the
thing it is named after is worse than no test.

The rule now splits by whether the DOM is enough to answer the question:

- **Canvas, frames, geometry, overlays, scroll/height behaviour → run a real
  browser pass** (Playwright; `playwright.config.ts` exists). Assert on
  *computed layout* — measured rects, `scrollHeight`, computed styles after
  layout — not on markup shape. This is where happy-dom is blind.
- **Panels, forms, server, parser, store → static gates only**
  (`bun run build`, `bun test <your suites>`, `bun run lint`). happy-dom models
  these fine and a browser pass is redundant spend.

Still required either way: end the handoff with a concrete **Human action
needed** line naming the route and the exact thing to look at. The human is no
longer the only line of defence, but they are still the last one.

### standing-06 — how work lands: one commit per work order
Each work order is **one commit** on the current feature branch, so a bad one
can be reverted alone instead of unpicked from a blob. A **draft PR** opens at
each milestone boundary. `main` is protected — never push to it, never bypass
branch protection, never treat a local commit on `main` as delivery.

Conventional Commit titles, no agent-branded prefixes (`[claude]`, `codex/…`)
in branch names, commit subjects, or PR titles. Stage explicit pathspecs and
inspect `git status -sb` first: a parallel agent's files must never ride along
in your commit.

### standing-07 — WS-3 may not delete `@alm-design` on schedule
`STUDIO-IMPORT-V2-PLAN.md` WS-3 says to delete `src/modules/alm/`,
`scripts/gen-alm-manifest.mjs`, and the `@alm-design/design-system` dependency
once generic package modules land. **That deletion is gated on evidence, not on
WS-3 landing:** the generic package pipeline must first render the eSIM board
*visually equivalently*. That package supplies 39 components and is what
actually renders the main corpus today; the local `design-system/` folder has 1.

This is a deliberate, time-boxed exception to CLAUDE.md's no-old-and-new rule —
the two paths coexist only until the generic one is proven, then the old one
goes. Do not let it calcify, and do not build new features on `alm.*`.

### standing-03 — the canvas has two known, specced performance defects
Both are diagnosed in `docs/agent-refs/canvas-internals.md` §Perf and specced in
`STUDIO-IMPORT-V2-PLAN.md` WS-5. Do not re-diagnose them:
1. Selection chrome is positioned in the parent document from measurements taken
   inside a zoomed iframe, so error scales with zoom — this is the "menu appears
   far from the selected element" report.
2. Two `useEditorStore` selectors scan every node of every page on **every**
   store change (`PropertiesPanelBody.tsx` `sharedTextOriginCount`,
   `InPlaceInspector.tsx` `findNodeById`).

### standing-04 — `public/runtime/react.js` already solves React identity sharing
The plugin host ships pre-built ESM shims at `public/runtime/{react,react-dom,
react-jsx-runtime,react-jsx-dev-runtime}.js`. WS-3 of the roadmap needs exactly
this mechanism to make bundled npm components share the admin's React instance.
Reuse it rather than inventing an import-map scheme from scratch.

### standing-05 — parallel-wave protocol, for the next time several agents touch Studio server handlers at once
`server/handlers/studio.ts` (the route table) and `STATE.md` are single-file
collision points across a parallel wave. `meta-04`'s four concurrent agents hit
zero merge conflicts under this rule: each agent's routes live in their OWN
file, exporting a `tryServeStudio*(req, url, pathname)` sub-router the
orchestrator composes into `STUDIO_SUB_ROUTERS` — mirroring how
`server/router.ts` already composes top-level handlers. Agents write their
handoff to a scratch file; the orchestrator merges into `STATE.md` once, after
the wave lands. Only apply this when agents are genuinely running in parallel —
a solo dispatch (like `server-04`) writes directly to both files, per that
task's own dispatch note.

### standing-09 — happy-dom's CSSOM silently drops EVERY rule inside an `@layer` block, with no warning — and this is not hypothetical, it already affects live imports

Verified by direct experiment (`canvas-07`, 2026-08-01): `sheet.replaceSync('@layer base { .hero { color: red } } .plain { color: blue }')`
against happy-dom's `GlobalWindow().CSSStyleSheet` produces exactly ONE rule
(`.plain`). `.hero`, and the `@layer` statement itself, vanish — not as a
`dropped-at-rule` warning, not as anything observable at all. happy-dom's CSS
parser does not implement `@layer` in any form.

Two real consequences, one fixed, one not:

1. **`darkSchemeCssTransform.ts` (WS-10 Phase 1) never round-trips a whole
   stylesheet through this CSSOM** — it validates only tiny isolated
   candidate spans (`@media <prelude> {}`), never the file. This is why it is
   safe against a Tailwind v4 project (which wraps its entire generated CSS
   in `@layer theme, base, components, utilities;`). **Fixed / designed
   around, not a live bug.**

2. **`cssToStyleRules.ts` (`@core/siteImport`) calls `sheet.replaceSync()` on
   the WHOLE input CSS text** — the same happy-dom CSSOM, same limitation.
   Confirmed by direct experiment (same method as above, run against
   `cssToStyleRules` itself, not just the raw CSSOM): a project stylesheet
   containing `@layer base { .hero {...} }` imports ZERO rules for anything
   inside the layer, with **zero warnings** — the parser doesn't know
   anything was dropped, so `parsed-at-rule`/`dropped-at-rule` never fires
   either. This is `studioCss.ts`'s `loadStudioStyles`'s actual engine —
   the same one every Studio-imported project's `.css` goes through at load
   time. **This is a live, un-fixed defect**, not a hypothetical: any
   imported project using Tailwind v4 (default output: everything wrapped in
   `@layer theme, base, components, utilities;`) or hand-rolled `@layer`
   cascade management loses those rules from `site.styleRules` entirely,
   silently, today — independent of and unrelated to WS-10. **Not fixed by
   `canvas-07`** — explicitly out of scope for that task (a real fix needs
   either a CSSOM that supports `@layer`, or a pre-pass that unwraps `@layer`
   blocks before handing text to `replaceSync`, or a warning at minimum).
   Whoever picks this up: reproduce with `cssToStyleRules('@layer base { .x
   { color: red } }')` → `rules` is `[]` with no warning, before designing a
   fix.

---

## Standing authorization (granted 2026-07-31)

**Run the whole plan to completion without stopping to ask.** Where a decision
arises, take the recommended option, record it, and continue. Do not block on
human confirmation. Every work order ends with a subagent-run test pass.

**The acceptance bar changed, and this is the most important line in this file.**
Unit tests in this repo verify *functions*. They structurally cannot verify
*interactions*: happy-dom has no layout engine and no real input pipeline. Three
features shipped "green" and unusable — WS-7 bulk selection (11 passing geometry
tests, unreachable by mouse or keyboard), the WS-8.2 frame fit (passed its own
regression test while blanking frames), and WS-3 (server half tested, nothing to
consume it). **A feature is done when a browser pass drives real input against
`studio-workspace/maherfayad-stack-eSIM` and shows the user-visible result** —
not when a suite is green. A truthful "this does not work" outranks a passing
test.

*(The work-order queue this authorization tracked is closed — every row landed.
It is archived under "Part 4" of
[`docs/state-archive/2026-Q3.md`](docs/state-archive/2026-Q3.md), together with
the three 2026-07/08 wave narratives that used to sit above this section.)*

---

## Archive

Everything older lives in
[`docs/state-archive/2026-Q3.md`](docs/state-archive/2026-Q3.md) — 154 entries,
moved verbatim, plus the wave narratives from July/August 2026. Grep that file by
entry id. Nothing was discarded.

<details>
<summary>Index of archived entries, newest first within each part</summary>

- `2026-09-06` — mcp-19 — visual verification stopped being hostage to the user's open tab
- `2026-09-06` — mcp-18 — the agent learned a page threw only as a blank rectangle in a PNG, and every turn paid frontier price
- `2026-09-06` — canvas-15 — the viewport and keyboard staples: clickable zoom, selection traversal, frame nudge, a visible shortcuts door
- `—` — store-01b — the WS-5.2 defect came back one import away from its own gate: two more full-site walks per keystroke
- `2026-09-06` — panel-10 — the inspector told you an edit could not be saved two seconds AFTER you made it
- `2026-09-06` — style-03 — a cleared declaration reached no code path at all, and every breakpoint override refused
- `2026-09-06` — canvas-14 — the board now draws flows the user never drew, because their code already performs them
- `2026-09-06` — style-02 — a class assignment wrote Studio's own hash into the user's JSX, and a refused write was silently adopted
- `—` — panel-10 — a refusal now shows its reason, its way forward, and where in the source it lives
- `—` — panel-10 — a Tailwind/Sass project imported unstyled and nothing on screen said why
- `2026-09-06` — mcp-17 — the assistant loop paid for its whole context every round, ran its read batch one tool at a time, and captured five screens in five browser round trips
- `—` — server-17 — Studio had no version control at all, so a designer could not ship
- `2026-09-06` — perf-03 — the Layers tree rendered every expanded node and paid 17 store subscriptions per row; it is now flat, windowed, and costs one
- `2026-09-06` — panel-10 — a refusal now shows its reason, its way forward, and where in the source it lives
- `—` — struct-04 — deleting a page only ever deleted it from memory, so the next reload parsed it straight back in
- `—` — agent-12 — Bypass is the assistant's default permission mode
- `—` — mcp-10 — the built-in Figma server is now Figma's REMOTE MCP, not the desktop app's
- `—` — mcp-11 — the in-canvas agent could not resolve a comment, because it had no comment tool
- `—` — struct-03 — "Delete refused: this would leave the TabBar import unused" — it now removes the import instead
- `—` — canvas-12 — `?raw` icons rendered at container width; `base.svg` was substituting its own host
- `—` — comment-01 — Review comments, end to end, including the agent loop
- `—` — perf-02 — Studio's lag was three unrelated bottlenecks, and the biggest one was invisible on every test fixture
- `2026-08-31` — test-01 — ~30 of the suite's 35 failures were one bug in the RUNNER, not thirty bugs in the code
- `2026-08-31` — panel-09 — the styles menu was blind to the project's own CSS, and the panel answered in the browser's vocabulary
- `2026-08-30` — panel-08 — the caption sweep: a control names itself once, and a styles button offers one family
- `2026-08-30` — panel-07 — the properties panel is Figma-shaped now; the label column is gone, and a style can be applied where it is used
- `2026-08-30` — board-10 — every design-system prop got a text box, and `dir` was defaulted onto every component (which defeated board-07)
- `2026-08-30` — board-09 — dark mode worked and still had a white band: the frame's paper was an admin token, and an iframe with no background is transparent
- `2026-08-30` — board-08 — dark mode still rendered fully light: the token extractor flattened the design system's aliases and the copy outranked the original
- `2026-08-30` — board-07 — RTL only reached half of every design-system component, and "light" rendered the vendor palette dark
- `2026-08-30` — board-06 — the heading control worked all along; its own type scale was what made it look broken
- `2026-08-30` — board-05 — the doc card duplicated itself because React owned a node whose children it did not write; sticky notes were a tint of the board, not paper on it
- `2026-08-30` — board-04 — five board/UX asks, and two bugs found under them: the ruler made guides perpendicular to itself, and every project's dark palette was dead CSS
- `2026-08-04` — agent-05 — the harness taught the agent the ONE icon import that cannot render, and nothing ever armed the ruler
- `2026-08-03` — agent-04 — the Studio agent now writes files: 24-minute screens, invented subagents, and emoji-for-icons all had one root cause
- `2026-08-03` — store-02 — a failed boards fetch was indistinguishable from a new project, so a synthesised board autosaved over the real `boards.json`; 56 files deleted in the same incident remain UNEXPLAINED
- `2026-08-03` — mcp-12 — a durable design-reference store, and a pixel diff that can measure a frame against one
- `2026-08-03` — panel-03 — a design reference now uploads losslessly, on a path separate from chat attachments
- `2026-08-04` — agent-05 — the fidelity loop was unreachable, not merely skipped: `studio_compare`
- `2026-08-03` — agent-03 — `design-critic` can now measure instead of guess
- `2026-08-03` — mcp-11 — the live-reload bridge: an MCP write now nudges the open canvas instead of leaving it stale
- `2026-08-03` — server-16 — `GET /admin/api/studio/load` gained a `?pageIds=` filter
- `2026-08-03` — store-04 — closed a second live vector of the boards-autosave overwrite hazard, and added `patchPages`
- `2026-08-03` — store-05 — the `boardFrameSelectionActions` split introduced a real import cycle, reported as pre-existing
- `2026-08-03` — sec-04 — SSRF-hardened `studio_fetch_remote_asset`
- `2026-08-03` — sec-03 — the agent driver handed a subprocess an unrestricted shell at the user's project root, while telling the model on every turn that it had none — CLOSED, one residual unknown
- `2026-08-03` — agent-02 — three defects in the generated roster: a cap that embedded nothing, prompts pointing at files that were not there, and a tool nobody held
- `—` — panel-05 — inspector disclosure wave 2: Layout, Spacing, Size, Appearance, Typography, rotation
- `—` — panel-04 — the inspector's progressive-disclosure pass: wave 1 (four primitives + three orders)
- `2026-08-03` — mcp-09 — the component API the extractor could not find was sitting in 29 Figma Code Connect files
- `2026-08-03` — store-03 — the store-02 fix broke the module-size gate, and two agents misread it as pre-existing
- `2026-08-03` — perf-02 — the subagent roster generator paid a full project probe twice, then rebuilt 17 files every turn regardless
- `2026-08-03` — mcp-08 — the insert palette's full component API was invisible to every agent tool
- `2026-08-02` — agent-01 — the agent re-read the whole design system from raw CSS on every single turn, because every mechanism for handing it that knowledge was keyed on `node_modules`
- `2026-08-02` — server-15 — server-14's Windows fix didn't reach POSIX: a killed `claude` CLI's subagents could wedge a conversation's stream lock forever
- `2026-08-02` — mcp-07 — `.studio/framework.json` (97 KB) made readable, and a third-party MCP bug on Windows
- `2026-08-02` — mcp-06 — Mid-turn message queue, and making 100 KB design docs actually readable
- `2026-08-02` — server-14 — Leaked `claude` subprocesses wedged port 3001 and hung every turn
- `2026-08-02` — mcp-05 — Why the agent burned 53 steps and shipped a non-responsive screen with 2 of 42 components
- `2026-08-01` — mcp-04 — In-chat permission prompts for the Claude CLI, plus `--add-dir` for staged attachments
- `2026-08-01` — server-13 — Add-credential dialog: horizontal-scroll fix + click-to-authorize Claude Code login. Heavy mid-task coordinator correction; read before touching claudeCli.ts, credentials.ts, or ProvidersTab.tsx.
- `2026-09-06` — server-12 — W5-4: preview deploys through the project's own Vercel/Netlify CLI
- `2026-09-06` — perf-03 — five measured hot-path fixes: the `frameId` branch nobody cached, per-frame CSS work that was frame-invariant, a frame memo that stopped one boundary too high, and an autosave that fired mid-word
- `2026-09-06` — docs-01 — `PROJECT-BRIEF.md` re-verified against the shipped tree; 8 of its 10 "does NOT work" items had already landed
- `2026-08-07` — parity-01 — Phase 0 + Band 1/2 of `STUDIO-FIGMA-PARITY-PLAN.md` executed by 13 parallel agents. **Uncommitted, in the working tree, awaiting human review.**
- `2026-08-06` — audit-01 — 12-agent whole-repo audit → `STUDIO-FIGMA-PARITY-PLAN.md`. Two CRITICAL data-loss bugs found. Nothing fixed yet.
- `2026-08-02` — sec-02 — Claude CLI's `--mcp-config` leaked secrets in plaintext via `ps` — now written to a private 0600 temp file
- `2026-08-01` — server-12 — WS-11 + WS-12 arc closed: parity matrix gaps closed, file attachments, reasoning (unverified). Reference entry for cold pickup, not a round log.
- `2026-08-01` — server-11 — Bypass mode implemented (conflict resolved by the coordinator), the parity matrix gate, effort persistence, image attachments
- `2026-08-01` — server-10 — WS-12 steps 3+4: StudioAgentSnapshot, the staleness rule, and session controls — with one flagged, unresolved conflict
- `2026-08-01` — server-09 — WS-12 steps 5+6: the subagent roster and the meta agents
- `2026-08-01` — server-08 — WS-12 steps 1b+2: the real Studio system prompt, studio_create_page/studio_read_file, and settling the AgentPanel attribution
- `2026-08-01` — server-07 — Claude CLI provider, steps 2+3: workspace cwd, widened argv, MCP tool routing (WS-11)
- `2026-08-01` — server-06 — Claude CLI provider, step 1: driver, per-user env, login, probe (WS-11)
- `2026-08-01` — server-05 — Collapse the AI agent "scope" concept to a single Studio agent (WS-12 §8.1 D3)
- `2026-08-01` — canvas-07 — WS-10 Phase 1: preview axes (direction/RTL + dark mode, board-global)
- `2026-08-01` — canvas-08 — WS-10 Phase 2: per-frame axes + "duplicate as variant", and the `(frameId, nodeId)` re-keying it forced
- `2026-08-01` — canvas-09 — WS-10 Phases 3+5: locale probe + board-global switch, MCP axes param; Phase 4 (per-frame locale) scoped but NOT shipped
- `2026-08-01` — canvas-10 — WS-10 Phase 4: per-frame locale, done properly — `(pageId, locale)` as a parallel map, not a `siteDocument.ts` reshape
- `2026-08-01` — canvas-11 — WS-10 Phase 4, finished: the locale-variant SAVE path — editing Arabic text now lands in `translations.js`'s `ar` branch
- `2026-08-01` — parser-10 — WS-13 step 4: canonical scaffolding, auto-placed on the board
- `2026-08-01` — parser-09 — Canonical JSX: the spec, the validator, the fixture (WS-13 steps 1-3)
- `2026-08-01` — struct-02 — a design system now RENDERS, and a component can be added to imported code
- `2026-08-01` — struct-01 — a structural edit now writes the user's `.tsx` or refuses out loud; it never silently vanishes
- `2026-08-01` — lock-01 — a resolved VALUE stopped locking its element: 34.4% -> 15.8% locked, and the notice stopped saying something false
- `2026-07-31` — board-03 — the marquee was never broken; its SPEC was. And the marquee was hit-testing a rect that doesn't exist
- `2026-07-31` — select-01 — Escape stopped working the moment you touched a panel; and the lock census says the locks are mostly honest, with one over-broad class
- `2026-07-31` — panel-02 — CSS write-back reaches disk, and the feature that "existed" was writing nothing at all
- `2026-07-31` — perf-01 — WS-5.3–5.6 measured in a real browser: pan/zoom is already 60fps, and the perf gate could never run
- `2026-07-31` — test-infra-01 — `DbClient.close()`, and the test signal becomes trustworthy
- `2026-07-31` — instance-ui-01 — clicking a component selects the instance, and you can see it
- `2026-07-31` — parser-08 — a conditional inside an expanded `.map` row resolves PER ROW
- `2026-07-31` — parser-07 — a conditional inside JSX renders ONE branch, not all of them
- `2026-07-31` — infra-01 — one token engine, the `--` naming decision, install-job durability
- `2026-07-31` — parser-05 — WS-4 instance model: components as instances, detach, swap
- `2026-07-31` — board-02 — bulk frame selection: marquee, header click, and Escape now actually work; Ctrl+A no longer hostage to focus
- `2026-07-31` — panel-01 — WS-6 Figma inspector: ScrubInput, target chip, align bar, typed prop controls, CSS write-back (partial)
- `2026-07-31` — approot-01 — a project's app root is not always its project directory
- `2026-07-31` — parser-06 — stop stacking every branch of a multi-return component
- `2026-07-31` — pkg-02 — WS-3.3 + WS-3.4: package components actually render
- `2026-07-31` — tokens-01 — auto-import colors/type/spacing into the Framework panel
- `2026-07-31` — mcp-01 — WS-9 studio MCP tools: orientation, bulk edits, codemods, fidelity report, guidelines resource
- `2026-07-31` — canvas-04 — frame fit height, correctly this time: the browser DOES now show the sheet unclipped
- `2026-07-31` — pkg-01 — WS-3.1 + WS-3.2: package components become real modules (manifest + bundling, server-side only)
- `2026-07-31` — board-01 — WS-7: board frame multi-selection + bulk frame/node actions
- `2026-07-31` — asset-01 — WS-8.3 image upload: import-bound `<img src={heroImg}>` is now editable
- `2026-07-31` — meta-06 — `canvas-02`'s fix is REVERTED; the browser said it made things worse
- `2026-07-31` — sec-01 — Tier 1 style compilation moved out of the server process
- `2026-07-31` — test-01 — browser-verify the frame-fit-height fix (`canvas-02`)
- `2026-07-31` — store-01 — WS-5.2: kill the O(pages × nodes) store selectors
- `2026-07-31` — style-01 — WS-2.1 + WS-2.2: compiled styles + CSS Modules through the evaluator
- `2026-07-31` — canvas-02 — fix `collectScrollDeficits` blindness to unrolled content (esim-manual-entry-screen clip)
- `2026-07-31` — meta-05 — audit fix: a shared `layout.tsx` edit left every other route stale
- `2026-07-31` — server-04 — WS-1.3 Next.js App Router support
- `2026-07-31` — meta-04 — M1 wave 1: ingest, probe, install, freeze + unroll
- `2026-07-31` — meta-03 — the five open roadmap decisions are called
- `2026-07-30` — meta-01 — de-fork cleanup, full rename, agent infrastructure
- `2026-07-31` — canvas-03 — WS-2.3: generic vendor package CSS (`ProjectCssInjector`)
- `2026-07-31` — canvas-05 — WS-5.1: selection chrome moves inside the iframe, the props panel stops fleeing at zoom
- `2026-07-31` — canvas-06 — overlay/bottom-sheet render fidelity: found and fixed a real `CanvasScrollUnrollInjector` bug via a real browser, found a second real bug that is NOT mine to fix
- `2026-07-31` — mcp-02 — WS-9.2 visual-audit trio: `studio_export_frames` / `studio_render_reference` / `studio_diff_frames`
- `2026-08-03` — mcp-07 — the agent could create screens but not build them: no intrinsic-tag insert, a dedup that ate sibling inserts, and an optional `dir` defaulting to the WRONG project
- `2026-08-30` — board-11 — the icon picker offered ten chevrons for a 568-icon design system, `dir` was still stamped by the OTHER registration path, and four `dir="ltr"` literals had already been written into the user's source
- `2026-08-30` — mcp-tooling-a2 — studio_compare's node-mapping used the wrong pixel space at dpr!=1, and A2's "region-scoped compare" framing was replaced with a capture-purpose split
- `2026-08-30` — board-12 — a filled slot showed its internal sentinel behind a padlock, the picker rendered at label width, and data binding is gone from the editor
- `2026-08-30` — mcp-10 — cutting model round trips out of the studio verify loop: batched compare/quality-check/fidelity-report, a compare verdict cache, and the bridge retry moved server-side
- `2026-08-30` — mcp-tooling-design-variables — measure against the design's OWN declared values, not just pixels
- `2026-08-30` — board-13 — you could fill an icon slot but never change your mind: there was no replace write in the system
- `2026-08-31` — board-14 — a Content tab: the project's own dictionary as an editable en/ar table
- `2026-08-31` — board-15 — AI translation, and content mapping for a project with no i18n
- `2026-08-31` — board-16 — every project gets English + Arabic
- `2026-08-31` — board-17 — content table, setup without a click, and a translate reply that survives a real model
- `2026-08-31` — board-18 — the translate action never had a prompt
- `2026-08-31` — board-19 — the RTL preview was pinned LTR by a false premise
- `2026-08-31` — board-20 — three bugs behind "reloaded and can't find them"
- `2026-08-31` — board-21 — what a full-suite run caught that the targeted runs did not
- `2026-08-31` — board-22 — property-panel affordances, and the padlocks my own extraction created
- `2026-08-31` — board-23 — the padlocks, lifted at the honest target
- `2026-08-31` — board-24 — pages come in four shapes now, and the first version of them was styled with CSS Studio cannot parse
- `—` — The two traps this work walked into. Both were invisible to every gate.
- `2026-08-31` — board-25 — the sheets had no close button and no content, and both were Studio dropping things on the floor
- `2026-08-31` — board-26 — a 16px spacing floor in the starter every later screen is copied from
- `2026-09-01` — board-28 — live mode draws the device, and stopped lying about the width
- `2026-09-01` — board-29 — "Missing ar (0)" was false: a translation identical to the source counted as done
- `2026-09-01` — board-30 — every design-system component was inserted empty; the seeded content never reached disk
- `2026-09-01` — board-31 — the inserted TabBar had no icons, no way to pick the active tab, and three tabs instead of five
- `2026-09-02` — mcp-12 — Studio performs the Figma OAuth itself; attachments no longer trigger a phantom "register" refusal
- `2026-09-02` — canvas-13 — CSS Modules pages were half-editable on the canvas, and the panel showed hashed build artefacts as class names
- `2026-09-02` — agent-13 — screens are built in parallel again; `Task` is back with a contract instead of a ban
- `2026-09-02` — mcp-13 — CORRECTION to mcp-12: Studio cannot sign in to Figma, and no code change can make it
- `2026-09-02` — mcp-14 — the sign-in badge read the one place a CLI sign-in never lands
- `2026-09-02` — mcp-15 — "open Studio and Figma is running": everything that could be automated, was
- `2026-09-02` — mcp-16 — the sign-in worked and the turns still had no Figma tools: the CLI's own needs-auth cache
- `2026-09-02` — canvas-14 — every agent turn broke the canvas until a manual refresh: the reload applied pages against the PREVIOUS stylesheet

</details>
