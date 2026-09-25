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

### canvas-33 — P5-G: the free canvas (OD-14) — loose layers on the empty board
- **Agent:** canvas-engineer · **Branch:** `feat/free-canvas-loose-layers` off `25681dcb` (trunk through `0177ed7d` / #263 merged in) · **PR:** #260 (draft, base `feat/canvas-excellence`; long form, threat list, reviewer file list, gesture table in its body) · **Updated:** 2026-09-25
- **Stage:** security APPROVED; merged over #263 (P6-B), ready for the orchestrator. N2 (`boards.json` plain-fs) is a listed follow-up.
- **Done:** FC-1 (id/path grammar, `Board.layers`, load apart from pages, memo, reload scope, the ONE write-path pattern), FC-2 (create/delete/restore/place/lift kinds; lift + place back is byte-exact), FC-3 (`canvasLayerPages` slice, gestures whose ONE history entry holds module + placement, heal), FC-4 (one windowed static surface per board, below frames; rings above), FC-5 (press/drag/snap/move, drag into a frame = place, drag out of a frame = lift, Delete, arrows), FC-6 G2 (OS image drop on the empty board, reconciled with P5-B's multi-file drop: one loose layer per image, intrinsic size from the landing route, cascaded 24 px; failures through P5-B's `reportUnlanded`). Doc: `docs/features/free-canvas.md`.
- **Decisions:**
  - Agent: native Write/Edit into `.studio/` stay refused; `studio_apply_edits` refuses every canvas-layer kind and every layer-module target (`canvas-layer-agent`) — only `/save` passes `canvasLayers: 'allow'`.
  - The surface takes NO input: `pointer-events: none`; layers are hit-tested from the board (`useCanvasLayerPointer`), so no gap forwarding exists to go wrong.
  - A loose layer is selected as a whole (a 4th selection list). Inspector editing of its content is FC-7.
  - `canvas-layer-restore` accepts client text (undo), exclusive-create, ≤ 512 KB — same trust as `reinsert-source`.
  - Default deny IN THE DECODER (#260 B1): `studioEditLocation`/`canonicalSourceRel`/`isWritableSourceRel` refuse a layer path unless given `SourceTargetScope` `{ canvasLayers: 'allow' }` — only `applyStudioEditBatch` for `/save` threads it. A new decoder caller gets the refusal for free; never pass `'allow'` from anything that writes on an agent's behalf.
  - `CanvasFileDropPlan` is `kind: 'frame'` (P5-B's action) | `kind: 'canvas'`; modifiers never apply on the empty board. A multi-file canvas drop is one undo step PER layer (FC-6 follow-up).
- **Canvas files touched:** `canvas/BoardCanvasLayer/*` (new), `StudioBoardLayers`, `IframeFrameSurface` + contract (`sizing`), `useIframeFrameAutoHeight` (`isLive` → `fitToContent`), `canvasFileDrop`, `canvasFileDragPreview`, `useCanvasFileDrop`, `canvasDragCommit`, `useCanvasReorderDrag`, `boardSnapping`.
- **Landmines (height × injectors × events):**
  - The surface uses `sizing: 'fixed'`: auto-height is OFF there, and its body gets inline `margin: 0`/transparent background. A change to `applyIframeBodyReset` that pins body size must not assume every canvas iframe fits to content.
  - The surface must stay `pointer-events: none`. If anyone makes it receive input, `useCanvasLayerPointer`'s capture-phase claim on the canvas root stops seeing presses over layers AND the marquee breaks over the surface's gaps.
  - `useCanvasLayerPointer` claims a root press with `stopImmediatePropagation` in CAPTURE; the marquee (`useMarqueeSelection`) must stay a non-capture listener or it will start under a layer press.
  - Pending marks are released after the RESYNC, not at `settle` — otherwise a heal between write and re-read drops a fresh placement.
  - A full `CMS_SITE_RELOAD_EVENT` re-reads `boards.json` over an unsaved placement (pre-existing for every board edit); layer writes resync narrowly (`reloadScope` maps layer files), and the heal re-places a module that lost its placement.
  - Events × drop: a free-canvas file drop is decided by the drop's TARGET (`isEmptyBoardTarget`), not by the frame hit test — a drop relayed out of a frame arrives targeted at the iframe element and must never fall through to the canvas. Keep the relay dispatching on the iframe element.
  - Structural commits now live in `studioStructuralCommitEngine.ts` (trunk refactor); the `placements` undo delta rides `StructuralCommitOptions.undo` there.
  - Load (P6-B): layers parse through `routeEntryParse.ts`'s `parseRouteFileThroughCache` (cache route `canvas-layer:<id>`), their dependencies join the memo's, and `routeListing` includes the layer ids so a create/delete invalidates. Site-root images render via P5-B2's `canvasProjectAssetUrl.ts`; P5-G's own `publicRoot` path was removed as a duplicate.
- **Next:** FC-7 panels/inspector, FC-8 MCP tools, FC-9 group, FC-10 budgets; FC-6 pieces ride P5-A/P5-D/P5-E (`createCanvasLayer`).
- **Human action needed:** dogfood (PR body checklist).

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
- `canvas-29` · `/admin/site` on `test4`, SMS, 100% · R-drag draws a box of the drawn size; T-click types; padding/gap bands (⇧ pair, ⌥ all four); ⌥A/⌥D/⌥W align; ⇧A; ⌘⌥C/⌘⌥V; ⌘⇧]; right-click "Select layer"; ⇧K opens the picker. Script: the PR body

**Assistant (P4)**
- `mcp-28` · the Agent panel with an Anthropic API key (not the CLI) · ask it to build a screen: it reads, writes and edits files; asking it to edit `vite.config.js` or `package.json` is refused as needs-you. Script: the PR #233 body
- `mcp-32` · the Agent panel with an Anthropic API key, default model · "build a signup and a login screen": one `studio_delegate` call, both pages written, "Revert turn" undoes both; "rename the button to Continue": the model chip reads `turn · claude-sonnet-5`; pick Opus in the picker, repeat: no routing. On a project with ESLint at Tier 2: ask it to lint — `studio_lint` returns diagnostics; at Tier 0 it refuses. Script: the PR body
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

- `perf-13` — P6-B: restart 2.8 s → 0.65 s, warm /load 55 → 18 ms on 40 pages; page edit and cold at baseline (prewarm builds the program, deferred cache writes) — #263 — 2026-09-25
- `canvas-34` — P5-B2: dropped and every literal public/ image loads in design frames via the hardened asset route (`url=`), media-only MIME gate, normalized rewrite; security approved — #262 — 2026-09-25
- `mcp-32` — P4-G: `studio_lint`, `studio_delegate` (per-turn caps 2 calls / 8 children / 150 rounds), model routing, short tool descriptions, run-project tools held in plan mode; security approved — #255 — 2026-09-25
- `canvas-29` — P5-E: armed draw tools, padding/gap handles, align, layer commands, ⇧K insert image, 12 IX/UX items — #261 — 2026-09-25
- `panel-46` — sweep: style-lock partial writes, dark --text-subtle contrast, icon guide, late component catalog, CLAUDE.md toast rule (owner reviews) — #259 — 2026-09-25
- `canvas-28` — P5-B: N images = one insert/undo, drop on img replaces (⌥ beside), ⇧ background, upload ghosts, natural size clamped, ⌘ at pointer, Insert image… command — #258 — 2026-09-25
- `sec-24` — security: SSRF pinning, separate admin CSP, server-side upload asset, link-safe scaffolds, case-folded read guard, Vite spawned directly (no predev), atomic writes, Tailwind @plugin/@config gate; approved after 3 B1 rounds — #256 — 2026-09-25
- `test-07` — green baseline: 15 of 16 pre-existing unit failures fixed (stub ready, log-file dev server, liveOrigin double subprotocol), canvasIframe e2e helper — #257 — 2026-09-25
- `store-19` — P3-E: edits rebase over outside writes and queued ⌘D; nothing typed is lost — #254 — 2026-09-25
- `infra-02` — P0-I: CI runs `bun run test` on Bun 1.3.13 — #253 — 2026-09-25

---

## Archive

Every entry that has left this file is in [`docs/state-archive/`](docs/state-archive/), verbatim, one file per month from 2026-09 (`2026-Q3.md` holds the older quarter). Find one through [`docs/state-archive/INDEX.md`](docs/state-archive/INDEX.md): one line per entry, `date · id · title · file`.
