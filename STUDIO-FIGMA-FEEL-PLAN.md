# Studio — "Feels like Figma, never shows me an error" plan

**Status:** proposed, nothing started · **Opened:** 2026-09-17 · **Owner:** main session (orchestrator)
**Base branch:** `feat/alm-figma-killer-studio-shell` (integration branch; PRs open as drafts against it, then one PR to `main`)

This plan answers one ask, quoted so nobody re-interprets it:

> Be as fast and snappy as Figma. The properties panel, the prototype and everything looks, feels
> and performs the same as Figma. Alt+drag to duplicate, Ctrl+D, a free canvas. No action
> whatsoever shows me noisy errors — the system handles it. No action I do is made a million
> times. No errors in the preview. The agent is fast, creative when I say creative, follows the
> design system when I say so, uses the studio tools with no errors. GitHub connect, push,
> branches, working perfectly. Detect the errors I did not see.

It was written after a full read-only audit of the tree on 2026-09-17 (seven specialist scouts,
findings cited by `file:line` throughout) and after reading every existing plan. **It does not
re-spec what already shipped.** Section 0 lists what is already true and which plan documents are
stale about it; the tracks only contain work that is genuinely missing.

---

## 0. What is already true — and which docs lie about it

Read this before dispatching anything. Several plan files still say "not started" for work that
is in the tree.

| Fact (verified in source 2026-09-17) | Doc that says otherwise |
|---|---|
| Track C perf fixes (C1–C5) are real: memoised page lookups (`store.ts:188-204, 304-316, 386-400`), narrow injector selectors (`UserStylesheetInjector.tsx:81-143`), patch-derived dirty tracking (`dirtyTracking.ts`), O(1) text-origin indexes (`PropertiesPanelBody.tsx:103-107`). Pan is a **measured 60 fps** with zero React re-renders (`tests/e2e/studio-board-perf.e2e.ts:51`). | — (accurate) |
| The Penpot-order inspector rebuild (Track P, P0–P6) shipped: `inspector/sections/index.ts:90-176` is the manifest, `selectionModel.ts` replaced the whole-`site` subscription, `ScrubInput` is the one numeric engine (scrub, ↑/↓, Shift ×10, Alt ×0.1, `100/2` math, Enter keeps focus, Escape reverts). | `STUDIO-LIVE-CANVAS-PLAN.md:1-3` still says "proposed, nothing started" |
| Prototype **Play** shipped (`src/core/studio-prototype/playback.ts`, `canvas/PrototypeScreenStack.tsx`, WAAPI transitions in `playbackMotion.ts`), including the `+`-handle drag on `BoardPrototypeLayer`. | `STUDIO-PROTOTYPE-PLAN.md:3` and `STUDIO-NEXT-WORKSTREAMS.md` WS-14.2 still say Phase 5 is unstarted |
| Track R (refusals become choices) shipped in full: `RefusalDialog` mounted at `SitePage.tsx:70`, exhaustive remedy table in `src/core/page-tree/editConstraint.ts`. Only the six remedy-less reasons still fall to a plain warning toast (`structuralSourceEdits.ts:337-348`). | `STUDIO-LIVE-CANVAS-PLAN.md` §3 |
| Canvas body-drag exists (press an element and drag it, `canvas-dnd` in STATE.md) — not only the 13 px grab handle. | `STUDIO-FIGMA-PARITY-PLAN.md:802-806` (D2 G2) |
| CSS write destination is **already auto-resolved**: co-located stylesheet → the single existing stylesheet → create one (`cssInsertDestination.ts:236-273`, `studioCssWriteback.ts:407-415`). Only `ambiguous-stylesheet` and `no-editable-stylesheet` remain as toasts. | — (accurate, but the user experiences the residual) |
| Track L (live Tier-2 frames) L1–L8 landed; `live-08` was the first one dogfooded in a real browser. **No project on this machine has ever been promoted to Tier 2** (`studio-workspace/*/.studio/meta.json` all `static`). | `STUDIO-LIVE-CANVAS-PLAN.md` header |
| The agent's 0.11 / 0.12 defects (advertised-but-unavailable tool, withheld diagnostic tool) are fixed by construction (`chatSystemPrompt.ts:68-96`, `agentToolNames.ts:91`). | `STUDIO-FIGMA-PARITY-PLAN.md` §4 body (ledger §0a is right) |
| Git v1 exists and is safe: init/status/diff/log/commit/branch create+switch/push/per-file restore, argv-only, no force, no stash (`docs/features/studio-git.md`). | — (accurate; the doc itself says "never dogfooded against a real remote") |

**Repo health on this checkout, measured 2026-09-17 (branch `feat/alm-figma-killer-studio-shell`, clean tree):**

| Gate | Result | Why |
|---|---|---|
| `tsc -b` | clean | — |
| `vite build` | **passes** | It failed on the original checkout because `alm-design-system` is a `file:` dependency and `bun install` had not been run. Z7 (#138) made `bun run dev` preflight exactly that, so the trap reports itself instead of surfacing as an unresolvable import. |
| `bun test` | **13,041 pass · 33 fail · 0 errors** in 713 s (1,199 files) — re-measured by `test-05` (#158), which replaces every number this row used to carry | The 281/198 reading was mostly ONE cause: `mock.module` is process-wide and PERMANENT (`mock.restore()` does not undo it), so a single unrestored mock in `server/liveOrigin.test.ts` stopped **129 later files LOADING at all**. Plus a real store leak in the canvas cluster (`useEditorStore` is a module singleton, now reset per test) and the CRLF cause above. The 33 that remain are named one by one in `standing-01`; 2 of them are the `useDevServerReadiness` pair #139 fixes. Runtime is LONGER than the old 477 s precisely because 129 more files now execute. |
| `bun run lint` | **clean** | The 6 `'os' is defined but never used` errors were deleted by `test-05` (#158). |

---

### Wave 1 — landed

Twenty-two work orders plus four security reviews, merged into
`integration/figma-feel-wave-1` on 2026-09-17. Each row links the work order to the PR
that carried it and the STATE.md entry that explains it.

| Work order | PR | Branch | STATE |
|---|---|---|---|
| Z9 + Z7 | #138 | `chore/workspace-gitignore-and-dev-preflight` | `server-24` |
| V2 | #158 | `test/windows-bucket-closed` | `test-05` |
| Z4 | #136 | `fix/dev-server-supervisor` | `dev-04` |
| Z10 + truth pass | #137 | `docs/plan-truth-pass` | `docs-14` |
| Z3 | #139 | `fix/bounded-tool-loops` | `mcp-21` |
| Z1 · Z2 · Z6 | #145 | `fix/zero-noise-toasts-boundaries-savechip` | `store-12` |
| Z8 | #143 | `feat/css-destination-open-page` | `style-06` |
| S3 · S4 | #140 | `perf/sandbox-selectors-event-driven-overlay` | `canvas-17` |
| K5 | #142 | `feat/alt-hover-measure` | `canvas-18` |
| S2 · K2 · K6 | #153 | `feat/drag-session-alt-duplicate-free-move` | `canvas-19` |
| S1 | #155 | `perf/cheap-frame-mount-iframe-pool` | `perf-07` |
| S6 · V1 · V3(CI) | #152 | `test/browser-perf-gate` | `verify-01` |
| K1 · K4 · K7 | #148 | `feat/one-key-dispatcher-bindings` | `keys-01` |
| K3 | #146 | `feat/group-ungroup` | `struct-10` |
| S5 | #144 | `feat/inspector-fits-900-multiselect-model` | `panel-36` |
| P9 | #141 | `feat/inspector-figma-parity-sections` | `panel-35` |
| P7 | #147 | `feat/prototype-triggers-smart-animate` | `proto-07` |
| Z5 · P8 | #150 | `feat/live-frame-errors-and-auto-promote` | `live-09` |
| — security review of #150 | #156 | `review/pr-150` | `sec-10` |
| A9 · A12 · A13 | #149 | `feat/agent-budget-design-policy-composition` | `mcp-22` |
| A10 · A11 · A14 | #154 | `fix/agent-tool-truth-and-gates` | `mcp-23` |
| — security review of #154 | #159 | `review/pr-154` | `sec-12` |
| G1 · G2 | #151 | `feat/github-connect-and-signin` | `git-21` |
| — security review of #151 | #157 | `review/pr-151` | `sec-11` |
| G3 · G4 · G5 · G6 · G7 | #160 | `feat/branches-pull-pr` (contains #151 + #157) | `git-22` |
| — security review of #160 | #161 | `review/pr-160` | — |

Not yet landed after wave 1: **G8** (the dogfood against a real private repository) and the
Phase 0 exit dogfood. Wave 2 machine-checked the second of those; G8 still needs a human.

---

### Wave 2 — landed

Ten work orders plus four security reviews, merged into `integration/figma-feel-wave-2` on
2026-09-18. Every row is a §9 backlog item or a Figma-hands gesture the wave-1 tracks left open.

| Work order | PR | Branch | STATE |
|---|---|---|---|
| §9 per-route capability gating (§6 decision 7, `sec-05` finding 2) | #167 | `feat/studio-route-capability-gating` | `sec-14` |
| — security review of #167 | #176 | `review/pr-167` | `sec-16` |
| §9 `deploy.ts` trust dir · GitHub-legal repo segments · two Windows reds | #166 | `fix/server-tier-dir-and-windows-reds` | `server-25` |
| — security review of #166 | #174 | `review/pr-166` | `sec-15` |
| §9 `parityMatrix` gap · `compare.test.ts` arity · `studio_list_projects` · the git guard | #168 | `fix/mcp-named-reds-and-parity-gap` | `mcp-24` |
| §9 CRLF-safe parsing and codemods for USERS' repos | #169 | `fix/crlf-safe-parse-and-codemods` | `parser-13` |
| §9 created ids from `commitStructural` (K7 follow-up) + `insertImportedNodes` (`mcp-21`) | #171 | `feat/structural-commits-report-created-ids` | `store-13` |
| D2 G3 + G15 — cross-frame element drag, OS image-file drop | #172 | `feat/cross-frame-drag-and-file-drop` | `canvas-20` |
| — security review of #172 | #177 | `review/pr-172` | `sec-17` |
| `meta-14`'s deferred design call — ONE frame mount pool | #175 | `refactor/one-frame-mount-pool` | `perf-9` |
| §9 `FillSection` Mixed through the one selection model | #165 | `fix/fill-section-mixed` | `panel-38` |
| S5 acceptance — the Design tab fits 900px; the height ratchet becomes one budget | #170 | `fix/inspector-design-tab-fits-900` | `panel-39` |
| §8 DoD line 1 — the Phase 0 exit dogfood as a Playwright spec | #173 | `test/phase0-exit-dogfood-e2e` | `verify-3` |

**Not in this wave:** `verify-2` (`bun run test:e2e` cold on Windows + a tracked ≥9-frame perf
corpus) had no PR open when the integration branch was cut — its three §9 items are still open
below, and the orchestrator merges it as a follow-up.

---

### Wave 3 — landed

Eleven work orders, merged into `integration/figma-feel-wave-3` on 2026-09-18. This was the
last wave: the owner called the plan closed after it. Every row is a §9 item or one of the four
defects `verify-3`'s Phase 0 spec machine-proved in wave 2.

| Work order | PR | Branch | STATE |
|---|---|---|---|
| §9 exact route entries, sidecars, secret stores, realpath-aware decode | #183 | `fix/route-table-exact-entries-and-sidecars` | `sec-18` |
| Phase-0 (a) — the group wrapper follows the HTML content model | #182 | `fix/group-wrapper-follows-content-model` | `struct-11` |
| Phase-0 (b)+(d) — structural gestures queue, keep selection, and undo in one step | #185 | `feat/structural-commit-queue-and-undo` | `store-14` |
| Phase-0 (c) — per-panel and per-section error boundaries; hidden/locked over N ids | #180 | `fix/inspector-error-boundary-and-fanout` | `panel-40` |
| §9 the three inspector density levers; the budget becomes strict | #184 | `fix/inspector-density-levers` | `panel-41` |
| §9 CRLF-safe subprocess output, through one helper | #179 | `fix/server-crlf-subprocess-output` | `server-26` |
| §9 no CMS `site_*` write in a Studio-scoped catalog + ONE real agent turn, wall-clocked | #187 | `feat/agent-turn-e2e-and-connector-tool-scope` | `mcp-25` |
| §8 DoD — G8 driven against a real private GitHub repository | #186 | `test/github-g8-dogfood-e2e` | `git-23` |
| `canvas-19`'s open item — the drag's reflow FLIP, file-drop UX, the copy remedy | #188 | `feat/drag-flip-and-file-drop-ux` | `canvas-21` |
| §9 `bun run test:e2e` cold on Windows, a tracked perf corpus, a clean tree | #181 | `test/e2e-windows-stack-and-corpus` | `verify-2` |
| §9 one cached tree walk, fixture containment, the auto-promote case | #189 | `test/e2e-baseline-and-reliability` | `verify-4` |

**`verify-4` is the one incomplete work order.** The account hit its weekly model limit mid-wave
and took five agents with it; four had already pushed everything, `verify-4` had not finished the
full cold-suite triage. What it did land is complete on its own. What it did not is the first
item under "What is still open", below.

**Two defects only the merge could find**, both fixed in the integration branch: the generated
studio-runtime bundles were stale against the merged tree, and `server-26`'s subprocess-output
gate built its own directory walk, which `verify-4`'s new shared-walk rule forbids — migrated
onto the shared cache rather than allowlisted.

---

## 1. The spine — why "I made this multiple times and the errors ruin it"

Every previous wave fixed a defect and shipped it green. The recurring failure is not any one
defect; it is four structural habits, each of which makes the next defect user-visible:

1. **Every error has a toast, and toasts do not de-duplicate.** `pushToast` is opt-in dedup
   (`toastBus.ts:51-109`); 139 call sites, 3 files use `dedupeKey`. `ErrorBoundary` toasts by
   default (`ErrorBoundary.tsx:128-153`) and only the per-node boundary opts out. So one root
   cause = N identical red boxes. That is the "noisy errors" experience.
2. **Loops have no ceilings.** The HTTP tool loop is `for (;;)` (`toolLoop.ts:173`) with no round
   cap and no same-call suppression; the CLI driver has a 10-minute **idle** timeout and no total
   cap (`claudeCliSpawn.ts:115`); the dev-server readiness poll logs every tick with no backoff
   (`useDevServerReadiness.ts:66`). That is the "made a million times" and "20–30 minutes for one
   page" experience.
3. **The process restarts under the user.** `bun run dev` spawns `bun --watch server/index.ts`
   (`scripts/dev.ts:245`); Studio writes into `studio-workspace/` constantly; the watcher has
   panicked before and wedged the port (`docs/state-archive/2026-Q3.md:3454-3466`). Two job stores
   exist only to survive this restart. Every mid-session reload the user cannot explain is this.
4. **Nothing gates feel.** The only real canvas perf numbers live in a Playwright spec nobody runs
   in CI; the Bun bench cannot launch Chromium on Windows (`studioBoard.bench.ts:51-64`);
   `## Pending dogfood` in STATE.md is twelve features long. Green gates, unusable surfaces.

Phase 0 below removes all four habits **before** any feature work, and adds a gate for each so
they cannot come back. Everything after it is ordinary feature work on a foundation that stays
quiet.

---

## 2. Track map

| Track | Delivers | Size | Owner |
|---|---|---|---|
| **Z — Zero noise** (Phase 0, barrier) | No stacked toasts, no boundary toasts, bounded loops, no self-restarts, live-frame errors captured, fresh-checkout builds | M | `store-engineer` · `server-engineer` · `canvas-engineer` · `test-engineer` |
| **S — Snappy** | Zoom never stalls, drag never re-renders per move, one measured 60 fps budget per gesture, gated in CI | L | `perf-hunter` · `canvas-engineer` |
| **K — Keys and hands** | Alt+drag duplicate, Ctrl+G/⇧G, Ctrl+[ ], lock key, Alt-hover measure, H/K tools, free movement that stays honest, one key dispatcher | L | `canvas-engineer` · `store-engineer` · `parser-surgeon` |
| **P — Panels, prototype, preview** | Inspector fits 900 px, multi-select through the one model, richer prototype triggers and smart-animate, Tier-0/2 preview that never breaks silently | L | `panel-designer` · `canvas-engineer` |
| **A — Agent** | Bounded fast turns, a design policy control (follow / balanced / free), quality that survives "creative", every tool honest about what it needs | M/L | `mcp-tooling` |
| **G — GitHub** | Connect a repo, sign in, branches list/create/switch, fetch/pull with conflicts surfaced, push, open a PR, one write lock | L | `server-engineer` · `panel-designer` · `security-guard` |
| **V — Verification** | A browser gate that runs, the Windows failure bucket closed, the dogfood backlog driven | M | `test-engineer` · `studio-verifier` · human |

Hard edges: **Z before everything.** S2 before K2/K6 (they share the drag session). G7 (write
lock) before G4 (pull). A10 needs the Tier-2 decision (§6). Everything else is parallel — see the
collision map in §4.

---

## 3. Work orders

Each work order is one commit on a `<type>/<kebab>` branch, one draft PR, one `STATE.md` entry,
docs updated in the same change. Sizes: S ≤ ½ day, M ≤ 2 days, L ≤ 1 week.

### TRACK Z — Zero noise (Phase 0, barrier)

#### Z1 — Toasts de-duplicate by default (S) · `store-engineer`
- `src/ui/components/Toast/toastBus.ts`: derive `dedupeKey` from `kind + title + body` when the
  caller passes none; an explicit `dedupeKey: false` opts out (only for genuinely distinct
  events, e.g. two different uploads). A repeat within the toast's lifetime bumps a `×N` counter
  on the existing toast instead of stacking.
- `studioStructuralCommits.ts:113-118, :372` — the "Still writing your last change" warning and
  the insert/duplicate/wrap success toast are the two the owner has already seen stacked.
- Gate (`test-engineer`): `toast-dedupe-default.test.ts` — a `pushToast` without `dedupeKey`
  twice yields one toast with count 2.
- Done when: rapid ⌘D ×5 on the canvas shows one "Duplicated" toast and one "Still writing", never
  five.

#### Z2 — Error boundaries never toast; they render in place (S) · `store-engineer` + `panel-designer`
- `ErrorBoundary.tsx`: default `silentToast: true`. Every seam except `admin-shell` renders an
  in-place fallback (`--bg-surface-2` panel, one line, a "Reload this panel" `Button`) instead of
  the toast. `admin-shell` keeps the toast (nothing else can render).
- `error-boundary-coverage.test.ts` gains the assertion; delete the per-site `silentToast` at
  `NodeRenderer.tsx:588-592` (now the default).
- Done when: throwing inside a panel shows the fallback in that panel and nothing else moves.

#### Z3 — Every loop has a ceiling (M) · `mcp-tooling` + `server-engineer`
- `server/ai/drivers/http/toolLoop.ts:173`: `MAX_TOOL_ROUNDS` (default 40) and a per-turn
  `seenMutatingCalls` set keyed by `hash(toolName + canonical args)`. A repeated **mutating** call
  with identical args in one turn is answered with a structured
  `{ code: 'duplicate-call', priorResult }` tool result, not re-executed. Read-only tools are
  exempt (the model may legitimately re-read).
- `server/ai/drivers/claudeCliSpawn.ts:115`: add `TOTAL_TURN_CAP_MS` (default 20 min, per-turn
  override via the existing session controls). On cap: send the CLI its `interrupt` stdin
  message, surface one `error` event with the last tool it was on, keep the warm session alive.
- `src/admin/pages/site/studio/useDevServerReadiness.ts:66`: exponential backoff (1 s → 10 s),
  log once per phase change.
- `server/ai/mcp/editorBridge.ts`: confirm every bridge-routed `studio_*` write reaches the store
  through `writeInsertToSource` / `writeDuplicateToSource` / `writeWrapToSource` and therefore
  `guardAgainstConcurrentStructuralCommit()`; the scout could not prove it. If any path bypasses
  the guard, route it through.
- Gate: `no-unbounded-tool-loop.test.ts` (a driver loop file must reference the round cap).
- Done when: a fixture model that emits the same `studio_duplicate` call 50 times produces one
  write and a transcript that says why.

#### Z4 — The dev server does not restart itself (M) · `server-engineer`
- First, **measure**: with `bun run dev` running, write a file in `studio-workspace/test4/` and
  check whether the server restarts. Record the answer in the STATE.md entry — the incident is
  documented, the mechanism is not proven.
- If it restarts: replace `--watch` in `scripts/dev.ts:245` with a supervisor in `scripts/lib/`
  that watches **only** `server/**`, `src/core/**`, `vendor/**` (the module graph the server
  actually imports) with `fs.watch` recursive, debounced, and restarts the child cleanly (SIGTERM,
  wait for the listening socket to close, respawn). Never watch `studio-workspace/`, `uploads/`,
  `.tmp/`, `.data/`.
- Also add `**/studio-workspace/**` to `vite.config.ts:236-243` `server.watch.ignored`.
- Delete the two "survive a `bun --watch` restart" comments' *premise* only if the restart is
  actually gone; the job stores themselves stay (they are correct anyway).
- Done when: a 5-minute agent session writing 30 files into a workspace produces zero server
  restarts in the log.

#### Z5 — A live frame that crashes says so, quietly (M) · `canvas-engineer` + `mcp-tooling`
- `src/core/studio-runtime/messages.ts:260-387`: add outbound `error` (`{ kind: 'exception' |
  'unhandledrejection' | 'resource' | 'console', message, stack?, source? }`), capped and
  rate-limited in the runtime.
- `runtime.ts`: install the same four taps `CanvasDiagnosticsInjector.tsx` installs for portal
  mode (`error` capture, `unhandledrejection`, `console.error`, `fetch`), post them over the
  bridge. Run `bun run studio-runtime:sync`.
- Parent side: route into `canvasDiagnosticsBuffer.ts` (so `studio_page_diagnostics` sees Tier-2
  frames too) **and** render a passive per-frame badge on the board frame chrome (a small
  `--warning` dot with a hover popover listing the last 5 entries). Never a toast.
- Vite's own error overlay inside the live iframe is fine to keep — it is the user's app telling
  the truth — but confirm the generated `vite.config.js` template does not disable it.
- Done when: throwing in a Tier-2 page shows the badge, the popover has the stack, and the agent's
  `studio_page_diagnostics` returns it.

#### Z6 — Unsaved is a state, not a surprise (S) · `panel-designer`
- `usePersistence.ts:214-218` correctly restores the dirty snapshot on a failed save and stays
  silent. Make the state visible: a status chip in the toolbar (`Saved · Saving… · Unsaved — retry`)
  bound to `saveStatus`, with retry on click and automatic retry with backoff (3 tries) before it
  reads "Unsaved". Same chip reflects `structuralCommitInFlight`.
- Done when: killing the server mid-edit turns the chip red with a retry; restarting the server
  and clicking retry lands the edit; no toast at any point.

#### Z7 — A fresh checkout builds, and generated artefacts cannot drift (S) · `server-engineer`
- `scripts/dev.ts` preflight: if `node_modules/alm-design-system` is missing or `bun.lock` is
  newer than `node_modules/.bun-install-stamp`, run `bun install` first and say so.
- Same preflight runs `alm:check`, `studio-runtime:check`, `icons:check`, `bootstrap:check` and
  prints the one-line fix if any drifts — the four `*:sync` gates that failed today did so
  silently for everyone using the running app.
- Done when: `git clone && bun run dev` on a clean machine starts without a manual step.

#### Z8 — The residual CSS refusal picks the open page (S) · `parser-surgeon` + `store-engineer`
- `cssInsertDestination.ts:179-182` refuses `no-editable-stylesheet` because it "has no notion of
  which page is open". The client does. `collectStyleRuleEdits` passes `activePageId`; the
  resolver treats the open page as the co-location anchor for a freestanding rule. The rule
  lands in that page's stylesheet (or creates it via the existing `create` branch).
- `ambiguous-stylesheet` (N candidates, none co-located) stays a choice — but as a
  `RefusalDialog` listing the N files (R2's mechanism), not a toast.
- Done when: creating a class on the Selectors panel with three stylesheets in the project either
  writes or asks which file, and never toasts.

**Phase 0 exit:** a 30-minute dogfood on `studio-workspace/test4` with the agent building two
screens while the human edits a third produces zero red toasts, zero server restarts, one toast
per distinct event, and a saved-state chip that never lies. Then S/K/P/A/G may start.

---

### TRACK S — Snappy

#### S1 — A frame mount that does not block a zoom (L) · `perf-hunter` + `canvas-engineer`
The measured defect: zooming out from 6 to 15 mounted frames costs **290–337 ms in one frame**
(`tests/e2e/studio-board-perf.e2e.ts:58-68`), because one `BreakpointFrame` mount is 100–140 ms
of synchronous work. `useDeferredValue` and staggering were tried and reverted
(`docs/state-archive/2026-Q3.md:7219-7230`). The fix is to make one mount cheap:
- Profile a single mount (`IframeFrameSurface.tsx` → injector chain → `NodeRenderer` tree) and
  split it: (1) iframe + `srcDoc` skeleton only, (2) injectors on the frame's `load`, (3) node
  tree via `startTransition` after first paint. Poster stays visible until (3) commits
  (`frameSnapshotCache.ts` already exists).
- An iframe **pool** (perf-06 Phase B): frames leaving the viewport hand their iframe back; a
  frame entering takes one and re-points it, avoiding a fresh document create. Budget the pool at
  `max(8, visible + 4)`.
- Ratchet `BUDGET_ZOOM_WORST_FRAME_MS` from 600 to **50**; gate in V1.
- Done when: pinch-zooming a 40-frame board from fit to 100 % never drops a frame > 50 ms.

#### S2 — The element drag is a session, not a re-render (M) · `canvas-engineer`
`useCanvasReorderDrag.ts:266-295` does two forced layout reads and a `setState` per raw
`pointermove`. Rewrite as D2's deferred `dragSession`:
- Build `frameCandidateIndex` **once** at `beginDrag` (rects of every candidate in the frame,
  plus the viewport rect and zoom) and only rebuild on a real reflow (`ResizeObserver` on the
  frame body).
- Pointer moves update a ref; one rAF resolves the drop target and writes the indicator by direct
  DOM mutation inside the frame (the pattern `useElementResizeDrag.ts:114-127` already uses).
  The store is written once, on `pointerup`.
- Escape cancels; Shift constrains axis; the ghost follows the cursor exactly (K6 builds on this).
- Done when: dragging inside a 500-node page records zero React commits between pointerdown and
  pointerup.

#### S3 — Sandboxed modules stop subscribing to the world (S) · `canvas-engineer`
`ModuleSandboxFrame.tsx:64` selects `s.site`; `:79-80` runs `generateClassCSS` in the render body.
Select `s.site?.styleRules` + the node's own `classIds`, compute CSS in the same cross-frame memo
`canvasClassCss.ts` uses. Add the file to the selector-stability gate.

#### S4 — The selection overlay is event-driven (M) · `canvas-engineer`
`BreakpointSelectionOverlay.tsx:536-553` runs a rAF loop forever while anything is selected. Keep
the loop **only** during an active gesture (drag, resize, pan, zoom) and while `hmr:before →
hmr:after` is in flight; otherwise re-measure on `ResizeObserver`, scroll, transform commit and
tree mutation. N frames idle at 0 rAF/s.

#### S5 — Inspector fits, and multi-select goes through the one model (M) · `panel-designer` + `store-engineer`
- The text-node inspector measures ~1400 px against the 900 px budget (STATE.md `panel-27`)
  because the five Studio-extras sections are always mounted. Move Transform / Animations /
  Interaction / CustomProperties behind one collapsed **More** disclosure in Design, and keep
  them expanded on the Prototype tab where they belong. Land WS-14.5's measurement gate
  (`scrollHeight <= clientHeight` at 900 px on the four fixtures).
- `selectionModel.ts:36-42` excludes multi-select; `MultiSelectionInspector.tsx`,
  `MultiInlineStyleComposer.tsx`, `MultiSelectorInspector.tsx` are the old paradigm. Extend
  `SelectionModel` to N nodes with `Mixed` per field (the `ScrubInput` sentinel already exists),
  delete the three old files, and land WS-14.4 (selection colours) on top.
- Done when: `bun test src/__tests__/panels` has the height gate green and no file under
  `panels/PropertiesPanel/` renders a multi-node surface.

#### S6 — A perf gate that runs on this machine (S) · `test-engineer`
`scripts/bench/studioBoard.bench.ts` cannot launch Chromium under Bun on Windows. Make
`bench:studio-board` shell out to `npx playwright test tests/e2e/studio-board-perf.e2e.ts`
(Node runner) and fail on budget. Wire the same spec into CI (V1). Delete the bench file's dead
Bun-launch path.

---

### TRACK K — Keys and hands

#### K1 — One key dispatcher (M) · `canvas-engineer`
21 independent `keydown` listeners (`useCanvasSelectionKeyboard.ts:189-190`, `CanvasRoot.tsx:388`,
`useBoardFrameNudge.ts:81`, …) each re-implement the guards. Keep `keybindings.ts` as the single
registry; add `useEditorKeyDispatcher` mounted once in `SitePage`, which resolves the pressed
chord against the registry and dispatches to the **highest-precedence active scope**:
`inline-edit > prototype-link > annotation > node > board > global`. Each former hook becomes a
scope handler registered with the dispatcher (no listeners of its own). The iframe forwarding
bridge stays (`useIframeEventForwarding.ts:174-187`) — it feeds the same dispatcher. Fix the
Windows path bug in `keybindings-registry-single-source.test.ts` and make it assert there is one
`addEventListener('keydown'` under `src/admin/pages/site/canvas/`.

#### K2 — Alt+drag duplicates (M) · `canvas-engineer` + `parser-surgeon` · after S2
- Board frames: Alt held at `pointerdown` on a frame → the drag moves a copy; on `pointerup` write
  a new frame into `boards.json` (cheap, no source write) via the existing `duplicateFrame`.
- Elements: Alt held → the session is a **duplicate-to** plan: on drop, one codemod
  `duplicateJsxElement(source, { to: { parentId, index } })` (extend the existing codemod with an
  explicit destination) through `writeDuplicateToSource` and the structural guard. Refuses by
  the same reasons a move would (`list-row`, `shared-component`, cross-file) through
  `RefusalDialog`.
- Releasing Alt mid-drag reverts to a move; the ghost shows a `+` badge while Alt is held.

#### K3 — Group and ungroup (M) · `parser-surgeon` + `store-engineer`
- ⌘G on one node = the existing `wrapNode`. ⌘G on N **contiguous siblings** = new
  `wrapJsxElements(ids, wrapper)` codemod (one `<div>` around the range, formatting-preserving);
  non-contiguous or cross-parent selections refuse with `multi-select` and the remedy "select
  siblings next to each other".
- ⌘⇧G = new `unwrapJsxElement(id)`: hoists the children into the parent at the wrapper's index.
  Honest refusal when the wrapper carries anything but `className`/`style` Studio itself wrote
  (a `key`, an event handler, a ref, spread props) — "this container has behaviour; open in code".
- Both are `applyTreeOperation` kinds, both in the 11-action list (`group`, `ungroup` — the gate
  `no-vc-mode-branches-in-mutations.test.ts` grows by two).

#### K4 — The missing bindings (S) · `canvas-engineer`
`⌘[` / `⌘]` → `layers.moveDown` / `layers.moveUp` (exists as ⌥↑/↓; keep both). `⌘⇧L` →
`layers.toggleLock` (command exists at `commands/layers.ts:214-235`, unbound). `H` → hand tool
(latched space-pan). `K` → scale tool (arms the resize handles on the selection with
proportional lock). `R` → insert a Container (the Assets panel's `base.container`) at the
selection, `O` → the same with `border-radius: 50%`. All in `keybindings.ts`, all in the `?`
sheet.

#### K5 — Alt-hover measures (M) · `canvas-engineer`
With a selection and Alt held, hovering another node draws the four distances (selection edge →
hovered edge) and the hovered node's padding, in the in-frame overlay (`BreakpointSelectionOverlay`
already draws inside the iframe; add a `MeasureLayer`). Geometry from the frame adapter's
`measure` (both portal and bridge). Numbers use `--text-*` mono tokens on a `--accent-*` pill.
Not to be confused with `CanvasTreeLadderOverlay.tsx` (Alt-hold ladder), which stays.

#### K6 — Free movement that stays honest (M) · `canvas-engineer` + `store-engineer` · after S2
§15 decision 3 of the parity plan stands: Studio does not fake absolute placement of flow
elements. But the **feel** can be Figma's:
- Flow element: the ghost follows the cursor exactly; the live reflow preview
  (`previewStructuralMove`, D2 G5) shows siblings making room; snap lines to sibling edges and
  centres; drop commits a reorder/reparent.
- An element that is already `position: absolute | fixed` (parsed from its rule or inline
  style), or any element while the user holds **⌘ while dragging** inside a `position: relative`
  parent: the drag writes `left`/`top` (or `inset-inline-start` in RTL) as an inline style via
  `setJsxStyle` — one honest target. ⌘-drag on a flow element in a static parent refuses with the
  remedy "make the parent `position: relative`" as a one-click action.
- Board frames already move freely; add snap-to-frame-edges and the alignment guides Figma shows.

#### K7 — Paste and duplicate land where the eye expects (S) · `store-engineer`
⌘V pastes as the next sibling of the selection (not the end of the parent); ⌘D likewise
(`duplicateJsxElement` already does; confirm paste does). Both select the new node and keep the
inspector open on it.

---

### TRACK P — Panels, prototype, preview

#### P7 — Prototype triggers and smart-animate (L) · `canvas-engineer` + `store-engineer`
- Triggers: `click` today; add `hover`, `press`, `after-delay(ms)`, `key`. Schema slot exists
  (`prototypeModel.ts`); the reader currently repairs anything else to `click`.
- **Smart animate**: for a `navigate` between two screens, match nodes by `NodeHint` (the same
  re-resolution `.studio/prototype.json` uses) and FLIP them with WAAPI between the two
  `PrototypeScreenStack` slots; unmatched nodes dissolve. Both screens are live iframes, so the
  FLIP runs on cloned boxes in the parent overlay, not on the iframes.
- Call `prunePrototypeLinks` from `deletePage` (it exists; nothing calls it).
- Done when: a two-screen prototype with a shared header slides its content and keeps the header
  still, at 60 fps in the e2e perf spec.

#### P8 — The preview never breaks silently (M) · `canvas-engineer` + `server-engineer`
- Z5's error channel is the foundation. On top: the Play surface shows a frame-level "This screen
  crashed — open diagnostics" card in place of a white frame (both tiers).
- Tier-0/1 Play renders the parsed tree through Studio's React (that is by design and it is
  fast). Make it explicit in the Play chrome: a `Static · Live` pill that says which one is
  running. Per §6 decision 2, a Vite project with a lockfile is **promoted on first open** with
  a one-line notice and an undo; the pill's "Run the real app" action remains for a project
  the owner put back to static. `security-guard` reviews this PR.
- Non-Vite projects (Next/CRA) cannot go live today. Decide (§6) whether the Babel adapter is in
  scope; until then the pill says "Live needs Vite" instead of failing.
- **Delete `PreviewOverlay.tsx`** and its spotlight command (`commands/preview.ts`): it renders the
  CMS publisher's static HTML into a sandboxed iframe — a third preview that is neither the
  canvas nor the real app and the one most likely to look "broken". Nothing in Studio depends on
  it; the publisher stays for the CMS half.

#### P9 — Figma parity gaps in the inspector (M) · `panel-designer`
The section order already matches. What is missing, in Figma's own terms: a **Constraints**
crosshair on absolute children (mapping exists, `inspector-w8-4-constraints`), an
**Auto layout** visual (gap/padding boxes on the Layout section, flex direction glyphs),
per-corner radius **link** toggle, **Blend** mode on Fill layers, and the `Mixed` state on every
field under S5. Each lands as one section PR against the P6 gate, deleting whatever old control it
replaces.

---

### TRACK A — Agent

#### A9 — A turn has a budget and shows its work (M) · `mcp-tooling`
- Z3's total cap plus a **step budget** in the prompt: the static prefix states the round budget
  and the model reports `step k/N` in the transcript; the AgentPanel renders a progress line
  ("Writing Home.tsx · 3 of 6") from tool-call events, so "is it stuck?" is answerable.
- Record per-turn telemetry to `.studio/agent-turns.jsonl` (tool name, ms, bytes, cache hit).
  `bench:agent-turn` reads it; set budgets: **one screen, balanced with a reference: ≤ 3 min;
  one screen, creative, no reference: ≤ 90 s.** Where a turn overruns, the log says which tool.
- Finish W9-3's mode-aware Stop gate halves (creative: a passing `studio_quality_check` since the
  last write; balanced: every differing region named) so the gate never asks for a measurement
  the mode does not define.

#### A10 — The best verification tool is reachable (S) · `mcp-tooling` + `security-guard`
Parity plan §15 decision 1, recommended option: grant `studio.run.project` behind the project's
Tier-2 promotion. Unify the gate: `studio_render_reference` checks the target project's trust
tier through `requireTrustTier` (closes STATE.md `sec-05` finding 1), not only the connector
capability.

#### A11 — The prompt cannot describe a tool wrongly (S) · `mcp-tooling` + `test-engineer`
`systemPrompt.ts:278` still says `studio_computed_styles` needs the open board; it went headless
in `mcp-20`. Generate that sentence from tool metadata (`execution: 'server' | 'bridge'`), and add
`prompt-claims-match-tool-metadata.test.ts` so it cannot drift again.

#### A12 — A design policy the user actually controls (M) · `mcp-tooling` + `panel-designer`
Fidelity mode (creative/balanced/strict) is about **measurement against a reference**. The owner's
ask is a second axis: **design-system adherence**. Add `designPolicy: 'follow' | 'balanced' |
'free'` beside fidelity in `AgentSessionControls.tsx`, persisted like fidelity:
- `follow`: `studio_quality_check`'s `raw-hex-color`, `raw-px-length`, `off-scale-*`,
  `design-system-coverage-low` are errors; the prompt block says "only tokens and `alm.*` /
  `design-system/` components".
- `balanced`: same findings as warnings; the prompt allows one-off values with a stated reason.
- `free`: the design-system findings are off; the prompt block says the design system is
  optional and asks for a distinct visual language; variant seeds (`variantSeeds.ts`) draw from an
  extended palette/type pool, not only the project's tokens.
The Stop gate honours the policy (a `free` turn is not failed on token findings).

#### A13 — Creative that looks designed (M) · `mcp-tooling`
Extend `compositionAudit.ts` and the creative prompt block with **layout archetypes** (hero,
feature grid, split, testimonial band, pricing, footer) and the rules that make them read as
designed: a type scale with ≥ 3 steps in use, one accent, consistent radius family, breathing
room ≥ 1 spacing step between bands, contrast ≥ AA. Variant seeds pick an archetype sequence, so
A/B/C differ in structure, not only in tokens. Add `studio_quality_check` findings
`monotone-band-rhythm` and `no-focal-point` (largest text-size delta below the hierarchy ratio).

#### A14 — Tool errors are structured everywhere (S) · `mcp-tooling`
Every `studio_*` tool returns `{ ok: false, code, remedy?, retryable }` on refusal (most already
do — audit `server/ai/mcp/tools/studio/*.ts` for bare `throw`). The prompt's failure-example
list says: a `retryable: false` code is never retried with the same args.

---

### TRACK G — GitHub

The panel's local half is solid (`docs/features/studio-git.md`). Everything below is **new
surface**; none of it changes the safety rails (argv only, no force, no stash, no `add -A`).

#### G7 — One write lock per project (S) · `server-engineer` · **first**
`server/handlers/studio/projectWriteLock.ts`: an async mutex keyed by real project path.
`studioWriteback.ts`, `studioCssWriteback.ts`, `pageScaffold.ts`, `installDeps.ts` and every
`gitOperations.ts` verb acquire it. A git verb waiting on a save reports `busy` after 5 s rather
than an `index.lock` error.

#### G1 — Connect a repository (M) · `server-engineer` + `panel-designer`
- Routes: `GET git/remotes`, `POST git/remote { set: { name: 'origin', url } }` (URL validated:
  `https://github.com/<owner>/<repo>(.git)?` or `git@github.com:…` only). No other remote name in
  v1.
- GitPanel header becomes a **Repository** block: "Connect" (paste a URL, or pick from your GitHub
  once signed in via G2) · shows `origin` · ahead/behind after G4.
- A GitHub zipball import gets a **Clone (keeps history)** alternative (`git clone --filter=blob:none`
  into `studio-workspace/<owner>-<repo>` using G2's token), so an imported project arrives with
  `.git` and `origin` set.

#### G2 — Sign in to GitHub (M) · `server-engineer` + `security-guard`
- **GitHub device flow** (no client secret; needs a GitHub OAuth App client id in config) with
  scopes `repo`, `workflow` off by default. The token is stored **encrypted per user** in a new
  additive migration `git_credentials` (`user_id`, `provider`, `ciphertext`, `iv`, `created_at`,
  `expires_at`) in both `migrations-pg.ts` and `migrations-sqlite.ts`. A paste-a-PAT fallback
  exists for servers where the device flow is blocked.
- Git never sees the token in its environment: `gitRunner.ts` gets a `credential` option that
  writes a one-shot `GIT_ASKPASS` script to a `0600` temp file printing the token, deletes it in
  `finally`. `GIT_TERMINAL_PROMPT=0` stays. Nothing is logged.
- Done when: push over HTTPS to a private repo succeeds with no OS credential helper configured,
  and `git config --list` in the project shows no token.

#### G3 — Branches (M) · `server-engineer` + `panel-designer`
- `GET git/branches` (`for-each-ref` local + remote, current, upstream, ahead/behind).
- Panel: a branch dropdown (`Select` primitive) replacing the free-text field; "New branch from
  current"; switch with a dirty tree opens a dialog: **Commit and switch** (one action: commit the
  ticked files, then switch) or **Cancel**. Studio still never stashes.

#### G4 — Fetch, pull, and conflicts you can see (L) · `server-engineer` + `panel-designer` · after G7
- `POST git/fetch`, `POST git/pull { strategy: 'ff-only' | 'rebase' | 'merge' }` (default
  `ff-only`; on divergence the panel offers rebase or merge explicitly).
- A conflict returns `409 { code: 'conflict', files }`. The panel lists them with **Keep mine /
  Keep theirs / Open in code** per file (`git checkout --ours|--theirs -- <file>` + `git add`),
  and a **Continue** that finishes the rebase/merge. `git rebase --abort` / `merge --abort` is
  the one new destructive verb, behind a confirm.
- Status shows ahead/behind after every fetch; push is disabled while behind with "Pull first".

#### G5 — Open a pull request (M) · `server-engineer` + `panel-designer`
`POST git/pull-request { title, body, base }` → GitHub REST with G2's token; returns the URL. Title
defaults to the last commit subject, body to the commit list. "Open PR" appears after a
successful push to a non-default branch. `studio_git_open_pr` MCP tool, gated by
`studio.git.write`.

#### G6 — Agent parity (S) · `mcp-tooling`
`studio_git_push`, `studio_git_branch`, `studio_git_status` beside the existing
`studio_git_commit`, all behind `studio.git.write`, all through the same operations module.

#### G8 — Dogfood with a real remote (human) — the doc's own precondition
A private repo on the owner's GitHub: import via clone, edit, branch, commit, push, pull a change
made on GitHub, resolve one deliberate conflict, open a PR. Recorded as a STATE.md dogfood entry.

---

### TRACK V — Verification

#### V1 — A browser gate that runs (M) · `test-engineer`
- CI: a `playwright` job on Linux running `tests/e2e/studio-board-perf.e2e.ts`,
  `inspector-panel-measurement.e2e.ts`, and a new `studio-feel.e2e.ts` (Alt+drag, ⌘G, ⌘D ×5
  = one toast, Escape ladder, zoom worst-frame) against `studio-workspace/test4`.
- Local: `bun run test:e2e` documented as the fourth gate for canvas/panel changes
  (`standing-02` already says browser for layout).

#### V2 — The Windows failure bucket is closed, not tolerated (M) · `test-engineer`
`standing-01` has carried "the honest not-mine bucket" for seven weeks. Fix the path-separator
gates (`no-core-barrel-deep-imports`, `keybindings-registry-single-source`, `codemirror-lazy-only`,
`dispatcher-html-pipeline`, `error-boundary-coverage`, `selectorStability`, `cacheLayout`,
`cmsMigrations`) with `path.posix` normalisation; quarantine the QuickJS/worker suites behind a
`describe.skipIf(process.platform === 'win32')` with a linked issue only where the runtime itself
is the blocker; make `AdminCanvasLayout` ×10 and `liveOrigin` ×7 pass or delete them. Target:
`bun test` green on Windows, under 6 minutes.

#### V3 — New gates this plan adds
`toast-dedupe-default`, `no-unbounded-tool-loop`, `keybindings-single-dispatcher`,
`prompt-claims-match-tool-metadata`, `error-boundary-silent-default`, `inspector-height-900`,
the perf budgets in V1. Each lands with the work order that motivates it.

#### V4 — The dogfood backlog (human, scripted)
STATE.md `## Pending dogfood` lists twelve features never driven. Phase 0's exit dogfood
(above) and G8 cover the ones this plan touches; the remainder get a single batched session
with the scripts as written. A feature not driven is not done — `standing-authorization` already
says so.

---

## 4. Collision map — what may run in parallel

**Single-file collision points** (serialize or split by sub-router, per `standing-05`):
`server/handlers/studio.ts` (route table — G1/G3/G4/G5 add routes: one sub-router file each),
`src/admin/spotlight/keybindings.ts` (K1/K2/K4 — K1 lands first), `useCanvasReorderDrag.ts`
(S2 rewrites it; K2/K6 wait), `studioStructuralCommits.ts` (Z1/Z3 touch it; do them together),
`systemPrompt.ts` (A9/A11/A12/A13 — one `mcp-tooling` agent, sequential), `STATE.md` (scratch
handoffs merged by the orchestrator during a wave).

**Verified-disjoint sets:** {Z4, Z7} ∥ {Z1, Z2, Z6} ∥ {Z5} ∥ {Z3, Z8}. {S1} ∥ {S3, S4} ∥ {S5} ∥
{S6}. {K3, K5} ∥ {K4, K7}. {P7} ∥ {P8} ∥ {P9}. {G1, G2} ∥ {G3} then {G4} then {G5, G6}.
Track A is one agent throughout. Track V's V2 may start on day one.

---

## 5. Sequencing

```
week 1   Z1 Z2 Z3 Z4 Z5 Z6 Z7 Z8 ── Phase 0 exit dogfood (barrier)        V2 starts
week 2   S1 (perf-hunter) · S2 · S3 S4 · K1 · G7 G1 G2 · A9 A11 · P8 · V1
week 3   S1 cont. · S5 · K2 K3 K4 · G3 G4 · A10 A12 · P7 · V3 gates as they land
week 4   S6 · K5 K6 K7 · G5 G6 · A13 A14 · P9 · G8 dogfood
week 5   V4 batched dogfood · docs truth pass (WS-14.6) · one PR to main
```

Hard edges restated: Z → all · S2 → K2, K6 · G7 → G4 · K1 → K2, K4 · A10 → §6 decision 1.

---

## 6. Decisions — called by the owner on 2026-09-17

| # | Decision | Consequence in this plan |
|---|---|---|
| 1 | **Yes** — grant `studio.run.project` behind Tier-2 promotion | A10 proceeds as written |
| 2 | **No prompt — promote.** Owner override of the "explicit click" rule in `CLAUDE.md`/`PROJECT-BRIEF.md` for Vite projects: a Vite project with a lockfile is promoted to Tier 2 on first open, with a one-line notice in the board chrome and an "Undo — back to static" action. Non-Vite projects stay at Tier 0. **Superseded 2026-09-20:** the owner's later call was narrower and simpler — *every* project starts at Tier 2 (`run-project`, `DEFAULT_TRUST_TIER`) by default, full stop. There is no lower default left to promote FROM, so the automatic-promotion mechanism (`LiveAutoPromoteNotice`, `trustTier.ts`'s `refuseAutoPromotion`, the `trustAutoPromoted`/`trustAutoPromotedAt` fields) was retired in the same change that flipped the default. `CLAUDE.md`, `PROJECT-BRIEF.md`, and the docs this row lists were updated again to state the new rule. | P8 changes: no consent dialog for Vite; `trustTier.ts` gains an `autoPromoted: true` flag so the origin of the promotion is recorded; the rule text in `CLAUDE.md` §invariant 1 and `PROJECT-BRIEF.md` §2 is amended in the same PR. `security-guard` reviews P8. |
| 3 | **Device flow + PAT fallback** | G2 as written |
| 4 | **Yes** — ignore `studio-workspace/*` except a named sample list; ignore `prototype/*.generated.*` inside kept projects | New work order **Z9** (S, `server-engineer`): `.gitignore` rules + `git rm --cached` of the committed generated files, one PR, before any other Track Z PR so nobody re-commits them |
| 5 | **Defer** non-Vite live frames | P8 shows "Live needs Vite" |
| 6 | **Yes** — ⌘-drag may write `left`/`top` inline for an already-absolute element or inside a relative parent | K6 as written |
| 7 | **Document "single operator" now; gate every route in a follow-up wave** | New work order **Z10** (S, `server-engineer`): the posture paragraph in `docs/server.md` + a `PROJECT-BRIEF.md` trap entry. The route-gating wave is listed under §9 as the first follow-up after this plan. |

The original questions are kept below for the record.

1. **Grant `studio.run.project` behind Tier-2 promotion?** (A10; parity plan §15.1, still open.)
   *Recommend yes* — the consent click already exists for exactly this.
2. **Ask once to promote a Vite project to Tier 2 on open?** (P8; live plan §7.2.)
   *Recommend ask once, default No*, same as the Tailwind consent banner.
3. **GitHub auth shape.** Device flow (needs a GitHub OAuth App client id you create once) with a
   PAT fallback, or PAT only. *Recommend device flow + PAT fallback* — PAT-only makes "connect"
   a chore.
4. **Should `studio-workspace/` stay committed in Studio's own repository?** Commit `188fda1a`
   added 140,894 lines of a test project's generated `prototype/*.generated.js` and
   `design-system/` copy. *Recommend*: gitignore `studio-workspace/*` except a named sample
   project list, and ignore `prototype/*.generated.*` inside any kept project.
5. **Non-Vite live frames (Next/CRA Babel adapter)?** *Recommend defer*; P8 makes the limit
   visible instead of silent.
6. **Free movement via ⌘-drag writes `left`/`top` inline (K6).** This is the one place the plan
   lets a gesture write a positional style. *Recommend yes*, since the target is honest and the
   refusal for a static parent is explicit; say no and K6 ships reorder-with-preview only.
7. **Studio-surface auth posture** (`sec-05` finding 2: most Studio routes have no per-request
   capability check). Not in this plan's tracks, but G2 stores a real token, so it has to be
   answered before any multi-user deployment. *Recommend*: document "single-operator tool" in
   `docs/server.md` now, and gate every Studio route with `requireCapability` in a follow-up
   wave.

---

## 7. The errors you did not report — found in this audit

Ranked by how likely they are to hit you on an ordinary day. Each maps to a work order above.

| # | What happens | Where | Fix |
|---|---|---|---|
| 1 | ~~The dev server restarts mid-session when Studio writes into a workspace~~ — **the premise was wrong, and Z4 measured it.** Bun's `--watch` keys on the entry's transitive MODULE GRAPH, per file: 300 files written into `studio-workspace/` produced zero restarts. The real defect was **Vite**, which watches the repo root as a TREE and full-reloads on any watched `.html` change that maps to no module — and every Vite-template app Studio imports ships a root `index.html`, so importing a project reloaded the editor out from under the user | `vite.config.ts` `server.watch.ignored` (was `scripts/dev.ts:245`) | Z4 · #136 · `dev-04` |
| 2 | Identical toasts stack (139 call sites, 3 use `dedupeKey`) | `toastBus.ts:51-109` | Z1 |
| 3 | Any render crash outside a single node produces a red "Render failed" toast | `ErrorBoundary.tsx:128-153` | Z2 |
| 4 | A non-CLI provider can loop on the same mutating tool forever; the CLI turn has no total cap | `toolLoop.ts:173`, `claudeCliSpawn.ts:115` | Z3 |
| 5 | A crash inside a Tier-2 live frame reaches nothing in Studio — no badge, no diagnostics | `studio-runtime/messages.ts:260-387` | Z5 |
| 6 | A fresh checkout does not build until `bun install`; four generated-artefact gates are red today | this checkout | Z7 |
| 7 | Zoom-out stalls 290–337 ms — but **not on the mount, which `perf-01` had blamed.** A CPU profile found the long animation frames admit ZERO new iframes: creating one is ~12 ms, while `useFramePosterCapture` rasterizing the frames that had *just arrived*, inside the gesture that brought them, was ~85–350 ms per poster in a burst. Fixed by queueing the posters until the board is quiet, caching the per-frame `:hover` CSSOM walk, and staging the mount — worst frame 350→195 ms, mean 41→22 ms | `useFramePosterCapture.ts`, `CanvasHoverSuppressionInjector` (was `studio-board-perf.e2e.ts:58-68`) | S1 · #155 · `perf-07` |
| 8 | Element drag re-renders React and forces layout twice per pointer move | `useCanvasReorderDrag.ts:266-295` | S2 |
| 9 | The selection overlay polls at 60 fps forever while anything is selected | `BreakpointSelectionOverlay.tsx:536-553` | S4 |
| 10 | The text-node inspector is ~1400 px tall against a 900 px budget | STATE.md `panel-27` | S5 |
| 11 | No canvas perf number is gated anywhere; the Bun bench cannot open Chromium on Windows | `studioBoard.bench.ts:51-64` | S6, V1 |
| 12 | A save and a git operation can interleave (no lock) | `gitOperations.ts`, `studioWriteback.ts` | G7 |
| 13 | A GitHub import has no `.git` and no `origin`; there is no route to add one | `githubImportRoutes.ts:132-183` | G1 |
| 14 | The dev-server poll logs every tick with no backoff | `useDevServerReadiness.ts:66` | Z3 |
| 15 | The system prompt claims `studio_computed_styles` needs the open tab; it does not | `systemPrompt.ts:278` | A11 |
| 16 | The Tier-2 render tool is offered but unreachable for a normal operator | `referenceRender.ts:9-13` | A10 |
| 17 | The MCP Tier-2 gate is weaker than the HTTP route's; most Studio routes have no capability check | STATE.md `sec-05` | A10, §6.7 |
| 18 | A third, CMS-static "preview" is still reachable from spotlight and looks broken on Studio pages | `preview/PreviewOverlay.tsx` | P8 |
| 19 | Multi-select edits run through the old panel paradigm, not the new sections | `selectionModel.ts:36-42` | S5 |
| 20 | Three plan documents report shipped work as unstarted | §0 table | docs pass in week 5 |
| 21 | 140,894 lines of a test project's generated files were committed into Studio's own repo | `188fda1a` | §6.4 |
| 22 | The residual CSS refusal (`no-editable-stylesheet`) could pick the open page and does not | `cssInsertDestination.ts:179-182` | Z8 |
| 23 | `bun test` is at 281 fail / 198 errors on this machine while the standing note says 34; the biggest single cause is an unmocked fetch in `agentPanel.test.tsx` (48) and a half-present fixture (`__canonical-fixture`, 26) | §0 table | V2 (start day one) |
| 24 | `bun run lint` has carried the same 6 unused-`os` errors across several handoffs | `server/handlers/__tests__/*.test.ts` | V2 |

---

## 9. Follow-up wave after this plan

Wave 2 (the table under "Wave 2 — landed") closed eight of the eleven items this section
carried. The three still open all belong to `verify-2`, whose PR was not open when the wave-2
integration branch was cut.

- ~~**Per-request capability gating on every Studio route**~~ — **done, `sec-14` (#167) +
  `sec-16` (#176).** Not "one sub-router at a time": one gate at dispatch, keyed by a table
  (`server/handlers/studio/routeCapabilities.ts`). An undeclared path answers 404, so a new
  route that forgets its declaration is dead rather than open, and an architecture gate fails
  the build naming it. The review found and closed a HIGH one namespace over — the
  `/admin/api/design-import/*` routes authenticated nothing — and made a missing `Origin`
  consult `Sec-Fetch-Site` instead of passing unconditionally.
- ~~**`insertImportedNodes` writes nodes no source write follows** (`mcp-21`)~~ — **done,
  `store-13` (#171).** It REFUSES on a studio tree, by name, and the refusal reaches both the
  modal and the tool. A source insert was genuinely unavailable: only two of the importer's
  ~15 target modules implement `sourceIntrinsic`, and the `<style>` half of the payload targets
  a different file. `pasteNode` became a real source duplicate in the same change.
- ~~**CRLF-safe parsing for USERS' repos** (`server-24`)~~ — **done, `parser-13` (#169).** One
  seam, not dozens of newline literals: `EolPreservingFileSystem` normalises to LF on read and
  re-applies the file's own dominant ending on write, so every ts-morph and postcss codemod is
  fixed at once. `verbatimSourceText` had to move off `node:fs` or every structural edit in a
  Windows checkout would have refused as `stale-source`.
- **Playwright cannot start the stack on Windows** (`verify-01` finding 3): `webServer` spawns
  `bun run e2e:dev` and Vite never binds on 5174 (4/4); by hand it comes up in ~25 s. Workaround
  today is `E2E_REUSE_SERVER=1` against a hand-started server. **`verify-2`'s, still open.**
- **The perf spec has no corpus on a clean checkout** (`verify-01` finding 1):
  `studio-workspace/maherfayad-stack-eSIM` is untracked, so `studio-board-perf.e2e.ts` self-skips.
  Repoint it at a tracked board of **at least 9 frames** — below that the mount pool keeps every
  frame mounted and there is no mount left to measure. **`verify-2`'s, still open.** `perf-9`
  took its nine-frame measurement by temporarily widening `studio-workspace/test4` to 12 frames,
  which is the cheapest path until the corpus is tracked.
- **e2e dirties `test4`** (`verify-01` finding 4): `auth.setup.ts` rewrites `lastOpenedAt` and
  `prototype/*`. Point the setup at a throwaway copy. **`verify-2`'s, still open.** `verify-3`
  shipped `tests/e2e/helpers/studioFixtureProject.ts`, which copies the fixture per CASE for its
  own spec; de-duplicating `studio-feel.e2e.ts`'s private copies onto one helper is the merge
  job that comes with `verify-2`.
- ~~**Select a source-backed duplicate/insert after resync** (`keys-01` K7 follow-up)~~ —
  **done, `store-13` (#171).** The four creating codemods return a `CreatedJsxLocation` verified
  against the re-parsed file, the save route answers `createdNodeIds`, and the editor claims them
  on both re-read paths. Integration extended it to `transplant` (#172's cross-frame move), whose
  created element lands in the DESTINATION file.
- ~~**`FillSection` Mixed re-wiring** (`panel-36`)~~ — **done, `panel-38`.** Re-wired row by row
  through the one multi-select model, and the audit it asked for found the same dropped-sentinel
  pattern in Layer, Shadow and Blur. Shadow was not under-stating: `String(MIXED)` put
  `Symbol(studio-mixed-value)` in a raw field offering to write it to disk. The row-by-row table
  is `docs/features/inspector.md` §9.3. Still open from that audit: `node.hidden`/`node.locked`
  in Layer toggle the ANCHOR only under a multi-selection — a structural fan-out gap needing a
  store action over N ids, not a Mixed one.
- ~~**`compare.test.ts:370`** carries the stale arity `readPassingCompare(dir, pageId)`~~ —
  **done, `mcp-24` (#168).** Both call sites derive the `userKey`. The missing argument had also
  made its "does NOT record a failing verdict" sibling pass for entirely the wrong reason.
- ~~**`parityMatrix` gap** (`test-05`)~~ — **done, `mcp-24` (#168).**
  `studio_import_figma_frame` got a row; `studio_plan_variants` genuinely has no canvas path and
  now says so on the TOOL, through a new `AiTool.headlessOnly` field the gate and the docs both
  read. No allowlist was added to the test.
- ~~**`deploy.ts` reads the trust tier off the APP ROOT**~~ — **done, `server-25` (#166).**
  `checkTrustTier`/`requireTrustTier` take a `projectDir` and `deployJobs.ts` stopped writing a
  second `.studio/meta.json` inside the user's own app.

### What is still open after three waves

The plan is closed. These are the real leftovers, each with the entry that found it. Nothing
here is a regression; every one is work that was named rather than done.

- **The full e2e baseline** (`verify-4`, cut short by the weekly model limit). A cold
  `bun run test:e2e` starts the stack by itself now (`verify-2`) and ran **23 pass / 64 fail /
  13 skip**, with no baseline to diff against. Two mechanical causes are confirmed by reading
  them — specs that navigate to the Content/Data/Media workspaces PR #18 deleted, and specs whose
  fixtures were built outside the containment root (`verify-4` moved four of them). Every
  remaining failure needs the same triage: delete the spec, move its fixture, fix the product, or
  annotate it with an owner. Until that is done, the CI `e2e` job runs the budget slice only.
- **Shadow + Blur become Figma's single Effects section** (`panel-41`): a measured **41px**, and
  the one thing standing between F2 (a text layer, 36px over) and a budget with no exceptions.
  It is a section-manifest change plus a restructure of two files `panel-38` had just rewritten
  for the Mixed contract, so it wants its own work order.
- **`GET github/device/poll` writes a credential under a GET** (`sec-18`): the route is gated on
  `site.structure.edit` now, but a GET skips the CSRF check by definition. Not exploitable today —
  the flow is bound to `(userId, flowId)` and a Client cannot start one — and closing it means
  changing how the gate keys CSRF, not adding a check.
- **`GET /load` spawns the Tier-1 compiler at `site.read`** (`sec-18`, documented not gated): the
  boundary is a capability, not a human consent, and `capabilities.md` now says so rather than
  claiming otherwise.
- **Whether Admin should hold `studio.git.write`** (`sec-14`) — owner-level, document only. The
  HTTP git surface is gated on `site.structure.edit`, so Admin keeps the Version control panel
  without gaining the agent's commit right.
- **`ensureClaudeCliConfigDir` is fail-soft** where Studio's own secret writers fail closed
  (`sec-18`): it restricts the directory the `claude` CLI writes its credential into and logs and
  continues if it cannot. An owner veto turns it into a refusal.
- **The device-flow sign-in needs `GITHUB_OAUTH_CLIENT_ID`**, which is not set on this machine, so
  G8 ran through the paste-a-token path (`git-23`). Creating the OAuth App is the owner's.

## 8. Definition of done for the plan

Ticked at the wave-3 integration head, each line with the thing that proves it.

- ~~Phase 0 exit dogfood passed and recorded in STATE.md~~ — **met.**
  `tests/e2e/studio-feel-phase0.e2e.ts` runs all seven cases as ordinary passes; none carries
  `test.fail()` any more. It took `panel-40`, `struct-11`, `store-13` and `store-14` to get there.
- **`bun run build`, `bun run lint` and `bun test` green on this machine; `bun run test:e2e`
  starts itself but is NOT green** — 64 specs still fail cold and are untriaged (first item under
  "What is still open"). CI runs the budget slice, not the whole suite. This is the one DoD line
  the plan does not meet.
- ~~Every budget in S1/S2/S4/A9 asserted by a gate with a real number~~ — **met.** Zoom worst and
  mean frame in `tests/e2e/helpers/canvasPerf.ts`; the inspector's height budget is a strict
  runtime measurement with one named exception (`panel-41`); A9 is `AGENT_TURN_WALL_MS`, measured
  over three real turns (`mcp-25`).
- ~~G8 dogfood recorded against a real private GitHub repository~~ — **met, and automated.**
  `tests/e2e/github-sync.e2e.ts` creates a private scratch repo, drives twelve claims through the
  UI against `gh api` and a fresh clone, and deletes the repo on every path (`git-23`).
- ~~`PROJECT-BRIEF.md` §3 and the stale plan headers corrected; `docs/features/*` updated with
  each track; `path-index.md` lists every new file~~ — **met**, re-checked at each wave's
  integration.
- ~~Nothing old left beside anything new~~ — **met.** `PreviewOverlay`, the three multi-select
  panel files, the Bun bench launch path and the 21 per-hook key listeners are deleted, not
  disabled; wave 2 and 3 added to that list the two frame mount pools (`perf-9`), the CMS
  `site_*` writes in the MCP catalog (`mcp-25`), and `store-11`'s in-flight refusal (`store-14`).
