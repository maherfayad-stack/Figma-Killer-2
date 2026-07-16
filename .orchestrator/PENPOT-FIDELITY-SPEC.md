# PENPOT-FIDELITY-SPEC — canvas-code-studio P5-rework

**Status:** DRAFT for orchestrator sign-off (2026-07-16). This is the SINGLE
source of truth every P5-rework worker aligns to. Do not diverge from the
values here without an ADR. Verbatim Penpot values were mined from a shallow
clone of `github.com/penpot/penpot` (MPL-2.0); source paths are cited so a
worker can re-check any number.

Two research briefs back this doc (kept in scratchpad, not committed):
`penpot-findings-design.md`, `penpot-findings-workspace.md`.

---

## 0. Why this exists / how to use it

The tool passes every automated gate but FAILS the human-use bar (dogfood):
"most of the functionality doesn't work … doesn't look or function like Penpot
at all." This spec captures **exactly how Penpot looks and behaves** so we can
reach visual + interaction parity, ADAPTED to our non-negotiable constraints:

- **Code-first, filesystem-is-truth.** A "file" IS a folder = a real React app.
  The only editor-owned persistent data is spatial metadata in
  `.studio/canvas.json`. We never build a second scene model.
- **No vector/shape drawing.** Penpot's rect/ellipse/line/path/boolean/mask
  tools and their inspector sections (Stroke/Shadow/Blur/Constraints/SVG-attrs)
  are **OUT OF SCOPE**. Layers = the AST tree of real JSX. We mirror Penpot's
  *chrome, layout, iconography, and interaction feel*, not its vector engine.
- **RTL-first** (Almosafer is Arabic-first) — logical CSS props only.

When Penpot behavior and our constraints collide, the constraint wins and the
adaptation is spelled out in §7 ("Code-first adaptations").

---

## 1. Licensing (icons + fonts) — READ BEFORE VENDORING

- **Icons:** Penpot's ~317 SVGs are **Kaleidos/Penpot original artwork under
  MPL-2.0** (no Tabler/Feather/FontAwesome attribution anywhere in the repo).
  MPL-2.0 permits reuse/modification. Obligation: any vendored/modified icon
  file must keep an MPL-2.0 notice and we must be able to disclose source.
  **Plan:** vendor only the ~30 icons we need into
  `packages/ui/src/icons/penpot/` with a top-level `NOTICE` file crediting
  "Kaleidos INC — Penpot, MPL-2.0" + the upstream commit SHA. Flag for a legal
  glance before public launch; fine for internal build now.
- **Fonts:** WorkSans + Vazirmatn are both **OFL** (open, free to bundle).
  Vazirmatn is a first-class Arabic/RTL variable font — directly useful for our
  RTL-first requirement. Bundling is allowed with the OFL license file kept.

---

## 2. Design tokens — Penpot dark theme → our `--ccs-*` port

Penpot ships two themes: `.light` (brand purple accent `#6911d4`) and `.default`
(near-black dark, **mint accent `#7efff5`** — NOT purple in dark). Our chrome is
dark-only (`color-scheme: dark`), so we port the **`.default`** theme.
Source: `frontend/src/app/main/ui/ds/colors.scss` +
`frontend/resources/styles/common/refactor/design-tokens.scss`.

> **OPEN DECISION D1 (accent):** faithful Penpot-dark accent is **mint
> `#7efff5`**. Our current chrome uses violet `#7c7cff`. Recommendation: adopt
> mint for true fidelity. If we want to keep an Almosafer-brand accent instead,
> say so and we deviate deliberately (documented, not by accident).

### 2.1 Port table (rewrite `packages/ui/src/tokens.css`)

| our `--ccs-*` var | Penpot semantic token | dark value |
|---|---|---|
| `--ccs-bg-canvas` (app/panel base) | `background-primary` | `#18181a` |
| `--ccs-bg-deepest` (NEW) | `background-secondary` | `#000000` |
| `--ccs-bg-panel` | `background-primary` | `#18181a` |
| `--ccs-bg-panel-raised` | `background-tertiary` | `#212426` |
| `--ccs-bg-hover` | `background-secondary`/tertiary | `#212426` |
| `--ccs-bg-selected` (row selected) | `background-quaternary` | `#2e3434` |
| `--ccs-bg-input` | `background-tertiary` | `#212426` |
| `--ccs-canvas-backdrop` (NEW) | `color-canvas` | `#bfbfbf` (mid-gray, BOTH themes — frames sit on gray) |
| `--ccs-border` (panel border) | `background-quaternary` | `#2e3434` |
| `--ccs-border-strong` | — | `#3a4040` |
| `--ccs-text` | `foreground-primary` | `#ffffff` |
| `--ccs-text-muted` | `foreground-secondary` | `#8f9da3` |
| `--ccs-text-subtle` | (dim of secondary) | `#6a767c` |
| `--ccs-icon` (NEW, default icon stroke) | `icon-default` | `#8f9da3` |
| `--ccs-icon-hover` | `foreground-primary` | `#ffffff` |
| `--ccs-icon-active` | `accent-primary` | `#7efff5` |
| `--ccs-accent` | `accent-primary` | `#7efff5` (D1) |
| `--ccs-accent-muted` | `accent-primary-muted` | `#426158` |
| `--ccs-accent-component` (layer=component-instance) | `accent-secondary` | `#bb97d8` |
| `--ccs-success` (fg / bg) | `accent-success` / bg | `#2d9f8f` / `#0a2927` |
| `--ccs-warning` (fg / bg) | `accent-warning` / bg | `#fe9c07` / `#3d2501` |
| `--ccs-danger` (fg / bg) | `accent-error` / bg | `#c80857` / `#500124` |
| `--ccs-danger-fg` | `foreground-error` | `#ff3277` |
| `--ccs-info` (fg / bg) | `accent-info` / bg | `#0e9be9` / `#082c49` |
| `--ccs-locked` | `accent-warning` | `#fe9c07` |

Component-level mappings to honor (from `design-tokens.scss`):
`layer-row selected bg = background-quaternary (#2e3434)`,
`layer-row selected fg = accent-primary (mint)`,
`layer-row component fg = accent-secondary (#bb97d8)`,
`sidebar selected element = background-quaternary bg + accent-primary fg`,
`search input bg = background-tertiary`, focus border = accent-primary,
`menu/dropdown bg = background-tertiary`.

### 2.2 Spacing, radius, sizes, elevation, layout

Source: `ds/spacing.scss`, `ds/_borders.scss`, `ds/_sizes.scss`,
`ds/elevations.scss`, `constants.cljs`.

```
spacing (4px base): --ccs-space-1..: 2, 4, 8, 12, 16, 20, 24, 32
  (Penpot: xxs2 xs4 s8 m12 l16 xl20 xxl24 xxxl32)
radius: 4 / 6 / 8 / 12 / 50%.  STANDARD = 8px (buttons, panels, toolbar, cards)
elevation: ONE shadow only → 0 0 10px 0 rgba(0,0,0,.6). Menus use 0 0 12px.
  Penpot uses background-layer contrast for depth, NOT shadow stacks.
```

Layout dims (REPLACE our current `--ccs-dock-width:280` etc.):
```
--ccs-sidebar-left-width : 318px  (min 318, max 500)   ← was 280
--ccs-sidebar-right-width: 318px  (max 768)            ← was 280
--ccs-header-height      : 52px                        ← was 48
--ccs-row-height         : 32px   (layer row, panel title, page row, button)
--ccs-row-height-compact : 24px   (icon-action buttons)
--ccs-statusbar-height   : 28px   (keep)
--ccs-layer-indent       : 24px   (--sp-xxl; per-depth indentation)
```

### 2.3 Typography

Source: `ds/typography.scss`.
```
font family : "WorkSans", "Vazirmatn", system-ui, sans-serif   (D2 below)
mono        : "Roboto Mono", ui-monospace, monospace
weights     : 400 regular, 500 medium
line-heights: dense 1.2, compact 1.3, normal 1.4
```
Named styles we use:
| role | style | size / weight / lh / transform |
|---|---|---|
| panel title, sidebar section label | `headline-small` | 12 / 500 / 1.2 / **UPPERCASE** |
| layer row / page row / list text | `body-small` | 12 / 400 / 1.3 |
| body | `body-medium` | 14 / 400 / 1.4 |
| section heading (dashboard) | `title-small` | 14 / 400 / 1.2 |
| code / uid / token value | `code-font` | 12 / 400 / 1.2 (mono) |

> **OPEN DECISION D2 (fonts):** adopt WorkSans+Vazirmatn (true fidelity + real
> RTL font) vs keep our current Inter. Recommendation: adopt (bundle OFL fonts
> into `packages/ui`). Vazirmatn is a genuine win for the Arabic requirement.

---

## 3. Icon system (vendor Penpot SVGs → `@ccs/ui` `<Icon>`)

Penpot: raw 16×16 SVGs → built into a sprite, referenced via `<use href="#icon-…">`.
Sizes `s=12 / m=16(default) / l=32`. Stroke icons use `stroke: currentColor`
with rounded caps/joins; a handful (component/group/rectangle/img) are filled.
Color + stroke-width applied by the CONSUMER via CSS, never baked in.
Source: `ds/foundations/assets/icon.cljs`, `resources/images/icons/*.svg`.

**Plan:** build `packages/ui/src/icons/` — an `<Icon name size />` React
component (inline `<svg>` with `stroke:currentColor`, sizes 12/16/32), backed by
the vendored SVGs. Replace ALL emoji/text glyphs in Toolbar/Layers/etc.

### Icon inventory (need → Penpot file, under `resources/images/icons/`)

| need | file |
|---|---|
| frame / board | `board.svg` |
| group | `group.svg` |
| text | `text.svg` |
| component (master) | `component.svg` |
| component instance/copy | `component-copy.svg` |
| image | `img.svg` |
| path/shape node | `path.svg` |
| show (eye) | `shown.svg` |
| hide (eye-off) | `hide.svg` |
| lock / unlock | `lock.svg` / `unlock.svg` |
| disclosure chevron | `arrow.svg` (rotate) / `expand.svg` |
| page | `document.svg` |
| assets/library | `library.svg` |
| tokens | `tokens.svg` |
| color swatches | `swatches.svg` |
| typography | `text-typography.svg` |
| move/select tool | `move.svg` |
| comment | `comments.svg` |
| pen/path tool | `pentool.svg` |
| add / plus | `add.svg` |
| search | `search.svg` |
| grid view / list view | `view-as-icons.svg` / `view-as-list.svg` |
| kebab menu | `menu.svg` |
| settings | `settings.svg` |
| user/avatar | `user.svg` |
| delete/trash | `delete.svg` |

Gaps (Penpot has no such icon — use judgment): **pan/hand** (Penpot pans via
space+drag, no tool button), **zoom** (numeric % control, not an icon),
**duplicate/rename** (text menu items, no dedicated icon — reuse `component-copy`
for duplicate if an icon is wanted).

---

## 4. Dashboard spec

Source: `dashboard.scss`, `dashboard/{sidebar,grid,files,projects}.{cljs,scss}`.

```
root grid: grid-template-columns: 40px 256px 1fr   (mini-rail | sidebar | content)
           grid-template-rows:    52px 1fr          (header | body)
           height 100vh, bg var(--app-background)
```
- **Mini-rail (40px):** thin left strip (Penpot: team/nav). For us: minimal —
  logo + maybe a settings/user glyph. Keep it but light.
- **Sidebar (256px):** sections stacked with 24px gap: team/workspace switcher
  (48px tall, radius 8, 1px border) → **search bar** (input 40px, radius 8, bg
  tertiary) → nav links (hover bg = sidebar-hover, selected bg = quaternary) →
  pinned/projects (flex-grow) → **profile footer** (40×40 circular avatar, 1px
  top border). Section labels = headline-small uppercase, foreground-secondary.
- **Content:** own header row (64px) + scroll body, padding `16px 16px 0 0`.
  Projects/files grid: `grid-auto-flow: column`, gap 24px.
- **File card:** thumbnail **252×168**, radius 8, `background-size: cover`.
  Hover reveals kebab (opacity 0→1) + 2px `accent-tertiary` selection overlay.
  Info block padding 8px: title 16px (h3, 28px tall, ellipsis) + date row 12px
  secondary. Dragged card: 4px accent-primary outline, +12px width.
- **"Add file" placeholder:** 1px dashed foreground-secondary; hover inverts to
  filled bg + 2px accent-tertiary border.
- **Empty state:** centered icon + text (Penpot `ds/product/empty_state`).
- Responsive: single breakpoint 1366px (text truncation only, no relayout).

**Our adaptation:** we have local projects (localStorage registry), not teams.
Keep the 3-column shell but the mini-rail is decorative/minimal; "projects" =
our project entries; a card thumbnail can be a frame screenshot or folder name
placeholder. Create/Duplicate/Delete move into the hover kebab menu (not three
always-visible buttons like today).

---

## 5. Workspace spec (the editor)

Source: `workspace/sidebar.cljs`, `sidebar/{sitemap,layers,layer_item,assets}.cljs`,
`right_header.cljs`, `sidebar/options.cljs`, `top_toolbar.cljs`,
`viewport/actions.cljs`, `data/workspace/shortcuts.cljs`.

### 5.1 Frame / layout

Penpot has **no single global top bar** — a **left header** and a **right
header**, each pinned atop its own sidebar, flanking the viewport. The toolbar
**floats over the canvas** (not a grid row).

```
┌ left header (52) ┬───────────── viewport ─────────────┬ right header (52) ┐
│ logo, file name, │   [floating toolbar overlays here]  │ avatars, zoom     │
│ menu ≡           │                                     │ widget, comments  │
├ [Layers|Assets|Tokens] tabs ┤                          ├ [Design|Inspect] ┤
│  PAGES (sitemap)  ▸ collapsible/resizable (default 200,│  Design sections │
│  ───── splitter ─────  min 38, up to 60% height)       │  (stack, §5.5)   │
│  LAYERS tree (fills remaining, scrollable)             │                  │
└ 318px (min318 max500) ┴────────────────────┴ 318px (max768) ┘
```

> **Current-state gap:** our `WorkspaceShell` uses a single global top bar + a
> 3-col grid with a 280px left dock whose tabs are **Pages / Layers / Assets /
> Tokens (four separate tabs)**. Restructure to: **left header** + tabs
> **Layers / Assets / Tokens**, where the **Layers tab contains BOTH Pages
> (top) and the Layers tree (below), split by a resizable/collapsible divider.**

### 5.2 Left tab = Pages(sitemap) stacked over Layers tree  ← THE key change

- One `article.layers-tab`: `sitemap*` (Pages) on top, a horizontal `ns-resize`
  splitter, then `layers-toolbox*` (Layers tree) filling the rest.
- Pages section collapsible to a 32px title strip; height persisted.
- **Tabs of the left sidebar are: Layers / Assets / Tokens.** ("Pages" is NOT a
  top-level tab — it lives inside Layers.)

### 5.3 Pages ("sitemap") behavior

- Title bar "Pages" + collapse chevron + **Add page (+)** icon button.
- Row (32px): `document` icon + name (ellipsis) + delete (trash) on hover
  (only if >1 page). Double-click name = inline rename. Drag = reorder.
  Click = navigate (switch current page). Selected row = quaternary bg.
- A page literally named `---` renders as a separator rule.
- Context menu (right-click page): Delete / Rename / Duplicate.

> **OPEN DECISION D3 — what is a "page" in our filesystem model?**
> The user said "pages mean whole canvas." Proposed default (respects the One
> Rule — pages are pure spatial metadata): **a page = one canvas SURFACE
> (a tldraw page) persisted in `.studio/canvas.json`; the frames (real React
> frame files in `src/frames/`) are the BOARDS placed on the current page.**
> Default project has one page "Page 1" holding all frames. Adding a page adds a
> spatial surface only (no source files created). This means the frames that are
> "pages" TODAY become **boards in the Layers tree**, and Pages becomes the
> higher-level surface switcher. Confirm or correct before WS-3 starts.

### 5.4 Layers tree behavior (row = 32px)

Row grid: `[disclosure ▸][type icon][name][spacer][hide][lock]`.
- Indentation = `depth * 24px` via CSS var (no nested `<ul>`).
- Disclosure triangle only when node has children; rotates 90° when open.
  Shift+click = collapse-all; Alt+click = expand whole subtree.
- Type icon from node kind (board/group/text/component/image/path). Double-click
  icon = zoom canvas to that node.
- Name: double-click = inline rename; Tab / Shift+Tab hop to sibling.
- Row state classes: selected (quaternary bg, mint fg), highlight (hover→canvas
  sync), hidden (dim), component (accent-secondary tint), root-board sticky
  header while scrolling.
- Hide (eye) / Lock actions: right-aligned, appear on hover/selection.
- Selection: click = single; Cmd/Ctrl+click = additive; Shift+click = range.
- Drag-drop: top/bottom third = reorder sibling; center third of a
  container-row = reparent INTO it; hold over collapsed row = spring-load expand.
- Search/filter bar (Cmd/F) + type-filter chips + find&replace — NICE-TO-HAVE,
  not P5-rework-blocking.

### 5.5 Right sidebar — Design tab section stack

Penpot order (per shape): `Layer → Measures → [Component] → Layout container →
[Grid cell] → [Layout item] → Constraints → Fill → Stroke → [Color selection] →
Shadow → Blur → [SVG attrs] → [Frame grid] → Exports`. Tabs: Design / Prototype
/ Inspect / Debug (Inspect = read-only code/CSS export view).

**Our code-first adaptation (§7):** keep the *visual pattern* (ordered stack of
collapsible sections, headline-small titles) but the sections are code-relevant:
`Layer (name/uid)` → `Content (text)` → `Layout (flex/tailwind classes)` →
`Spacing (padding/gap)` → `Typography` → `Fill (token bind)` → `Component props`
(when instance) → `Code / Open in IDE`. Drop Stroke/Shadow/Blur/Constraints/
SVG-attrs/Frame-grid (vector-only). A `dynamic` node stays read-only + "Open in
IDE" (existing behavior — keep).

### 5.6 Assets panel

Grouping is **3-level: library → asset type (Components/Colors/Typographies) →
folder path**. Header: manage-libraries button, search, sort toggle, filter
popover (All/Components/Colors/Typography), grid⇄list toggle (persisted).
**Our adaptation:** one "local library" = the Almosafer DS catalog (P4 engine).
Components section = draggable thumbnails/list that instantiate on drop (we have
insert). Colors + Typographies = read from token model. Folder grouping by the
component `category`/path.

### 5.7 Tokens panel

Third left tab. Penpot `workspace/tokens/` = token sets tree + theme switcher +
token CRUD + DTCG import/export. We already have this shape in `TokensPanel.tsx`;
restyle to Penpot fidelity and keep the P4 engine wiring. (Persistence to
`design-system` remains a carry-forward CR.)

### 5.8 Toolbar (floating)

Penpot floats a pill toolbar over the canvas: Move(V) / Board(B) / Shapes-flyout
(rect/ellipse/line/arrow) / Text(T) / Image / Draw-flyout(path/curve) / plugins.
**Our adaptation (no vector):** Move/Select(V) · Frame(F, creates React frame) ·
Insert component(I) · Text(T) · Image · Comment(P7 stub). Style as a floating
8px-radius, 2px-border pill overlaying the canvas top-center, real vector icons.

### 5.9 Canvas interactions (pan / zoom / context menu)

- **Pan:** middle-mouse drag; Space+left-drag; plain wheel = vertical pan;
  Shift+wheel = horizontal pan.
- **Zoom:** Cmd/Ctrl+wheel zooms at cursor. Keyboard `+`/`-`, `Shift+0` reset,
  `Shift+1` fit-all, `Shift+2` zoom-to-selection.
- **Context menu:** one component, contents by kind — `shape/layer`, `page`,
  `viewport(empty)`. Our viewport menu (minimal): Paste / Hide UI. Our layer
  menu (already partly built): Copy/Paste/Duplicate/Wrap/Delete/Open-in-IDE.
- tldraw already provides pan/zoom/select out of the box (our P1 `StudioCanvas`
  used stock tldraw and it WORKED). See §6 regression.

---

## 6. Known functional breakage to fix (from dogfood + QA)

These are BLOCKERS independent of the visual pass:

1. **DS component insert crashes the frame (top blocker).** `insert-node`
   writes `import … from 'design-system'` but a file-app can't resolve
   `design-system` (no dep/alias/node_modules). Crashed frame → no DOM →
   selection/inspector/layers/editing all die. Fix: daemon `studio-vite-config`
   injects a `design-system` alias → the DS `dist`, and we build the DS `dist`.
   (Do NOT restructure `design-system/`; it's an external gitignored repo — only
   add the alias + ensure a built `dist`.)
2. **Canvas pan/move/context-menu "no longer work"** (user, 2026-07-16). P1's
   stock-tldraw canvas worked; something in the P5 chrome regressed it.
   Suspects to verify LIVE first: an overlay/pointer-events trap over the
   `canvas-area`, a JS crash from a broken frame (see #1) killing the editor, or
   `MINIMAL_COMPONENTS` hiding tldraw's context menu. Reproduce in a browser,
   read console errors, then fix. Do NOT guess-patch.
3. **Camera doesn't fit** frames on project open / frame select — add
   zoom-to-fit (`Shift+1` behavior) on open and zoom-to-selection on select.
4. **Layers didn't populate** from selection in QA — verify the
   `currentTree()`/`selectedNode()` live-snapshot wiring end-to-end against a
   real rendered frame (the earlier fix was code-level; re-verify in browser).

---

## 7. Code-first adaptations (Penpot feature → our equivalent)

| Penpot | us (code-first) |
|---|---|
| Free vector shapes (rect/ellipse/path/bool/mask) | **none** — we edit real JSX |
| Layers = scene objects | Layers = **AST tree** (buildTree over source) |
| Page = canvas surface w/ boards | Page = **tldraw surface in canvas.json**; frames = boards (D3) |
| Move/resize shapes → scene | Move/resize FRAME → `.studio/canvas.json` geometry (spatial only) |
| Inspector Measures/Stroke/Shadow/Blur | **dropped**; Layout/Spacing/Typography/Fill via Tailwind classes + tokens |
| Assets library (drawn components) | Almosafer **DS catalog** (P4 engine), insert = real import + JSX |
| Hide/Lock shape flags | studio-only visual aids in `canvas.json` (not source) |
| Inspect/dev-mode = CSS export | "Open in IDE" + read-only for `dynamic` nodes |
| Comments | **P7** (not in this rework) |

---

## 8. Spec → our files → workstreams

Proposed workstream partition (sequential per session-limit memory; each is one
fresh Sonnet worker, no git — orchestrator commits + gates):

- **WS-1 Foundations** (`packages/ui`): port tokens (§2) into `tokens.css`;
  bundle WorkSans/Vazirmatn (D2); build `<Icon>` + vendor the ~30 SVGs (§3) with
  NOTICE. Acceptance: every primitive + panel renders with new tokens/icons; no
  emoji glyphs remain.
- **WS-2 Dashboard** (`apps/studio/src/dashboard`): rebuild to §4 shell (rail +
  sidebar + content grid, cards with hover kebab). Acceptance: matches §4 dims;
  create/duplicate/delete via kebab.
- **WS-3 Left panel restructure** (`apps/studio/src/workspace` + minimal
  `packages/canvas` for pages): Pages+Layers in one tab (§5.2/5.3), page
  semantics per D3, layers tree fidelity (§5.4). Acceptance: pages switch canvas
  surfaces; frames appear as boards in the tree; tree row anatomy matches §5.4.
- **WS-4 Assets + Tokens** (`apps/studio/src/workspace`): §5.6/5.7 structure.
- **WS-5 Right Inspector** (`apps/studio/src/workspace`): §5.5 code-first stack.
- **WS-6 Canvas + functionality** (`packages/canvas`, `packages/sync-daemon`):
  §6 blockers — DS resolution (#1), pan/context-menu regression (#2), camera
  fit (#3), layers-from-selection (#4), floating toolbar restyle (§5.8).

**Gate:** REAL browser dogfood (drive it, screenshot every panel, insert a
component and confirm the frame still renders + is editable, pan/zoom/context
menu by hand) — NOT scripted e2e alone. Per `dogfood-ui-before-gating` memory.

Suggested order: **WS-6 (#1 DS resolution + #2 regression) FIRST** (unblocks
"can't edit anything"), then WS-1 (foundations everything else builds on), then
WS-3, WS-2, WS-4, WS-5, then re-gate.

---

## 9. Open decisions for the human (blocking sign-off)

- **D1 accent:** mint `#7efff5` (faithful) vs keep violet vs Almosafer brand.
- **D2 fonts:** adopt WorkSans+Vazirmatn (faithful + RTL) vs keep Inter.
- **D3 page semantics:** confirm "page = canvas surface in canvas.json, frames =
  boards on it" (the proposed default), or define differently.
- **Scope confirm:** WS-1..6 as above, sequential, code-first, no vector, then
  real-browser re-gate. OK to proceed after D1–D3?
