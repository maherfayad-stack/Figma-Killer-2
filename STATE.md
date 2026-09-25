# STATE
> **Purpose:** live coordination only: what is in flight, what is blocked, what a human still owes · **Read when:** before any task; write at every stage boundary · **Trust:** live; a claim older than its Updated date may be stale · **Owner:** studio-scribe · **Verified:** 2026-09-23

Protocol: [`docs/agent-refs/handoff-protocol.md`](docs/agent-refs/handoff-protocol.md) · Plan: [`ROADMAP.md`](ROADMAP.md) · Decisions: [`docs/decisions.md`](docs/decisions.md) · History: [`docs/state-archive/INDEX.md`](docs/state-archive/INDEX.md)

**New entries go under `## Now`, never above it.** An entry is at most 40 lines; put the long form in the PR body and link it. Entry ids are `<area>-<nn>`: take the next free number in your area from `docs/state-archive/INDEX.md` and this file. This file stays under 400 lines; the section caps below are hard.

---

## Now

*At most 8 entries. Only work that is not yet merged into the trunk `feat/canvas-excellence`.*

### store-19 — P3-E: edits survive concurrent writes (ERR-9, WB-9, WB-10, WB-25, WB-32)
- **Agent:** store-engineer · **Branch:** `fix/edits-survive-concurrent-writes` off `25681dcb` · draft PR #254, base `feat/canvas-excellence`, long form in the body · **Updated:** 2026-09-25
- **Stage:** verifying — gates green except the pre-existing failures listed in the PR body.
- **Slices touched:** `site/lifecycleActions.ts` (`loadSite`, `patchPages`) + new `site/unsavedEditRebase.ts`. No new selector; no new mutation (no history entry, no coalesce key — a re-read is not an edit).
- **Done:**
  - ERR-9: a re-read REBASES unsaved edits instead of discarding them, on both reload paths, whoever wrote the file. `loadedValuesBaseline.ts` files the baseline each re-read replaced under its own `pages` array (`baselineBeforeRead`); the store diffs against it, aligns the pre-edit tree with the fresh one (`alignPageTrees`, then P1-A identity), writes local values onto the fresh nodes (per node all-or-nothing; never over a value now in code or a literal that moved/changed), keeps the page marked and `hasUnsavedChanges` true. The "an agent" toast is gone; a loss says its cause. `usePersistence` no longer clears the flag after a full reload.
  - WB-9: `setJsxText` writes raw JSX text, keeps surrounding whitespace, re-wraps over the original lines; `{"…"}` only when needed or already used, in its own quote. WB-10: `setJsxStyle` keeps the object's quote and layout; `setJsxProp` keeps the attribute quote. Shared `ast-codemods/stringSpelling.ts`.
  - WB-25: one ts-morph project per batch (`syncProjectWithDisk` before each edit), position-indexed `findJsxElementAtLocation`. 40 edits, 1,500 elements, under the lock: prop 17.4 s → 1.4 s, text 19.5 s → 0.8 s, style 20.5 s → 1.3 s (medians) (this machine; audit: 3.8 s).
  - WB-32: locale JSON splices the value span; a created key re-serializes in the file's indent/EOL/final newline.
- **Decisions:** local wins on a plain-value conflict (same answer as P1-D's flush-first save); an origin-backed (literal) value never wins a conflict. A page list no Studio read produced has no baseline and is adopted as-is.
- **Landmines:** (1) `baselineBeforeRead` is keyed by array IDENTITY — a caller that copies `pages` between the fetch and `patchPages`/`loadSite` silently loses the rebase. (2) Structural codemods still get their own project (one write per gesture). (3) Old tests asserted `{"…"}` text spellings; updated.
- **Next:** orchestrator merges. Collision: `lifecycleActions.ts` is serial with P6-A (P1-B already in).

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
- **Next:** Phase 2 is merged (P2-I #245: hover worst frame 169–183 → 21–33 ms, warm click → ring 292–440 → 78–85 ms; cold-click A/B showed no P2-A regression). Phase 2 exit gate: budgets pass; the owner dogfoods P2-F spacing and the P2-B/C/D/E gestures on `test4`. Running: P2-C2 bulk actions (OD-16), P3-C. Merged since the exit gate: P2-F #234, P2-A #235, P2-G #236, P2-D #237, P2-B #238, P2-H #239, P2-C #242, P2-E #243 (+ OD-15); P3-B #240, P3-A #244; P4-C #233, P4-D #241. Then P4-E, P3-C/D/E/F, P0-I. Owner: `CLAUDE.md`'s budget-spec list should name `canvas-feel-budgets.e2e.ts`; regenerate `runtimeBridgeBundle.ts` with `studio-runtime:sync` on an LF tree (bun 1.3.11).

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

### infra-02 — P0-I: CI runs `bun run test` on one pinned Bun
- **Agent:** studio-implementer · **Branch:** `chore/ci-pin-bun-and-run-tests` off `25681dcb` · **PR:** #253 (draft, base `feat/canvas-excellence`; long form in its body) · **Updated:** 2026-09-24
- **Stage:** done (draft PR open)
- **Goal:** re-land #86's CI half: `bun run test` (isolated workers) instead of bare `bun test`, on a pinned Bun.
- **Done:** `engines.bun` = exact `1.3.13`; every `setup-bun` step reads it (`bun-version-file: package.json`); Dockerfile `oven/bun:1.3.13`. `ci.yml` `test` and `release.yml` run `bun run test --shard=N/10` as a 10-runner matrix; new `generated-fresh` job runs `studio-runtime:sync` + `bootstrap:sync` on Linux, fails on drift and uploads `regenerated-bundles`. Both studio-runtime bundles regenerated with bun 1.3.13 from an LF export. New gate `architecture/bun-version-pinned.test.ts`. Docs: `docs/architecture.md` → "Bun is pinned to one exact version", `architecture-tests.md`.
- **Decisions:** 1.3.13, because (a) Bun 1.3.6 and 1.3.11 have no `--parallel`/`--shard`: they silently ignore them, so `bun run test` there IS bare `bun test`; (b) 1.3.11 and 1.3.13 emit byte-identical bundles, 1.3.6 does not. Exact pin, not a range, because `Bun.build` bytes differ between patch releases.
- **Landmines:** the owner's bun 1.3.6 fails `studio-runtime-bundle-fresh` against the (correct) regenerated bundles and runs the suite un-isolated. Fix: install 1.3.13 (`powershell -c "& ([scriptblock]::Create((irm bun.sh/install.ps1))) -Version 1.3.13"`). The committed `vitePluginBundle.ts` was stale on SOURCE (missing `SourceOriginSchema`), not only on version. Any bundle that edits `src/core/studio-runtime/*` conflicts on the one-line generated files: resolve by regenerating (or take CI's artifact).
- **Human action needed:** upgrade local Bun to 1.3.13. `ci.yml` only triggers on PRs to `main`, so this runs for the first time when the trunk PR goes to `main`.
- **Verification:** `actionlint` 1.7.12 clean on both workflows (they cannot run locally). Build and lint clean. The new gate fails 3/3 with the old pins. Suite in 11 locked chunks (bun 1.3.6): 15 fail, all baseline (freshness, optimistic broadcast ×4, bridge measurement ×5, render_reference ×4, liveOrigin WS). The freshness gate passes on 1.3.13 and 1.3.11. Shard 1/10 on 1.3.13 `--parallel=4`: 141 files, 5.2 GB peak, 127 s.
- **Next:** orchestrator review.

### test-07 — Green baseline: the 16 pre-existing unit failures and the broken e2e specs
- **Agent:** test-engineer · **Branch:** `test/green-baseline` off `25681dcb` · **PR:** #257 (draft, base `feat/canvas-excellence`; per-failure table in its body) · **Updated:** 2026-09-25
- **Stage:** verifying (draft PR open)
- **Goal:** the baseline every bundle reports shows no pre-existing red, so a real regression is visible.
- **Done (unit):**
  - `structuralOptimisticBroadcast` ×4, `useBridgeComputedValues` ×4, `fillSection` ×1: their stub channels never said `ready`, and `BridgeFrameAdapter.post` queues every message until it does. The stubs now announce `ready`, like `optimisticStructuralBroadcast.test.ts`.
  - `referenceRender` ×4: since `live-16` a dev server writes to `options.logPath` and the manager tails that file; the fake filled `stdout`, so every boot hit the 30 s race. The fake now writes to the log file; each test gets its own `STUDIO_DEV_SERVER_STATE_DIR` and stops its server.
  - `liveOrigin` WebSocket: **product fix** in `server/liveOrigin.ts`. Bun's `upgrade` already echoes the first offered subprotocol; passing it in `headers` too sent the header twice on Bun 1.3.6 (1.3.13 de-duplicates), and a checking client refuses that (1002). Proven on both Bun versions; a raw-handshake test asserts one header.
  - `withWorkspaceProject` Windows path: already fixed on the trunk by P1-C; passes.
  - Bundle freshness: not regenerated (P0-I owns the Bun pin). The gate now names the running Bun and the first differing line, and says whether it is Bun's runtime helpers, a cwd-relative `// node_modules/` comment, or real drift.
- **Done (e2e):** `tests/e2e/helpers/canvasIframe.ts` (`visibleCanvasIframe`, `canvasContentFrame`, `liveBridgeIframe`, `settleCanvasFrameMode`, `selectionRings`) replaces every bare `frameLocator` in 30 files. Fixed-name fixtures are emptied in place (`emptyFixtureDir`): EPERM reproduced with `--repeat-each=2`. `readBoardCounts` counts per board frame (`mountedFrames`). studio-feel ⌘D now asserts five copies in the file and zero toast cards (P3-A removed success toasts; the queue removed the refusal).
- **Landmines:** in the e2e workspace a fixture's Vite resolves from this repo's `node_modules`, so Tier-2 frames really go live some seconds into a spec. A portal frame draws its selection ring inside its iframe, a live frame in the editor document: settle first.
- **Verified:** chunked unit suite (16 chunks, `--parallel=1`, under the lock): 1 failure left, bundle freshness (P0-I). e2e: `structural-writeback` 5/5 with `--repeat-each=2` (failed on EPERM with the old helper); `studio-feel` 5 pass + 1 pre-existing conditional skip.
- **Found, not fixed:** Tier-2 frames never get a poster (perf-06 Phase B), so `studio-board-perf`'s WS-5.3 poster criterion still fails on the default tier; its virtualization counts now pass. `studio-feel-phase0` still waits for success toasts P3-A removed (⌘D, Alt+drag, ⌘G, save chip). The runtime bundles were built by two different Bun versions and one from a different cwd.
- **Next:** orchestrator review; P0-I regenerates the bundles on the pinned Bun.


### canvas-28 — Live-frame parity: resize, snap, rollback, double-click and hover in Tier 2 frames
- **Agent:** canvas-engineer · **Branch:** `fix/live-frame-parity` off `25681dcb` · **PR:** draft, base `feat/canvas-excellence` (long form in its body) · **Updated:** 2026-09-24
- **Stage:** verifying (draft PR open; owner dogfood below)
- **Goal:** gestures fixed in static frames in Phases 1–2 behave the same in live (Tier 2, Vite) frames: canvas-23, canvas-26, store-17, canvas-24, perf-12's hover note.
- **Done:**
  - canvas-23: the parent sends the node's stored `flex`/`alignSelf`/`justifySelf` with `setResizeTarget`; the runtime plans the Fixed companions with the SAME resolver as the portal drag and previews a clear as the cascade value. `resize:commit` carries them (`flex: '0 1 auto' | null`, `alignSelf`/`justifySelf: null`) and rejects any other key.
  - canvas-23 badge: the runtime hides its overlay root for the `scrollHeight` read (handles and badge are not content) and reports no `frame:resize` while a resize is live (`onGestureChange`), once after.
  - canvas-26: the parent sends the tree siblings, tree parent and zoom; the runtime snaps the moving edge (`elementResizeSnapRules.ts`) and posts `resize:guides`, painted in the parent drag layer (`elementResizeGuides.ts`).
  - store-17: new `optimistic.revert`; `structuralCommitRollback.ts` broadcasts it for the gesture's own nodes (`trackStructuralTreeCommit` takes them).
  - canvas-24: `text:editStart` carries the stamped ancestor chain; the adapter resolves the nearest KNOWN node, like a click; the runtime accepts a reply for any ref in the chain.
  - perf-12 note: static frames only (live frames resolve hover per move). A leave hands the hover to `relatedTarget`'s node (`canvasHoverHandoff.ts`); `onMouseLeave` now receives the event.
- **Moved to `@core/studio-runtime`** (one implementation for both hosts): `elementSizing.ts` → `elementSizingRules.ts`, `canvasSnapPeers.ts` → `snapPeerRules.ts`, the pure half of `boardSnapping.ts` → `snapRules.ts`, and the plan/snap halves of `elementResizeSizing.ts`/`elementResizeSnap.ts`. The admin keeps `elementResizeInlinePreview.ts` and `elementResizeGuides.ts`. `resizeMessages.ts` split out of `messages.ts`.
- **Canvas files touched:** `canvas/{useElementResizeDrag, elementResizeInlinePreview (new), elementResizeGuides (new), resizeTargetContext (new), canvasHoverHandoff (new), useBridgeSelectionChrome, NodeRenderer (leave only), boardSnapping, canvasFreeMove, canvasDragPainter, useAnnotationInteraction, BoardFramesLayer/{useBridgeFrameInteraction, useBoardFrameMoveDrag}, frameAdapter/{FrameDocumentAdapter, BridgeFrameAdapter, PortalFrameAdapter, optimisticStructuralBroadcast}}`; `core/studio-runtime/{runtime, resizeHandles, inlineTextEdit, gestureForwarding, nodeDom, optimisticDomOps, messages, messageShapes, index}` + the new rule modules + `generated/runtimeBridgeBundle.ts` (regenerated by `studio-runtime:sync`, never hand-patched).
- **Landmines:**
  - **Height × injectors:** runtime chrome sits inside `<body>`, so anything it draws below an element counts in `body.scrollHeight` = the reported frame height. Anything new drawn under an element needs the gesture freeze. Documented in canvas-internals → "Height".
  - **Events × height:** the freeze ends in `finish()` AFTER `RESIZE_ACTIVE_ATTR` is removed (badge hidden), then one `scheduleFrameResize`. Reordering those re-measures the badge.
  - **Events × store:** a live resize's companions come from the markers the parent sent at the LAST `setResizeTarget`. They are re-sent on change (primitive selectors), but a drag started before the HMR lands plans from the old markers.
  - **Wire:** `text:editStart` now requires `ancestors`; `resize:commit.patch` is `additionalProperties: false`.
  - `runtime.ts` is 694/700 lines, `messages.ts` 694/700.
- **Tests (each failed with its fix disabled in place):** `studio-runtime/{liveFrameParity (5), resizeHandles (+5), elementResizeSizing (+2), messages (+3)}`, `canvas/frameAdapter/BridgeFrameAdapter (+5)`, `editor-store/undoTellsTheTruth (+3)`, `canvas/canvasHoverOffStore (+2)`, `canvas/useBridgeSelectionChrome (+1)`. e2e `tests/e2e/live-frame-parity.e2e.ts` (store-17, badge, flex, snap on a live SMS frame).
- **Next:** owner dogfood (Pending dogfood → `canvas-28`). P5-G/B/D regenerate the bundle after this lands.

## Blocked

*One line per item: id · question · who decides · since.*

- Nothing is blocked. Owner questions that gate future work are in `ROADMAP.md` §13 → "Open questions for the owner".

## Pending dogfood

*One line per item: id · route · what to look at. The script is in the entry (`docs/state-archive/2026-09.md`, grep the id) unless it says otherwise. Older scripts: [`docs/e2e/dogfood-backlog.md`](docs/e2e/dogfood-backlog.md). Delete a line once the script has been run.*

**Design pane (P2)**
- `panel-43` · `/admin/site` on `test4` · select a text element: props block ends in 8px + a hairline, 12px between sections, one Effects section; the ClassPicker fade only while scrolled. Script: the `panel-43` entry in the archive
- `panel-44` · `/admin/site` on `test4` · select a component instance: one "<Name> · Local" row with icon Detach/Swap under Measures, props visible even with no class, Esc reverts a text prop, hidden under multi-select. Script: the `panel-44` entry in the archive
- `panel-45` · `/admin/site` on `test4`, dark AND light · field hover lifts, Layers keyboard ring + selected ≠ hovered, forceOpen headers are plain titles, notice cards on the 12px gutter, skeletons on first open. Script: the `panel-45` entry in the archive

**Assistant (P4)**
- `mcp-28` · the Agent panel with an Anthropic API key (not the CLI) · ask it to build a screen: it reads, writes and edits files; asking it to edit `vite.config.js` or `package.json` is refused as needs-you. Script: the PR #233 body
- `mcp-29` · a mobile project, CLI and API-key paths · "design a checkout screen, 3 directions": variants use app bands, sit side by side with a note each; select two elements and ask "what are these": the reply names both file:lines; "make the brand colour coral" edits one `--brand` declaration. Script: the PR body

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
- `canvas-23` · `/admin/site` on `test4` · resize a border-box and a content-box element (the CSS width lands exactly), a `flex: 1` child (goes fixed; static frames only), ⇧/⌥ mid-drag, the W/N handles of an absolute element, the W×H badge; release outside the window ends the drag. Script: the `canvas-23` entry in the archive
- `canvas-24` · `/admin/site` on `test4` · ⇧-click toggles; Tab cycles siblings (never in a panel); ⌘A climbs; V; zoom keys from a panel; Space + Alt-Tab never sticks; a click on a component selects the outermost instance. Script: the `canvas-24` entry in the archive
- `canvas-25` · `/admin/site` on `test4`, SMS · arrows nudge the absolute banner (one save, one ⌘Z), reorder a code input, stand down in a panel. Script: the `canvas-25` entry in the archive
- `canvas-26` · `/admin/site` on `test4`, 100% and 50% · snaps feel the same at both zooms (move and resize, parent edges too), the drop's container is outlined, Alt off-node measures to the parent, a Layers click then → moves the layer. Script: the `canvas-26` entry in the archive
- `canvas-27` · `/admin/site` on `test4`, SMS · two absolute layers nudge together (one save, one ⌘Z), two code inputs step together, ⌥↓ on a pair, a mixed selection nudges only the absolute one. Script: the `canvas-27` entry in the archive
- `canvas-28` · `/admin/site` on `test4` (live tier), SMS frame, 100% and 50% · a code input's E handle: it follows the pointer and keeps its width after the save; near a sibling's edge it snaps with a guide; the page's `<main>` E handle at the frame bottom: the frame never grows; a refused delete comes back; a double-click on a component's text opens it; child → parent hover keeps the parent's ring. Script: the `canvas-28` PR body

**Inspector**
- `panel-39`, `panel-41`, `panel-37`, `panel-36` · a ~900 px window, text layer · the Design tab fits, or ends in one collapsed More row
- `panel-38` · a multi-selection · Fill, Layer, Shadow and Blur show Mixed honestly; a single selection looks unchanged
- `panel-35` · an absolute node in a relative parent · constraints, auto layout and the radius link each undo in one step
- `panel-33` (2026-09-17, colour picker) · a text layer with a `var()` colour · one click opens the picker and the swatch paints the value
- `panel-32` · a mobile breakpoint tab · Fill keeps a text colour the user declared at base
- `canvas-16` · a frame with a per-frame axes override · the override shows on the frame and can be cleared
- `panel-40` · any panel · a panel that throws takes out only that panel; hide/lock fan out over the selection
- `parser-18` · a page calling `<Header title="…"/>` · double-click the heading and retype it: the page's `title="…"` changes, `Header.tsx` does not; a new class in a project with two stylesheets saves with no dialog; restyle one row of a `.map` list → "Applied to all N rows" and every row changes; add a class to an element whose `className={cond ? …}` is code → it saves

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

- `docs-16` — docs: 29 stale plan citations repointed, duplicate rows removed, agent-refs brought up to P1–P4, inspector §G12/§9.4 current; owner reviews the CLAUDE.md and studio-scribe.md edits — #252 — 2026-09-23
- `mcp-31` — P4-F: per-turn checkpoints with Revert turn / per-file revert (hash-verified, CAS, gated), streaming tool progress, Haiku compaction, `studio_propose_plan`; security re-review approved — #251 — 2026-09-23
- `mcp-30` — P4-E: `studio_find_icon`, `studio_find_image` (Pexels, attribution), fonts/assets lists, a vouched-host fetch policy, a sandbox CSP on served SVG/HTML; security re-review approved — #248 — 2026-09-23
- `parser-18` — P3-C: call-site and origin writes, automatic stylesheet choice, winning-declaration CSS edits, @container/@supports, spread-safe styles, className wraps, alias imports, .map row templates (OD-8 style) — #247 — 2026-09-23
- `canvas-27` — P2-C2: arrows, ⌥↑/↓ and ⌘[/] move a whole multi-selection as one undo and one write; grid ↑/↓ move a row; bulk-action audit — #246 — 2026-09-23
- `perf-12` — P2-I: hover off the store, keyed selection, stable selection context; hover worst frame 169–183 → 21–33 ms, warm click → ring 292–440 → 78–85 ms; cold-click A/B: no P2-A regression — #245 — 2026-09-23
- `store-18` — P3-A: per-edit save outcomes (successes commit, refusals named and re-sent), save-time refusals warn with "Open in code", no success toasts on gestures, chrome error boundaries; error toast sites 128 → 104, pinned — #244 — 2026-09-23
- `canvas-26` — P2-E: one snap threshold (8 screen px ÷ zoom), parent edges/padding/centre snap, resize edges snap (static frames), drop outlines the landing container, Alt measures to the parent; OD-15 arrows after a Layers click — #243 — 2026-09-23
- `canvas-25` — P2-C: arrows nudge an absolute layer 1/10 px or reorder a flow child, one undo + one write per held key; free move writes camelCase `insetInlineStart` — #242 — 2026-09-23
- `mcp-29` — P4-D: one rewritten prompt for both paths (craft rubric, self-critique, real content, no eSIM facts), archetypes, component snippets, multi-width screenshots, `studio_arrange_frames`, `studio_set_tokens`, selection digest — #241 — 2026-09-23

---

## Archive

Every entry that has left this file is in [`docs/state-archive/`](docs/state-archive/), verbatim, one file per month from 2026-09 (`2026-Q3.md` holds the older quarter). Find one through [`docs/state-archive/INDEX.md`](docs/state-archive/INDEX.md): one line per entry, `date · id · title · file`.
