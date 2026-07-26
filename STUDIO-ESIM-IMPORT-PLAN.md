# Plan: generalize Studio's import pipeline to handle real-world React repos

**Validation corpus:** `https://github.com/maherfayad-stack/eSIM` → `journey-screens/`
(also cloned locally at `~/Documents/Github/eSIM/journey-screens`).

**Goal:** a normal React app — local sub-components, per-component CSS imports,
inline SVG icons, hooks for local UI state, an npm design-system dependency —
imports into Studio *in place* and renders on the canvas, with no manual
rewriting of the source repo. eSIM is the corpus that proves it; every gap that
stops one of its screens is a gap the general pipeline closes.

---

## 0. Ground truth (verified by reading the code — do not re-derive)

### 0.1 How a Studio page becomes canvas nodes

```
GET /admin/api/studio/load?dir=<project>
  server/handlers/studio.ts:368-403
    → discoverPageFiles(join(dir,'pages'))            studioProjects.ts:48-50
    → createWorkspaceProject(dir)                     page-parser/componentSources.ts:47-61
    → parsePageFile(file, dir, project)  per page     page-parser/parsePageFile.ts:58
    → resolveComponentSources(...)                    page-parser/componentSources.ts:75
    → parsedPageToSitePage(parsed, {resolveModuleId, resolveTextProp})
                                                      core/studio-sync/parsedPageToSitePage.ts:33
  ← { dir, projectName, pages, componentSources }
src/admin/pages/site/studio/fsCodemodAdapter.ts:190-221  loadSite()
    → site = createDefaultSiteDocument('Studio'); site.pages = pages
```

The source is **never executed as React**. It is structurally parsed with
ts-morph and rendered through the module registry (`NodeRenderer.tsx:207` —
`registry.get(node.moduleId)`, falling back to an "Unknown module" box).

### 0.2 Parser facts (`src/core/page-parser/parsePageFile.ts`)

| Fact | Line | Consequence |
|---|---|---|
| Whole body wrapped in `try/catch` → `{rootIds:[],nodes:{}}` | 63, 76-80 | Parser NEVER throws. Preserve this. |
| `kind` = `/^[A-Z]/.test(name) ? 'component' : 'element'` | 229 | Purely capitalization. No allowlist. |
| Node id = `` `${relFile}:${line}:${column}` `` (tag-name start) | 231-234 | Must stay compatible with `ast-codemods`. |
| Only literal attrs captured (`extractProps`) | 270-312 | Identifiers/calls/templates silently skipped. |
| `style={{…}}` flattened to literal entries only | 324-358 | `var(--x)` values are *dropped* today. |
| `.map()`/ternary/`&&`/spread → `locked:true` + `lockReason` | 240-242, 465-476 | Existing "degrade, don't drop" convention. |
| Nested function scopes skipped when finding the return | 163-166 | Hooks/handlers are invisible to the parser. |
| Least-nested `return` wins | 174-177 | A multi-`return` component yields one snapshot. |

### 0.3 moduleId mapping (`server/handlers/studio.ts:222-233`)

```ts
if (node.kind === 'component') return `alm.${node.name}`
// div|section|main|header|footer|nav|article|aside → base.container
// button → base.button ; a → base.link ; img → base.image
return 'base.text'   // ← h1-h6, p, span, ul, li, label, svg, … ALL land here
```

`base.text` is a **leaf** (`canHaveChildren:false`,
`src/modules/base/text/index.ts:27`) whose `render()` only emits `props.text` —
any nested JSX inside a `<p>`/`<h1>`/`<li>` is silently dropped today.

### 0.4 Styling model — classes, not `className`

- `PageNode.classIds: string[]` → `SiteDocument.styleRules: Record<id, StyleRule>`
  (`src/core/page-tree/siteDocument.ts:76`).
- `StyleRule` (`src/core/page-tree/styleRule.ts:65-129`):
  `{ id, name, kind:'class'|'ambient', selector, order, styles:Record<string,unknown>,
  stylePriorities?, contextStyles:Record<contextId,Record<string,unknown>>,
  contextStylePriorities?, rawCss?, tags?, generated?, createdAt, updatedAt }`
- Property ceiling is **permissive** (`src/core/publisher/classCss.ts:19-66`):
  any syntactically valid property name (kebab/camel/vendor/`--custom`) except a
  3-entry denylist; security is value-level (`sanitiseCssValue`).
- `kind:'ambient'` carries arbitrary selectors (`a:hover`, `.hero .title`).
- `contextStyles` keys are viewport-context ids **or** `ConditionDef` ids
  (`@media`/`@container`/`@supports`) — `SiteDocument.conditions`
  (`siteDocument.ts:73`).
- Single emission engine for publish **and** canvas:
  `createStyleRuleCssEmitter` / `generateClassCSS` (`classCss.ts:331,401`).
- `createDefaultSiteDocument` starts with `styleRules: {}`
  (`store/slices/site/defaults.ts:46`) — a Studio load has an empty registry,
  so there is nothing to reconcile against on first load.

### 0.5 A CSS-text → StyleRule pipeline ALREADY EXISTS

`src/core/siteImport/cssToStyleRules.ts:233` — `cssToStyleRules(cssText, opts)`
→ `{ rules: NewStyleRule[], warnings, assetRefs, conditions: ConditionDef[], fontFaces }`.
Parses with native CSSOM (`CSSStyleSheet.replaceSync`), `getSheetConstructor()`
at :150 falls back to `globalThis.window.CSSStyleSheet`.

**`happy-dom` is a RUNTIME dependency** (`package.json:90`, inside
`dependencies` which spans lines 59-105) — so this pipeline can run
**server-side** in the Bun process, not only in the browser. Confirm at
implementation time by registering happy-dom's window before the call.

Name→id linking reference implementation already exists too:
`src/admin/pages/site/store/slices/site/importLinking.ts` —
`indexStyleRulesByName`, `linkImportedClassNames`, `mergeImportedStyleRules`.
It lives under `src/admin/` so **the server must not import it**; see §5.3.

### 0.6 Hardcoded `pages/` + `.tsx` (every site)

```
server/handlers/studioProjects.ts:48-50  discoverPageFiles → .endsWith('.tsx')
server/handlers/studioProjects.ts:64     pageCountFor      → join(dir,'pages')
server/handlers/studio.ts:372            load
server/handlers/studio.ts:571            create-project scaffold
server/handlers/studio.ts:596            rename (page count)
server/handlers/studio.ts:616            create-page
server/ai/mcp/tools/studioImportTool.ts:73  listImportedPagePaths
```
`.studio/meta.json` is `interface StudioProjectMeta { displayName: string }`
(`studioProjects.ts:76-78`), read tolerantly at :85-103 — trivially extensible.

`createWorkspaceProject` is **already NOT pages-scoped**: it globs
`${root}/**/*.{ts,tsx}` minus `EXCLUDED_WORKSPACE_DIR_NAMES`
(`.studio`, `.git`, `node_modules`, `dist`, `.next`, `.turbo` —
`page-parser/workspaceFiles.ts:14-21`). It only needs `.jsx`/`.js` added.

### 0.7 Design-system coverage — no gap

`src/modules/alm/manifest.generated.json` registers 39 components including
**every** one eSIM uses: `Button, Chip, Tag, Cell, Separator, TabBar,
SegmentedControl, BottomSheet, ActionSheet, GlassButton, TextInput, Snackbar,
ProgressStepper, LinearProgressIndicator, Radio, ListItem`. Nothing to add.

### 0.8 What actually breaks on eSIM today

| eSIM reality | Today's outcome | Fixed by |
|---|---|---|
| Screens live in `src/screens/**`, `.jsx` extension | 0 pages discovered | §1 |
| `<Icon/>`, `<SheetShell/>`, `<StatusBar/>`, `<EsimStatusBanner/>`, … | `alm.Icon` → "Unknown module" box | §2 |
| `<svg>…</svg>` inline icons, `<circle>`, `<path>` | `base.text` leaf, children dropped | §3 |
| `<p>`/`<h1>`/`<li>`/`<span>` wrapping nested JSX | children silently dropped | §4 |
| `import esimChip from '../assets/….png'` | src prop unresolved / 404 | §5 |
| `import './HomepageScreen.css'` + `className="hp-header"` | CSS never reaches the canvas | §6 |
| `{t.homepage.greeting}`, `{PRODUCT_CARDS}`, `` {`${pct}%`} ``, `{t.common.gbLeft(4)}` | **all copy dropped** — literals only (`extractProps` :270, `extractSingleText` :371) | §7 |

The last row is the one that decides whether an import *looks* like the app or
like an empty wireframe. Almost no real app writes visible copy as a bare JSX
string literal — it comes from constants, i18n dictionaries, or props. §7 is
therefore load-bearing, not a nice-to-have.

---

## Implementation stages

Each stage is independently shippable, independently testable, and leaves the
tree green. **Do not start a stage before the previous one's acceptance
criteria pass.** See §10 for the recommended landing order (it is not strictly
1→7; the cheap structural stages land first).

---

## §1 — Configurable page source per project

**Why:** eSIM's screens are at `journey-screens/src/screens/**` as `.jsx`. Any
real repo has its own convention. Restructuring the source repo defeats the
purpose of "import in place".

### 1.1 Extend the meta sidecar
`server/handlers/studioProjects.ts`

```ts
interface StudioProjectMeta {
  displayName: string
  /** Project-root-relative POSIX dir scanned for pages. Default 'pages'. */
  pagesDir?: string
}
```
- `readProjectMeta` (:85): accept `pagesDir` when it is a non-empty string
  that is **not** absolute and contains no `..` segment; otherwise ignore it
  (same tolerant-parse posture `displayName` already has).
- `writeProjectMeta` (:105): pass through (it already `JSON.stringify`s the
  whole object — verify it does not drop unknown keys).
- New export:
  ```ts
  /** Absolute pages dir for a project — meta override or the default 'pages'. */
  export function projectPagesDir(dir: string): string
  ```
  Implement as `join(dir, readProjectMeta(dir)?.pagesDir ?? 'pages')`, then
  assert the result stays inside `dir` (`resolve`d prefix check) — belt and
  braces against a hand-edited `meta.json`.

### 1.2 Widen page-file discovery
`discoverPageFiles` (:48-50):
```ts
const PAGE_FILE_EXTENSIONS = ['.tsx', '.jsx'] as const
export function discoverPageFiles(pagesDir: string): string[] {
  return listWorkspaceFiles(pagesDir)
    .filter((relPath) => PAGE_FILE_EXTENSIONS.some((ext) => relPath.endsWith(ext)))
}
```
Also widen `createWorkspaceProject`'s glob
(`src/core/page-parser/componentSources.ts:57`) to
`` `${root}/**/*.{ts,tsx,js,jsx}` `` and set `allowJs: true` in its
`compilerOptions` so ts-morph parses `.jsx` at all. Verify
`skipAddingFilesFromTsConfig: true` still holds; a workspace `tsconfig.json`
must not be able to turn `allowJs` back off.

`pageIdFromRelPath` (`studio.ts:325-339`) strips only `.tsx` at :329 — change to
`.replace(/\.(tsx|jsx)$/,'')`.

### 1.3 Replace every hardcoded `join(dir,'pages')`
All 7 sites listed in §0.6 call `projectPagesDir(dir)` instead.
**Exception:** `POST /admin/api/studio/create` (`studio.ts:571`) and
`POST /admin/api/studio/page` (`studio.ts:616`) *scaffold* files — they should
also honour the override so a new page in an imported project lands in the
right folder.

### 1.4 Accept `pagesDir` on import
`GithubImportBodySchema` (`studio.ts:215-220`) gains
`pagesDir: Type.Optional(Type.String())`. In the `/import-github` handler
(:518-539), after `runGithubImport` succeeds, call
`writeProjectMeta(result.dir, { displayName: <derived>, pagesDir: body.pagesDir })`.
Keep `dir` out of the wire schema — the comment at :202-213 explains why; do not
weaken it.

### 1.5 Tests
`server/handlers/__tests__/studioProjects.test.ts` (extend or create):
- `projectPagesDir` returns `<dir>/pages` with no meta, honours a valid
  override, ignores `..`/absolute overrides.
- `discoverPageFiles` finds `.jsx` and `.tsx`, recursively, sorted.
- `pageIdFromRelPath('screens/esim/QrCodeScreen.jsx')` → `screens-esim-qr-code-screen`.

### 1.6 Acceptance
Point a fixture project's `pagesDir` at a nested folder with `.jsx` files;
`GET /admin/api/studio/load` returns one page per file. Existing projects
(no `pagesDir` in meta) behave **identically** to before.

---

## §2 — Local-component inlining (the core piece — highest risk)

**Why:** eSIM screens are ~70% custom components. Today
`resolveComponentSources` only *classifies* local vs package
(`componentSources.ts:13-15`: "does not parse a local component's own file into
an editable tree"); every one renders as an "Unknown module" box.

### 2.1 New module
`src/core/page-parser/inlineLocalComponents.ts`, exported from
`src/core/page-parser/index.ts`.

```ts
export interface InlineOptions {
  /** Hard cap on nesting depth. Default 6. */
  maxDepth?: number
  /** Hard cap on total nodes produced by inlining one page. Default 4000. */
  maxNodes?: number
}

/**
 * Expands every `kind:'component'` node whose ComponentSource is `local` into
 * the JSX its own file returns, recursively. Returns a NEW ParsedPage; never
 * mutates the input, never throws (mirrors parsePageFile's contract).
 */
export function inlineLocalComponents(
  parsed: ParsedPage,
  sources: Record<string, ComponentSource>,
  project: Project,
  workspaceRoot: string,
  opts?: InlineOptions,
): ParsedPage
```

### 2.2 Algorithm
For each node with `sources[node.id]?.kind === 'local'`:
1. Resolve the target `SourceFile` from `project` (already workspace-wide).
2. Reuse the **exact** existing discovery pair —
   `findComponentDeclaration` + `getReturnedJsxRoot` (`parsePageFile.ts:96,154`).
   Export them from `parsePageFile.ts` rather than duplicating.
   *If the component identifier is a named (non-default) export, resolve that
   specific declaration instead of the default one.*
3. Parse the target's JSX with the same walk, producing a sub-`ParsedPage`.
4. **Substitute props** into the sub-tree (see 2.3).
5. Splice: replace the call-site node with the sub-tree's roots in the parent's
   `children` array; merge the sub-nodes into `nodes`.
6. Recurse into the sub-tree's own local components (depth + node caps, plus a
   **cycle guard**: a `Set<string>` of `${file}#${exportName}` on the current
   path — a component that re-enters itself stops and leaves the opaque node).

### 2.3 Prop substitution — what is in scope
Build `env: Map<paramName, Substitution>` from the call site's literal
attributes (`node.props`, already literal-only per `extractProps`).

| Target JSX shape | Behaviour |
|---|---|
| `{propName}` as a text child, param is a literal | Substitute the literal into `text` |
| `propName={x}` on a nested element, `x` is a param bound to a literal | Substitute into that node's `props` |
| `{children}` | Splice the call-site node's own children subtree in |
| `className={\`a ${cond ? 'b':''}\`}` | Keep the statically-known prefix; mark node `locked` |
| Anything else (calls, member chains, functions, spreads) | Leave slot as-is, mark node `locked` with `lockReason` |

This is **partial evaluation, not an interpreter**. There is no control-flow
execution, no hook evaluation, no context resolution. Unsupported shapes take
the existing lock path, never a crash or a dropped node.

### 2.4 Node identity — CRITICAL, get this right

An inlined node's natural id is its own source location, e.g.
`components/Icon.jsx:3:5`. eSIM renders `<Icon/>` **dozens of times per page** →
every instance would collide on the same id and destroy the node map.

**Rule: an inlined node's id is `` `${callSiteNodeId}~${componentNodeId}` ``.**
Example: `src/screens/HomepageScreen.jsx:77:19~components/Icon.jsx:3:5`.
Deterministic, collision-free, and encodes provenance for debugging.

Two guards this forces:

1. **`applyStudioEdit` must refuse composite ids.** `NODE_LOC_ID`
   (`studio.ts:122`) is `/^(.*):(\d+):(\d+)$/` with a **greedy** `.*`, so it
   *would* match a composite id and derive a garbage file path. Add an explicit
   early return:
   ```ts
   if (edit.nodeId.includes(INLINE_ID_SEPARATOR)) return false // inlined — no writeback
   ```
   Same guard in `orderStudioEditsForApply` (sort such ids last, like synthetic ones).
2. **`fsCodemodAdapter` must not ship edits for them.** `SOURCE_NODE_ID`
   (`fsCodemodAdapter.ts:42`) is `/^.+:\d+:\d+$/` — also matches. Add the same
   separator check to the `continue` at :232.

Export the separator from one place (`@core/page-parser`) so both sides agree:
```ts
export const INLINE_ID_SEPARATOR = '~'
```

### 2.5 Inlined nodes are LOCKED (deliberate)
Every inlined node gets `locked: true`, `lockReason: 'from component <Name>'`.

Rationale — write this into the module doc comment:
- Writeback to a shared component file would mean **editing one instance
  changes every instance**, silently. That is worse than read-only.
- The composite id has no single valid source location to write back to.
- It matches the parser's existing "rendered dynamically ⇒ read-only surface"
  convention (`DYNAMIC_LOCK_REASON`), so editor edit-guards
  (`nodeActions`, `inlineEditSlice`) already respect it with zero new work.

The **call-site node itself stays editable** — it is a real page-file location,
so `<Icon svg={x} size={24}/>`'s `size` prop remains writable. The call site
becomes a `base.container` wrapping the inlined subtree (see §4's promotion
rule), preserving both editability and visual output.

### 2.6 Wire it in
`server/handlers/studio.ts` load handler (:385-397):
```ts
const parsed = parsePageFile(file, dir, project)
const sources = resolveComponentSources(project, file, dir, parsed)
const expanded = inlineLocalComponents(parsed, sources, project, dir)
Object.assign(componentSources, sources)
return parsedPageToSitePage(expanded, { ... })
```
Note `resolveComponentSources` must run on the **pre-inline** tree (it keys off
call-site ids). If inlining introduces new component nodes from the sub-tree,
re-run `resolveComponentSources` against the sub-tree's own file inside the
recursion — that is the recursion's job, not the caller's.

### 2.7 Staging within §2 (do NOT big-bang this)
- **2a — literal props, no recursion.** Validate on eSIM's `Icon`,
  `SectionTitle`, `Price`, `ProgressSignal`, `DataRing`, `StaticScreenshotScreen`.
- **2b — recursion + cycle/depth/node caps.** Validate on
  `SheetShell → SheetHeader + StatusBar`.
- **2c — `{children}` passthrough.** Validate on `SheetShell`'s
  `{children}` slot with `BookingDetailsScreen`'s body.
- **2d — locking fidelity.** Validate on `EsimStatusBanner` (variant branching,
  `.map`, computed `className`) — must render *something* structural, with
  locks, never a crash or an empty page.

### 2.8 Tests
`src/core/page-parser/__tests__/inlineLocalComponents.test.ts` — temp-dir
fixtures, one `describe` per stage above, plus:
- composite ids are unique for two instances of the same component;
- cycle A→B→A terminates and leaves an opaque node;
- `maxDepth`/`maxNodes` caps terminate and degrade;
- a target file with a syntax error yields the unmodified input page;
- package (non-local) components are untouched.

Extend `server/handlers/__tests__/studio*.test.ts` for the `applyStudioEdit`
and ordering guards in §2.4.

### 2.9 Acceptance
A fixture page importing a 3-deep local component chain returns a fully
expanded node tree with unique ids, all inlined nodes `locked`, all call-site
nodes editable, and `bun test` green.

---

## §3 — `<svg>` raw capture → `base.svg`

**Why:** `<svg>` currently maps to `base.text` (leaf) and its `<path>`/`<circle>`
children are dropped. eSIM's icons, progress rings, and status bars are all
inline SVG. `base.svg` already exists (`src/modules/base/svg/index.ts`) taking a
raw `svg` markup string, sanitised at the publisher boundary via the DOMPurify
SVG profile, rendered inline so `currentColor` still works.

### 3.1 Parser
`parsePageFile.ts` — in `processElement` (:218), before walking children:
```ts
if (kind === 'element' && name.toLowerCase() === 'svg') {
  // Capture verbatim; do NOT recurse into <path>/<circle>/… — they are not
  // page-tree modules, and base.svg renders the markup as one unit.
  node.props.svg = element.getText()
  node.children = []
  ctx.nodes[id] = node
  return id
}
```
Keep `extractProps`/`extractInlineStyles` running on the `<svg>` element itself
so `className`/`style` still land (§4/§6 need them).

`ParsedNode` needs no schema change — `props` already carries strings.

### 3.2 moduleId
`server/handlers/studio.ts` `resolveModuleId` (:222): add
`if (tag === 'svg') return 'base.svg'` before the `base.text` fallback.

### 3.3 Boundaries
- SVG containing JSX expressions (`strokeDashoffset={C*(1-pct/100)}` in
  `EsimStatusBanner`/`DataRing`) captures the **raw source text**, which is not
  valid standalone SVG. Detect any `{` in the captured text → keep the node but
  set `locked:true`, `lockReason:'dynamic SVG'`, and drop the `svg` prop rather
  than emitting broken markup. Renders as an empty placeholder, honestly.
- Sanitisation is the publisher's existing job — do not add a second gate.

### 3.4 Tests
Extend `src/core/page-parser/__tests__/parsePageFile.test.ts`:
static `<svg>` → single node, `props.svg` contains `<path`, `children` empty;
dynamic `<svg>` → locked, no `svg` prop.

---

## §4 — Context-aware element→module resolution

**Why:** only 8 host tags map to `base.container`. `<p>`, `<h1>`, `<li>`,
`<span>`, `<ul>`, `<label>` fall to leaf `base.text` and drop nested JSX. After
§2 this is everywhere — eSIM wraps `<Icon/>` inside `<p>`/`<span>`/`<li>`
constantly.

### 4.1 Signature change
`parsedPageToSitePage`'s `resolveModuleId` option
(`src/core/studio-sync/parsedPageToSitePage.ts:20`) currently receives
`Pick<ParsedNode,'kind'|'name'>`. Widen to also pass whether the node has
element/component children:

```ts
resolveModuleId: (node: Pick<ParsedNode, 'kind' | 'name' | 'children'>) => string
```
Call site at :46 already has the full node — pass `children` through.

### 4.2 New rule (`server/handlers/studio.ts:222`)
```ts
function resolveModuleId(node: { kind: 'element'|'component'; name: string; children: string[] }): string {
  if (node.kind === 'component') return `alm.${node.name}`
  const tag = node.name.toLowerCase()
  if (CONTAINER_TAGS.has(tag)) return 'base.container'
  if (tag === 'button') return 'base.button'
  if (tag === 'a') return 'base.link'
  if (tag === 'img') return 'base.image'
  if (tag === 'svg') return 'base.svg'
  // A text-ish tag that actually wraps nested elements must be a container, or
  // base.text (a leaf) would silently drop its children. Text-only content
  // keeps base.text so inline click-to-edit is unchanged for existing projects.
  if (node.children.length > 0) return 'base.container'
  return 'base.text'
}
```

### 4.3 Preserve the original tag
`base.container`'s `htmlTag` is `resolveHtmlTag(props.tag, props.customTag)`
(`src/modules/base/container/index.ts:52`). A promoted node must carry the real
tag or an `<h1>` renders as a `<div>`. In `parsedPageToSitePage`, when the
resolved module is `base.container` and the source tag is not `div`, set
`props.tag` (or `props.tag='custom'` + `props.customTag=<tag>` — check
`htmlTagControl()`'s option list in `@modules/base/utils/htmlTag` and use the
built-in value when the tag is in it).

### 4.4 Non-regression is the whole point
Add an explicit test asserting `<p>Hello</p>` (text only) still resolves to
`base.text` with `props.text === 'Hello'` — the existing inline-edit UX for
every current Studio project must be byte-identical.

---

## §5 — Local asset serving

**Why:** `import esimChip from '../assets/esim-flow/figma/esim-chip.png'` then
`<img src={esimChip}/>`. Today the `src` prop is a non-literal identifier
(dropped by `extractProps`) and nothing serves the file anyway.

### 5.1 Resolve image imports to a URL
In `parsePageFile`, when an attribute's initializer is a **plain identifier**
that resolves to a default import from a path with an image extension
(`.png|.jpg|.jpeg|.svg|.webp|.gif|.avif`), emit the resolved
workspace-relative path as the prop value, prefixed with a sentinel:
`props.src = 'studio-asset:assets/esim-flow/figma/esim-chip.png'`.

Resolution uses the shared workspace `Project` (already available) — the same
mechanism `classifyImport` uses (`componentSources.ts:124`). This is a small,
contained widening of `extractProps`, not a general expression evaluator.

### 5.2 Rewrite the sentinel to a URL
In `parsedPageToSitePage` (or a thin pass in the load handler), rewrite
`studio-asset:<rel>` → `/admin/api/studio/asset?dir=<encoded>&path=<encoded>`.
Keep the sentinel in the parser layer so `@core/page-parser` stays free of HTTP
concerns.

### 5.3 The endpoint
`server/handlers/studio.ts`, new route:
```
GET /admin/api/studio/asset?dir=<projectDir>&path=<workspace-rel>
```
- `resolveProjectDir(dir)` for the project (existing guard).
- Reject `path` that is absolute, contains a `..` segment, or whose
  `resolve(join(dir,path))` does not start with `resolve(dir) + sep`.
- Reject any path segment in `EXCLUDED_WORKSPACE_DIR_NAMES`.
- Serve via the existing `serveStaticFile(dir, '/'+path, req)`
  (`server/static.ts`) — it already knows png/jpg/svg/webp/woff2 MIME types,
  compression, and range handling. Return 404 on `null`.
- Add the route to the router's admin-API prefix handling in
  `server/router.ts` the same way the other `/admin/api/studio/*` routes go
  through `tryServeStudio` (no router change expected — verify).

### 5.4 Tests
`server/handlers/__tests__/studioAsset.test.ts` — serves a real fixture file;
rejects `..`, absolute paths, `node_modules/…`; 404s a missing file.

---

## §6 — CSS imports → StyleRules + classIds

**Why:** eSIM ships ~2,900 lines of hand-written BEM CSS across 25 files, tied
to elements by `className`. Studio's renderer never reads a literal `className`
prop; styling attaches via `classIds` → `styleRules`.

### 6.1 Collect the CSS a page depends on
New `src/core/studio-sync/collectPageStylesheets.ts`:
- Walk the page's `SourceFile` **and every local component file inlined into
  it** (§2 already computes that set — return it from `inlineLocalComponents`
  as `usedFiles: string[]`).
- Collect bare side-effect imports (`import './X.css'`) plus any
  `.css`/`.scss` module specifier, resolved relative to the importing file,
  restricted to inside the workspace root.
- Preserve **source order**, deduped, so cascade order is faithful.

### 6.2 Parse with the existing pipeline
Call `cssToStyleRules(cssText, { breakpoints })` per file, in order, offsetting
`order` so later files sort after earlier ones. Pass the site's breakpoints so
`@media` folds into `contextStyles` correctly; collect the returned
`conditions` for unmatched `@media`/`@container`/`@supports`.

**Server-side CSSOM:** `getSheetConstructor` (`cssToStyleRules.ts:150`) needs a
`CSSStyleSheet`. In Bun there is none, so register happy-dom's window once,
lazily, in a server-only module (e.g. `server/handlers/studioCss.ts`):
```ts
// happy-dom is a runtime dependency (package.json:90), not dev-only.
const { Window } = await import('happy-dom')
```
Set `globalThis.window` (or pass the ctor in — **preferred**: add an optional
`sheetConstructor` option to `cssToStyleRules` rather than mutating globals in
a server process). Prefer the explicit-injection route; mutating `globalThis`
in a long-lived Bun server is a footgun.

### 6.3 className → classIds
In `parsedPageToSitePage`: read `props.className` (a literal string — already
captured by `extractProps`), split on whitespace, put the **names** into
`node.classIds`, and delete `className` from `props` (it is not a renderable
prop in this engine).

### 6.4 Name→id resolution — server-side, deterministic
`site.styleRules` starts empty on a Studio load (§0.4), so there is nothing to
reconcile — but Studio **reloads the whole site** on
`requestCmsSiteReload()`/`shifted` saves, so ids must be **stable across
reloads** or selection/undo churns.

Use a deterministic id derived from the class name (and for ambient rules, the
selector) — e.g. `` `sc-${sha1(name).slice(0,10)}` `` — not `nanoid()`.
Document the choice in the module doc.

Do **not** import `src/admin/.../importLinking.ts` from the server. Either
(a) implement the ~20-line deterministic mapping in the new server module, or
(b) if it starts to duplicate, move `importLinking.ts` down into
`@core/siteImport` and have both sides import it — per CLAUDE.md's "no
duplicated old/new paths" rule, prefer (b) the moment there is real overlap.

### 6.5 Ship it to the client
`server/handlers/studio.ts` load response gains `styleRules` and `conditions`:
```ts
return jsonResponse({ dir, projectName, pages, componentSources, styleRules, conditions })
```
`fsCodemodAdapter.ts`:
- Extend `StudioLoadResponseSchema` (:62) with
  `styleRules: Type.Record(Type.String(), StyleRuleSchema)` and
  `conditions: Type.Array(ConditionDefSchema)` — import both from
  `@core/page-tree` (barrel). **No `as` casts** — `boundary-validation.test.ts`
  enforces this.
- In `loadSite` (:195), assign `site.styleRules = styleRules` and
  `site.conditions = conditions` after `createDefaultSiteDocument`.
- **Update the test mock**: `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts:41`
  must gain the new required fields or all 4 tests fail with a TypeBox error
  (this exact class of break has already happened once on `projectName`).

### 6.6 Explicit boundary — CSS is READ-ONLY (one-way)
There is no CSS writeback codemod. Editing a class in Studio's CSS Classes panel
updates the in-memory site document but will **not** be written back to the
`.css` file, and will be lost on the next reload. State this in the load
handler's doc comment and in `docs/` — do not let it be discovered.

*If* two-way CSS editing is wanted later, that is a separate initiative
(a CSS-text codemod alongside `ast-codemods`), explicitly out of scope here.

### 6.7 Tests
`src/core/studio-sync/__tests__/collectPageStylesheets.test.ts` — import
ordering, dedupe, transitive component CSS, workspace-escape rejection.
Round-trip test: fixture page + CSS → `styleRules` contains the class,
`node.classIds` references its id, ids stable across two parses.

---

## §7 — Static value resolution (makes imported screens show real content)

**Why this is not optional.** Today `extractProps`
(`parsePageFile.ts:270-312`) and `extractSingleText` (:371-388) capture
**string/number/boolean literals only**. Every other expression is skipped.
In eSIM that means essentially *all* visible copy is dropped — every screen
would import structurally correct but visually empty. The same is true of any
real app: copy lives in constants, i18n dictionaries, or props, almost never as
a bare JSX string literal. Without this section, §§1-6 produce correct
skeletons that look broken.

This is also the section that generalizes furthest beyond eSIM: a bounded
static evaluator is what lets *any* imported repo show its real content.

### 7.1 The patterns that must resolve (from the corpus)

| Tier | Pattern | eSIM example | Notes |
|---|---|---|---|
| **A** | Module-scope `const` object/array + member chain | `PRODUCT_CARDS`, `DATA_PACKAGES`, `BANNER_VARIANTS[bannerStyle]` | Same file |
| **A** | Cross-file `const` via local import | `import { translations } from './translations'` | Needs workspace `Project` (have it) |
| **A** | Local alias inside the component body | `const d = t.bookingDetails` then `{d.route}` | Scope chain |
| **A** | Computed member with a resolvable key | `productLabels[card.key]` | String/number keys only |
| **A** | Template literal with resolvable parts | `` `${pct}%` ``, `` `esb esb--${tone}` `` | Partial ⇒ keep prefix, lock |
| **B** | Destructured hook return | `const { t } = useLanguage()` | Needs provider tracing (7.3) |
| **B** | Dynamic index into a dictionary | `translations[lang]` | Needs a branch pick (7.4) |
| **C** | Call of a resolvable arrow returning a template | `t.common.gbLeft(4)` → `"4 GB left"`, `t.bookingDetails.moreAbout(x)` | Pure single-expression arrows only |
| **D** | `.map()` over a resolved array | `t.common.esimChecklist.map(…)` | Loop expansion — **out of scope**, see 7.7 |

### 7.2 New module

`src/core/page-parser/staticEval.ts`, exported from the barrel.

```ts
export type StaticValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'object'; entries: Map<string, StaticValue> }
  | { kind: 'array'; items: StaticValue[] }
  | { kind: 'fn'; node: ArrowFunction | FunctionDeclaration }   // tier C
  | { kind: 'unresolved'; reason: string; partial?: string }

export interface StaticEvalOptions {
  /** Max resolution depth through bindings/members. Default 12. */
  maxDepth?: number
  /** Max nodes visited per top-level resolution. Default 2000. */
  maxSteps?: number
  /**
   * Preferred key when indexing a dictionary with a non-static key
   * (`translations[lang]`). Falls back to the object's FIRST key.
   * Sourced from `.studio/meta.json`'s `previewLocale`.
   */
  preferredKey?: string
}

/**
 * Resolves a JSX expression to a static value, or reports why it can't.
 * Pure, memoized per (file, expression start). NEVER throws — an unexpected
 * error resolves to `{ kind:'unresolved' }`, matching parsePageFile's contract.
 */
export function evaluateExpression(
  expr: Node,
  scope: EvalScope,
  opts?: StaticEvalOptions,
): StaticValue
```

`EvalScope` is a small chain: component-body `const` bindings → module-scope
bindings → imported-module bindings (resolved through the workspace `Project`,
same mechanism `classifyImport` uses at `componentSources.ts:124`). Cache
resolved module namespaces per file — `translations.js` is read once, not once
per JSX expression.

**Guards, non-negotiable:** cycle set on `${file}#${bindingName}`, `maxDepth`,
`maxSteps`, and a global per-page budget. Every guard trip returns
`{kind:'unresolved'}`, never an exception, never a hang.

### 7.3 Tier B — hook return values via provider tracing

For `const { t } = useLanguage()`:
1. Resolve `useLanguage` to its declaration (local import or same file).
2. If its body is `useContext(<Ctx>)` — tolerating a throw-guard like
   eSIM's `if (!ctx) throw …; return ctx` — resolve `<Ctx>`.
3. Find `<Ctx.Provider value={…}>` anywhere in the workspace `Project`.
   If exactly one provider exists, evaluate its `value` expression. If the
   value is a `useMemo(() => ({…}), deps)`, unwrap to the returned object
   literal. **More than one provider ⇒ unresolved** (ambiguous; do not guess).
4. Destructure the requested key out of the resolved object.

For eSIM this yields
`{ lang: <dynamic>, dir: <dynamic>, t: translations[lang], … }`, so `t`
resolves to `translations[lang]` — handled by 7.4.

Any other hook shape (`useState`, `useIsMobile`, custom hooks with logic)
resolves to `{kind:'unresolved'}` immediately. **No hook is ever executed.**
This is AST tracing of a provider's static value, not React semantics.

### 7.4 Tier B — dictionary index with a non-static key

`translations[lang]` where `lang` is runtime state. Rule:
- If the indexed value is an object with ≥1 key, pick `preferredKey` when
  present, else the **first key in source order**.
- Record a `ResolutionNote` on the node so the editor can surface
  *"showing the `en` branch"* rather than pretending it is the only value.
- `previewLocale` goes in `.studio/meta.json` (extends §1.1's shape) — default
  unset ⇒ first key. For eSIM, `"en"` (also the first key, so it works
  unconfigured).

This one heuristic is what makes the entire i18n family of apps import
usefully, and it generalizes to theme/config dictionaries.

### 7.5 Tier C — calling resolvable pure arrows

`t.common.gbLeft(4)` → `` (n) => `${n} GB left` `` → `"4 GB left"`.

Strictly bounded — evaluate a call **only** when all of:
- the callee resolves to an arrow/function whose body is a **single
  expression** (concise arrow) or a body of only `if (…) return <expr>` /
  `return <expr>` statements (eSIM's `daysLeftAr` shape);
- every argument resolves statically;
- the body contains no assignment, loop, `await`, `new`, or member call other
  than a whitelisted set (`String`, `Number`, `Math.*`, `.toFixed`,
  `.padStart`, `.toUpperCase`, `.toLowerCase`, `.trim`, `.join`);
- depth/step budget holds.

For an `if`-chain, evaluate conditions with the same evaluator and take the
first true branch; if a condition is unresolved, take the **final** `return`
(the general case, e.g. `` `تبقّى ${n} يومًا` ``) and mark it a note.

Anything outside this envelope ⇒ `{kind:'unresolved'}`. Implement Tier C
**last** and behind its own tests — it is the easiest place to accidentally
build an interpreter.

### 7.6 Wiring it into the parser

`extractProps` (:270) and `extractSingleText` (:371) gain an optional
evaluator. Keep the current literal fast-path first (zero behaviour change,
zero cost, for pages that only use literals); fall through to
`evaluateExpression` only when the fast path misses.

Also apply it to `extractInlineStyles` (:324) — today a `style={{ width: size }}`
or a `var(--x)` value is dropped (:354). Resolving these is the same call.

**Resolved values are DERIVED — the node must be locked.**
Add `lockReason: 'value from <shortExprText>'` (e.g.
`value from t.homepage.greeting`). Rationale, to be written into the doc
comment: writing an edited literal back over `{t.homepage.greeting}` would
silently destroy the i18n binding in the user's real source file. Same
principle as §2.5's inlined-node rule, and it reuses the same edit-guard
machinery for free.

Carry a small, optional `ParsedNode.resolution?: { source: string; note?: string }`
so the editor can show *why* a node is locked and which branch was chosen.
Plumb it through `parsedPageToSitePage` onto the `PageNode` alongside
`locked`/`lockReason` (:69-72 already does exactly this for the existing lock
fields — follow that pattern).

### 7.7 Explicitly OUT of scope (Tier D)

**Loop expansion.** Once `t.common.esimChecklist` resolves to a 3-item array,
one could render the `.map()` three times. That is a genuinely separate
feature (it needs iteration-scoped binding, stable per-iteration node ids, and
a decision about how `base.loop` interacts with source-backed ids) and it has a
real analogue already in the codebase — `LoopIterationsPreview`
(`NodeRenderer.tsx:228`). **Do not build it here.** `.map()` bodies keep
today's single locked representative node.

Also out: conditional-branch selection (`esimTab === 0 ? A : B` keeps today's
behaviour of parsing both branches, locked), any hook state, any effect,
any network/async value.

### 7.8 Tests

`src/core/page-parser/__tests__/staticEval.test.ts` — one `describe` per tier:
- **A**: same-file const, cross-file import, alias chain, computed key,
  template literal (full and partial), array index.
- **B**: `useContext` provider tracing (single provider resolves; two
  providers ⇒ unresolved); `dict[dynamicKey]` picks `preferredKey`, then
  first key; note recorded.
- **C**: concise arrow with template; `if`-chain picking a branch; rejection
  of a body with an assignment/loop/`await`.
- **Guards**: cycle `A→B→A` terminates; `maxDepth`/`maxSteps` degrade to
  unresolved; a malformed target file resolves unresolved, does not throw.
- **Non-regression**: a page using only literals produces byte-identical
  output to before (assert against the existing `parsePageFile` fixtures).

### 7.9 Acceptance

On eSIM, `BookingConfirmationScreen` and `HomepageScreen` show real English
copy on the canvas (`"Hi Muhammad"`, `"Your booking is confirmed"`,
`"Almosafer Points"`), every such node is locked with an explanatory
`lockReason`, and no page takes materially longer to load than before
(measure; the memoized module-namespace cache is what keeps this true).

---

## §8 — Validation on eSIM (no manual rewriting)

1. `POST /admin/api/studio/import-github` with
   `{ url: 'https://github.com/maherfayad-stack/eSIM', subdir: 'journey-screens', pagesDir: 'src/screens' }`.
   For local dev iteration, copy `~/Documents/Github/eSIM/journey-screens` into
   `studio-workspace/esim-journey/` and hand-write `.studio/meta.json` instead.
   Set `previewLocale: 'en'` in `.studio/meta.json` (§7.4).
2. `bun run dev`, open the project in Studio, `GET /admin/api/studio/load` and
   assert in the browser:
   - every screen file appears as a page;
   - local components are expanded (no "Unknown module" boxes);
   - icons render (inline SVG);
   - images load through `/admin/api/studio/asset`;
   - CSS classes appear in the CSS Classes panel and visibly apply;
   - **real English copy renders** (`"Hi Muhammad"`, `"Your booking is
     confirmed"`, `"Almosafer Points"`, `"5 GB"`) — §7.
3. Lay the real screens onto **one board** via `POST /admin/api/studio/boards`.
   Skip `ActivationFlowScreen`/`TopupFlowScreen` — they are step-routers holding
   runtime state, not screens; no static-page system represents "current step in
   a state machine".
4. Browser console clean.

### Expected residual gaps on eSIM (acceptable, document them)
- **Repeated list content.** `t.common.esimChecklist.map(…)` renders one
  representative locked row, not three — loop expansion is Tier D, explicitly
  out of scope (§7.7).
- **Multi-stage screens** (`ActivateSettingsScreen`'s 4 stages) collapse to the
  least-nested `return` — existing parser behaviour, unchanged.
- **Computed `className`** (`` `esb esb--${tone}` ``) yields the static prefix
  only, node locked (§7.1 Tier A partial rule).
- **Arabic / RTL.** Only the `previewLocale` branch renders. Switching locale
  on canvas is not modelled; the note on each resolved node says which branch
  was chosen.
- **Everything resolved by §7 is read-only on canvas.** Editing derived copy
  would corrupt the source's i18n binding — locked by design (§7.6), not an
  oversight.

---

## §9 — Verification gate (CLAUDE.md, run once at the end)

```sh
bun install
bun run build        # tsc -b && vite build
bun test
bun run lint
```

New/changed tests to expect green:
```
src/core/page-parser/__tests__/inlineLocalComponents.test.ts   (new, §2)
src/core/page-parser/__tests__/staticEval.test.ts              (new, §7)
src/core/page-parser/__tests__/parsePageFile.test.ts           (svg §3, resolved values §7.6)
src/core/page-parser/__tests__/componentSources.test.ts        (jsx glob §1.2)
src/core/studio-sync/__tests__/parsedPageToSitePage.test.ts    (tag promotion §4, classIds §6.3, resolution field §7.6)
src/core/studio-sync/__tests__/collectPageStylesheets.test.ts  (new, §6.1)
server/handlers/__tests__/studioProjects.test.ts               (pagesDir, .jsx §1.5)
server/handlers/__tests__/studioAsset.test.ts                  (new, §5.4)
src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts (mock fields §6.5)
```

Architecture gates that will bite if ignored:
- `boundary-validation.test.ts` — no `as` at the new HTTP boundary; use TypeBox.
- `no-core-barrel-deep-imports.test.ts` — import from `@core/page-parser`,
  `@core/page-tree` barrels, never deep paths.
- `db-postgres-isms.test.ts` — N/A, no DB work here.
- Docs must track code (CLAUDE.md #7): update
  `docs/features/` with a Studio-import section covering the pages-dir override,
  inlining semantics + lock rule, the asset route, the one-way CSS boundary, and
  static value resolution (what resolves, what locks, how `previewLocale` picks
  a branch).

**No database schema changes anywhere in this plan. No changes to the
DB-backed (non-Studio) CMS editor.**

---

## §10 — Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| §2 inlining explodes node counts / load time on a big repo | Medium | `maxNodes`/`maxDepth` caps; measure load time on eSIM; caps degrade to opaque nodes, never fail |
| Composite ids leak into writeback → corrupt source files | **High if unguarded** | Two explicit guards (§2.4) + a test that a composite-id edit is a no-op |
| §7 evaluator grows into a JS interpreter | **High** | Hard tier boundaries (7.1); Tier C's explicit envelope (7.5); Tier D banned (7.7); step/depth budgets; build C last |
| §7 cross-file resolution tanks load time | Medium | Memoize resolved module namespaces per file; per-page step budget; measure before/after on eSIM (§7.9) |
| Resolved copy edited on canvas silently corrupts i18n source | **High if unguarded** | Resolved nodes are locked with an explanatory `lockReason` (§7.6), reusing existing edit-guards |
| Wrong locale/branch shown with no signal to the user | Medium | `ResolutionNote` per node + `previewLocale` config (§7.4) |
| happy-dom in the server process leaks globals | Medium | Inject the sheet constructor instead of mutating `globalThis` (§6.2) |
| §4 promotion regresses inline text editing | Medium | Explicit non-regression test (§4.4); text-only stays `base.text` |
| CSS ids churn across reloads → selection/undo thrash | Medium | Deterministic hashed ids (§6.4) |

**The two heavy sections are §2 and §7** — both are scoped partial evaluators,
not patches, and both are where an agent will drift into building an
interpreter. Stage §2 as 2a→2d and §7 as tier A→B→C, with tests against the
real eSIM sources at each step, never as one change. §§1, 3, 4, 5 are small and
can land quickly to de-risk the surface area first.

### Suggested landing order
`§1` → `§4` → `§3` → `§5` → `§2 (a,b,c,d)` → `§7 (A,B,C)` → `§6` → `§8`
Rationale: cheap structural wins first; inlining before value resolution
(inlined components need their own values resolved, so §7 must see the expanded
tree); CSS last because it is the only piece that is purely additive and
read-only, so it can be deferred without blocking visual validation.
