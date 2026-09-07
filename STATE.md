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
