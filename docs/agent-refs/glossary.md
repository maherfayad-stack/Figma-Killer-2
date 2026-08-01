# Glossary

Terms that mean something specific here. Alphabetical.

**`.studio/`** — per-project sidecar directory inside a workspace. Holds
`meta.json` (displayName, pagesDir, previewAxes), `boards.json` (frames, notes,
docs), `framework.json` (color/type/spacing tokens). Excluded from imports and
downloads. Its presence marks a directory as a real studio workspace — the
GitHub import refuses to clear one.

**Board** — the 2D canvas holding every page of a project as a positioned frame.
Model in `src/core/studio-board/`. Persisted to `.studio/boards.json`.

**`BoardFrame`** — one page rendered at `(x, y)` with optional `width`/`height`.
Missing dimensions fall back to `FRAME_WIDTH`/`FRAME_HEIGHT` at render time, so
old boards open unchanged with no migration.

**Breakpoint / viewport context** — a named width the canvas can render a
document at. Studio boards use frames instead; breakpoints remain the mechanism
behind style overrides and `activeBreakpointId`.

**`codeProps`** — the list of prop names on a node with **no writable source
target**, because the source holds an expression rather than a literal. Inline
styles appear as `style:<property>`. About *values*. Contrast **locked**.

**Composite node id** — `callSiteId~componentNodeId`. An inlined component's node
id. Split on `~` and keep the **tail** before any writeback.

**Design frame vs live frame** — design frames grow to content, don't scroll, and
receive editor chrome CSS; live frames are 100% height and scroll natively. Both
are editable.

**Detach** *(planned, WS-4)* — replace a component call site with the component's
own JSX, substituted with the call site's arguments. The Figma verb.

**`fromComponent`** — set on an inlined node, naming the component whose file
backs it. Drives `SharedComponentNotice` and its instance count.

**Frame virtualization** — mounting only frames intersecting the viewport plus a
margin. `frameVirtualization.ts`, pure board→screen math.

**Inlining** — expanding a local component's JSX at its call site so the canvas
shows real markup. The call-site node is **replaced**, not wrapped.

**Instance** *(planned, WS-4)* — a node representing a component call site that
renders **no DOM element** (a React Fragment), so props become editable and
swap/detach become possible without reintroducing a wrapper box.

**`locked` / `lockReason`** — the node's **structure** is not simply placed by the
source (a `.map` made it, a branch chose it, a spread feeds it). Blocks move,
delete, reorder, wrap. Says nothing about whether its props are editable.

**`nodeVisualRect`** — geometry helper returning the union of an element's
children when the element itself has no box (`display: contents`, fragments).
Keeps box-less nodes selectable and droppable.

**Origin (`ValueOrigin`)** — workspace-relative path + 1-based line/column of the
**literal a resolved value physically came from**. Attached at the single place a
literal is read, so passing a value along carries it for free and computing a
value cannot. `textOrigin` is the text-scoped one.

**Package component** — a JSX component imported from a bare specifier. Left as
an opaque `alm.*` node today with a read-only prop surface.

**`ParsedPage` / `ParsedNode`** — the parser's own output shape, before
`parsedPageToSitePage` converts it into the editor's `Page`.

**preferred key / `preferredKey`** — which dictionary branch Tier B picks when a
value indexes a translations object with runtime state (`translations[lang]`).
Unset means first key in source order. The choice is recorded in
`resolution.note`. Sourced from `PreviewAxes.locale` below (`previewAxes.ts`'s
`projectPreviewLocale`) — genuinely PARSE-TIME, unlike `direction`/`colorScheme`
in the same triple. A pre-WS-10-§4.2 project's legacy top-level `previewLocale`
JSON field still parses and is folded into `previewAxes.locale` on read
(`studioMeta.ts`'s `foldLegacyPreviewLocale`) — nothing downstream reads that
legacy field name any more.

**`PreviewAxes`** (WS-10) — the board's preview triple: `direction`
(`'ltr'|'rtl'`) and `colorScheme` (`'light'|'dark'`) are RENDER-TIME (an
attribute effect on the frame document — `dir`, `lang`, `data-studio-scheme` —
never a remount, see `docs/agent-refs/canvas-internals.md`'s "Preview axes"
section); `locale` is PARSE-TIME (§4.2, Phase 3 — selects `preferredKey`
above, so changing it re-parses the whole project). Board-global by default,
persisted per project in `.studio/meta.json`'s `previewAxes` field; a
`BoardFrame` can also carry its OWN `axes` override (Phase 2, "duplicate as
variant") for `direction`/`colorScheme` — side-by-side per-frame `locale`
variants are NOT implemented (Phase 4, gated on a second per-`(pageId,
locale)` parsed-tree mechanism this codebase does not have yet).

**Resolution / resolved value** — a value the static evaluator computed from the
AST. Resolving a value **locks that prop** (writing a literal there would replace
the expression). Resolved *text* is the exception — it writes to its origin.

**`spliceReference`** — the operation that replaces a call-site node with the
component's root nodes.

**`StudioEdit`** — one typed edit in a save batch: `prop` \| `text` \| `style` \|
`tag` \| `literal`. Each maps to one AST codemod.

**`studio-asset:` sentinel** — what an image import resolves to during parsing.
Rewritten to `/admin/api/studio/asset?dir=…&path=…` once `dir` is in scope.

**Studio mode** — the editor running against the filesystem instead of the
database. Entered with `?studio`, sticky in localStorage.

**Tiers (A/B/C/D)** — the static evaluator's explicit capability boundary.
A = literals/consts/members/operators. B = hook → context provider.
C = pure calls in a narrow envelope. **D = banned** (branch selection, state,
effects, async).

**Trust tiers** *(planned)* — `static` (never executes) → `render-packages`
(bundles and runs the project's dependencies in the canvas iframe) →
`run-project` (runs the project's dev server). Declared in `.studio/meta.json`.

**Unroll** *(planned, WS-8)* — neutralizing inner scroll containers on the design
canvas so a whole app screen is visible in one frame.

**Workspace / project** — one directory under `studio-workspace/`. A real React
repo. The unit a board, a `.studio/` sidecar, and an import target all belong to.

**Writeback** — turning a canvas edit into an AST change in the user's source
file. Always through `src/core/ast-codemods/`.
