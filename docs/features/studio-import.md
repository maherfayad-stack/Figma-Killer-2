# Studio Import

Studio can open a **real React repository** — one written by hand or pulled straight from GitHub — as an editable board, without that repo knowing anything about Studio.

The load path is `GET /admin/api/studio/load?dir=<abs>` → `loadStudioPages` (`server/handlers/studioPageLoad.ts`). Everything below describes what that pipeline does to arbitrary source and, just as importantly, what it deliberately refuses to do.

---

## TL;DR

- **Studio parses source structurally. It never executes it.** No component is rendered, no hook is called, no module is evaluated. Every value on the canvas was read out of the AST with ts-morph.
- **Page discovery is configurable.** `.studio/meta.json`'s `pagesDir` points at a repo's real screens directory (e.g. `src/screens`); `.tsx` and `.jsx` are both discovered.
- **Written for any React repo, not one app.** `genericRepoShapes.test.ts` is a second fixture that shares nothing with the validation corpus — `.tsx`, arrow components, named exports, a barrel between page and component, typed data modules — and exists because a suite grown from one repo's defects encodes that repo's habits.
- **Local components are inlined.** A `<Card />` whose import resolves inside the workspace is expanded into its own JSX so the canvas shows real markup, not an opaque box. The call-site node is **replaced** by that JSX, not left wrapping it. Inlined nodes are **editable**, and the panel says how many places an edit will land in.
- **Package components are not.** `@alm-design/design-system`'s `<Button />` stays a `alm.Button` node rendered by its own module.
- **`.map` over a statically-resolved array is expanded** into one node per item, so a list renders as a list. Rows are locked (derived from data).
- **The parser SELECTS one `return`** (parser-06) — the last JSX-bearing one, the component's "normal" state — and leaves it unlocked. A screen with `if (stage === 'loading') return …` shows the branch that survives every guard; the guard branches are recorded as `label` + source location (`ParsedNode.branchAlternatives`), never rendered. A ternary/`&&` inside JSX gets the same treatment one level down (parser-07 closed a gap where `&&` used to render unconditionally, with no static check at all), and both honor a `useState(<literal>)` binding's own initial value as a real, first-paint answer when the condition names one.
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
└── studioWriteback.ts    — StudioEdit shapes, tail-resolved edit locations, dedupe, path containment

src/core/page-parser/
├── parsePageFile.ts          — the ts-morph JSX walk → ParsedPage
├── inlineLocalComponents.ts  — local-component expansion: structure, composite ids, call-site replacement
├── componentSubstitution.ts  — the value half: call-site props → the component's own JSX
├── staticLoopExpansion.ts    — `.map` over a resolved array → one node per item
├── jsxAttributeReaders.ts    — how each attribute shape is read (props, style, raw SVG)
├── inlineSvg.ts              — an `<svg>` written as JSX elements → markup for `base.svg`
├── staticEvalTypes.ts        — pure leaf: the evaluator's value/scope types incl. `ValueOrigin`
├── componentSources.ts       — local vs package classification, workspace-wide ts-morph Project
├── staticEval.ts             — public composer for the value evaluator
├── staticEvalCore.ts         — Tier A + the recursive walker + binding resolution
├── staticEvalCalls.ts        — Tier B (hook → provider) + Tier C (pure calls)
├── staticEvalOperators.ts    — Tier A operators: arithmetic, concatenation, unary, `&&`/`||`/`??`
├── assetImports.ts           — imports that name a FILE: `?raw` → text, image → `studio-asset:` path
└── resolutionLock.ts         — resolved value → lock + `resolution`; scalar vs structured prop values

src/core/studio-sync/
├── parsedPageToSitePage.ts    — ParsedPage → Studio Page (moduleId, text prop, classIds, codeProps)
└── collectPageStylesheets.ts  — which .css files a page depends on, in cascade order

src/core/page-tree/
├── sourceNodeId.ts            — the studio node-id grammar: separators, decode, "is there one place
│                                 to write this?" (false for a `.map` iteration)
└── sourceWritability.ts       — the ONE per-prop rule every edit surface asks (`codeProps`)

src/core/ast-codemods/
└── setJsxTagName.ts           — renames an HTML element; the writeback behind the `tag` property

src/modules/alm/
└── register.tsx               — design-system components as modules; revives `{ svg }` props into elements;
                                  layout-transparent host so a component keeps the author's layout

src/admin/pages/site/property-controls/
└── CodeValueControl.tsx        — read-only stand-in for any prop this panel cannot write

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

### The app root is not always the project directory (`approot-01`)

A GitHub import lands at `studio-workspace/<project>/`, but the real app's
`package.json` doesn't have to sit there — a monorepo (`apps/web/`), an
`examples/` folder, or a repo that keeps its app in a named subdirectory
(`journey-screens/`) are all real shapes. `probeProject`'s `detectAppRoot`
searches the project directory itself, then its immediate children, then
their children (bounded, never a full-tree walk) for the nearest
`package.json`, and stores the result on `ProjectProfile.appRoot` — a
project-relative POSIX path, `''` when the app root is the project directory
(the common case). When several candidates exist at the same depth (a real
monorepo), it ranks them (framework config presence, `src/` presence,
dependency count) and reports the full list on `appRootCandidates` plus an
`app-root-ambiguous` warning, rather than silently picking.

Every OTHER probe detector (framework, pages dir, style toolchain, aliases,
component packages) runs rooted at the resolved app root — but every path
`ProjectProfile` returns (`pagesDir`, `entryFiles`,
`styleToolchain.*.configPath`) is re-prefixed with `appRoot` before being
stored, so it stays project-relative and every existing `join(dir, ...)`
call site (`projectPagesDir`, `styleCompileTier1.ts`) keeps working
unchanged. A consumer that needs the app root ITSELF resolved — to spawn
`bun install`, to resolve `<appRoot>/node_modules/<pkg>`, to bundle a
package component — calls `resolveAppRoot(dir)` (`server/handlers/studio/
appRoot.ts`), real-path containment-checked against `dir` (the value is
cached in hand-editable `.studio/meta.json`, so it is never trusted blindly).

### Install jobs survive a server restart (`infra-01`)

The dev server runs under `bun --watch`, which restarts on every file edit —
including edits an agent makes while a user's `bun install` job is still
running. `installDeps.ts`'s job registry is an in-memory
`Map<jobId, JobRecord>`, so a naive implementation would strand the client
polling a `jobId` the new process has never heard of, 404ing forever (from
the UI: "the install button did nothing"). Every job is now ALSO mirrored to
`<appRoot>/.studio/install-job.json` (`installJobStore.ts`) at start and at
completion. A status query that finds a record on disk with no matching
in-memory job — the process that owned it is gone — resolves it to a
terminal `'interrupted'` status rather than reporting a phantom `'running'`
forever (`resolvePersistedJobStatus` in `installDeps.ts`). Both status routes
(`GET /admin/api/studio/install/status?dir=` and
`GET /admin/api/studio/install/:id?dir=`) go through this resolution, so a
completed-then-restarted install is still reported correctly — paired with
`hasNodeModules`'s live disk check, which settles whether dependencies
actually landed regardless of what the job record itself could observe.

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

### The call site is an instance, not a wrapper (WS-4.2)

`<SheetShell/>` renders SheetShell's own root `<div>` at that position; a component call emits no element of its own. Through M2, expansion **replaced** the call-site node with the component's root(s) outright, so no node represented the call site at all. WS-4.2 replaces that with the **instance fragment model**: the call site is KEPT — it takes `moduleId: 'studio.instance'`, its own literal/resolved props move to `props.callSiteProps`, and the inlined subtree becomes its `children` instead of splicing into the call site's own position. `NodeRenderer` renders a `studio.instance` node as a bare React Fragment (`src/modules/base/instance/InstanceEditor.tsx`) — **zero DOM elements**, strictly better than the `display: contents` trick the design-system host uses (that still creates an element, which breaks `:nth-child`/sibling selectors landing on either side of it; a Fragment breaks nothing).

A leftover wrapper element breaks two things silently — this is why "zero DOM" is the whole point, not a detail:

- **Percentage and flex height chains.** `.sheet-shell { height: 100% }` resolves against the wrapper's `auto` height, collapsing the shell to its own content height and every `flex: 1` scroll viewport inside it to 0. Measured on the eSIM corpus: 1447px of a screen's body clipped to nothing, with the header still visible above it.
- **Direct-child and sibling combinators** that cross the call site: `.sheet-shell__panel > .booking-confirmation__scroll` stops matching.

This is the same invariant the per-frame iframe exists to protect (`IframeFrameSurface`, "no `display: contents` NodeWrapper divs"): the canvas DOM must be the DOM React renders, or authored CSS quietly means something different here than in the app. `tests/e2e/instance-fragment-node.e2e.ts` proves both halves against the real eSIM corpus in a real browser: `.sheet-shell`'s `height: 100%` resolves to a real, non-trivial pixel height (not a collapsed one), and `.sheet-shell`'s DOM parent is the page's own root container with nothing editor-inserted in between.

Unlike the old replace-in-place design, a call site's own literal props (`<Icon size={24}/>`'s `size`) **are** now editable — as `ParsedNode.instanceOf.callSiteProps`, because the call site keeps its own id (a real, writable source location, never composite) instead of being deleted. `parsedPageToSitePage.ts` mirrors `instanceOf` onto `PageNode.props` as `{ componentName, source, sourceFile, callSiteProps }`, and a non-writable call-site prop is named `callSiteProps:<name>` in `codeProps` — the same `style:<property>` convention `isPropWritableToSource` already generically supports, so writability needed no new predicate. `applyStudioEdit` (`studioWriteback.ts`) strips the `callSiteProps:` prefix before calling `setJsxProp`, because the instance node's own id **is** the call site.

### Detach and swap (WS-4.4/4.5)

`src/core/ast-codemods/detachComponent.ts` inlines a LOCAL instance's own JSX at its call site, substituting the callee's params with the call site's own argument **expressions** (never evaluated values — `title={plan.name}` stays a binding), reconciling every import the pasted JSX now needs, and removing the component's import if this was its last usage. It **refuses**, with a specific reason, rather than guessing: a hook call anywhere in the body (`uses-hooks`), a `.map` over one of the component's own props (`maps-over-props`), an undestructured `props` parameter (`unsupported-params`), a package (not local) component (`package-component`), or an unresolvable declaration (`unresolvable`). A component with more than one JSX-bearing `return` (parser-06 already selects one) is **not** refused — detach inlines the branch actually shown and reports it via `branchNote`.

`src/core/ast-codemods/extractComponentCopy.ts` is the refusal escape hatch: duplicate the component under the next free numeric suffix (`Card` → `Card2`), rename the copy's own export, and repoint just the one call site — no inlining, so none of detach's refusal conditions apply.

`src/core/ast-codemods/swapComponentInstance.ts` retargets an instance at a different component: renames the JSX tag (self-closing, or opening+closing — a self-closing element's `.getParent()` is whatever CONTAINS it, not "its own open+close pair"; get that wrong and a nested instance's swap corrupts the ENCLOSING element's closing tag instead — a real bug this module's tests caught and pin down), adds/repoints the import, and diffs the prop sets — a prop the new component doesn't accept is removed and reported (`removedProps`), a required prop (no destructured default) the new component adds is left for the user to fill in and reported (`unfilledRequiredProps`), never synthesized. Refuses when the new name would shadow an existing binding in the page file.

All three share `resolveComponentCallSite.ts`'s "what does this JSX tag identifier actually refer to" resolution — the same local/package classification, barrel/rename-aware lookup, and declaration walk `inlineLocalComponents.ts` uses for the identical question.

Measured against the real eSIM corpus (139 `studio.instance` nodes on the board): 59 detach cleanly; 42 refuse `uses-hooks` (`StatusBar`'s `useState`, and `useLanguage()` — the i18n hook — used throughout); 38 have no single writable call-site location at all (they sit inside a `.map()` row — the pre-existing, unrelated "no writable source location" rule, unchanged by WS-4).

### Imports are followed through barrels

A named import is classified against the file that actually DECLARES it, not the file the specifier names — `resolveExportedDeclaration` walks `export { X } from './X'` and `export * from './X'` chains via ts-morph's own `getExportedDeclarations()`, and returns the declaration's own name so a renaming barrel (`export { Card as PlanCard }`) resolves too.

Without this, `import { Card } from '../components'` recorded a local component whose file (`components/index.ts`) declares nothing, inlining bailed, and the node stayed an opaque box. A barrel between a page and its components is one of the most common layouts there is; the validation corpus simply does not use one.

### A component's own JSX is re-read against the call site's values

`applySubstitutions` re-reads props, inline styles, `className`, the raw-SVG markup, and the single-text-leaf against a scope where the component's **parameters** are bound to what the call site passed.

The substitution table alone only covers a param forwarded verbatim (`{paramName}`). Everything read OFF a param needs the evaluator: `title={plan.name}`, `{seatLabel(plan.seats)}`, `{money(plan.monthly)}`. A component that takes an object and renders its fields is the normal way to write a typed React component, and none of it resolved — the component's own file sees `plan` as a parameter with no value anywhere in it. Combined with structured props, a loop item forwarded as an object prop now resolves three hops out.

### Inlined nodes are editable, with their blast radius shown

An inlined subtree is one component's markup shown at one call site, and a composite id's writeback target is its tail — the component's own source location, which is a real, valid place to write. So these nodes are **editable**. What they are not is *isolated*: one file backs every instance, so an edit lands on all of them. `ParsedNode.fromComponent` carries the component name, and `SharedComponentNotice` states the consequence next to the controls that would cause it, with a live instance count (one `Icon.jsx` line sat behind 29 board nodes on the corpus).

A node locked for its **own** reason (`.map`/ternary/spread/dynamic value) stays locked — that lock is about having no single valid writeback target at all, which inlining does not change.

---

## Static value resolution

`extractProps`/`extractSingleText` capture string/number/boolean **literals**. In a real repo almost nothing is a literal — copy comes from `{t.homepage.greeting}` behind a `useLanguage()` hook. Without resolution, an import produces a structurally perfect, visually empty wireframe.

The evaluator (`staticEval.ts` and friends) is a **bounded partial evaluator, not a JavaScript interpreter**. Its tiers are the boundary; do not blur them when extending.

### Tier A — literals, consts, member chains, operators

Module-scope and cross-file `const` objects/arrays, component-body aliases, computed members with a resolvable key, template literals with resolvable parts, array indexing. A partially resolvable template keeps its static prefix (`` `esb esb--${tone}` `` → `partial: 'esb esb--'`).

Also **operators** (`staticEvalOperators.ts`), which are pure functions of source text:

| Shape | Notes |
|---|---|
| `+ - * / % **` | `/` and `%` by zero decline rather than emit `Infinity`/`NaN` |
| `+` with a string operand | concatenation |
| `-x`, `+x`, `!x` | also what makes a negative literal (`{-4}`) resolve — `-4` is a prefix expression, not a numeric literal |
| `a \|\| b`, `a && b`, `a ?? b` | return an **operand**, not a boolean: `{title \|\| 'Untitled'}` renders a string |
| `Math.PI`, `Math.E`, … | constants, which are property accesses, not calls |
| `Math.round/max/min/abs/…` | pure functions; `Math.random` is deliberately excluded |

Arithmetic in a JSX value is ordinary React and none of it resolved before: `const CIRCUMFERENCE = 2 * Math.PI * RADIUS` is how every progress ring is drawn, and `Math.max(0, Math.min(100, pct))` is how a percentage is clamped. `Math.*` calls had been *admitted* by `isWhitelistedCallShape` since Tier C landed, but nothing computed them — `Math` is not a resolvable binding, so the receiver check rejected all of them.

### Tier B — hook → context provider

Traces `useLanguage()` → `useContext(Ctx)` → the single `<Ctx.Provider value={…}>` in the workspace, unwraps a `useMemo`, and evaluates the value object **in the provider component's own scope** (the shape is almost always `value={value}` referring to a `const` in that component's body).

Two providers for the same context ⇒ `unresolved`. Ambiguity is never guessed at.

`translations[lang]` indexes a dictionary with runtime state. §7.4 picks a branch — `previewLocale` if it names a real key, else the first key in source order — and attaches a `note` so the editor can say which branch it chose.

### Tier C — pure function calls

Calls a resolvable arrow/function inside `qualifiesForTierC`'s explicit envelope: a concise-expression body, or a block of bare `if (cond) return …` / `return …` statements, with no assignment, loop, `await`, `new`, or non-whitelisted member call anywhere in a reachable sub-expression. Whitelisted: `String`, `Number`, `Math.*`, `.toFixed`, `.padStart`, `.toUpperCase`, `.toLowerCase`, `.trim`, `.join`.

### Value-level ternaries resolve when the condition does

`cond ? a : b` evaluates its condition with `evaluateCondition` (`&&`/`||`/`!`, the six comparisons, a bare boolean) and returns the taken branch. This is the same act Tier C already performed for `if (cond) return x` in a callee body, so declining it was an inconsistency: a dictionary's pluraliser is `` (days) => `+${days} Day${days === 1 ? '' : 's'}` ``, and refusing the ternary left every "Days" row blank while the "GB" rows — identical but for the suffix — resolved.

**A ternary whose branches contain JSX declines regardless of the condition**, and that is checked rather than assumed. Markup stays the structural walk's decision alone; see Tier D.

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

**Expansion does not depend on where the `.map` sits.** It fires for a direct `{items.map(…)}` child and equally for one reached through a ternary (`{tab === 0 ? A.map(…) : B.map(…)}`), a `&&`, or a `return` that is itself the conditional — `collectFromExpression` expands a loop met on the way down instead of walking into the callback. It used to live only in `processChildren`, so the same list wrapped one level deeper collapsed to ONE row per branch with every item-dependent value unresolved. Which of two equivalent spellings a repo happens to use is not something the result may depend on.

Measured on the eSIM corpus: 955 → 1062 nodes, 60 → 78 rendered icons (many icons live inside list rows), 773 → 868 styled elements.

### One `return` renders — the parser SELECTS a branch (parser-06)

`getReturnedJsxRoots` finds **every** JSX-producing `return` in a component's body, in source order, but marks exactly **one** `chosen`; `parseJsxTree` walks only that one into real `ParsedNode`s.

This replaced an earlier policy change that went the other way: for a while, EVERY JSX-bearing return rendered, stacked and locked, reasoning that choosing a branch would mean evaluating the condition (Tier D) — the same rule already applied to a ternary's two sides. That was correct about the tier boundary and wrong about the user experience: it put a genuine, measured visual defect on the board. A card with a loading state, an empty state, and a loaded state rendered **all three, stacked in a column**, on every screen that used it — never what a real user sees. Measured on the eSIM corpus before this change: 176 `MULTI_BRANCH_ALL_RENDERED` findings, the second-most-common finding on the board, and the homepage screen's "2 eSIMs for your trip" card rendered three times in three different visual states.

**The rule: the LAST JSX-bearing return is chosen.** Guard clauses — loading, empty, error — are overwhelmingly written as early returns; the return that survives every guard is the component's real, "normal" content. This is still not Tier D: nothing is *evaluated* (no `loading`/`stage` variable is ever read) — only a *position* in the source is preferred, the same kind of decision the label-derivation below already makes about which `if` a return sits under.

| Rule | Why |
|---|---|
| The LAST JSX-bearing return is `chosen`; it alone contributes nodes | Guard clauses return early; the return that survives every guard is the normal state |
| The chosen branch is **unlocked** | The structure at that location is completely ordinary — the parser is certain of it, it only chose which of several runtime states to show by default |
| Every OTHER branch is recorded as a `BranchAlternative` (a label + its own source location) on the chosen node, via `ParsedNode.branchAlternatives` — never parsed into nodes | Cheap (zero node-count cost), and honest: the alternative is addressable, not silently discarded, without pretending the parser knows it also renders |
| The label is the branch's own guard `if` condition text (`"loading"`, `"!items.length"`), or a positional fallback | Matches how a person reading the source would name the branch |
| A `return null` guard does **not** count | It contributes no nodes; counting it would make a single real return look like "the chosen one of several" for no reason |
| Returns inside a nested callback are ignored | They belong to the callback, not the component |
| A component whose ONLY return sits inside an `if`, with no fallback return | Treated as a plain single-return component — nothing to choose between |

**A ternary or `&&` inside JSX gets the identical treatment one level down** (`selectJsxBranch` in `src/core/page-parser/branchSelection.ts`): a ternary prefers the consequent (same "first-written branch is normal" rule), and BOTH honor a statically-decidable condition over the heuristic when one is available — a real answer always outranks a guess at "which is normal". `||`, and any construct the walk cannot resolve to a single branch/row (an unresolvable `.map`, another function call), are unchanged — still shown and locked as `dynamic — rendered in code`.

**`&&` (parser-07)** used to be the one branch-selection path with no static check at all — its right side rendered UNCONDITIONALLY, so `{showDataHelp && <Overlay/>}` stacked the overlay on the base screen even when `showDataHelp` starts `false`. Measured against the real eSIM board: 3 of 15 screens rendered wrong for exactly this reason. It now gets the SAME `evaluateStaticCondition` check the ternary side always had:

| Condition | Result |
|---|---|
| Statically **false** | Nothing renders at this position — no node, not even a locked one, because the source places nothing here |
| Statically **true** | The right side renders, unlocked, no alternative (nothing to switch to) |
| Not statically decidable | Falls back to today's behaviour (render the right side), but now records the HIDDEN state as a `branchAlternatives` entry pointing at the same JSX — not silently assumed away |

`evaluateStaticCondition` (Tier A/B only) covers a literal, a module-scope const, AND — parser-07 — a binding's own DEFAULT literal value, read directly off the source (`src/core/page-parser/staticEvalCore.ts`'s `resolveConditionDefaultLiteral`). Two shapes, checked in order, a name is never both:

1. **A destructured prop parameter's own default** — `function Foo({ introVariant = 'checklist' })` reads `'checklist'` the same way `componentSubstitution.ts`'s `buildSubstitutionEnv` already does for a locally-inlined call site's fallback value; this is that identical read, reached when there is no call site at all (a page parsed standalone, which is exactly how a `.studio/boards.json` screen gets parsed).
2. **A `const [x] = useState(<default>)` binding** — `const [showDataHelp] = useState(false)` reads the literal `false` directly; `const [step] = useState(initialStep)` recurses ONE hop into lookup 1 when the argument is itself a defaulted parameter (the real eSIM shape — `ActivationFlowScreen`'s five `step === '…' && <Screen/>` overlays are gated by exactly this: `useState(initialStep)` where `initialStep = 'intro'` is the parameter's own default, not a bare literal at the call).

Both are Tier A, not Tier D — nothing is executed, no hook runs, no setter is simulated, no call site is guessed at; the literal the author wrote in the signature/hook call is read the same way a `const` initializer already is, and the result is the component's FIRST PAINT with no props passed, exactly what a design tool should show by default. The boundary is narrow and deliberate: the default must itself be a bare literal (a computed/prop-derived value with no default anywhere stays unresolvable), the binding must never be reassigned elsewhere in the function body (a `let`-mutated pair falls back to unresolvable too), only the function's own top-level statements/first parameter are scanned (flat, not block-scoped — same simplification `buildComponentLocals` already makes), and — critically — this is wired ONLY into condition evaluation, never into the general identifier-resolution chain (`resolveIdentifier`/`buildComponentLocals`) every other Tier A/B path shares. Wiring it in generally would also feed Tier B.4's dynamic-dictionary-key pick (`translations[lang]` where `lang` is `useState('en')`), silently overriding the `previewLocale` option the language-switcher pattern depends on — see `staticEval.test.ts`'s provider-tracing tests.

Measured on the eSIM corpus, before parser-06: 176 `MULTI_BRANCH_ALL_RENDERED` findings. See `STATE.md`'s `parser-06`/`parser-07` entries for the after counts.

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

### Structure is locked; values are decided per prop

Two different facts used to share one field, and conflating them made most of an imported app uneditable.

- **`locked` / `lockReason`** describe the node's **structure**: the source does not simply place it. A `.map` generated it, a ternary or `&&` chose it, a spread feeds it. It may not be moved, deleted, reordered, or wrapped.
- **`codeProps`** describes its **values**: the prop names with no writable target, because the source holds an expression rather than a literal attribute. Inline-style entries appear as `style:<property>`.

Structure says nothing about values. Which branch renders at runtime has nothing to do with whether `title="Where to?"` on that branch's element is a literal attribute at a known line and column — it is one, and `setJsxProp` rewrites it precisely. **45% of the nodes on the eSIM board are structurally locked** (a screen that opens `if (loading) return <Spinner/>` puts its entire main return behind a branch), so gating values on the structural lock refused nearly everything:

| | editable props, eSIM screens | |
|---|---|---|
| | before | after |
| structurally locked nodes | 0 of 63 (0%) | **40 of 63 (63%)** |
| unlocked nodes | 120 of 120 | 116 of 120 (the 4 lost are genuinely code-valued) |
| `.map` rows | 4 of 127 | 4 of 127 (unchanged — see below) |
| **all** | **124 of 310 (40%)** | **160 of 310 (52%)** |

A prop is code-valued when §7's evaluator resolved it (`title={c.sheetTitle}` — writing there would replace the binding with a baked literal), or when it holds a structured or JSX value with no scalar source form (`actions={[…]}`, `icon={<Icon/>}`). **A `.map` row has no source location of its own** (`hasWritableSourceLocation` is false for a `…#2` id), so every one of its props is code-valued: one piece of JSX renders all the rows, and a write there would change all of them. Its resolved *text* is the exception — that came from its own array element, and `textOrigin` says which literal.

`isPropWritableToSource` in [`src/core/page-tree/sourceWritability.ts`](../../src/core/page-tree/sourceWritability.ts) is the single predicate. Every surface asks it, so what the panel offers and what the store accepts can't drift:

| Surface | Behaviour |
|---|---|
| `updateNodeProps` / `setNodeInlineStyles` | Refuse a patch if **any** key is code-valued — all-or-nothing, because a half-applied patch is a canvas that disagrees with the file it mirrors. Silent: both are also called by agents and plugins, where a toast would be noise |
| Properties panel, top | `SourceLockedNotice` — the structural reason, `resolution.note` when the evaluator had to choose a branch, and which individual props stay read-only |
| Prop rows | `CodeValueControl` for a code-valued prop only (`propLockReason`); its literal siblings get their ordinary control |
| In-place canvas inspector | Same `propLockReason`. It previously rendered a live-looking input for every prop, including ones the store was about to refuse |
| Inline styles | `InlineStyleComposer` is offered unless the node is a `.map` row. Per-property refusals happen in the store. **Classes are unaffected** either way — assigning one writes `node.classIds`, which none of this gates |
| HTML attributes tab | `readOnly` only when `htmlAttributes` itself is code-valued |
| Canvas double-click | An `info` toast when the **text prop** is code-valued. Announced where the store's other early-returns stay silent, because it is the only one a user can mistake for a bug: they double-clicked real copy sitting right there and nothing happened |

### Resolved TEXT is editable, at its origin

Explaining a dead field is not the same as fixing it, and copy is the thing users actually came to edit. So resolved text now writes — not to the JSX, but to the string it reads.

`ParsedNode.textOrigin` (`ValueOrigin`: workspace-relative path + 1-based line/column) records where a resolved text's literal physically lives. `{c.hotelsTag}` resolves to `hotelsTag: 'Exclusive rates on hotels'` at `src/i18n/translations.js:142:18`, and **that** is a perfectly ordinary string literal to rewrite. On the eSIM corpus, **106 of the 149 locked-with-text nodes have a writable origin.**

How each piece knows:

| Layer | Mechanism |
|---|---|
| Evaluator | `origin` is attached at the ONE place a literal is read out of a file, so every path that merely passes the value along (identifier → const → `pluck` → array index) carries it for free, and every path that COMPUTES a value (template, concatenation, arithmetic, a call) cannot |
| Parser | `textOrigin` on the node, scoped to text on purpose — see below |
| Sync | `parsedPageToSitePage` leaves the text prop OUT of `codeProps` when an origin exists — so "writable" needs no special case downstream, it falls out of the one predicate |
| Store | `updateNodeProps` and `startInlineEdit` both consult `isPropWritableToSource`, so canvas double-click and the panel field agree |
| Panel | `propLockReason` offers that prop and keeps the genuinely code-valued ones read-only |
| Save | `saveSite` emits `kind: 'literal'` with the ORIGIN's `rel:line:col` as its `nodeId`, so the server's existing ordering, dedupe, and touched-file logic all apply unchanged |
| Codemod | `setStringLiteral` replaces the literal at that exact position, preserving the file's quote style |

**Scoped to text, not hung off `resolution`.** A node can resolve several values (text, `className`, an aria label) and `resolution` keeps only the first — so an origin there could point at the literal behind a *different* prop than the one being edited, and a writeback aimed at the wrong string is worse than none.

**A `.map` row's copy is individually editable.** Each iteration resolved a different array element, so each carries its own origin. The origin path deliberately runs before the `hasWritableSourceLocation` guard in `saveSite`, because that guard is about JSX locations and a literal edit has nothing to do with the node's own id.

**Shared copy says so.** A dictionary key is shared by design, so the notice counts how many nodes resolve to the same literal and warns before the user commits — the same treatment `SharedComponentNotice` gives a shared component.

**Still not editable:** a computed text (`` `${count} left` ``) has no single literal to rewrite, so `codeText` is set with no origin and `parsedPageToSitePage` puts the text prop into `codeProps`.

### `tag` renames the element

`tag` is the one editor property that is not an attribute: `parsedPageToSitePage` synthesizes it from the element's **name** so an imported `<h1>` keeps rendering as an `<h1>` instead of `base.container`'s default `<div>`.

Routing it through `setJsxProp` therefore did the wrong thing quietly — it added a literal `tag="section"` attribute, which React passes to the DOM as an unknown attribute, while the element stayed a `<div>`. On the eSIM screens that was **140 properties** worth of controls that looked live, changed the canvas, and wrote junk into the user's file.

It now has its own edit kind and codemod. `saveSite` collapses `tag`/`customTag` into one effective name (`effectiveTag`), diffs it against the load baseline, and emits `kind: 'tag'`; `setJsxTagName` renames the opening and closing tag together. Restricted to `base.*` nodes, whose source element IS the host tag at that location. It fails closed on a component reference (`<Sheet>` → `<Dialog>` would need the new name imported and in scope) and on anything that is not a plain HTML tag name.

### The writeback path is contained

`studioEditLocation` now rejects a `rel` that is absolute, contains a `..` or empty segment, or does not end in a JS/TS extension.

This was a real hole, not a hypothetical one: the whole edit batch arrives from the client with `rel` inside each `nodeId`, and the save route builds its target with `join(dir, rel)` — so a `nodeId` of `../../.ssh/config:1:1` was an arbitrary file write. Nothing legitimate produces one (the parser mints ids from `path.relative(workspaceRoot, file)` for files it already found inside the workspace), and the check lives in the single decoder every path shares, so ordering, dedupe, touched-file collection, and apply all inherit it.

### A save only reloads when a write actually landed

A reload re-parses the whole workspace and replaces the document. That is required when a write **landed** and either moved line numbers (`shifted` — every `line:col` id below the write is stale) or rewrote a shared component (`sharedComponents` — every other instance on the board shows a stale value). It is destructive when **nothing** landed, because the reload then overwrites the user's in-memory edit with the unchanged source.

That combination was reachable and routine. `<p className="sheet-header__title">{title}</p>` renders a prop the *call site* passes, so `setJsxText` refuses it (correctly — writing a string there would delete the binding), while the node is inlined, so `sharedComponents` was `true`. The server reported `written: 0, skipped: 1, sharedComponents: true` and the client reloaded on top of the edit: **the user's change reverted itself about two seconds after they typed it**, on the autosave cadence, with nothing in the UI to explain why.

Three rules now hold:

| Rule | Why |
|---|---|
| The reload is gated on `written > 0` | With no write, the document still matches the files — there is nothing to re-sync, and reloading can only discard the user's edit |
| `applyStudioEdit` returning `false` counts as `skipped`, not as nothing | It used to increment neither counter, so an edit that resolved to no writable location was invisible to the client, which then assumed a write had happened |
| `skipped > 0` raises a toast | The failure was silent. A refusal the user cannot see is indistinguishable from data loss |

Prop-forwarded text is still not editable on the canvas — the honest fix is to resolve it to the call site the way `textOrigin` already resolves dictionary copy ([resolved text is editable, at its origin](#resolved-text-is-editable-at-its-origin)), which is a parser change, not a writeback one. Until then the user is told, rather than left to discover it.

`loadSite` also **keeps the page that is currently open** when the incoming site still contains its id, instead of always resetting to the home page. Resetting is right when opening a different project and wrong when re-syncing the one already open: it threw the designer back to the home page mid-edit, which read as the canvas moving on its own.

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

**The properties panel does not offer to edit one.** `PropertyControlRenderer` renders `CodeValueControl` — a read-only summary (`2 items · set in code`) — for any array/object value on a scalar control. The `TextControl` it replaces showed `[object Object]` in an editable box, and one keystroke would have replaced a whole array of actions with that string.

**`alm.*` modules declare every prop `Type.Unknown()`.** The generated manifest records `tsType: 'unknown'` for all of them, so `Type.String()` was a lie: `validateNodeProps` ran `Value.Parse`, an `actions` array failed `Check`, and the module fell back to its declared defaults. Declaring the truth passes values through untouched — a boolean `open` stays a boolean instead of becoming `"true"`.

### JSX-valued icon props

`<Cell icon={<Icon svg={rewardCardSvg}/>}/>` is how a design system's icon slots are filled, and a React element has no JSON form. Such a prop is captured as **`{ svg: markup }`** — the same key a node carrying raw markup uses (`resolveModuleId` promotes such a node to `base.svg`), so this is one convention read at two altitudes rather than a new one.

`iconPropFromJsx` reads only the element's **own** attributes, one level deep: its `dangerouslySetInnerHTML`, or any attribute resolving to a string that opens an `<svg>` document. A nested layout declines rather than being flattened into an icon.

The module layer turns it back into an element: `reviveIconProps` in `src/modules/alm/register.tsx` — already the adapter between page-tree JSON and React props — replaces a `{ svg }` value with a `<span dangerouslySetInnerHTML>`, sanitised through `sanitizeSvg` for the same reason `SvgEditor` sanitises (never trust that an upstream layer did).

### The design-system host carries no layout

`makeComponent` mounts every design-system component under a host `<div>` that carries the editor's selection/hover/keyboard wiring — a third-party component cannot be relied on to forward `nodeWrapperProps` onto its own root. That host is `display: contents`, so it generates **no box**.

As an `inline-block` it shrink-wrapped, and every full-width design-system button on an imported screen came out at its intrinsic width. The source styles them the ordinary way:

```css
.esim-sheet__footer .btn { width: 100%; }
```

That selector matched the real `<button>` fine — but `100%` resolved against the shrink-to-fit host, which is the button's own content width. The same box also stopped the component participating in its parent's flex/grid layout, so `align-self: flex-start` on a design-system button did nothing.

Two consequences worth knowing:

- **The node's classes go on the design-system component, not the host.** They used to be applied to *both* (the host got `mcClassName`, the component got the source's literal `className`), which double-applied every padding and margin in the rule.
- **`nodeVisualRect` (`canvasDomGeometry.ts`) is what keeps a box-less node usable.** A `display: contents` element measures as all zeros, so selection rings, hover outlines, and drop candidates would all vanish. It falls back to the union of the element's children — one helper, shared by the overlay and the drop-candidate measurement, both of which previously just skipped a zero-size element.

---

## Inline SVG icons — `?raw` imports

`import icon from './x.svg?raw'` plus `dangerouslySetInnerHTML` is how real repos ship icons. `resolveRawTextImport` (`assetImports.ts`) resolves the specifier to the file's text, so one mechanism covers every path the value travels: read directly, aliased through a local `const`, or passed as a prop and substituted into a component.

### Installed-package specifiers

A bare specifier (`@alm-design/design-system/src/icons/line-icons/headset.svg?raw`) resolves by walking `node_modules` up from the importing file, **stopping at the workspace root** — Node's own algorithm, narrowed to one file. ~23 of the eSIM corpus's icons are imported exactly this way and resolved to nothing before it.

**Containment is checked on the real path, after following symlinks.** A workspace can arrive from `/import-github` and git stores symlinks, so a `node_modules` entry is untrusted input: a textual containment check would happily read `~/.ssh/id_rsa` through a link that merely *looks* like it sits under the workspace. An absolute specifier is never read at all.

The cost is that a **linked** `file:../pkg` dependency (or a pnpm store) does not resolve. Installing the package — a real directory — does.

### SVG through a transform the evaluator cannot run

The common real shape is not a bare identifier but `__html: applyTokens(svg)`, where `applyTokens` **loops** over a substitution table swapping hardcoded hex fills for design tokens. A loop in a callee's body is not executed, so the call is unresolved — and 9 illustration icons on the corpus's homepage rendered as blank 48px boxes with their markup one argument away.

`resolveRawSvgMarkup` falls back to the markup the transform was **handed**: one call level deep, first argument that resolves to an `<svg>` document.

What that gives up, stated plainly: the icon renders with the fills the source file holds rather than the ones the transform would have produced (real hex instead of `var(--color-aqua-*)`, so it does not follow a dark theme). It is the same trade `applySubstitutions` already makes for a computed `className`, keeping the static prefix for visual fidelity — and it beats a blank box, which tells the user nothing about their screen.

### An `<svg>` written as JSX elements is serialised

The other half of inline SVG is a graphic authored as real JSX, which is how every hand-rolled icon and progress ring is written:

```jsx
<svg className="ring__svg" viewBox="0 0 40 40">
  <circle className="ring__track" cx="20" cy="20" r={RADIUS} />
  <circle strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} … />
</svg>
```

`serializeInlineSvg` (`inlineSvg.ts`) walks that subtree into markup for `base.svg`. It resolves each attribute through §7 independently, writes real markup attribute names (`className` → `class`, `strokeWidth` → `stroke-width`, while `viewBox` and the other genuinely-camelCase SVG attributes stay), serialises a `style={{…}}` object into a declaration string, drops event handlers, and omits any single attribute it cannot resolve.

This replaced copying `element.getText()` verbatim and blanking the whole graphic whenever it contained a `{`. That heuristic was wrong in both directions: a "static" SVG shipped `className=` into markup where it is not a class attribute, and a single computed attribute erased the entire drawing — six empty progress rings on the eSIM corpus.

The alternative was keeping the interior as real nodes with `base.container` carrying `customTag: 'circle'`. That renders a geometry-free element: `base.container` has no generic attribute passthrough, so every `cx`/`r`/`stroke-*` would be dropped and the graphic would come out blank one layer further down.

**The interior is not editable.** An `<svg>` subtree collapses to one `base.svg` node; its children are drawing instructions, not page structure, and `base.svg`'s own editor is where markup is changed.

---

## Element → module resolution

`resolveModuleId` (`studioPageLoad.ts`) maps a parsed node to an Studio module:

| Source | moduleId |
|---|---|
| `kind: 'component'` | `alm.<Name>` |
| `div`, `section`, `main`, `header`, `footer`, `nav`, `article`, `aside` | `base.container` |
| `img` / `a` | `base.image` / `base.link` |
| an element carrying resolved SVG markup (`svg` prop), whatever its tag | `base.svg` |
| `svg` | `base.svg`, its subtree serialised into markup — see "An `<svg>` written as JSX elements" |
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

`resolveImageAssetImport` (`assetImports.ts`) resolves a local image import to a `studio-asset:<workspace-rel>` sentinel; `rewriteStudioAssetSentinels` turns that into the URL above once `dir` is in scope. That rewrite lives in the load pipeline rather than the pure converter because the query-param shape belongs with the endpoint that owns it.

**Resolution runs through the evaluator, not through a special case at the attribute.** It sits in the same "an import with no `SourceFile`" branch as `?raw` text, because that is exactly what an image import is — ts-morph tracks only JS/TS, so a `.png` specifier never resolves to a module. Matching a bare identifier at `<img src={…}>` used to be the only path, and it is close to the rarest shape in a real repo: the eSIM corpus reaches every one of its images as `deal.image` off a `const DEALS = [{ image: dealCard1 }, …]`, as `SLIDE_IMAGES[index]`, or as a prop handed to a child component. Going through the evaluator means every shape it already understands — member chains, array indexing, aliases, call-site substitution — works here for free.

Two deliberate narrowings versus `?raw`:

- **The file must exist.** A path nothing can serve is worse than no path: the canvas would render a broken image instead of an empty one.
- **Installed-package specifiers are not resolved.** The asset endpoint refuses to serve out of `node_modules`, so a path it would never honour is not worth emitting.

A resolved `src` **locks its node**, like every other resolved value: `src={esimChip}` binds to an import, and writing an `/admin/api/...` URL over that expression would delete the binding — the JSX itself is never a writeback target. `codeProps` still names `src` for exactly this reason.

`resolveStudioAssetResponse` rejects absolute and UNC paths, `..` traversal on either separator, anything under `EXCLUDED_WORKSPACE_DIR_NAMES`, and symlink escapes. Everything rejected is a 404.

### The import is editable, at its origin (WS-8.3)

Same shape of fix as resolved text above, aimed at a different literal. `<img src={heroImg}>` was locked for a correct reason — the JSX is not a writeback target — but the reason it stayed locked forever was that no codemod could reach the one place that IS honest: the import declaration naming the file.

`ParsedNode.assetOrigin` (`ValueOrigin`, same shape as `textOrigin`) records where an image import's own module-specifier string literal physically lives — `import heroImg from './hero.png'` → `assetOrigin` points at `'./hero.png'`, in the file HOLDING the import, not the asset file itself. Attached at `resolveImageAssetImport` (`assetImports.ts`), the one place that resolves an image import to its `studio-asset:` sentinel — mirroring `textOrigin`'s rule that `origin` is attached at the one place a literal is read, this one is attached at the one place an import's OWN specifier literal is identified, whether or not the target file exists (a missing file still has a real specifier to redirect).

How each piece knows:

| Layer | Mechanism |
|---|---|
| Evaluator | `resolveImageAssetImport` returns `{ path, origin }`; `origin` is the specifier's own `(rel, line, col)`, computed against the IMPORTING file — a different file than the one `originOf` addresses for an ordinary literal |
| Parser | `extractProps` captures the first resolved prop whose value is a `studio-asset:` sentinel as `ParsedNode.assetOrigin` (same "only the first" scoping as `textOrigin`, and for the same reason) |
| Sync | `parsedPageToSitePage` copies `assetOrigin` straight across onto `PageNode`, unconditionally — unlike `textOrigin`, an asset prop STAYS in `codeProps` (an ordinary `setJsxProp` write there is still wrong); `assetOrigin`'s presence is what tells a caller a DIFFERENT edit kind exists for it |
| Panel | `ImageSourceSection` (`PropertiesPanel/`) offers the picker whenever `assetOrigin` is set, or the prop is plain-writable (a literal `src="..."`); a node with neither falls through to the existing `CodeValueControl` |
| Client save | `saveStudioAssetEdit` (`fsCodemodAdapter.ts`) commits ONE `kind: 'asset'` edit immediately on pick — not queued into the ordinary optimistic prop diff, because the target is the import, not the node's own `src` |
| Server | `kind: 'asset'` `StudioEdit` (`studioWriteback.ts`) carries `assetPath` — the NEW file's workspace-relative path, validated by `resolveContainedAssetPath` (full symlink-aware containment guard) before `applyStudioEdit` computes the relative specifier and calls the codemod |
| Codemod | `setImportSpecifier` replaces the specifier literal at that exact position, preserving quote style — `setStringLiteral`'s narrower sibling, additionally requiring the literal be a real `ImportDeclaration`'s own module specifier |

**Uploading a new file.** `POST /admin/api/studio/asset-upload` (`server/handlers/studio/assetUpload.ts`) writes into the workspace — a caller-supplied `targetDir` (defaulting to `src/assets`), full path-containment guard (including real-path symlink resolution), a byte cap enforced by streamed count, and the actual file content SNIFFED against real image magic numbers before anything is written (the declared filename/MIME type is never trusted for either the accept/reject decision or the extension actually written).

**Shared imports reload the board.** `isSharedSourceNodeId` treats every `kind: 'asset'` edit as shared, unconditionally — unlike an inlined component or route chrome, there is no cheap way to tell from the id alone whether ANOTHER node in the same file reads the same import, so the client always reloads on a successful write. Same "fail toward the reload" policy `meta-05` established for route chrome.

**Literal `src` needed no new writeback.** `src="/img/hero.png"` was always just `setJsxProp` — WS-8.3 only added the picker UI in front of it (still routed through the ordinary optimistic prop diff, not `saveStudioAssetEdit`).

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

### Compiled styles — Tailwind, Sass, PostCSS, CSS Modules (WS-2.1/2.2)

`server/handlers/studio/styleCompile.ts` is what makes an imported app look like itself beyond plain CSS. The design decision: **run the workspace's own toolchain, never reimplement it.** `loadStudioPages` calls `compileProjectStyles(dir, profile)` before parsing any route, and its `CompiledStyles.css` is fed into the SAME `cssToStyleRules` engine as every plain-CSS import (`loadStudioStyles`'s `extraCss` parameter) — one new producer, not a second styling system.

Two trust postures, by toolchain:

- **CSS Modules is Tier 0 (`static`) safe.** `.module.css` selectors are rewritten to hashed global class names (`Card_card__a1b2`) by a small, self-contained transform this module owns — no workspace code ever runs, so it works unconditionally, even on a freshly-imported project. The resulting `{ localName: globalName }` map per file feeds `import styles from './Card.module.css'` in the evaluator (below).
- **Sass/Less/PostCSS/Tailwind (v3 and v4) are Tier 1.** Compiling them means running the workspace's own installed `sass`/`postcss` package and, for PostCSS, the workspace's own `postcss.config.*` — a config file is an arbitrary JS module. At Tier 0 (every fresh import's default — `meta-03` decision 1) this returns a `style-toolchain-requires-trust-promotion` warning instead of compiling; it never auto-promotes. **`sec-01`:** the compile itself runs in a SUBPROCESS (`server/handlers/studio/styleCompileWorker.ts`, spawned via `subprocessRunner.ts`'s `runCappedSubprocess` from `styleCompileTier1.ts`), never in the admin server's own process — `cwd` is the workspace directory, `env` is an explicit minimal set (no `STUDIO_SECRET_KEY`/`DATABASE_URL`/AI provider keys forwarded), the process is killed on a timeout, and stdout/stderr are capped. Compilers are resolved from `<dir>/node_modules/<pkg>` by an explicit, symlink-containment-checked path (`workspacePackageResolve.ts`), never the host admin server's own `node_modules`. This is still a blast-radius boundary, not a filesystem/network sandbox — Tier 1 is explicit, informed, revocable consent to run the workspace's own code. Compiled once per distinct input, cached under `.studio/cache/styles-<hash>.{css,json}`.

### CSS Modules through the evaluator (WS-2.2)

`import styles from './Card.module.css'` then `className={styles.card}` — the evaluator already resolved member chains off a resolved object, it just had no value for `styles`. `src/core/page-parser/assetImports.ts`'s `resolveCssModuleImport` teaches `resolveIdentifier` one more "an import with no `SourceFile`" case, sourced from `styleCompile.ts`'s `moduleClassMaps` (threaded through as `StaticEvalOptions.cssModuleClassMaps`). Everything downstream — `classIdsForClassName`, member chains, template literals — works for free. `cn()`/`clsx()`/`classNames()`/`classnames()` are a Tier C built-in (matched by identifier name, not import provenance): a pure string join with clsx's own tiny semantics — truthy strings/numbers kept, falsy scalars dropped, arrays flattened, object keys kept when truthy — implemented directly rather than calling the user's actual function, so it executes no user code and stays inside §7's envelope.

### Package CSS (WS-2.3)

`import '@acme/ui/dist/style.css'` — a bare-specifier stylesheet import — is a THIRD, separate input `styleCompile.ts` produces, alongside `css`/`moduleClassMaps`: `CompiledStyles.vendorCss`. Unlike Sass/PostCSS/Tailwind, this needs **no trust promotion** — resolving a bare specifier against `<dir>/node_modules/<pkg>/<subpath>` and reading the already-built `.css` file is a text scan plus a file read, never code execution, so `collectVendorCss` runs unconditionally at every trust tier (only `node_modules` existing is required; missing it degrades to a `vendor-css-requires-install` warning pointing at `POST /admin/api/studio/install`).

`vendorCss` never joins `css`/`moduleClassMaps` and is never parsed through `cssToStyleRules` — it rides `loadStudioPages`'s return value as its own field, reaches the client as `GET /admin/api/studio/load`'s `vendorCss`, and is injected into the canvas iframe by `ProjectCssInjector` as a read-only `@layer vendor` bucket, explicitly ordered below the editable `@layer user-authored` bucket so a user's own class edit always wins over a package default. See `docs/features/canvas-iframe-per-frame.md`'s "Vendor vs. user-authored ordering" for the cascade-layer mechanics, and `docs/agent-refs/canvas-internals.md`. `ProjectCssInjector` also carries `@alm-design/design-system`'s own bundled stylesheet (Studio's own dependency, not the open project's) — the same bucket now serves both sources.

### The frame gives percentage heights a definite basis

An imported screen is not a document that flows — it is an app shell: `html, body, #root { height: 100% }` under a `height: 100%` flex column, with the scrolling done by a `flex: 1` region inside. A percentage height only resolves against a parent whose height is **definite**; against `auto` it degrades to `auto`. So a design-canvas body left at `height: auto` (grow-to-content) collapses the whole chain and computes the scroll region to 0.

`useIframeFrameAutoHeight` therefore pins `body.style.height` to the frame height it already measures, floored at `CANVAS_VIEWPORT_HEIGHT`. It unpins to `auto` before each measurement, because a pinned height floors `body.scrollHeight` and a page that got shorter could otherwise never shrink back — the same staleness `resolveCanvasFrameHeight` guards against for `documentElement`.

This is the same move `resolveViewportUnits` makes for `vh`: give authored CSS a definite, device-like viewport to resolve against instead of a value derived from the content it is supposed to size. Grow-to-content still works, because the pin tracks measured content — a 3000px document page pins to 3000.

### Numeric style values get their unit

`style={{ width: size, height: size }}` parses to real numbers. `width: 44` is not valid CSS — the browser drops the declaration, in the canvas and in published HTML alike — so a bare number has to become `44px`. `sanitiseCssValue` sees only the value and can only stringify it, so `cssValueForProperty(prop, value)` (in `@core/css-sanitize`) owns the unit rule and every style-bag emitter goes through it. The rule is React's `isUnitlessNumber` list, so the canvas, the publisher, and anyone who has written JSX all agree. Before this, every inline SVG icon rendered at its own intrinsic size: a 24px check painted 300px wide across its badge.

---

## What still does not import

Honest list, all deliberate. WS-9.4 (`server/ai/mcp/tools/studio/fidelityCodes.ts`)
turns every one of these that a loaded page tree can actually detect into a
stable, machine-readable finding code `studio_fidelity_report` emits. Six more
codes are reused verbatim from the project probe's own `ProbeWarning.code`
(`server/handlers/studio/projectProfileSchema.ts`) — `studio_project_profile`
and `studio_fidelity_report` return the SAME code for the same issue. A `—` in
the Code column means the limitation below is real but not yet turned into an
automatic finding (either it's a codemod/tooling constraint with no per-node
signal, or the underlying compile step doesn't surface a warning through the
page-load pipeline yet) — `fidelityCodes.test.ts` gates that every code in
this table exists in the registry and vice versa, so a code can only appear
here once it is genuinely detectable.

| Code | Limitation |
|---|---|
| `SVG_BUILT_DYNAMICALLY` | A transform's own effect (`applyTokens(svg)` loops) or dynamically-constructed inline SVG markup. |
| `DYNAMIC_CONTENT_UNRESOLVED` | `.map` over data the parser cannot read; a computed `className` interpolation that isn't statically resolvable; an image behind hook state. |
| `BRANCH_AUTO_SELECTED` | **info, not a defect** (`mcp-02`, replacing the retired `MULTI_BRANCH_ALL_RENDERED` — see [One `return` renders](#one-return-renders--the-parser-selects-a-branch-parser-06)) — the parser found more than one `return`/ternary/`&&` branch and SELECTED one (the node is NOT locked); the untaken alternative(s), each a label + source location, are read straight off `PageNode.branchAlternatives`. Verify the auto-selected branch is the one that matters for the audit — a real run (`studio_render_reference`) is the only way to confirm which branch a user actually sees. |
| `SPREAD_PROPS_UNRESOLVED` | An element spreads an arbitrary prop bag (`{...rest}`). |
| `CODE_VALUED_PROP` | A prop §7 resolved is read-only (that one prop, not its literal siblings or the node); nothing on a `.map` row is editable except its own copy. |
| `dependencies-not-installed` | Package CSS/components/`?raw` icons resolve to nothing until `studio_install_deps` runs. |
| `pages-dir-heuristic` / `pages-dir-not-found` | The pages directory was guessed or not found. |
| `tailwind-config-not-found` / `vite-entry-not-found` / `next-config-no-routes-found` | Project-level config gaps the probe found. |
| `—` | CSS Modules only compiles `.module.css` (Sass/Less module variants detected, not compiled). |
| `—` | Sass/Less/PostCSS/Tailwind compilation needs the project promoted past Tier 0 (`style-toolchain-requires-trust-promotion`, not yet surfaced through the page-load pipeline). |
| `—` | CSS-in-JS (`styled-components`/`emotion`/`stitches`) is detected, never compiled. |
| `—` | Linked package dependencies (a `?raw` import from a symlinked `file:../pkg`) do not resolve. |
| `—` | A JSX-valued prop that is not an icon is dropped rather than flattened. |
| `—` | Only the `previewLocale` branch renders; the other locale/RTL is not applied. |
| `—` | One attribute of an inline `<svg>` that depends on a prop/state is omitted (the graphic still serialises). |
| `—` | `{children}` splicing depth (does not occur in practice). |
| `—` | Renaming a component reference — `studio_codemod`'s `rename-tag` renames HTML elements only. |

- **A transform's own effect.** `applyTokens(svg)` loops, so the call does not resolve; the icon renders with the source's raw fills instead of the token-substituted ones ([why](#svg-through-a-transform-the-evaluator-cannot-run)). A transform written without a loop resolves normally.
- **`.map` over data the parser cannot read.** A resolved array is expanded ([above](#bounded-loop-expansion--not-tier-d)); an array reached through props/state/fetch stays one locked, opaque node.
- **Multi-stage screens show ONE stage** (parser-06) — the last JSX-bearing `return`, unlocked. The other stages are not rendered; each is recorded as a `label` + source `loc` on the chosen node's `branchAlternatives`, never materialized into nodes. Still not Tier D: nothing is evaluated, only a source POSITION is preferred. What is genuinely still not possible: showing more than one stage on the board at once (that would need editor-side branch-switching UI, not built here — see `STATE.md`'s `parser-06` handoff), and a stage the heuristic picks wrong (the last `return` is overwhelmingly the "normal" one, but a component that orders its returns unusually can still surprise).
- **Computed `className` whose interpolation isn't statically resolvable.** `` className={`esb esb--${tone}`} `` keeps only its static prefix when `tone` cannot be resolved. As of WS-2.2 this is much narrower than it used to be — a CSS Modules value (`styles.card`), a resolved const, or a `cn()`/`clsx()` call now resolves through the evaluator — but a genuinely runtime-only interpolation (component state, an unresolvable prop) still keeps only the prefix. The plan's WS-2.4 variant probe (pick the default variant from an enumerable prop union, record a `resolution.note`) is not implemented.
- **CSS Modules only compiles `.module.css`.** `.module.scss`/`.module.sass`/`.module.less` are detected (`css-module-sass-not-supported` warning) but not compiled — that needs Sass/Less compilation (Tier 1) BEFORE the class-name renamer could run, and this slice doesn't wire that chain.
- **Sass/Less/PostCSS/Tailwind compilation needs the project promoted past Tier 0.** A freshly-imported project defaults to Tier 0 (`static`, `meta-03` decision 1) and never auto-promotes; `styleCompile.ts` returns a `style-toolchain-requires-trust-promotion` warning and compiles nothing until the user explicitly promotes the project's trust tier.
- **CSS-in-JS is detected, never compiled.** `ProjectProfile.styleToolchain.cssInJs` names `styled-components`/`emotion`/`stitches` when present; `styleCompile.ts` does nothing with it. A component styled this way renders structurally correct and unstyled.
- **Linked package dependencies.** A `?raw` import from a symlinked `file:../pkg` (or a pnpm store) does not resolve — containment is checked on the real path ([why](#installed-package-specifiers)). Install the package instead.
- **A JSX-valued prop that is not an icon.** `iconPropFromJsx` recovers inline SVG markup one level deep; a prop holding a nested layout is dropped rather than flattened.
- **Only the `previewLocale` branch.** The other locale exists in the dictionary but is not rendered; RTL is not applied.
- **One attribute of an inline `<svg>` that depends on a prop or state.** The graphic serialises; the unresolvable attribute is omitted ([above](#an-svg-written-as-jsx-elements-is-serialised)). A ring drawn from `strokeDashoffset={f(props.percent)}` shows its track without its progress arc.
- **An image behind hook state.** `SLIDE_IMAGES[index]` where `index` is `useState(0)` does not resolve. Not a Tier D ban (parser-07 established that reading a `useState(<literal>)`'s own initial value is a Tier A source read, not execution) — a deliberate SCOPING decision: that read is wired only into `evaluateCondition` (JSX branch selection), never into `resolveIdentifier`/`buildComponentLocals`, the chain element/property access shares with Tier B.4's dynamic-dictionary-key pick. Wiring it in generally would silently override the `previewLocale` option for the common `useState('en')` language-switcher shape — see [One `return` renders](#one-return-renders--the-parser-selects-a-branch-parser-06)'s `&&` section. The two carousel slides on the eSIM corpus are the only instances of the array-index case.
- **A ternary/`&&` branch the heuristic guesses wrong.** `selectJsxBranch` (parser-06) prefers the CONSEQUENT unless the condition is statically decidable, so `{addOn.image ? <img …/> : <Icon …/>}` renders `<img>` even for the items that actually carry an `icon` at runtime — the untaken `<Icon …/>` is recorded as a `branchAlternatives` entry (label + location), not rendered. Was previously "every branch renders", which showed BOTH; this is now a single, sometimes-wrong guess instead of an always-honest stack. Extract the condition to a module-scope const to get the real answer instead of the guess.
- **`{children}` splicing depth.** Spliced content that is itself an intermediate inlined id from a deeper nesting level would produce a dangling reference. Does not occur in practice; documented in `inlineLocalComponents.ts` rather than solved with general bookkeeping.
- **A prop §7 resolved is read-only** — that one prop, not its literal siblings and not the node ([above](#structure-is-locked-values-are-decided-per-prop)). Editing a resolved value would replace the expression that produces it.
- **Nothing on a `.map` row is editable except its own copy.** One piece of source JSX renders every row, so a prop or style write there would change all of them. Its text escapes this because each iteration resolved a different array element and `textOrigin` names the literal.
- **Renaming a component reference.** `setJsxTagName` renames HTML elements only; `<Sheet>` → `<Dialog>` would need the new name imported and in scope.
- **The node-id grammar lives in one place now** (`@core/page-tree`'s `sourceNodeId`), consumed by the parser and the client save adapter. `server/handlers/studioWriteback.ts` still has its own `NODE_LOC_ID` regex, because it pairs the decode with a write-permission check on the path; the two agree but nothing enforces that they keep agreeing.

---

## Testing

| Area | Test |
|---|---|
| Value evaluator, all tiers + guards | `src/core/page-parser/__tests__/staticEval.test.ts` |
| Local-component inlining | `src/core/page-parser/__tests__/inlineLocalComponents.test.ts` |
| `.map` expansion | `src/core/page-parser/__tests__/staticLoopExpansion.test.ts` |
| Branch SELECTION (multi-return, ternary, `&&`), `return null` guards don't count, a statically-resolvable condition outranks the heuristic | `src/core/page-parser/__tests__/multipleReturns.test.ts` |
| Structured + JSX-valued props | `src/core/page-parser/__tests__/structuredProps.test.ts` |
| `?raw` imports, `node_modules`, symlink containment, transform fallback | `src/core/page-parser/__tests__/rawSvgImports.test.ts` |
| Image imports through data structures, inline-`<svg>` serialisation, Tier A operators | `src/core/page-parser/__tests__/imageAssetsAndInlineSvg.test.ts` |
| A repo unlike the validation corpus (barrels, named exports, typed data, CSS modules, hooks) | `src/core/page-parser/__tests__/genericRepoShapes.test.ts` |
| Panel never offers an editable input for a structured value, or for a code-valued prop | `src/__tests__/property-controls/PropertyControlRenderer.test.tsx` |
| `codeProps` derived from real source: conditional branches stay editable, resolved props don't, `.map` rows have nothing | `src/core/studio-sync/__tests__/codeProps.test.ts` |
| Store gate, panel gate, and the writability predicate agreeing | `src/__tests__/studio/resolvedTextEditing.test.ts` |
| Store refuses a code-valued prop/style, admits a structurally-locked literal one | `src/__tests__/editor-store/lockedNodeGuards.test.ts` |
| Element rename, and its refusals (component reference, non-tag name) | `src/core/ast-codemods/__tests__/setJsxTagName.test.ts` |
| Stylesheet collection, ordering, escape rejection | `src/core/studio-sync/__tests__/collectPageStylesheets.test.ts` |
| CSS round-trip, id stability, classIds | `server/handlers/__tests__/studioCss.test.ts` |
| Asset route guards | `server/handlers/__tests__/studioAsset.test.ts` |
| Load/save endpoint contract | `server/handlers/__tests__/studio.test.ts` |
| Save write-loop safety | `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` |
| Literal writeback + writable-path guard | `server/handlers/__tests__/studioWriteback.test.ts` |
| `setStringLiteral` fail-closed behaviour | `src/core/ast-codemods/__tests__/setStringLiteral.test.ts` |
| Resolved text is editable at its origin, and nothing else is | `src/__tests__/studio/resolvedTextEditing.test.ts` |
