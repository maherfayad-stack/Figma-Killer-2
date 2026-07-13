# Canvas-Code Studio — Multi-Phase Agent Playbook

**Product codename:** `canvas-code-studio` (rename freely)
**Author context:** Plan produced 2026-07-13 from analysis of `penpot/penpot` (GitHub, main branch, sparse clone of `frontend/src/app/main/ui`) plus tldraw SDK architecture.
**Audience:** Claude Code agents. Each phase contains ready-to-paste agent prompts, file paths, acceptance criteria, and pitfalls.

---

## 0. Product Definition

A Figma/Penpot-class design tool where:

1. **Projects contain files, like Penpot.** Dashboard → projects → files.
2. **Each file IS a folder containing a fully functional React app.** Not a proprietary document that exports code — the folder is the document.
3. **A `design-system/` folder holds tokens + components.** Editing anything there (in code or via UI) propagates to every file/canvas that consumes it.
4. **Editing on the infinite canvas writes directly into the React app folder** (AST codemods on real source files).
5. **Editing code in the folder updates the canvas live** (Vite HMR into canvas frames).

### The One Rule that governs every decision

> **The file system is the single source of truth. There is NO separate design document format.**
> The canvas is a *live renderer + structured editor* over real source code.
> Any feature that requires a second persistent scene model is rejected or redesigned.

Corollaries:

- "Save" does not exist as a concept for design content; writing files IS saving. Git is the version history.
- The only editor-owned persistent data is **spatial metadata** (frame x/y on infinite canvas, zoom bookmarks, comments anchors) stored in `.studio/canvas.json` inside each file-folder. This file never affects app runtime.
- Sync is not a feature — it is the absence of two models. Never reintroduce a translation layer.

### Editable-surface contract (critical, prevents the unsolvable problem)

Two-way editing of *arbitrary* code is unsolved industry-wide. We constrain the surface:

| Code construct | Canvas behavior |
|---|---|
| Static JSX elements & component instances | Fully editable: select, move (within layout), reorder, insert, delete, wrap |
| Literal props (string/number/bool/enum) | Editable via inspector panel |
| Tailwind classes / style props | Editable via design panel (visual controls ↔ class list) |
| Design-token references | Editable via token picker |
| JSX inside `.map()`, conditionals, render props | Rendered live, selectable, **locked** (read-only badge: "dynamic — edit in code") |
| Hooks, handlers, business logic | Invisible to canvas, never touched |
| Spread props `{...rest}` | Rendered, prop editing disabled on spread keys |

Agents MUST enforce this contract in every phase. It is the line between "shippable" and "research project."

---

## 1. System Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  STUDIO APP (Next.js or Vite SPA, TypeScript, all plain React) │
│                                                                │
│  Dashboard (projects/files)      Workspace (per file)          │
│                                  ┌──────────────────────────┐  │
│                                  │ tldraw infinite canvas   │  │
│                                  │  └─ FrameShape (custom)  │  │
│                                  │      └─ <iframe> → Vite  │  │
│                                  │         dev server (HMR) │  │
│                                  │  overlay: selection,     │  │
│                                  │  handles, badges         │  │
│                                  └──────────────────────────┘  │
│  Left sidebar: pages/layers(=JSX tree)/assets/tokens           │
│  Right sidebar: design(inspector)/interactions/inspect(code)   │
└───────────────▲───────────────────────────▲────────────────────┘
                │ WebSocket (ops + events)   │ postMessage (hit-test,
                │                            │ rect reports, hover)
┌───────────────┴────────────────────────────┴───────────────────┐
│  SYNC DAEMON (Node, per open project)                          │
│  - manages Vite dev server per file-folder                     │
│  - AST engine: ts-morph codemods (canvas ops → file writes)    │
│  - FS watcher (chokidar): code edits → invalidate → HMR        │
│  - design-system watcher: token/component change → broadcast   │
│  - git integration: auto-commit checkpoints, branch/PR ops     │
└───────────────▲────────────────────────────────────────────────┘
                │
┌───────────────┴────────────────────────────────────────────────┐
│  FILE SYSTEM (the actual document)                              │
│  project-root/                                                  │
│    design-system/                                               │
│      tokens/tokens.json          (W3C DTCG format)              │
│      components/Button/Button.tsx, Button.stories.tsx, meta.ts  │
│      index.ts                                                   │
│    files/                                                       │
│      landing-page/               ← one "Penpot file"            │
│        src/frames/Hero.tsx       ← one frame on canvas          │
│        src/frames/Pricing.tsx                                   │
│        src/App.tsx  vite.config.ts  package.json                │
│        .studio/canvas.json       ← spatial metadata only        │
│      checkout-flow/                                             │
│        ...                                                      │
└─────────────────────────────────────────────────────────────────┘
Backend (Phase 6): Postgres + auth/teams/projects registry,
git remote hosting, thumbnail storage. Local-first before that.
```

### The edit loop (single loop — memorize this)

```
Canvas gesture → op {nodeUid, type, payload}
  → sync daemon → ts-morph codemod → write .tsx file
  → Vite HMR → iframe re-renders → overlay re-measures
Code edit in IDE → FS watcher → Vite HMR → same path from step 4
```

Code path and canvas path converge on the file. Neither can drift because neither holds independent state.

### Node addressing: how canvas knows which JSX node is which

Custom Vite/Babel plugin (`@studio/vite-plugin-source-uid`) runs only in studio dev mode:

- For every JSX element in source, inject `data-uid="<relPath>:<astNodePath>"` (e.g. `src/frames/Hero.tsx:JSXElement[3].children[1]`) — stable across HMR because derived from AST position, remapped after every codemod.
- Elements originating inside `.map()`/conditionals get `data-dynamic="true"`.
- Component instances additionally get `data-component="Button"` resolved through imports.

The overlay hit-tests via `document.elementFromPoint` inside the iframe (bridge script), walks up to nearest `data-uid`, reports rect + uid via postMessage. All ops address nodes by uid; daemon maps uid → AST node deterministically.

---

## 2. Penpot UI Inventory → Target Mapping

Verified against repo `penpot/penpot`, path `frontend/src/app/main/ui/` (ClojureScript — reference for UX only; we rebuild plain React + TS).
Study these files for interaction/UX detail (all viewable on GitHub; MPL-2.0 — copy patterns and UX, write our own code and styles):

### 2.1 Workspace shell (`workspace/`)

| Penpot source | What it is | Our equivalent (Phase) |
|---|---|---|
| `workspace.cljs` | Workspace layout shell | `apps/studio/src/workspace/WorkspaceShell.tsx` (P1) |
| `left_header.cljs` | File name, main menu trigger | `TopBarLeft.tsx` (P5) |
| `right_header.cljs` | Share, users, zoom, play (preview) | `TopBarRight.tsx` (P5) |
| `main_menu.cljs` | File/edit/view menu | `MainMenu.tsx` (P5) |
| `top_toolbar.cljs` | Tool switcher (move, board, shapes, text, image, comments) | `Toolbar.tsx` — our tools: select, frame, insert-component, text, image, comment (P1/P5) |
| `context_menu.cljs` | Right-click menu | `CanvasContextMenu.tsx` (P5) |
| `presence.cljs` | Multiplayer avatars/cursors | (P7) |
| `color_palette.cljs`, `text_palette.cljs` | Bottom palettes | Token palette strip (P4) |
| `nudge.cljs`, `coordinates.cljs` | Nudge settings, coord display | (P5) |

### 2.2 Left sidebar (`workspace/sidebar/`)

| Penpot source | What it is | Our equivalent |
|---|---|---|
| `sitemap.cljs` | Pages list | `PagesPanel.tsx` — lists frames (= files in `src/frames/`) (P5) |
| `layers.cljs`, `layer_item.cljs`, `layer_name.cljs` | Layers tree (rename, hide, lock, drag-reorder) | `LayersPanel.tsx` — **renders the live JSX tree**; reorder = AST move op; dynamic nodes shown with lock badge (P3/P5) |
| `assets.cljs` | Libraries/components/colors assets panel | `ComponentsPanel.tsx` — reads `design-system/components/**/meta.ts` (P4) |
| `history.cljs`, `versions.cljs` | History/versions | Git-backed `HistoryPanel.tsx` (P6) |
| `shortcuts.cljs` | Shortcuts sheet | (P8) |

### 2.3 Right sidebar — design options (`workspace/sidebar/options/menus/`)

This is the gold mine: 20+ focused menus, each maps to codemod-backed controls:

| Penpot menu | Our inspector section | Writes |
|---|---|---|
| `measures.cljs` | Size/position | w/h/x/y → Tailwind `w- h-` or flex sizing; x/y only valid inside absolute contexts, else disabled with hint |
| `layout_container.cljs`, `layout_item.cljs` | Auto-layout (flex/grid) | `flex flex-col gap-* p-* items-* justify-*` classes |
| `fill.cljs` | Fill/background | `bg-*` class or token ref |
| `stroke.cljs` | Border | `border-*` |
| `border_radius.cljs` | Radius | `rounded-*` |
| `shadow.cljs` | Shadow | `shadow-*` |
| `blur.cljs` | Blur | `blur-*` (backdrop) |
| `text.cljs`, `typography.cljs` | Text styles | `text-* font-* leading-* tracking-*` + typography tokens |
| `component.cljs` | Component instance panel | Props editor generated from TS types (P3) |
| `constraints.cljs` | Constraints | Skip v1 (flexbox replaces) |
| `interactions.cljs` | Prototype links | `InteractionsPanel` — writes `onClick` nav stubs or route links (P8, optional) |
| `align.cljs` | Align/distribute row | Only inside absolute contexts; else disabled (P5) |
| `exports.cljs` | Export PNG/SVG | Frame screenshot export (P8) |
| `input_wrapper_tokens.cljs`, `token_typography_row.cljs` | Token-aware inputs | Every inspector input accepts token binding — copy this pattern exactly (P4) |

Shape-specific option sets (`options/shapes/{rect,text,frame,group,...}.cljs`) → our equivalent: option sets per node kind (`element`, `component-instance`, `frame`, `text`, `image`, `locked-dynamic`).

### 2.4 Tokens (`workspace/tokens/`)

Penpot implements W3C DTCG design tokens with **sets** and **themes** (`sets.cljs`, `themes.cljs`, `management.cljs`, `import/`, `export/`). Adopt wholesale:

- `design-system/tokens/tokens.json` in DTCG format, sets + themes supported.
- `TokensPanel.tsx` mirrors Penpot's sidebar: token sets tree, themes switcher, token CRUD, import/export DTCG JSON.
- Build pipeline: tokens.json → CSS custom properties (`--color-primary`) + Tailwind theme extension → consumed by all file-apps AND the studio UI itself.

### 2.5 Viewport interactions (`workspace/viewport/`)

Penpot's viewport files enumerate every canvas interaction we must (re)implement or get free from tldraw:

| Penpot file | Behavior | Ours via |
|---|---|---|
| `selection.cljs` | Marquee, shift-select | tldraw built-in |
| `snap_points.cljs`, `snap_distances.cljs` | Smart guides/snapping | tldraw built-in + custom for frame alignment |
| `rulers.cljs`, `guides.cljs` | Rulers + guides | tldraw extras / custom overlay (P8) |
| `comments.cljs` | Comment pins on canvas | P7 |
| `interactions.cljs` | Prototype arrows | P8 optional |
| `top_bar.cljs` | Context top bar (edit-mode banner) | Edit-mode indicator (P2) |
| `pixel_overlay.cljs` | Pixel grid at high zoom | Skip (DOM frames, not pixels) |
| `path_actions.cljs`, `drawarea.cljs` | Vector path editing | **Deliberately excluded** — no pen tool (see contract) |

### 2.6 Dashboard (`dashboard/`)

`projects.cljs`, `files.cljs`, `grid.cljs`, `sidebar.cljs`, `team.cljs`, `fonts.cljs`, `templates.cljs`, `import.cljs`, `search.cljs` → our Dashboard: project list, file-folder grid with thumbnails, team management (P6), fonts (P8), templates = starter file-folders (P8), search.

### 2.7 Other reusable UX

- `inspect/` — Penpot's "inspect" tab (attributes, code, annotations). Ours is trivially better: the code IS the source; inspect tab = read-only code view of selected node with "Open in IDE" (deep link `vscode://file/...`).
- `viewer/` — presentation/preview mode → ours: open file-app URL directly in new tab (it's a real app!) with frame-navigation chrome (P8).
- `ds/` — Penpot's own internal design-system components (buttons, inputs, dropdowns for the tool UI). We build ours with Radix/shadcn + our tokens (P0).
- `onboarding/`, `releases/` — later.

---

## 3. Monorepo Layout (create in Phase 0)

```
canvas-code-studio/
  apps/
    studio/                  # the editor app (Vite + React + TS)
  packages/
    canvas/                  # tldraw integration, FrameShape, overlay
    ast-engine/              # ts-morph codemods + uid mapping (pure, heavily tested)
    sync-daemon/             # node daemon: vite orchestration, ws server, fs watch, git
    vite-plugin-source-uid/  # babel/vite plugin injecting data-uid
    bridge/                  # script injected into file-app iframes (hit-test, rects, postMessage)
    tokens/                  # DTCG parse/serialize, css-var + tailwind emitters
    protocol/                # shared TS types: ops, events, uids (zod schemas)
    ui/                      # studio design system (Radix/shadcn based)
  templates/
    file-app/                # scaffold copied when user creates a new "file"
    design-system/           # scaffold for new projects
  e2e/                       # playwright tests driving studio + real file-apps
```

Conventions for ALL agents:
- TypeScript strict everywhere. pnpm workspaces + turborepo.
- Every package: vitest unit tests; `ast-engine` requires golden-file tests (input source + op → expected output source, byte-exact).
- Prettier with explicit config committed; **every codemod output must be prettier-formatted with that exact config** so canvas edits never produce noisy diffs.
- All cross-boundary messages validated with zod schemas from `packages/protocol`.
- No feature may persist scene state outside source files + `.studio/canvas.json`. PR review checklist item.

---

## 4. Phases

Dependency graph: `P0 → P1 → P2 → P3 → {P4, P5} → P6 → P7 → P8`. P4 and P5 parallelizable across agents once P3 lands.

---

### PHASE 0 — Foundations & Contracts (1 week equiv.)

**Goal:** Monorepo boots; protocol types defined; templates exist; CI green.

**Agent prompt:**
> Scaffold pnpm+turborepo monorepo per §3 layout. Implement `packages/protocol`: zod schemas for `NodeUid`, `CanvasOp` (set-prop, set-classes, insert-node, delete-node, move-node, wrap-node, set-text), `DaemonEvent` (file-changed, hmr-update, uid-remap, tokens-changed, components-changed), `FrameMeta` (`.studio/canvas.json` schema: frames[{framePath, x, y, w, h}], comments[], zoomBookmarks[]). Implement `templates/file-app`: minimal Vite+React+TS+Tailwind app with `src/frames/` convention — every `.tsx` file in `src/frames/` default-exports a component and is a frame; `App.tsx` renders a frame router (`?frame=Hero`). Implement `templates/design-system`: tokens.json (DTCG, one set "core", themes light/dark), `components/Button` example with `meta.ts` (`{name, description, category, propsSchemaFrom: 'types'}`). Set up vitest, playwright skeleton, prettier config, CI (lint+test+typecheck). Acceptance: `pnpm create-file demo && pnpm dev` serves the template app standalone in a browser.

**Pitfalls:** Do not let templates depend on studio packages (they must run standalone). Pin tldraw version in root; check current tldraw license/watermark terms before choosing tier.

---

### PHASE 1 — Infinite Canvas + Live Frames (2 weeks equiv.)

**Goal:** Open a project → infinite canvas → each `src/frames/*.tsx` appears as a live, HMR-updating frame positioned per `.studio/canvas.json`.

**Agent prompt:**
> In `packages/sync-daemon`: on project open, scan `files/*/src/frames/*.tsx`, boot one Vite dev server per file-folder (portpool), expose ws server (protocol events). Watch `.studio/canvas.json` and frames dir (add/remove frame files → event). In `packages/canvas`: wrap tldraw `<Tldraw>`; register custom shape `FrameShape` (util extends BaseBoxShapeUtil): renders chrome (name label from filename, resize handles) + sandboxed `<iframe src="http://localhost:<port>/?frame=<Name>">`. Frame geometry two-way binds to `.studio/canvas.json` (debounced write via daemon). New frame tool: creates `src/frames/<Name>.tsx` from template + meta entry. Acceptance: edit `Hero.tsx` in VS Code → frame updates in <1s without canvas reload; drag frame → canvas.json updated; create frame on canvas → new .tsx exists and renders; 20 frames pan/zoom at 60fps.

**Perf requirements (build in now, not later):** frames outside viewport get `iframe` unmounted, replaced by cached screenshot (html-to-image via bridge, cached per HMR generation). Zoom < 30% → screenshots only. `content-visibility` + `contain` on frame containers.

**Pitfalls:** iframe pointer-events MUST be `none` in canvas mode or tldraw gestures die. One Vite server per file-folder, not per frame. Don't proxy HMR websockets through daemon — direct connection.

---

### PHASE 2 — Selection Bridge (instrumentation + overlay) (2 weeks equiv.)

**Goal:** Click into a frame → select real JSX nodes; hover highlights; breadcrumb; dynamic nodes show lock badge. No editing yet.

**Agent prompt:**
> Implement `packages/vite-plugin-source-uid`: babel visitor tags every JSXElement/JSXFragment with `data-uid` (relPath + stable AST path), `data-dynamic` when inside CallExpression map/ternary/logical, `data-component` for imported component instances (resolve import source; mark `ds:` prefix when from design-system). Implement `packages/bridge` (injected via plugin in studio mode): listens for postMessage `{type:'hit-test', x, y}` → elementFromPoint → nearest data-uid ancestor → reply `{uid, rect, dynamic, component, breadcrumb:[...ancestor uids+names]}`; also `report-rects` for a uid list (for selection outlines tracking scroll/HMR); `hover-highlight` rendering. In `packages/canvas`: double-click frame = enter edit mode (tldraw camera locks to frame, iframe pointer-events auto, studio overlay draws selection/hover rects in canvas space by transforming iframe-space rects). Esc exits. Selection state (uids) lives in studio store (zustand). Acceptance: hover any element → blue outline + name tag; click → selection rect + breadcrumb in top bar; map-generated list item shows lock badge; selection survives HMR (uid remap event re-resolves).

**Pitfalls:** uid stability across HMR — derive from AST path not byte offsets; after any codemod the daemon must emit `uid-remap` table (old→new). Rect coordinates: iframe → frame-shape space → canvas space; test at multiple zooms. Scroll inside frames changes rects — bridge must stream rect updates (rAF-throttled) while selected.

---

### PHASE 3 — AST Write-Back Engine (3-4 weeks equiv., the core)

**Goal:** Canvas ops mutate real source files deterministically, format-preserving, undo-able.

**Agent prompt:**
> Implement `packages/ast-engine` (pure library, zero IO): ts-morph project; API `applyOp(sourceText, op): {newText, uidRemap}`. Ops: `set-text` (JSXText replace), `set-prop` (add/update/remove JSXAttribute; literals + template strings only; refuse expressions → error 'edit in code'), `set-classes` (merge/patch className string or `cn()` first-arg literal; Tailwind class group semantics: setting `bg-red-500` removes other `bg-*`), `insert-node` (insert JSX for a design-system component with required props defaulted, auto-add import), `delete-node`, `move-node` (reorder within parent / reparent, preserve comments), `wrap-node` (wrap selection in `<div className="flex ...">`). Every op refuses targets with data-dynamic. Output always run through prettier (shared config). Golden-file test suite: minimum 60 cases including: props with existing spread, self-closing conversion, className with cn()/clsx, moving node with leading comments, insert into empty fragment, tailwind conflict groups, unicode/RTL text content (Arabic strings must round-trip byte-exact). In `sync-daemon`: op queue per file (serialize, no concurrent writes), write-through with atomic rename, emit uid-remap, git auto-commit checkpoint every N ops / idle 30s with message `studio: <op summary>`. Undo/redo: op-inverse stack in daemon (compute inverse before apply; delete stores removed JSX text). Acceptance: from a test harness (no UI needed): apply 500 random valid ops to template app → app still typechecks, builds, and renders; diffs are minimal (prettier-stable); undo returns byte-identical file.

**Pitfalls (hard-won, do not skip):**
- Never regenerate whole file from AST default printer — destroys formatting. ts-morph manipulations + prettier is the discipline.
- `cn("base", cond && "x")` — only touch the first string literal; if className is fully dynamic, disable style controls for that node.
- Concurrent IDE edit + canvas op: daemon must detect file mtime/hash change since AST snapshot → re-parse before applying, or reject op with toast "file changed, retry".
- Component insertion import paths: always via `design-system` package alias, never relative into DS.

---

### PHASE 4 — Design System Folder: Tokens + Components (2-3 weeks equiv., parallel with P5)

**Goal:** `design-system/` is live: token edits propagate everywhere; components palette; token-aware inspector inputs.

**Agent prompt:**
> Implement `packages/tokens`: DTCG tokens.json parse/validate (sets, themes, aliases), emit (a) CSS custom properties file per theme, (b) Tailwind preset mapping tokens → utilities. File-app template consumes the preset. In daemon: watch `design-system/**` → rebuild token outputs → HMR ripples to all file-apps automatically (they import the emitted css/preset). Studio UI (`TokensPanel.tsx`, model on Penpot `workspace/tokens/`): sets tree, theme switcher, CRUD token (writes tokens.json), DTCG import/export. `ComponentsPanel.tsx` (model on Penpot `sidebar/assets.cljs`): reads `components/*/meta.ts` + extracts props schema from TS types (ts-morph type extraction, cache); category tree; drag component onto frame → `insert-node` op with import. Token-aware inputs (copy Penpot `input_wrapper_tokens` UX): every color/size/typography input in inspector has token-picker toggle; choosing token writes class/var referencing token, not raw value. Acceptance: change `color.primary` value in tokens.json via IDE → every frame using it updates <1s; same via TokensPanel; drag Button from palette into a flex column → correct JSX + import appears in file; inspector shows token chip not hex when token-bound.

**Pitfalls:** Token rename = codemod across all apps (class references) — implement as explicit "rename with refactor" flow, not silent. Component prop extraction must handle generics/unions gracefully (fallback: JSON control).

---

### PHASE 5 — Studio UI Chrome, Penpot-grade (3 weeks equiv., parallel with P4)

**Goal:** Full workspace UX per §2 mapping: layers tree, inspector with all design menus, toolbar, context menu, pages panel, dashboard shell (local projects).

**Agent prompt:**
> Build `apps/studio` chrome per §2 tables using `packages/ui` (Radix/shadcn, styled by our own tokens — dogfood). LayersPanel: virtualized JSX tree per selected frame (daemon supplies tree snapshots per file, updated on change); rename (component instances only → set-prop on a `data-name`? NO — rename = rename frame file or component; element rows show tag+class summary); drag-reorder → move-node op; lock/hide are studio-only visual aids stored in canvas.json. Inspector right sidebar with sections per §2.3 mapping, each control emitting ops; sections shown/hidden by node kind; dynamic nodes → read-only inspector with "Open in IDE" deep link. Toolbar: select / frame / insert component (opens palette) / text / image / comment(stub). Context menu: copy/paste (JSX-aware clipboard via ast-engine serialize), duplicate, delete, wrap-in-container, "open file in IDE". Keyboard map modeled on Penpot `shortcuts.cljs` (common Figma bindings). Dashboard: local projects registry (~/.studio/projects.json), file grid with thumbnails (frame screenshot composite), create/duplicate/delete file (fs ops through daemon). Acceptance: an agent-written Playwright script builds a small landing page start-to-finish using only the UI (insert components, edit text, set layout, bind tokens), and `git diff` of the file-folder is clean, prettier-formatted, and the app builds.

**Pitfalls:** Layers tree = derived view of AST, never a store. Debounce tree refresh on HMR bursts. RTL: studio chrome must support RTL locale from day one (user market: GCC) — CSS logical properties only, test `dir="rtl"`.

---

### PHASE 6 — Backend: Projects, Teams, Git, Thumbnails (2-3 weeks equiv.)

**Goal:** Multi-user product shell: auth, teams, project registry, git hosting, dashboard over server state. Local-first still works offline.

**Agent prompt:**
> Stand up Supabase (or Postgres+Auth service): tables teams, members, projects, files(registry: name, folder git remote, thumbnail url), comments (Phase 7 anchors). Each project = one git repo (self-hosted gitea or GitHub App integration — decide by ops constraints; abstract behind `packages/git-host` interface). Daemon gains: clone/pull on open, background push on checkpoint commits, conflict surface = plain git conflict → open in IDE (v1: last-write-wins on canvas.json only, source conflicts always manual). History panel = git log of studio checkpoints with restore (checkout file state into working tree). Thumbnails uploaded on checkpoint. Dashboard now server-backed (model Penpot `dashboard/` UX: projects grid, search, team switcher, invites). Acceptance: two machines open same project; edits flow via git push/pull with checkpoint granularity; new member invited via email joins team and opens project.

**Pitfalls:** DO NOT build custom sync of file contents — git is the sync. Realtime co-editing is Phase 7 and scoped to presence + comments + canvas.json, NOT concurrent source editing (v1 policy: file-level advisory locks — frame being edited by Alice shows lock to Bob; explicit, honest, shippable).

---

### PHASE 7 — Presence, Comments, Soft-Realtime (2 weeks equiv.)

**Goal:** Figma-feel without CRDT-on-source-code research project.

**Agent prompt:**
> Websocket presence service (or Supabase Realtime/PartyKit): cursors, avatars (model Penpot `presence.cljs`), per-frame edit locks (advisory, TTL), live broadcast of checkpoint commits → peers auto-pull when clean. Comments: pin threads anchored to {file, frameName, nodeUid|frameXY} stored server-side; render pins on canvas overlay (model Penpot `viewport/comments.cljs`, `dashboard/comments.cljs`); resolve/notify. Acceptance: 2 users same file — cursors visible; Alice edits Hero (Bob sees lock); Alice idle 30s → checkpoint → Bob's canvas updates automatically; Bob comments on a node, Alice sees pin live.

**Pitfalls:** nodeUid anchors break when code changes — store fallback (frame-relative xy + text snippet) and mark comment "detached" instead of losing it.

---

### PHASE 8 — Hardening, Preview, Export, Polish (ongoing)

**Agent prompt (menu — split into parallel tasks):**
> (a) Preview mode: "play" button opens file-app URL full-screen with frame navigation chrome (model Penpot `viewer/`); shareable if Phase 6 deploys preview builds. (b) Export: frame → PNG/SVG via bridge html-to-image; file-folder → zip / push to user's GitHub repo. (c) Guides/rulers on canvas (tldraw overlay). (d) Templates gallery (starter file-folders). (e) Fonts panel: manage font files in design-system, emit @font-face + tokens (model `dashboard/fonts.cljs`). (f) Interactions panel v1: nav links between frames → real `<a>`/router codemods. (g) Perf pass: 100-frame project benchmark, iframe pool cap with LRU, screenshot cache persistence. (h) A11y & i18n of studio chrome (WCAG 2.2 AA: focus order in panels, 24px targets, contrast from tokens; AR/EN locales, RTL). (i) Onboarding tour (model `onboarding/`). (j) Shortcut sheet (model `shortcuts.cljs`).

---

## 5. Global Risks & Standing Decisions (all agents read)

1. **No second scene model — ever.** Any PR persisting design state outside source files + `.studio/canvas.json` is rejected.
2. **Editable-surface contract (§0)** is law. Locked-dynamic UX must be polished, not apologetic — it is a feature ("this is real code"), not a limitation.
3. **Formatting-preserving codemods** are the product's reputation. Golden tests gate every ast-engine change. Noisy diffs = users stop trusting canvas edits.
4. **tldraw licensing:** verify current terms (watermark/paid tier) before P1 completes; abstraction layer in `packages/canvas` keeps a custom-canvas fallback possible (§ options in earlier analysis: own camera ≈ 2-4 weeks if ever needed).
5. **Penpot code is MPL-2.0 and ClojureScript — we take UX patterns, never code.** Screenshots + file references in §2 are design references. Our code is original TypeScript. (If any agent literally ports a file, that file carries MPL obligations — don't.)
6. **Vector/pen tooling is out of scope permanently** (v1/v2). Illustration = import SVG as asset/component.
7. **Concurrent source editing (CRDT) is out of scope** — advisory locks + git. Revisit only after product-market fit.
8. **Security:** iframes sandboxed (`allow-scripts allow-same-origin` on localhost only); daemon binds localhost; bridge validates postMessage origins; file-app code executes with user's local privileges — document this; no remote project code execution without sandbox story (Phase 6+: consider container-per-project for cloud version).
9. **RTL/Arabic first-class:** DOM canvas makes Arabic text, bidi, IME native — a real differentiator vs Figma-class tools in GCC market. Test Arabic content in every phase's acceptance (golden tests include Arabic strings).
10. **Definition of done, every phase:** typecheck + unit + golden + at least one Playwright e2e driving the real studio against a real file-app; demo GIF in PR.

## 6. Suggested Agent Team Topology

| Agent | Owns | Phases |
|---|---|---|
| `infra` | monorepo, CI, daemon skeleton, protocol | P0, P1 |
| `canvas` | tldraw integration, FrameShape, overlay, edit-mode | P1, P2 |
| `ast` | vite-plugin-source-uid, bridge, ast-engine, golden suite | P2, P3 |
| `tokens-ds` | tokens package, TokensPanel, ComponentsPanel | P4 |
| `chrome` | studio UI, layers, inspector, dashboard | P5 |
| `platform` | backend, git-host, presence, comments | P6, P7 |
| `qa` | e2e harness, perf benchmarks, a11y audits | continuous |

Sequencing note for orchestrator: P3 golden suite is the critical path — staff it first and heaviest. P4/P5 agents can start against mocked daemon events once `packages/protocol` freezes (end of P0).

---

## Appendix A — Penpot reference paths (for agents' further reading)

Repo: `github.com/penpot/penpot` → `frontend/src/app/main/ui/`
Workspace shell: `workspace.cljs`, `workspace/{top_toolbar,left_header,right_header,main_menu,context_menu,presence,palette}.cljs`
Left sidebar: `workspace/sidebar/{sitemap,layers,layer_item,assets,history,versions,shortcuts}.cljs`
Inspector menus: `workspace/sidebar/options/menus/*.cljs` (20+ files, see §2.3)
Shape option sets: `workspace/sidebar/options/shapes/*.cljs`
Tokens: `workspace/tokens/{sidebar,management,sets,themes,import,export}.cljs`
Viewport: `workspace/viewport/{selection,snap_points,snap_distances,rulers,guides,comments,top_bar}.cljs`
Dashboard: `dashboard/{projects,files,grid,sidebar,team,fonts,templates,search}.cljs`
Inspect tab: `inspect/{attributes,code,annotation}.cljs`
Viewer: `viewer/`
Penpot's own UI kit: `ds/`
Architecture docs: `help.penpot.app/technical-guide/developer/architecture/`

## Appendix B — Op protocol sketch (freeze in P0)

```ts
type NodeUid = `${string}.tsx:${string}`; // relPath : astPath

type CanvasOp =
  | { t: "set-text";    uid: NodeUid; text: string }
  | { t: "set-prop";    uid: NodeUid; name: string; value: Json | { token: string } | null }
  | { t: "set-classes"; uid: NodeUid; add: string[]; remove: string[] }
  | { t: "insert-node"; parentUid: NodeUid; index: number;
      source: { kind: "ds-component"; name: string } | { kind: "element"; tag: string; classes?: string } }
  | { t: "delete-node"; uid: NodeUid }
  | { t: "move-node";   uid: NodeUid; newParentUid: NodeUid; index: number }
  | { t: "wrap-node";   uids: NodeUid[]; wrapper: { tag: "div"; classes: string } };

type DaemonEvent =
  | { t: "hmr-update";      file: string }
  | { t: "uid-remap";       file: string; map: Record<NodeUid, NodeUid> }
  | { t: "tree-snapshot";   file: string; tree: TreeNode }
  | { t: "tokens-changed" } | { t: "components-changed" }
  | { t: "op-applied";      opId: string; inverse: CanvasOp[] }
  | { t: "op-rejected";     opId: string; reason: string };
```
