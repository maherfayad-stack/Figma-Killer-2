# store-engineer — Phase 0 handoff (items 0.1, 0.2, 0.3)

All three items landed. Nothing committed/staged — working tree only, per instructions.

## Files touched

New:
- `src/admin/pages/site/store/historyCoalesce.ts` — shared `coalesceKeyForPatch` helper (moved out of `nodeActions.ts`)
- `src/admin/pages/site/store/slices/site/historyPreservation.ts` — history-survives-reload check (0.2)
- `src/admin/pages/site/studio/__tests__/studioSaveRequests.test.ts` — new test file (0.2)
- `src/__tests__/editor-store/structuralReloadHistoryPreservation.test.ts` — new test file (0.2)

Edited:
- `src/admin/pages/site/studio/loadedValuesBaseline.ts` (0.1)
- `src/admin/pages/site/studio/fsCodemodAdapter.ts` (0.1)
- `src/admin/pages/site/studio/studioSaveRequests.ts` (0.2) — **not in my originally-declared file list; see "Scope note" below**
- `src/admin/pages/site/store/slices/site/lifecycleActions.ts` (0.2)
- `src/admin/pages/site/store/slices/site/nodeActions.ts` (0.2, mechanical — moved `coalesceKeyForPatch` to the shared module, no behavior change)
- `src/admin/pages/site/store/slices/styleRule/crudActions.ts` (0.3)
- `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` (0.1 tests)
- `src/__tests__/editor-store/styleRuleSlice.test.ts` (0.3 tests)
- `src/__tests__/editor-store/patchPages.test.ts` (test-hygiene fix required by 0.2 — see below)

**Scope note:** the plan's file list gave me `store/slices/site/*` + `studio/loadedValuesBaseline.ts` for 0.1/0.2/0.3, but item 0.2's actual bug (the unconditional `finally`-reload) lives in `src/admin/pages/site/studio/studioSaveRequests.ts`, not in `store/slices/site/*`. I edited it — there was no honest way to fix 0.2 without touching the file that contains the bug. **This file is not exclusively mine**: while I was working, a concurrent agent (implementing plan item 0.7, per its own doc-comment) landed an ADDITIVE change to the same file (a new `unexplainedSkips` field on `StudioSaveResponseSchema`). The two changes merged cleanly with no conflict — my edits are all inside `commitStructural`; theirs is the schema + imports above it. Verified post-merge: `grep -n "flushEditorSave|willReload|finally"` still shows my code intact. Flag this for the orchestrator as a file both of us touched.

---

## 0.1 — undo-after-autosave permanently desyncs tree from disk

**Root cause confirmed exactly as audited.** `fsCodemodAdapter.ts`'s `saveSite` diffs against `getLoadedNodeValues(node.id)` but never advanced that baseline after an ordinary (non-reloading) save — only `resetLoadedValues`/`mergeLoadedValuesBaseline` (both full-reload paths) ever touched it. `styleRuleWriteback.ts`/`localizedPageWriteback.ts` both correctly advance their own baselines post-save; this path didn't.

**Fix.**
- `src/admin/pages/site/studio/loadedValuesBaseline.ts:99-139` — new `NodeValueBump` type + `commitNodeValuesBaseline(bumps)`: advances the baseline for exactly the `(nodeId, key)` pairs passed in, without touching anything else (unlike `resetLoadedValues`, which replaces a whole node's bag).
- `src/admin/pages/site/studio/fsCodemodAdapter.ts:341-472` (the edit-collection loop) — every `edits.push(...)` call site (the `literal`/`textOrigin` branch, the `tag` branch, the flat `prop`/`text` loop, the `callSiteProps` loop, the `style` branch) now ALSO pushes a matching entry to a parallel `bumps: NodeValueBump[]` array, keyed the same way the pre-existing baseline-diff check (`Object.is(baseline[key], value)`) reads it.
- `fsCodemodAdapter.ts:547-559` — inside the `edits.length > 0` branch, right after the `unexplainedSkips` toast: `if (unexplainedSkips === 0) commitNodeValuesBaseline(bumps)`.

**Why gated on `unexplainedSkips === 0`, not "always advance the sent edits":** the POST response (`written`/`skipped`/`refusals`) is an AGGREGATE over the whole batch (which also contains CSS + localized-text edits sent in the same request) — there's no per-edit success/failure signal for `prop`/`text`/`style`/`tag`/`literal` kinds specifically (only `detach`/`swap`/`css` get named `refusals`). Rather than guess which of several sent edits landed, I only commit the bumps when the WHOLE batch is known-good (`unexplainedSkips === 0`, i.e. no unnamed skip occurred anywhere in the batch). This is strictly conservative: in the rare case some OTHER edit in the same batch silently failed, we just re-diff (and harmlessly re-send, since these codemods are idempotent) the successful ones on the next tick instead of ever risking a false "landed" that hides a real refusal. This satisfies the explicit instruction "do not advance on a refused or skipped edit."

**Tested (adapter level, exactly as the task asked):** `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts`, new `describe('save-diff baseline advances after a landed write (E1)')`:
1. Seed baseline via `loadSite` (`text: 'Hell'`) → `saveSite('Hello')` (1st POST) → `saveSite('Hell')` (simulated undo) → asserts a **second** POST fires carrying the reverting edit (`text: 'Hell'`). Without the fix this second POST never fires (the exact E1 repro).
2. A batch with `written:0, skipped:1` (unexplained skip) does NOT advance the baseline — re-saving the SAME unchanged value still re-POSTs (proves we don't silently adopt an unwritten value as "saved").

Both pass; `bun test src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` → 18/18 pass (standalone and combined with the rest of `src/__tests__/editor-store` + `src/admin/pages/site/studio`).

**One test-authoring note, not a functional issue:** whether `base.text`'s `text` prop ships as `kind: 'text'` or `kind: 'prop'` depends on whether `registry.get('base.text')?.inlineTextEdit` was populated by some OTHER test file importing `@modules/base/index` earlier in the same `bun test` process — genuinely order-dependent across the whole suite (not introduced by me, but it broke my first draft's exact-`kind` assertions when run in combination with other files). Fixed by asserting on `nodeId` + value only, independent of which kind won.

---

## 0.2 — forced reload destroys undo stack + in-flight edits

**Correction to the plan's evidence, stated plainly:** the plan says *"Every move/delete/insert/detach/swap/image-replace calls `requestCmsSiteReload()` unconditionally in a `finally` block."* Reading `studioSaveRequests.ts` as it exists today: **only** `commitStructural` (shared by `commitStudioMove`/`commitStudioDelete`/`commitStudioInsert`) has the `finally`-unconditional bug. `saveStudioAssetEdit`, `detachInstance`, `swapInstance` already gate on `result.written > 0` with no `finally` at all — someone already fixed those three (or they were built correctly from the start) since the audit was written. `extractInstanceCopy` reloads unconditionally too, but only ever reaches that line after an explicit `if (!result.ok) return {...}` — its endpoint has no partial/skip state, `ok:true` always means the write landed, so that's not a bug. **I fixed exactly `commitStructural`**, which is the only place item 0.2's fix actually applies.

### (a) Reload only when a write landed
`src/admin/pages/site/studio/studioSaveRequests.ts:292-344` — `commitStructural`'s reload moved out of `finally` into the success path, gated on `willReload = result.written > 0`. The catch branch (network/thrown error — no response at all) never reloads either (there is no `written` to check; "no response" means "assume disk unchanged").

**Known limitation, flagged in-code and here:** a REFUSED move/delete (the "residue only the AST can answer" case documented in `commitStudioMove`'s own doc comment) had already applied its optimistic tree mutation client-side before the refusal came back. Previously, the unconditional reload corrected that divergence as a side effect. Now, since `written === 0` on a pure refusal, **no reload fires**, and the board can show a move/delete that never reached the source until some LATER, unrelated reload happens to resync it. I did not build a targeted "revert just this transaction" mechanism — the plan's own audit (finding **E3**, not one of my three items) already identifies this exact race ("a user's Ctrl+Z of a move/delete can be silently overwritten by the forced reload... no cancellation path, no race detection") as a separate, harder, deliberately-deferred problem, and building it here risks reproducing that exact race in a new form. **A human should decide whether this trade-off (whole-undo-stack-death on every structural edit, vs. a refused move staying visually applied until an unrelated later reload) is acceptable as an interim state, or whether E3 needs to be pulled forward.**

### (b) Flush pending debounced save before the structural POST
`commitStructural` now does `await flushEditorSave()` (imported from `@site/hooks/editorSaveRef` — this bridge ALREADY EXISTED, built for the MCP editor-bridge; I didn't invent a new mechanism) as its very first step, wrapped in its own try/catch so a flush failure logs but never blocks the structural edit itself.

**I placed the flush BEFORE the structural POST, not just "before the reload"** (the plan's literal wording). Reasoning: if a pending prop/text edit is flushed AFTER the structural write has already landed and shifted lines, that flush would target now-stale `line:col` ids and could silently fail or hit the wrong node. Flushing first means the pending edit lands (and — per 0.1's fix — its own baseline advances) against still-valid ids, before anything can shift them.

### (c) Preserve history across a structural reload
New module `src/admin/pages/site/store/slices/site/historyPreservation.ts`:
- `collectAllNodeIds(site)` — every node id in `site.pages` + `site.visualComponents[].tree` (the two surfaces `mutateActiveTree` can target).
- `historySurvivesReload(entries, knownNodeIds)` — scans every `HistoryEntry`'s forward+inverse patches for `['...', 'nodes', <id>, ...]`-shaped path segments and checks each referenced node id is still a key in `knownNodeIds`.

`lifecycleActions.ts`'s `loadSite` now computes `historySafe` (both `_historyPast` and `_historyFuture` must pass) BEFORE wiping, and only resets `_historyPast`/`_historyFuture` to `[]` when `!historySafe`. When safe, the arrays are left untouched (Mutative draft semantics: not assigning = keeping the same reference — verified by a `toBe()` reference-identity assertion in the new test). `_historyCoalesceKey` is always reset to `null` (a reload boundary always ends an open burst, safe or not). `hasUnsavedChanges` is **always** forced to `false` regardless of `historySafe` — see the "why NOT preserve `hasUnsavedChanges`" reasoning below.

**This is a real, honest interpretation of "re-anchor node ids," not the full position-based mapping the plan's wording gestures at** ("ids are re-derived source locations, so a post-reload re-anchor is well-defined"). A TRUE re-anchor (map old id → whatever the same source element's id became after a shift) needs AST-level correspondence data the client doesn't have — that's Track C2/C5 territory, explicitly out of scope here ("do not attempt targeted per-file re-parse"). What I built instead is provably SAFE (never replays a patch against a path that doesn't exist) and correctly handles the common case (a structural edit only shifts ids inside the file(s) it touched — every other node in the document, i.e. the vast majority of any prior undo history, is untouched and its patches replay identically against the fresh tree). **Scope gap, documented in the module doc:** it only tracks node ids, not `styleRules`/`visualComponents` MEMBERSHIP (e.g. a generated-class rule that gets pruned because the node using it was deleted) — an edge case narrower than the "undo dies on every edit" bug this fixes; the safe fallback (wipe) still applies whenever it's triggered by a node-id check, it just doesn't independently detect this one style-only case.

**Why `hasUnsavedChanges` is NOT preserved even when history is:** `state.site` is unconditionally replaced by the freshly-loaded document either way — so an edit that was still "unsaved" pre-reload has ALREADY been discarded from the tree by the time this flag would matter (preserving just the boolean without the edit it describes would be a permanently-stuck "unsaved" indicator with nothing left to save, since the fresh site will never diff as different from itself). Item (b)'s pre-POST flush is what's supposed to prevent a real edit from reaching this point un-flushed in the first place; this is *by design*, not an oversight.

### Regression found and fixed: `patchPages.test.ts` isolation gap
Running the combined suite surfaced `patchPages — never marks the store dirty (write-loop gate) > does not push an undo history entry` failing. Root cause: that test file's `freshStore()` helper never reset `_historyPast`/`_historyFuture`/`_historyCoalesceKey`/`canUndo`/`canRedo` between tests (every OTHER `freshStore` in the codebase does). This was harmless before my fix because `loadSite` always wiped history unconditionally for every caller; my fix made `loadSite` sometimes PRESERVE history, which surfaced this pre-existing test-isolation gap (a prior test's leftover `_historyPast` entries — referencing generic ids like `'root'`/`'hero'` that this file's fixtures also happen to use — "proved safe" against the coincidentally-overlapping fresh fixture). Fixed by adding the missing resets to `patchPages.test.ts`'s `freshStore()`, matching every sibling test file's convention. This is a genuine test-hygiene fix, not a workaround.

**Production risk of this same "coincidental id collision" class of bug:** low. Real studio node ids are `rel:line:col` (e.g. `pages/Home.tsx:3:1`), so a collision between two genuinely different projects/documents would require an implausible identical-file-and-position coincidence. The risk is confined to hand-authored test fixtures reusing short static ids (`'root'`, `'hero'`) — which is exactly what surfaced here — and to CMS-mode documents (nanoid ids, also effectively collision-free).

**Tested:**
- `src/__tests__/editor-store/structuralReloadHistoryPreservation.test.ts` (new, 5 tests): history survives (same array references, not copies) when ids resolve; ends an open coalescing burst regardless; `hasUnsavedChanges` always clears; first-load-with-empty-history is a safe no-op; falls back to wiping when the incoming site is a genuinely different document.
- `src/admin/pages/site/studio/__tests__/studioSaveRequests.test.ts` (new, 7 tests): flush happens and is awaited BEFORE the POST; a flush failure is logged but doesn't block the commit; the commit still works with no editor mounted (flush is a no-op); reload does NOT fire on refusal-only, skip-only, or thrown-request outcomes; reload DOES fire when `written > 0`.

All pass. Combined run (`src/admin/pages/site/studio` + `src/__tests__/editor-store` + `src/__tests__/editor` + the two architecture gates): 550/550 pass.

---

## 0.3 — class/style edits flood and evict undo history

**Confirmed exactly as audited.** `updateClassStyles`/`setClassContextStyles` in `store/slices/styleRule/crudActions.ts` called `mutateSite(...)` with no second argument at all.

**Fix.**
- Extracted `coalesceKeyForPatch` out of `nodeActions.ts` (where it was a private, unexported function) into a new shared leaf `src/admin/pages/site/store/historyCoalesce.ts`, so both the node-prop path and the style/class path use the IDENTICAL implementation rather than a hand-rolled duplicate that could drift. `nodeActions.ts` now imports it; behavior there is unchanged (verified: `historyCoalescingFold.test.ts` + `undo-redo.test.ts` still pass unmodified).
- `updateClassStyles(classId, patch)` → `mutateSite(fn, coalesceKeyForPatch('style', classId, patch))`
- `setClassContextStyles(classId, contextId, patch)` → `mutateSite(fn, coalesceKeyForPatch(`style-context:${contextId}`, classId, patch))` — contextId is part of the scope so a `mobile` burst and a `tablet` burst on the same class never fold into each other.

Both mirror `coalesceKeyForPatch`'s existing multi-key behavior: a shorthand-expansion patch (>1 key) still gets its own discrete undo entry, matching the node-prop path's contract exactly.

**Tested:** `src/__tests__/editor-store/styleRuleSlice.test.ts`, new `describe('styleRuleSlice — style/class edits coalesce into one undo entry')` (6 tests): a same-property burst on `updateClassStyles` folds to ONE entry and undo reverts to the pre-burst value; a multi-property patch is NOT coalesced with a later single-property one; edits to different classIds never coalesce into each other; the same three shapes for `setClassContextStyles` (same-breakpoint burst folds, different breakpoints don't coalesce). All pass; full file 20/20.

**Note on test authoring:** the first version of my burst test seeded a baseline value via a call to `updateClassStyles` with the SAME single-key patch shape as the burst under test — which meant that seed call itself opened the SAME coalescing burst (same `coalesceKey`), so the "burst" loop folded into the seed rather than opening a fresh entry after it. Fixed by inserting an unrelated-key call (different `coalesceKey`) between seed and burst to deliberately close the prior burst — this is a property of the ALREADY-EXISTING coalescing mechanism (continuous, not per-assertion-window), not something my fix changed; worth knowing if anyone else writes a coalescing test here.

---

## Verification run

```
bun test src/admin/pages/site/studio src/__tests__/editor-store src/__tests__/editor \
  src/__tests__/architecture/centralized-site-mutation-history.test.ts \
  src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts
# => 550 pass / 0 fail

bun test src/__tests__/persistence src/__tests__/canvas src/__tests__/site-explorer \
  src/__tests__/toolbar src/__tests__/spotlight src/__tests__/panels \
  src/__tests__/page-tree src/__tests__/editor-hooks
# => 1550 pass / 2 fail
#    Both failures are in files I never touched and don't import anything I
#    touched (agentPanel.test.tsx — AgentPanel/ModelEffortPicker/server AI;
#    siteExplorerPanel.test.tsx — DOM-panel-style row classnames). `git status`
#    confirms canvas-engineer/panel-designer/mcp-tooling have concurrent
#    in-progress edits to exactly those areas (canvas/*, panels/*, server/ai/*).
#    Not mine — did not attempt to fix per the "parallel sessions" rule.

./node_modules/.bin/tsc --noEmit -p tsconfig.json
# => zero errors, project-wide (per standing-08, not `npx tsc`)
```

Did NOT run `bun run build` / `bun run lint` per explicit instructions (collision risk with concurrent agents' `dist/`/`.tsbuildinfo`).

I also started a full `bun test` in the background to double-check against the documented 7618/34/1 baseline, but it hadn't produced output after several minutes (large suite, concurrent load from 3 other agents) — I did not block on it given the instructions explicitly call for targeted suites only. If the orchestrator wants that number reconfirmed at the end of the wave, it should be re-run once all four agents have landed.

## For the human to dogfood

- **The E3 gap (0.2's known limitation):** drag a node into a position the AST refuses (a "residue only the AST can answer" case — rare, hard to construct deliberately), confirm the board keeps showing the refused move until an unrelated later reload corrects it. This is a real, intentional trade-off versus destroying the whole undo stack on every structural edit; worth a product call on whether it's acceptable pending a proper E3 fix.
- **0.1's fix in the browser:** type into a text field, wait ~2s for autosave, press Ctrl+Z, wait ~2s again — confirm the `.tsx` file on disk reflects the undo (previously it silently didn't).
- **0.2's history preservation:** make a few unrelated edits, then drag-reorder a layer in the tree — confirm Ctrl+Z still works for the earlier edits (previously the whole stack died on the reorder).
