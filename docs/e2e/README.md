# User E2E Testing
> **Purpose:** the Playwright e2e suite: the fourth gate, the disposable stack, authoring rules, coverage · **Read when:** writing or running an e2e spec · **Trust:** current · **Owner:** test-engineer · **Verified:** not yet

This folder defines the agent-run browser testing workflow for Studio.

- `protocol.md` explains how an agent should run user-facing E2E audits.
- `run-log-template.md` is copied into `runs/` for each audit (created on first
  use — this repo does not check in past run logs).
- [`docs/archive/e2e/agent-upgrade-dogfood.md`](../archive/e2e/agent-upgrade-dogfood.md) is the human test plan for the 2026-08-03
  five-workstream agent upgrade (live canvas reload, component awareness, turn
  latency, visual measurement, Figma MCP). Everything in it passed unit,
  integration, and static gates but was **never driven through a browser** — the
  file names exactly what still needs a human, and which failures are known
  no-ops rather than bugs.

**`feature-validation.tsv`, `feature-matrix.md`, and `capabilities.md`, referenced
below and by `protocol.md` as the scenario-ID source of truth, are not present in
this repo.** The scenario IDs used throughout this page (`SETUP-001`, `ADMIN-001`,
`SPOT-001`, …) still appear as docblock comments inside the `*.e2e.ts` specs
themselves, which is where the "Automated coverage map" below draws them from —
but there is currently no standalone matrix to pick an unautomated row from.
Recreating that matrix (or removing the scenario-ID convention) is a real gap,
not something this docs pass can safely fabricate.

## Common Requests

Use these prompts with Codex:

- "Run the Core Owner Lifecycle E2E protocol."
- "Run rows MEDIA-001 through MEDIA-003."
- "Run a friction audit of the visual builder."
- "Run the capability E2E scenarios."
- "Retest E2E-20260514-01 from the last run."
- "Promote PUB-001 into automated smoke coverage."

The project-local `studio-user-e2e` skill should load for those requests and keep the agent focused on browser-observed user behavior. **That skill directory does not currently exist** at `.agents/skills/studio-user-e2e/` — `.gitignore` still force-includes it (alongside `agent-browser` and `skill-creator`, which *are* present), so it is expected to be checked in but is missing from this working tree.

## Automated Playwright E2E

The scripted regression suite lives outside this folder in `tests/e2e/`.
Automated E2E files use the `*.e2e.ts` suffix so `bun test` does not load
Playwright specs as unit tests.
It complements the agent-run audits above; it does not replace them. Use
Playwright for stable, critical flows where the expected result is
unambiguous, and keep exploratory UX, accessibility, and visual-friction work
in the agent-run protocol.

Run the automated suite with:

```sh
bun run test:e2e:install   # once, to install Chromium
bun run test:e2e           # starts its own stack — do not hand-start one first
```

### `bun run test:e2e` is the fourth gate

`build`, `test`, and `lint` are the three gates every change runs. **A change
that touches the canvas, a frame, an overlay, geometry, or a panel's height
runs `bun run test:e2e` as well** — it is the fourth gate, not an optional
extra. The reason: happy-dom has no layout engine, so a unit test
on those surfaces structurally cannot fail on the thing it is named after
(WS-8.2 shipped a real frame-height defect behind a green one). Assert on
*computed* layout — measured rects, `scrollHeight`, computed styles after
layout.

Running the four budget specs by path is usually enough and takes a few
minutes:

```sh
npx playwright test tests/e2e/studio-board-perf.e2e.ts   tests/e2e/inspector-panel-measurement.e2e.ts   tests/e2e/inspector-height.e2e.ts tests/e2e/studio-feel.e2e.ts
```

### In CI

**Two jobs, and they are separate on purpose.**

`e2e` runs the **whole suite** — no path list, for the same reason the `test`
job has no path filter: a spec that has to be named in `ci.yml` to run is a
spec that will be forgotten. Its ceiling is 90 minutes against a measured ~53
minute cold Windows run, so a timeout there means a hung stack, not a slow
suite.

That job could not exist until the suite's result meant something. The first
cold whole-suite run anyone had ever done (`verify-2`) reported **23 passed /
64 failed / 13 skipped** with nothing to diff the 64 against — see
"The full-suite baseline" below for what those 64 turned out to be.

`e2e-budgets` runs the narrow budget slice — `studio-board-perf`,
`inspector-panel-measurement`, `inspector-height`, `studio-feel` — because
those four measure **computed layout and frame time**, the one class of
question happy-dom structurally cannot answer. It stays its own
job so a 40 ms regression is visible in ten minutes instead of at the end of an
hour-long run, and so the two kinds of failure get the triage they each need.

Both let `playwright.config.ts`'s `webServer` block start the stack,
deliberately: CI is the only place that proves that path works on Linux, and a
job which bypassed it would let the bypass rot into the only thing that works —
the exact shape that hid the Windows boot bug for seven weeks. The budget job
passes only the spec paths that exist, so a spec that has not landed yet costs
coverage instead of failing the job for the wrong reason.

Each job uploads its own report artifact (`playwright-report-full`,
`playwright-report-budgets`). One upload step each, not two: there used to be
an `if: failure()` step and an `if: always()` step sharing the artifact name
`playwright-report`, and since `actions/upload-artifact@v4` rejects a duplicate
name, the one run where the report mattered was the one run where the upload
errored.

`bun run bench:studio-board` runs `studio-board-perf.e2e.ts` through the same
Playwright Node runner from the bench harness and republishes its `perf`
annotations — see `scripts/bench/README.md`.

### The disposable stack

The Playwright config starts one by default:

| | |
|---|---|
| Admin UI | `http://127.0.0.1:5174` (`E2E_VITE_PORT`) |
| CMS / public site | `http://127.0.0.1:3002` (`E2E_CMS_PORT`) |
| Database | `.tmp/e2e-agent.db` |
| Uploads | `.tmp/e2e-uploads` |
| Studio workspace | `.tmp/e2e-workspace` (`E2E_WORKSPACE_DIR`) |
| Per-child logs | `.tmp/e2e-cms.log`, `.tmp/e2e-vite.log` |

Those five names live in one place, `scripts/lib/e2eStack.ts`, which the
config, the stack script, and `tests/e2e/helpers/constants.ts` all read — so
moving a run to another port is one variable, not three edits.

`scripts/e2e-dev.ts` resets every one of those paths, then runs the same Vite +
Bun CMS stack a developer uses, with three deliberate differences.

**The CMS runs without `bun --watch`.** A regression suite needs a stable
server, and under watch the publish pipeline writing baked HTML (and the SQLite
DB churning) can reload the server mid-test and drop in-memory state. Vite is
likewise told to ignore the runtime-written paths (`.tmp`, `uploads`, `dist`,
`studio-workspace` in `vite.config.ts`), so publishing never reloads the admin
app mid-test. The Vite dev proxy follows the configured CMS `PORT`, keeping the
Playwright admin UI pointed at the disposable CMS instead of any regular dev
server on port 3001.

**The Studio workspace is a throwaway copy.** `studio-workspace/` is tracked by
git and is a user's real React project everywhere else, so the stack copies it
to `.tmp/e2e-workspace` and exports `STUDIO_WORKSPACE_DIR`, which
`projectsRootDir()` reads per call. Everything a run writes — `auth.setup.ts`
stamping `lastOpenedAt`, the shell scaffolder writing `index.html` and
`prototype/*` and rewriting `package.json`, the framework compiler dropping a
`.studio/framework.json` — lands in the copy. **`git status --porcelain
studio-workspace/` is empty after a run**; it was not before (`verify-01`
finding 4). A spec that puts a fixture project on disk must therefore join onto
`WORKSPACE_ROOT` from `tests/e2e/helpers/constants.ts` and never onto
`process.cwd() + 'studio-workspace'` — a project outside the root the server
resolved fails `resolveProjectDir`'s containment check and the route answers
404.

**That includes an OS temp directory**, and three specs learned it the
expensive way. `css-writeback`, `structural-writeback` and
`design-system-insert` each built their fixture with
`fs.mkdtempSync(os.tmpdir())` and opened it by absolute path, reasoning that a
temp dir is the safest place for a spec that writes. It is outside the
containment root, so the board 404'd and all six cases failed on a timeout that
read exactly like a product bug. `createAuthoredFixtureProject(name, files)` in
`helpers/studioFixtureProject.ts` is the correct form of that instinct: it
authors the fixture under `WORKSPACE_ROOT`, which for a run IS a throwaway
directory. Its sibling `createFixtureProject(source, name)` copies an existing
tracked project instead.

**Tracked fixture projects.** Four projects under `studio-workspace/` are
committed, each with a `.gitignore` negation line naming its consumer:
`__canonical-fixture` (the parser corpus), `__board-perf-fixture` (the canvas
budget corpus), `test4` (the Phase 0 dogfood target), and
`__vite-live-fixture` — the smallest project `resolveLiveCapability` answers
`{ capable: true }` for, which is what phase 0 case 8 needs to drive the
automatic Tier 2 promotion. Adding a fifth means committing someone's
repository into this one, so each has to earn its line. Two rules when you do:
the negation line is mandatory (without it the project is invisible to
`git status`), and `listStudioProjects` sorts by `displayName` while
`defaultProjectDir` takes the first — so a new fixture's display name decides
whether it becomes the project a fresh Studio opens.

**Vite's boot is supervised.** Handed a pipe for stdout — which is exactly what
Playwright's `webServer` gives it — Vite intermittently binds its port, prints
nothing, and answers nothing, because it is blocked inside a write. Measured at
3/10 successful boots. Two changes fix it, both in the stack script and its
`scripts/lib/stackChild.ts` helper, which carry the numbers: each child writes
to a log FILE that the supervisor tails (a file write cannot block on a reader),
and the supervisor then waits for Vite to answer `/admin`, killing and
respawning it if it does not. A stack that genuinely cannot start now says so
instead of expiring as a bare "Timed out waiting …".

The readiness probe asks for `/admin`, never `/`: `vite.config.ts` proxies `/`
into the CMS's public-site renderer, which on a just-created database takes
seconds and depends on state the stack has no opinion about.

For debugging against a server you started yourself, set `E2E_REUSE_SERVER=1`.
That path still works and is still the fastest way to iterate on one spec — but
nothing in `webServer.env` reaches it, so export `VITE_ALLOWED_ORIGIN` (and any
port overrides) in that shell yourself, or stay on the defaults, which need
nothing. Do not use reuse mode for CI or for regression runs that need a clean
database.

Local trace and video capture are opt-in because a complete run keeps many SSE
connections in one worker and can otherwise accumulate gigabytes of temporary
artifacts before Playwright discards passing tests. Set `E2E_TRACE=1` and/or
`E2E_VIDEO=1` for a focused debugging run. CI still records trace/video on the
first retry automatically.

### Suite structure

- **`tests/e2e/helpers/`** — small, user-behaviour-shaped helpers (setup/login,
  page readiness, module insertion). No large abstractions.
- **`auth.setup.ts`** — a Playwright *setup project* that runs once. The
  disposable DB is set up once per run, so first-run setup happens here (proving
  SETUP-001) and the owner's authenticated `storageState` is saved. Every spec
  in the `e2e` project depends on it via `playwright.config.ts`'s `projects`.
- **The former `dashboard-preflight` and `personas` setup projects are gone.**
  `playwright.config.ts` now runs exactly two projects — `setup` (`auth.setup.ts`)
  and `e2e` (every `*.e2e.ts`, sharing the saved owner `storageState`). They were
  removed along with the CMS-only specs they existed for (clean-install dashboard
  facts, and a throwaway persona for destructive self-management tests). The
  specs that remain are Studio-relevant — shell navigation, canvas/visual
  builder, pages, preview, files/deps, perf, a11y, reliability — and each owns
  whatever fixtures it needs directly rather than depending on a shared persona.
- **Session rule.** Specs default to the shared owner `storageState` (fast).
  A spec that rotates the session token server-side (sign-out, a step-up-gated
  action that revokes other sessions) opts into `ANONYMOUS_STATE` and logs in
  fresh instead, so it does not invalidate the shared state for later specs.
- **Selectors.** Durable user-facing selectors first (roles, labels, accessible
  names). `data-testid` only for stable editor/canvas controls where an
  accessible name is not practical (canvas notch, toolbar actions, dialogs).
- **Isolation.** With `workers: 1` all specs share one database; each spec works
  on its own uniquely-named page/fixture rather than sharing mutable state.

### Authoring rules

Learned from the 2026-09-19 cold-suite triage (`e2e-1`); each one caused real red specs.

1. **Open the board with `openFixtureBoard`, never a spec's own `goto`**
   (`tests/e2e/helpers/studioFixtureProject.ts`). The canvas has no scroll
   container, and where a frame lands is decided by a "center on open" pass that
   races the page documents it centres on. On a cold load the board can settle
   with no frame in view, and a click at the frame's box centre lands on empty
   canvas: the failure then reads like a product bug. `openFixtureBoard` presses
   the product's own **Ctrl+0**; `panIntoView` puts the target under the pointer.
2. **The single-selection write target is the ClassPicker pill.** Use
   `class-chip-<name>` (`SelectorPillStack.tsx`) and read writability from the
   enclosing `write-target-chip-<classId>`'s `data-locked`. `StyleTargetChip`
   renders only for a multi-selection.
3. **Size lives in Measures.** `MeasuresSection` renders `SizeSection` and is
   always mounted; width is `css-size-input-width` (`textbox[name="Width"]`).
4. **A same-file reparent is a write, not a refusal** (`moveJsxElement.ts`), and
   a cross-file one goes through `transplantJsxElement.ts`. The refusal that
   remains is about scope (`freeVariablesOutOfScopeAt`); no e2e covers it yet.
5. **Reach into a canvas iframe through `helpers/canvasIframe.ts`, never a
   bare `frameLocator('iframe[title^="Canvas frame"]')`.** Every fixture is at
   Tier 2 by default, so each board frame is a `LiveBoardFrame`: it holds the
   portal fallback AND a hidden bridge iframe until the live frame is ready,
   which in a fixture without `node_modules` is never. A bare `frameLocator`
   then matches two iframes (a strict-mode violation), and waiting for one
   iframe never ends. `canvasContentFrame(boardFrame)` and
   `visibleCanvasIframe(boardFrame)` pick the one that is displayed;
   `liveBridgeIframe(boardFrame)` is for a case that must measure the live frame
   itself. Counting frames goes per board frame too (`readBoardCounts`'
   `mountedFrames`), not per iframe element.
6. **Fixed-name fixtures are overwritten in place** (`createFixtureProject`,
   `createAuthoredFixtureProject`). Opening a Tier-2 fixture starts its own Vite
   dev server with the fixture as its working directory, and the server watches
   an open project for 15 s after its last tab closes (`outsideEditReload.ts`'s
   `LINGER_MS`). Both outlive the worker, so deleting the fixture in a restarted
   worker's `beforeAll` failed with `EPERM` on Windows (reproduced with
   `--repeat-each=2`). The helpers empty the directory instead, and wait out a
   delete-pending one. Do not `rmSync` + `cpSync` a fixture yourself.

The CMS half of the suite drives UIs PR #18 deleted (an Explorer tab row, a
name-and-slug page dialog, a toolbar Publish action). Whether to re-point or
delete those specs is an open row in `ROADMAP.md` §13.

### Automated coverage map

**This map was written before PR #18 deleted the standalone Content, Data,
Media, Plugins, and Users admin workspaces** (see `CLAUDE.md`'s "The dormant
CMS half") **and `playwright.config.ts` dropped the `dashboard-preflight` and
`personas` setup projects along with the CMS-only specs that needed them** —
`core-owner-lifecycle.e2e.ts`, `dashboard.e2e.ts`, `content.e2e.ts`,
`media.e2e.ts`, `users.e2e.ts`, `capabilities.e2e.ts`, `account.e2e.ts`,
`account-persona.setup.ts`, and `plugins.e2e.ts` no longer exist in
`tests/e2e/`. The feature-matrix rows those specs used to cover (AUTH-001,
SAVE-001, PUB-001–003, PUBLISH-002's page-scheduling half, CAP-001, CAP-002,
CAP-003, CAP-004, DASH-001–003, MEDIA-001–007, CONTENT-001–007, BUILDER-008,
USERS-002, USERS-003, most of ACCOUNT-\*/ADMIN-002/ADMIN-003(-as-MFA)/AUTH-002/
AUTH-004/AUTH-006, and PLUGIN-001–008) currently have **no Playwright
coverage** — the rows below are what actually still runs. Re-establishing
that coverage (new specs, or restoring the deleted ones' surviving assertions
against whatever replaced the workspace UI) is real follow-up work, not
something this docs pass can invent.

Rows list Playwright specs unless a focused Bun test path is included:

| Row(s) | Spec |
|---|---|
| SETUP-001 | `auth.setup.ts` |
| PUBLISH-002 (due-row scheduler tick) | `page-management.e2e.ts`, `src/__tests__/server/publishScheduler.test.ts` |
| AUTH-003 (logout + stale-tab session revocation + mobile account menu) | `auth.e2e.ts`, `src/__tests__/admin/accountMenuButton.test.tsx`, `src/__tests__/server/authSessionEdgeCases.test.ts`, `src/__tests__/server/cmsHandlers.test.ts`, `src/__tests__/toolbar/moduleInserterPreference.test.tsx` |
| ADMIN-001 (workspace navigation), ADMIN-003 (global toolbar actions + open-live target), ADMIN-004 (global Settings modal + editor preferences), ADMIN-005 (workspace panel resize/close/reload recovery) | `admin-navigation.e2e.ts` |
| PAGE-001, PAGE-002, PAGE-003, PAGE-004, SAVE-001 (mobile draft reload) | `page-management.e2e.ts` |
| BUILDER-001, BUILDER-002, BUILDER-003 (DOM-panel reorder, locked slot layers, mobile notch insert), BUILDER-004 (canvas drag reorder), BUILDER-005 / SITE-009 (undo/redo), BUILDER-006 (spacing/color/typography controls), BUILDER-007, EDIT-002, SITE-005 (search/keyboard insert + drag + mobile), SITE-011 (class/ambient/attribute/pseudo/breakpoint selector authoring), SITE-017, SITE-018, SITE-019 | `visual-builder.e2e.ts`, `src/__tests__/toolbar/moduleInserterModel.test.ts`, `src/__tests__/toolbar/moduleInserterFavorites.test.tsx`, `src/__tests__/toolbar/moduleInserterPreference.test.tsx`, `src/__tests__/toolbar/modulePickerDropdown.test.tsx`, `src/__tests__/editor-store/pageActionsSelection.test.ts` |
| SITE-013 (Code Editor stylesheet authoring + published user CSS) | `site-files.e2e.ts` |
| SITE-016 (draft preview vs. last-published open-live) | `preview-live.e2e.ts` |
| SPOT-001 through SPOT-013 | `command-palette.e2e.ts` |
| CAP-005 (chat-only Site assistant request omits mutating write tools) | `ai.e2e.ts` |
| AI-001 (Ollama credential create/delete), AI-002 (default-model save/reload), AI-003 (saved chat load/delete), AI-004 (streamed chat, with AI-006's audit rollups in the same test), AI-005 (browser `site_read_document` tool-result bridge) | `ai.e2e.ts` |
| A11Y-001 (keyboard login + shell navigation, see `accessibility.e2e.ts`'s own tests), RESP-001, RESP-002 | `accessibility.e2e.ts` |
| PERF-001, PERF-002 | `performance.e2e.ts` |
| REL-001 | `reliability.e2e.ts` |
| REL-002 | `error-handling.e2e.ts` |
| SITE-014 (runtime-dependency authoring, missing-package add, mobile containment) | `runtime-dependencies.e2e.ts` |

The rows above are the surviving half of the **old CMS-era feature matrix**.
A second, newer body of coverage exists for Studio-specific canvas/parser/board
work that was never folded into that matrix at all — each spec below cites the
`STATE.md` work-item id it proves rather than a feature-matrix row:

| `STATE.md` id | What it proves | Spec |
|---|---|---|
| `panel-02` (WS-6.3) | A Figma-inspector value edit lands in the project's real `.css` file, or refuses | `css-writeback.e2e.ts` |
| WS-2.3 (canvas-03) | `@layer vendor, user-authored;` actually resolves the way `canvasCssLayers.ts` assumes, in a real browser | `vendor-css-cascade.e2e.ts` |
| design-system insert | Adding a design-system component renders with its own package CSS instead of unstyled text | `design-system-insert.e2e.ts` |
| board-02 (WS-7.1) | `selectedFrameIds`, marquee selection, `FrameBulkInspector`, `canvas.selectAll` (was `board.selectAllFrames`) | `board-frame-bulk-selection.e2e.ts` |
| canvas-02 → test-01 → canvas-04 | Frame "fit height to content" | `frame-fit-height.e2e.ts` |
| canvas-06 | Overlay/bottom-sheet screens render as the real app renders them | `canvas-06-sheet-render-fidelity.e2e.ts` |
| select-01 | Escape always gets you back to nothing selected | `canvas-deselect.e2e.ts` |
| WS-5.1 (canvas-05) | The selection ring/props panel track the element at non-100% zoom | `canvas-selection-overlay-zoom.e2e.ts` |
| WS-4.2 | The `studio.instance` fragment node renders zero DOM elements; a `height: 100%` chain crossing it still resolves | `instance-fragment-node.e2e.ts`, `instance-selection-ui.e2e.ts` |
| parser-06 | A multi-return/ternary/`&&` JSX branch renders only the selected branch, not every branch stacked | `parser-branch-selection.e2e.ts` |
| `lock-01` | A node whose VALUE the evaluator resolved is no longer locked | `resolved-value-not-locked.e2e.ts` |
| `struct-01` | A move/delete/insert/duplicate/wrap writes back to the real `.tsx`, or refuses with an `EditConstraint` | `structural-writeback.e2e.ts` |
| *(no `STATE.md` id — no docblock)* | An authored background-image prop uses optimized media variants in both the editor and the published CSS | `background-image-smoke.e2e.ts` |
| `perf-01` (WS-5.3/5.4) | Board pan/zoom frame time and iframe virtualization against the real eSIM corpus. **Self-skips on a clean checkout** — `studio-workspace/maherfayad-stack-eSIM` is not tracked by git | `studio-board-perf.e2e.ts`; `_perf-diagnostic-studioboard.e2e.ts` is the underlying diagnostic, explicitly not a permanent spec |
| V1 (`STUDIO-FIGMA-FEEL-PLAN.md`) | Toast de-duplication under a hammered ⌘D, the Escape ladder terminating at nothing selected, the zoom frame budget on the **tracked** `test4` corpus, and (skipped until K2 lands) Alt+drag duplicating a board frame | `studio-feel.e2e.ts` |
| Phase 0 exit dogfood (`STUDIO-FIGMA-FEEL-PLAN.md` §8, `meta-14`) | The seven claims wave 1 could not close from a unit test: ⌘D ×5 inside 300 ms, Alt-hover measurement against real `getBoundingClientRect` geometry, Alt+drag duplicate, ⌘G/⌘⇧G/⌘Z, a panel that throws, the save chip's Saving→Saved and its Retry, and zero unexplained `console.error` across the whole file | `studio-feel-phase0.e2e.ts` (+ `helpers/studioFixtureProject.ts`) |
| `parser-p1a` (P1-A, WB-1) | A Delete on an element whose line moved under the board (an outside write the board was not told about) is refused `element-moved`, re-read and re-planned, and deletes the element the user pointed at — nothing else | `element-identity-guard.e2e.ts` |
| `store-16` (P1-B, ERR-5) | The selection follows its ELEMENT, not its `line:col`, when a write above it shifts the line | `selection-follows-element.e2e.ts` |
| `server-29` (P1-D, ERR-19) | A file edited outside Studio mid-session reaches the canvas with no gesture (the project watcher), and a later Delete lands on the right element | `outside-edit-live-reload.e2e.ts` |
| `store-17` (P1-F, ERR-1) | A width typed, entered and undone is not written back when the parked field blurs | `undo-tells-the-truth.e2e.ts` |
| `canvas-23` (P2-D, IX-6a/6b/6d) | A real handle drag, measured as COMPUTED layout: a border-box and a content-box element each grow by exactly the drag (mid-drag too) with the CSS width in the source and one undo entry; a `flex: 1` item renders at the dragged width; an absolute element's W/N handles keep the opposite edge | `element-resize.e2e.ts` |
| `panel-45` (P2-H, UX-11/20/21/25) | A hovered inspector field is lighter than its resting fill in both themes; a keyboard-focused Layers row draws a ring and a clicked one does not; the selected and a hovered Layers row paint different fills; a node-level notice sits on the 12px panel gutter | `inspector-panel-polish.e2e.ts` |
| Phase 1 exit gate (`ROADMAP.md` §5, `test-06`) | An outside edit mid-session, then a canvas text edit, a Delete and an undo change the file exactly where intended, byte for byte. Three race cases make the outside write while a text edit is PENDING, or a text edit or a Delete is IN FLIGHT (held by `page.route`): each lands on the element the user pointed at or is refused, never on a neighbour. With the server's identity check disabled, all three race cases fail on a wrong-element write | `phase-1-exit-gate.e2e.ts` (+ `sourceNodeId` in `helpers/studioFixtureProject.ts`) |
| G8 dogfood (`STUDIO-FIGMA-FEEL-PLAN.md` §3 G8, `git-21`/`git-22`) | The twelve claims no local bare repository can settle: paste-a-token sign-in, *Keep history* clone of a PRIVATE repo, branching over a dirty tree, commit + push landing on GitHub, a real pull request, `1↓` → Pull, `1↑ 1↓` → rebase-or-merge, a same-line conflict, Abort, the write lock's `busy` refusal, commit-and-switch, and sign-out actually deleting the credential. **Self-skips without `gh auth token`** | `github-sync.e2e.ts` (+ `helpers/githubScratchRepo.ts`) |

| A9 (`STUDIO-FIGMA-FEEL-PLAN.md`, `mcp-25`) | **ONE real agent turn**, wall-clocked: the warm `claude` CLI on a throwaway copy of `__canonical-fixture`, `balanced` fidelity — one write batch, zero tool refusals, the activity line on screen, telemetry in `.studio/agent-turns.jsonl`, and every changed file the hero's own. **Self-skips** without the `claude` binary, without Studio's CLI probe answering, or without a `claudeCli` credential on the account | `agent-turn.e2e.ts` |

#### `github-sync.e2e.ts` refuses to run unless it can clean up

It creates a real private repository on the signed-in account, so it needs two
things, not one: `gh auth token` must succeed AND the token must carry the
`delete_repo` scope. A `repo`-scoped token can create the repository and cannot
remove it — the spec archives it as a fallback and it stays on the account for
good. That is not hypothetical: twenty-two archived `studio-g8-scratch-*`
repositories accumulated on this machine's account before the scope was made a
precondition. The skip reason names the one command that fixes it:

```sh
gh auth refresh -h github.com -s delete_repo
```

#### `agent-turn.e2e.ts` costs real tokens, and says so when it does not run

It is the only spec in this directory that spends money: it drives the
`claudeCli` driver, which spawns a real `claude` subprocess against the
operator's own subscription. Three preconditions gate it, and each one names
itself in the skip reason rather than reporting a silent pass — the binary on
PATH, `GET /admin/api/ai/providers/claude-cli/status` not answering
`not-installed`/`unsupported`, and a `claudeCli` credential on the signed-in
account. Studio's L1 terminal login stores no credential row on purpose, so a
host login alone is not enough; add the value `claude setup-token` prints under
Settings → AI → Providers.

There is a **fourth**, discovered late rather than early: if every failed tool
call is capture-family (`studio_screenshot` / `studio_compare` /
`studio_computed_styles` / `studio_export_frames`) and the transcript shows the
capture browser could not run, the case skips with that reason instead of
failing. On this Windows box `playwright-core`'s `chrome-headless-shell` hangs
for its full 180 s launch timeout when launched from a Bun process, while the
same binary serves the Playwright RUNNER fine — a machine, not a product
defect, and neither a pass nor a red belongs to it.

It also carries one `test.fail()`: the agent panel's fidelity control is not
clickable at the panel's default width, because the model/effort picker's label
overlaps it and takes the click. See `STATE.md` `mcp-25`.

Every run appends what it measured to `.tmp/agent-turn-measurement.json` — wall
ms, tool rounds, writeback POSTs, telemetry lines, failed tool labels and the
changed-file set. That file is how `AGENT_TURN_WALL_MS` gets re-calibrated:
three runs, budget is 1.5x the worst.
| Default trust tier (`sec-10`, `sec-12`) | Every project starts at `run-project` (Tier 2) with no click and no notice (`DEFAULT_TRUST_TIER` — owner decision, 2026-09-20, superseding the earlier §6 decision 2 one-time auto-promotion). **"Back to static" is a real, permanent demotion that survives a reload** — a demotion that only edits a file while the dev server keeps running is cosmetic. Case 8 of the phase-0 spec, on `studio-workspace/__vite-live-fixture` | `studio-feel-phase0.e2e.ts` |
| `sec-17` landmine 6 | The frame drag relay's **FILE** branch, which no suite could reach: happy-dom implements neither `DragEvent` nor `DataTransfer`, so `src/__tests__/canvas/canvasFrameDragRelay.test.ts` can only assert the cancel. A real `DataTransfer` built in the frame's own realm must put the PNG in `public/` and an `<img>` in the `.tsx`; a `text/uri-list` drop must leave the frame exactly where it was | `frame-file-drop.e2e.ts` |

#### The expected-failure convention

A spec that asserts what the product was PROMISED to do, on a tree where it does
not yet, marks the case `test.fail()` and names the defect and its owning
`STATE.md` entry in a docblock directly above it. Playwright then fails the run
if such a case starts **passing**, which is the whole point: a fix cannot land
silently and the annotation cannot rot into a lie.

Two rules go with it. **Never use `test.skip()` for a known defect** — a skip is
invisible in a summary and nothing tells you when it is fixed. And **never
weaken the assertion instead**; the annotation is the honest record, a softened
`expect` is not.

#### `studio-feel-phase0.e2e.ts` runs four cases that are EXPECTED to fail
#### `studio-feel-phase0.e2e.ts` — the plan's exit dogfood, now fully green

This spec asserts what the product was promised to do, not what it currently
does, so for two waves most of it ran as expected failures. **As of wave 3 all
seven cases assert and pass, and none carries `test.fail()`.** It took four
entries to get there and they are worth naming, because each closed a defect a
different layer owned: `panel-40` (a panel that throws no longer takes the
editor with it — case 5), `struct-11` (the ⌘G wrapper follows the HTML content
model, so Studio stopped writing `<div>` into a `<p>` in the user's own file —
case 4, and the two React errors that kept case 7 red), `store-13` + `store-14`
(created ids reach the client, structural gestures queue instead of refusing,
and the family has a real undo — cases 1 and 4).

Playwright fails a run in which a `test.fail()` case starts **passing**, so a
fix cannot land silently and an annotation cannot rot. Read the `[phase0] …`
annotations for the measurements; case 7 is the file's backstop, and any NEW
console error from any case fails there. Case 5's probe event names the
boundary's own `location` (`detail: 'panel:design'`), not a bare panel word.

It also writes to a project's real `.tsx`, so `helpers/studioFixtureProject.ts`
copies `studio-workspace/test4` to `studio-workspace/__e2e-phase0` **before each
case** and removes it afterwards. Per-case, not per-file: a shared copy made
case 4 group whatever case 3 had left behind, and the defect it finds appeared
and disappeared between runs because of it.

### `github-sync.e2e.ts` — the G8 dogfood, against a REAL GitHub repository

The only spec in this suite that talks to a third party. It exists because the
whole git track (G1–G7, `git-21`/`git-22`) is otherwise covered by unit tests
that use a **local bare repository** — correctly, since those must not need the
network, and just as certainly unable to answer the questions G8 asks: is the
branch on GitHub, is that a real pull request, is the file on disk after Pull
the one GitHub has.

It drives the Version control panel through `git-22`'s twelve-step script and
checks every claim twice — once in the UI, once against GitHub (`gh api`, or a
fresh `git clone` into a temp dir) or against the `.git` on disk.

**What it needs, and what happens without it.** A `gh` CLI signed in with a
`repo`-scoped token (`gh auth login`). The spec calls `gh auth token` at
collection time and **skips itself, annotated**, when that fails — no
credential, no run, and the skip says so rather than reporting green coverage
that did not happen. Nothing else is configured: `GITHUB_OAUTH_CLIENT_ID` is
not required, because step 1 deliberately exercises the **paste-a-token**
sign-in fallback, which is the path an install with no OAuth App has.

**The token never leaves `gh`.** Every authenticated call is made by `gh`
itself; git's network verbs borrow gh's credential for one invocation with
`-c credential.helper='!gh auth git-credential'`. The single place it exists in
the spec's own process is `readGithubTokenForSignIn()` → `locator.fill()` —
step 1 typing it into Studio's sign-in field — and that function **refuses to
run under `E2E_TRACE=1` or `E2E_VIDEO=1`**, because a Playwright trace records
the value of every `fill()`. The field is `type="password"`, which is what keeps
the always-on failure screenshot harmless.

**The cleanup guarantee.** `beforeAll` creates a private
`studio-g8-scratch-<unix-ms>`; `afterAll` destroys it, and deals with the
REMOTE first — the local directories are throwaways inside `.tmp/e2e-workspace`,
the repository is the only thing that outlives the run. Nothing in that hook
throws (a Windows `EPERM` on a read-only git pack file once skipped the delete
and left a private repository behind).

`gh repo delete` needs the **`delete_repo`** scope, which a plain `repo` token
does not have and which `gh auth refresh -s delete_repo` can only grant
interactively. When the delete is refused the repository is **archived** — so a
later run cannot push into it — and the name is printed as an annotation on the
last case, with the exact command to finish the job:

```sh
gh repo delete <owner>/studio-g8-scratch-<unix-ms> --yes
```

Grant `delete_repo` once (`gh auth refresh -h github.com -s delete_repo`) and
teardown completes on its own.

#### Three of its cases are EXPECTED to fail

Same convention as `studio-feel-phase0.e2e.ts`: `test.fail()` with the defect
named in a docblock, so Playwright fails the run if one starts passing. All
three are one defect — **`proto-01`**: `loadStudioPages` calls
`ensurePrototypeShell(dir)` on every board open, which writes Studio's own
preview shell (`prototype/`, `index.html`, `vite.config.js`, `package.json`)
into the user's working tree, where none of those paths is in git's excluded
set.

| Case | What it measures |
|---|---|
| `2b` | Opening a freshly cloned project dirties 16 paths the user never touched — and Studio refuses to pull or switch branches over a dirty tree |
| `6b` | The board reload that FOLLOWS a pull re-dirties it, so the second pull of a session refuses too |
| `8` | Everything through *Keep mine* holds; `Continue` cannot finish, because `git rebase --continue` refuses while any tracked file has unstaged changes and Studio has just written one |

The steps after each of those commit the scaffolding first
(`absorbStudioScaffolding`) — a workaround, labelled as one, because without it
none of G8's remaining steps can be measured at all. How much it had to absorb,
and when, is reported as `proto-01 — Studio rewrote the project` annotations on
the last case.

Run it alone (it is not in the `e2e-budgets` CI slice, and it needs a
credential CI does not have):

```sh
bun run test:e2e tests/e2e/github-sync.e2e.ts
# or, on an isolated stack alongside other agents:
E2E_VITE_PORT=5223 E2E_CMS_PORT=3223 bun run test:e2e tests/e2e/github-sync.e2e.ts
```

### Intentionally left agent-run only

**Read this section against the caveat above the coverage map, not in
isolation.** Several bullets below say a row "is now automated in
`users.e2e.ts`" / `capabilities.e2e.ts` / `media.e2e.ts` / `content.e2e.ts` /
`account.e2e.ts` / `plugins.e2e.ts` / `dashboard.e2e.ts` / `core-owner-lifecycle.e2e.ts`
— none of those files exist in `tests/e2e/` any more (removed with the CMS
admin workspaces, PR #18). Treat every such claim in this section as reverted
to agent-run-only until a real spec re-covers it; the coverage map above is
the accurate source for what is genuinely automated today.

Kept in the agent-run protocol because they are subjective, drag/zoom-physics
dependent, environment-dependent, or need product/role tooling that makes a
durable assertion brittle:

- **CAP-004 remaining capability edge variants** — remaining
  data, plugin, and AI capability depth. Need
  multi-persona role setup and step-up side-effect review better audited than
  asserted. (ADMIN-004, USERS-002 role lifecycle, mobile layout, and edge semantics, CAP-001 desktop isolation and mobile limited navigation, CAP-002, and CAP-004 data/media browse,
  manage, import/export, upload, metadata, replace, and delete affordance splits, MEDIA-004 viewer
  metadata edits, MEDIA-005 replace/delete/restore/purge/mobile lifecycle, MEDIA-006
  built-in storage panel and mobile panel coverage, and MEDIA-007 SVG sanitizer/public media
  serving are now automated in `users.e2e.ts`, `capabilities.e2e.ts`, and
  `media.e2e.ts`; CAP-005 plugin
  read/install/configure/lifecycle/schedule/pack, site AI chat rail, AI provider/audit tab gates, and AI write-tool filtering are also automated. ADMIN-003 MFA
  setup cancel, ACCOUNT-001 display-name update/profile API edges/mobile cancel no-op, ACCOUNT-002 avatar upload/removal/invalid upload feedback/API edges/storage error/mobile layout,
  ACCOUNT-003 password change and mobile dialog coverage, AUTH-002 TOTP/mobile challenge/pending-session API edges/unknown-cookie rejection/empty+wrong-code feedback/recovery-code login and reuse rejection,
  AUTH-004 active-device sign-out, mobile table containment, and session API
  edge cases, ACCOUNT-004 MFA invalid-code feedback, QR fallback,
  enable/login/recovery regenerate/disable and mobile setup dialog,
  ACCOUNT-005 step-up window, mobile controls, disabled-mode bypass, and invalid policy values, and
  CAP-003 mobile user-create dialog, expired-window re-prompt, MFA user-create step-up, plus plugin JSON-manifest install/uninstall and
  destructive CMS-bundle replace import step-up are automated too. USERS-003
  mobile audit-table containment is automated in `users.e2e.ts`.)
- **BUILDER-004 remaining edge cases and BUILDER-008 remaining formatted-content edges** —
  drag physics, custom binding/sanitization edges, and visual/typographic
  judgement; left to the friction audit or lower-level tests.
  (BUILDER-003 DOM reorder, BUILDER-004 direct canvas drag, BUILDER-005/SITE-009
  undo/redo history lifecycle, BUILDER-006 style controls, and BUILDER-007 breakpoint variants
  are automated in `visual-builder.e2e.ts`. BUILDER-008 rich-body bold/italic
  persistence and public entry-template rendering are automated in
  `content.e2e.ts`.)
- **MODULE-001 remaining browser/editor permutations** — body/container/outlet
  render contracts are covered by focused Bun tests in
  `src/__tests__/base-modules.test.ts` and
  `src/modules/base/outlet/__tests__/outlet.render.test.ts`; browser insertion,
  full template composition, permission variants, and responsive authored-layout
  review remain agent-run.
- **MODULE-002 remaining browser/editor permutations** — common text/list/link,
  button/image/SVG/video render contracts are covered by focused Bun tests in
  `src/__tests__/base-modules.test.ts`, `src/__tests__/core/sanitizeSvg.test.ts`,
  and `src/__tests__/htmlImport/svgMapping.test.ts`; browser insertion/edit,
  media-picker combinations, permission variants, and responsive authored-layout
  review remain agent-run.
- **MODULE-003 remaining browser/editor permutations** — loop module
  conformance/defaults/tag fallback, publisher iteration/currentEntry and
  parentEntry isolation, empty/missing data, prefetch, infinite runtime
  injection, and request-dependent detection are covered by focused Bun tests in
  `src/__tests__/base-modules.test.ts`,
  `src/__tests__/publisher/loopRender.test.ts`,
  `src/__tests__/server/loopPrefetch.test.ts`, and
  `src/__tests__/server/dynamicDetection.test.ts`; browser insertion,
  dynamic property-panel editing, permission variants, stale-data UX, and
  responsive repeated-layout review remain agent-run.
- **MODULE-004 remaining browser/editor permutations** — form module
  conformance, semantic render contracts, publisher-boundary escaping, formId
  normalization, snapshots, settings analysis, validation, canvas suppression,
  form preview, runtime emission, public endpoint security, and the form
  settings panel are covered by focused Bun tests in `src/__tests__/forms/`,
  `src/__tests__/canvas/`, `src/__tests__/publisher/`,
  `src/__tests__/server/publicForms.test.ts`, and
  `src/__tests__/panels/formSettingsPanel.test.tsx`; browser insertion, full
  edit/save/publish/public submission, permission variants, and mobile form
  composition remain agent-run.
- **MODULE-005 remaining browser/editor permutations** — component-ref,
  slot-outlet, and slot-instance module contracts; publish-behavior dispatch;
  schema-derived defaults; publisher inlining; prop overrides; slot
  content/defaults; missing components; hidden nodes; sanitization; nested refs;
  slot sync; recursion/data-layer gates; editor-store reconciliation;
  persistence healing; canvas slot reactivity/editing; locked slot DnD; and
  placement architecture are covered by focused Bun tests in
  `src/__tests__/base-modules.test.ts`,
  `src/__tests__/module-engine/moduleConsolidation.test.ts`,
  `src/__tests__/publisher/`, `src/__tests__/core/`,
  `src/__tests__/editor-store/`, `src/__tests__/persistence/`,
  `src/__tests__/integration/`, `src/__tests__/canvas/`,
  `src/__tests__/dom-panel/`, and `src/__tests__/architecture/`; browser
  conversion/reuse/publish permutations, permission variants, and mobile
  component editing remain agent-run.
- **SITE-014 remaining browser/operator permutations** — dependency panel
  import analysis, missing-dependency add, stale-lock status, manual and
  background resolve flows, client envelope validation, runtime handler
  normalization, module dependency/importmap filtering, site runtime build,
  dependency resolver/cache, package importmap/server, malformed runtime-cache
  paths, and runtime asset publish injection are covered by focused Bun tests in
  `src/__tests__/panels/depsSectionRuntime.test.tsx`,
  `src/__tests__/editor-hooks/useAutoResolveDependencies.test.tsx`,
  `src/__tests__/persistence/cmsRuntimeClient.test.ts`,
  `src/__tests__/server/cmsRuntimeHandlers.test.ts`,
  `src/__tests__/module-engine/moduleDependencies.test.ts`,
  `src/__tests__/module-engine/runtimeResolver.test.ts`,
  `src/__tests__/server/runtimeDependencies.test.ts`,
  `server/publish/runtime/__tests__/cacheLayout.test.ts`,
  `src/__tests__/server/siteRuntimeBuild.test.ts`,
  `src/__tests__/site-runtime/runtimeConfig.test.ts`,
  `src/__tests__/site-runtime/importAnalysis.test.ts`, and
  `src/__tests__/publisher/runtimeAssets.test.ts`. Browser authoring of a
  site script import, Dependencies-panel missing-package Add, live
  `canvas-confetti` registry/cache resolution, publish, public importmap
  emission, browser loading of the emitted runtime-cache package URL, and a
  390px mobile path that verifies Code Editor authoring plus dependency-panel
  containment/Add reachability are covered by
  `tests/e2e/runtime-dependencies.e2e.ts`; live registry/install failure UX
  permutations remain operator-run.
- **PUBLIC-003 remaining browser/operator permutations** — external CSS link
  generation and stale/malformed CSS 404s, DB-backed and disk-baked runtime
  asset serving, module-JS injection and route validation, runtime package
  importmap/cache/server behavior, full-router ownership of runtime cache
  package URLs, runtime script injection safety, and signed media redirect
  architecture are covered by focused Bun tests in
  `src/__tests__/server/publicRendering.test.ts`,
  `src/__tests__/server/publishStaticArtefact.test.ts`,
  `src/__tests__/server/moduleJsRoute.test.ts`,
  `src/__tests__/server/moduleJsBundle.test.ts`,
  `src/__tests__/publisher/runtimeAssets.test.ts`,
  `src/__tests__/publisher/render.test.ts`,
  `server/publish/runtime/__tests__/cacheLayout.test.ts`,
  `server/__tests__/runtime-bundle-scripts.test.ts`,
  `src/__tests__/server/runtimeAssetRepository.test.ts`,
  `src/__tests__/architecture/module-js-asset-route.test.ts`, and
  `src/__tests__/architecture/media-signed-redirect-serving.test.ts`; browser
  asset waterfalls, CDN cache behavior, real mobile network/device
  permutations, and live signed-storage adapters remain operator-run.
- **PUBLIC-004 remaining browser/operator permutations** — dynamic-node
  detection rules, loop render semantics, loop data prefetch, static-shell
  baking with hole runtime, hole runtime lazy/eager fetching, hole fragment
  stale-version/missing-node/cache behavior, per-query and per-visitor dynamic
  plugin islands, form token stamping in fragments, and full-router ownership
  of hole runtime/fragment URLs are covered by focused Bun tests in
  `src/__tests__/server/holeRouteHandler.test.ts`,
  `src/__tests__/server/holeRuntime.smoke.test.ts`,
  `src/__tests__/server/holePublisher.test.ts`,
  `src/__tests__/publisher/loopRender.test.ts`,
  `src/__tests__/server/loopPrefetch.test.ts`,
  `src/__tests__/server/dynamicDetection.test.ts`,
  `src/__tests__/server/dynamicDetectionLoop.test.ts`,
  `src/__tests__/server/dynamicIslandsPlugin.test.ts`,
  `src/__tests__/architecture/hole-runtime-asset-route.test.ts`, and
  `src/__tests__/server/publishStaticArtefact.test.ts`. **Browser route-query
  hole hydration has no Playwright coverage** — `tests/e2e/public-dynamic-fragments.e2e.ts`
  does not exist in this repo (it may never have been committed, or was
  removed with the CMS-workspace specs; either way there is nothing under
  `tests/e2e/` covering the baked shell, hole runtime asset, or hole fragment
  response today). The baked shell, hole runtime asset, hole fragment
  response, mobile query values, placeholder-backed real-browser
  `IntersectionObserver` timing, and live external loop-source failures all
  remain agent-run/operator-run until such a spec exists.
- **FORM-001 remaining browser/operator permutations** — form module
  conformance/render contracts, snapshots, settings analysis, compatible field
  binding, setup-panel table creation/missing-field/preview behavior, canvas
  native-control suppression including submit buttons, and form-preview parent
  lookup are covered by focused Bun tests in `src/__tests__/forms/`,
  `src/__tests__/canvas/canvasFormControls.test.tsx`,
  `src/__tests__/canvas/canvasFormPreview.test.ts`, and
  `src/__tests__/panels/formSettingsPanel.test.tsx`; full browser
  authoring-to-publish submission, permission variants, and mobile public form
  layout remain operator-run.
- **FORM-002 remaining browser/operator permutations** — full-router ownership
  of public form URLs, same-origin/page-token challenge issuance, one-time
  challenge submission, oversized payload handling, rate limits, target-table
  guards, field validation, form runtime challenge prefetch/submit delegation,
  page-token stamping, form module contracts, snapshots, settings analysis, and
  settings-panel behavior are covered by focused Bun tests in
  `src/__tests__/server/publicForms.test.ts`,
  `src/__tests__/publisher/formRuntime.test.ts`,
  `src/__tests__/publisher/formModuleJs.test.ts`,
  `src/__tests__/server/formChallengeSecret.test.ts`,
  `src/__tests__/forms/formModules.test.ts`,
  `src/__tests__/forms/formSettingsAnalysis.test.ts`,
  `src/__tests__/forms/formSnapshot.test.ts`,
  `src/__tests__/forms/formValidation.test.ts`, and
  `src/__tests__/panels/formSettingsPanel.test.tsx`; browser success/error
  copy, min-submit timing with real clocks, full authoring-to-publish form
  submission, and mobile public form layout remain operator-run.
- **CONFIG-001 remaining operator permutations** — DATABASE_URL parsing,
  SQLite adapter selection, parent-dir creation, migration idempotence,
  Postgres scheme selection, invalid scheme errors, migration parity, JSON
  column naming, repository SQL portability, SQLite smoke behavior, rowCount,
  transaction serialization, advisory-lock fallback, statement cache, dev
  workflow, and Docker config are covered by focused Bun tests in
  `src/__tests__/db/`, `src/__tests__/architecture/`,
  `server/db/__tests__/`, `src/__tests__/devWorkflow.test.ts`, and
  `src/__tests__/server/dockerConfig.test.ts`; live Postgres connectivity,
  credential failures, backups/restore, and hosted environment permutations
  remain operator-run.
- **CONFIG-002 remaining operator permutations** — runtime config defaults
  and env overrides for `PORT`, `DATABASE_URL`, `UPLOADS_DIR`, `STATIC_DIR`,
  trusted proxies, and public origins; health routing; admin/static/uploads
  serving; upload response hardening; dev launcher/proxy contracts; and
  Docker image/compose healthcheck/persistent-data wiring are covered by
  focused Bun tests in `src/__tests__/server/serverConfig.test.ts`,
  `src/__tests__/server/staticAdmin.test.ts`,
  `src/__tests__/server/router.test.ts`, `src/__tests__/devWorkflow.test.ts`,
  and `src/__tests__/server/dockerConfig.test.ts`; actual port-conflict
  handling, Caddy TLS issuance, filesystem permission failures, and
  deployed-platform smoke remain operator-run.
- **CONFIG-003 remaining operator permutations** — form secret precedence and
  fallback, public form challenge routing, plugin manifest host/path/coherence
  checks, granted-permission enforcement, SSRF-gated fetch, encrypted plugin
  settings, media adapter boundary validation, and runtime dependency
  cache/package serving are covered by focused Bun tests in
  `src/__tests__/server/formChallengeSecret.test.ts`,
  `src/__tests__/server/publicForms.test.ts`,
  `src/__tests__/plugins/pluginManifest.test.ts`,
  `src/__tests__/plugins/gatedFetchSsrf.test.ts`,
  `src/__tests__/server/pluginVmPermissions.test.ts`,
  `src/__tests__/server/pluginSecrets.test.ts`,
  `src/__tests__/server/pluginMediaAdapterBoundary.test.ts`,
  `src/__tests__/server/runtimeDependencies.test.ts`, and
  `server/publish/runtime/__tests__/cacheLayout.test.ts`; live provider/network
  permutations, true process-restart durability, and browser UI permutations
  remain operator-run.
- **SECURITY-001 remaining operator permutations** — CMS/AI invalid-origin
  mutations before DB access, safe CMS GET auth behavior, CMS namespace 405s,
  capability-before-body ordering, malformed JSON/schema body rejection,
  route-shape fuzzing across 76 CMS mutation endpoints and 11 AI mutation
  endpoints, configured custom/platform public origins at the CMS/AI boundary,
  trusted-proxy forwarded-host/proto spoof rejection at the CMS/AI boundary,
  route-table semantics, handler capability architecture gates,
  HTTP boundary-validation gates, origin helper behavior, AI driver isolation,
  and AI tool capability filtering are covered by focused Bun tests in
  `src/__tests__/server/apiSecurityBoundary.test.ts`,
  `src/__tests__/server/security.test.ts`,
  `src/__tests__/server/routeTable.test.ts`,
  `src/__tests__/server/capabilityRouteMatrix.test.ts`,
  `src/__tests__/architecture/boundary-validation.test.ts`,
  `src/__tests__/architecture/cms-handlers-capability-gated.test.ts`,
  `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`,
  `src/__tests__/architecture/ai-driver-isolation.test.ts`, and
  `src/__tests__/agent/aiToolCapabilityGate.test.ts`; live deployed smoke and
  browser-observed API error UX remain operator-run.
- **CONTENT-003 remaining media/sanitization edges, CONTENT-005 remaining
  error/mobile edges, CONTENT-007 provider-backed flows,
  and remaining CONTENT-006 field schema edges** — rich body media-picker
  insertion, sanitization, live-template missing-template/stale-state checks,
  provider-backed chat/model-test flows, custom field-schema edge cases, and
  destructive collection deletion remain agent-run or lower-level until stable
  browser fixtures exist.
  CONTENT-003 slash-menu heading/data-token persistence, CONTENT-005 template
  draft rendering, CONTENT-006 built-in collection field toggles, and
  CONTENT-007 no-provider setup guidance are automated in `content.e2e.ts`.
- **PLUGIN-001 remaining invalid-package edges, PLUGIN-005 remaining schedule edges, and PLUGIN-006 remaining pack edges** —
  need broader local plugin fixtures. PLUGIN-001 JSON-manifest permission
  review/install step-up and ZIP package review/install now have Playwright
  coverage. PLUGIN-002 has a packaged lifecycle smoke for disable, enable,
  runtime route unregistration and restoration, and uninstall cleanup.
  PLUGIN-003 has a packaged settings/secrets smoke that verifies persistence,
  accessible labels, and browser-bound secret masking. PLUGIN-004 has a
  packaged ZIP smoke for plugin admin pages, a resource record page, an app
  page asset, and an authenticated runtime route. PLUGIN-005 has a packaged
  schedule smoke for inspection, run-now, pause, and resume. PLUGIN-006 has a
  packaged site-pack smoke for auto-imported page content and re-sync feedback.
  PLUGIN-008 invalid manifest upload and recovery is automated in
  `plugins.e2e.ts`.
- **AI-001/AI-002/AI-003/AI-004/AI-005/AI-006 remaining provider-network/defaults/conversation/chat/tool-bridge/audit edges and AI-007 remaining live-driver edges** —
  live provider model tests, remaining defaults editing, conversation title/cross-user/stale-credential cases, mutating write-tool
  loops, bridge timeout/abort and malformed-result UX, dashboard/range/timezone audit views, and provider driver/pricing
  behavior remain lower-level or future fixture-backed browser coverage.
  AI-001 Ollama credential create/list/delete and offline default-guard coverage
  are automated in `ai.e2e.ts`; AI-002 Data-scope default save/reload/clear
  coverage is automated there too. AI-003 Site chat history load/new/delete,
  AI-004 fixture-backed Site assistant streaming, AI-005 browser
  `site_read_document` tool-result bridge, CAP-005 request-level AI write-tool filtering, and AI-006 Audit tab rollups from that
  streamed usage are also automated in `ai.e2e.ts`. AI-007 direct
  Anthropic/OpenAI/Ollama/OpenRouter driver mapping and pricing coverage is
  automated in focused Bun tests; live-provider network behaviour remains
  outside the browser suite.
- **PERF-* and remaining error-recovery sweeps**  — performance and broader
  error recovery remain observational, agent-run.
  PERF-001 and PERF-002 have Site editor startup and moderately-complex publish
  completion smokes in `performance.e2e.ts`; deeper profiling and regression
  budgeting remain agent-run.
  A11Y-001 and A11Y-002 have keyboard login and main shell navigation
  regressions in `accessibility.e2e.ts`; deeper focus-order sweeps remain
  agent-run.
  RESP-002 has a mobile public-page smoke regression in `accessibility.e2e.ts`;
  broader multi-module mobile visual review remains agent-run. REL-001 has a
  saved-edit reload-recovery smoke in `reliability.e2e.ts`; deeper crash and
  error-boundary recovery remains agent-run. REL-002 has a page-slug validation
  smoke in `error-handling.e2e.ts`; broader form/error sweeps remain agent-run.

**`core-owner-lifecycle.e2e.ts` no longer exists** — it was the flagship owner
journey (login/logout, edit homepage text, save/reload, step-up-gated publish,
visitor-facing public output, draft/public isolation) and was removed with the
CMS-workspace specs. `page-management.e2e.ts` and `admin-navigation.e2e.ts`
now carry the closest surviving pieces (page create/rename/delete/switch,
draft reload, toolbar publish target), but there is no single spec proving the
whole login-to-public-output journey end to end. Recreating that flagship
journey against the Studio-only admin shell is real follow-up work.
