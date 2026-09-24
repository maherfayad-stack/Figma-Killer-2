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

### parser-18 — P3-C: value refusals become writes (two PRs)
- **Agent:** parser-surgeon · **Branches:** PR 1 `feat/value-refusals-become-writes` off `01f3d9c2` (#247); PR 2 `feat/style-edits-land-anywhere`, stacked on PR 1 (#249) · both draft, base `feat/canvas-excellence`, long form in the bodies · **Updated:** 2026-09-24
- **Stage:** verifying — both drafts open, gates green (pre-existing failures listed in the PR bodies).
- **Goal:** ROADMAP P3-C: WB-6, WB-8, ERR-14, ERR-15 (PR 1); WB-16, WB-17, WB-18, WB-19, WB-30, WB-31, OD-8 (PR 2).
- **Scope (parser files):** `page-parser/{types,jsxAttributeReaders,nodeResolution,parsePageFile,componentSubstitution,inlineLocalComponents,nextAppLayout}.ts`; `ast-codemods/{setStringLiteral,setJsxStyle,setJsxClassName,classNameWrap(new),cssModuleImportPlan(new),jsxImportEdits,jsxSubtree,insertJsxElement,insertJsxIntoSlotProp,wrapJsxElement,wrapJsxElements,swapComponentInstance,setStyledDeclaration}.ts`; `css-codemods/{setDeclaration,removeDeclaration,insertRule,analyzeDeclarationTarget,cssAtRuleScope(new),keyframes,cssPropertyCase}.ts`; `page-tree/{sourceNodeId,editConstraint}.ts`; `studio-sync/parsedPageToSitePage.ts`. Client/server files: see the PR bodies.
- **Done (PR 1):** WB-6 call-site literals are the origin of forwarded text/props; WB-8 every origin-backed value writes as `literal`; ERR-14 a new class's stylesheet is ranked, never asked (dialog deleted); ERR-15 no stylesheet → `studio.css` beside the entry.
- **Done (PR 2):**
  - WB-16: `setDeclaration` writes the WINNING declaration (later block, after a covering shorthand, last duplicate); `unset` removes every copy in scope. Only a covering `!important` shorthand refuses.
  - WB-31: `atRule` (`media`/`container`/`supports`) replaces `atMedia`; `setDeclarationAtMedia` deleted.
  - WB-17: `setJsxStyle` writes after a spread (moving a pre-spread key, TS1117) and wraps an identifier/call/member/conditional.
  - WB-18: a class ADD wraps an expression `className` (`cn(expr, "a")` or `` `a ${expr || ''}` ``); a missing CSS-Module import is reserved and added after the batch (`ModuleImportPlan`); `templateHeadClassNames` shows whole static classes only.
  - WB-19: `planImportBindings` aliases a clashing component name (insert, slot fill, wrap, group, swap) or reuses an existing alias.
  - OD-8: a `.map` row's style/class edits write the row template (`loopTemplateNodeId`); rows are fingerprinted; "Applied to all N rows" + page re-read.
  - WB-30 (partial): the unmapped-class warning carries "Style the element instead".
- **Decisions (per new resolution):** call-site literal origin — locks: no; codeProps: yes; origin: yes (the string literal only). `templateHeadClassNames` (className template head) — locks: no; codeProps: yes (unchanged); origin: none (visual only, className becomes `classIds`); panel: class chips. Row fingerprint — identity metadata only (no lock, no codeProps, no origin).
- **Landmines:** (1) `chosenDestinations` resets only on a project switch. (2) The row-template notice names ⌘Z instead of an Undo button — by the time it shows, the newest history entry may be another edit. (3) The old `className` head fallback rendered half-tokens (`banner--`); both sites now share `templateHeadClassNames`. (4) Test files are outside `tsc -b`: a wrong fixture shape surfaces only when the test runs.
- **Found, not fixed:** WB-30's real move (typed class declarations → the element's inline style) is not built. Transplant still refuses `binding-conflict` (it carries user markup verbatim). Storybook args have no origin. ERR-14's "change" chip and per-project memory are not built. Canvas resize handles on a `.map` row were not checked (canvas area, P2-I's).
- **Next:** orchestrator merges #247, then PR 2. studio-scribe: landmines (2)–(3) are in `studio-import.md`; (4) is not.

### perf-12 — P2-I: selector sweep (PERF-1, PERF-12, PERF-5; PERF-14 measured and refuted)
- **Agent:** perf-hunter · **Branch:** `perf/hover-and-selection-off-the-global-store` off `ecfa57d6` (trunk `01f3d9c2` merged in) · **PR:** #245 (draft, base `feat/canvas-excellence`; full tables in its body) · **Updated:** 2026-09-24
- **Stage:** verifying (draft PR open; owner dogfood below)
- **Done:**
  - Hover is off the editor store: `canvas/canvasHover.ts` (keyed + per-frame reads). `hoverNode`/`hovered*` are gone; store actions call `clearCanvasHover`/`followCanvasHover`. The dead `isHovered`/`data-hovered` is deleted.
  - Selection is a keyed read in `NodeRenderer` (`canvas/canvasNodeSelection.ts`, one store listener). Both `useShallow` selectors are primitives; actions/session constants read via `getState()`. Budget 11 → 7, and `useShallow` is banned there.
  - **Found by measuring:** `CanvasSelectionContext` got a new value on every `CanvasRoot` render, so every click re-rendered all ~2,800 mounted `NodeRenderer`s. `useCanvasNodeInteraction` now returns a once-created facade over a ref.
  - PERF-12: `selectPageDirectory`/`selectTemplatePages` (`store/slices/pageDirectory.ts`). Nine always-mounted readers narrowed. The gate now also fails bare `s.site` in layouts/hooks/Explorer, whole `site.pages` in chrome, and `.pages.filter/map` in any selector.
  - PERF-5: posters are captured only while a frame is off screen and pooled (`framePosterNeeded`). The busy listeners run in every frame document (portal DOM; bridge adapter events). Each capture records a `studio:poster-capture` measure.
- **Numbers (dev build, 40 × 300 corpus):** hover worst frame 169–183 → 21–30 ms · Layers hover 111–125 → 20–26 ms · warm click → ring 292–440 → 78–85 ms · post-edit pause worst frame 1,140 → 19 ms · sweep medians: hover 8–16 → 0.000 ms, selectNode ~21 → 5–10, keystroke ~23 → 6–12, pan commit ~16 → 2–5.
- **Cold-click A/B (10 each, interleaved, quiet box):** means `53c2746f` 162.5 · `ecfa57d6` 167.1 / 162.6 · branch 158.0 / 159.2 ms. P2-A caused no regression; the old 432 → 485 was load.
- **Landmines:**
  - Diagnostics that mutate a global during render make the React Compiler bail out of that component, which fakes an unstable context. Count renders from a `useLayoutEffect`.
  - PERF-14: stubbing out the Properties AND Layers panels left click → ring at 315–330 ms. The inspector is not on that path, so no deferral was added.
  - A capture of a 310-element frame is 880–1,160 ms (`getFontEmbedCSS` ~0 ms, so font caching buys nothing). An evicted frame whose poster is stale shows the plain title card.
  - `studio-board-perf` "virtualization bounds live iframes" fails on trunk too (live + fallback iframes: 16 ≥ 12 frames). Pre-existing.
- **Next:** the orchestrator merges. Found-not-fixed items are in the PR body.
- **Human action needed:** dogfood on a large board (40 frames, 25–40% zoom):
  1. Sweep the pointer across a frame: the hover ring tracks with no stutter.
  2. Click element after element: each ring appears at once and the inspector follows.
  3. Edit a text in the inspector, pause 2 s, then click: no hitch.
  4. Pan an edited frame off screen and back: it comes back as a picture, then live.

### canvas-27 — P2-C2: bulk actions on a multi-selection (OD-16)
- **Agent:** canvas-engineer · **Branch:** `feat/bulk-actions-on-multi-selection` off `bee865f1` (trunk `01f3d9c2` merged in) · **PR:** #246 (draft), base `feat/canvas-excellence` (long form + the per-action audit table in its body) · **Updated:** 2026-09-24
- **Stage:** verifying (draft PR open; owner dogfood below)
- **Done:** arrows, ⌥↑/⌥↓, ⌘[/⌘] and the palette's Move up/down act on the WHOLE selection, one undo entry + one source write per gesture.
  - Nudge: every absolute layer moves by one delta from its own authored offsets (per-layer preview bag `NodeStylesPreview.stylesByNode`, one `setNodesInlineStylesPerNode` on keyup). Mixed selection: absolute members nudge, flow members stay put.
  - Reorder: `@core/page-tree`'s new `planSiblingSteps` reduces a step to INDEPENDENT single-element moves (a run's neighbour jumps over it; a single layer moves itself); new store actions `stepSiblings`/`moveSiblings` (`siblingStepActions.ts`) write them as ONE `/save` batch (`commitStudioMove` → `commitStudioMoves`) and tag ONE `gesture: 'siblings'` entry whose undo is the inverse batch. Each parent steps along its own axis. Refused by name: a grid-row step of 2+ layers, a nested pair, a locked member.
  - Grid: ↑/↓ move a child one row (resolved `grid-template-columns` count), ←/→ one cell; past the last row nothing moves.
  - Audit: delete, duplicate, copy/cut, hide, lock, group, style edits and align-self were already bulk (table in the PR). Ungroup and copy-as-PNG stay anchor-only (reasons in the PR).
- **Files touched:** `core/page-tree/{siblingSteps (new), index}`; `store/slices/site/{siblingStepActions (new), nodeActions, types, historyTypes, historyNodeIdRemap, structuralHistory, undoRedoActions}`, `store/slices/styleRule/{types, uiStateActions}`; `studio/studioStructuralCommits`; `canvas/{canvasNodeArrowMove, useCanvasNodeArrowKeys, useCanvasNodeShortcuts, canvasNodeInlineStyle}`; `spotlight/{keybindings (OD-3 rows), commands/layers}`. None of P2-I's files (NodeRenderer untouched: the per-node preview rides its existing selector).
- **Tests:** `siblingSteps.test.ts` (11), `siblingStepsBatch.test.ts` (4: one request each way, never half), `nodeArrowKeys.test.tsx` (+8). Each shown failing with its fix disabled in place. e2e `node-arrow-keys.e2e.ts` 8/8 (ports 50374/30302): two absolute layers held → = one save + one ⌘Z; A and C step → in ONE `/save` batch (and one undo batch); grid ↓ = one row.
- **Landmines:**
  - **Events × history:** a batch of 2+ moves is `gesture: 'siblings'`; a batch of one is still a plain `move` entry (`moveSiblings` delegates). Undo of a partially refused batch replays the whole inverse — the same pre-existing hazard a multi-delete has.
  - **Injectors:** none. **Height:** none.
  - The batch is honest only because regions are disjoint AND applied bottom-to-top by the server (`orderStudioEditsForApply`). Anything that reorders a batch client-side, or adds a non-move edit to it, breaks that.
- **Next:** P3-D can reuse `planSiblingSteps`/`moveSiblings` for multi-select drag; multi-ungroup needs a per-container undo template.
- **Human action needed:** dogfood on `test4`, `/admin/site`, static tier, SMS frame, 100%:
  1. Click the SheetHeader, press ⇧Enter (its absolute `.header` wrapper is selected), then ⇧-click empty space in the content banner. Hold ↓ three times: both slide together; release → ONE save; both `<div>`s gain a `top` style; ⌘Z once restores both.
  2. Click the 2nd code input, ⇧-click the 4th, press →: they become 3rd and 5th in `SMS.tsx` in one save; ⌘Z once puts both back.
  3. Select the 2nd and 3rd code inputs, press ⌥↓ (or ⌘]): both move one place right together.
  4. Select a code input and the banner (mixed), press ↓: the banner moves, the input stays.
  5. (No grid in `test4`.) In any project with a CSS grid, select a cell, press ↓: it moves one row down; ← / → move one cell.

### mcp-30 — P4-E: assets for the agent (AI-13, AI-20, P4-C review F8)
- **Agent:** mcp-tooling · **Branch:** `feat/agent-finds-icons-and-images` off `5a15f249` (trunk merged in) · **PR:** #248 (draft, base `feat/canvas-excellence`; long form, threat list and tool table in its body) · **Updated:** 2026-09-24
- **Stage:** verifying: the security review of #248 came back CHANGES-REQUIRED; F1, F2, F3 and F7 are fixed and need re-review. F4, F5 and F6 are deferred (reasons in the PR).
- **Goal:** the agent finds a real icon or photo instead of drawing a grey box, lists the project's images and fonts, and can no longer be steered into fetching from an arbitrary host (F8).
- **Tools added** (all `execution: server`):
  - `studio_find_image` (`ai.tools.write` + `studio.write`, `write`, `headlessOnly`): `{ dir?, query, orientation?, size?, count ≤4, photoId?, targetDir? }`. Pexels (direct HTTP) lands photos and credits each in `IMAGE-CREDITS.md`. With no `PEXELS_API_KEY` it returns `configured:false` and "Stock photo search is not set up on this Studio server…"; it is not an error.
  - `studio_find_icon` (read): `{ dir?, query, limit ≤12, forFile? }`. With no catalog: "This project has no design-system icon files Studio can read… never draw one."
  - `studio_list_assets` (read): `{ dir?, query?, offset?, limit ≤100 }`. `studio_list_fonts` (read): `{ dir?, query?, limit ≤20 }`.
- **Done:**
  - `remoteFetchPolicy.ts`: Figma hosts, the stock host, the opted-in loopback, or a URL the user pasted (exact); anything else is `host-not-allowed` before any request. Covers `fetch_remote_asset` and `register_design_reference({url})`. User URLs come from `chat.ts` via `ToolContextBase.userSuppliedUrls`; on the CLI path via `connectorUserUrls.ts`.
  - `remoteAssetFetch.ts`: 30 s deadline, image content-type allowlist, and a magic-byte match.
  - `landAgentAsset`: agent write gate, project lock and turn log for fetch, find_image and extract_reference_asset (`prototype/` was reachable).
  - Prompt ladder rewritten (find, then name the gap); a digest line when stock search is not set up. Codes `host-not-allowed`, `stock-search-failed`, `stock-key-refused`.
- **Decisions:** Pexels (licence allows self-hosting; one image host). Figma and Dev Mode hosts were added beyond the brief's "stock + user" list so the Figma asset flow keeps working; flagged in the PR. The key is env-only.
- **Review #248 fixes:**
  - F1: `INERT_FILE_CSP` (`default-src 'none'; sandbox`, `static.ts`), one helper for studio asset, uploads and published SVG/HTML; `applySecurityHeaders` now APPENDS to a route's CSP; the SVG sanitizer is hardened.
  - F2: `origin: 'studio'` on composed user text ("Address with AI"), which `collectUserSuppliedUrls` skips.
  - F3: loopback allowed only at `:3845/assets/`.
  - F7: the target folder is judged as a parent.
- **Landmines:** `ConnectorRegistryBinding` now requires `userSuppliedUrls`. A route that sets its own CSP under `/admin` now keeps it. Test servers need `node:http` + `Bun.fetch`, because the suite preload swaps in happy-dom's `Response`/`fetch`. `chat.ts` is at 699/700 lines.
- **Verification:** build and lint clean; every chunk run under the lock; only pre-existing failures (render_reference dev server, bundle freshness, optimistic broadcast, bridge measurement, liveOrigin WS). `editorLayoutPersistence` timed out in a 200-file batch and passes alone.
- **Next:** security-guard review. Found-not-fixed items are in the PR body (`studio_upload_asset` bypasses the agent gate; stale icon-guide text).
  - **Security re-review APPROVED (`review-248`). Open follow-ups:** F5, the pre-existing address-class gaps in `ssrfGuard.ts` (reachable only through a URL the user pasted); make the sanitizer strip DOCTYPE, XHTML elements (`iframe srcdoc`) and XSLT instructions (the sandbox CSP stops them today); switch the CSP helper to `headers.append` so a future route's `frame-ancestors` cannot win; F4, narrow the Figma host allowance; F6, `studio_upload_asset` should go through `agentWriteRefusal`.

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
- `canvas-27` · `/admin/site` on `test4`, SMS · two absolute layers nudge together (one save, one ⌘Z), two code inputs step together, ⌥↓ on a pair, a mixed selection nudges only the absolute one. Script: the `canvas-27` entry under `## Now`

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

- `store-18` — P3-A: per-edit save outcomes (successes commit, refusals named and re-sent), save-time refusals warn with "Open in code", no success toasts on gestures, chrome error boundaries; error toast sites 128 → 104, pinned — #244 — 2026-09-23
- `canvas-26` — P2-E: one snap threshold (8 screen px ÷ zoom), parent edges/padding/centre snap, resize edges snap (static frames), drop outlines the landing container, Alt measures to the parent; OD-15 arrows after a Layers click — #243 — 2026-09-23
- `canvas-25` — P2-C: arrows nudge an absolute layer 1/10 px or reorder a flow child, one undo + one write per held key; free move writes camelCase `insetInlineStart` — #242 — 2026-09-23
- `mcp-29` — P4-D: one rewritten prompt for both paths (craft rubric, self-critique, real content, no eSIM facts), archetypes, component snippets, multi-width screenshots, `studio_arrange_frames`, `studio_set_tokens`, selection digest — #241 — 2026-09-23
- `parser-17` — P3-B: text in containers is editable, memo/forwardRef/React.memo/barrels/namespace imports unwrap, Fragment is a fragment, class and HOC pages render or name their shape — #240 — 2026-09-23
- `canvas-24` — P2-B: ⇧-click toggles, Tab cycles siblings, ⌘A climbs, V, zoom keys on the dispatcher, blur releases keys, keys forwarded from live frames, the outermost instance is selected first — #238 — 2026-09-23
- `panel-45` — P2-H: dark hover lifts, AA text contrast (light `--text-subtle` darkened), Layers focus ring, selected ≠ hovered, plain forceOpen headers, skeletons on first open — #239 — 2026-09-23
- `canvas-23` — P2-D: resize writes the CSS size per `box-sizing`, flex/grid children go through `sizingPatch(fixed)`, live ⇧/⌥, W/N move left/top, a W×H badge, one shared drag-session guard — #237 — 2026-09-23
- `panel-44` — P2-G: one "<Name> · Local" title row under Measures with icon Detach/Swap, hidden under multi-select, 96px labels, draft-then-commit text props — #236 — 2026-09-23
- `perf-11` — P2-A: toolbar pinned to the ring through a pan, 0 idle rAF, no chrome-driven hover mutations, O(1) no-op marquee; benches + `canvas-feel-budgets.e2e.ts` in CI — #235 — 2026-09-23

---

## Archive

Every entry that has left this file is in [`docs/state-archive/`](docs/state-archive/), verbatim, one file per month from 2026-09 (`2026-Q3.md` holds the older quarter). Find one through [`docs/state-archive/INDEX.md`](docs/state-archive/INDEX.md): one line per entry, `date · id · title · file`.
