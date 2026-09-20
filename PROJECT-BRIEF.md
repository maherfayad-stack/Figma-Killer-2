# PROJECT BRIEF — read this before touching anything

**You are working on Studio: a Figma-grade visual design tool whose source of truth is a real React repository on disk.**

If you read only one thing, read this file. It exists so you do not have to
re-scan the repo to understand what this project is. `CLAUDE.md` tells you the
*rules*; this file tells you the *product, the current state, and where to look*.

---

## 1. The single most important disambiguation

This repository began as a fork of an open-source **CMS**. The product is now
**Studio**, and every identifier, route, and doc has been renamed accordingly —
there is no other product name in the tree. But **a large CMS subsystem is still
in here, dormant**, and several `docs/features/*.md` still describe it.

| | The dormant CMS half | **Studio** (what we work on) |
|---|---|---|
| Source of truth | Postgres/SQLite `data_tables` + `data_rows` | **Files on disk** in `studio-workspace/<project>/` |
| Content | Pages authored in the editor | **A real React repo** — `.tsx`/`.jsx` the user wrote or imported |
| Editing | Edit a DB-backed page tree | Edit the canvas → **AST codemods rewrite the user's source files** |
| Output | Published static HTML | **The repo itself** — you download the code, no codegen |
| Canvas | One page, several breakpoint frames | **A board** — every page as a frame, laid out in 2D like Figma |

**The CMS code is kept but unsurfaced.** It is load-bearing — Studio's editor
store, page tree, module engine, canvas, admin shell, and auth are all built on
it — so do not delete it, do not build new features on it, and do not let a CMS
feature doc convince you that a CMS concept is the right home for a Studio
feature. When a doc conflicts with this brief, **this brief wins**.

Docs for CMS-only surfaces Studio never touches (Content/Data/Dashboard/Media
workspaces, audit log, loops, entry templates, CMS forms, site transfer) have
been **deleted**. What remains under `docs/features/` is either Studio's own or
shared infrastructure Studio genuinely depends on.

**Practical rule:** if your change is about parsing/rendering/writing back a
user's React repo, it belongs in the Studio surfaces listed in
[`docs/agent-refs/path-index.md`](docs/agent-refs/path-index.md). If you find
yourself adding a database migration, stop and re-read the task.

---

## 2. The 60-second mental model

```
studio-workspace/<project>/          ← a real React repo. THE source of truth.
        │
        │  GET /admin/api/studio/load?dir=<abs>
        ▼
  ts-morph static parse               server/handlers/studioPageLoad.ts
  (NEVER executes the code)           src/core/page-parser/
        │  · walk JSX → ParsedNode tree
        │  · inline local components  (inlineLocalComponents.ts)
        │  · resolve values statically (staticEval*.ts — Tiers A/B/C only)
        │  · expand `.map` over resolved arrays
        │  · read imported .css → StyleRule + node.classIds
        ▼
  Instatic `Page` tree                src/core/studio-sync/parsedPageToSitePage.ts
        │
        ▼
  Board canvas                        src/admin/pages/site/canvas/
  one <iframe> per frame              IframeFrameSurface.tsx
        │
        │  user edits a prop / text / style / class / tag, or inserts,
        │  reorders, reparents, duplicates, wraps, groups, ungroups or
        │  deletes an element
        ▼
  Typed StudioEdit batch              POST /admin/api/studio/save
        │
        ├──▶ AST codemods             src/core/ast-codemods/
        │    rewrite the user's .tsx  (setJsxProp, setJsxText, setJsxStyle,
        │                              setJsxClassName, setStringLiteral,
        │                              setJsxTagName, insertJsxElement,
        │                              moveJsxElement, deleteJsxElement,
        │                              duplicateJsxElement, wrapJsxElement,
        │                              wrapJsxElements, unwrapJsxElement)
        │
        └──▶ postcss CST codemods     src/core/css-codemods/
             rewrite the user's .css  (setDeclaration, insertRule — routed by
                                       server/handlers/studioCssWriteback.ts)
```

A structural gesture that CANNOT be written (a `.map` row, a shared component,
a container in another file) is refused before the tree mutates, with a
reason — `refuseStructuralEdit` in `src/core/page-tree/sourceStructure.ts`. It
never silently no-ops.

**Two invariants that explain 80% of the code's weirdness:**

1. **Parse, never execute.** No component is rendered server-side, no hook is
   called. Every value on the canvas was read out of the AST. This is why there
   is a hand-written bounded evaluator with explicit tiers instead of "just run
   it". **Every project starts at Tier 2 (`run-project`) by default —
   `DEFAULT_TRUST_TIER`, owner decision, 2026-09-20** (superseding the narrower
   2026-09-17 override below). **The parse itself never executes anything at
   any tier**; the tier only decides whether Studio may run the workspace's OWN
   code (its style toolchain, its package components, its dev server) on top of
   the parse. The tier is a per-project fact the owner can lower (the Live
   pill's "Back to static") and raise again — nothing promotes automatically
   any more because nothing needs to. Tier 1 (`render-packages`) buys exactly
   two things — the workspace's own style toolchain compiles in a capped
   subprocess (`styleCompileTier1.ts`) and its package components are bundled
   and rendered in the canvas (`componentBundle.ts`) — reachable now only for a
   project explicitly demoted below Tier 2, since Tier 2 already implies it
   (`trust !== 'static'`). Tier 2 (`run-project`) is genuinely distinct from
   Tier 1 still: the dev-server manager, the preview deploy, and the agent's
   `studio_render_reference` all demand `trust === 'run-project'` exactly, via
   `server/handlers/studio/trustGate.ts` — not the looser `trust !== 'static'`
   that Tier-1 consumers read, so a project explicitly set to `static` is
   refused exactly as before. Read the default for what it is: **Tier 2 is a
   PRODUCT DEFAULT, not a consent boundary** (`sec-12`) — every project ships
   with `studio_render_reference`'s gates satisfied by default, and no human
   answers a question to get there. Anything that needs a human to have agreed
   must ask at the point of use, and the single-operator posture is what makes
   the default acceptable at all. (Superseded: before 2026-09-20, one narrow
   automatic promotion — the owner's call on 2026-09-17,
   `STUDIO-FIGMA-FEEL-PLAN.md` §6 decision 2 — promoted only a Vite project
   with a lockfile, once, with a notice and an Undo in the board chrome. That
   mechanism (`LiveAutoPromoteNotice`) is gone; there is no lower default left
   to promote FROM.)
2. **A write must have exactly one honest target.** Every lock, every
   `codeProps` entry, every refusal exists because writing an edit there would
   destroy a binding, change N places at once, or write to a file that does not
   exist. When you are tempted to "just make it editable", you are almost
   certainly about to corrupt a user's repo.

---

## 3. Where you are right now

| | |
|---|---|
| Base branch for PRs | `main` (protected — never push to it). Branch per change, `<type>/<kebab>` |
| Roadmap | [`STUDIO-IMPORT-V2-PLAN.md`](STUDIO-IMPORT-V2-PLAN.md) — the feature plan (WS-1…WS-9). **Intent, not status** — most of it has shipped; check §0a below before believing a "not built" claim there. [`STUDIO-NEXT-WORKSTREAMS.md`](STUDIO-NEXT-WORKSTREAMS.md) carries the workstreams beyond it (WS-10…WS-14) |
| Defect + parity plan | [`STUDIO-FIGMA-PARITY-PLAN.md`](STUDIO-FIGMA-PARITY-PLAN.md) — **§0a is the granular per-track status ledger.** When you need finer detail than the two lists below, read it there, not here |
| **Active plan** | [`STUDIO-FIGMA-FEEL-PLAN.md`](STUDIO-FIGMA-FEEL-PLAN.md) — **the plan currently being executed** (opened 2026-09-17). Tracks Z (zero noise, a barrier before everything else), S (snappy), K (keys and hands), P (panels/prototype/preview), A (agent), G (GitHub), V (verification). Its §0 lists what is already true, §6 the owner's seven decisions, §7 the defects found in the audit that opened it |
| Live canvas + inspector plan | [`STUDIO-LIVE-CANVAS-PLAN.md`](STUDIO-LIVE-CANVAS-PLAN.md) — **landed**: Tier 2 live runtime frames (L1–L8), refusals-as-choices (R1–R3) and the Penpot-measured inspector rebuild (P0–P6) are all in the tree. L9 is the only unstarted work order. Every project now starts at Tier 2 by default (2026-09-20), so Track L is exercised on every project open, not just a promoted one |
| Built-in design system | [`STUDIO-BUILTIN-DESIGN-SYSTEM-PLAN.md`](STUDIO-BUILTIN-DESIGN-SYSTEM-PLAN.md) — **shipped (DS-1…DS-9)**, 2026-09-17. The `@alm-design/design-system` npm is retired: the design system is vendored at `vendor/alm-design-system/`, projects carry their own `design-system/` folder, the insert dialog is an **Assets** panel of live previews, and the toolbar `+` is **Add page**. Only DS-4b (drag a card to the canvas) is open |
| Live coordination | [`STATE.md`](STATE.md) — **read at the start of every task, write at the end** |
| Entry point in the app | `/admin/site` — `src/admin/router.tsx` renders the studio editor there unconditionally; there is no mode flag and no `?studio` param. Which project is open comes from `src/admin/pages/site/studio/studioWorkspaceDir.ts` (localStorage-sticky, set by the Overview launcher; the server falls back to the first project on disk) |
| Test projects on disk | `studio-workspace/` — whatever folders are there on your checkout (`test4` and `test4 copy` on this one). **User data: never `rm -rf` one, and never assume a given project exists.** |

### What works today (do not rebuild)

- GitHub zipball import with path-traversal / zip-bomb guards, plus a
  **Keep history (clone)** alternative (`POST git/clone`) that lands the repo
  with its history and `origin` set — target derived server-side, refuses an
  existing project rather than clearing it
- **Sign in to GitHub** (device flow + paste-a-PAT), token stored encrypted per
  user in `git_credentials` and handed to git through a 0600 one-shot
  `GIT_ASKPASS` script — never an env var, never a URL. Connect a repository
  (`git/remotes`, `git/remote`) with a two-shape URL allowlist. See
  [`docs/features/studio-git.md`](docs/features/studio-git.md)
- **The whole git publish sentence in the Version control panel**: a branch
  *dropdown* (list / create-from-current / commit-and-switch — never a stash),
  fetch, `--ff-only` pull with an explicit rebase-or-merge choice on divergence,
  per-file conflict resolution (*Keep mine / Keep theirs / Open in code* →
  *Continue*, with `mine`/`theirs` translated server-side because git's
  `--ours`/`--theirs` invert during a rebase), push disabled while behind, and
  **Open PR** with base/title/body defaulted from the repository. The same five
  verbs are MCP tools behind `studio.git.write` (`studio_git_status` is a read)
- **One write lock per project** (`server/handlers/studio/projectWriteLock.ts`):
  saves, page scaffolds, dependency installs and every mutating git verb take
  an async mutex keyed by the real project path, so a canvas save can no longer
  land between a `git add` and its `git commit`. A git verb waiting more than
  5 s answers `409 { code: 'busy' }`; a save waits
- Multi-file page discovery + `.studio/meta.json` (`displayName`, `pagesDir`, `previewAxes` — `direction`/`colorScheme`/`locale`)
- ts-morph parse, local-component inlining through barrels, tsconfig `paths` aliases
- Static value resolution Tiers A/B/C, `.map` expansion, multi-return/ternary/`&&`
  branch **selection** (parser-06 — one branch chosen, unlocked; the rest recorded
  as `branchAlternatives`, never stacked)
- Per-prop writability (`codeProps`), resolved-text writeback at its literal origin
- Plain-CSS import → `StyleRule` registry + `node.classIds`
- Compiled styles (WS-2.1/2.2): CSS Modules (`.module.css`, Tier 0) rewritten
  to hashed class names and resolved through the evaluator
  (`styles.card`, `cn()`/`clsx()`/`classnames()`); Tailwind v3/v4, Sass, and
  PostCSS compiled by running the workspace's own toolchain once the project
  is off Tier 0 trust — which every project is by default since 2026-09-20 —
  `server/handlers/studio/styleCompile.ts`
- Vendor package CSS (WS-2.3): a bare-specifier `.css` import
  (`import '@acme/ui/dist/style.css'`) is resolved against the project's own
  `node_modules` and injected into the canvas iframe as a read-only
  `@layer vendor` bucket (`ProjectCssInjector`), ordered below the editable
  `@layer user-authored` class registry — Tier 0 safe, no trust gate
- **Trust tiers.** `.studio/meta.json`'s `trust` field has three values —
  `static` (Tier 0), `render-packages` (Tier 1), `run-project` (Tier 2) —
  read/written by `server/handlers/studio/trustTier.ts` and driven from the
  client by `setStudioProjectTrust`/`promoteProjectToTier1`
  (`studio/studioProjectTrust.ts`). **Every project starts at `run-project`
  (Tier 2) by default — `DEFAULT_TRUST_TIER`, owner decision, 2026-09-20** —
  superseding the earlier, narrower 2026-09-17 override
  (`STUDIO-FIGMA-FEEL-PLAN.md` §6 decision 2) that auto-promoted only a Vite
  project with a lockfile, once, via a board notice with an Undo
  (`LiveAutoPromoteNotice` — retired in the same change). Nothing promotes
  automatically any more because nothing needs to: the tier is a per-project
  fact the owner can lower (the Live pill's "Back to static") and raise again.
  A non-Vite project's Live pill still reads "Live needs Vite" (§6 decision 5,
  deferred) — that capability check is unrelated to the trust tier and stays.
  Tier 2 (`run-project`) has a real gated consumer beyond the MCP visual-audit
  tool: `server/handlers/studio/devServer.ts`'s dev-server process manager
  (Track L, `live-01`) — one reused, idle-timed subprocess per project,
  exposed as a polled `status`/`start`/`stop` route family and prewarmed the
  instant a Tier-2 project's canvas mounts (now every project, on open).
  **A Tier-2 action needs two independent gates, and the tier is the one that
  cannot be delegated.** The `studio.run.project` capability (held by
  Owner *and* Admin, A10) says a caller may run project code at all; the
  project's own tier says *this* project may be run. Every Tier-2 entry point
  checks both through the one shared helper — `requireTrustTier` for an HTTP
  route, `checkTrustTier` for an agent tool — in
  `server/handlers/studio/trustGate.ts`. Until A10 the MCP tool
  `studio_render_reference` checked only the capability, which made it
  strictly weaker than the route performing the identical spawn (`sec-05`
  finding 1); the trap to avoid is adding a Tier-2 tool that leans on the
  capability alone. **Tier 2 is a PRODUCT DEFAULT, not a consent boundary**
  (`sec-12`) — every project ships with both gates satisfied by default, and
  no human answered a question to get there; anything that genuinely needs a
  human to have agreed must ask at the point of use.
- **A built-in design system, and an Assets panel to insert from**
  (`STUDIO-BUILTIN-DESIGN-SYSTEM-PLAN.md`, DS-1…DS-9). The 39-component ALM
  design system is **vendored into Studio** at `vendor/alm-design-system/` and
  registered as the `alm.*` pack (`src/modules/alm/register.tsx`) — it renders
  at **Tier 0**, with no npm, no install and no promotion, because it is
  Studio's own code. A DS-backed project carries a Studio-written
  `<project>/design-system/` folder (`designSystemFiles.ts`) and imports it
  relatively, so the downloaded repository builds with react + vite and nothing
  else; the parser treats that folder as a black box
  (`src/core/page-parser/designSystemDir.ts`). A project that still imports the
  retired npm gets a board banner offering a one-click source rewrite
  (`designSystemMigrate.ts`) — never automatic. The left rail's **Assets**
  panel (`src/admin/pages/site/panels/AssetsPanel/`) replaced the full-screen
  insert dialog: design-system components grouped by purpose, elements,
  layouts, saved components and icons, **every card a live render of the real
  component** inside a shadow root, searched by name, description and purpose
  keywords (`rankAssets.ts`). The toolbar / notch `+` is now **Add page**
  (`AddPagePicker.tsx`).
- npm package components (`pkg-01`/`pkg-02`/E4): manifest → bundle → register
  → render is wired end to end for **any** installed package —
  `server/handlers/studio/componentBundle.ts`
  (`tryServeStudioComponentBundle`),
  `src/admin/pages/site/studio/registerProjectModules.ts`
  (`useRegisterProjectModules`). Registration fires on every project-dir /
  trust-tier transition and is **not** gated on the board already containing a
  `pkg.*` node, so a package with zero call sites in the imported source is
  still listed in Assets. Rendering stays gated on trust tier ≥ 1 —
  Tier 0 gets `PackageComponentPlaceholder`'s "promote this project" surface
  and the Assets panel's own "N components need this project promoted" notice,
  never a silent empty palette, and never a fetch or an execution.
- **Dependency install** (E3): the Dependencies panel's Add/Remove run a real
  `bun add`/`bun remove` (or the project's own detected package manager)
  against the on-disk project, as a polled job —
  `server/handlers/studio/installDeps.ts` (`POST /admin/api/studio/install`,
  mirrored to `.studio/install-job.json` so a `bun --watch` restart mid-install
  doesn't strand the poller), `panels/DependenciesPanel/`
  (`DepsSection.tsx`, `useDependencyInstallJob.ts`). A successful install
  resyncs the package modules without a page refresh.
- **Project-wide component catalog** (E1): `GET /admin/api/studio/components`
  (`server/handlers/studio/components.ts`) answers "what components does this
  project have, and what props do they take" off the same ts-morph `Project`
  the page parse already builds. Client half + per-dir cache:
  `studio/componentCatalog.ts`. Live consumers: the instance **swap** picker
  and the call-site **prop rows** (`InstanceCallSiteView.tsx`), and the
  slot-fill picker (`property-controls/SlotPicker.tsx`). Local components
  only; package components are not in it, and neither is the insert picker.
- Component instances, swap, detach (WS-4.2 / `parser-05` / `instance-ui-01`):
  every local-component call site is a `studio.instance` node with an
  editable call-site prop surface (`InstanceCallSiteView.tsx`, routed from
  `renderModuleTabContent.tsx`), not spliced away. Detach (inline the
  component's own JSX at the call site), swap (retarget to another local
  component, candidates from the catalog above) and extract-a-copy
  (`extractComponentCopy.ts`, offered as the remedy when detach refuses) all
  write real codemods and are wired to the panel — proven end to end by
  `tests/e2e/instance-selection-ui.e2e.ts` and `instance-fragment-node.e2e.ts`
  against the real eSIM board. Detach refuses honestly wherever the call site
  captures a hook or has no writable source location (~42% clean-detach rate
  measured on the real corpus — the rest are correct refusals, not bugs).
- Extract-to-component and slots (E2): `extractSubtreeToComponent.ts`,
  `addSlotPropToComponent.ts`, `insertJsxIntoSlotProp.ts` in
  `src/core/ast-codemods/`; the parser captures fragment-valued slots as
  `studio.slot` nodes.
- **Scroll unrolling** — a frame renders a page's full height instead of a
  clipped scroll region: `canvas/canvasScrollUnroll.ts` (pure classification)
  + `canvas/CanvasScrollUnrollInjector.tsx` (the per-iframe injector).
- **Frame multi-select and bulk actions** — Shift-click, ⌘/Ctrl+A, marquee,
  and bulk align/distribute/tidy:
  `store/slices/boardFrameSelectionActions.ts`,
  `canvas/BoardFramesLayer/useMarqueeSelection.ts`, and the multi-frame
  inspector `panels/PropertiesPanel/FrameBulkInspector.tsx`.
- Board frames with per-frame x/y/w/h, sticky notes, doc cards, frame virtualization
- iframe-per-frame canvas with cascade-layered CSS injection, each board frame
  wrapped in `BreakpointFrame.tsx` (`BoardFramesLayer.tsx`) — the same
  design-mode viewport component Live mode uses, load-bearing in both, not
  CMS residue
- CSS animations, transitions, smooth scroll and media autoplay all freeze on
  the canvas (`canvas/CanvasAnimationInjector.tsx`) — an animation plays once
  at its authored speed and holds
- **CSS write-back, three ops, all reaching disk** (WS-6.3 / `panel-02` /
  Track B1). One server entry, `server/handlers/studioCssWriteback.ts`, one
  codemod pair in `@core/css-codemods`, one client planner
  (`studio/styleRuleWriteback.ts`'s `collectStyleRuleEdits`):
  - `op: 'set'` — change a value on a rule the parser mapped to a real
    hand-authored `.css` file (`setDeclaration`).
  - `op: 'insert'` — a rule the user created in the editor that has no source
    yet, written into the stylesheet co-located with its anchor page, or the
    project's one editable stylesheet (`insertRule`). The anchor page is the
    class's own page, or — for a class that is on no element yet — the page
    the user has OPEN (Z8, `resolveOpenPageFile`). With several candidates and
    none co-located, `resolveCssInsertDestination` still refuses rather than
    guessing, but the refusal is a **choice**: a `RefusalDialog` with one
    `choose-stylesheet` remedy per candidate file, which pins the destination
    and re-runs the insert. Never a toast.
  - `op: 'create'` — no editable stylesheet exists at all: the server invents
    one co-located with the anchor page, wires the page's `import`
    (`ensureStylesheetImport`, a ts-morph edit — which is why it cannot happen
    client-side), and writes the rule into it.

  All three are formatting-preserving postcss CST edits, and inserting a
  selector that already exists **merges** rather than adding a second
  cascade-shadowing block. A rule stays writable through the ordinary `set`
  path on its next edit with no reload (`commitBaseline` /
  `recordCreatedStylesheet`). What still does not write is a change scoped to
  a real `@media` breakpoint — see "What does NOT work today"
- **Class assignment writes to source** (Track B2): `setJsxClassName.ts` plus
  the `{ kind: 'class', add, remove }` edit kind (`studio/studioEditPayload.ts`),
  which is what makes editing a Tailwind element on the canvas possible at all
- Image upload/replace (WS-8.3) — `<img src={heroImg}>` where `heroImg` is a
  local import is now editable: `ParsedNode.assetOrigin` names the import's
  own specifier literal, `setImportSpecifier` rewrites it, `POST
  /admin/api/studio/asset-upload` lands the new file in the workspace
- Structural writeback: **reorder**, **delete**, **insert**, and (W4-1)
  **duplicate**, **wrap** and same-file **reparent**. None of them mints a node:
  each asks the SOURCE to grow the markup — the picker's insert writes the
  element *and* its `import` — and the board re-reads the file, so what lands is
  a real parsed node with a real `rel:line:col`. What cannot be written refuses
  out loud (`refuseStructuralEdit`)
- Creating a new page, in four shapes: the `+` picker (`AddPagePicker.tsx`, one
  popover mounted at the canvas notch, the Explorer *Pages* header and the
  board empty state) offers **Screen**, **Popup**, **Bottom sheet — small** and
  **Bottom sheet — big** under *New page*, and every page already on disk but
  not on this board under *From files* (MCP `studio_create_page` takes the same
  `kind`). Each writes a
  canonical starter component + stylesheet and auto-places its board frame, end
  to end — `server/handlers/studio/pageScaffold.ts` (`createScaffoldedPage`),
  templates in `pageTemplates.ts`, the shared vocabulary in
  `@core/studio-board`'s `pageKinds.ts`. A kind is a creation-time choice only:
  nothing persists it, because the `.tsx` on disk IS the answer
- Storybook CSF import (`W5-3`): a project's `*.stories.{tsx,ts,jsx}` become
  board frames — one per accepted story — on a board of their OWN named
  "Stories", never mixed into the board the author curated. Two accepted
  shapes, read statically and never executed: an args-only CSF3 object
  (synthesized into a real call site and run through `inlineLocalComponents`)
  and a jsx-only function body (the ordinary page pipeline, real writable ids
  in the `.stories.tsx`). Everything else refuses by name — `render-logic`,
  `play-function`, `decorators`, `loaders`, `csf2-storiesof`, … — reported by
  `GET /admin/api/studio/stories`. Measured: **97.8 %** accepted on
  Shopify Polaris, **67.2 %** on Primer React.
  `server/handlers/studio/story{Discovery,Pages}.ts`
- MCP server with a live editor bridge, and ~46 `studio_*` tools in
  `server/ai/mcp/tools/studio/` — including the **visual-audit loop**
  (`studio_export_frames`, `studio_screenshot`, `studio_diff_frames`,
  `studio_compare`, `studio_fidelity_report`, `studio_quality_check`,
  `studio_measure_reference`, `studio_render_reference`), the catalog reads
  (`studio_list_components`, `studio_find_component`), `studio_typecheck`,
  `studio_install_deps` and `studio_create_page`

**Landed in the Figma-feel plan's waves 2 and 3** (2026-09-18 — the plan is closed; its
"Wave 2 — landed" and "Wave 3 — landed" tables map each item to its PR and STATE entry):

- **Every `/admin/api/studio/*` route is declared, not guarded.** One gate at dispatch reads
  `server/handlers/studio/routeCapabilities.ts`: an undeclared path is a 404, a state-changing
  method without an acceptable `Origin` is a 403, then the capability the declaration names.
  Exact entries per verb — no prefix namespaces — and an architecture gate that scans the real
  dispatches, so a new route that forgets its row fails the build.
- **Structural gestures queue, keep their selection, and undo in one step.** A burst of ⌘D
  writes every copy instead of refusing after the first; a write reports the node ids it created
  and relocated, so the new element is selected after the resync; insert, duplicate, wrap, group,
  ungroup, paste, cross-frame move and image drop each record an inverse and take one ⌘Z —
  including the two-file case.
- **⌘G can no longer write invalid markup.** The wrapper tag follows the HTML content model, so
  grouping inline elements inside a `<p>` writes a `<span>`; a wrapper that could not be legal
  anywhere is refused with the container named.
- **A panel that throws takes out that panel only.** `PanelBoundary` wraps every editor panel,
  inspector tab and inspector section with an in-place fallback and a reload button; the canvas,
  the layer tree and the toolbar stay up, and no toast fires.
- **CRLF is handled end to end** — the user's repository (parse and every codemod preserve the
  file's own endings) and every line-wise read of subprocess output.
- **The e2e stack starts itself on Windows** and runs against a throwaway copy of the workspace,
  so a run leaves `git status` clean. The Phase 0 exit dogfood
  (`tests/e2e/studio-feel-phase0.e2e.ts`) is seven cases, all asserting and all green. G8 is
  driven against a real private GitHub repository (`github-sync.e2e.ts`), and one real agent turn
  is wall-clocked (`agent-turn.e2e.ts`); both self-skip and say why when their preconditions are
  absent. **The full cold suite is NOT green** — 64 specs are still untriaged, see the plan's
  "What is still open after three waves".

### What does NOT work today

This list is deliberately short and is the *orientation* set. The granular,
per-track ledger is
[`STUDIO-FIGMA-PARITY-PLAN.md`](STUDIO-FIGMA-PARITY-PLAN.md) **§0a** — it
tracks partially-landed tracks (D2's structural drag work, Track G density,
A7) at a resolution this file should not try to carry.

One update from the style-compile consent work (2026-09-06), itself
superseded by the 2026-09-20 default-tier change: a fresh Tailwind/Sass/
PostCSS import no longer sits silently unstyled at Tier 0 — the board asks
once, on load, via `StyleCompileConsentBanner`
(`src/admin/pages/site/canvas/StyleCompileConsentBanner/`). Since every
project now starts at Tier 2, a fresh import clears that gate before the
banner would ever have a reason to show; the banner is reachable today only
for a project explicitly demoted to `static`.

- **A style change scoped to a real `@media` breakpoint does not reach disk.**
  The codemod and the wire both support it — `insertRule`/`setDeclaration`
  take an `atMedia` query, and the `insert`/`create` payload schemas carry the
  field — but **nothing in the editor ever sets it.** A change made in a real
  user breakpoint context is reported through `collectStyleRuleEdits`'s
  `unwritableContexts` and toasted, never dropped silently. Only the board's
  own synthetic `studio` viewport context writes. Wiring a producer for
  `atMedia` is the whole remaining gap.
- **A style edit on a rule with no honest destination still refuses.** An
  imported rule the parser could not map back to a hand-authored `.css` file
  (Tailwind/Sass/PostCSS output, a non-`.css` module) goes to `unmapped` and is
  toasted. This is correct behaviour, not a bug — but it is why a Tailwind
  project's styles are edited through the `class` path, not the style path.
- ~~Tailwind v3/v4, Sass and PostCSS compilation requires Tier-1 promotion~~ —
  **no longer true as of 2026-09-20.** WS-2.1 built the pipeline
  (`styleCompileTier1.ts`, a capped subprocess), and every project now starts
  at Tier 2 (`DEFAULT_TRUST_TIER`), which already clears the Tier-1 gate
  (`trust !== 'static'`) — a fresh import compiles its styles on the very
  first load, no click required. The refusal
  (`style-toolchain-requires-trust-promotion`) is still real, just reachable
  now only for a project explicitly demoted to `static` via the Live pill's
  "Back to static".
- `.module.scss` / `.module.sass` / `.module.less` are **detected and warned
  about** (`css-module-sass-not-supported`) but not compiled — only plain
  `.module.css` is.
- **CSS-in-JS is detection-only.** `styleToolchainDetect.ts` recognises
  styled-components / emotion / stitches as a dependency and reports it in the
  project profile. Nothing reads or writes those styles.
- **Cross-FILE reparent refuses** — `refuseStructuralEdit` in
  `src/core/page-tree/sourceStructure.ts`. Every structural verb now writes
  within one file (W4-1: duplicate, wrap and same-file reparent joined reorder,
  delete and insert; K3: group and ungroup), but moving markup into another
  module would land it where the values it reads do not exist. A same-file move
  whose subtree captures a binding that is not in scope at the destination
  refuses too, naming the binding.
- **⌘G groups a CONTIGUOUS RUN of siblings, and only that** (K3). One container
  around one span (`wrapJsxElements`); a selection that crosses parents or has
  a gap in it refuses with `multi-select` — "select siblings next to each
  other" — because the wrapper would otherwise land around elements the user
  never selected. ⌘G on one element is the existing single-element `wrap`.
  **The container's tag follows the HTML content model** (`struct-11`,
  `@core/utils/htmlContentModel.ts`): `<span>` in phrasing content, `<div>` in
  flow content, and a REFUSAL (`content-model`) where neither would be valid —
  inside a `<ul>`/`<tr>`/`<select>`, or around an `<li>`/`<td>`/`<figcaption>`.
  It used to be a hard-coded `<div>`, which put a `<div>` inside a `<p>` in a
  real project and made React report a hydration error in the user's own app.
  **⌘⇧G refuses to dissolve a container that is doing anything but holding its
  children** (`has-behaviour`): a handler, a `ref`, a `key`, a spread, or a
  component tag rather than an intrinsic element. Only
  `className`/`style`/`id`/`data-*` are inert enough to drop.
- **JS-driven animation does not freeze.** `CanvasAnimationInjector` handles
  CSS animations/transitions, smooth scroll and media; it makes no attempt to
  intercept `requestAnimationFrame`, so framer-motion and GSAP keep running on
  the canvas.
- **The Assets panel does not list the project's own local components.** It
  lists `registry.list()` — the `alm.*` built-in design system, the `base.*`
  elements, registered `pkg.*` package components — plus saved layouts, Visual
  Components and the icon catalog. A component the user wrote in their own
  `components/` folder (which E1's catalog knows about, and which the *swap*
  picker already uses) still has no card.
- **A package-sourced instance cannot be detached** —
  `detachComponent.ts` refuses with `package-component` and points at the
  extract-a-copy action instead.

Features not yet built are specced in
[`STUDIO-IMPORT-V2-PLAN.md`](STUDIO-IMPORT-V2-PLAN.md). **Read the relevant
workstream section before designing anything.**

---

## 4. Reference docs — read the one that matches your task

These are written **for agents**, are kept short, and are the reason you do not
need to scan the repo.

| Ref | Read it when |
|---|---|
| [`docs/agent-refs/path-index.md`](docs/agent-refs/path-index.md) | **Always.** "Where does X live" — the file map. |
| [`docs/agent-refs/conventions-quickref.md`](docs/agent-refs/conventions-quickref.md) | **Always before writing code.** The rules that have gate tests, compressed. |
| [`docs/agent-refs/studio-pipeline.md`](docs/agent-refs/studio-pipeline.md) | Parsing, evaluation, inlining, locks, writeback, codemods. |
| [`docs/agent-refs/canvas-internals.md`](docs/agent-refs/canvas-internals.md) | Canvas, iframes, injectors, overlays, geometry, events, perf. |
| [`docs/agent-refs/editor-store.md`](docs/agent-refs/editor-store.md) | Zustand slices, tree mutations, undo history, selection. |
| [`docs/agent-refs/handoff-protocol.md`](docs/agent-refs/handoff-protocol.md) | **Always.** How to read/write `STATE.md`. |
| [`docs/agent-refs/glossary.md`](docs/agent-refs/glossary.md) | You hit a term you don't recognise. |

Deeper, human-authored docs (longer, still accurate for Studio):
[`docs/features/studio-import.md`](docs/features/studio-import.md) (578 lines —
the definitive parser contract) and
[`docs/features/canvas-iframe-per-frame.md`](docs/features/canvas-iframe-per-frame.md).

---

## 5. Task routing — which agent, which docs

| Your task touches | Specialist agent | Read first |
|---|---|---|
| ts-morph, JSX parsing, static evaluation, codemods, node ids | `parser-surgeon` | `studio-pipeline.md` |
| iframes, overlays, selection rings, pan/zoom, injectors | `canvas-engineer` | `canvas-internals.md` |
| Zustand slices, mutations, undo, selection state | `store-engineer` | `editor-store.md` |
| Right sidebar, property controls, UI primitives, CSS modules | `panel-designer` | `conventions-quickref.md` §CSS + §UI |
| HTTP routes, handlers, TypeBox boundaries, filesystem safety | `server-engineer` | `conventions-quickref.md` §Boundaries |
| MCP tools, AI tools, agent capabilities | `mcp-tooling` | `docs/features/mcp-connectors.md` |
| Rendering speed, frame budgets, benchmarks | `perf-hunter` | `canvas-internals.md` §Perf |
| Path containment, archives, executing project code | `security-guard` | `conventions-quickref.md` §Safety |
| New tests, fixtures, architecture gates | `test-engineer` | `docs/reference/architecture-tests.md` |

The always-on agents (`studio-scout`, `studio-architect`, `studio-implementer`,
`studio-verifier`, `studio-scribe`) are described in
[`.claude/agents/`](.claude/agents/) and in `CLAUDE.md` §"Agent team".

---

## 6. The traps that catch every new agent

Read this list twice. Each item is a real defect that shipped and had to be fixed.

1. **Do not add a wrapper `<div>` around anything on the canvas.** A wrapper
   breaks `%`/flex height chains and `>`/`+`/`:nth-child` combinators in the
   user's CSS. The canvas DOM must be the DOM React renders. This is why local
   components are spliced in, not nested, and why the design-system host is
   `display: contents`.
2. **A node's id is a source location** (`relFile:line:col`), sometimes composite
   (`callSite~component`) or indexed (`…#2`). Never invent, concatenate, or
   regex an id by hand — use `src/core/page-tree/sourceNodeId.ts`.
3. **`locked` is about structure; `codeProps` is about values.** They are
   different facts. Gating values on the structural lock made 45% of a real
   board uneditable. One predicate decides writability:
   `isPropWritableToSource` in `src/core/page-tree/sourceWritability.ts`.
4. **Never write a resolved value back as a literal.** `title={c.sheetTitle}`
   resolved to `"Where to?"` — writing `"Where to?"` into the JSX deletes the
   binding. Resolved *text* is the one exception, and it writes to the string
   literal's own origin (`textOrigin`), not to the JSX.
5. **A save must only reload when a write actually landed.** Reloading after
   zero writes silently reverts the user's edit ~2 s after they typed it.
6. **Do not put `useMemo` / `useCallback` / `memo` in new code.** The React
   Compiler is on. Three documented exceptions only — see
   `conventions-quickref.md`.
7. **Do not hand-roll `fetch`.** Use `apiRequest` from `@core/http`. Gated.
8. **Do not use hex/rgb colors or `var(--x, fallback)` in CSS modules.** Tokens
   from `src/styles/globals.css` only. Gated.
9. **Do not import `zod`, `lucide-react`, `clsx`, `react-router-dom`, or any
   `@radix-ui/*`.** All banned and gated.
10. **Canvas DOM lives inside iframes.** `document.querySelector('[data-node-id]')`
    returns `null` in tests. Use `src/__tests__/canvas/iframeCanvasQuery.ts`.
11. **Never scan every node of every page inside a Zustand selector.** It runs on
    every store change. The two original offenders are fixed — `PropertiesPanelBody.tsx`'s
    shared-text-origin count and `findNodeById.ts` (`src/admin/pages/site/canvas/
    InPlaceInspector/`) both now read an O(1) index (`_textOriginKeyToCount`/
    `_nodeIdToPageIds`, WS-5.2) instead of scanning. `selectCanvasPageFor`
    (`store.ts`) was the third, and is now fixed on **both** of its lookups:
    the `pageId → Page` scan is memoised per `(site, pageId)`
    (`lookupCanvasPageById`, `parity-01` C1) and the `frameId → axes.locale`
    scan is skipped entirely unless a locale-variant page has actually been
    fetched, then memoised per `(frames, frameId)` (`perf-03`). It is called
    from a **per-node** selector — `NodeRenderer.tsx` calls it twice per
    mounted node (`node`, `mcClassName`) — so on a 40-page/804-live-node board
    that was 36,180 array comparisons per store commit, now 0. **When you add
    a branch to a selector on this path, memoise it in the same change**;
    that is exactly how the `frameId` branch slipped past the first fix.
    `src/__tests__/store/selectCanvasPageFor.test.ts` is the gate.
12. **`studio-workspace/*` is user data.** Never `rm -rf` a project directory, and
    never write outside a workspace root without a containment guard. It is also
    **gitignored** except for a named sample list (`__canonical-fixture/`,
    `test4/`) — see the block in `.gitignore`. Adding a project to that list
    means committing someone's repository into this one.
13. **Do not run browser/e2e tests to validate UI changes.** The human dogfoods
    UI. Run static gates (`bun test`, `bun run build`, `bun run lint`) and hand
    off with a "needs human dogfood" note.
14. **Bun, not Node/npm/pnpm/yarn.** Lockfile is `bun.lock`.
15. **Generated artefacts are compared byte-for-byte, so line endings matter.**
    `.gitattributes` forces LF for `vendor/`, the ALM manifest, the
    studio-runtime bundles and the QuickJS bootstrap. Without it a Windows CRLF
    checkout makes all four `*:check` gates permanently red, and `bun run
    alm:sync` *overwrites* the real design-system manifest with 39 propless
    components — `vendorDocs.ts` matches headings with `/^(#{1,6})\s+(.*)$/`,
    and JavaScript's `.` does not match `\r`. Never add a `-text` or CRLF rule
    for those paths. **The USER's repo is the other half of this**, and it is
    not `.gitattributes`-fixable: `parser-13` put the one seam in
    `EolPreservingFileSystem` (`src/core/page-parser/eolFileSystem.ts`) — every
    disk-backed ts-morph `Project` reads LF-only and writes the file's own
    ending back, and anything reading a user file line-wise uses `splitLines`
    from `@core/utils/lineEndings`, never `text.split('\n')`. See
    `docs/features/studio-import.md` → "Line endings".
16. **A Studio route that is not in the capability table does not exist.**
    Every `/admin/api/studio/*` request passes `gateStudioRequest`
    (`server/handlers/studio/routeGate.ts`) before any sub-router: the path
    must be declared in `server/handlers/studio/routeCapabilities.ts`, a
    state-changing method must pass the CSRF `Origin` check, and the caller
    must hold the capability that declaration names for this method class.
    An undeclared path answers **404** — so adding a route without adding a
    table line produces a dead route, not an open one, and
    `studio-routes-capability-declared.test.ts` fails the build for it. The
    gate resolves the `AuthUser` once and hands it to the session sub-routers
    in `StudioSessionRuntime`; **never add a `requireCapability` call inside a
    Studio sub-router** — a second policy is a policy that drifts. Capabilities
    map by effect: `site.read` to read, `studio.write` for the project's files,
    `studio.run.project` for anything that runs somebody's code (dev server,
    deploy, trust promotion), `site.structure.edit` for git history and the
    GitHub credential, `site.content.edit` for comments and shares.
    `studio.git.write` is NOT a route capability — it gates the agent tool, and
    fusing the two would force a role to hand its agent commit rights just to
    give a human the Version control panel. This closed `sec-05` finding 2; the
    posture is still single-operator by default (the Owner role holds every
    capability in the table), so it is a real gate, not a login flow.
    **Every entry is an EXACT path, per verb** — there are no namespaces, so
    `git/<new-action>` and `dev-server/restart` 404 rather than inheriting
    `site.read` (`sec-16`'s hole, closed by `sec-18`). The one dynamic shape
    is `jobId` on `install`/`deploy`, matched against the UUID those
    registries mint. Adding a verb without a table row fails the build, and so
    does adding a METHOD to an existing route whose table row declares that
    method class `null`. Full write-up: `docs/server.md` → "Per-request
    capability gating on the Studio routes".

---

## 7. Commands

```sh
bun install
bun run dev            # full stack, SQLite at .tmp/dev.db, no external deps
bun run build          # tsc -b && vite build   ← type errors fail this
bun test               # unit + architecture gates
bun run lint           # eslint incl. react-compiler rules
bun test src/__tests__/architecture   # gates only, fast
bun run test:e2e       # Playwright — the fourth gate, for canvas/panel work
bun run bench          # perf benchmarks
bun run bench:studio-board   # canvas budgets, via Playwright's Node runner
```

`bun run dev` preflights itself (`scripts/lib/devPreflight.ts`): it installs when
`node_modules/` is missing a `file:` dependency or `bun.lock` moved, and reports
any stale generated artefact with the `bun run <x>:sync` that fixes it — in the
background, so it never delays the server.

**Verification is an end-of-task gate, not a per-edit ritual.** Run the three
(`build`, `test`, `lint`) once, at the end. Pre-existing failures from parallel
sessions are not yours — triage with `git status` / `git diff` and say so.

**Touched the canvas, a frame, an overlay, geometry, or a panel's height? Run
`bun run test:e2e` too — it is the fourth gate, not an optional extra.**
`standing-02` says why: happy-dom has no layout engine, so a unit test on
those surfaces structurally cannot fail on the thing it is named after (WS-8.2
shipped a real frame-height bug behind a green one). Assert on *computed*
layout — measured rects, `scrollHeight`, computed styles after layout.

The budget slice of that suite — `studio-board-perf`,
`inspector-panel-measurement`, `inspector-height`, `studio-feel` — also runs
in CI as the `e2e-budgets` job (`.github/workflows/ci.yml`). Locally it is
cheaper to run just those four by path than the whole suite.

`bun run test:e2e` **starts its own stack**; do not hand-start one first. It
resets a disposable database, copies `studio-workspace/` to `.tmp/e2e-workspace`
and points the servers there (so a run leaves `git status` clean), and
supervises Vite's boot rather than letting a stuck one expire as a bare
timeout. `E2E_REUSE_SERVER=1` against a stack you started yourself still works
for iteration. All four budget specs measure tracked corpora:
`studio-board-perf.e2e.ts` runs against the committed twelve-frame
`studio-workspace/__board-perf-fixture` (nine frames is the floor — below that
the mount pool keeps every frame mounted and there is no mount to measure), and
`studio-feel.e2e.ts` against `studio-workspace/test4`.

### What watches what in `bun run dev`

The two dev processes watch on opposite principles. Knowing which is which is
the difference between debugging a phantom and debugging a real restart.

| Process | Watcher | Scope | Reacts to a `studio-workspace/` write? |
|---|---|---|---|
| cms (`bun --watch server/index.ts`) | Bun, **module-graph**, per file | exactly the 630 modules `server/index.ts` transitively imports — 567 `server/`, 55 `src/modules/base`, 3 `src/core/data`, 3 `src/modules/studio`, 2 `src/core/persistence` | **No.** Nothing under `studio-workspace/`, `uploads/`, `.tmp/`, `.data/` or `dist/` is in that graph, and nothing in it is a test file. |
| vite | chokidar, **directory tree**, rooted at the repo root | everything under the root except `server.watch.ignored` (`.tmp`, `uploads`, `dist`, `studio-workspace`) and Vite's own defaults | **No — since the `studio-workspace` ignore was added.** Before that it did: Vite full-reloads on any watched `.html` change that maps to no module, and every React app Studio imports ships a root `index.html`. |

Measured 2026-09-17 (`dev-04`), not inferred. Bun's `--watch` restarts **only**
for files in the entry's module graph: a new file in a sibling directory, a
modified file in a sibling directory, 300 files written into a `studio-workspace/`
under the cwd, and an unimported file dropped into the very directory holding an
imported module all produced zero restarts; touching the imported module
restarted every time. Bun holds no OS handle on a directory containing no graph
module, so the Windows `EBUSY` watcher panic in `server-14` cannot come from a
workspace write.

Consequences:

- **Do not replace `--watch` with a hand-maintained directory allowlist.** Any
  such list drifts from the real graph the moment an import changes — a plausible
  guess at it (`server/**`, `src/core/**`, `vendor/**`) was already wrong in two
  directions: it misses all 55 `src/modules/base` modules and watches `vendor/`,
  of which the server imports none.
- **When you add a runtime-written directory at the repo root, add it to
  `vite.config.ts` `server.watch.ignored`** in the same change.
  `src/__tests__/devWorkflow.test.ts` is the gate.
- `bun run dev:server` runs the server alone, same watcher.

---

## 8. Definition of done for any change here

- [ ] The change is in the right layer (checked against `path-index.md`).
- [ ] Every new untyped boundary validates with TypeBox.
- [ ] No wrapper elements added to canvas DOM; no new manual memoization.
- [ ] Anything replaced was **deleted** — no old-and-new side by side, no shims.
- [ ] Docs updated in the same change (`docs/features/*` or `docs/agent-refs/*`).
- [ ] If a structural rule moved, its gate test in `src/__tests__/architecture/` moved too.
- [ ] `bun run build && bun test && bun run lint` pass for the files you touched.
- [ ] If the change touched canvas / frames / overlays / geometry / panel height,
      `bun run test:e2e` ran too (`standing-02` — happy-dom cannot answer those).
- [ ] **`STATE.md` updated with a handoff entry** — see `handoff-protocol.md`.
