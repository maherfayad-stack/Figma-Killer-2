# Instatic Fork — Plan to make it 100% fit our scenario

**Branch:** `instatic-fork`
**Base:** CoreBunch/Instatic v0.0.11 (MIT), self-hosted CMS + visual editor. Bun + React 19 + Vite + Zustand + SQLite/Postgres.
**Our thesis (unchanged):** the file system is the single source of truth; a "file" IS a real, runnable React app folder; the canvas is a live renderer + structured editor over real `.tsx` source; canvas edits write source via AST codemods; code edits flow back to the canvas via HMR. **No second persistent scene model.**

Original context preserved on `main` (playbook, custom camera engine). This branch replaces that engine with Instatic's mature editor and re-plumbs it toward our thesis.

---

## 0. The key realization that makes this cheap

Instatic's canvas is **not** a static HTML preview. From `docs/editor.md`:

- `IframeFrameSurface` boots an empty iframe and **portals a real React node tree into the iframe `<body>` via `createPortal`** (`src/admin/pages/site/canvas/IframeFrameSurface.tsx`).
- `NodeRenderer` renders each node as real React inside the frame (`.../canvas/NodeRenderer.tsx`).
- Selection/hover rings, the Alt-ladder inspector, DnD (insert/move/wrap), inline `contentEditable` text editing, per-breakpoint viewports, and **patch-based O(change) undo/redo** already exist and are debugged.
- The right-panel **property controls are auto-generated from a module's schema** (`src/core/module-engine/propertySchema.ts` → `src/admin/pages/site/property-controls/`).
- Instatic already has **Visual Components** — reusable, typed, slotted components (`src/core/visualComponents/`) — and a **locked-node** concept (`toggleNodeLocked`).

So the expensive 60–70% (iframe React canvas, overlays, DnD, undo, inspector, tokens, dashboard, auth, media, spotlight) is **reused as-is**. Our work is bridging **four seams** so the nodes being rendered/edited are real codebase React components backed by real files instead of DB-stored blocks.

---

## 1. The four seams

| # | Seam | Instatic today | Target | Primary files |
|---|------|----------------|--------|---------------|
| 1 | **Render** | `NodeRenderer` renders built-in module types | Also render real user components resolved from a **component manifest** | `src/admin/pages/site/canvas/NodeRenderer.tsx`, `src/core/module-engine/registry.ts` |
| 2 | **Identity / mapping** | `PageNode.id` (DB-generated) | Every node carries **source coordinates** (`file`, JSX range, component id) via build-time tagging + manifest | `src/core/page-tree-schema/`, new `src/core/source-map/`, new Babel/SWC plugin |
| 3 | **Persistence** | `src/core/persistence/cms.ts` → SQLite/Postgres `data_tables`/`data_rows` | **Filesystem = truth**: React app folder per file; spatial-only metadata in `.studio/canvas.json`; git = history | `src/core/persistence/*`, new `src/core/fs-truth/` |
| 4 | **Output / two-way sync** | `src/core/publisher/` renders node tree → HTML/CSS | **Emit / edit real `.tsx`** via ts-morph codemods (canvas→code) + chokidar watch (code→canvas), trigger-based with echo suppression | `src/core/publisher/*` (repurpose), new `src/core/ast-sync/`, new `server/sync-daemon.ts` |

Everything not in this table is **kept**.

---

## 2. What we KEEP, REWIRE, REPLACE

### KEEP as-is (no thesis conflict)
- Admin shell: `src/admin/` — dashboard, auth/2FA/RBAC, media, users, account, spotlight (Cmd+K), in-house router, layouts, plugin host.
- Canvas machinery: `src/admin/pages/site/canvas/` — iframe surfaces, portal rendering, selection/hover overlays, Alt-ladder, DnD geometry, inline text edit, breakpoint frames, transform/pan-zoom.
- Editor store infra: `src/admin/pages/site/store/` — Zustand + Mutative + patch-based undo/redo, `mutateActiveTree` routing. (We change what a node *is*, not how the store mutates trees.)
- Property-control UI: `src/admin/pages/site/property-controls/`, `src/core/module-engine/propertySchema.ts`.
- Framework/tokens UI + token system: `FrameworkPanel`, `src/core/framework*`.
- Server/runtime plumbing, plugin sandbox, spotlight.

### REWIRE (UI kept, data source swapped)
- **Module registry → component manifest.** Register real codebase components as "modules" whose schema is derived from their prop types (`react-docgen`). Property controls then work for real components for free. Files: `src/core/module-engine/registry.ts`, `propertySchema.ts`, `validateNodeProps.ts`.
- **Visual Components → codebase components.** Map `src/core/visualComponents/` (typed, slotted, reusable) onto real `.tsx` component files. Their "componentize" flow becomes "extract to a real component file."
- **Persistence adapter.** Keep the `cmsAdapter` call sites in the editor; swap the implementation from DB to filesystem (Seam 3). Files: `src/core/persistence/cms.ts`, `cmsData.ts`.
- **Selectors/Site Explorer.** Point the Pages/Templates/Components explorer at real folders/files instead of DB rows.

### REPLACE (thesis-critical)
- **Publisher** (`src/core/publisher/` node→HTML) → React-source emission + AST codemod engine (Seam 4).
- **DB scene store** → filesystem truth + `.studio/canvas.json` spatial metadata + git (Seam 3).
- **Node-id-only identity** → source-coordinate identity (Seam 2).

### Editable-surface contract (carry over from the original playbook — non-negotiable)
Map directly onto Instatic's existing **locked-node** mechanism (`toggleNodeLocked`):
- Static JSX elements / component instances → fully editable.
- Literal props / Tailwind classes / token refs → editable via inspector (already schema-driven).
- JSX inside `.map()` / conditionals / render props → **rendered live but locked** (read-only badge).
- Hooks / handlers / business logic → invisible to canvas, never touched.
- Spread props `{...rest}` → rendered, editing disabled on spread keys.
This contract is what keeps two-way sync tractable. Enforce it in the manifest + codemod layer.

---

## 3. Toolchain decision

Instatic is **Bun** (`engines.bun >=1.3`). We are forking Instatic wholesale, so **adopt Bun as the runtime for this branch** — do not port to pnpm/turbo (that would fight the whole codebase, its tests, and its build). Our AST tools (ts-morph) and watcher (chokidar) run fine under Bun. Revisit only if a hard incompatibility appears.

Action items: `bun install`, `bun run dev`, confirm the stock editor boots before we touch anything.

---

## 4. Phased execution (risk-ordered — prove the thesis before deep integration)

### Phase A — Boot & orient (0.5 day)
- `bun install`; `bun run dev`; log in; open `/admin/site`; confirm canvas, DnD, undo, inspector, publish all work stock.
- Read `docs/editor.md` (done), `docs/architecture.md`, `docs/reference/page-tree.md`, `docs/features/visual-components.md`.
- **Gate:** stock Instatic runs locally.

### Phase B — De-risking spike: real component → click → source (1–2 days) ⭐ CRITICAL
The single experiment that proves or kills the whole approach.
1. Add a build-time **source-tagging** transform (Babel/SWC plugin) that stamps every JSX element with `data-src-file` + `data-src-loc` (`react-docgen`/`@babel/plugin-transform-react-jsx-source` as the base).
2. Render **one real `.tsx` component** from a sample React app folder inside an `IframeFrameSurface` via `NodeRenderer` (Seam 1, minimal).
3. Click it → selection overlay resolves the clicked element's `data-src-*` back to the exact file + JSX range (Seam 2, minimal).
4. Edit one literal prop in the inspector → a ts-morph codemod writes it back to the `.tsx` file → Vite HMR reflects it in the frame (Seam 4, minimal, one direction).
- **Gate:** the loop closes for one prop on one component. If it can't, stop and rethink before further investment.

### Phase C — Filesystem truth (3–5 days)
- New `src/core/fs-truth/`: a "file = React app folder" model; `.studio/canvas.json` holds ONLY spatial metadata (frame x/y, zoom bookmarks, comment anchors) — never runtime data.
- Implement a `cmsAdapter`-shaped **filesystem persistence adapter** so the editor store loads/saves against folders, not the DB. Keep DB code behind a flag for reference during migration; delete once parity is reached.
- Git integration for checkpoints (Instatic has no git layer; add `server/git.ts`).
- **Gate:** open a real React app folder as a "file", see its tree in the Site Explorer, edits persist to disk.

### Phase D — Component manifest & inspector (3–5 days)
- `src/core/source-map/manifest.ts`: scan the app folder, extract components + prop types (`react-docgen`), variants, slots → feed `module-engine/registry.ts`.
- Property controls (Seam 1 + rewire) now drive real component props. Wire the editable-surface contract → lock dynamic nodes.
- Map Visual Components onto real component files (extract-to-component writes a new `.tsx`).
- **Gate:** select a real component instance, edit its typed props from the panel, changes land in source.

### Phase E — Full two-way AST sync (5–8 days)
- `src/core/ast-sync/`: ts-morph codemods for the full editable surface — move (within layout), reorder, insert, delete, wrap, prop/class/token edits.
- `server/sync-daemon.ts`: chokidar watches the folder; on external code edit → reparse changed file → re-tag → invalidate → HMR into frames. **Trigger-based with echo suppression** (hash/ignore self-writes; debounce) to prevent write→watch→write loops.
- Repurpose the publisher's traversal utilities where useful; retire HTML emission.
- **Gate:** edit on canvas → source changes; edit source by hand → canvas updates; no loops; dynamic regions stay locked.

### Phase F — Reconcile the shell (2–4 days)
- Point Site Explorer / Selectors / Framework at filesystem + manifest.
- Decide the fate of DB-only workspaces (Content/Data/Media collections). Options: keep Media (files on disk already), drop or defer Content/Data collections (they're CMS features, not design-tool features).
- Tighten publish flow to "build the React app" instead of "bake HTML".
- **Gate:** a coherent design tool over a real React app folder, end to end.

---

## 5. Known hard parts (so they're not a surprise)
1. **Mapping stability.** Source tags locate an element; codemods still need to understand surrounding code to mutate it. The locked-surface contract is what keeps this bounded — enforce it early (Phase D).
2. **Echo/loop in trigger sync.** Self-write suppression + debounce is mandatory (Phase E). Design it in, don't retrofit.
3. **Partial/broken parse.** A file mid-edit may not parse; canvas must degrade to last-good AST + locked regions.
4. **DB assumptions in the shell.** Many editor call sites assume `cmsAdapter`/`data_rows`. Keep the adapter interface, swap the impl — don't rip the interface out.
5. **Manifest freshness.** Re-extract prop types on file change; treat the manifest as derived, never authored.

## 6. Upstream strategy
- Track upstream for fixes: `git remote add upstream https://github.com/CoreBunch/Instatic.git` (fetch-only). It's v0.0.x and pre-1.0, so APIs will shift — cherry-pick, don't blindly merge, once our seams diverge.

## 7. First action
Run **Phase A** then the **Phase B spike**. Nothing after Phase B is worth starting until the spike's loop closes.
