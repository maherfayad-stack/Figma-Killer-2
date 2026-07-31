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
        │  user edits a prop / text / style / tag
        ▼
  Typed StudioEdit batch              POST /admin/api/studio/save
        │
        ▼
  AST codemods                        src/core/ast-codemods/
  rewrite the user's .tsx             (setJsxProp, setJsxText, setJsxStyle,
                                       setStringLiteral, setJsxTagName)
```

**Two invariants that explain 80% of the code's weirdness:**

1. **Parse, never execute.** No component is rendered server-side, no hook is
   called. Every value on the canvas was read out of the AST. This is why there
   is a hand-written bounded evaluator with explicit tiers instead of "just run
   it". *(The V2 roadmap proposes relaxing this behind an explicit trust tier —
   see §4. Until that ships, the invariant holds absolutely.)*
2. **A write must have exactly one honest target.** Every lock, every
   `codeProps` entry, every refusal exists because writing an edit there would
   destroy a binding, change N places at once, or write to a file that does not
   exist. When you are tempted to "just make it editable", you are almost
   certainly about to corrupt a user's repo.

---

## 3. Where you are right now

| | |
|---|---|
| Branch | `feat/alm-figma-killer-studio-shell` |
| Base branch for PRs | `main` (protected — never push to it) |
| Roadmap | [`STUDIO-IMPORT-V2-PLAN.md`](STUDIO-IMPORT-V2-PLAN.md) — the plan for everything not yet built |
| Live coordination | [`STATE.md`](STATE.md) — **read at the start of every task, write at the end** |
| Entry point in the app | `/admin/site?studio` (`src/admin/pages/site/studio/studioMode.ts` — sticky in localStorage) |
| Test projects on disk | `studio-workspace/` — `test`, `esim-journey`, `my-workspace`, `untitled*` |

### What works today (do not rebuild)

- GitHub zipball import with path-traversal / zip-bomb guards
- Multi-file page discovery + `.studio/meta.json` (`displayName`, `pagesDir`, `previewLocale`)
- ts-morph parse, local-component inlining through barrels, tsconfig `paths` aliases
- Static value resolution Tiers A/B/C, `.map` expansion, multi-return rendering
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
- Board frames with per-frame x/y/w/h, sticky notes, doc cards, frame virtualization
- iframe-per-frame canvas with cascade-layered CSS injection
- CSS animations freeze (play once, hold last keyframe)
- Image upload/replace (WS-8.3) — `<img src={heroImg}>` where `heroImg` is a
  local import is now editable: `ParsedNode.assetOrigin` names the import's
  own specifier literal, `setImportSpecifier` rewrites it, `POST
  /admin/api/studio/asset-upload` lands the new file in the workspace
- MCP server with a live editor bridge + `studio_import_project`

### What does NOT work today (the roadmap)

CSS Modules (`.module.css` only — Sass/Less module variants are undetected),
Tailwind v3/v4 and Sass/PostCSS compilation (WS-2.1 built the pipeline, but it
requires the project promoted past Tier 0 trust — a fresh import never
auto-runs it), CSS-in-JS ·
npm package components (only the hardcoded `@alm-design/design-system`) ·
component instances, swap, detach · scroll unrolling · CSS
write-back to disk · frame multi-select and bulk actions · Figma-grade
inspector interactions · visual-audit MCP tools.

All of it is specced in [`STUDIO-IMPORT-V2-PLAN.md`](STUDIO-IMPORT-V2-PLAN.md).
**Read the relevant workstream section before designing anything.**

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
    returns `null` in tests. Use `src/admin/pages/site/canvas/__tests__/iframeCanvasQuery.ts`.
11. **Never scan every node of every page inside a Zustand selector.** It runs on
    every store change. Two such scans exist today and are a known perf bug.
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
