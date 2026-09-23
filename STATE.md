# STATE
> **Purpose:** live coordination only: what is in flight, what is blocked, what a human still owes · **Read when:** before any task; write at every stage boundary · **Trust:** live; a claim older than its Updated date may be stale · **Owner:** studio-scribe · **Verified:** 2026-09-23

Protocol: [`docs/agent-refs/handoff-protocol.md`](docs/agent-refs/handoff-protocol.md) · Plan: [`ROADMAP.md`](ROADMAP.md) · Decisions: [`docs/decisions.md`](docs/decisions.md) · History: [`docs/state-archive/INDEX.md`](docs/state-archive/INDEX.md)

**New entries go under `## Now`, never above it.** An entry is at most 40 lines; put the long form in the PR body and link it. Entry ids are `<area>-<nn>`: take the next free number in your area from `docs/state-archive/INDEX.md` and this file. This file stays under 400 lines; the section caps below are hard.

---

## Now

*At most 8 entries. Only work that is not yet merged into the trunk `feat/canvas-excellence`.*

### meta-18 — the canvas excellence program: 10 audits, one ROADMAP.md, and the trunk `feat/canvas-excellence`
- **Agent:** orchestrator (main session)
- **Stage:** executing. The owner answered on 2026-09-23 (`ROADMAP.md` §2) and re-confirmed the standing authorization.
- **Branch:** `feat/canvas-excellence`, the program trunk, cut from `chore/integrate-open-drafts` (`9fc88346`, PR #217). Every bundle PR targets this trunk.
- **Updated:** 2026-09-23
- **Goal:** the owner's 2026-09-23 ask: no lag, zero visible errors, Penpot/Figma gestures, design-pane spacing, the best possible assistant, image drag & drop, SVG draw/edit, component detach, a free canvas, and a docs cleanup. Ten Opus audits (`docs/audits/2026-09-23-studio-audit/`) were bundled into phases P0–P6 in `ROADMAP.md`.
- **Owner decisions:**
  - archive the old plans;
  - armed draw tools;
  - a structural gesture inside a shared component applies to this instance only (detach, then replay);
  - a new free canvas (OD-14 / P5-G), where loose layers are `.studio/canvas/<id>.tsx` rendered in one static iframe per board.
- **Findings a later agent must not rediscover:**
  - Line:col ids hit the WRONG element after an outside edit, or a delete during an in-flight move (WB-1, ERR-4). This is the Phase 1 barrier.
  - Dictionary edits revert on reload (WB-2).
  - Style/class edits on two instances collapse to one (WB-7).
  - The selection is not remapped after a resync (ERR-5).
  - The mode and design-policy prompt blocks never reach the Claude-CLI path (AI-1).
  - `isWritableSourceRel` accepts any `.studio/*.tsx` path (P1-G).
- **Landmines:**
  - The P0-C freeze on STATE.md is over (#225 merged into the trunk). Bundle agents write their entry under `## Now` again, following `docs/agent-refs/handoff-protocol.md`.
  - The auditors' probe scripts were not committed. P1 recreates them as regression tests.
- **Progress:** Phase 1 is merged into the trunk: P1-G #219, P1-C #220, P1-A #221, P1-B #222, P1-E1 #224, P1-E2 #223, P1-E3 #226, P1-H #228, P1-D #229, P1-F #230; P0 #225; P4-A #227, P4-B #231. At most 3 agents run at once, because of the owner's RAM (never run `server` tests as one process).
- **Next:** Phase 1 exit gate passed (#232). Merged in Phase 2: P2-F #234, P2-A #235, P2-G #236, P2-D #237; P4-C #233. Running: P2-B, P2-H, P4-D. Then P2-C→E and P2-I (after P2-B). P2-C must also fix `canvasFreeMove` writing the kebab key `inset-inline-start` into JSX `style={{}}` (P2-D finding, `canvas-23`). **P2-I must A/B the cold click-to-ring** on a quiet machine (P2-A measured a 432 → 485 ms mean, within load noise; suspect: lazy portal observers paying setup on the first selection). Owner: `CLAUDE.md`'s budget-spec list should name `canvas-feel-budgets.e2e.ts`; regenerate `runtimeBridgeBundle.ts` with `studio-runtime:sync` on an LF tree (bun 1.3.11).

### meta-19 — integration head: every open draft line merged into chore/integrate-open-drafts
- **Agent:** integrator (general-purpose, own worktree) · **Updated:** 2026-09-23
- **Stage:** done. `chore/integrate-open-drafts` off `origin/main` `51b19940`, draft PR #217 against `main`. Nothing was merged into `main`, no PR was edited or closed, nothing was force-pushed.
- **Full entry** (every head sha, the conflict calls, the exact failing tests): `docs/state-archive/2026-09.md` → `meta-19`.
- **Included:** the studio perf line (`560ddb0e`: #192, #193, #194), #195, #196, #197/#198 (the `run-project` default), #199, #200, #201, #202, #203, #204, and the speed line at `e15c4c88` (#205–#210 plus the already-merged #211–#216).
- **Excluded:** #99 (already in `main` by patch-id); #86 (457 commits behind; its CI idea is ROADMAP P0-I); `tmp/speed-integration`'s tip `546f1477` (dogfood residue in test fixtures); unpushed local WIP branches.
- **Resolved:** the two "keep one ts-morph Project across loads" implementations became one, `withWorkspaceProject`; the other copy and its test were deleted. Two modules the merge pushed past 700 lines were split (`structuralUndoPlan.ts`, `studioAsset.ts`).
- **Gates (Windows, bun 1.3.6):** build, lint and `tsc -b` clean. `bun test`: 16 fail, and every one reproduces on the speed-line baseline `e15c4c88` (the ROADMAP §13 "Baseline"). No e2e run.
- **Landmines:** two different entries are both `perf-10` (#195 and #196); cite them by title. `04f92846` commits Studio's generated prototype shell into `__board-perf-fixture` and edits `test4`: owner to decide whether to revert it.
- **Next:** once #217 merges, close #192, #195 and #198–#210 as included.

### docs-15 — P0: consolidate the docs (ROADMAP P0-A … P0-H)
- **Agent:** studio-scribe · **Branch:** `docs/p0-consolidate-docs` off `386e1d00` · **PR:** #225 (draft, base `feat/canvas-excellence`) · **Updated:** 2026-09-23
- **Stage:** verifying (draft PR open; owner review needed, see Human action)
- **Goal:** one living plan, one decisions file, a `STATE.md` under 400 lines with nothing lost, a header on every doc, and no reference to a dead doc path.
- **Done:** eight commits, one per bundle, plus a merge of the trunk (P1-A/B/C/G) before the last one.
  - A: `docs/CONVENTIONS.md` (header line, trust levels, plan and archive doc types).
  - B: seven code-cited plans + `STUDIO-SPEED-PLAN.md` → `docs/archive/plans/` (names unchanged); three uncited plans deleted after harvest; new `docs/decisions.md`, `docs/features/{trust-tiers,live-canvas,design-system}.md`, `docs/archive/README.md`; D2 target in `canvas-dnd.md`; CMS traps in `architecture.md`; ROADMAP §13 filled.
  - C: this file 20,036 → about 165 lines; `docs/state-archive/2026-09.md` (214 entries verbatim, plus the P1-A/B/C/G entries `store-16`, `parser-p1a`, `parser-15`, `sec-23` folded in from PR bodies #219–#222), `INDEX.md` (218 + 153 lines, count parity), `docs/e2e/dogfood-backlog.md`.
  - D: `handoff-protocol.md`. E: 52 `inspector-disclosure.md` refs, 3 gate messages, 11 agent files, dead paths. F: CLAUDE.md, BRIEF, `docs/README.md` (the doc map), README, AGENTS. G: 65 headers + 73 historical headers; C15, C16, C22. H: `doc-headers.test.ts`.
- **Decisions:** archived plans keep their filenames so ~200 code-comment citations still resolve; `Verified: not yet` marks every doc nobody has checked since headers were added (honest, not a date); ROADMAP §2 now indexes the decisions and `docs/decisions.md` holds their text.
- **Landmines:**
  - `.claude/agents/studio-scribe.md` still routes "intent" to `STUDIO-IMPORT-V2-PLAN.md`: it is this agent's own configuration, so it was left for the owner.
  - `CLAUDE.md` and ten `.claude/agents/*.md` files were edited only where the moves broke a reference; the broader rule-book trim ROADMAP P0-F describes was not done (it needs the owner, not an agent request).
  - ~~The Docker images and templates kept `studio-workspace/` outside every volume.~~ Fixed by P1-H (#228, `server-28`).
- **Verification:** see the PR body (`bun run build`, `bun run lint`, `bun test`, with the triage of every failure).
- **Human action needed:** review the `CLAUDE.md` and `.claude/agents/` diffs before merging (an agent's request cannot authorise rule-book changes); fix `studio-scribe.md` line 30.

### test-06 — Phase 1 exit gate: outside-edit e2e + regression audit (WB-1/2/7/23, ERR-1/3/4/5)
- **Agent:** test-engineer · **Branch:** `test/phase-1-exit-gate` · **PR:** #232 (draft, base `feat/canvas-excellence`; the audit table is in its body) · **Updated:** 2026-09-23
- **Stage:** verifying (draft PR open)
- **Goal:** `ROADMAP.md` §5 exit gate: a regression test that fails before its fix for every reproduced P1 finding, and an e2e that edits a page outside Studio mid-session, then edits and deletes on the canvas, and checks the file bytes.
- **Done:**
  - `tests/e2e/phase-1-exit-gate.e2e.ts`, 4 cases, Chromium, green twice. (1) outside edit, then the live reload, a text edit, a Delete and ⌘Z: the file is byte-exact after each step. (2–4) the outside write races a PENDING text edit (autosave off, flushed by the watcher push), an IN-FLIGHT text edit, and an IN-FLIGHT Delete (held with `page.route`). All three landed on the intended element, recorded as annotations.
  - With `resolveEditIdentities` disabled in place, all three race cases fail on a wrong-element write. Case 1 does not fail that way: after the live reload its ids are fresh, so it proves P1-D's watcher, not the guard.
  - Regression audit: each of the 8 findings has a committed test, and each test was proven to fail with its fix disabled in place, then restored with `git checkout -- <file>`. Table in the PR body.
  - Shared `sourceNodeId()` in `tests/e2e/helpers/studioFixtureProject.ts` replaces three copies (`element-identity-guard`, `outside-edit-live-reload`, `structural-writeback`).
  - `docs/e2e/README.md` coverage map: rows for the P1 specs.
- **Decisions:** a racing edit may land OR be refused, never land elsewhere. `settleOnDisk` fails on any third file state that persists across 3 reads, so a read that races the server's non-atomic write cannot fail the case.
- **Landmines:** `structural-writeback.e2e.ts` fails on the trunk BEFORE this change too. Its fixture is not pinned to `trust: 'static'`, so the Tier-2 default mounts a live frame as well (two canvas iframes, a strict-mode violation). Its second case then hits Windows `EPERM` re-creating the held fixture dir. Found, not fixed.
- **Verification:** build + lint clean. Chunked suite: only pre-existing failures (bundle freshness, optimistic broadcast, bridge measurement, WebSocket, headless capture, dev server), plus three 5 s load timeouts that pass alone.
- **Next:** none for Phase 1. Phase 2 can start.


### mcp-28 — P4-C: the API-key path can build (AI-2, AI-8, AI-10, AI-11)
- **Agent:** mcp-tooling · **Branch:** `feat/agent-api-path-can-build` off `53c2746f` · **PR:** #233 (draft, base `feat/canvas-excellence`) · **Updated:** 2026-09-23
- **Stage:** verifying — review F1–F9 addressed; re-review R1 (F3 bypass through `prototype/studioRuntime.generated.js`) fixed; **needs security-guard sign-off**
- **Goal:** an HTTP-driver (API-key) turn can read, grep, write and edit project files; the loop retries transient errors, winds down before the round cap and ends on a summary, sets `max_tokens` per model, continues a truncated reply, and maps `effort` to thinking/reasoning.
- **Tools added** (all `execution: server`):
  - `studio_grep` (read, no caps; registry + HTTP agent) — `{ query (literal), path?, caseSensitive?, limit? }`.
  - `studio_write_file` / `studio_edit_file` / `studio_edit_files` (HTTP agent ONLY; `ai.tools.write` + `studio.write`; `sideEffects: write`) — `{ path, content, expectedHash? }`, `{ path, oldString, newString, replaceAll?, expectedHash? }`, `{ edits: [≤50] }`. No `dir` field. Missing precondition → `no-open-project`: "No Studio project is open for this turn, so there is nowhere to write. Ask the user to open the project in Studio and send the message again."
  - `studio_read_file`, `studio_list_files`, `studio_get_node_source` moved to `fileReadTools.ts` and now also on the HTTP agent surface.
- **Done:**
  - One containment rule, `server/handlers/studio/agentFileAccess.ts` (real path, case-folded dirs, `agentWriteRefusal` + `isWorkspaceWritablePath` for writes, credential files, NTFS streams, Windows devices, 1024/255-char caps; hard links refused by the writers).
  - Review F3: `hostExecutedWorkspaceFile` (`@core/page-parser`) inside the ONE agent write gate `agentWriteRefusal` (was `agentWriteRefusalReason`, now `{ code, message }`) → `needs-user` on the CLI hook AND the HTTP tools for build config, `package.json`, env/npm config, `.husky`/`.vscode`/CI/commit-hook runners, `CLAUDE.md`.
  - Re-review R1: the same gate refuses Studio's preview shell (`prototype/`, `studioShellWorkspaceFile`, `protected-path`; a test derives the list from the shell templates) and the depth-2 relative-import closure of every root host config (`hostConfigImports.ts`, `needs-user`, mtime-cached).
  - Writes hold `withProjectWriteLock`, check `expectedHash`, `appendTurnWrite`, and `pushStudioDiskChange` once per call. `studioHttpTurn.ts` generates the project guide and resets the turn log for HTTP turns.
  - `selectStudioTools(..., { fileAccess })` + `agentFileAccessForProvider`; the prompt derives its file paragraph from the tools (`agentFileAccessFor`); the `needs-user` paragraph is on both paths.
  - Loop: `providerRetry.ts` (AI-8, `retrying` event + panel headline), wind-down + tools-off summary round (AI-10), `anthropicModelProfile.ts` + truncation continuation + effort mapping + `unsupportedParameter` fallback (AI-11). `toolLoop.ts` split: `toolDispatch.ts`, `heavyElision.ts`, `toolLoopTypes.ts`.
  - Fixed on the way: `studio_get_node_source` read outside the project via `../` in a node id; `studio_read_file` excluded `.git`/`.studio` case-sensitively.
- **Decisions:** the write tools are NOT in the external MCP catalog (no external connector is ever bound, so they could only refuse). Thinking blocks live only in the turn's in-memory history, never persisted (AI-11's "new AiContentBlock kind" not done — no later turn needs them). Pre-image checkpoints (AI-7) are P4-F's.
- **Landmines:** any Studio writer that is NOT an agent must not call `agentWriteRefusal` (the prototype shell writes `vite.config.js`). `tool-write-gate-unchanged-by-side-effects.test.ts` now has `WRITE_GATED_ADDED_SINCE`; `no-phantom-tool-names` and the parity matrix gate cover the HTTP surface too. `TurnResult.stop` is gone (`truncated` + `toolCalls.length`).
- **Verification:** after the review fixes and the trunk merge (`c9ef0b76`): build, lint, tsc clean; every chunk run under the heavy-run lock with `server/handlers` split; only pre-existing failures (PR body). No e2e: a real turn needs a provider key.
- **Next (open follow-ups, owners named):**
  - F7: `pruneLegacyGuideArtefacts` deletes 18 fixed `.claude/` names with no ownership/hash check, and the guide generator writes `CLAUDE.md`/`.claude/*` without a real-path check (a `.claude` junction escapes) — pre-existing CLI-path code in `projectGuide*.ts`; owner: server-engineer.
  - F3.4: `devServer.ts` spawns `npm run dev`, which runs a repo-supplied `predev`/`postdev`; switch to `npm run --ignore-scripts dev` (or exec Vite directly) — owner: the Tier-2 dev-server bundle.
  - F5: temp-file + rename for crash-atomic writes (needs EPERM-on-Windows handling and mode preservation).
  - F8: `studio_fetch_remote_asset` host restriction or first-use confirmation — P4-E.
  - R1 residuals (security re-review 2 APPROVED with these open, `review-233`): imports of a NESTED app's config (scan `resolveAppRoot` next), depth-3 imports, backtick `import()`, postcss plugin-map keys, tsconfig-`paths` imports, a symlinked config, a dev script's custom `--config`, Tailwind v4 `@plugin`/`@config`. Each needs an import chain already present; none exists in a scaffolded project.
- **Human action needed:** dogfood with an Anthropic API key (script in the PR body). Security sign-off done.

---

### perf-11 — P2-A: perf quick wins + benches (PERF-2, 3, 4, 9, 10, 11, 13; budgets 1, 2, 5, 6, 7)
- **Agent:** perf-hunter · **Branch:** `perf/canvas-quick-wins-and-benches` off `53c2746f` · **PR:** #235 (draft, base `feat/canvas-excellence`) · **Updated:** 2026-09-23
- **Stage:** verification complete. Before/after table and every run: the PR body.
- **Benches (committed first, measured before any fix):**
  - Budget 1: the canvas subscriber sweep (`scripts/bench/lib/canvasSubscriberSweep.ts`, 40 pages × 300 nodes × 12 frames, 39,600 subscribers) is a GATE in `bench:editor-store`. A breach fails the bench through the new `BenchResult.budgetFailures`, after the rows are written.
  - Budget 2: a generated 40-frame × 310-element Tier-0 corpus, `tests/e2e/helpers/largeBoardCorpus.ts`.
  - Budgets 5, 6, 7: `tests/e2e/canvas-feel-budgets.e2e.ts` (canvas hover sweep, Layers hover sweep, pan with a selection, idle rAF). It is added to CI's `e2e-budgets` job.
- **Done:**
  - `isSelectionChromeMutation` (`@core/studio-runtime`) filters chrome in all four frame observers. The hover ring stays mounted and is hidden by a style write.
  - `frameFitMutationScheduler` moved to core and is now the live runtime's too: attribute-only batches never reset a fit, and a live frame's structural changes debounce for 250 ms.
  - The toolbar and inspector follow every transform write from a board-space anchor (`selectionChromeViewportFollow.ts`), and a pan over in-frame rings arms no loop.
  - The rulers paint on change only.
  - `PortalFrameAdapter`'s ring observer is lazy.
  - The annotation `setSelection` no-op guard. `hoverNode`'s guard was already in (`speed-03`) and is now pinned.
  - A frame-less selection or hover is scoped to the frames whose page holds the node (`idsRenderedByFramePage`).
- **Numbers (before → after):**
  - pan toolbar drift: 288 px → 0.0 px.
  - idle rAF calls per second: ~122 → 0.
  - hover chrome tree mutations: canvas 4 → 0, Layers 14 → 0.
  - marquee no-op `set()`: ~22 ms → 1.6 µs.
  - hover worst frame: 148–198 ms → 124–150 ms. Mean frame: 22–25 ms → 19 ms.
- **Tests:** eight regression tests. Each was shown to fail with its fix disabled in place.
- **Landmines:**
  - Hover frame time is still PERF-1: frames over 20 ms stayed at 48/~195. Only P2-I moves it, so the 225 ms worst-frame budgets are ratchets.
  - `runtimeBridgeBundle.ts` was produced by applying the source diff to the committed artifact, because a sync on this CRLF/Bun-1.3.6 tree emits different helpers. Re-run `studio-runtime:sync` on an LF tree before relying on the freshness gate.
  - The sweep's selectors mirror `NodeRenderer.tsx`. P2-I must update the mirror when it changes them.
  - speed-04 cold click to ring, on `__board-perf-fixture`, was already over budget on trunk. Before: 401–494 ms (mean 432). After: 425–533 ms (mean 485). The ranges overlap under load, so the difference is not attributed. Re-measure on a quiet runner.
- **Next:** the orchestrator merges after the Phase 1 exit gate. P2-I tightens the sweep and hover budgets.

### panel-44 — P2-G: the Component section (UX-4, UX-7, UX-10, UX-14, UX-16)
- **Agent:** panel-designer · **Branch:** `feat/component-section-one-title-row` off `91df2c59` · **PR:** #236 (draft, base `feat/canvas-excellence`; long form in its body) · **Updated:** 2026-09-24
- **Stage:** verifying (draft PR open; owner dogfood below)
- **Goal:** an instance's props directly under Measures, under one title row, honest under multi-select; prop names readable; text props that commit instead of writing per keystroke.
- **Done:**
  - `ComponentSection`: one `SectionStaticHeader` ("Button · Local", new `meta` slot) with Detach/Swap icon buttons; Swap is an `InspectorPopover`; keyed per instance so a refusal or draft never carries over. Manifest `order: 3`; `appliesTo: showsComponentSection` (no multi-select).
  - **Found and fixed:** an instance with no writable class showed only "Inline styles come from this component's own source." — `StyleSurface`'s notice replaced every section, the props included. New manifest field `writes: 'call-site'`; `designCallSiteSections` still mounts beside the notice.
  - Detach's duplicate offer reads `explainDetachConstraint`; the duplicate `EXTRACT_OFFER_REASONS` is deleted.
  - `--inspector-label-w` 68 → 96px; `ControlRow` gaps use the frozen scale under `[data-field-skin='inspector']`.
  - `TextControl` draft-then-commit via `textFieldDraft.ts` (blur/Enter commit once, Esc reverts, a parked caret follows the store).
  - Gates: `measurement.test.ts` (order, `writes`, structure, 96px), `inspector-height.e2e.ts` (F5 instance + a P2-G shape test; F2 allowance 50 → 47), `05-section-heights.json/.md`, `inspector.md`, `design.md`, `ui-primitives.md`.
- **Measured (1400×900, room 746):** F1 598 → 598 · F2 772 → 769 (23 over) · F3 715 → 715 · F4 601 → 595 · F5 instance: notice only → 276 (Component 137).
- **Tokens added:** none (`--inspector-label-w` changed value).
- **Landmines:**
  - The component catalog loads after the section mounts: until it lands, rows are call-site-only and a union prop is a text box. F5 waits on `instance-call-site-prop-ariaLabel`.
  - `Section forceOpen` still renders a toggle button that does nothing (every forceOpen section). Not changed here; in the PR's Found, not fixed.
- **Human action needed:** dogfood on `test4`, `/admin/site`:
  1. Select a component instance: right under W/H/X/Y is ONE row "<Name> · Local" with two icon buttons, then its props. No "Component" title, no grey band.
  2. An instance with no class still shows its props, above the "Inline styles come from…" notice.
  3. Type into a text prop: nothing reaches the canvas or source until Enter or click-away; Esc puts the old text back.
  4. Detach a component that uses a hook: the refusal sentence appears under the title with "Duplicate as a new file and edit that".
  5. Swap: a popover with a search field opens from the ⇄ button.
  6. Shift-select the instance and another layer: the component section disappears.
  7. A prop like `ariaLabel` or `fetchPriority` reads in full in the label column.

### canvas-23 — P2-D: resize that obeys CSS (IX-6a, 6b, 6c, 6d, IX-18, ERR-12)
- **Agent:** canvas-engineer · **Branch:** `fix/resize-obeys-css` off `28bbf963` · **PR:** #237 (draft, base `feat/canvas-excellence`; long form + gate triage in its body) · **Updated:** 2026-09-24
- **Stage:** verifying (draft PR open)
- **Goal:** an element resize writes what CSS will render, reads ⇧/⌥ live, keeps an absolute element's opposite edge, shows W×H, and no canvas drag outlives a lost release or a focus loss.
- **Done:**
  - `@core/studio-runtime`: `elementResizeRules.ts` rewritten (`resizeElementBox`: border-box geometry → CSS size per `box-sizing`, live modifiers, offsets for `absolute|fixed`, RTL `insetInlineStart`); new `elementResizeMeasure.ts` (`readResizeBoxStart`, `isPositionedFreely`) and `dragSessionGuard.ts`; `resizeHandles.ts` (live frames) uses all three plus the badge; `resize:commit` schema gains offsets; bridge bundle patched (see Landmines).
  - Portal: `useElementResizeDrag.ts` rewritten; new `canvas/elementResizeSizing.ts` routes each written axis through `elementSizing.ts`'s `sizingPatch('fixed')`, which gained an optional `flexCascade` (a class `flex: 1` → `flex: 0 1 auto`); restorable preview; one `setNodeInlineStyles` per drag.
  - IX-18: badge child of the handle frame (`CanvasResizeHandles.tsx`, CSS in `selectionChromeCss.ts`), text from the ring rect via `positionResizeFrame` (`canvasSelectionOverlayPositioning.ts`, `BreakpointSelectionOverlay.tsx` −1 line).
  - ERR-12: guard in resize (both hosts), reorder, insertion, prototype-link drag, comment pin, marquee, guide move + create (+ pointer capture and the iframe relay for both guide drags).
  - Found while testing, fixed: the click ending a resize bubbled to the page body and selected it (pre-existing).
- **Canvas files touched:** `useElementResizeDrag.ts`, `elementResizeSizing.ts` (new), `CanvasResizeHandles.tsx`, `canvasSelectionOverlayPositioning.ts`, `BreakpointSelectionOverlay.tsx`, `canvasFreeMove.ts`, `resizeOffer.ts` (doc), `useCanvasReorderDrag.ts`, `useCanvasInsertionDrag.ts`, `RulerGuidesLayer/RulerGuidesLayer.tsx`, `CanvasRulers/useRulerGuideCreation.ts`, `BoardPrototypeLayer/BoardPrototypeLayer.tsx`, `BoardCommentsLayer/CommentPin.tsx`, `BoardFramesLayer/useMarqueeSelection.ts`, `frameAdapter/FrameDocumentAdapter.ts`.
- **Decisions:** the badge shows only while a drag is live (single selection); flex companions are skipped for a positioned element; a lost release COMMITS at the last shown point, a blur CANCELS; the scale tool is read from the store at pointerdown.
- **Landmines:**
  - **Resize writes the CSS width, not the rect width.** Anything that measures a rect and writes a size must convert per `box-sizing` (`readResizeBoxStart`).
  - **Events × injectors:** the resize's key listeners run in CAPTURE on both the frame and parent documents and `stopPropagation` Shift/Alt/Escape, so the Alt tree ladder, K5 measure and the dispatcher's Escape-deselect never see them mid-drag. A bare Alt keyup is `preventDefault`ed (Windows menu focus would blur the page and abandon the drag through the guard).
  - **Events × height:** the badge hangs 6px + ~18px below the element; in a LIVE frame (no gesture freeze) a selection at the very bottom of the body can grow `scrollHeight` mid-drag.
  - **The guard's blur is only a hint** — focus moving into a frame blurs the parent window; it re-checks `document.hasFocus()` one task later. P2-B's pan-latch blur reset is separate and must stay separate.
  - `runtimeBridgeBundle.ts` was produced by applying the source diff to the committed artifact (the leftover drift from a local build equals the pre-existing bun-version drift). Re-run `studio-runtime:sync` on an LF tree before trusting the freshness gate.
- **Next:** owner dogfood (below and in the PR). Live frames still lack the flex companions (resolver needs stored styles across the wire).
- **Dogfood (`test4`, static tier, `/admin/site`, 100%, one frame):** (1) select a padded card, drag its E edge 40px: the box grows 40px (not 40 + padding), W×H pill under it while dragging, card still selected after; (2) a `flex: 1` row child: drag E, it stays where released; (3) ⇧ mid-drag without moving locks the ratio, ⌥ grows from the centre; (4) an absolute element's W handle: the right edge stays put; (5) drag a ruler guide over a frame and release there: the guide stops; Alt-Tab mid-drag: it snaps back.

## Blocked

*One line per item: id · question · who decides · since.*

- Nothing is blocked. Owner questions that gate future work are in `ROADMAP.md` §13 → "Open questions for the owner".

### panel-43 — P2-F: design pane spacing (UX-1, UX-2, UX-3, UX-5, UX-6)
- **Agent:** panel-designer · **Branch:** `feat/design-pane-breathing-room` off `3b5ead5e` · **PR:** #234 (draft, base `feat/canvas-excellence`) · **Updated:** 2026-09-23
- **Stage:** verifying (draft PR open; owner dogfood below)
- **Goal:** the owner's ask, "add spacing to segregate a bit, specially in between props and the element below", paid for in height (OD-4).
- **Done:**
  - Props block: `SectionStaticHeader` title (new export of `@ui/components/Section`, same 32px recipe as every section), 4px rows, 8px bottom padding, a hairline under it (`ModuleBlock.tsx/.module.css`).
  - New token `--inspector-section-gap: 12px` in `globals.css`; `.surfaceContent` uses it. The false "8px is Penpot's gap" comments are rewritten (Penpot = 8 gap + 8 margin = 16).
  - 4px within a group: Text (`StackedPropertyGrid rhythm="within-group"`), Measures, ComponentSection `.propsList`.
  - Shadow + Blur → one `effects` entry: `EffectsSection.tsx` + `EffectEditorPopover.tsx` (+ `.module.css`); the four old files are deleted. The manifest has 15 entries.
  - ClassPicker fade: `StyleSurface` sets `data-scrolled`; the `::after` is `opacity: 0` unless `.headerClassPicker:has(~ [data-scrolled='true'])`.
  - Gates: `measurement.test.ts` (15 entries, gap read from the token, P2-F structure pins), `inspector-height.e2e.ts` (F2 allowance 60 → 50), `inspector-panel-measurement.e2e.ts` (row deltas 48/74/77), `05-section-heights.json/.md`, `docs/features/inspector.md` §6 and G8, `ui-primitives.md`.
- **Measured (1400×900, room 746):** F1 608 → 598 · F2 782 → 772 (26 over) · F3 725 → 715 · F4 603 → 601.
- **Tokens added:** `--inspector-section-gap`.
- **Landmines:**
  - Both inspector e2e specs failed on the trunk before this change: the fixture now mounts a live frame as well (two canvas iframes). Both now wait for one iframe. Windows `EPERM` on fixture cleanup is caught and logged.
  - Parallel e2e runs collide on ports 5174/3002: use `E2E_VITE_PORT=5274 E2E_CMS_PORT=3102`.
- **Human action needed:** dogfood on `test4`, `/admin/site`:
  1. Select a text element: the props block has a bold 32px title, 4px between prop rows, 8px of air, then a hairline, then a wider gap before the opacity row.
  2. The sections below read as blocks: 12px between sections, 4px between Text's rows and between W/H, X/Y and rotation.
  3. Effects: one header with one `+`, listing Drop shadow, Inner shadow, Text shadow | Layer blur, Background blur. Add a shadow and a blur: both rows appear in one list. Alt+↓ on a shadow never moves it onto the blur.
  4. At rest, the Module title under the ClassPicker is not dimmed. Scroll the Design tab: the fade appears. Scroll back to the top: it goes away.
  5. Shift-select two layers with different shadows: Effects shows one "Mixed" row, and Drop/Inner shadow are disabled with a tooltip.

---

## Pending dogfood

*One line per item: id · route · what to look at. The script is in the entry (`docs/state-archive/2026-09.md`, grep the id) unless it says otherwise. Older scripts: [`docs/e2e/dogfood-backlog.md`](docs/e2e/dogfood-backlog.md). Delete a line once the script has been run.*

**Design pane (P2)**
- `panel-43` · `/admin/site` on `test4` · select a text element: props block ends in 8px + a hairline, 12px between sections, one Effects section; the ClassPicker fade only while scrolled. Script: the `panel-43` entry under `## Now`
- `panel-44` · `/admin/site` on `test4` · select a component instance: one "<Name> · Local" row with icon Detach/Swap under Measures, props visible even with no class, Esc reverts a text prop, hidden under multi-select. Script: the `panel-44` entry under `## Now`

**Element identity (P1)**
- `store-16` · a studio-imported page · select an element, have the agent insert a line above it: the ring stays on the same element; drag while an agent write lands: the drop moves what you grabbed. Spec: `tests/e2e/selection-follows-element.e2e.ts`
- `parser-p1a` (optional) · a page open on the board · edit the file in VS Code, then edit and delete on the canvas: only the intended element changes. Spec: `tests/e2e/element-identity-guard.e2e.ts`

**Live frames (Tier 2)**
- `live-10` · `/admin/site` on `test4` · the three frames swap from the static render to the real app; toggle RTL; edit a label and watch HMR carry it in
- `live-18` · a live frame · double-click text edits in place; Enter commits to source, Escape cancels
- `speed-04` · a Tier-2 board with `node_modules` installed · a cold click on a node selects it with one overlay, not two
- `speed-05` · `test4` · Delete on an element inside a shared local component opens the refusal dialog at once
- `live-09` · a frame · a runtime error in a page shows a red dot on that frame's header, and hover names the error

**Structure and drag**
- `store-11`, `store-13`, `verify-01` · any studio-imported page · ⌘D once writes one copy; after the resync the copy is selected; ⌘D ×5 fast gives one "Duplicated" card
- `perf-10` (both entries) · any studio-imported page · ⌘D, an Assets insert and ⌘G paint at once, and "Saving…" settles well under half a second
- `resil-01` · any project · restart the dev server mid page-create, board edit and duplicate: no toast, the gesture lands exactly once
- `struct-10`, `struct-11` · a source-backed page · ⌘G / ⌘⇧G write one wrapper that respects the HTML content model; everything else byte-identical in `git diff`
- `canvas-19`, `canvas-20`, `canvas-21` · a board with 3+ pages at 50 % · element drag (drop line, Alt duplicates, ⌘ places freely, Escape), cross-frame drag, file drop preview
- `keys-01` · 3+ frames · the keyboard dispatcher: Delete, ⌘D, paste beside the selection
- `canvas-18` · 2+ frames at 100 % and 50 % · Alt-hover measures distances and padding

**Inspector**
- `panel-39`, `panel-41`, `panel-37`, `panel-36` · a ~900 px window, text layer · the Design tab fits, or ends in one collapsed More row
- `panel-38` · a multi-selection · Fill, Layer, Shadow and Blur show Mixed honestly; a single selection looks unchanged
- `panel-35` · an absolute node in a relative parent · constraints, auto layout and the radius link each undo in one step
- `panel-33` (2026-09-17, colour picker) · a text layer with a `var()` colour · one click opens the picker and the swatch paints the value
- `panel-32` · a mobile breakpoint tab · Fill keeps a text colour the user declared at base
- `canvas-16` · a frame with a per-frame axes override · the override shows on the frame and can be cleared
- `panel-40` · any panel · a panel that throws takes out only that panel; hide/lock fan out over the selection

**Board, assets, performance**
- `panel-33` (2026-09-17, Assets), `panel-34`, `meta-12` · `test4` → Assets · every card is a live render; search finds "header", "pill", "row"; Colors swatches split light/dark
- `struct-08`, `struct-09` · `test4` · design-system components look exactly as before; the "retired package" banner migrates the imports
- `perf-07`, `perf-9` · a board with 12+ frames · zoom out and pan without blinking frames or re-flashing posters
- `canvas-17` · 4+ frames at 50 % · with a selection held still, no repeating work in a DevTools performance recording
- `perf-08` · 9+ frames · an agent snapshot of an off-screen breakpoint returns fast and the visible canvas does not move
- `proto-07` · prototype mode, 3+ pages · each of the five triggers shows only its own control
- `dev-04` · `bun run dev` · importing a project no longer full-reloads the editor
- `style-06` · a project with three stylesheets · creating a class writes silently or asks which stylesheet, never errors
- `mcp-25` · the AI panel · the bottom control strip row; one real agent turn

**Owner actions (not dogfood)**
- `git-21` · create a GitHub OAuth App with Device Flow and set `GITHUB_OAUTH_CLIENT_ID` (ROADMAP §13)
- `meta-17` · delete the archived scratch GitHub repositories, or grant `gh` the `delete_repo` scope

---

## Standing notes

*Durable operational facts, grouped by subsystem. Each: id · fact · date verified · where it is enforced. At most 120 lines. How the code works belongs in `docs/`, not here.*

### Workflow

**standing-05 — parallel-wave protocol.** When several agents touch Studio server handlers at once, each agent's routes live in their own file exporting a `tryServeStudio*(req, url, pathname)` sub-router that the orchestrator composes in `server/handlers/studio/subRouters.ts`, and each declares its paths in `routeCapabilities.ts` (`CLAUDE.md` → "Studio routes are declared, not guarded"). `STATE.md` is a single-file collision point: in a parallel wave, agents put their handoff in their PR body under `## STATE entry` and the orchestrator folds them in once. Two traps from wave 3 (`server-26`): a fresh worktree can be seeded far behind the trunk, so check `git log -1` against the trunk before starting; and the session scratchpad is shared between agents, so use a uniquely named scratch file and never re-read a shared path expecting your own content. · verified 2026-09-23 · `server/handlers/studio/subRouters.ts`

### Tooling

**standing-08 — never type-check with `npx tsc`.** The repo pins `typescript@~6.0.3`; `npx tsc` downloads a different compiler (5.9.x) that invents 100–200 phantom errors (`NodeList` iterator, `SchemaResult` narrowing). Use `bun run build` or `./node_modules/.bin/tsc -b`. Before reporting a large cross-cutting `tsc` breakage in files nobody touched, compare `npx tsc --version` with `package.json`. · verified 2026-09-23 · `package.json`

**standing-11 — the Write, Edit and Bash tools turn `\u0000` and `﻿` escapes typed in prose into raw bytes.** Build such text with `chr()` in Python (or `String.fromCharCode` in TS) and byte-scan the result. · verified 2026-09-23 · `src/__tests__/architecture/no-nul-bytes-in-source.test.ts` catches the NUL case

**CRLF checkouts** break the `*:sync` scripts and every regex that uses `.` over file text: see `PROJECT-BRIEF.md` → traps, and `.gitattributes`.

### Tests

**standing-01 — triage a red suite by running each unfamiliar failure on its own.** The current known-failure list is `ROADMAP.md` §13 → "Baseline" (16 on the trunk, 2026-09-23). Run the full suite, diff against that list, and run any other failing file alone before calling it yours or not yours: most past "flakes" were real leaks with findable causes. The recurring causes (`mock.module` is permanent, the editor-store leak, CRLF) are in `docs/agent-refs/conventions-quickref.md` → "Test traps". · verified 2026-09-23 · `src/__tests__/architecture/mock-module-must-restore.test.ts`

**standing-10 — `src/__tests__/setup.ts` makes `os.tmpdir()` the Studio workspace root for the whole suite.** A test that enumerates the workspace (rather than addressing one project) scans the machine's temp directory: slow and non-deterministic (`studio_list_projects` took 21–33 s against a 5 s budget, `mcp-24`). Give such a test its own workspace root, the escape `setup.ts` documents. `bun run test` is `bun test --parallel=4`, which `bunfig.toml` relies on; a bare `bun test` produces extra reds. · verified 2026-09-23 · `src/__tests__/setup.ts`, `package.json`

**standing-12 — `bun run test` writes no run summary when its stdout is redirected to a file.** Only the per-test `(fail)` lines survive; count those instead of looking for `N pass / M fail`. · verified 2026-09-18 (`server-26`)

**standing-13 — Chromium usually cannot launch inside a sandboxed agent worktree.** The browser process starts but the CDP handshake times out (180 s), even for a `data:` URL (`resil-01`). Write or extend the e2e spec anyway, try it once, and if the browser will not launch say so plainly in the handoff so the owner or CI runs it. · verified 2026-09-19 · `playwright.config.ts`

---

## Recently landed

*At most 10 one-liners, newest first: ids — what — PR — date. Everything here is merged into the trunk; full entries are in [`docs/state-archive/2026-09.md`](docs/state-archive/2026-09.md).*

- `mcp-27` — P4-B: the static prefix, mode and policy blocks reach the Claude CLI via `--append-system-prompt-file`; the warm-session fingerprint hashes the prompt; the generated `CLAUDE.md` is facts only — #231 — 2026-09-23
- `store-17` — P1-F: ScrubInput commits only when typed; undo resolves the owning page; a stale step is skipped, not jammed; refused moves/deletes roll back, network failures retry then roll back — #230 — 2026-09-23
- `server-29` — P1-D: a project watcher reloads the board on outside edits; an edit whose element moved is re-located by line diff + fingerprint, written only on exactly one match — #229 — 2026-09-23
- `server-28` — P1-H: `studio-workspace/` and `.data` on persistent volumes in every image/compose/template; boot refuses a root that overlaps data, uploads or code; security review fixed — #228 — 2026-09-23
- `mcp-26` — P4-A: tokens come from the CSS the canvas loads; `requiresWrite` + `sideEffects` (reads run in parallel, never deduped); no phantom tool names; schema errors say the expected shape — #227 — 2026-09-23
- `canvas-22` — P1-E3: SVG `style` becomes attributes + an object, Illustrator `<style>` classes are applied or refused, ids are suffixed per insert — #226 — 2026-09-23
- `asset-06` — P1-E2: one server rule for image URLs (percent-encoded), content dedupe, `wx` writes, keyed replay for asset-drop; security review fixed — #223 — 2026-09-23
- `parser-16` — P1-E1: detach fails closed — symbol-based substitution, spread/rest, aliasing, a free-variable gate; every refusal leaves files byte-identical — #224 — 2026-09-23
- `store-16` — P1-B: selection, hover, inline edit, entered instances and the drag follow their element across a reparse; a full reload is awaitable and sequenced — #222 — 2026-09-23
- `parser-p1a` — P1-A: element identity guard; a stale line:col write is refused as `element-moved` and silently re-planned — #221 — 2026-09-23

---

## Archive

Every entry that has left this file is in [`docs/state-archive/`](docs/state-archive/), verbatim, one file per month from 2026-09 (`2026-Q3.md` holds the older quarter). Find one through [`docs/state-archive/INDEX.md`](docs/state-archive/INDEX.md): one line per entry, `date · id · title · file`.
