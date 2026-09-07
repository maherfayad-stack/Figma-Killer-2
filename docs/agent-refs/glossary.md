# Glossary

Terms that mean something specific here. Alphabetical.

**`.studio/`** — per-project sidecar directory inside a workspace. Holds
`meta.json` (displayName, pagesDir, previewAxes, `trust`, cached probe profile),
`boards.json` (frames, notes, docs), `framework.json` (color/type/spacing
tokens), `fonts.json` (the installed font library — `@font-face` entries plus
the `var(--font-*)` tokens bound to them; a sibling of `framework.json`, not a
field inside it, because `settings.fonts` and `settings.framework` are separate
`SiteSettings` fields), `comments.json` (review threads), `prototype.json` (authored links),
`shares.json` (share-link registry), `thumbnail.png` (the launcher tile's 4:3
preview — W7-3), `references/` (design references) and
`cache/` (compiled styles, component bundles, design-system digests). Excluded
from imports and downloads. Its presence marks a directory as a real studio
workspace — the GitHub import refuses to clear one.

**Board** — the 2D canvas holding every page of a project as a positioned frame.
Model in `src/core/studio-board/`. Persisted to `.studio/boards.json`.

**`BoardFrame`** — one page rendered at `(x, y)` with optional `width`/`height`.
Missing dimensions fall back to `FRAME_WIDTH`/`FRAME_HEIGHT` at render time, so
old boards open unchanged with no migration.

**Breakpoint / viewport context** — a named width the canvas can render a
document at. Studio boards use frames instead; breakpoints remain the mechanism
behind style overrides and `activeBreakpointId`.

**Capture token** — the single-purpose credential the headless capture page
(`/admin/agent-capture`) authenticates with, minted by the server for ONE
capture and revoked in the driver's `finally`
(`server/ai/mcp/capture/captureToken.ts`). It carries **no capabilities** — a
grant is not a principal. It authorises exactly two reads, both scoped to the one
project directory recorded in the grant: that capture's payload and the local
image assets its pages reference. `dir` comes from the grant, never the query
string, so there is no traversal surface. In-memory, per-process, minutes-long
TTL as a safety net rather than the boundary. Deliberately not the operator's
session cookie — taking a picture of a parsed page needs none of that authority.

**Code-derived connector** — a flow edge Studio READ out of the project's own
navigation code (`src/core/studio-prototype/codeFlow.ts`), not one the user
drew. Recomputed on every load, never persisted — a stale claim about what the
code does is worse than no claim. It has no transition and no `NodeHint`
(nothing to re-anchor), and it carries `via`: the literal snippet the fact came
from, so a read-only connector the user cannot delete can answer "why do you
think that". Contrast **`PrototypeLink`**, the authored design-layer artefact.

**`codeProps`** — the list of prop names on a node with **no writable source
target**, because the source holds an expression rather than a literal. Inline
styles appear as `style:<property>`. About *values*. Contrast **locked**.

**Composite node id** — `callSiteId~componentNodeId`. An inlined component's node
id. Split on `~` and keep the **tail** before any writeback.

**Design frame vs live frame** — design frames grow to content, don't scroll, and
receive editor chrome CSS; live frames are 100% height and scroll natively. Both
are editable.

**Detach** — replace a component call site with the component's own JSX,
substituted with the call site's arguments. The Figma verb.
`src/core/ast-codemods/detachComponent.ts`; its siblings are
`extractComponentCopy.ts`, `extractSubtreeToComponent.ts` and
`swapComponentInstance.ts`, all sharing `resolveComponentCallSite`.

**`fromComponent`** — set on an inlined node, naming the component whose file
backs it. Drives `SharedComponentNotice` and its instance count.

**Frame virtualization** — mounting only frames intersecting the viewport plus a
margin. `frameVirtualization.ts`, pure board→screen math.

**Inlining** — expanding a local component's JSX at its call site so the canvas
shows real markup. The call-site node is **replaced**, not wrapped.

**Instance** — a node representing a component call site that renders **no DOM
element** (a React Fragment), so props become editable and swap/detach become
possible without reintroducing a wrapper box. The `studio.instance` module is
`src/modules/base/instance/`.

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

**Package component** — a JSX component imported from a bare specifier. It
becomes a `pkg.<sanitized-package>.<ComponentName>` module
(`src/core/module-engine/packageModuleId.ts`), whose prop surface comes from
`packageManifest.ts`'s purely-syntactic `ComponentSpec` extraction (Tier 0) and
whose rendering comes from the bundled real component (Tier 1,
`componentBundle.ts`). Below Tier 1 the canvas shows
`PackageComponentPlaceholder.tsx` with the promote button.

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

**Share token** — `shr_` + 43 base64url characters of 32 random bytes, the
credential in a `/share/<token>` URL (`src/core/studio-share/shareWire.ts`). Its
shape regex runs BEFORE the token is ever joined into a filesystem path, so
traversal is unreachable rather than merely detected; containment is re-checked
on the resolved real path anyway. Registry in `.studio/shares.json`, re-read on
every public request — which is what makes revocation immediate. A revoked
record is kept; only the bytes are deleted. See **Share link**.

**Share link** — a read-only board snapshot at a revocable public URL. The
viewer (`src/admin/shareViewer/`, Vite's third HTML entry) sees only
`SharedBoardSchema`: a project name, a board name, a timestamp, and per frame a
display name, a rectangle and an opaque image filename. No page id, no source
path, no node id, no style rule, no workspace directory. A share is a picture of
the work, not a copy of it. Every failure — bad token, revoked token, missing
file — is the same 404. Docs: `docs/features/studio-share.md`.

**`spliceReference`** — the operation that replaces a call-site node with the
component's root nodes.

**`StudioEdit`** — one typed edit in a save batch: `prop` \| `text` \| `style` \|
`tag` \| `literal` \| `asset` \| `styled` \| the structural `move`/`delete`/
`insert` kinds. Each maps to one AST or CSS codemod.

**`studio-asset:` sentinel** — what an image import resolves to during parsing.
Rewritten to `/admin/api/studio/asset?dir=…&path=…` once `dir` is in scope.

**Studio mode** — *historical.* Studio is now the only editor mode: the editor
lives at `/admin/site`, `src/admin/router.tsx` renders it unconditionally, and
`studioMode.ts` / the `?studio` query param are gone. Which project is open comes
from `studioWorkspaceDir.ts` (localStorage-sticky, set by the Overview
launcher). If you find a doc, comment or test still branching on "studio mode",
that is drift.

**Styled-template writeback tier** — the fourth thing a style declaration can
live in, beside an inline `style`, an authored stylesheet rule and a generated
utility class: a `styled.div` / `css` tagged template inside a `.tsx`
(`src/core/ast-codemods/setStyledDeclaration.ts`, edit `kind: 'styled'`).
ts-morph re-finds the template at the recorded `line:col` and hands postcss each
quasi's RAW text with its source offset, so the selector a write matches is the
selector the canvas showed. **Every `${…}` is a hole on the write side**,
including interpolations the parser resolves for rendering — editing
`padding: ${SPACING.md}` would change every other reader, so it refuses.
Refusals are named: `interpolated-value`, `declaration-not-in-template`,
`unwritable-value`, `template-not-found`, plus the ordinary duplicate/shorthand/
`!important` verdicts forwarded verbatim. Reported to the panel as
`classCssWritability`'s `styled-template` kind.

**Tiers (A/B/C/D)** — the static evaluator's explicit capability boundary.
A = literals/consts/members/operators. B = hook → context provider.
C = pure calls in a narrow envelope. **D = banned** (branch selection, state,
effects, async). Not to be confused with **trust tiers** below.

**Trust tiers** — the per-project permission to run any of the user's own
toolchain, stored as `.studio/meta.json`'s `trust` field and read/written by
`server/handlers/studio/trustTier.ts`. Three values:

- **Tier 0 — `static`** (the default; never auto-promoted). Nothing of the
  user's ever runs. Parse, CSS Modules transform, vendor `.css` reads.
- **Tier 1 — `render-packages`**. Buys exactly two things: the workspace's own
  style toolchain (Sass / PostCSS / Tailwind) compiles in a capped subprocess
  (`styleCompileTier1.ts` → `styleCompileWorker.ts`), and its package components
  are bundled and rendered on the canvas (`componentBundle.ts` →
  `componentBundleWorker.ts`).
- **Tier 2 — `run-project`**. What `deploy.ts` gates on: a preview deploy builds
  the project, which runs its code.

**The parse itself never executes anything at any tier**, and promotion is always
an explicit user click (`promoteProjectToTier1`, the consent banner, the
placeholder's promote button) — never a side effect of loading a page. Gates that
only need "above Tier 0" read `trust !== 'static'`.

**Unroll** — neutralizing inner scroll containers on the design canvas so a whole
app screen is visible in one frame (`canvasScrollUnroll.ts`,
`CanvasScrollUnrollInjector.tsx`). Scoped to a CONFIRMED scroll region
(`[data-studio-unroll-overflow-y="auto"|"scroll"]`), never the universal
selector — a clip mask and an ellipsis container are not scroll regions.

**Warm CLI session** — one long-lived `claude` subprocess serving many turns of
ONE conversation (`server/ai/drivers/claudeCliWarmSession.ts`, pooled by
`claudeCliSessionPool.ts`, protocol in `claudeCliStdinProtocol.ts`). The cold
shape — spawn, write the prompt, read to exit — paid a full process start plus an
`initialize` handshake with every attached MCP server on every turn; warm, turn
N+1 costs one line of NDJSON. It yields the exact same event type as the cold
path, so the consuming loop is byte-for-byte identical. **The cold path remains
as the crash-recovery mechanism, not as a legacy shim**: a dead process throws
`ClaudeCliWarmSessionDeadError` and the caller silently re-runs the turn cold.

**Workspace / project** — one directory under `studio-workspace/`. A real React
repo. The unit a board, a `.studio/` sidecar, and an import target all belong to.

**Writeback** — turning a canvas edit into an AST change in the user's source
file. Always through `src/core/ast-codemods/`.
