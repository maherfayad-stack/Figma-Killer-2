# Studio Import

Studio can open a **real React repository** — one written by hand or pulled straight from GitHub — as an editable board, without that repo knowing anything about Instatic.

The load path is `GET /admin/api/studio/load?dir=<abs>` → `loadStudioPages` (`server/handlers/studioPageLoad.ts`). Everything below describes what that pipeline does to arbitrary source and, just as importantly, what it deliberately refuses to do.

---

## TL;DR

- **Studio parses source structurally. It never executes it.** No component is rendered, no hook is called, no module is evaluated. Every value on the canvas was read out of the AST with ts-morph.
- **Page discovery is configurable.** `.studio/meta.json`'s `pagesDir` points at a repo's real screens directory (e.g. `src/screens`); `.tsx` and `.jsx` are both discovered.
- **Local components are inlined.** A `<Card />` whose import resolves inside the workspace is expanded into its own JSX so the canvas shows real markup, not an opaque box. The call-site node is **replaced** by that JSX, not left wrapping it. Inlined nodes are **editable**, and the panel says how many places an edit will land in.
- **Package components are not.** `@alm-design/design-system`'s `<Button />` stays a `alm.Button` node rendered by its own module.
- **`.map` over a statically-resolved array is expanded** into one node per item, so a list renders as a list. Rows are locked (derived from data).
- **Every `return` in a component renders**, not just the shallowest one. A screen with `if (stage === 'loading') return …` shows both branches, locked — the parser never picks between them.
- **A component's array/object props survive.** `<ActionSheet actions={[{ label }, { label }]}/>` reaches the canvas as a real array, so the design-system component renders its buttons. HTML elements stay scalar-only (an attribute is a string).
- **Non-literal values are statically resolved** where it is safe to — `{t.homepage.greeting}` becomes `"Hi Muhammad"`. Resolved nodes are **locked**, because writing an edited literal back over the expression would destroy the binding in the user's source file.
- **Imported CSS is read-only.** `.css` files become `StyleRule`s and `node.classIds`, but **nothing is ever written back to a `.css` file**. An edit made in the CSS Classes panel is lost on the next reload. See [CSS is one-way](#css-is-one-way).
- **Writeback is prop/text/style only**, and only for nodes whose id is a real single source location.

---

## Where the code lives

```text
server/handlers/
├── studio.ts             — HTTP routing only (load / save / asset / framework / download)
├── studioPageLoad.ts     — the parse → inline → CSS → convert pipeline
├── studioProjects.ts     — project discovery, `.studio/meta.json` (displayName, pagesDir, previewLocale)
├── studioCss.ts          — §6: imported .css → StyleRule registry, deterministic ids, happy-dom CSSOM
├── studioAsset.ts        — GET /admin/api/studio/asset, path-containment guards
└── studioWriteback.ts    — StudioEdit shapes, tail-resolved edit locations, dedupe

src/core/page-parser/
├── parsePageFile.ts          — the ts-morph JSX walk → ParsedPage
├── inlineLocalComponents.ts  — local-component expansion: structure, composite ids, call-site replacement
├── componentSubstitution.ts  — the value half: call-site props → the component's own JSX
├── staticLoopExpansion.ts    — `.map` over a resolved array → one node per item
├── jsxAttributeReaders.ts    — how each attribute shape is read (props, style, raw SVG, images)
├── componentSources.ts       — local vs package classification, workspace-wide ts-morph Project
├── staticEval.ts             — public composer for the value evaluator
├── staticEvalCore.ts         — Tier A + the recursive walker + binding resolution
├── staticEvalCalls.ts        — Tier B (hook → provider) + Tier C (pure calls)
└── resolutionLock.ts         — resolved value → lock + `resolution`; scalar vs structured prop values

src/core/studio-sync/
├── parsedPageToSitePage.ts    — ParsedPage → Instatic Page (moduleId, text prop, classIds)
└── collectPageStylesheets.ts  — which .css files a page depends on, in cascade order

src/modules/alm/
└── register.tsx               — design-system components as modules; revives `{ svg }` props into elements

src/admin/pages/site/property-controls/
└── StructuredValueControl.tsx — read-only stand-in for an array/object prop value

src/core/css-sanitize/
└── cssValueForProperty.ts     — the number → `px` rule, shared by canvas and publisher

src/admin/pages/site/canvas/
└── useIframeFrameAutoHeight.ts — frame height + the definite `body` height authored `%` chains need
```

---

## Project configuration — `.studio/meta.json`

Sits alongside the existing `.studio/boards.json` and `.studio/framework.json`.

```json
{
  "displayName": "eSIM Journey",
  "pagesDir": "src/screens",
  "previewLocale": "en"
}
```

| Field | Effect |
|---|---|
| `displayName` | Shown under the brand mark in the toolbar. Decoupled from the folder name so renaming never moves a directory. |
| `pagesDir` | Project-root-relative POSIX path to the pages directory. Defaults to `<dir>/pages`. Guarded by `isSafePagesDirOverride` — never absolute, never containing a `..` segment on either separator, because this file is hand-editable. |
| `previewLocale` | The `preferredKey` for the static evaluator's dictionary branch pick (see [Tier B](#tier-b--hook--context-provider)). Unset means "first key in source order". |

Page discovery (`discoverPageFiles`) walks `pagesDir` recursively, returns sorted POSIX paths, and skips `EXCLUDED_WORKSPACE_DIR_NAMES` (`.studio`, `.git`, `node_modules`, `dist`, `.next`, `.turbo`). Both `.tsx` and `.jsx` are page files.

---

## Local-component inlining

`resolveComponentSources` classifies every `kind: 'component'` node:

- **local** — the import resolves to a real file inside the workspace. `inlineLocalComponents` parses that file's returned JSX and splices it in, recursively (`maxDepth` 6, `maxNodes` 4000).
- **package** — a bare specifier. Left as an opaque `alm.*` node with a read-only prop surface; the design-system modules render these properly on their own.

### Composite node ids

An inlined node's natural id would be its own source location (`components/Icon.jsx:3:5`) — and `Icon` is used dozens of times per page, so every instance would collide and destroy the flat node map.

The rule: an inlined node's id is

```
`${callSiteNodeId}${INLINE_ID_SEPARATOR}${componentNodeId}`
    src/screens/HomepageScreen.jsx:77:19~components/Icon.jsx:3:5
```

`INLINE_ID_SEPARATOR` is `'~'`, exported from `@core/page-parser`. `fsCodemodAdapter.ts` **mirrors** the literal rather than importing it, because pulling the page-parser barrel into the browser bundle drags ts-morph/TypeScript along and blows the `AdminCanvasLayout` chunk budget by an order of magnitude (measured). The same file already mirrors `ComponentSource` for that reason.

> **Writeback guard.** `NODE_LOC_ID` (`studioWriteback.ts`) is a permissive `:line:col` pattern whose greedy `.*` matches straight *through* the separator. Run on a whole composite id it yields the right line and column with a file path of `pages/Home.jsx:77:19~components/Icon.jsx` — a path that does not exist, and if it ever did, a file the user never asked to modify. `studioEditLocation` therefore splits on `INLINE_ID_SEPARATOR` and keeps the **tail** before matching. Order is not optional.

### The call site is replaced, not wrapped

`<SheetShell/>` renders SheetShell's own root `<div>` at that position; a component call emits no element of its own. So expansion **replaces** the call-site node with the component's root(s) (`spliceReference`) instead of nesting them under it.

A leftover wrapper div breaks two things silently:

- **Percentage and flex height chains.** `.sheet-shell { height: 100% }` resolves against the wrapper's `auto` height, collapsing the shell to its own content height and every `flex: 1` scroll viewport inside it to 0. Measured on the eSIM corpus: 1447px of a screen's body clipped to nothing, with the header still visible above it.
- **Direct-child and sibling combinators** that cross the call site: `.sheet-shell__panel > .booking-confirmation__scroll` stops matching.

This is the same invariant the per-frame iframe exists to protect (`IframeFrameSurface`, "no `display: contents` NodeWrapper divs"): the canvas DOM must be the DOM React renders, or authored CSS quietly means something different here than in the app.

The trade-off is that a call site's own literal props (`<Icon size={24}/>`'s `size`) are no longer editable *as a node*, because no node represents the call site. Those values still reach the canvas by substitution into the subtree, and are edited where they actually live.

### Inlined nodes are editable, with their blast radius shown

An inlined subtree is one component's markup shown at one call site, and a composite id's writeback target is its tail — the component's own source location, which is a real, valid place to write. So these nodes are **editable**. What they are not is *isolated*: one file backs every instance, so an edit lands on all of them. `ParsedNode.fromComponent` carries the component name, and `SharedComponentNotice` states the consequence next to the controls that would cause it, with a live instance count (one `Icon.jsx` line sat behind 29 board nodes on the corpus).

A node locked for its **own** reason (`.map`/ternary/spread/dynamic value) stays locked — that lock is about having no single valid writeback target at all, which inlining does not change.

---

## Static value resolution

`extractProps`/`extractSingleText` capture string/number/boolean **literals**. In a real repo almost nothing is a literal — copy comes from `{t.homepage.greeting}` behind a `useLanguage()` hook. Without resolution, an import produces a structurally perfect, visually empty wireframe.

The evaluator (`staticEval.ts` and friends) is a **bounded partial evaluator, not a JavaScript interpreter**. Its tiers are the boundary; do not blur them when extending.

### Tier A — literals, consts, member chains

Module-scope and cross-file `const` objects/arrays, component-body aliases, computed members with a resolvable key, template literals with resolvable parts, array indexing. A partially resolvable template keeps its static prefix (`` `esb esb--${tone}` `` → `partial: 'esb esb--'`).

### Tier B — hook → context provider

Traces `useLanguage()` → `useContext(Ctx)` → the single `<Ctx.Provider value={…}>` in the workspace, unwraps a `useMemo`, and evaluates the value object **in the provider component's own scope** (the shape is almost always `value={value}` referring to a `const` in that component's body).

Two providers for the same context ⇒ `unresolved`. Ambiguity is never guessed at.

`translations[lang]` indexes a dictionary with runtime state. §7.4 picks a branch — `previewLocale` if it names a real key, else the first key in source order — and attaches a `note` so the editor can say which branch it chose.

### Tier C — pure function calls

Calls a resolvable arrow/function inside `qualifiesForTierC`'s explicit envelope: a concise-expression body, or a block of bare `if (cond) return …` / `return …` statements, with no assignment, loop, `await`, `new`, or non-whitelisted member call anywhere in a reachable sub-expression. Whitelisted: `String`, `Number`, `Math.*`, `.toFixed`, `.padStart`, `.toUpperCase`, `.toLowerCase`, `.trim`, `.join`.

### Tier D — banned

JSX conditional-branch selection, hook state, effects, async. Do not implement these anywhere in this module. The line is **executing code**: control flow whose outcome the parser cannot know, state it would have to simulate, work it would have to run.

Picking a ternary branch is the sharpest case, and it stays banned because it can look right and be a lie — a stateful screen has many states, and rendering one as if it were the markup misrepresents the source. **The parser's answer to a branch is always "render all of it, lock all of it"** — for a ternary child, a `&&`, and (since the multi-return change below) a component's several `return`s alike.

A **loop inside a callee's body** is likewise not executed, so a call like `applyTokens(svg)` does not resolve. Where the value is raw SVG markup there is a documented fallback — see [SVG through a transform](#svg-through-a-transform-the-evaluator-cannot-run).

### Bounded loop expansion — not Tier D

`items.map(item => <Row/>)` **is** expanded, when `items` is an array Tier A has already fully resolved (`src/core/page-parser/staticLoopExpansion.ts`). This is not execution: the length comes from the source, every item is a value the evaluator produced by reading declarations, and there is no branch to guess. It is a bounded, deterministic function of the AST like every other §7 resolution.

The guard rails:

| Rule | Why |
|---|---|
| The array *and every item* must resolve | One unresolved item would silently drop a row instead of showing the list as unknown |
| Callback must be an inline arrow/function with identifier params | A destructured param would mean re-implementing destructuring against a `StaticValue` |
| `MAX_LOOP_ITERATIONS` = 100 | "Bounded" and "renderable on a canvas" are different claims |
| Iteration ids get a `#<index>` suffix (`LOOP_ID_SEPARATOR`) | One source location legitimately yields N nodes; without it they collide |
| Rows are **locked** | They are derived, and one piece of source JSX backs all N — an edit to row 3 has nowhere isolated to land. Edit the data |

Decline and the call site keeps its single `dynamic — rendered in code` placeholder — exactly the old behaviour.

Measured on the eSIM corpus: 955 → 1062 nodes, 60 → 78 rendered icons (many icons live inside list rows), 773 → 868 styled elements.

### Every `return` renders — no branch is chosen

`getReturnedJsxRoots` returns **every** JSX-producing `return` in a component's body, in source order, and `parseJsxTree` walks all of them into one `ParsedPage`.

It used to sort the returns by block depth and take the shallowest, which systematically preferred the *fallback* and dropped the *special case*: `EsimAddonIcon`'s data-usage ring — an `<svg>` plus a percentage label behind `if (type === 'ring')` — never appeared on any of the four cards that use it, and multi-stage screens collapsed to their last `return`.

| Rule | Why |
|---|---|
| All JSX-bearing returns contribute nodes | Same rule already applied one level down, where a ternary contributes both sides. Choosing would mean evaluating the condition — Tier D |
| Each subtree is locked, `one branch of several — chosen in code` | Which branch runs is not knowable here, so it is not an editable surface |
| A `return null` guard does **not** count | It contributes no nodes; counting it would lock an entire editable screen for `if (!data) return null` |
| Returns inside a nested callback are ignored | They belong to the callback, not the component |

Measured on the eSIM corpus: 1062 → 1154 nodes, 161 → 181 text-bearing nodes.

### Locked nodes still show their text

A locked node used to have its `text` withheld, on the reasoning that a node with no writeback path shouldn't imply an editable surface. `locked` is what carries that meaning — the editor's edit guards read it — and withholding the text doesn't make a node less editable, it makes it **blank**. Every `.map` row, every `{cond && <span>Saved</span>}`, and every spread-bearing element rendered as an empty box while its text sat in plain sight in the source. §7 had already settled this the other way (a resolved value sets `text` *and* locks the node), so the two rules contradicted each other.

### Guards

Every guard trip resolves to `{kind:'unresolved'}` — never an exception, never a hang, matching `parsePageFile`'s never-throw contract.

| Guard | Default | Purpose |
|---|---|---|
| `maxDepth` | 24 | **Binding hops only.** Descending into an object/array literal's own members does not count — finite source text cannot diverge, and charging it here truncated realistic i18n dictionaries partway down. |
| `maxSteps` | 2000 | Per top-level `evaluateExpression` call. |
| `pageBudget` | 20 000 | Shared across one page load, including every inlined subtree. |
| `cycle` | — | Keyed `${file}#${binding}` for consts and `provider:${file}#${pos}` for provider traces. |

### Memoization is complete-results-only

Resolving a whole `translations` object is memoized per `SourceFile`, and a provider trace (which scans every file in the workspace) is memoized per hook function node, keyed by `preferredKey`.

**A guard-truncated result is never cached.** A truncated value describes the budget that happened to be left at that moment, not the code — caching one made *which page was parsed first* silently decide whether any copy resolved at all. `Budget.truncated` and `trackTruncation` enforce this; both caches check it.

### Resolved nodes are locked

A resolved value is *derived*. Writing an edited literal back over `{t.homepage.greeting}` would destroy the real i18n binding in the user's source file, so the node is locked with `lockReason: 'value from <source>'` and carries `ParsedNode.resolution = { source, note? }` so the editor can explain why.

---

## Structured props — arrays and objects

`ParsedNode.props` is `Record<string, ParsedPropValue>`, where a value may be a scalar, an array, or a plain object (JSON-shaped, because it crosses HTTP to the editor).

This exists because a design-system component's most important props are not scalars. `<ActionSheet actions={[{ label }, { label }]}/>` was reaching the canvas with no actions at all, so the device-picker screen rendered its title over empty space; `<TabBar items={…}/>` rendered no tabs; `<SegmentedControl items={…}/>` no segments.

| Rule | Why |
|---|---|
| **Components only.** An HTML element stays scalar-only | An attribute is a string — an object there could only stringify to `[object Object]`. It also keeps `base.*` modules and the publisher's prop escaping on the scalar diet they were written for |
| A **function** entry is dropped, never stubbed | `{ label, onClick }` becomes `{ label }`. A handler has no JSON form, and a placeholder would claim behaviour the source does not have |
| One **unresolved array item** declines the whole array | Rendering the resolvable half reads as "the list is shorter", not "we could not read the list" — the same rule `readStaticLoop` applies |
| An object left with **no entries** declines | An empty object is not information; an absent prop lets the component fall back to its own default |
| A structured value records **no `Resolution`**, so it does **not** lock the node | `withResolutionLock` locks to protect a *writeback target*, and a structured value is never one (`setJsxProp` writes scalars; the studio save path filters to scalars first). Locking would cost the user the ability to edit the sibling `title` |
| `style` and `dangerouslySetInnerHTML` are excluded from `extractProps` | `extractInlineStyles` and `extractRawSvgMarkup` own them. Before objects resolved, the scalar-only evaluator declined them implicitly; now the exclusion has to be stated |

**The properties panel does not offer to edit one.** `PropertyControlRenderer` renders `StructuredValueControl` — a read-only summary (`2 items · set in code`) — for any array/object value on a scalar control. The `TextControl` it replaces showed `[object Object]` in an editable box, and one keystroke would have replaced a whole array of actions with that string.

**`alm.*` modules declare every prop `Type.Unknown()`.** The generated manifest records `tsType: 'unknown'` for all of them, so `Type.String()` was a lie: `validateNodeProps` ran `Value.Parse`, an `actions` array failed `Check`, and the module fell back to its declared defaults. Declaring the truth passes values through untouched — a boolean `open` stays a boolean instead of becoming `"true"`.

### JSX-valued icon props

`<Cell icon={<Icon svg={rewardCardSvg}/>}/>` is how a design system's icon slots are filled, and a React element has no JSON form. Such a prop is captured as **`{ svg: markup }`** — the same key a node carrying raw markup uses (`resolveModuleId` promotes such a node to `base.svg`), so this is one convention read at two altitudes rather than a new one.

`iconPropFromJsx` reads only the element's **own** attributes, one level deep: its `dangerouslySetInnerHTML`, or any attribute resolving to a string that opens an `<svg>` document. A nested layout declines rather than being flattened into an icon.

The module layer turns it back into an element: `reviveIconProps` in `src/modules/alm/register.tsx` — already the adapter between page-tree JSON and React props — replaces a `{ svg }` value with a `<span dangerouslySetInnerHTML>`, sanitised through `sanitizeSvg` for the same reason `SvgEditor` sanitises (never trust that an upstream layer did).

---

## Inline SVG icons — `?raw` imports

`import icon from './x.svg?raw'` plus `dangerouslySetInnerHTML` is how real repos ship icons. `resolveRawTextImport` (`staticEvalCore.ts`) resolves the specifier to the file's text, so one mechanism covers every path the value travels: read directly, aliased through a local `const`, or passed as a prop and substituted into a component.

### Installed-package specifiers

A bare specifier (`@alm-design/design-system/src/icons/line-icons/headset.svg?raw`) resolves by walking `node_modules` up from the importing file, **stopping at the workspace root** — Node's own algorithm, narrowed to one file. ~23 of the eSIM corpus's icons are imported exactly this way and resolved to nothing before it.

**Containment is checked on the real path, after following symlinks.** A workspace can arrive from `/import-github` and git stores symlinks, so a `node_modules` entry is untrusted input: a textual containment check would happily read `~/.ssh/id_rsa` through a link that merely *looks* like it sits under the workspace. An absolute specifier is never read at all.

The cost is that a **linked** `file:../pkg` dependency (or a pnpm store) does not resolve. Installing the package — a real directory — does.

### SVG through a transform the evaluator cannot run

The common real shape is not a bare identifier but `__html: applyTokens(svg)`, where `applyTokens` **loops** over a substitution table swapping hardcoded hex fills for design tokens. A loop in a callee's body is not executed, so the call is unresolved — and 9 illustration icons on the corpus's homepage rendered as blank 48px boxes with their markup one argument away.

`resolveRawSvgMarkup` falls back to the markup the transform was **handed**: one call level deep, first argument that resolves to an `<svg>` document.

What that gives up, stated plainly: the icon renders with the fills the source file holds rather than the ones the transform would have produced (real hex instead of `var(--color-aqua-*)`, so it does not follow a dark theme). It is the same trade `applySubstitutions` already makes for a computed `className`, keeping the static prefix for visual fidelity — and it beats a blank box, which tells the user nothing about their screen.

---

## Element → module resolution

`resolveModuleId` (`studioPageLoad.ts`) maps a parsed node to an Instatic module:

| Source | moduleId |
|---|---|
| `kind: 'component'` | `alm.<Name>` |
| `div`, `section`, `main`, `header`, `footer`, `nav`, `article`, `aside` | `base.container` |
| `img` / `svg` / `a` | `base.image` / `base.svg` / `base.link` |
| any other tag **with element children**, or **with no text** | `base.container` |
| `button` with text, no children | `base.button` |
| a tag `base.text` can render, with text, no children | `base.text` |
| any other tag | `base.container` |

`base.text` and `base.button` need the care. Both are leaves (`canHaveChildren: false`) — a `<button><Icon/><span>Save</span></button>` mapped to `base.button` would **silently drop its children** — and both render a hardcoded placeholder, the literal words "Text" and "Button", when their content prop is empty. That placeholder is right for a hand-authored page (an empty text block stays visible and clickable) and pure noise on an imported one, where real repos are full of `<span className="hp-avatar" />` icon slots drawn entirely by CSS.

Every tag-bearing module also keeps its real host tag, or a module default silently rewrites the element: `base.container` would turn an `<h1>` into a `<div>`, and `base.text` would turn an inline `<span>` into a block `<p>`. `base.container` can represent any tag (via `tag`/`customTag`); `base.text` has no custom escape hatch, so a tag outside `TEXT_HTML_TAGS` (`<label>`, `<figcaption>`) goes to `base.container` instead of being defaulted to `<p>`.

Measured on the eSIM corpus before these rules: 154 nodes rendered the word "Text", 21 rendered "Button", 10 buttons dropped their children, and 33 spans/headings rendered as paragraphs.

---

## Local assets

`GET /admin/api/studio/asset?dir=<abs>&path=<workspace-rel>` serves an imported page's own images.

`parsePageFile` resolves a local image import to a `studio-asset:<workspace-rel>` sentinel; `rewriteStudioAssetSentinels` turns that into the URL above once `dir` is in scope. That rewrite lives in the load pipeline rather than the pure converter because the query-param shape belongs with the endpoint that owns it.

`resolveStudioAssetResponse` rejects absolute and UNC paths, `..` traversal on either separator, anything under `EXCLUDED_WORKSPACE_DIR_NAMES`, and symlink escapes. Everything rejected is a 404.

---

## Imported CSS

An eSIM-shaped repo attaches styling with `import './Screen.css'` plus a `className`. Studio's renderer never reads a literal `className` — styling attaches through `node.classIds` → `site.styleRules`.

1. **`collectEntryStylesheets`** picks up the **global** stylesheets first — the ones reached from the app's entry module rather than any one screen. It resolves the entry from `index.html`'s module `<script src>` (falling back to `src/main.tsx|jsx`, `src/index.tsx|jsx`, …) and walks relative JS/TS imports from there.

   This matters more than it sounds: in a Vite React app the design tokens and resets live in `src/index.css` and `src/App.css`, imported by `main.jsx`/`App.jsx`. Neither contributes a single node to any page, so a page-only walk never sees them — and every `var(--space-lg)` in a screen's own CSS then resolves to nothing, collapsing all spacing.

2. **`collectPageStylesheets`** works out which per-screen files matter: the page's own file plus every local component file inlined into it, derived from `ParsedNode.loc.file` (which inlining already rewrites to the component's own file). Page first, then in the order nodes first appear; within a file, imports keep source order; deduped keeping the first occurrence.
   - Only **relative** specifiers (`./x.css`, `../y.css`). A bare package specifier is skipped — those components render through their own `alm.*` modules, and pulling a dependency's whole stylesheet into the editable class list would bury the user's own classes.
   - Anything resolving outside the workspace root is rejected.
3. **`loadStudioStyles`** reads each file and parses it with the existing `cssToStyleRules` engine, globals first so a reset precedes the rules that depend on it.
4. **`classIdsForClassName`** splits a literal `className` and maps each name to its rule id, dropping names with no rule — a dangling `classId` would point at something the editor cannot show. The `className` prop is then deleted; it renders nothing on its own.

### CSSOM in Bun

`cssToStyleRules` parses through a real `CSSStyleSheet`. Bun has none, so `studioCss.ts` lazily loads happy-dom (a **runtime** dependency) and passes the constructor in through `CssToStyleRulesOptions.sheetConstructor`.

Two non-obvious requirements:

- **`GlobalWindow`, not `Window`.** happy-dom's CSS parser reports selector errors through `this.window.SyntaxError`, and only `GlobalWindow` puts the JS built-ins on the window object. With a plain `Window`, *every* stylesheet fails with "undefined is not a constructor". `src/__tests__/setup.ts` picks `GlobalWindow` for the same reason.
- **Injection, not `globalThis`.** Assigning browser globals onto a long-lived Bun server would silently change behaviour for every other module that feature-detects them.

### Stable ids

Studio reloads the whole site document on `requestCmsSiteReload()` and on a `shifted` save, so a random id per load would churn selection, undo history, and every `classIds` entry. Ids are `sc-${sha1(kind|name).slice(0,10)}` — same CSS in, same ids out. Timestamps are fixed at `0`; the `.css` file is the record of change.

Two files defining the same class name collapse onto one id, later-parsed file winning — close enough to cascade order for a read-only view, and it keeps `classIds` unambiguous.

### CSS is one-way

**There is no CSS writeback codemod.** Editing one of these rules in the CSS Classes panel updates the in-memory site document and is **lost on the next reload**. The `.css` file on disk is never rewritten.

This is a real, user-visible sharp edge and it must not be discovered by losing work. Two-way CSS editing would need a CSS-text codemod alongside `ast-codemods` — a separate initiative.

### The frame gives percentage heights a definite basis

An imported screen is not a document that flows — it is an app shell: `html, body, #root { height: 100% }` under a `height: 100%` flex column, with the scrolling done by a `flex: 1` region inside. A percentage height only resolves against a parent whose height is **definite**; against `auto` it degrades to `auto`. So a design-canvas body left at `height: auto` (grow-to-content) collapses the whole chain and computes the scroll region to 0.

`useIframeFrameAutoHeight` therefore pins `body.style.height` to the frame height it already measures, floored at `CANVAS_VIEWPORT_HEIGHT`. It unpins to `auto` before each measurement, because a pinned height floors `body.scrollHeight` and a page that got shorter could otherwise never shrink back — the same staleness `resolveCanvasFrameHeight` guards against for `documentElement`.

This is the same move `resolveViewportUnits` makes for `vh`: give authored CSS a definite, device-like viewport to resolve against instead of a value derived from the content it is supposed to size. Grow-to-content still works, because the pin tracks measured content — a 3000px document page pins to 3000.

### Numeric style values get their unit

`style={{ width: size, height: size }}` parses to real numbers. `width: 44` is not valid CSS — the browser drops the declaration, in the canvas and in published HTML alike — so a bare number has to become `44px`. `sanitiseCssValue` sees only the value and can only stringify it, so `cssValueForProperty(prop, value)` (in `@core/css-sanitize`) owns the unit rule and every style-bag emitter goes through it. The rule is React's `isUnitlessNumber` list, so the canvas, the publisher, and anyone who has written JSX all agree. Before this, every inline SVG icon rendered at its own intrinsic size: a 24px check painted 300px wide across its badge.

---

## What still does not import

Honest list, all deliberate:

- **A transform's own effect.** `applyTokens(svg)` loops, so the call does not resolve; the icon renders with the source's raw fills instead of the token-substituted ones ([why](#svg-through-a-transform-the-evaluator-cannot-run)). A transform written without a loop resolves normally.
- **`.map` over data the parser cannot read.** A resolved array is expanded ([above](#bounded-loop-expansion--not-tier-d)); an array reached through props/state/fetch stays one locked, opaque node.
- **Multi-stage screens show every stage at once**, stacked and locked, because choosing one is Tier D. Honest, but a screen with four stages is four screens tall on the board.
- **Computed `className`.** `` className={`esb esb--${tone}`} `` keeps only its static prefix, so the variant class never attaches.
- **Linked package dependencies.** A `?raw` import from a symlinked `file:../pkg` (or a pnpm store) does not resolve — containment is checked on the real path ([why](#installed-package-specifiers)). Install the package instead.
- **A JSX-valued prop that is not an icon.** `iconPropFromJsx` recovers inline SVG markup one level deep; a prop holding a nested layout is dropped rather than flattened.
- **Only the `previewLocale` branch.** The other locale exists in the dictionary but is not rendered; RTL is not applied.
- **Dynamic SVG.** An `<svg>` whose captured text contains `{` is treated as dynamic and renders as an empty placeholder. Conservative: a static SVG containing a literal `{` (an embedded `<style>` block) is a false positive.
- **`{children}` splicing depth.** Spliced content that is itself an intermediate inlined id from a deeper nesting level would produce a dangling reference. Does not occur in practice; documented in `inlineLocalComponents.ts` rather than solved with general bookkeeping.
- **Everything §7 resolved is read-only** on the canvas, by design.

---

## Testing

| Area | Test |
|---|---|
| Value evaluator, all tiers + guards | `src/core/page-parser/__tests__/staticEval.test.ts` |
| Local-component inlining | `src/core/page-parser/__tests__/inlineLocalComponents.test.ts` |
| `.map` expansion | `src/core/page-parser/__tests__/staticLoopExpansion.test.ts` |
| Every `return` renders, `return null` guards don't lock | `src/core/page-parser/__tests__/multipleReturns.test.ts` |
| Structured + JSX-valued props | `src/core/page-parser/__tests__/structuredProps.test.ts` |
| `?raw` imports, `node_modules`, symlink containment, transform fallback | `src/core/page-parser/__tests__/rawSvgImports.test.ts` |
| Panel never offers an editable input for a structured value | `src/__tests__/property-controls/PropertyControlRenderer.test.tsx` |
| Stylesheet collection, ordering, escape rejection | `src/core/studio-sync/__tests__/collectPageStylesheets.test.ts` |
| CSS round-trip, id stability, classIds | `server/handlers/__tests__/studioCss.test.ts` |
| Asset route guards | `server/handlers/__tests__/studioAsset.test.ts` |
| Load/save endpoint contract | `server/handlers/__tests__/studio.test.ts` |
| Save write-loop safety | `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` |
