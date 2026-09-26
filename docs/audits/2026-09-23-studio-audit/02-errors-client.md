# Audit 02 — Client-side errors, refusals, stuck states and store/disk desync
> **Trust:** historical, dated 2026-09-23. Paths and line numbers were true at `560ddb0e`; re-read the code before acting on a finding. The plan built from it is `ROADMAP.md`.

Auditor: store-engineer (read-only) · 2026-09-23 · branch `fix/studio-load-memo-cold-on-every-load`
Scope: `src/admin/pages/site/**`, `src/core/page-tree`, `src/core/studio-*`, plus the editor-shell
seams that wrap them (`AdminCanvasLayout`, `LazyChunkBoundary`, `main.tsx`, `ScrubInput`).

Owner's bar: canvas used freely, zero visible errors, one gesture = one write = one toast, and
where a refusal is unavoidable the editor does the sensible thing itself.

## How findings were verified

- **CONFIRMED (probe)**: I reproduced it with a throwaway `bun test` file in the scratchpad that imports
  the real modules by absolute path. No repo file was touched. The probes are in this folder:
  `scrubUndoProbe.test.tsx`, `crossFrameUndoProbe.test.ts`, `selectionRepointProbe.test.ts`,
  `concurrentCommitProbe.test.ts`.
- **CONFIRMED (read)**: the code path is unambiguous, or an existing repo test pins the behaviour.
- **SUSPECTED**: plausible from the code, but I did not reproduce it.

---

## 1. Findings

Severity: **P0** means a user hits an error or a broken state in normal use. **P1** is an edge
case that users will still meet. **P2** is minor.

### Top findings (P0)

#### ERR-1 — A focused inspector number field re-applies stale values when the user clicks away (it undoes the undo)
- **P0 · CONFIRMED (probe)** — `scrubUndoProbe.test.tsx`: the field is focused at `24px`, an external change sets the value to `10px`, the field still shows `24px`, and blur calls `onChange('24px')`.
- **Where:** `src/ui/components/ScrubInput/ScrubInput.tsx:209-213` syncs the external value only when `!isEditing`. Lines 243-253 make blur commit `e.target.value`. Lines 254-263 make Enter commit but leave `isEditing` true, so the field stays in edit mode after Enter.
- **Trigger:** The user types a width, presses Enter (focus stays, per Figma), presses ⌘Z (allowed, because `pendingTextEdit` counts no draft as pending), then clicks the canvas. The undone value is written back, and the redo stack is cleared. The same thing happens for any external change while the caret sits in a field: an agent edit, a resync, or a multi-select change. The field overwrites it on blur. `pendingTextEdit.ts` says this "parked caret" state is "most of the time".
- **Magic fix:** Track a `userTyped` bit. Set it on input change or nudge, and clear it on commit and on sync. While `!userTyped`, keep the draft in step with `display` even when focused. On blur, commit only if `userTyped`. `TokenAwareInput` avoids the bug by ending the edit session on Enter (`TokenAwareInput.tsx:266-300`).
- **Effort:** S · **Owner:** panel-designer · **Plan coverage:** none. W8-1 ("Enter keeps focus", #47) introduced it. STATE `RC1` fixed the sibling bug in `TokenAwareInput` only.

#### ERR-2 — After deleting an element, ⌘Z can never get past that delete
- **P0 · CONFIRMED (read)** — `src/__tests__/editor-store/structuralMoveUndo.test.ts:282-300` asserts that `_historyPast.length` is unchanged after `undo()`.
- **Where:** `store/slices/site/undoRedoActions.ts:50-53` returns early without moving the entry. `structuralHistory.ts:114-128` shows a persistent warning toast. `deleteNodesAction.ts:109` tags the entry.
- **Trigger:** Delete any element on a source-backed board, then press ⌘Z. The user sees "Undo can't restore this yet". Every later ⌘Z hits the same entry, so every edit made before the delete can no longer be undone from the keyboard.
- **Magic fix:** Make delete genuinely undoable. The server already reads the verbatim element text (`jsxChildRange.ts` `verbatimSourceText`) and `transplantJsxElement` already inserts verbatim markup at a parent and anchor. The fix has three parts:
  - Return `deletedSources[{text, parentNodeId, anchorNodeId, position, imports}]` from the save.
  - Record the delete as a `source` gesture whose inverse is a new `restore` edit.
  - Stop-gap (S, ship first): on the refusal, move the entry to a "skipped" state and continue to the next one, so the stack never jams.
- **Effort:** M · **Owner:** store-engineer + parser-surgeon · **Plan coverage:** none. `docs/reference/editor-history.md:322,432` calls this deliberate.

#### ERR-3 — Undo and redo of a structural edit fail as soon as the user clicks into another frame
- **P0 · CONFIRMED (probe)** — `crossFrameUndoProbe.test.ts`: move an element in page A, activate page B, run `undo()`. The history length is unchanged and the element is still moved.
- **Where:**
  - `structuralHistory.ts:84-95`: `reissueStructuralMove` resolves `resolveActiveTreeTarget` and shows "Nothing to undo here".
  - `structuralSourceHistory.ts:128-164`: for duplicate, wrap, group, ungroup, paste, transplant and image drop, `unresolvedNodeIds` checks the active page and opens a modal `RefusalDialog`. The modal says "`a.tsx` has changed since … check what changed in that file". That is false: the ids were checked against the wrong page.
- **Trigger:** On a multi-frame board, pressing on any frame activates its page (`openPageInCanvas` in `onPointerDownCapture`). So "drag in frame A, click frame B, ⌘Z" is the normal flow. The entry also stays on the stack, so undo is blocked until the user goes back to frame A.
- **Magic fix:** Resolve each id's owning page through `_nodeIdToPageIds` (O(1)) and re-issue against that page. That needs page-targeted `moveNodes`, or a silent activation of the owning page, which Figma also does. Check `unresolvedNodeIds` against the union of owning pages, not the active tree.
- **Effort:** S · **Owner:** store-engineer · **Plan coverage:** none.

#### ERR-4 — A move or delete made while another write is still in flight can hit the WRONG element in the user's `.tsx`
- **P0 · CONFIRMED (probe)** — `concurrentCommitProbe.test.ts`: while a move POST was still on the wire (100 ms delay), `deleteNodes(['a.tsx:5:5'])` posted a second `/save` straight away, using ids from before the move. After the move lands, `a.tsx:5:5` is the element that was moved, not the one the user deleted.
- **Where:**
  - `nodeActions.ts:450-510` (`moveNodes`) and `deleteNodesAction.ts:51-110` never call `deferWhileStructuralCommitInFlight`. Every other structural writer does (`studioSourceWrites.ts:146,271,336,411,478,540`, `transplantActions.ts:85`, `imageDropActions.ts:48`).
  - `commitStructural` (`studioStructuralCommits.ts:568-580`) sets the in-flight flag but does not queue behind it.
  - The codemods do not check that the element at `line:col` is the one intended (`deleteJsxElement.ts:66-90`; `stale-source` only compares the ts-morph cache against disk).
- **Trigger:** Drag or reorder an element, then within one round-trip press Delete on a sibling below it. Also: undo a move (it re-issues `moveNodes`) while a duplicate is still writing, or delete twice in quick succession.
- **Magic fix:** Two parts.
  - Route `moveNodes`, `deleteNode(s)` and `undo`'s move re-issue through the commit queue. The queue already re-plans against the resynced tree.
  - Add an identity guard to every structural edit: the tag name plus a hash of the opening tag's verbatim text, recorded at plan time. The server then refuses, or re-locates within ±N lines, instead of editing whatever now sits at `line:col`.
- **Effort:** M · **Owner:** store-engineer (queue) + parser-surgeon (fingerprint) · **Plan coverage:** partial. `store-14` queued the insert family only. Move and delete were never in it.

#### ERR-5 — After a resync, the selection can point at a different element (inspector edits, Delete and nudge then act on it)
- **P0 · CONFIRMED (probe)** — `selectionRepointProbe.test.ts`: select `a.tsx:4:5` ("Body"). An agent write inserts a line above it, and `patchPages` runs. The selection is still `a.tsx:4:5`, which is now "NEW BANNER". After a full `loadSite`, `selectedNodeIds` still holds an id that no longer exists.
- **Where:**
  - `lifecycleActions.ts:390-411`: selection is filtered by existence only. `buildReparseNodeIdRemap` is computed at lines 304-307, but only for history, and only when history is non-empty.
  - `loadSite` (`lifecycleActions.ts:86-190`) never touches `selectedNodeIds`, `activeInlineEdit`, `hoveredNodeId` or `enteredInstanceIds`.
  - `docs/agent-refs/editor-store.md` says a shifted id "simply isn't a key … and the selection drops cleanly". That is untrue when line numbers permute.
- **Trigger:** An agent edits the open file, a save returns `shifted` or `sharedComponents`, or a structural write lands above the selection. The ring jumps to another element. The next inspector keystroke, Delete, or ⌘D targets it, and the write goes to disk.
- **Magic fix:** On both reload paths, always compute the remap for the touched pages (O(nodes of those pages)). Map `selectedNodeIds`, `selectedNodeId`, `selectedNodeFrameId`, `activeInlineEdit`, `hoveredNodeId`, `enteredInstanceIds` and the drag session through it. When the remap is empty or strict matching fails, keep an id only if `moduleId`, tag and a label/text/props fingerprint still match. Otherwise drop it.
- **Effort:** S-M · **Owner:** store-engineer · **Plan coverage:** none.

#### ERR-6 — A refused or failed move or delete leaves the canvas out of step with disk, and the error toast stays
- **P0 · CONFIRMED (read)** — the code documents it as a "KNOWN LIMITATION" at `studioStructuralCommits.ts:535-545`.
- **Where:**
  - `commitStructuralBody` rolls back only the optimistic insert, duplicate, wrap and group (`:612, :669-680`). A move or delete has already mutated the tree through `mutateActiveTree`.
  - `commitStructuralBody` catch (`:665-680`) shows "Move refused" or "Delete refused" with the fetch error.
  - The history entry stays tagged `move` (`nodeActions.ts:478-487`), so a later ⌘Z issues a real move on disk to undo a move that never happened.
- **Trigger:** The dev server restarts mid-drag (`dev-04`), the save route is briefly unavailable, or the server refuses at AST level (`has-behaviour`, `out-of-scope`). The board shows a layout the file does not have until some unrelated reload.
- **Magic fix:**
  - Give move and delete the same `OptimisticPreviewHandle` contract: roll back by applying the entry's inverse patches and popping the entry.
  - On a network failure, retry automatically with backoff (the save ladder already does this) before rolling back.
  - A genuine refusal rolls back and shows exactly one toast.
- **Effort:** M · **Owner:** store-engineer · **Plan coverage:** only the E3 follow-up named in the code comment. No open plan owns it.

#### ERR-7 — Multi-select drag, Alt-drag, paste, wrap and multi-file drop all refuse
- **P0 · CONFIRMED (read)**
- **Where:**
  - `sourceStructure.ts:204-215`: multi reorder, reparent and wrap.
  - `structuralSourceEdits.ts:275-289`: multi Alt-drag duplicate.
  - `sourceStructureTransplant.ts` (~`:112`): multi cross-frame drop.
  - `canvasFileDrop.ts:115-121`: "One image at a time".
  - Paste of multiple roots goes through `planSourceDuplicateTo`, which refuses as multi-select.
- **Trigger:** Select three cards and drag them (the most common Figma gesture). Also ⌘C two layers then ⌘V, or drop four images.
- **Magic fix:** Expand an N-node gesture into a chained sequence through `structuralCommitQueue`. Each step re-plans after the previous resync and is anchored `after` the element the previous step placed. Record all steps as one history entry with a composite inverse. Wrap on a multi-selection routes to `groupNodes` when the nodes are adjacent siblings (ERR-16 covers the case where they are not).
- **Effort:** M · **Owner:** store-engineer · **Plan coverage:** none. `FEEL-PLAN:391` accepted the refusal.

#### ERR-8 — Copy on one frame, paste on another (or paste after anything shifted the lines) refuses
- **P0 · CONFIRMED (read)** — `studioSourceWrites.ts:556-573`: "What you copied is not part of this page's code any more … Copy the element again from this page".
- **Trigger:** ⌘C in frame A, click frame B, ⌘V. Or ⌘C, then any edit above the copied element, then ⌘V.
- **Magic fix:** At copy time, capture the verbatim JSX slice and the imports it needs (a server read, reusing the `transplant` machinery). Paste writes that text into the destination container. The transplant codemod already handles the cross-file import work, so cross-page paste is `transplant(copy:true)` with a text source instead of an id.
- **Effort:** M · **Owner:** store-engineer + parser-surgeon · **Plan coverage:** none.

### P1

#### ERR-9 — Edits typed during a structural write, a `shifted` save or an agent write are thrown away, and the toast blames an agent
- **P1 · CONFIRMED (read)**
- **Where:**
  - `lifecycleActions.ts:260-273` marks the page "overwritten", and lines 431-440 show "Local edits overwritten … by a change an agent just wrote". The narrow resync after the user's own save or structural commit takes the same path.
  - The full `loadSite` path discards silently (`:136-178` sets `hasUnsavedChanges=false`).
- **Trigger:** Type in the inspector during the ~0.3–2 s between a drag or ⌘D and its resync, or during a save that answers `shifted`. An inline text edit open while an agent writes the same file loses its keystrokes too.
- **Magic fix:** Rebase instead of overwrite. Remap ids old→new with `buildReparseNodeIdRemap`, which suits value-only edits because the structure is isomorphic. Replay the site patches recorded since the dirty snapshot onto the fresh page, keep the page dirty, and let autosave write them. Show no toast when the rebase succeeds. When it cannot, the copy should name the real cause.
- **Effort:** M · **Owner:** store-engineer

#### ERR-10 — When the resync falls back to a full reload, queued gestures plan against a stale tree, and reloads can land out of order
- **P1 · CONFIRMED (read)**
- **Where:**
  - `studioBoardResync.ts:139-157` → `requestCmsSiteReload()` only dispatches an event (`adminEvents.ts:35-40`). So `await resyncBoardAfterWrite` returns before `loadSite` runs, `endStructuralCommit` drains the queue (`structuralCommitQueue.ts:113-118`), and the next gesture plans against the pre-write ids.
  - `usePersistence.ts:476-500` `reload()` has no monotonic token, so two reload events can resolve out of order.
  - `pendingStructuralOutcome` is a single slot, so the next commit can overwrite the previous commit's selection and undo entry before it is claimed.
- **Trigger:** A cold parse cache, a layout or shared-file write, or any `reload-scope` failure, followed by a quick second gesture.
- **Magic fix:** Make the full reload awaitable: `requestCmsSiteReload()` returns a promise that resolves after `loadSite` and `applyStructuralWriteOutcome`. Add a sequence token to `reload()` and drop superseded responses.
- **Effort:** S-M · **Owner:** store-engineer

#### ERR-11 — Held-key states stick after the window loses focus (Space-pan leaves every frame unclickable)
- **P1 · CONFIRMED (read)**
- **Where:** `hooks/useCanvas.ts:357-384` and `canvas/useIframeEventForwarding.ts:246-270` set the pan flags on keydown and clear them only on keyup. `IframeFrameSurface.module.css:50-54` sets `pointer-events:none` on every frame while the flag is set. There is no `blur` or `visibilitychange` handler.
- **Trigger:** Hold Space to pan, then Alt+Tab or click devtools. After returning, clicks pan instead of selecting until Space is pressed again. The same risk applies to Alt-measure and the hand-tool latches.
- **Magic fix:** One `window` `blur` and `visibilitychange` listener that clears every pan flag and modifier latch and cancels any live drag session.
- **Effort:** S · **Owner:** canvas-engineer

#### ERR-12 — Guide drags can get stuck, and no drag recovers from a lost pointer-up
- **P1 · CONFIRMED (read)**
- **Where:**
  - `RulerGuidesLayer.tsx:48-91` (guide move) and `CanvasRulers/useRulerGuideCreation.ts:52-96` (guide create) listen on `document` with no `setPointerCapture` and no `markCanvasPointerRelay`. The move handler also has no `pointercancel`.
  - Frames are iframes, so releasing over a frame never reaches the parent `document`. The guide or its preview keeps following the cursor.
  - No drag checks `e.buttons === 0` on pointermove, and none cancels on window blur. That includes `useCanvasReorderDrag`, `useElementResizeDrag`, `usePrototypeLinkPick` and marquee.
- **Magic fix:**
  - A shared drag-session guard: pointermove with the primary button up finishes the drag at the last point, and window blur cancels it.
  - Guide drags use pointer capture plus the iframe relay, like reorder does.
- **Effort:** S · **Owner:** canvas-engineer

#### ERR-13 — A crash in editor chrome replaces the whole body with "Editor chunk failed to load", or blanks the entire editor
- **P1 · CONFIRMED (read)**
- **Where:**
  - `lib/LazyChunkBoundary.tsx:42-55` renders "Editor chunk failed to load" for any error, including ordinary render errors.
  - It wraps the entire body (`AdminCanvasLayout.tsx:251-263`). Everything outside a narrower boundary falls back to it: `CanvasRulers`, `CanvasLayerContextMenu`, `LazyStudioCanvasChrome`, `CanvasContextSelector`, `CodeEditorPanel`, `LayoutNameDialog`, `ImportHtmlModal` and the sidebar rail.
  - `Toolbar` (`AdminCanvasLayout.tsx:227`) and `RefusalDialog` (`SitePage.tsx:86`) sit outside it and fall to `admin-route` (`router.tsx:41`), which takes out the whole editor.
  - The canvas boundary (`CanvasRoot.tsx:557`) replaces the entire board and resets only when the page, document or view changes.
- **Magic fix:**
  - Give each chrome seam its own silent boundary with a `null` fallback, logged, which resets on the next store change.
  - Show "chunk failed" only for `ChunkLoadError` or a dynamic-import failure.
  - The canvas boundary retries automatically once before showing its fallback.
  - Extend `error-boundary-coverage.test.ts`.
- **Effort:** S-M · **Owner:** canvas-engineer + panel-designer · **Plan coverage:** partial. `panel-40` fixed panels and sections only (STATE lines ~4155, ~6700).

#### ERR-14 — Choosing a stylesheet pops up as a modal about 2 s after the first keystroke on a new class
- **P1 · CONFIRMED (read)** — `studio/refusalToasts.ts:146-180` (`presentCssDestinationRefusals` → `RefusalDialog`). Autosave triggers it, so it appears while the user is still typing.
- **Magic fix:** Choose automatically, in this order: the stylesheet the element's own file already imports, then the one written most recently this session, then the one with the most rules for the element's siblings. Remember the choice per project in `.studio/`, and show a small "→ `styles.css` · change" affordance on the class chip. Never open a modal for this.
- **Effort:** S-M · **Owner:** store-engineer + panel-designer · **Plan coverage:** Z8 covers the `no-editable-stylesheet` half only.

#### ERR-15 — Edits are accepted and rendered, then dropped at save time with a "won't be saved / will revert" toast
- **P1 · CONFIRMED (read)**
- **Where:**
  - `panels/inlineStyleUnsavedNotice.ts:67-89`: inline style on a `pkg.*` or `studio.instance` node.
  - `panels/classAssignmentUnsavedNotice.ts:46-69`: class change on a `.map` row or synthetic root.
  - `panels/unexplainedSkipsNotice.ts:92-130`: a red "Some changes were not saved to source".
  - `refusalToasts.ts:191-197`: `no-editable-stylesheet`.
- **Trigger:** The user edits normally. Two seconds later a warning appears, and the value reverts on the next reload.
- **Magic fix:** Never show an edit the editor cannot keep.
  - Inline style on an instance or package component whose props forward `className`: auto-assign a generated class and write the rule to the co-located stylesheet.
  - Class on a `.map` row: apply it to the row template and say "Applied to all N rows · Undo". This is still one honest target: one JSX site.
  - Otherwise, disable the control with a reason up front (`isPropWritableToSource` is already the rule).
  - `no-editable-stylesheet`: create `src/studio.css` plus an import at the app entry.
- **Effort:** M · **Owner:** panel-designer + parser-surgeon

#### ERR-16 — Group, reparent and transplant refusals that have a mechanical fix
- **P1 · CONFIRMED (read)**
- **Where:**
  - `sourceStructurePreview.ts:406-416,463-470`: `NOT_A_RUN`, siblings that are not adjacent.
  - `:392-402`: grouping the outermost returned element.
  - `sourceStructure.ts:260-313`: `cross-file` reparent and `no-sibling-anchor` reorder.
  - `sourceStructureTransplant.ts` (~`:170-180`): "These two frames are two views of the same file … Drag it inside one frame".
- **Magic fix:**
  - Non-adjacent group: move the members together first, then group, as one gesture and one undo.
  - Outermost element: wrap the returned root. That is a legitimate single write.
  - Cross-file reparent: route to `transplant`, which already handles imports and scope.
  - Same-file frames: just perform the ordinary move.
  - `no-sibling-anchor`: try the other neighbour, then the parent-append form.
- **Effort:** M · **Owner:** store-engineer + parser-surgeon

#### ERR-17 — Localized text typed while a save is in flight is marked saved but never sent
- **P1 · CONFIRMED (read)** — `studio/fsCodemodAdapter.ts:669-671` commits the baseline from `useEditorStore.getState().localizedPages` (the current state), not from the snapshot that was sent (`localizedEdits`, `:556`).
- **Magic fix:** Commit the baseline from the collected edits.
- **Effort:** S · **Owner:** store-engineer

#### ERR-18 — A project that fails to load has no retry, and a failed background reload is silent
- **P1 · CONFIRMED (read)**
- **Where:** `AdminCanvasEditorBody.tsx` `SiteEditorLoadError` shows the heading and message only. `usePersistence.ts:501-503` only logs to the console when a reload fails.
- **Trigger:** The server restarts during open, or a network blip.
- **Magic fix:** Retry automatically with backoff (2/4/8 s), add a Retry button, and mark a stale board quietly in the save chip.
- **Effort:** S · **Owner:** store-engineer

#### ERR-19 — Edits made outside Studio (VS Code, `git pull`) are never noticed
- **P1 · SUSPECTED** — the client's only reload triggers are its own writes and the agent push (`agent/studioLiveReload.ts`). I found no file watcher.
- **Impact:** The board goes stale, and the next gesture posts stale `line:col` ids, which compounds ERR-4.
- **Magic fix:** A server-side watcher on the open project that sends the existing `studio_live_reload` push, debounced and ignoring Studio's own writes.
- **Effort:** M · **Owner:** server-engineer

### P2

| id | What happens | Where | Magic fix | Effort · owner |
|---|---|---|---|---|
| ERR-20 | Store actions throw on a stale id (`updateNodeProps`, `updateInstanceCallSiteProp`, `setBreakpointOverride`, `renameNode`, `setNodeInlineStyles`). `runHistoricMutation` has no try/catch, so an exception escapes in the handler and the edit is lost silently | `nodeActions.ts:352,377,408,431`, `inlineStyleActions.ts:69`, `helpers.ts:171-231` | Return `false` (no-op), as the bulk variants already do | S · store-engineer |
| ERR-21 | `isTextInputTarget` treats every `<input>` as typing. The `Select` trigger (a readOnly input), range inputs and checkboxes then swallow Delete, ⌘D and arrow-nudge until the user clicks the canvas. SUSPECTED impact | `canvas/editorKeyGuards.ts:28-35`, `ui/components/Select/Select.tsx:377-397` | Match only text-entry types that are not readOnly | S · canvas-engineer |
| ERR-22 | Delete on a pending optimistic preview shows "Still writing your last change" | `structuralOptimism.ts:143-155` | Queue it and retarget it at `createdNodeIds` | S · store-engineer |
| ERR-23 | A drag whose target went stale mid-gesture silently does nothing (console.warn only) | `useCanvasReorderDrag.ts:323-327` | Remap the session ids through the `patchPages` remap (see ERR-5) | S · canvas-engineer |
| ERR-24 | Copy as PNG shows a red *error* for a no-op: several frames selected, a VC open, or no screen | `useCopyAsPngShortcut.ts:97-100`, `copyAsPngTarget.ts:70-102` | Copy the union bounds or the anchor frame. Use silence or `info` for the no-op | S · canvas-engineer |
| ERR-25 | Holding ⌘D past 20 queued writes shows "Too many changes at once" | `structuralCommitQueue.ts:123-135` | Ignore `e.repeat` above the ceiling without a toast | S · store-engineer |
| ERR-26 | The editor window has no `unhandledrejection` or `error` sink (frames have one), so async failures are invisible to diagnostics | `main.tsx` (only React root callbacks) | One window listener that logs and feeds the diagnostics buffer, with no toast | S · canvas-engineer |
| ERR-27 | Section `PanelBoundary` never resets by itself (a deliberate choice) | `StyleSurface.tsx:196-208` | Retry once automatically on the next selection change | S · panel-designer |
| ERR-28 | Undo of a `source` gesture after an agent edit to the same file opens a modal that blocks the stack | `structuralSourceHistory.ts:152-161`, `:214-230` | Skip past the entry with a one-line notice; reserve the modal for the first occurrence | S · store-engineer |
| ERR-29 | Several refusal sentences tell the user to "Reload the project and try again" | `sourceStructureTransplant.ts` (~`:100`), `canvasFileDrop.ts:151-154`, `deleteJsxElement.ts:77-82` | Reload automatically and retry once (resyncs are cheap now) | S · store-engineer |
| ERR-30 | Undo of a move made on another page/VC shows the misleading "Nothing to undo here — Open it again" | `structuralHistory.ts:88-95` | Fixed by ERR-3 | — |

---

## 2. Inventory — every user-visible error, warning or refusal in scope

Dispositions:
- **KEEP**: the copy and surface are right.
- **AUTO**: auto-resolve (the editor should do it).
- **RETRY**: auto-retry with backoff before saying anything.
- **SILENT**: downgrade to no toast (log or chip only).
- **REWORD**: keep, but fix the copy.
- **GATE**: prevent it at input instead of refusing after the fact.

Paths are relative to `src/admin/pages/site/` unless shown otherwise. The `pushToast` count is about 158 sites in 66 files, plus modal refusals.

### 2a. Canvas gestures and structural writes (the "use it freely" surface)

| Message (title) | Kind / surface | Site | Trigger | Disposition |
|---|---|---|---|---|
| Move refused / Delete refused / Duplicate refused / Wrap refused / Group refused / Ungroup refused / Cannot add this to imported code / Cannot move this between frames (remedy-less reasons) | warning, persistent, deduped | `store/slices/site/structuralSourceEdits.ts:629` (`presentStructuralRefusal`) | reasons `multi-select`, `reparent`, `insert`, `duplicate`, `wrap`, `no-sibling-anchor`, `group`, `content-model` | **AUTO** for `multi-select` (ERR-7), `no-sibling-anchor`, `cross-file` and non-adjacent `group` (ERR-16). **KEEP** `content-model` (it already picks span vs div). **REWORD** the rest |
| (same titles) with remedies: shared-component / list-row / route-chrome / code-placed / cross-file | **modal** `RefusalDialog` | `structuralSourceEdits.ts:614-627` | dragging or deleting inside a component, `.map` row or layout | **KEEP** as a choice. Add **AUTO** for a `list-row` over a literal local array (reorder, delete or duplicate the array item). Pre-select the likely remedy |
| Move refused / Delete refused / etc. (server refusal) | error | `studio/studioStructuralCommits.ts:595` | AST-level decline (`has-behaviour`, `out-of-scope`, `stale-source`) | **KEEP** one toast, but **roll back** the optimistic tree (ERR-6) |
| "The code no longer has an element at the position the canvas was showing" | error | `studioStructuralCommits.ts:612-621` | stale id | **AUTO**: resync, re-plan once, then **SILENT** if the retry lands (ERR-4, ERR-29) |
| `<gesture>` failed (network/exception) | error | `studioStructuralCommits.ts:665-672` | server restart, fetch failure | **RETRY** then roll back (ERR-6) |
| Undo can't restore this yet | warning, persistent | `store/slices/site/structuralHistory.ts:115` | ⌘Z after delete | **AUTO** (ERR-2) |
| Nothing to undo here | warning | `structuralHistory.ts:89` | ⌘Z after switching frame | **AUTO** (ERR-3) |
| Undo/redo refused "`X.tsx` has changed since …" | **modal** | `store/slices/site/structuralSourceHistory.ts:152-161` | ⌘Z after switching frame (false) or after an agent write | **AUTO** (ERR-3). **SILENT**-skip on a real conflict (ERR-28) |
| Still writing your last change | warning | `structuralOptimism.ts:147` | Delete on a pending preview | **AUTO** queue (ERR-22) |
| Too many changes at once | warning | `studio/structuralCommitQueue.ts:126` | held ⌘D | **SILENT** (ERR-25) |
| Paste: "What you copied is not part of this page's code any more…" | warning (via refusal) | `store/slices/site/studioSourceWrites.ts:556-573` | cross-frame paste, or paste after a shift | **AUTO** (ERR-8) |
| Drop an image: not-an-image / multiple-files / no-frame / frame gone / no-position | warning | `canvas/useCanvasFileDrop.ts:174` (`canvasFileDrop.ts:108-160`) | OS file drop | multiple → **AUTO** queue. no-position → **AUTO** climb to the nearest container. no-frame → **AUTO** add to project assets and show a quiet "Added to Assets". frame gone → **AUTO** reload and retry. not-an-image → **KEEP** |
| Drop an image: upload failed | error | `useCanvasFileDrop.ts:223` | upload failure | **RETRY** once, then KEEP |
| Nothing to copy as PNG | error | `canvas/useCopyAsPngShortcut.ts:99` | ⌘⇧C with several frames selected or a VC open | **AUTO**, or **SILENT** / `info` (ERR-24) |
| Copy as PNG failed | error | `useCopyAsPngShortcut.ts:114` | clipboard or capture failure | KEEP |
| This text is set in code | info | `store/slices/inlineEditSlice.ts:156` | double-click on code-valued text | **AUTO** where possible: when the text is a call-site prop in the same file, edit it through `updateInstanceCallSiteProp`. Otherwise KEEP (the one sanctioned announcement) |
| Only one content outlet | warning | `store/slices/site/nodeActions.ts:109`, `slices/clipboardSlice.ts:263`, `slices/layoutsSlice.ts:157` | CMS/VC only | KEEP (unreachable on a Studio board) |
| Circular component reference | warning | `slices/layoutsSlice.ts:187` | CMS/VC | KEEP |
| Could not open source | error | `store/openSourceFile.ts:41` | jump-to-source failure | KEEP |
| Could not create page / Could not delete page | error | `canvas/BoardFramesLayer/AddPagePicker.tsx:155`, `store/slices/site/pageActions.ts:53` | server failure | **RETRY** once, then KEEP |
| Could not link this element / Could not create the link / failure title for link update/delete / Failed to load prototype links | error | `studio/prototypeActions.ts:44,60,114,168` | server failure | **RETRY**. Load failure → **SILENT** (a chip or empty state) |
| Nowhere to go back to / Nothing to close | info | `studio/playNavigation.ts:72` | Play mode back/close with no history | **SILENT** (Figma ignores these) |
| Inserted / Placed `<item>` | success | `hooks/useInsertInserterItem.ts:57`, `studioStructuralCommits.ts:598` | insert | **SILENT**: the new selected element is the feedback. At least collapse to one toast per gesture (the "one gesture = one toast" bar) |

### 2b. Save and writeback notices (autosave loop)

| Message | Kind | Site | Disposition |
|---|---|---|---|
| Style not saved to source (`no-editable-stylesheet`) | error | `studio/refusalToasts.ts:191` | **AUTO**: create a stylesheet (ERR-15) |
| Which stylesheet should this class live in? | **modal** | `refusalToasts.ts:146-180` | **AUTO** choose (ERR-14) |
| Detach / Swap / Style / Class change / Inline style not saved to source (server refusals, deduped once per session) | warning/error | `refusalToasts.ts:84` (`toastOnce`) | KEEP for detach and swap. For css/class/style, **GATE** in the panel (ERR-15) |
| Style change won't be saved | warning | `panels/inlineStyleUnsavedNotice.ts:74` | **AUTO**, or GATE (ERR-15) |
| Class change won't be saved | warning | `panels/classAssignmentUnsavedNotice.ts:54` | **AUTO** apply to the row template, or GATE (ERR-15) |
| Some changes were not saved to source | error | `panels/unexplainedSkipsNotice.ts:113` | **GATE** at input. Any residue → REWORD as a warning |
| Stylesheet created | success | `studio/studioSaveRequests.ts:165` | **SILENT**, or `info` once per project |
| Image was not saved to source | error | `studioSaveRequests.ts:214` | **AUTO**: resync and retry once |
| Local edits overwritten | warning | `store/slices/site/lifecycleActions.ts:432` | **AUTO** rebase (ERR-9). REWORD the attribution |
| Failed to load boards / Failed to save boards / Boards not saved | error/warning | `src/admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx:370,441,473` | load and save → **RETRY**, then show in the chip (**SILENT**). The guard refusal → **AUTO**: re-read `boards.json`, merge, retry |
| Save failed (⌘K) | error | `src/admin/spotlight/commands/editor.ts:54` | **SILENT**: the chip already owns save failure (Z6) |
| Save chip `error`/`retrying` | chip | `toolbar/SaveStatusChip.tsx` | KEEP. Add retry-on-next-edit after the ladder runs out |

### 2c. Inspector and property controls

| Message | Site | Disposition |
|---|---|---|
| Detach failed / Duplicate failed / Swap refused / Swap failed | `inspector/sections/ComponentSection.tsx:154,165,175,205,219` | KEEP (explicit gestures), with RETRY on network errors |
| Detach refused / Duplicate refused (instance codemods) | `store/constraintActions.ts:239,250` | KEEP |
| Copy as PNG / Copy CSS / Copy JSX failed, `<fmt>` export failed, Nothing to copy | `inspector/sections/ExportSection.tsx:197,204,221,231,245` | KEEP. "Nothing to copy" → SILENT (disable the button instead) |
| Not an image / Image upload failed | `panels/PropertiesPanel/ImageSourceSection.tsx:81,109`, `ImageSourcePicker.tsx:72` | KEEP, with RETRY on upload |
| Failed to save frame default | `panels/PropertiesPanel/FrameBulkInspector.tsx:119` | RETRY |
| `<verb>` refused / failed (slots) | `property-controls/SlotControl.tsx:107,112` | KEEP |
| Cannot use `<icon>` / SVG too large / Cannot use `<file>` / Could not read that file | `property-controls/SlotPicker.tsx:98,107,117,122` | KEEP |
| Could not copy `<label>` | `panels/InspectPanel/InspectPanel.tsx:33,40` | KEEP |
| Could not pick a colour | `src/ui/components/ColorPickerPopover/ColorPickerPopover.tsx:411` | SILENT (the EyeDropper was cancelled or is unsupported) |
| Font still in use / Could not delete font files | `panels/TypographyPanel/FontsSection/FontsSection.tsx:97,109` | "still in use" → turn into a confirm with a replace-font choice. Delete failure → KEEP |

### 2d. Board chrome, trust and live

| Message | Site | Disposition |
|---|---|---|
| Could not put this project back to static | `canvas/LiveAutoPromoteNotice/LiveAutoPromoteNotice.tsx:108` | RETRY, then KEEP |
| `failureTitle` (tier change) | `canvas/LiveRuntimePill.tsx:120` | RETRY, then KEEP |
| Could not promote project | `canvas/PackageComponentPlaceholder.tsx:65`, `panels/AssetsPanel/PackageBundleNotice.tsx:62` | KEEP |
| Could not run this project's compiler / Could not save that choice | `canvas/StyleCompileConsentBanner/StyleCompileConsentBanner.tsx:91,107` | KEEP |
| Design system moved / Could not move the design system | `canvas/DesignSystemMigrateBanner/DesignSystemMigrateBanner.tsx:76,86` | KEEP |
| Could not rename project | `toolbar/Toolbar.tsx:109` | KEEP |
| Failed to download code | `toolbar/DownloadCodeButton.tsx:27` | KEEP |
| Share: could not load, copy, update, share or revoke | `toolbar/ShareDialog.tsx:49,66,86,103` | load → SILENT (show inside the dialog). Others → KEEP |
| Render failed in admin-shell | `src/ui/components/ErrorBoundary/ErrorBoundary.tsx:154` (only `silentToast={false}`) | KEEP (nothing else is left on screen), but fix the seams (ERR-13) |
| Unhandled render error | `src/admin/main.tsx:49` | KEEP. It should become unreachable once every seam has a boundary |
| "Editor chunk failed to load" (fallback panel) | `src/admin/lib/LazyChunkBoundary.tsx:48` | **REWORD** and narrow (ERR-13) |
| "Could not open this project" (fallback) | `src/admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx` `SiteEditorLoadError` | **RETRY** plus a button (ERR-18) |

### 2e. Side panels (network operations the user asked for — outside canvas freedom)

These are genuine operation results. The default is **KEEP** for errors on explicit actions and **RETRY** for loads.

| Area | Sites |
|---|---|
| Git: diff, action failed (warning for state refusals), restore, sign-in, connect, list, sign-out, copy, deploy, lost deploy | `panels/GitPanel/*.tsx`: `GitPanel.tsx:122,140`, `GitHistorySection.tsx:82`, `RepositorySection.tsx:232,257,273,292`, `DeploySection.tsx:267,275`, `useDeployState.ts:99,108,126` |
| Dependencies: install/remove failures, could not start install | `panels/DependenciesPanel/useDependencyInstallJob.ts:102,111,134`, `InstallDependenciesPrompt.tsx:86,149` |
| Content/i18n: read, set up locales, setup, write key, save, translate | `panels/ContentPanel/ContentPanel.tsx:86,124,141,175,182,210`. The read failure → SILENT (empty state) |
| Agent: load/delete conversations, change model, send message, attachments, image limits, restart session | `agent/agentSlice.ts:309,391,445,536,634`, `panels/AgentPanel/*` |
| Comments: failure title, failed to load, send to assistant | `studio/commentActions.ts:30,47`, `studio/commentBulkActions.ts:118`. The load failure → SILENT |
| Assets: copy variable, copy icon | `panels/AssetsPanel/ColorsSection.tsx:193`, `IconsSection.tsx:78` |
| Framework: re-scan tokens | `panels/FrameworkPanel/TokenImportStatus.tsx:69` |

On success toasts generally (Git, deps, assets, share, layouts): these are fine on explicit panel actions. On canvas gestures, prefer **SILENT** (the result is visible).

---

## 3. Other checks from the brief

- **Keyboard shortcuts while typing:** mostly sound. `K1`'s one dispatcher and a guard in every scope (`editorKeyGuards.ts`) handle it, the `inline-edit` rung halts everything, and undo routing uses `hasPendingTextEdit`. Two residual gaps:
  - Space-pan and `canvas.zoomReset` listen outside the dispatcher (`useCanvas.ts:357-400`) with their own guards. That is fine for typing, but see ERR-11 for blur.
  - The over-broad input guard is ERR-21.
  - There is no IME `isComposing` check, but an IME only composes inside inputs, which are already guarded.
- **Iframe load failures:** portal and srcdoc frames cannot fail to load in practice. Tier-2 live frames are Z5's diagnostics (`CanvasDiagnosticsInjector.tsx`) and belong to another auditor.
- **Unhandled promise rejections:** the fire-and-forget calls I sampled catch internally: `commitStructural`, `savePreviewAxes`, `fetchStudioIconCatalog`, `copyPngToClipboard`, and the save retries. The gap is the missing window sink (ERR-26).
- **HMR and file-watcher events mid-gesture:** the agent's `patchPages` during an inline edit force-closes the edit when its node id moved. Keystrokes are lost (ERR-9). A drag whose target went stale no-ops (ERR-23). A focused inspector field overwrites the agent's value on blur (ERR-1). A board reload during a frame drag goes through `loadBoards` and restores `activeBoardId` (`studioLiveReload.ts:62-68`), which looks acceptable.

## 4. Suggested order (smallest change first, most feel gained)

1. ERR-1: ScrubInput stale blur (S).
2. ERR-3: undo resolves the owning page (S).
3. ERR-2 stop-gap: skip past the delete entry (S), then the real `restore` (M).
4. ERR-5: remap the selection on both reload paths (S-M).
5. ERR-4: queue move and delete, then the identity fingerprint (M).
6. ERR-11 and ERR-12: blur and drag self-heal (S).
7. ERR-6, ERR-9, ERR-10: the rollback and rebase family (M).
8. ERR-7, ERR-8, ERR-16: the auto-resolve family, which removes the most refusals (M-L).
9. ERR-13, ERR-14, ERR-15, ERR-17, ERR-18.

Handoff: this was a read-only audit. I changed no slices, selectors or mutations, so no `STATE.md` entry is owed.
