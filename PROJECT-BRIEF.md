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
        │  reorders, reparents, duplicates, wraps or deletes an element
        ▼
  Typed StudioEdit batch              POST /admin/api/studio/save
        │
        ├──▶ AST codemods             src/core/ast-codemods/
        │    rewrite the user's .tsx  (setJsxProp, setJsxText, setJsxStyle,
        │                              setJsxClassName, setStringLiteral,
        │                              setJsxTagName, insertJsxElement,
        │                              moveJsxElement, deleteJsxElement,
        │                              duplicateJsxElement, wrapJsxElement)
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
   it". *The trust-tier relaxation has now shipped, and it is narrow:* at Tier 0
   (`static`, the default) nothing of the user's ever runs. Promoting to Tier 1
   (`render-packages`) buys exactly two things — the workspace's own style
   toolchain compiles in a capped subprocess (`styleCompileTier1.ts`) and its
   package components are bundled and rendered in the canvas
   (`componentBundle.ts`). **The parse itself never executes anything at any
   tier**, and Tier 2 (`run-project`) is a defined value that no gate yet
   distinguishes from Tier 1 — both read as `trust !== 'static'`.
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
| Live coordination | [`STATE.md`](STATE.md) — **read at the start of every task, write at the end** |
| Entry point in the app | `/admin/site` — `src/admin/router.tsx` renders the studio editor there unconditionally; there is no mode flag and no `?studio` param. Which project is open comes from `src/admin/pages/site/studio/studioWorkspaceDir.ts` (localStorage-sticky, set by the Overview launcher; the server falls back to the first project on disk) |
| Test projects on disk | `studio-workspace/` — `test`, `esim-journey`, `my-workspace`, `untitled*` |

### What works today (do not rebuild)

- GitHub zipball import with path-traversal / zip-bomb guards
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
  is promoted past Tier 0 trust — `server/handlers/studio/styleCompile.ts`
- Vendor package CSS (WS-2.3): a bare-specifier `.css` import
  (`import '@acme/ui/dist/style.css'`) is resolved against the project's own
  `node_modules` and injected into the canvas iframe as a read-only
  `@layer vendor` bucket (`ProjectCssInjector`), ordered below the editable
  `@layer user-authored` class registry — Tier 0 safe, no trust gate
- **Trust tiers.** `.studio/meta.json`'s `trust` field has three values —
  `static` (Tier 0, the never-auto-promoted default), `render-packages`
  (Tier 1), `run-project` (Tier 2) — read/written by
  `server/handlers/studio/trustTier.ts` and driven from the client by
  `promoteProjectToTier1` (`studio/studioProjectTrust.ts`). Promotion is an
  explicit user click, never a side effect of loading a page.
- npm package components (`pkg-01`/`pkg-02`/E4): manifest → bundle → register
  → render is wired end to end for **any** installed package, not just
  `@alm-design/design-system` — `server/handlers/studio/componentBundle.ts`
  (`tryServeStudioComponentBundle`),
  `src/admin/pages/site/studio/registerProjectModules.ts`
  (`useRegisterProjectModules`). Registration fires on every project-dir /
  trust-tier transition and is **not** gated on the board already containing a
  `pkg.*` node, so a package with zero call sites in the imported source is
  still draggable from the picker. Rendering stays gated on trust tier ≥ 1 —
  Tier 0 gets `PackageComponentPlaceholder`'s "promote this project" surface
  and the picker's own "N components need this project promoted" notice, never
  a silent empty palette, and never a fetch or an execution.
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
    yet, written into the project's one editable stylesheet (`insertRule`).
    `resolveCssInsertDestination` refuses by name when the destination is
    ambiguous rather than guessing.
  - `op: 'create'` — no editable stylesheet exists at all: the server invents
    one co-located with the page, wires the page's `import`
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
- Creating a new page, in four shapes: the `+` button (`NewPageButton.tsx`)
  offers **Screen**, **Popup**, **Bottom sheet — small** and **Bottom sheet —
  big** (MCP `studio_create_page` takes the same `kind`). Each writes a
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

### What does NOT work today

This list is deliberately short and is the *orientation* set. The granular,
per-track ledger is
[`STUDIO-FIGMA-PARITY-PLAN.md`](STUDIO-FIGMA-PARITY-PLAN.md) **§0a** — it
tracks partially-landed tracks (D2's structural drag work, Track G density,
A7) at a resolution this file should not try to carry.

One update from the style-compile consent work (2026-09-06): a fresh
Tailwind/Sass/PostCSS import no longer sits silently unstyled at Tier 0 —
the board asks once, on load, via `StyleCompileConsentBanner`
(`src/admin/pages/site/canvas/StyleCompileConsentBanner/`); promotion to
Tier 1 remains an explicit user action through the existing trust-tier route.

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
- **Tailwind v3/v4, Sass and PostCSS compilation requires Tier-1 promotion.**
  WS-2.1 built the pipeline and it runs in a capped subprocess
  (`styleCompileTier1.ts`), but a fresh import sits at Tier 0 and never
  auto-runs it, so a newly imported Tailwind/Sass project renders **unstyled**
  until a human clicks promote. The refusal is explicit
  (`style-toolchain-requires-trust-promotion`), not silent.
- `.module.scss` / `.module.sass` / `.module.less` are **detected and warned
  about** (`css-module-sass-not-supported`) but not compiled — only plain
  `.module.css` is.
- **CSS-in-JS is detection-only.** `styleToolchainDetect.ts` recognises
  styled-components / emotion / stitches as a dependency and reports it in the
  project profile. Nothing reads or writes those styles.
- **Cross-FILE reparent refuses** — `refuseStructuralEdit` in
  `src/core/page-tree/sourceStructure.ts`. Every structural verb now writes
  within one file (W4-1: duplicate, wrap and same-file reparent joined reorder,
  delete and insert), but moving markup into another module would land it where
  the values it reads do not exist. A same-file move whose subtree captures a
  binding that is not in scope at the destination refuses too, naming the
  binding.
- **JS-driven animation does not freeze.** `CanvasAnimationInjector` handles
  CSS animations/transitions, smooth scroll and media; it makes no attempt to
  intercept `requestAnimationFrame`, so framer-motion and GSAP keep running on
  the canvas.
- **The insert picker is not seeded from the component catalog.**
  `ModuleInserterDialog.tsx` / `ModulePicker.tsx` list `registry.list()` — the
  module registry, i.e. first-party modules plus registered package
  components. The project's own local components (which E1's catalog knows
  about, and which the *swap* picker already uses) have no picker rows.
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
    never write outside a workspace root without a containment guard.
13. **Do not run browser/e2e tests to validate UI changes.** The human dogfoods
    UI. Run static gates (`bun test`, `bun run build`, `bun run lint`) and hand
    off with a "needs human dogfood" note.
14. **Bun, not Node/npm/pnpm/yarn.** Lockfile is `bun.lock`.

---

## 7. Commands

```sh
bun install
bun run dev            # full stack, SQLite at .tmp/dev.db, no external deps
bun run build          # tsc -b && vite build   ← type errors fail this
bun test               # unit + architecture gates
bun run lint           # eslint incl. react-compiler rules
bun test src/__tests__/architecture   # gates only, fast
bun run bench          # perf benchmarks
```

**Verification is an end-of-task gate, not a per-edit ritual.** Run the three
(`build`, `test`, `lint`) once, at the end. Pre-existing failures from parallel
sessions are not yours — triage with `git status` / `git diff` and say so.

---

## 8. Definition of done for any change here

- [ ] The change is in the right layer (checked against `path-index.md`).
- [ ] Every new untyped boundary validates with TypeBox.
- [ ] No wrapper elements added to canvas DOM; no new manual memoization.
- [ ] Anything replaced was **deleted** — no old-and-new side by side, no shims.
- [ ] Docs updated in the same change (`docs/features/*` or `docs/agent-refs/*`).
- [ ] If a structural rule moved, its gate test in `src/__tests__/architecture/` moved too.
- [ ] `bun run build && bun test && bun run lint` pass for the files you touched.
- [ ] **`STATE.md` updated with a handoff entry** — see `handoff-protocol.md`.
