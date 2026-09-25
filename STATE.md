# STATE
> **Purpose:** live coordination only: what is in flight, what is blocked, what a human still owes · **Read when:** before any task; write at every stage boundary · **Trust:** live; a claim older than its Updated date may be stale · **Owner:** studio-scribe · **Verified:** 2026-09-23

Protocol: [`docs/agent-refs/handoff-protocol.md`](docs/agent-refs/handoff-protocol.md) · Plan: [`ROADMAP.md`](ROADMAP.md) · Decisions: [`docs/decisions.md`](docs/decisions.md) · History: [`docs/state-archive/INDEX.md`](docs/state-archive/INDEX.md)

**New entries go under `## Now`, never above it.** An entry is at most 40 lines; put the long form in the PR body and link it. Entry ids are `<area>-<nn>`: take the next free number in your area from `docs/state-archive/INDEX.md` and this file. This file stays under 400 lines; the section caps below are hard.

---

## Now

*At most 8 entries. Only work that is not yet merged into the trunk `feat/canvas-excellence`.*

### store-20 — P6-A: reconcile after writes (PERF-6)
- **Agent:** store-engineer · **Branch:** `perf/reconcile-after-writes` off `74425627` · draft PR #266 (base `feat/canvas-excellence`), long form in the body · **Updated:** 2026-09-25
- **Stage:** done, awaiting merge — build + lint green; `bun test` (chunked) adds no failure (pre-existing + load timeouts triaged in the PR body); e2e `studio-board-perf` 2 failures reproduce with the change disabled.
- **Slices touched:** `site/lifecycleActions.ts` (`patchPages`, and `createSite`/`loadSite`/`clearSite` clear the render keys), `site/reparseNodeFollow.ts` (optional `alignments` input, shared). New `site/rereadRenderKeys.ts`, `canvas/nodeRenderKeys.ts` (off-store), `@core/utils/replaceEqualDeep`. No new selector; no new mutation (a re-read is not an edit: no history entry, no coalesce key).
- **Done:**
  - `patchPages` applies a re-read by value: each re-read page, `styleRules` and `conditions` go through `replaceEqualDeep`, so a deep-equal node, rule, registry or page keeps its object. A prop write re-renders one `NodeRenderer`, not the whole page, and restyles no frame (was 12 of 12).
  - A renumbered node keeps its React key: `rereadRenderKeys.ts` aligns each changed re-read page (`alignPageTrees`) and carries keys through `nodeRenderKeys.ts`; `NodeRenderer` and `CanvasComposedTree` key children by `nodeRenderKey(pageId, id)`. A move remounts nothing (was 297 of 300). The follower reuses the alignment.
  - Bench: `bench:editor-store` "Post-write re-sync" (`scripts/bench/lib/postWriteResync.ts`), counts are a budget; before/after table in its doc.
- **Decisions:** always align a changed page (an unchanged id SET is not a shortcut: a move among same-size siblings permutes addresses). Keys are per page and unique among siblings (minted key when a new node takes an address a moved one carries).
- **Landmines:** (1) a shared parent whose child keys changed is COPIED (`rereadRenderKeys.ts`), or it would not re-render and keep stale keys — test `nodeRendererPostWriteRerender.test.tsx` "permutes". (2) Only frames with `CanvasPageContext` carry keys. (3) The move pays ~2.5 ms more in the store (one alignment) to save 297 remounts.
- **Next:** orchestrator merges. Collision: `lifecycleActions.ts` (serial; P1-B/P3-E in). P3-D (#250) touches the structural commit path, not `patchPages`.

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

### panel-46 — "Found along the way": six small bugs other bundles recorded
- **Agent:** panel-designer · **Branch:** `fix/found-along-the-way` off `65f5026d` · **PR:** #259 (draft, base `feat/canvas-excellence`; long form in its body) · **Updated:** 2026-09-25
- **Stage:** done (draft PR open; owner dogfood and `CLAUDE.md` review below)
- **Done:**
  1. `StyleWriteLockContext` now has a provider: `StyleSurface` wraps the mounted sections with `partialStyleWriteLock(model.inlineWriteReach)`. `SelectionModel.blockedPropertyCounts` → `inlineWriteReach` (built by `buildInlineStyleWriteReach`; `null` for one layer or a class target). A partial `ClassPropertyRow` underlines its label (dotted `--warning`). Dead `blockedStyleWriteLock` deleted.
  2. Dark `--text-subtle` `#787878` → `#888888` (floating `--bg-surface` 3.9 → 4.9:1; docked 5.9:1).
  3. `optimistic.text` deleted from `OptimisticDomOps` and both adapters.
  4. `renderIconReference` (built-in DS): teaches `?raw` from `design-system/icons/…` for every icon (the load copies it in).
  5. `CLAUDE.md` → "UI error handling" states the P3-A policy + `error-toast-sites.test.ts`.
  6. `useLocalComponentCatalog()` returns `null` in flight; `ComponentSection` draws disabled skeleton rows per call-site prop; a settled catalog is read on first render.
- **Tests (each failed with its fix disabled in place):** `styleSurfacePartialWrite.test.tsx` (new, 4), `measurement.test.ts` (+floating AA), `projectGuide.test.ts` (icon guide), `componentSection.test.tsx` (+2).
- **Tokens:** changed dark `--text-subtle`; none added.
- **Verification:** trunk `fea4f125` merged cleanly. `bun run build` and `bun run lint` clean. Chunked suite under the lock (`--parallel=1`): `src/__tests__/architecture` + rest (only the flaky `publicSdkExports`, which passes alone), `src/core` (117 files, 1689 pass, 0 fail), `server/handlers/studio` (82 files, 1205 pass, 0 fail); the bundle's own 8 test files pass after the merge.
- **Landmines:**
  - Only `ClassPropertyRow` reads the lock. `ScrubInput` fields (W/H, X/Y, rotation angle) don't; `MultiSelectTargetBar` states their counts above the sections.
  - The runtime half of `optimistic.text` (`messages.ts` schema, `runtime.ts` case, `applyOptimisticText`, the generated bundle) is left for `live`, which owns `runtime.ts`.
  - Nothing in the app provides a `blocked` lock; the state stays for `classPropertyRowWriteLock.test.tsx`'s row contract.
- **Human action needed:** dogfood on `test4`, `/admin/site`: (1) shift-select two `.map` rows whose `transform`/`style` comes from row data plus one static element, then hover a row the notice names: its label has a dotted amber underline and the tooltip reads "Writes to 1 of 3 selected layers — 2 are set from an expression in code."; (2) dark theme, floating inspector: captions/units readable; (3) reload, select a component instance with a union prop: grey placeholders, then a dropdown — never a text box first; (4) owner review of the `CLAUDE.md` diff.

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
### sec-24 — security hardening follow-ups (mcp-28 / mcp-30 open items, P1-E2 found-not-fixed)
- **Agent:** security-guard · **Branch:** `fix/security-hardening-followups` off `25681dcb` · **PR:** #256 (draft, base `feat/canvas-excellence`; the item | threat | fix | test table and the adversarial inputs are in its body) · **Updated:** 2026-09-24
- **Stage:** verifying (draft PR open; review #256 B1 fixed, needs security-guard re-review of it)
- **Goal:** close the follow-ups that reviews #233 and #248 deferred, each with a test that failed with its fix disabled in place.
- **Done:**
  - `ssrfGuard.ts` parses addresses to bytes: NAT64, SIIT, IPv4-compatible, 6to4, Teredo, doc/benchmark ranges, multicast, broadcast; fails closed. The plugin gated fetch now PINS the connection to the validated address (it re-resolved before: DNS rebinding).
  - CSP: `appendContentSecurityPolicy` adds each policy separately (a route's `frame-ancestors` can no longer win).
  - `studio_upload_asset` is a server tool on `landAgentAsset` (agent gate, lock, turn log); browser half deleted.
  - Scaffolds never write through a link: `isUnlinkedWorkspacePath` (Studio-owned files: shell, guide, design-system, `.studio`), lstat + `wx` for page/i18n/seed. The shell used to overwrite a linked `vite.config.js` target on first open.
  - One read decoder `resolveWorkspaceReadPath` (asset route + edit targets), case-folded; git paths, archive entries, workspace walk fold case.
  - R1 residuals in `hostConfigImports.ts` + a new CONTENT half of the one gate (`agentContentRefusal`: adding a Tailwind `@plugin`/`@config` needs the user).
  - `devServer.ts` runs the project's own Vite bin (`viteLaunch.ts`); `predev`/`postdev` never run (measured on `__vite-live-fixture`: they did under `bun run dev` and `npm run dev`).
  - Guide generator: prune only where Studio's manifest exists and the hash matches; nothing through a link.
  - `writeFileAtomic` for agent overwrites (temp + fsync + rename; EPERM retry then in place; mode kept).
  - Review #256 B1 fixed: `parseTailwindLoadDirectives` reads `@plugin`/`@config` the way tailwindcss@4 does (comments stripped, ANY wrapping, since Tailwind takes `params.slice(1,-1)`); the content gate judges EVERY agent text write (`<style>` in .html/.vue/.svelte too); the closure scan uses the same parser. Nits: EPERM in-place fallback never follows a link (O_NOFOLLOW, lstat on Windows); `gitOperations` exclusion is case-folded.
- **Decisions:** exec Vite directly rather than `--ignore-scripts` (pnpm/yarn/bun differ; no shell at all now); Node runtime kept (fidelity), Bun only without Node. TEST-NET ranges are blocked, so tests that used 203.0.113.x as "public" now use 93.184.216.34.
- **Landmines:**
  - P4-F (#251) is in the trunk; the merge (`a5855b96`) kept both sides: the checkpoint pre-image is taken BEFORE `writeFileAtomic`, and the hook runs the content refusal beside `agentWriteRefusal` before its pre-image capture. Keep that order.
  - Dev-server test fixtures need an installed stub Vite: `writeViteProject` (`viteLaunch.testHelpers.ts`).
  - `checkContent` now takes `before` (the file's current text, `null` for new).
- **Found, not fixed:** git clone keeps a repo's own `.studio/` (possibly a link) — every `.studio` store writes through it; Vite under Node binds `::1` for `localhost` while `devServerOutput` pins `127.0.0.1` (pre-existing; scaffolded configs pin the host). Details in the PR.
- **Verification:** build + lint clean (before and after merging the trunk `c5dac965`+, which brought P4-F). Full suite in sequential locked chunks; every failure is pre-existing: studio-runtime bundle freshness; `module-size-budgets` (trunk's `agentCheckpoints.ts`, 789 lines, not touched here); 4 `studio_render_reference` dev-server timeouts (reproduced with this PR's spawn change reverted in place); bridge measurement (`useBridgeComputedValues` x4, `FillSection`); optimistic broadcast x4; liveOrigin WebSocket. Flaky under load, pass alone: `assetLanding` concurrent-process landing, `publicSdkExports`. No e2e: server-only change; the live dev-server path was run for real on `__vite-live-fixture` instead.
- **Next:** security-guard re-review.
### canvas-28 — P5-B: drop images onto the canvas (IMG-2, 3, 7, 8, 9; IX-img)
- **Agent:** canvas-engineer · **Branch:** `feat/drop-images-onto-the-canvas` off `25681dcb` · **PR:** #258 (draft), base `feat/canvas-excellence` (long form, dogfood script and "Found, not fixed" in its body) · **Updated:** 2026-09-24
- **Stage:** verifying (draft PR open; owner dogfood below)
- **Done:** N dropped images are ONE `insert` edit (`InsertEditSchema.siblings`, `insertJsxElement` writes a run in one splice and reports every created id, all or none): one write, one resync, one ⌘Z. Drop ON an `<img>` replaces it (⌥ inserts): literal `src` → `asset-drop` + `updateNodeProps`; import-bound → `asset-upload` beside the old file + `kind:'asset'` via `commitStudioAssetReplace` with the new undo template `known`. Ghost per file from its object URL (`previewOptimisticInsertRun`) + XHR progress into `--studio-upload-progress`. `width`/`height` = intrinsic, clamped to the container content box. ⌘-drop = K6 absolute (static parent refuses with K6's dialog). ⇧-drop = top background layer, inline; refused when a class owns the background. "Insert image…" command (`insert.image`) = picker, images land beside the selection. **Fixed on the way:** drop surfaces registered only for the ACTIVE frame, so an OS file drop onto a not-yet-clicked frame always refused "Drop onto a frame" (found by the e2e; `BreakpointSelectionOverlay` now gates registration on the permission alone). And the canvas `<img>` ignored the authored `width`/`height` (`base.image`'s `ImageEditor` now renders them), so the canvas never showed the size the source says.
- **Decisions:** one XHR upload client, `@core/http`'s `apiUploadRequest` (reuses `retryPlanFor`/replay key/envelope/schema); `dropStudioAsset`, `uploadStudioAsset`, `uploadDesignReference` moved onto it. `commitStructural` + options moved to `studio/studioStructuralCommitEngine.ts` (size gate). Server `created` is a list end to end (`StructuralEditOutcome`, `StudioEditApplyOutcome`).
- **Files touched (canvas):** `modules/base/image/ImageEditor`, `canvas/{canvasFileDrop, canvasFileDragPreview, useCanvasFileDrop, canvasFrameDragRelay, EditorChromeInjector, BreakpointSelectionOverlay, canvasImageDropPlacement (new), canvasImagePicker (new), canvasUploadProgress (new)}`. Also `store/slices/site/{imageDropActions, imageDropShapes (new), structuralOptimism, structuralSourceHistory, types, nodeActions}`, `studio/{studioStructuralCommits, studioStructuralCommitEngine (new), structuralUndoPlan, dropStudioAsset, uploadStudioAsset, uploadDesignReference, projectAssets}`, `core/http/{uploadRequest (new), apiClient, index}`, `core/ast-codemods/insertJsxElement`, `server/handlers/{studioStructuralWriteback, studioEditSchemas, studioWriteback}`, `spotlight/{commands/images (new), builtinCommands}`.
- **Landmines:**
  - **Events × history:** the drop HOLDS the structural queue (`beginStructuralCommit`) from before the upload until `commitStructural`'s own end; a drop where nothing lands releases it itself. Any new early return in `dropImagesIntoPage` after the begin must call `endStructuralCommit()` or every later structural gesture queues forever.
  - **Injectors × events:** the ghost's uploading look is an UNLAYERED `EditorChromeInjector` rule on `img[data-studio-uploading]`; the progress property is written imperatively on the element (React does not own it). The relay now copies `altKey/shiftKey/metaKey/ctrlKey` — a relay that drops them silently changes what a drop means.
  - **Events × registration:** a board frame is a drop surface whether or not it is active (it used to be active-only). Anything that assumes "registered surface ⇒ active frame" is wrong now; the file drop activates its own page.
  - **Height:** none — but the ghost carries an inline `max-width: 100%` so a large photo cannot stretch the frame before its clamped size is written.
  - The ghost rollback checks its ids are still on the page first: a page replaced by an outside resync mid-upload is settled, never patched.
  - Portal (design) frames render a literal `src="/x.png"` against the ADMIN origin, so a dropped image shows broken there until something serves the project's `public/` to design frames (Found, not fixed — PR body). Live (Tier 2) frames are fine.
- **Next:** ⇧K binding → `insert.image` (P5-E owns `keybindings.ts`); IMG-4 paste (after P5-A), IMG-5 URL drag (OD-13, security review), IMG-6 Assets images section, IMG-10 import convention, IMG-11 ledger.
- **Human action needed:** dogfood in the **Design** view (live frames take no file drops yet — PR body), `/admin/site` on `test4`, 100% zoom, one frame; dropped images show broken-but-correctly-sized in design frames (the `public/` gap):
  1. Drag three PNGs from the desktop onto the frame: three ghosts appear at once and fill left to right while uploading; one save; `public/` gets three files; one ⌘Z removes all three `<img>`s.
  2. Drag a 4000 px photo into a 390 px-wide container: the written `width` is ≤ the container, aspect kept.
  3. Drag one PNG onto an existing `<img>`: it is outlined and the chip says "Replace image"; release swaps the image; ⌘Z restores the old one. Hold ⌥: it inserts beside instead.
  4. Hold ⇧ over a container: "Set as background"; release adds a background layer (Fill section shows it). Hold ⌘ over a `position: relative` container: the image lands at the pointer; over a static one, the "make it relative" dialog.
  5. ⌘K → "Insert image…": pick two files; they land right after the selected layer.

## Blocked

*One line per item: id · question · who decides · since.*

- Nothing is blocked. Owner questions that gate future work are in `ROADMAP.md` §13 → "Open questions for the owner".

## Pending dogfood

*One line per item: id · route · what to look at. The script is in the entry (`docs/state-archive/2026-09.md`, grep the id) unless it says otherwise. Older scripts: [`docs/e2e/dogfood-backlog.md`](docs/e2e/dogfood-backlog.md). Delete a line once the script has been run.*

**Design pane (P2)**
- `panel-43` · `/admin/site` on `test4` · select a text element: props block ends in 8px + a hairline, 12px between sections, one Effects section; the ClassPicker fade only while scrolled. Script: the `panel-43` entry in the archive
- `panel-44` · `/admin/site` on `test4` · select a component instance: one "<Name> · Local" row with icon Detach/Swap under Measures, props visible even with no class, Esc reverts a text prop, hidden under multi-select. Script: the `panel-44` entry in the archive
- `panel-45` · `/admin/site` on `test4`, dark AND light · field hover lifts, Layers keyboard ring + selected ≠ hovered, forceOpen headers are plain titles, notice cards on the 12px gutter, skeletons on first open. Script: the `panel-45` entry in the archive

**Images (P5)**
- `canvas-28` · `/admin/site` on `test4`, Design view, 100% · drop 3 images on a frame (ghosts fill, one ⌘Z removes all), onto an `<img>` (replace), with ⇧ (background) and ⌘ (at the pointer); ⌘K → Insert image…. Script: the `canvas-28` entry

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
