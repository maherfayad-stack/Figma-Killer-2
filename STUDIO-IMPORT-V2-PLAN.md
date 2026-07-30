# Studio Import V2 — "any React repo, edited like Figma"

Plan for taking Studio from *"an eSIM-shaped Vite repo parses into a board"* to
*"paste a GitHub URL or drop a zip, and the whole app is a Figma-grade design
surface backed by the real source"*.

Written against the code as it stands on `feat/alm-figma-killer-studio-shell`
(HEAD `6610754`). Every "today" claim below was read out of the repo, not
assumed.

---

## 0. The one decision everything else hangs off

Studio's founding invariant is stated at the top of
[`docs/features/studio-import.md`](docs/features/studio-import.md):

> **Studio parses source structurally. It never executes it.**

Three of the ten requirements cannot be met under that invariant:

| Requirement | Why static parsing can't do it |
|---|---|
| "import the npm packages … and modules for npm packages" | A `<Button>` from an arbitrary package is a compiled function. Its markup exists only when it runs. |
| "as close as possible to the source one" (fidelity audit) | Tailwind/CSS-Modules/PostCSS class names only exist after the project's own build runs. |
| "compare frames to the live one" | The "live one" *is* the running app. |

So V2 replaces one invariant with a **three-tier trust model**, declared per
project in `.studio/meta.json` and shown in the UI:

```jsonc
{ "trust": "static" }          // Tier 0 — today's behaviour. Nothing runs. Default for a fresh import.
{ "trust": "render-packages" } // Tier 1 — the project's *dependencies* are bundled and rendered in the canvas iframe.
{ "trust": "run-project" }     // Tier 2 — the project's own dev server / build runs, for reference screenshots.
```

The honest framing for the consent dialog: **Tier 1 executes exactly the code
`bun dev` in that repo would execute; Tier 2 runs `bun dev` itself.** A user who
cloned the repo already trusts it that much. What changes is that Studio now
says so out loud instead of implying a safety property it is about to drop.

Non-negotiables that survive all three tiers:

- **The AST stays the source of truth for structure and writeback.** Rendering a
  package component never produces editable nodes for its internals — it
  produces one node whose props are editable at the call site. Executing code is
  a *rendering* strategy, never a *parsing* one.
- **Tier 1 code runs only inside the canvas iframe**, never in the admin
  document. Today's iframes are same-origin (they must be — the editor portals
  React into them). So Tier 1 is not a security boundary; it is a blast-radius
  boundary (an error boundary + a crashed frame instead of a crashed editor).
  This is stated as a limitation, not sold as sandboxing.
- **Tier 2 runs behind an explicit capability** (`studio.run.project`), never
  granted by default, never granted to an MCP connector implicitly.

Everything below is sequenced so Tier 0 improvements land first and remain
useful even if Tiers 1–2 are deferred.

---

## 1. Where we actually are

A ledger, so no phase re-solves a solved problem.

### Already built (do not rebuild)

| Capability | Where |
|---|---|
| GitHub zipball import, path-traversal + zip-bomb guards, per-repo target dir | `server/handlers/studioGithubImport.ts` |
| Multi-file page discovery, `pagesDir` override, `.tsx`/`.jsx` | `server/handlers/studioProjects.ts` |
| ts-morph parse → `ParsedPage`, **tsconfig `paths` aliases already resolve** | `src/core/page-parser/`, `componentSources.ts:60` |
| Bounded static evaluator (Tiers A/B/C), `.map` expansion, multi-return | `src/core/page-parser/staticEval*.ts` |
| Local-component inlining through barrels, composite node ids | `inlineLocalComponents.ts` |
| Per-prop writability (`codeProps`), resolved-text writeback at its origin | `src/core/page-tree/sourceWritability.ts`, `sourceNodeId.ts` |
| Codemods: `setJsxProp`, `setJsxText`, `setJsxStyle`, `setStringLiteral`, `setJsxTagName` | `src/core/ast-codemods/` |
| CSS import → `StyleRule` + `classIds`, entry-stylesheet discovery, happy-dom CSSOM | `server/handlers/studioCss.ts`, `src/core/studio-sync/` |
| Local asset serving with symlink-escape guards | `server/handlers/studioAsset.ts` |
| Boards: frames at (x,y), optional per-frame w/h, sticky notes, docs | `src/core/studio-board/`, `BoardFramesLayer/` |
| **Frame virtualization already exists** (viewport intersection + margin) | `BoardFramesLayer/frameVirtualization.ts` |
| iframe-per-frame canvas, cascade-layered injectors, cross-realm events | `IframeFrameSurface.tsx`, `docs/features/canvas-iframe-per-frame.md` |
| Frame auto-height + definite `body` height for `%` chains | `useIframeFrameAutoHeight.ts` |
| CSS animations play once and hold | `CanvasAnimationInjector.tsx` (HEAD) |
| Agent screenshot of any breakpoint, offscreen, deterministic | `AgentSnapshotFrame.tsx`, `server/ai/tools/site/snapshot.ts` |
| MCP server + live editor bridge + image forwarding + `studio_import_project` | `server/ai/mcp/` |
| Design-system components as modules, `{svg}` prop revival, layout-transparent host | `src/modules/alm/register.tsx` |
| Figma-ish style sections (layout, size, position, typography, background, border, spacing box) | `panels/PropertiesPanel/` |

### The gaps, mapped to the ask

| # | Ask | Gap |
|---|---|---|
| 1 | Import from GitHub **or upload** | No upload route. No dependency install. No project-shape probe (framework, pages dir, aliases) — the user hand-edits `.studio/meta.json`. |
| 2 | "add all the styles" | Only plain `.css` reached by relative import. **No Tailwind, no CSS Modules, no Sass, no PostCSS, no package CSS, no CSS-in-JS.** |
| 2 | "import the npm packages … modules for npm packages" | Hardcoded to `@alm-design/design-system`, bundled into the admin app at build time via `scripts/gen-alm-manifest.mjs`. Nothing generalizes. |
| 3 | Edit local components, pass props at call sites | Local components are **inlined and their call site is destroyed** (`spliceReference`). There is no instance node, so call-site props are not editable as a node, by design. |
| 4 | Smooth, no canvas glitch, menu not far from selection | Overlay chrome lives in the parent document and is measured across the iframe + pan/zoom transform. Two O(pages×nodes) scans run inside store selectors on every store change. |
| 5 | Detach an instance to source | Does not exist. `setJsxTagName` explicitly refuses component references. |
| 6 | Right panel closer to Figma | Sections exist but are ordered/styled as a CMS inspector; no scrubbable numerics, no mixed-value state, no explicit class-vs-element target chip, no align/distribute row. |
| 7 | Set all pages to one width; select all for bulk actions | `BoardFrame.width/height` exist and single-frame resize works. No frame multi-select, no bulk apply, no device-preset apply-to-all. |
| 8 | Swap instances, upload images, dropdowns for known props | None of the three. Enum dropdowns exist only for `alm.*` from the build-time manifest. An `<img src={imported}>` is locked. |
| 9 | Freeze animation, kill all scroll | Animation freeze landed at HEAD. **Scroll is not addressed** — an app shell's `overflow:auto` + `flex:1` region still clips inside the frame. Media/JS animation/`scroll-behavior` untouched. |
| 10 | MCP tools for visual audit + bulk edits + structural guidance | `site_render_snapshot` exists (single frame, editor-bound). No board export, no reference render, no diff, no fidelity report, no studio codemod tools. |

---

## 2. Workstreams

Nine, ordered by dependency. Each states: **what**, **where**, **contract**,
**risk**, **gate**.

---

### WS-1 — Ingest: get any repo onto disk, correctly configured

**Goal:** paste a URL *or* drop a zip *or* pick a folder, and land in a board
without hand-editing JSON.

#### 1.1 Upload import

New `POST /admin/api/studio/import-upload` (multipart). Reuses
`resolveZipEntryRelPath`, `isSafeRelPath`, `WORKSPACE_MAX_FILE_BYTES`,
`WORKSPACE_MAX_FILES`, and the `MAX_IMPORT_TOTAL_BYTES` budget verbatim —
extract those from `studioGithubImport.ts` into
`server/handlers/studio/archiveIngest.ts` and have **both** routes call it. One
ingest engine, two fetch strategies.

- Zip archives handled by `fflate` (already a dep, already used).
- A *directory* upload (`<input webkitdirectory>`) arrives as N files; feed the
  same per-entry decision function, skipping the "strip the zipball root
  folder" step (the GitHub-specific bit — parameterize it, don't branch inside).
- Target dir derived from the archive's own root name, slugified, never
  caller-supplied. Same `.studio/` refuse-to-clobber guard as the GitHub path.

Client: extend `ImportGithubDialog.tsx` into `ImportProjectDialog` with three
tabs (GitHub / Upload / Local folder path). Upload goes through
`useUploadQueue`'s XHR path (the one place `parseJsonResponse` is legitimately
used), so progress works for a 100 MB archive.

#### 1.2 Project probe — replace hand-written `.studio/meta.json`

New `server/handlers/studio/projectProbe.ts`. Pure `dir → ProjectProfile`, run
once after ingest and re-runnable from the UI. Reads only files.

```ts
export interface ProjectProfile {
  framework: 'vite' | 'next-app' | 'next-pages' | 'cra' | 'remix' | 'astro' | 'unknown'
  pagesDir: string                       // repo-relative POSIX
  routeStyle: 'directory' | 'flat' | 'file-router'
  entryFiles: string[]                   // for collectEntryStylesheets
  packageManager: 'bun' | 'pnpm' | 'npm' | 'yarn'
  styleToolchain: {
    tailwind: { version: string; configPath: string } | null
    cssModules: boolean                  // any *.module.css|scss present
    sass: boolean
    postcssConfigPath: string | null
    cssInJs: 'styled-components' | 'emotion' | 'stitches' | null
  }
  componentPackages: string[]            // deps whose entry exports React components
  aliases: Record<string, string>        // from tsconfig paths + vite resolve.alias
  warnings: ProbeWarning[]               // each with a stable `code` and a human fix
}
```

Detection rules (all cheap, all file-reads):

| Signal | Conclusion |
|---|---|
| `next.config.*` + `app/` with `page.tsx` | `next-app`, `pagesDir: 'app'`, `routeStyle: 'file-router'` |
| `next.config.*` + `pages/` | `next-pages` |
| `vite.config.*` | `vite`; entry from `index.html`'s module `<script src>` (the walk `collectEntryStylesheets` already does) |
| `react-scripts` in deps | `cra`, entry `src/index.*` |
| No routing framework | fall back to the **densest directory of JSX-returning default exports** — a real heuristic, not a guess: rank candidate dirs by (files whose default export returns JSX) ÷ (total files). Present the top 3 in the dialog and let the user confirm. |
| `tailwindcss` in deps | record version (v3 config file vs v4 `@import "tailwindcss"` in CSS differ — both handled in WS-2) |
| `vite.config` `resolve.alias` | merged over tsconfig `paths` |

Extends `.studio/meta.json` (additive — today's `displayName`/`pagesDir`/
`previewLocale` keep working):

```jsonc
{
  "displayName": "…", "pagesDir": "…", "previewLocale": "…",
  "trust": "static",
  "profile": { /* ProjectProfile — cached probe result, re-runnable */ },
  "frameDefaults": { "width": 390, "height": 844 }   // WS-7
}
```

Validated with TypeBox (`StudioMetaSchema`) at the read boundary — today's
`isSafePagesDirOverride` check folds into it. The file stays hand-editable, so
every field keeps a containment guard.

#### 1.3 Next.js App Router support

`next-app` needs three parser changes, all small and all in
`studioProjects.ts` / `studioPageLoad.ts`:

1. Page discovery matches `page.tsx` / `layout.tsx` / `template.tsx` under
   `app/`, and the **page id is the route** (`app/(marketing)/pricing/page.tsx`
   → `/pricing`), so board frames are named like routes instead of `page`,
   `page (2)`, `page (3)`.
2. `layout.tsx` composition: a route's rendered tree is
   `RootLayout(SegmentLayout(Page))`. Reuse `inlineLocalComponents`' splice
   machinery with `{children}` as the splice point — the mechanism already
   exists (`{children}` splicing is documented, with a known depth limitation).
   A per-route toggle "show layout chrome" in the frame header.
3. `'use client'` / server components: **no behavioural difference** — the
   parser never executes either. Record it in the fidelity report (WS-9) so an
   `async` server component that awaits data is reported as unresolvable rather
   than silently empty.

#### 1.4 Dependency install

Required by WS-2 (package CSS, Tailwind) and WS-3 (package components), and by
today's already-shipped `?raw` package-icon resolution, which silently resolves
to nothing without a real `node_modules`.

New `server/handlers/studio/installDeps.ts` — a **job**, not a request:

```
POST /admin/api/studio/install      { dir }  → { jobId }
GET  /admin/api/studio/install/:id           → { status, log, exitCode }
```

- Runs `bun install --ignore-scripts` (or the detected package manager) via
  `Bun.spawn`, cwd = workspace, `timeout` 5 min, output captured and capped.
- **`--ignore-scripts` is not optional.** A postinstall script is arbitrary code
  execution at Tier 0, which would silently break the trust model *before* the
  user has consented to anything. Packages needing postinstall (`sharp`,
  `esbuild` binaries) are reported as warnings; the user may re-run with scripts
  from a confirm dialog, which promotes the project to Tier 1.
- `node_modules` stays excluded from `collectWorkspaceFiles` (download) and from
  archive ingest — unchanged.
- UI: a persistent status chip in the toolbar, and an `EmptyState` in the
  Dependencies panel offering "Install dependencies" when `node_modules` is
  absent but `package.json` has deps. Wire into the existing
  `panels/DependenciesPanel/`.

**Risk:** install is slow (30 s–3 min) and network-dependent. Mitigation: the
board loads and is fully editable at Tier 0 while install runs; package-backed
features light up when it finishes, via one `requestCmsSiteReload()`.

**Gate:** `archiveIngest.test.ts` (shared entry decisions, both routes),
`projectProbe.test.ts` against fixture trees for each framework — reuse the
`genericRepoShapes` discipline: at least one fixture that shares nothing with
the eSIM corpus.

---

### WS-2 — Styles: make an imported app *look* like itself

Today an imported repo's styling arrives only if it is plain CSS reached by a
relative import. That covers roughly the eSIM corpus and almost nothing else.

The design decision: **do not reimplement the toolchains — run them.** A
Tailwind config, a PostCSS pipeline, and a Sass import graph are programs. Any
hand-rolled approximation drifts the moment a plugin is used.

#### 2.1 The style compile step

New `server/handlers/studio/styleCompile.ts`. Input: `dir` + `ProjectProfile`.
Output: `CompiledStyles { css: string; sourceMapishIndex; moduleClassMaps }`.

Strategy, in order of what the profile found:

| Toolchain | Approach |
|---|---|
| Plain CSS | today's path, unchanged (`cssToStyleRules`) |
| Sass / Less | compile via the workspace's own `sass`/`less` if installed; else warn |
| PostCSS (incl. Tailwind v3) | load the workspace's `postcss.config.*` and run **the workspace's own** `postcss` + plugins, resolved from its `node_modules` (never the host's). Content globs come from the Tailwind config, so JIT emits exactly the utilities the source uses. |
| Tailwind v4 | v4 is a PostCSS/Vite plugin driven by `@import "tailwindcss"` inside CSS — same runner, different entry discovery. Detect by the `@import`, not by config-file presence. |
| CSS Modules | compile with the workspace's `postcss-modules` (or a minimal local implementation — the class-name hash rule is stable and small) to get `{ localName → globalName }` per file. **This map is the deliverable**, see 2.2. |
| CSS-in-JS | not compiled. Detected, reported, and the affected nodes flagged in the fidelity report. Honest gap. |

The compile runs **at load**, cached by a content hash of (all style inputs +
config files + the set of source files Tailwind's content globs match). Cache
lives in `.studio/cache/styles-<hash>.css`, gitignored via the workspace's own
`.gitignore` if we wrote one, else `.studio/` is already excluded from ingest.

The compiled CSS is then fed to the **existing** `cssToStyleRules` engine —
`StyleRule` ids, the class registry, and the editor's whole styling surface stay
exactly as they are. This is one new producer for an existing consumer, not a
second styling system.

#### 2.2 CSS Modules through the evaluator

`import styles from './Card.module.css'` then `className={styles.card}`. The
static evaluator already resolves member chains off a resolved object — it just
has no value for `styles`. Teach `assetImports.ts` one more "an import with no
`SourceFile`" case (exactly where `?raw` and images already live):

```
*.module.css import  →  StaticValue object { card: 'Card_card__a1b2', … }
```

from the compile step's `moduleClassMaps`. Everything downstream —
`classIdsForClassName`, member chains, template literals, `clsx`-style
concatenation via Tier A's `+`, call-site substitution — then works **for free**.
This is the highest fidelity-per-line change in the whole plan.

`cn()`/`clsx()`/`classnames()` calls: add them to Tier C's whitelist as a
built-in (they are pure string joins with a documented, tiny semantics —
strings kept, falsy dropped, object keys kept when truthy). Bounded, no
execution of user code.

#### 2.3 Package CSS

Generalize `AlmDesignSystemCssInjector` into `ProjectCssInjector`:

- Collect `.css` files imported from **bare specifiers**
  (`import '@acme/ui/dist/style.css'`) — today those are deliberately skipped.
  Keep them out of the *editable* class registry (the current, correct reason:
  they'd bury the user's own classes) but **inject them into the iframe** as a
  separate unlayered-below-user stylesheet so components look right.
- Two style buckets in each iframe, ordered: `vendor` (read-only, from packages)
  → `@layer user-authored` (the editable class registry). A `<style id="mc-vendor">`
  added to the injector table in `docs/features/canvas-iframe-per-frame.md`.

#### 2.4 Computed `className` — close the biggest fidelity hole

Documented today: `` className={`esb esb--${tone}`} `` keeps only its static
prefix, so **variant classes never attach**. With 2.2 in place, most of these
now resolve (the interpolated value usually comes from a prop, a const, or a
literal at the call site). For the residue, add a **variant probe**: when a
template's interpolation is unresolvable but its candidate set is enumerable
from the prop's TS union type (WS-6 reads these anyway), pick the *default*
variant and record `resolution.note` — same "we chose, and we said so" contract
Tier B's locale branch already uses.

**Gate:** `styleCompile.test.ts` with a Tailwind v3 fixture, a v4 fixture, a
CSS-Modules fixture; `cssModulesEvaluator.test.ts` asserting `styles.card`
resolves and lands in `classIds`. A visual gate lands in WS-9 (pixel diff).

---

### WS-3 — Package components become real modules

**Tier 1.** The requirement: *"import the npm packages … and modules for npm
packages"*.

Today: `src/modules/alm/register.tsx` statically imports
`@alm-design/design-system`, reads `manifest.generated.json` produced at build
time by `scripts/gen-alm-manifest.mjs`, and registers `alm.*` modules. Nothing
about it generalizes to a repo that uses MUI, shadcn/ui, Chakra, Mantine, or a
private design system.

#### 3.1 Manifest generation, per project, at import time

Move the extraction server-side: `server/handlers/studio/packageManifest.ts`.

- Input: `dir` + a package name. Output: the **same `ComponentSpec[]` shape**
  `register.tsx` already consumes — so the client-side registration code is
  reused, not rewritten.
- Source of truth, in order: the package's `.d.ts` (best — real prop types,
  real unions), then its `.tsx` source if shipped, then runtime `Object.keys`
  of the module namespace (worst — names only, no props).
- **Enum extraction is the payoff for requirement 8** ("drop down menus for
  predetermined props"): a `.d.ts` prop typed `variant?: 'primary' | 'ghost'`
  becomes a `select` control with those options. Extend beyond today's
  `enumValues` to a `PropKind` union:

```ts
type PropKind =
  | { kind: 'string' } | { kind: 'number' } | { kind: 'boolean' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'color' }          // name matches /color|fill|stroke|bg/ and type is string
  | { kind: 'image' }          // name matches /src|image|icon|avatar|logo/ and type is string
  | { kind: 'node' }           // ReactNode — rendered as a slot, see 3.4
  | { kind: 'handler' }        // (…)=>… — dropped, never stubbed (today's rule, kept)
  | { kind: 'unknown' }
```

`PropKind` drives the Properties-panel control choice (`buildSchema`), so
dropdowns, color pickers, and image pickers all fall out of one classification.

- Which packages get manifested: `ProjectProfile.componentPackages`, computed by
  probing each dependency's entry for exports whose name is `PascalCase` **and**
  whose `.d.ts` type is a `FunctionComponent`/`ForwardRefExoticComponent`/
  `(props) => JSX.Element`. Plus any bare specifier the parser actually saw a
  JSX component imported from — the parser already classifies these
  (`componentSources.ts` local-vs-package), so the demand list is free.

#### 3.2 Rendering them — the crux

The canvas must render a component from the project's `node_modules`. That means
executing it in the browser, which means bundling it.

**`POST /admin/api/studio/component-bundle { dir }` → `{ url, hash, components }`**

- Built with **`Bun.build`** (already the runtime; no new dep):
  - entry: a generated barrel re-exporting every manifested component
  - `target: 'browser'`, `format: 'esm'`, `minify: false` (readable stack traces)
  - `external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime']`
- **React identity is the whole problem.** Two React copies means hooks throw
  ("Invalid hook call") and context is invisible. The bundle must use the
  admin's React instance. Solution: serve the bundle with an **import map** in
  the admin document:

```html
<script type="importmap">
{ "imports": {
    "react": "/admin/api/studio/react-shim.js",
    "react-dom": "/admin/api/studio/react-dom-shim.js",
    "react/jsx-runtime": "/admin/api/studio/jsx-runtime-shim.js"
} }
</script>
```

  where each shim is a tiny generated ESM module that re-exports
  `globalThis.__INSTATIC_REACT__` — set once by the admin bundle. Import maps
  must exist before any module resolution, so this goes in `index.html` and is
  inert (three 200-byte modules) until a studio project needs it.
  *Fallback if import maps prove awkward under Vite dev:* build with a Bun
  plugin that rewrites `react` imports to `globalThis.__INSTATIC_REACT__`
  directly. Same effect, uglier, no HTML change. Decide by measurement, not
  by preference.

- Output written to `.studio/cache/bundle-<hash>.js`, served by a new route with
  the same containment guards as `studioAsset`.
- The bundle is `import()`ed **lazily**, only when the board contains at least
  one package-component node and the project is at Tier ≥ 1.

#### 3.3 Registration

Generalize `register.tsx` into `src/admin/pages/site/studio/registerProjectModules.ts`:

- module id: `pkg.<sanitized-package>.<ComponentName>` — namespaced, so two
  packages exporting `Button` coexist. `alm.*` becomes one instance of this,
  and `scripts/gen-alm-manifest.mjs` + `src/modules/alm/` are **deleted**
  (no old-and-new side by side — CLAUDE.md §"No band-aids").
- Keep verbatim from `register.tsx`, because each earned its comment:
  - the `AlmErrorBoundary` → `PackageErrorBoundary`
  - `reviveIconProps` (JSON `{svg}` → element) — now keyed off `PropKind.node`
  - `TRANSPARENT_HOST_STYLE` (`display: contents`) and the `nodeVisualRect`
    fallback that keeps a box-less node selectable
  - `Type.Optional(Type.Unknown())` for every prop (declaring the truth)
  - the class-goes-on-the-component-not-the-host rule
- Palette hiding (`PALETTE_HIDDEN_ALM_MODULE_IDS`) becomes a per-manifest flag
  derived from a name heuristic (`Dialog|Sheet|Modal|Toast|Snackbar|Tooltip|Popover`),
  overridable in `.studio/meta.json`.
- Modules registered per project are **unregistered on project switch** — today
  registration is a module-level side effect at import, which cannot be undone.
  Needs `registry.unregister(id)` if it doesn't exist, plus a `registerOrReplace`
  keyed set per project.

#### 3.4 `ReactNode` props render as slots

A `PropKind.node` prop (`icon`, `header`, `footer`, `children`) is where a
design system's composition lives. Today `iconPropFromJsx` recovers *only* SVG
markup, one level deep, and anything else is dropped.

At Tier 1 we can do better: capture the JSX subtree as a **child node group**
tagged with its target prop, render it through the ordinary `NodeRenderer` into
a React element, and pass *that* element as the prop. The existing
`base.slot-instance` machinery (see CLAUDE.md §"Visual Components and slots") is
the precedent for "children materialized as real, locked nodes in the page
tree" — reuse the shape, not the code path.

**Risk register for WS-3:**

| Risk | Mitigation |
|---|---|
| Package needs a provider/theme (`<ThemeProvider>`) | Probe for a `*Provider` export and wrap, the way `register.tsx` already wraps in `DesignSystemProvider`. Make it configurable in `.studio/meta.json`. |
| Package imports CSS/asset files inside the bundle | `Bun.build` handles CSS entries; collect and inject via WS-2.3. |
| Package touches `window`/`document` at module scope | The bundle is imported from the parent document but *rendered* into iframes. A module-scope DOM read gets the parent document. Documented limitation; the error boundary catches the crash. |
| Bundle is huge (MUI is ~300 KB gz) | Lazy `import()`, per-project cache, only components actually used on the board are in the entry barrel. |
| Version skew between the project's React 18 and admin React 19 | Detect from the workspace's `package.json`; if major differs, refuse Tier 1 with a clear message rather than producing hook-call crashes. |

**Gate:** `packageManifest.test.ts` (`.d.ts` → specs, incl. unions →
`PropKind.enum`); `componentBundle.test.ts` (build succeeds, externals are
external, hash is stable); an architecture test that `src/modules/alm` no longer
exists and nothing imports `@alm-design/design-system` outside a fixture.

---

### WS-4 — The instance model: components as instances, and detach

This is the heart of requirements 3 and 5, and it is a **redesign**, not an
addition.

#### 4.1 The problem with today's inlining

`inlineLocalComponents` **replaces** the `<Card/>` call site with Card's own
JSX (`spliceReference`). The reasoning is airtight and must be preserved: a
leftover wrapper `<div>` breaks `%`/flex height chains and `>`/`+` combinators
that cross the call site.

But replacing the call site costs four things the user is asking for:

1. No node represents the instance → **call-site props are not editable**
   (documented as a known trade-off).
2. No instance → **no swap** (requirement 8).
3. No instance → **no detach** (requirement 5).
4. Every inlined node claims the component's own source location, so an edit
   silently lands on all N instances (mitigated today by `SharedComponentNotice`,
   but mitigation is not the same as choosing).

#### 4.2 The fix: fragment nodes

Introduce a node that exists in the tree and the node map but **renders no DOM
element of its own**: a React Fragment.

```ts
// src/core/page-tree/ — new module kind
moduleId: 'studio.instance'
props: {
  componentName: string
  source: 'local' | 'package'
  sourceFile: string | null        // local only
  callSiteProps: Record<string, ParsedPropValue>
}
children: [ …the inlined subtree… ]
```

- `NodeRenderer` renders `studio.instance` as `<>{children}</>` — **zero DOM
  boxes**, so every reason `spliceReference` exists is preserved exactly. This is
  strictly better than `display: contents`, which still creates an element that
  breaks `:nth-child` and sibling combinators.
- Selection geometry: `nodeVisualRect` **already** falls back to the union of an
  element's children for box-less nodes (built for the `display: contents`
  design-system host). It generalizes to a fragment node with zero changes.
- Click selects the **instance** (Figma behaviour). `Enter` / double-click
  enters it and selects the inner node under the cursor. `Esc` steps back out.
  This is the standard Figma nesting model and it maps onto the existing
  `CanvasTreeLadder` (the ancestor-picker overlay) without a new concept.
- The DOM panel shows the instance as a collapsed row with a component glyph,
  its subtree nested beneath — again, Figma.

**Migration:** the composite id grammar
(`callSiteId~componentNodeId`, `INLINE_ID_SEPARATOR`) is unchanged; the instance
node simply takes `callSiteId` as its own id, which is exactly the id whose
absence forced the composite grammar in the first place. `studioEditLocation`'s
split-and-keep-the-tail rule is unaffected for inner nodes, and for the instance
node the id *is* the call site — a real, writable location.

#### 4.3 Call-site props become editable

With an instance node, `<Icon size={24}/>`'s `size` is a literal attribute at a
known line and column, and `setJsxProp` already writes exactly that. So:

- Properties panel for a `studio.instance` shows the **call-site prop surface**,
  driven by the component's own signature (WS-6 reads its TS types → dropdowns,
  color pickers, image pickers).
- `isPropWritableToSource` gets one new true-case and needs no new concept:
  a call-site prop holding a literal is writable; one holding an expression is
  `codeProps` as always.
- Editing a call-site prop is **instance-local** — the blast radius warning
  (`SharedComponentNotice`) moves off it and stays only on *inner* nodes, where
  it is genuinely true. This alone resolves most of the confusion the notice
  exists to explain.

#### 4.4 Detach — the Figma verb

New codemod `src/core/ast-codemods/detachComponent.ts` and a
`kind: 'detach'` `StudioEdit`.

```
detachComponentInstance(dir, callSiteNodeId) →
  { written: boolean; reason?: DetachRefusal }
```

Algorithm:

1. Resolve the call site (file, line, col) and the component's declaring file
   (`resolveExportedDeclaration` — already handles barrels and renaming
   re-exports).
2. Read the component's returned JSX. **Refuse** (with a specific reason) when
   the body contains hooks, state, effects, early returns with different JSX, or
   a `.map` over props — those aren't inlinable as markup, and pretending
   otherwise produces a page that behaves differently.
3. Substitute parameters with the call site's argument *expressions* (not their
   evaluated values) — so `title={plan.name}` stays a binding, not a baked
   string. Destructured params with defaults get the default when the call site
   omits them. This is a **source→source** transform; the existing
   `applySubstitutions` is a value transform, so this is new code, but the
   parameter-binding analysis is the same shape.
4. Splice `{children}` with the call site's children.
5. Write the resulting JSX at the call site, replacing `<Card …/>`.
6. Reconcile imports in the page file: add every identifier the pasted JSX now
   references (sub-components, icons, constants, `?raw` imports, CSS imports),
   resolving each relative specifier to the page file's own directory. Remove
   the `Card` import if this was its last usage.
7. Return `{ shifted: true }` so the client reloads (the existing rule: a write
   that moves line numbers invalidates every `line:col` id below it).

**Refusal is a first-class outcome, surfaced as a toast with the reason and an
offer:** "Card uses `useState` — detach can't inline it. Duplicate it as
`Card2.tsx` and edit that instead?" (`extractComponentCopy`, a much simpler
codemod: copy the file, rename the export, repoint this one call site.) That
gives the user a real escape hatch for the case detach genuinely can't handle,
which is the difference between a limitation and a dead end.

For a **package** instance, "detach" means something different and should be
labeled differently: **"Eject to local component"** — copy the component's
compiled-source-or-`.d.ts`-shaped JSX into `src/components/`, which is only
honest when the package ships source. When it doesn't, offer "Replace with
markup snapshot": serialize the rendered DOM (Tier 1 gives us a real render) to
JSX at the call site. Label it as lossy, because it is — handlers and state are
gone. Do not do this silently.

#### 4.5 Swap instance

New codemod `swapComponentInstance.ts` + `kind: 'swap'`:

- rename the JSX tag (opening + closing + self-closing),
- add/replace the import for the new component (resolving from the same barrel
  when both live in one),
- diff the prop sets: props the new component doesn't accept are **removed and
  reported**, required props it does accept and the old didn't are **added with
  their default**,
- refuse when the new name would shadow an existing binding.

This lifts `setJsxTagName`'s explicit refusal of component references — its
stated reason ("would need the new name imported and in scope") is precisely
what this codemod does.

UI: a swap picker in the instance's properties header — searchable list of local
components + manifested package components, with the component's own preview
thumbnail where one can be rendered (Tier 1). Figma's swap panel, essentially.

**Gate:** `detachComponent.test.ts` covering: plain component, destructured
defaults, `{children}`, sub-component import reconciliation, last-usage import
removal, and every refusal reason. `instanceNodes.test.tsx` asserting a
`studio.instance` renders zero DOM elements and that a `%`-height chain across
it still resolves (the regression this whole design exists to avoid).

---

### WS-5 — Canvas performance and selection precision

Requirement 4, split into named causes. Every item below is a specific,
verifiable defect or budget, not "make it faster".

#### 5.1 Move selection chrome inside the iframe

**The "menu far from the element" symptom is a coordinate-conversion problem.**
Overlay chrome (`BreakpointSelectionOverlay`, the toolbar, the tree-ladder) is
positioned in the *parent* document from measurements of elements inside a
*transformed* iframe, so its position is `elementRect × zoom + iframeOffset +
panOffset`, recomputed on a tick. Any staleness in any term shows up as
displacement — and at zoom ≠ 1 the error is multiplied.

Fix: render the **rings and the node badge inside the iframe document**, in a
`position: absolute` overlay layer appended to the iframe body, in the *same*
coordinate space as the element. No conversion, no zoom multiplication, no
drift — and zero cost on pan/zoom because the whole frame is one composited
transform. The injectors already own iframe `<head>`; this adds a body-level
overlay root, excluded from `applyIframeBodyPresentation`'s ownership and from
the publisher (design-mode only, same as `CanvasAnimationInjector`).

The **`InPlaceInspector`** (a real React panel with inputs) must stay in the
parent document — inputs inside a transformed iframe are a worse problem. It
instead anchors to a single **anchor rect published by the in-iframe overlay**,
written once per selection change and once per pan/zoom *commit* (not per
pointermove). Add a `--selection-anchor-{x,y,w,h}` custom-property channel, which
is exactly the sanctioned inline-style exception in CLAUDE.md.

#### 5.2 Kill the O(pages × nodes) store selectors

Two exist today and both run on **every store change**:

- `PropertiesPanelBody.tsx:97` — `sharedTextOriginCount` scans every node of
  every page to count shared text origins.
- `InPlaceInspector.tsx` `findNodeById` — scans every page to find one node.

Fix: build two indexes once at load, in the site slice:
`nodeIdToPageId: Map<string,string>` and
`textOriginKeyToCount: Map<string,number>`, maintained incrementally by the
mutations that can change them. Selectors become O(1). On a 40-page board with
1000 nodes/page this is 40 000 iterations per keystroke today.

**Gate:** an architecture test forbidding `for (const page of s.site.pages)`
inside a `useEditorStore` selector callback — the pattern, not the instance.

#### 5.3 Frame virtualization for iframes, not just DOM

`isFrameOnScreen` exists and is used. Verify (and fix if not) that an offscreen
frame **unmounts its iframe**, not just its overlay. Then add the missing half:
a **frozen poster** for offscreen frames, so panning across a 50-frame board
shows content instead of empty rectangles. Rasterize each frame once when it
first settles (the `AgentSnapshotFrame` capture path already exists and is
deterministic), cache the PNG in memory keyed by `(pageId, width, treeRevision)`,
and render it as the placeholder. This is how every design tool does it.

#### 5.4 Pan/zoom must not re-render React

Audit `useCanvas`: pointermove during a pan must write `transform` to a ref'd
element directly and commit to the store on pointerup. Same for zoom. Any
`setState` per pointermove event on a board with mounted iframes is the single
biggest source of "glitching".

#### 5.5 Load-time

- Parse is server-side and already cached per request; add a **page-level cache**
  keyed by (file mtime + workspace config hash), so re-opening a project with
  one changed file re-parses one file.
- Stream the load response page-by-page (NDJSON) so the first frames render
  while the rest parse. The store already handles incremental page addition.
- Budget: **first frame interactive < 2 s** for a 40-page repo on a warm cache.

#### 5.6 A perf gate that can fail

Add `scripts/bench/studioBoard.bench.ts` (there is already a `scripts/bench/`)
rendering a synthetic 50-frame / 20 000-node board and asserting:

| Budget | Threshold |
|---|---|
| Selection→ring paint | < 32 ms (2 frames) |
| Pan at 60 fps | no frame > 20 ms during a scripted 1 s pan |
| Store-change → panel re-render | < 8 ms |
| Mounted iframes at rest | ≤ visible + margin |

Numbers to be calibrated on first run, then enforced. A budget nobody can fail
is a comment.

---

### WS-6 — Right panel: a design tool's inspector

Requirement 6. The sections mostly exist
(`LayoutSection`, `SizeSection`, `PositionSection`, `TypographySection`,
`BackgroundSection`, `BorderControl`, `SpacingBoxControl`). What's missing is
Figma's *shape*, *density*, and *interaction*.

#### 6.1 Structure — Figma's order, top to bottom

```
┌────────────────────────────────────────┐
│ ⟨align row: 6 icon buttons + distribute⟩│  ← new
├────────────────────────────────────────┤
│ Editing:  ⟨element⟩ | .card | .card:hover│  ← new: the style-target chip
├────────────────────────────────────────┤
│ Position   X ▸000   Y ▸000              │
│ Size       W ▸000   H ▸000   🔒          │
│            min/max (disclosure)          │
├────────────────────────────────────────┤
│ Auto layout  [→][↓][⊞]  gap ▸  pad ▸    │  ← flex, Figma's icon language
│              align 3×3 grid              │
├────────────────────────────────────────┤
│ Appearance   opacity ▸  radius ▸  clip □ │
├────────────────────────────────────────┤
│ Fill         ⬛ #0A0A0A  100%      + −    │
│ Stroke       ⬛ 1px inside          + −    │
│ Effects      shadow / blur         + −    │
├────────────────────────────────────────┤
│ Typography   family, size, weight, LH,   │
│              LS, align, transform         │
├────────────────────────────────────────┤
│ Component    ⟨instance⟩ swap ⇄  detach ⊗ │  ← WS-4
│ Props        variant [primary ▾]          │  ← WS-3/6.4
│              icon    [upload…]            │
├────────────────────────────────────────┤
│ Export       PNG 1× / 2× / SVG            │
└────────────────────────────────────────┘
```

#### 6.2 The style-target chip — the honest version of Figma

This is where Studio *must* differ, and hiding the difference is worse than
showing it. Figma edits one object. Here, a change goes to one of three places:

| Target | Writes to |
|---|---|
| **Element** | the node's inline `style={{}}` in the JSX (`setJsxStyle`) |
| **Class** `.card` | the CSS rule — **which today is not written back to disk** |
| **Class + state** `.card:hover` | same, plus the state-pseudo machinery that already exists |

The chip makes the current target unmissable and switchable in one click, and it
**states the CSS write-back gap inline** rather than in a doc: a small warning
on the class target reading "CSS edits are preview-only until CSS write-back
lands". Which leads to:

#### 6.3 CSS write-back (the "one-way CSS" gap)

Documented today as *"a real, user-visible sharp edge [that] must not be
discovered by losing work"* and deferred as "a separate initiative". With a
Figma-like panel, nearly every style edit hits a class, so this stops being
deferrable.

New `src/core/css-codemods/` (parallel to `ast-codemods/`):

- Parse the `.css` file with a **CST** parser that preserves formatting
  (`postcss` — already available via WS-2's toolchain, and it round-trips
  whitespace/comments faithfully). Not `cssToStyleRules`, which is a lossy
  CSSOM read.
- `setDeclaration(file, selector, prop, value)` — updates in place, inserts at
  the end of the rule if absent, creates the rule if absent (at the end of the
  file the class was first defined in).
- `setDeclarationAtMedia(file, selector, media, prop, value)` for breakpoints.
- Map `StyleRule.id` → `(file, selector, position)` at load — the id is already
  deterministic (`sc-${sha1(kind|name)}`), so this is one extra field on the
  parse output, not a new lookup mechanism.
- Refuse (and say so) when the rule came from a **compiled** stylesheet
  (Tailwind output, a package's `dist/style.css`, a `.module.css` compile) —
  those have no editable source. For Tailwind specifically, the right edit is a
  *utility class change on the element*, which is a `className` edit — offer
  that instead. That's a genuinely nice affordance: a Tailwind project gets a
  visual editor whose "fill" picker rewrites `bg-red-500` → `bg-blue-600`.

#### 6.4 New UI primitives (in `src/ui/components/`, per CLAUDE.md)

| Primitive | Why |
|---|---|
| `ScrubInput` | Drag-on-label to change a number. *The* Figma interaction. Also handles unit suffixes, arrow keys (±1 / ±10 with Shift), and `auto`/`fill`/`hug` keywords. |
| `IconToggleGroup` | Flex direction, alignment, text align — Figma's segmented icon rows. |
| `MixedValue` support | Multi-select shows `Mixed`; typing replaces on all. Needed by WS-7. |
| `ColorField` | Swatch + hex + alpha + eyedropper (`EyeDropper` API where available), reading the project's color tokens as swatches (`FrameworkPanel` already has tokens). |
| `AlignBar` | Align/distribute the current selection. |

Icons from `pixel-art-icons` only (gated). Tokens only, no hex (gated). No
manual memoization (React Compiler is on).

#### 6.5 Prop controls from types

Ties WS-3's `PropKind` into `PropertyControlRenderer`:

- `enum` → `Select` (requirement 8's dropdowns)
- `color` → `ColorField`
- `image` → image picker with upload (WS-8)
- `boolean` → `Switch`
- `node` → slot affordance ("Edit contents" → enters the slot)
- `unknown`/structured → today's `CodeValueControl` read-only summary (keep — it
  exists because an editable box for an array was actively destructive)

For **local** components the same classification comes from the component's own
TS signature via ts-morph — the parser already has the declaration.

**Gate:** `css-token-policy`, `no-css-var-fallbacks`, `button-primitive-usage`
all already run. Add `scrubInput.test.tsx` for the drag math and keyboard steps.

---

### WS-7 — Board: bulk selection and bulk actions

Requirement 7. `BoardFrame.width/height` already exist and are already optional
with a documented no-migration fallback, so the data model is done.

#### 7.1 Frame multi-selection

New `selectedFrameIds: string[]` in `boardSlice`, distinct from node selection
(a board frame is not a node).

- Click frame chrome (label or border) selects the frame.
- Shift-click extends; `⌘/Ctrl+A` on empty canvas selects all frames.
- **Marquee** on empty canvas: drag to select intersecting frames. Pure geometry
  next to `frameVirtualization.ts` (`framesInMarquee`) — same board→screen math,
  unit-testable without a browser.
- Selection ring drawn per frame in the board layer, plus one bounding box.

#### 7.2 Bulk frame actions

A frame inspector in the right panel when frames (not nodes) are selected:

| Action | Detail |
|---|---|
| **Set size** | W/H with `MixedValue`. Applies to all selected. |
| **Device preset** | The existing `devicePresets.ts` list, as a dropdown — "iPhone 15 Pro (393×852)" applied to N frames at once. |
| **Apply to all pages** | The literal ask: one control that writes `width` to *every* frame on the board and to `.studio/meta.json`'s `frameDefaults`, so pages added later inherit it. |
| **Fit height to content** | Sets `height` to each frame's measured content height (already computed by `useIframeFrameAutoHeight`). Pairs with WS-8's scroll unroll: "show me every screen, whole, at 390px". |
| **Align / distribute** | Left/center/right/top/middle/bottom; distribute h/v; "tidy up" into a grid using `defaultFramePosition`'s existing constants. |
| **Reorder / rename** | Batch rename with a pattern; reorder in the board list. |
| **Delete** | With one confirmation for the whole set. |

All of it mutates `boards.json` through the existing `boardsApi` + `parseBoardsFile`
(defensive coercion, no parallel TypeBox mirror — keep that decision).

#### 7.3 Bulk node actions across frames

Node multi-select already exists (`MultiSelectionInspector`). Extend it to work
**across frames** on a board (it currently assumes the active document). Given
WS-5.2's `nodeIdToPageId` index this is cheap. Bulk apply: add/remove a class,
set a shared style property, delete, wrap.

**Gate:** `framesInMarquee.test.ts`, `bulkFrameSize.test.ts` (mixed values,
apply-to-all, persistence round-trip through `parseBoardsFile`).

---

### WS-8 — Design-surface fidelity: freeze, unroll, and assets

#### 8.1 Freeze everything that moves (requirement 9, first half)

`CanvasAnimationInjector` (HEAD) handles CSS animations. Extend it — same file,
same rationale, same `!important` justification:

| Motion source | Rule |
|---|---|
| CSS animations | `animation-iteration-count: 1; animation-fill-mode: forwards` ✅ shipped |
| CSS transitions | `transition: none !important` — a transition mid-flight during a layout change reads as canvas jitter, and it's never wanted on a static surface |
| Smooth scrolling | `scroll-behavior: auto !important` |
| `<video>` / `<audio>` | pause + `removeAttribute('autoplay')` on mount and on DOM insert (a `MutationObserver` in the injector) |
| Animated GIF/WebP/APNG | Can't be frozen by CSS. Leave, and document. |
| JS animation (framer-motion, GSAP) | Only runs when "Run scripts" is on. Add a design-mode rule: **Run scripts is forced off in design frames** unless explicitly enabled per-frame. |
| `prefers-reduced-motion` | Inject `(prefers-reduced-motion: reduce)` as the iframe's matched state, so a well-behaved app disables its own motion |

**Freeze point toggle**, per project: `end` (today's `forwards`, correct for
entrance animations) vs `start` (`animation-play-state: paused` at delay 0 —
correct for a fade-out ping whose end state is invisible). Default `end`; the
known consequence is already documented in the injector and the toggle is the
fix for it.

#### 8.2 Unroll every scroll region (requirement 9, second half)

The unaddressed half, and the one that most breaks "see the whole screen".
An imported app shell is `height: 100%` + a `flex: 1; overflow: auto` region.
Inside a frame, that region clips — so the design canvas shows a scrollable
box, not a screen.

New `CanvasScrollUnrollInjector`, design frames only, toggleable per board
("Unroll scroll" in the canvas toolbar, on by default for imported projects):

```css
/* every scroll container becomes content-sized */
*, *::before, *::after {
  overflow: visible !important;
  overflow-x: visible !important;
  overflow-y: visible !important;
  scroll-behavior: auto !important;
}
/* a flex child that was a scroll viewport must be allowed to grow */
* { min-height: auto !important; }
/* sticky/fixed chrome would float mid-frame; pin it into flow */
[data-instatic-unroll] { position: static !important; }
html, body { overflow: visible !important; height: auto !important; }
```

Two things need more than a stylesheet and belong in the injector's JS half:

- **`position: fixed`** elements (a bottom nav, a header) must become
  `position: absolute` relative to the frame, not `static`, or the layout
  reflows into something the app never looks like. A `MutationObserver` +
  `getComputedStyle` pass tags them with `data-instatic-unroll="fixed"` and the
  stylesheet pins them to the frame's top/bottom. Cost is bounded: one pass per
  DOM settle, not per frame.
- **Elements with an explicit `height` that clips** (`height: 100vh` on an inner
  panel) get `height: auto; min-height: <original>` so nothing shrinks but
  everything can grow.

Interaction with `useIframeFrameAutoHeight`: unrolling makes content taller, the
frame grows, `%` chains still resolve against the pinned body height. The
existing unpin-before-measure logic already handles the shrink direction. Add a
regression test for the pin/unroll interaction specifically — it's the one place
these two systems can fight.

**This must never affect the publisher or writeback.** Design-mode injector
only, same scope contract as `CanvasAnimationInjector`.

#### 8.3 Image upload (requirement 8)

Today an `<img src={heroImg}>` where `heroImg` is an import is **locked**, with
a correct reason: the only honest write-back would change the import, which
didn't exist as a codemod.

Build it:

1. `POST /admin/api/studio/asset-upload { dir, targetDir, file }` — writes into
   the workspace (default: the directory the existing import points at, else
   `src/assets/`), with `resolveStudioAssetResponse`'s full guard set applied to
   the *write* path (absolute/UNC/`..`/excluded dirs/symlink escape).
2. New `ParsedNode.assetOrigin: ValueOrigin | null` — where the import
   declaration's module-specifier **string literal** physically lives. This is
   the exact same trick `textOrigin` already uses for dictionary copy, and it
   reuses the same evaluator hook: `origin` is attached at the one place a
   literal is read.
3. New codemod `setImportSpecifier(file, line, col, newSpecifier)` — replaces
   that literal, preserving quote style (like `setStringLiteral`).
4. `kind: 'asset'` `StudioEdit`, routed by `applyStudioEdit`. Shared-asset
   warning when N nodes resolve to the same import (same treatment as shared
   text).
5. Literal-`src` case (`src="/img/hero.png"`) is just `setJsxProp` — already works,
   just needs the picker UI in front of it.
6. UI: `SizeSection`-adjacent image control with drag-drop, "replace", the
   project's own asset browser (reuse `MediaExplorerPanel`'s shape, pointed at
   the workspace instead of the CMS media library), and object-fit/position.

**Gate:** `setImportSpecifier.test.ts`, `assetUpload.test.ts` (containment
guards, including a symlinked target dir).

---

### WS-9 — MCP: let an agent audit and restructure the board

Requirement 10. Existing surface:
`server/ai/mcp/registry.ts` composes headless tools + browser-bridged tools,
image forwarding works (`imageForwarding.ts`), `site_render_snapshot` renders
one frame at one breakpoint offscreen and deterministically.

New tool family, all in `server/ai/mcp/tools/studio/`, all following the
registry's existing rules (capability-gated via `toolAllowedForCapabilities`;
never a headless mutator that would desync the open editor).

#### 9.1 Project + board tools (headless)

| Tool | Contract |
|---|---|
| `studio_list_projects` | Wraps `listStudioProjects`. Adds `profile` from the probe. |
| `studio_project_profile` | The `ProjectProfile` + probe warnings. Lets the agent see "Tailwind v4, app router, 3 component packages" before touching anything. |
| `studio_install_deps` | Kicks the WS-1.4 job; returns `jobId`. Capability: `studio.write`. |
| `studio_list_pages` | Page ids, routes, source files, node counts, frame rects. |
| `studio_get_node_source` | node id → `{ file, line, col, snippet }`. The bridge from a visual defect to the code. The id grammar already encodes this (`sourceNodeId.ts`); this exposes the decode. |
| `studio_find_nodes` | Query by module id, tag, class, text, lock reason, or `codeProps` presence. The agent's "show me everything that failed to resolve". |

#### 9.2 Visual audit tools

| Tool | Contract |
|---|---|
| `studio_export_frames` | **Batch** render of N frames to PNG at a given width/DPR. Returns MCP image blocks (forwarding exists). Uses `AgentSnapshotFrame`'s deterministic readiness path, and honours the freeze + unroll injectors so the export matches the canvas. This is the "export them as images" ask. |
| `studio_render_reference` | **Tier 2.** Boots the project's own dev server (`bun dev` / detected script) on an ephemeral port, drives a headless browser (Playwright — `playwright.config.ts` already exists) to the route at the same viewport, screenshots. Behind `studio.run.project`. Server torn down after a configurable idle. |
| `studio_diff_frames` | Server-side pixel + perceptual diff (`pixelmatch` for pixels, a small SSIM for structure) between a studio frame and its reference. Returns: overall score, a diff PNG, and **per-region scores** for the top N differing rectangles, each mapped back to the node ids intersecting that rectangle. So the agent gets "the hero section is 78% different, nodes `X`, `Y`" instead of "the images look different". |
| `studio_fidelity_report` | The machine-readable version of "what didn't import" — see 9.4. |

#### 9.3 Bulk edit + structural tools

| Tool | Contract |
|---|---|
| `studio_apply_edits` | A batch of the existing `StudioEdit` shapes in one call, through the existing `/save` engine (ordering, dedupe, containment, shared-component detection all reused). The "make big changes at once" ask. |
| `studio_codemod` | The higher-level verbs as one dispatched tool: `detach`, `swap`, `extract-component`, `set-import-specifier`, `rename-tag`. Each maps to a WS-4/WS-8 codemod. |
| `studio_set_frames` | Bulk frame geometry (WS-7) — set width on all, apply preset, tidy, fit-to-content. |
| `studio_open_project` | Points the live editor bridge at a project dir, so the browser-bridged tools operate on it. Fails with a clear message when no workspace is connected — matching the existing bridge contract. |

#### 9.4 The fidelity report — "guide the agent on how to structure pages"

The most valuable and most novel tool. `studio_fidelity_report(dir, pageId?)`
returns, per page:

```jsonc
{
  "pageId": "src/screens/Home.tsx",
  "score": { "nodes": 1154, "resolved": 612, "locked": 519, "codeValued": 214 },
  "findings": [
    { "code": "UNRESOLVED_MAP_SOURCE", "nodeId": "…:88:7", "file": "…", "line": 88,
      "message": "`.map` over `plans`, which comes from `useQuery` — not statically readable.",
      "fix": "Extract the shape to a module-scope `const PLANS = […]` and map over that, or pass it as a default prop.",
      "impact": "1 opaque node instead of 4 rows" },
    { "code": "COMPUTED_CLASSNAME", … },
    { "code": "MULTI_STAGE_SCREEN", … },
    { "code": "CSS_IN_JS_UNSUPPORTED", … },
    { "code": "PACKAGE_NOT_MANIFESTED", … }
  ]
}
```

Every documented limitation in `docs/features/studio-import.md` §"What still
does not import" becomes a **finding code with a suggested source restructure**.
That list is already written, already honest, and already precise — this turns
it from prose into a machine-readable contract an agent can act on. Codes are
stable identifiers, versioned, and covered by a test that every code the parser
can emit appears in the doc table (and vice versa).

#### 9.5 MCP resource: the structuring guide

Expose `studio://guidelines` as an MCP **resource** (the server already supports
resources) containing the distilled "how to write React that imports cleanly"
rules: module-scope consts over hooks for demo data, literal `className`s,
avoid computed variants, one return per component where possible, `?raw` icon
imports, keep provider values in one place. The agent reads it once and writes
conformant code thereafter — which is the requirement's "guiding it on how to
structure the pages so they render perfectly".

**Gate:** `studioMcpTools.test.ts` per tool; `fidelityCodes.test.ts` (doc ⇄ code
parity); an e2e that exports a frame and diffs it against a stored golden.

---

## 3. Sequencing

Dependencies are real; this order is not arbitrary.

```
WS-1 Ingest ────────────┬──> WS-2 Styles ──┬──> WS-9.2 visual audit
  (probe, upload,       │                  │
   install)             ├──> WS-3 Packages ─┤
                        │      (Tier 1)     │
                        └──> WS-4 Instances ┴──> WS-6 Right panel
                                 │                    │
WS-5 Perf (independent) ─────────┴──> WS-7 Board bulk ┘
WS-8 Freeze/unroll/assets (independent)
WS-9 MCP (last — it exposes everything above)
```

### Milestones

| M | Contents | User-visible outcome |
|---|---|---|
| **M1 — "It opens"** | WS-1 (all), WS-8.1+8.2 | Paste a URL or drop a zip; any Vite/Next/CRA repo lands on a board, correctly configured, frozen and unrolled so every screen is visible whole. |
| **M2 — "It looks right"** | WS-2 (all), WS-5.1+5.2 | Tailwind/CSS-Modules projects render correctly. Selection chrome is exactly on the element. No selector-driven jank. |
| **M3 — "It's a design tool"** | WS-6, WS-7, WS-8.3, WS-5.3–5.6 | Figma-shaped inspector with scrub inputs, CSS write-back, frame multi-select + bulk width, image upload. Perf budgets enforced. |
| **M4 — "Components behave"** | WS-4 (all), WS-3 (all) | Instances select/enter/swap/detach. npm components render and expose typed prop controls with dropdowns. |
| **M5 — "The agent can audit"** | WS-9 (all) | Batch frame export, reference render, pixel diff mapped to node ids, fidelity report, bulk codemods over MCP. |

M1 and M2 are the ones that change the product's answer to "can I use my repo?"
from *no* to *yes*. M4 is the largest single body of work and the one most
likely to need its own sub-plan once WS-4.2's fragment-node model is prototyped.

---

## 4. Cross-cutting requirements (CLAUDE.md compliance)

Not optional, and cheaper to do inline than retrofit:

- **TypeBox at every new boundary.** `StudioMetaSchema`, `ProjectProfileSchema`,
  install-job responses, upload responses, every new MCP tool's input schema.
  No `as Foo` at a JSON boundary (`boundary-validation.test.ts` gates it).
- **`apiRequest`** for every new client call; `readEnvelope` in the persistence
  layer; the XHR path only for upload progress.
- **No new DB migrations.** Studio is filesystem-backed; nothing here touches
  `data_tables`/`data_rows`. If a project registry ever moves into the DB, it
  ships as an additive migration in both dialect files with the same id.
- **CSS Modules + tokens only** for every new panel; add tokens to `globals.css`
  rather than using fallbacks or hex.
- **No manual memoization** (React Compiler is on) except the three documented
  exceptions — and WS-5.3's poster placeholder is a plausible `React.memo`
  case (hot, list-rendered, O(N) critical path): justify it in a comment if used.
- **Delete what's replaced.** `src/modules/alm/`, `scripts/gen-alm-manifest.mjs`,
  and the `@alm-design/design-system` dependency go when WS-3 lands. No
  old-and-new side by side, no compat shim.
- **Docs track code, in the same change.** New/updated:
  `docs/features/studio-import.md` (instance model, package rendering, style
  compile, the trust tiers), `docs/features/canvas-iframe-per-frame.md`
  (new injectors, in-iframe overlay), `docs/features/mcp-connectors.md` (studio
  tools), plus a new `docs/features/studio-projects.md` for ingest/probe/install.
- **Architecture tests updated in the same change** whenever a structural rule
  moves — that includes the new "no full-site scans in store selectors" gate and
  the "no `@alm-design` imports" gate.
- **Verification once, at the end of each WS:** `bun run build`, `bun test`,
  `bun run lint`.

---

## 5. Open decisions — need a call before M1 starts

1. **Trust default.** Should a freshly imported project default to Tier 0
   (static, safest, but package components render as boxes until the user opts
   in) or auto-promote to Tier 1 after a successful `--ignore-scripts` install?
   *Recommendation: Tier 0 by default, with a one-click promote in the frame
   where a package component would have rendered — the affordance appears
   exactly where the value is.*

2. **Tier 2 scope.** Full dev server + Playwright (accurate, heavy, needs a
   browser dependency in the container) vs. a static production build served
   from disk (lighter, but misses client-only routes)?
   *Recommendation: dev server + Playwright. The whole point is comparing
   against what actually renders, and `playwright.config.ts` already exists.*

3. **CSS write-back scope for M3.** Full `postcss` CST round-trip on the user's
   `.css` files, or start with "Tailwind projects get class edits, plain-CSS
   projects get declaration edits, everything else stays preview-only"?
   *Recommendation: the second — it covers most real repos at a fraction of the
   risk, and the target chip already tells the truth about the rest.*

4. **`studio.instance` and the publisher.** Studio boards are not published
   today. Does a fragment node need a publisher representation at all, or does
   it stay a studio-only module (simplest, and consistent with the filesystem
   being the source of truth)?
   *Recommendation: studio-only. Publishing a studio board is a different
   product question.*

5. **Where board frames get their default width.** Per-project
   `frameDefaults` (proposed), a global editor preference, or both with project
   winning? *Recommendation: both, project wins — matches how
   `defaultBreakpoint` already works in editor preferences.*
