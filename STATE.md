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
- **Progress:** merged into the trunk: P1-G #219, P1-C #220, P1-A #221, P1-B #222, P1-E1 #224, P0 #225, P1-E2 #223 (after a security review caught a CSS-injection path in asset URLs). At most 3 agents run at once, because of the owner's RAM.
- **Next:** P1-E3, P4-A, P1-D, P1-F; then Phase 2. Urgent: P0 found that the Docker images keep `studio-workspace/` outside every volume (ROADMAP P1-H).

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
  - The Docker images and templates keep `studio-workspace/` outside every volume: user projects are lost on container recreate. Documented in `docs/deployment/README.md`; the compose/template fix is not made.
- **Verification:** see the PR body (`bun run build`, `bun run lint`, `bun test`, with the triage of every failure).
- **Human action needed:** review the `CLAUDE.md` and `.claude/agents/` diffs before merging (an agent's request cannot authorise rule-book changes); fix `studio-scribe.md` line 30.

### canvas-22 — P1-E3: the SVG→JSX converter never writes code that crashes React
- **Agent:** canvas-engineer · **Branch:** `fix/svg-to-jsx-never-writes-broken-code` · **PR:** draft against `feat/canvas-excellence` (long form in its body) · **Updated:** 2026-09-23
- **Stage:** verifying (draft PR open)
- **Goal:** ROADMAP P1-E (SVG part). Closes audit `08-svg.md` §2 defects 2, 3 and 5. Defect 4 (the `href` sanitizer hook) waits for P5-D and its security review.
- **Scope:** `src/admin/pages/site/studio/{svgToJsxNode.ts, svgImportStyles.ts (new)}`, `src/__tests__/studio/svgToJsxNode.test.ts`, `docs/editor.md`, `docs/agent-refs/path-index.md`. No canvas DOM, injector, height or event code, no `sanitize.ts`, no parser.
- **Done so far:**
  - A `style="…"` string becomes presentation attributes (SVG's presentation set intersected with React's alias list) plus a `style` OBJECT for the rest. It is never written as a string. Values only CSS can resolve (`var()`, `calc()`, reset keywords) stay in the object.
  - `<style>`: single-class rules, including comma lists, are inlined by the real cascade (rule < inline < `!important`). The block and any `<defs>` it leaves empty are dropped. Any other selector or `@`-rule is refused with a sentence that names it.
  - ids get a per-conversion random suffix. `url(#…)`, `href`/`xlink:href="#…"` and `aria-labelledby`/`-describedby` are rewritten to match. A bare `#hex` colour is never touched.
  - Both SVG writers (`SlotPicker.tsx`, `insertablePropValues.ts`) already use this converter, and a grep found no other writer.
- **Next step:** owner dogfood (script in the PR body), then merge.
- **Decisions:**
  - Paint that arrived as SVG-internal CSS now lands as presentation attributes, the weakest cascade source, so the user's page CSS can recolour it. This is deliberate and matches Penpot.
  - The converter still sanitises first.
  - The audit §5.5 rename to `svgMarkupToInsertNode` is left to SVG-5.
- **Landmines:**
  - Under happy-dom, DOMPurify drops a `<style>` inside `<svg>` together with everything after it; a browser keeps it. `<style>` tests must call `convertSanitizedSvg`, not `svgToJsxNode`.
  - `sanitizeSvg` still strips `href`, so the href rewrite does nothing until P5-D adds its hook.
  - DOMPurify does not vet CSS `url()`, so a remote `url()` in `fill` or `style` survives (pre-existing; listed under "Found, not fixed" in the PR).
  - Under Bun, `vite build` hung twice after "modules transformed" while the machine was loaded. It built under Node, and a later retry under Bun built normally.
- **Verification:**
  - 15 new tests, proven to fail on the old converter, including React's real "style prop expects a mapping" error. `svgToJsxNode.test.ts` now passes 26/26.
  - `bun run build` and lint are clean.
  - Chunked `bun test --parallel=1`, 30 failures in total, all live-browser, dev-server, WebSocket, optimistic-broadcast or bundle-freshness tests, none touching the converter:
    - `architecture`: 1 (bundle freshness)
    - rest of `src/__tests__`: 4 (optimistic broadcast)
    - `src/core`: 0
    - `src/admin`: 5 (bridge measurement)
    - `src/modules` and `src/ui`: 0
    - `server`: 21 (headless capture, dev server, WebSocket)
- **Human action needed:** dogfood `/admin/site` icon-slot upload. The four steps are in the PR body.

### server-28 — P1-D: notice edits made outside Studio (watcher + re-locate)
- **Agent:** server-engineer · **Branch:** `fix/notice-edits-made-outside-studio` · **PR:** draft against `feat/canvas-excellence` (long form in its body) · **Updated:** 2026-09-23
- **Stage:** verifying (draft PR open)
- **Goal:** ROADMAP P1-D. Closes ERR-19 and WB-1's re-locate + watcher half.
- **Scope:** new `server/handlers/{sourceLineMap,studioEditRelocate}.ts`, `server/handlers/studio/{projectWatch,sourceTextHistory}.ts`, `server/ai/mcp/outsideEditReload.ts`; edits to `studioEditIdentity.ts`, `studioWriteback.ts`, `projectWriteLock.ts`, `pageParseCache.ts`, the editor bridge, `liveReloadPush.ts`, `agent/studioLiveReload.ts`, `@core/page-tree` (`withSourceLocation`). No route added.
- **Done:**
  - `projectWatch.ts`: one watcher per open project, retained by the editor-bridge stream (15 s linger). Events are hints only; a `size:mtime` snapshot diff is the truth. `origin` is `studio` when the file's mtime falls inside a project write-lock hold (new session log in `projectWriteLock.ts`).
  - Outside changes to board inputs are pushed as `studio_live_reload { diskChanged: { files } }` to every tab on the project. The tab flushes pending edits, then runs `resyncBoardAfterWrite(files)`.
  - `/save` and `studio_apply_edits`: a fingerprint mismatch is re-found through a line diff against remembered texts. Exactly one verified position means the edit is re-addressed and written, listed in `retargeted`, with `shifted: true`. Anything else is the old `element-moved`.
- **Decisions:**
  - No wire change for the base text. The expected fingerprint picks which remembered text the board read.
  - The line map uses both extreme optimal alignments (Myers forwards and reversed). A line that some reading deletes is never re-found.
  - Outcomes are reported under the id the caller SENT.
- **Landmines:**
  - Bun 1.3 `fs.watch` on Windows drops most of a burst and names directories, not files. Never trust an event's path.
  - Writers that bypass the project write lock (`translationWrite`, `assetLanding`, `i18nScaffold`, `pageDelete`, …) read as `outside`, so they cost one redundant re-read.
  - No tab open means no watcher. History is per-process, so after a restart the first stale edit refuses as before.
- **Next:** P6-C subscribes `subscribeProjectChanges` for `/load` invalidation; it must use ALL origins, not just `outside`. FC-1: `.studio/canvas/` is already watched.
- **Verification:** 4 new server test files plus 1 client test file, and 1 e2e spec, run in Chromium and passing. Relocate, watcher-push and e2e were each proven to fail with the fix disabled in place. Build and lint are clean. The chunked suite shows only pre-existing failures: bundle freshness, optimistic broadcast, bridge measurement, headless capture, dev server and WebSocket.

---

## Blocked

*One line per item: id · question · who decides · since.*

- Nothing is blocked. Owner questions that gate future work are in `ROADMAP.md` §13 → "Open questions for the owner".

---

## Pending dogfood

*One line per item: id · route · what to look at. The script is in the entry (`docs/state-archive/2026-09.md`, grep the id) unless it says otherwise. Older scripts: [`docs/e2e/dogfood-backlog.md`](docs/e2e/dogfood-backlog.md). Delete a line once the script has been run.*

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

- `asset-06` — P1-E2: one server rule for image URLs (percent-encoded), content dedupe, `wx` writes, keyed replay for asset-drop; security review fixed — #223 — 2026-09-23
- `parser-16` — P1-E1: detach fails closed — symbol-based substitution, spread/rest, aliasing, a free-variable gate; every refusal leaves files byte-identical — #224 — 2026-09-23
- `store-16` — P1-B: selection, hover, inline edit, entered instances and the drag follow their element across a reparse; a full reload is awaitable and sequenced — #222 — 2026-09-23
- `parser-p1a` — P1-A: element identity guard; a stale line:col write is refused as `element-moved` and silently re-planned — #221 — 2026-09-23
- `parser-15` — P1-C: the parse cache tracks evaluator reads, batch edits merge, a broken tsconfig or page degrades instead of failing a load — #220 — 2026-09-23
- `sec-23` — P1-G: one write predicate; no Studio writer lands in `.studio`, `.git`, `node_modules`, build output or `.claude` — #219 — 2026-09-23
- `speed-00` … `speed-06` — the speed plan's wave 1: optimistic style in live frames, 250 ms autosave, coalesced hover, one cold-selection overlay, refusal inside keydown, drag into live frames with a drop line — #205–#208, #210, #212–#214 — 2026-09-21
- `live-17` … `live-20` — live frames: component-instance selection, inline text editing, middle-mouse pan, the prototype link handle — #209, #211–#216 — 2026-09-21
- `live-10` … `live-16` — live frames on a local install: vite-only dev server, HMR subprotocol, bridge selection and pan, optimistic delete, dev servers that survive an API restart — #197, #202–#204 — 2026-09-20/21
- `sec-19`, `sec-20`, `sec-21` — every project starts at `run-project`, and its two security reviews — #197, #198 — 2026-09-20

---

## Archive

Every entry that has left this file is in [`docs/state-archive/`](docs/state-archive/), verbatim, one file per month from 2026-09 (`2026-Q3.md` holds the older quarter). Find one through [`docs/state-archive/INDEX.md`](docs/state-archive/INDEX.md): one line per entry, `date · id · title · file`.
