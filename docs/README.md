# Studio docs
> **Purpose:** the doc map: every maintained doc, one row, with what it is for, when to read it and how far to trust it · **Read when:** after `PROJECT-BRIEF.md`, `STATE.md` and `ROADMAP.md`, to find the doc for your task · **Trust:** index · **Owner:** studio-scribe · **Verified:** 2026-09-23

One row per doc. This page holds no orientation of its own: what Studio is, what works and the traps are in [`PROJECT-BRIEF.md`](../PROJECT-BRIEF.md); the rules are in [`CLAUDE.md`](../CLAUDE.md); how docs are written is in [`CONVENTIONS.md`](CONVENTIONS.md).

---

## TL;DR

- **Reading order for an agent:** [`PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) → [`STATE.md`](../STATE.md) → [`ROADMAP.md`](../ROADMAP.md) → this map → the `agent-refs/` page the BRIEF's routing table names for your task.
- **Trust** says how far to rely on a doc: `rule` (gated constraints), `current` (describes the tree as it is), `current-cms` (accurate, but for the dormant CMS half), `live` (changes daily), `index` (a map), `historical` (a dated record: never act on it). Every doc's line 2 carries the same header, including an **Owner** and the date it was last **Verified** against the code (`not yet` means nobody has checked it since headers were added).
- **Where a doc conflicts with `PROJECT-BRIEF.md`, the brief wins.** Where either conflicts with the code, the code wins: fix the doc.

## Entry points (repo root)

| Doc | Purpose | Read when | Trust |
|---|---|---|---|
| [`PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) | orientation: what Studio is, what works and what does not, the traps, and which agent and docs a task needs | first, before any task | current |
| [`CLAUDE.md`](../CLAUDE.md) | the rule book: every constraint a change must satisfy, each with its gate | always, before any change | rule |
| [`STATE.md`](../STATE.md) | live coordination only: what is in flight, what is blocked, what a human still owes | before any task; write at every stage boundary | live |
| [`ROADMAP.md`](../ROADMAP.md) | the single living plan: what to build next, in what order, by whom, and the open questions for the owner | before designing any change, to find its bundle | live |
| [`AGENTS.md`](../AGENTS.md) | the pointer for non-Claude coding agents (Codex and others) | you are not Claude Code and just opened this repository | rule |
| [`README.md`](../README.md) | what Studio is, quick start and commands, for humans | you are a person setting Studio up or looking around | current |

## System docs

| Doc | Purpose | Read when | Trust |
|---|---|---|---|
| [`architecture.md`](architecture.md) | the system overview: processes, folders, layers, request lifecycle, data model, and the dormant CMS half | orienting in an unfamiliar layer, or deciding where new code belongs | current |
| [`server.md`](server.md) | the server in depth: boot, router, handlers, auth, database, publishing, plugin runtime, the single-operator posture | adding or changing an HTTP route or server subsystem | current |
| [`editor.md`](editor.md) | the admin shell and visual editor in depth: routing, store, canvas, sidebars, panels | changing the editor UI or its store wiring | current |
| [`design.md`](design.md) | the visual design system: principles, tokens, surfaces, primitives and the inspector in design language | changing any admin UI styling | current |
| [`decisions.md`](decisions.md) | every settled owner decision, with its date, source and consequence | before re-opening a product question, or when a work order cites a decision id (OD-n, D-n, FEEL §6.n, BUILTIN §0.n) | current |
| [`CONVENTIONS.md`](CONVENTIONS.md) | how docs in this repo are written, headed, placed and retired | before adding, moving or rewriting any doc | rule |

## Agent references

Compressed, agent-facing summaries. Start here for any task; follow their links for depth.

| Doc | Purpose | Read when | Trust |
|---|---|---|---|
| [`agent-refs/canvas-internals.md`](agent-refs/canvas-internals.md) | how the canvas works: iframes, injectors, overlays, geometry, events, bridge frames, perf | touching the canvas, a frame, an overlay or pointer handling | current |
| [`agent-refs/conventions-quickref.md`](agent-refs/conventions-quickref.md) | every gated rule, compressed, plus the test traps | always, before writing code | rule |
| [`agent-refs/editor-store.md`](agent-refs/editor-store.md) | the Zustand editor store: slices, tree mutations, undo history, selection | touching store state, mutations or undo | current |
| [`agent-refs/glossary.md`](agent-refs/glossary.md) | the project vocabulary, one entry per term | you meet a term you do not recognise | current |
| [`agent-refs/handoff-protocol.md`](agent-refs/handoff-protocol.md) | how `STATE.md`, its archive and a PR's handoff are written, so work survives the session that did it | before writing or archiving a `STATE.md` entry, and at every stage boundary | rule |
| [`agent-refs/path-index.md`](agent-refs/path-index.md) | where every file lives, marked Studio, shared or dormant CMS | always: "where does X live?" | index |
| [`agent-refs/studio-pipeline.md`](agent-refs/studio-pipeline.md) | the repo-to-board pipeline: parse, evaluate, inline, lock, write back | touching parsing, evaluation, node ids or codemods | current |

## Features: Studio

| Doc | Purpose | Read when | Trust |
|---|---|---|---|
| [`features/agent.md`](features/agent.md) | the in-canvas AI agent: providers, the tool loop, the Studio tool family, refusals | touching the agent, its prompt or its tools | current |
| [`features/auth-and-access.md`](features/auth-and-access.md) | sessions, MFA, step-up, lockout, CSRF, capabilities and roles | touching sign-in, sessions or capability checks | current |
| [`features/board-annotations.md`](features/board-annotations.md) | sticky notes and rich-text doc cards on the board | touching board notes or doc cards | current |
| [`features/canvas-iframe-per-frame.md`](features/canvas-iframe-per-frame.md) | how a static (portal) frame renders in its own iframe | touching frame rendering, injectors or cross-realm events | current |
| [`features/canvas-rulers-and-guides.md`](features/canvas-rulers-and-guides.md) | canvas rulers, persisted guides and the useCanvas() transform API | touching rulers, guides or canvas transforms | current |
| [`features/design-system.md`](features/design-system.md) | how Studio's own design system gets from `vendor/` onto the canvas, into a user's project, and into the Assets panel | touching `vendor/alm-design-system/`, the `alm.*` modules, a project's `design-system/` folder, the Assets panel or Add page | current |
| [`features/editor-preferences.md`](features/editor-preferences.md) | catalog-driven editor preferences | adding or reading an editor preference | current |
| [`features/inspector.md`](features/inspector.md) | the properties panel's density contract: laws, goals G1–G12, the field model, the height gate | touching the inspector, or reading a "Law n" / "§4 Gn" code comment | current |
| [`features/live-canvas.md`](features/live-canvas.md) | how a board frame shows the user's real running app: the dev server, the live origin, the in-frame runtime and the frame adapter | touching a live frame, `devServer.ts`, `server/liveOrigin.ts`, `@core/studio-runtime`, or any canvas code that talks to a frame's document | current |
| [`features/mcp-connectors.md`](features/mcp-connectors.md) | Studio as an MCP server for external agents: connectors, tokens, the live bridge | touching the MCP endpoint, a connector or a studio_* tool | current |
| [`features/modules.md`](features/modules.md) | the module engine, the base and alm.* packs, and the built-in design system manifest | adding or changing a module | current |
| [`features/prototype-export.md`](features/prototype-export.md) | the runnable preview shell Studio scaffolds into a project, and "Download the code" | touching the generated prototype shell or the download | current |
| [`features/spotlight.md`](features/spotlight.md) | the ⌘K command palette | adding a command or a palette provider | current |
| [`features/studio-comments.md`](features/studio-comments.md) | review threads pinned to the board and the agent loop over them | touching comments or the anchor model | current |
| [`features/studio-deploy.md`](features/studio-deploy.md) | preview deploys through the project's own Vercel/Netlify CLI | touching deploys | current |
| [`features/studio-git.md`](features/studio-git.md) | version control against the project's own repository, GitHub sign-in, the agent commit tool | touching the Git panel or git routes | current |
| [`features/studio-import.md`](features/studio-import.md) | the parser contract: how a React repository becomes a board | touching parsing, evaluation, inlining or CSS import | current |
| [`features/studio-prototype.md`](features/studio-prototype.md) | prototype mode: authored links and the flow map read from the project's own navigation code | touching prototype links, flows or playback | current |
| [`features/studio-share.md`](features/studio-share.md) | read-only share links at /share/<token> | touching share links | current |
| [`features/trust-tiers.md`](features/trust-tiers.md) | what each per-project trust tier lets Studio run, where it is stored, and which routes check it | touching anything that runs a user's own code (style compile, package bundle, dev server, deploy, `studio_render_reference`), or changing a default | current |

## Features: the dormant CMS half

Accurate, and much of it load-bearing for Studio under a CMS-shaped name (see [`architecture.md`](architecture.md) → "The dormant CMS half: four traps"). Do not build new Studio features on these concepts.

| Doc | Purpose | Read when | Trust |
|---|---|---|---|
| [`features/html-import.md`](features/html-import.md) | HTML string to page-tree fragment (paste HTML, the agent insertHtml tool) | touching HTML paste or HTML import | current-cms |
| [`features/plugin-system.md`](features/plugin-system.md) | the inherited plugin system: package shape, sandbox, SDK, permissions | touching plugins or the QuickJS sandbox | current-cms |
| [`features/publisher.md`](features/publisher.md) | the page-tree-to-HTML/CSS renderer (load-bearing) and the CMS publishing pipeline around it | touching src/core/publisher/ or server/publish/ | current-cms |
| [`features/site-import.md`](features/site-import.md) | the static-site importer and the CMS bundle import in the same modal | touching SiteImportModal or @core/siteImport | current-cms |
| [`features/site-shell.md`](features/site-shell.md) | the persisted CMS site config: breakpoints, classes, files, dependencies | touching the DB site row | current-cms |
| [`features/visual-components.md`](features/visual-components.md) | Visual Components: slots, params, instantiation, the recursion guard | touching Visual Components or slots | current-cms |

## Reference

| Doc | Purpose | Read when | Trust |
|---|---|---|---|
| [`reference/admin-router.md`](reference/admin-router.md) | the in-house admin router | adding admin navigation | current |
| [`reference/architecture-tests.md`](reference/architecture-tests.md) | the catalogue of every architecture gate test | a gate fails, or you change a structural rule | current |
| [`reference/canonical-jsx.md`](reference/canonical-jsx.md) | the JSX subset Studio reads and writes losslessly, and its validator | authoring or checking canonical screens | current |
| [`reference/canvas-dnd.md`](reference/canvas-dnd.md) | drag and drop in the editor: mechanisms, drop resolution, the D2 target architecture | touching any drag, drop or insert-at-a-point gesture | current |
| [`reference/capabilities.md`](reference/capabilities.md) | every capability string, its default roles, and how to add one | gating a route or tool on a capability | current |
| [`reference/css-class-registry.md`](reference/css-class-registry.md) | the site style-rule registry (site.styleRules) | touching style rules or class CSS | current-cms |
| [`reference/database-dialects.md`](reference/database-dialects.md) | running the same repositories on Postgres and SQLite | writing SQL or a migration | current-cms |
| [`reference/design-tokens.md`](reference/design-tokens.md) | the complete catalogue of CSS tokens in globals.css | picking or adding a token | current |
| [`reference/editor-history.md`](reference/editor-history.md) | patch-based undo/redo: HistoryEntry, the mutate helpers, coalescing | touching undo, redo or history coalescing | current |
| [`reference/error-boundaries.md`](reference/error-boundaries.md) | where error boundaries live and how errors are reported | adding a boundary or an error surface | current |
| [`reference/module-engine.md`](reference/module-engine.md) | adding a first-party module | defining a new module | current |
| [`reference/page-tree.md`](reference/page-tree.md) | the NodeTree primitive and its tree-agnostic mutations | mutating a page or component tree | current |
| [`reference/persistence-keys.md`](reference/persistence-keys.md) | every localStorage, sessionStorage and server preference key | persisting a client preference | current |
| [`reference/react-compiler.md`](reference/react-compiler.md) | the React Compiler memoization rule and its three exceptions | tempted to write useMemo, useCallback or memo | rule |
| [`reference/typebox-patterns.md`](reference/typebox-patterns.md) | validating every untyped boundary with TypeBox | parsing JSON, a request body or a response | rule |
| [`reference/ui-primitives.md`](reference/ui-primitives.md) | the shared UI primitives and when to use each | building any admin UI control | current |
| [`reference/use-async-resource.md`](reference/use-async-resource.md) | the canonical single-resource async load hook | loading data in an admin screen | current |

## Operations and testing

| Doc | Purpose | Read when | Trust |
|---|---|---|---|
| [`deployment/README.md`](deployment/README.md) | the deployment targets, their variables and what must persist | deploying or operating a Studio server | current |
| [`deployment/backup-restore.md`](deployment/backup-restore.md) | what to back up and how to restore it: the workspace, the database, uploads | backing up, restoring or migrating an install | current |
| [`deployment/docker-image.md`](deployment/docker-image.md) | the production Docker image outside the VPS Compose files | building or running the image yourself | current-cms |
| [`deployment/railway.md`](deployment/railway.md) | the Railway image-source configuration | deploying on Railway | current-cms |
| [`deployment/release-workflow.md`](deployment/release-workflow.md) | publishing Studio Docker images (maintainers) | cutting a release | current-cms |
| [`deployment/render.md`](deployment/render.md) | the Render Blueprint configuration | deploying on Render | current-cms |
| [`deployment/tls-caddy.md`](deployment/tls-caddy.md) | TLS termination with the Caddy override | putting an install behind a real domain | current-cms |
| [`deployment/vps.md`](deployment/vps.md) | Docker Compose installs on a single VPS | installing on a VPS | current-cms |
| [`e2e/README.md`](e2e/README.md) | the Playwright e2e suite: the fourth gate, the disposable stack, authoring rules, coverage | writing or running an e2e spec | current |
| [`e2e/protocol.md`](e2e/protocol.md) | how an agent runs a user-facing browser audit | running a manual browser audit | current |
| [`e2e/run-log-template.md`](e2e/run-log-template.md) | the template for a browser-audit run log | recording a browser audit | current |
| [`e2e/dogfood-backlog.md`](e2e/dogfood-backlog.md) | every human dogfood script owed for work that landed without a browser pass | running a dogfood session, or archiving a `STATE.md` entry whose "Human action needed" block is a script | live |
| [`scripts/bench/README.md`](../scripts/bench/README.md) | the benchmark harness: what each bench measures and its budgets | measuring or gating performance | current |

## History: read for rationale, never act on it

| Path | What it holds | Trust |
|---|---|---|
| [`archive/`](archive/README.md) | Finished plans (`plans/`, filenames unchanged so code citations still resolve), the 2026-08-07 parity handoffs, one-off e2e records | historical |
| [`state-archive/`](state-archive/INDEX.md) | Every `STATE.md` entry that left the file, verbatim, one file per month; `INDEX.md` lists them all | historical |
| [`audits/2026-09-23-studio-audit/`](audits/2026-09-23-studio-audit/README.md) | The ten audits behind `ROADMAP.md`; every bundle's finding IDs resolve here | historical |
| [`audits/2026-08-06/`](audits/2026-08-06/) | The twelve audits behind the finished parity plan | historical |
| [`audits/penpot-inspector-baseline/`](audits/penpot-inspector-baseline/README.md) | Measured Penpot inspector geometry; `measurement.test.ts` and the inspector source cite it as evidence | historical |
| [`audits/2026-09-13-live-frame-memory-baseline.md`](audits/2026-09-13-live-frame-memory-baseline.md) | A placeholder for the live-frame memory baseline, not yet measured | historical |
| [`assets/`](assets/) | Images the pages above reference | — |

## Related

- [`CONVENTIONS.md`](CONVENTIONS.md): the header line, trust levels and doc types this map uses
- [`agent-refs/path-index.md`](agent-refs/path-index.md): the same kind of map, for code
- Gate tests: `src/__tests__/architecture/doc-headers.test.ts`
