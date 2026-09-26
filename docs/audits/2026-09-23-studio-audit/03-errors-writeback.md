# Audit 03: parse and writeback errors, refusals, and auto-resolution
> **Trust:** historical, dated 2026-09-23. Paths and line numbers were true at `560ddb0e`; re-read the code before acting on a finding. The plan built from it is `ROADMAP.md`.

Auditor: parser-surgeon (read-only). Date: 2026-09-23. Branch: `fix/studio-load-memo-cold-on-every-load`.
Area: `src/core/page-parser`, `src/core/ast-codemods`, `src/core/css-codemods`, `src/core/studio-sync`,
`server/handlers/studioWriteback*.ts` and siblings, `server/handlers/studio/**`.

**Method.** I read the docs (brief, pipeline, all of `studio-import.md`, FEEL plan §0/§1/§7/§9) and the code.
Then I ran nine throwaway probe scripts (`probe-*.ts`, in this folder). Each one calls the real
`loadStudioPages` and `applyStudioEditBatch` on temp workspaces inside the scratchpad. Nothing in the repo
or in `studio-workspace/` was touched. A finding is **CONFIRMED** when a probe reproduced it or the code
path is unambiguous. It is **SUSPECTED** when it rests on reasoning I did not run.

---

## 0. Headline

Six findings account for most of what a user would see as "Studio broke my file" or "Studio can't see my
page". Three of them are silent data-loss bugs. The other three hide text or components on a large share of
ordinary React code.

| # | What | Why it matters |
|---|---|---|
| WB-1 | A stale `line:col` writes to, or **deletes**, the WRONG element when the file changed on disk after the board loaded. Nothing watches the files. | Silent corruption of user source |
| WB-2 | `pageParseCache` does not track files the evaluator reads (dictionaries, consts, providers). Studio's own resolved-text edit is **reverted on every later reload.** | Silent revert of edits that succeeded |
| WB-3 | Text inside `<div>/<section>/<li>/<label>/<td>/…` is **dropped**. `base.container` has no text prop. | Copy missing from the canvas |
| WB-4 | `memo()`, `forwardRef()`, `React.memo(X)`, `export { default as X }` barrels and `import * as UI` all become **"Unknown module"** boxes | Whole components vanish |
| WB-6 | Text a component receives through a prop (`<Header title="Where to?"/>` → `<h2>{title}</h2>`) is read-only. The honest target, the call-site literal, is right there. | Most copy in a component-based app is locked |
| WB-7 | `dedupeStudioEdits` keeps only the last `style`/`class` edit per target. Distinct edits on two instances of a shared component are **silently dropped** and reported as written. | Silent loss |

---

## 1. Findings

Severity: P0 = a common pattern breaks or data is lost. P1 = a frequent visible failure. P2 = an edge case or polish.
Effort: S ≤ ½ day, M ≤ 2 days, L ≤ 1 week.

### WB-1 — A stale `line:col` writes to the wrong element, and nothing notices an external change — P0 · CONFIRMED
- **Where:** `src/core/ast-codemods/locateJsxElement.ts:71-104` (`findJsxElementAtLocation` matches on position only). `server/handlers/studioWriteback.ts:183-199` (value kinds). `jsxChildRange.ts:51` (`stale-source` only compares disk text with ts-morph's parse *within one codemod run*, not with what the board loaded). There is no `fs.watch` anywhere under `server/handlers/studio` or `src/admin/pages/site/studio`.
- **Trigger (probe `probe-stale-write.ts`):** the board parses `<li title="b">Two</li>` at `pages/Home.tsx:5:8`. An outside writer (the Claude CLI agent's own Edit tool, VS Code, `git pull`, a second tab) inserts one line above it. Result:
  - A `prop` edit plus a `text` edit on id `:5:8` both land on the **previous sibling** (`<li title="EDITED-b">{"Two (edited)"}</li>` replaces "One").
  - A `delete` on `:4:8` removes **"Zero"** instead of "One".
  - Both report `written:1, refusals:[]`.
  - `setStringLiteral` (resolved-text writes to a dictionary) and `setImportSpecifier` share the same flaw.
- **Also in-session (SUSPECTED):** the canvas holds unsaved value edits keyed by old ids. An MCP write or live-reload push shifts lines. The next autosave sends the old ids.
- **Auto-resolution:**
  1. Record a per-file fingerprint at load: content hash, plus the opening-tag text for every node id the board holds (cheap, and already available at parse time). Send the file hash with every save batch.
  2. On the server, if the hash differs, **re-locate** each edit. Diff the loaded text against the current text, translate `line:col`, and confirm the opening-tag fingerprint still matches. If exactly one match exists, write there. If not, refuse `source-moved` with no red toast and auto-trigger the targeted reload.
  3. Add a debounced workspace watcher (`fs.watch` recursive, ignoring `.studio/` and `node_modules`) that pushes the same live-reload the MCP bridge already uses (`liveReloadPush.ts`). The board then stays true to disk when the user or the agent edits outside Studio.
  4. Minimum safe step (S): carry the expected opening-tag text (or tag name plus attribute-name set) on every value edit, and refuse on mismatch. That alone turns wrong-element writes into honest refusals.
- **Effort:** S (guard), M (re-locate), M (watcher). **Owner:** parser-surgeon + server-engineer (+ store-engineer for the fingerprint). **Plan coverage:** none. FEEL §7 #12 covered git/save interleaving only (G7 lock). The lock does not cover edits made outside Studio.

### WB-2 — The parse cache misses evaluator dependencies, so dictionary edits revert on reload — P0 · CONFIRMED
- **Where:** `server/handlers/studioPageLoad.ts:215-217` records `[file, ...dependencyFiles]`. `dependencyFiles` is filled only by `inlineLocalComponents.ts:225,331` (component files). Files the evaluator reads are never recorded: a cross-file `const`, i18n dictionaries, context-provider files (Tier B), and `?raw` SVG imports.
- **Trigger (probe `probe-dict-cache.ts`):** `<h1>{COPY.title}</h1>`, with `COPY` in `src/copy.ts`. A `literal` edit, which is exactly what the canvas sends for resolved text (`textOrigin`), writes `'Hello edited'` to disk. A subsequent `loadStudioPages` still returns **"Hello original"**. The outer `studioLoadMemo` misses correctly, because its fingerprint covers every file. The inner `pageParseCache` then hits, because none of its recorded mtimes moved. This is the same two-layer bug `studioPageLoadDeepComponentCache.test.ts` fixed for nested components, one layer over.
- **User impact:** the user types new copy, which saves. Then any reload (a structural edit that widens, reopening the project, a locale switch) shows the old copy, until the server restarts or the page's own file changes. Other nodes sharing the same dictionary key also stay stale in memory after the edit, because `literal` is not `isSharedSourceNodeId`, so no resync runs. Edits the agent or VS Code make to `translations.js` never appear at all.
- **Auto-resolution:** have the evaluator report every `SourceFile` it reads. Add an out-param on `StaticEvalOptions` alongside `pageBudget`, fill it in `staticEvalCore`'s binding and import resolution, `staticEvalCalls`' provider trace and `assetImports`, and merge it into `setCachedRouteParse`'s dependency set. `reloadScope` then narrows correctly for free. Mark a `literal` edit as shared, or resync the pages that depend on the origin file, so sibling nodes update right away.
- **Effort:** S–M. **Owner:** parser-surgeon. **Plan coverage:** none. The `pageParseCache.ts` header even claims the set is complete.

### WB-3 — Text inside container tags is dropped — P0 · CONFIRMED
- **Where:** `server/handlers/studio/moduleMapping.ts:22-24,125-137`, and `resolveTextProp` (`:150-161`) returns `null` for `base.container`. `src/core/studio-sync/parsedPageToSitePage.ts:169-178` maps text only when a text prop exists.
- **Trigger (probe `probe-patterns2.ts`):** all of these reach the canvas as `base.container` with `props: {}`, and the text is gone: `<div>Plain div text</div>`, multi-line `<div>` text, `<li>`, `<label>`, `<td>`, and `<Box>styled text</Box>` (styled.div). The same applies to any tag not in `TEXT_HTML_TAG_SET`, such as `dt`/`dd`/`th`/`figcaption`/`blockquote`/`code`/`pre`/`b`/`i`/`time`/`option`. `div` is even listed in `TEXT_HTML_TAG_SET`, but `CONTAINER_TAGS` is checked first. It also affects `<section {...rest}>Spread</section>`.
- **Auto-resolution:** give `base.container` a text representation. Either add an optional `text` prop plus `inlineTextEdit` on the container module when it has no element children, or route text-only leaves to a text module that accepts `customTag`. `setJsxText` already writes this shape honestly (single `JsxText` child). No test covers `<li>text</li>` or `<div>text</div>`.
- **Effort:** M. **Owner:** parser-surgeon + canvas-engineer (module). **Plan coverage:** none.

### WB-4 — Wrapped and re-exported components become "Unknown module" — P0 · CONFIRMED
- **Where:** `moduleMapping.ts:109` (`alm.${node.name}` fallback). `inlineLocalComponents` and `resolveComponentCallSite.ts` have no case for `memo`/`forwardRef` call-expression declarations (grep finds zero mentions of either in `src/core/page-parser`).
- **Trigger (probe `probe-patterns2.ts`):**

  | Pattern | Became |
  |---|---|
  | `export const MemoCard = memo(function MemoCard…)` | `alm.MemoCard` |
  | `forwardRef<…>(({ph}, ref) => …)` | `alm.FwdInput` |
  | `export default React.memo(Inner)` | `alm.RMemo` |
  | `export { default as Arrow } from './Arrow'` barrel | `alm.Arrow` (a direct default import of the same file inlines fine) |
  | `import * as UI from '../components'; <UI.Arrow/>` | `alm.UI.Arrow` |

- **Auto-resolution:** in the declaration walk, unwrap `memo(X)`, `React.memo(X)`, `forwardRef(fn)` and `React.forwardRef(fn)` to their inner function or identifier. This reads the argument's AST; it executes nothing. Follow `export { default as X }` through `getExportedDeclarations().get('default')` of the target module. Resolve a namespace member (`UI.Arrow`) through the namespace import's module exports. forwardRef's second parameter (`ref`) is simply unbound.
- **Effort:** S–M. **Owner:** parser-surgeon. **Plan coverage:** none (IMPORT-V2 :410 mentions `ForwardRefExoticComponent` for **package** `.d.ts` typing only).

### WB-5 — A page that exports a HOC-wrapped or class component renders an empty frame, with no reason given — P1 · CONFIRMED
- **Trigger (probe `probe-broken.ts`):** `export default withLayout(Inner)` gives one node, just the body. So does `export default class Page extends React.Component { render(){…} }`. The same will apply to `export default observer(Page)`, `connect(...)(Page)` and `memo(Page)` (see WB-4). No diagnostic reaches `/load`. The load result carries no per-page warning field (`keys: pages, componentSources, styleRules, …`).
- **Auto-resolution:** for `export default <call>(<Identifier>, …)`, parse the identifier's component and record `resolution.note = "wrapped by withLayout() — its effect is not shown"`. This is not Tier D: it reads which function is passed and never runs the wrapper. For a class, read the JSX that `render()` returns (a pure AST read). Otherwise, show an in-frame empty state naming the shape ("This page's default export is a class / wrapped call — open in code"), never a blank frame.
- **Effort:** M. **Owner:** parser-surgeon + canvas-engineer (empty state). **Plan coverage:** none.

### WB-6 — Prop-forwarded text and labels are read-only when the call-site literal is an honest target — P0 · CONFIRMED
- **Where:** `componentSubstitution.ts` never attaches an origin (grep finds zero "origin" hits). The result is `codeProps:["text"]` with no `textOrigin`.
- **Trigger (probes `probe-patterns.ts`, `probe-patterns3.ts`):**
  - `<Header title="Where to?"/>` → `<h2>{title}</h2>` gives `text:"Where to?", codeProps:[text]`.
  - `<Btn label="Save"/>` gives `code:label`.
  - A same-file `<Row name="one"/>` gives `code:text`.
  - A double-click shows the info toast "This text is set in code". A panel edit ends in the red `unexplainedSkips` toast, which says "Text that comes from a prop or a variable cannot be edited on the canvas yet".
- **Auto-resolution:** when a substituted parameter is used verbatim as sole text (or a scalar prop), set `textOrigin` / `resolvedProps[k].origin` to the **call site's attribute string literal**. When the call site passes `{c.key}`, chain on to that literal's own origin. `setStringLiteral` already rewrites an attribute string literal. For an inlined instance this is exactly **one, per-instance** target, strictly better than the component file. `studio-import.md` "A save only reloads when a write actually landed" already names this as the honest fix. The `.map`-row origin precedent shows the save path needs no change.
- **Effort:** M. **Owner:** parser-surgeon. **Plan coverage:** documented as a gap in `studio-import.md` (line ~409 of the doc), not scheduled.

### WB-7 — Dedupe silently drops distinct `style`/`class` edits on a shared target — P1 · CONFIRMED
- **Where:** `server/handlers/studioEditRouting.ts:313-314`. The key is `rel:line:col|kind|prop`, and `style`/`class` edits have no `prop`, so the last one wins.
- **Trigger (probe `probe-dedupe.ts`):** two instances of `<Card/>`. Instance A gets `style {padding}` and class `+a`; instance B gets `style {margin}` and class `+b`. The file receives only `margin` and `b`. The response is `written:2, skipped:0`. The client then commits its baselines (`unexplainedSkips === 0`), so padding and `a` are **lost for good**: they stay on the canvas until the next reload, then disappear.
- **Auto-resolution:** merge instead of replace. Union the `style` patches (and `remove` lists) per target, and union `class` add/remove sets. Only true conflicts (the same key with different values) should be last-wins.
- **Effort:** S. **Owner:** parser-surgeon / server-engineer. **Plan coverage:** none.

### WB-8 — A resolved prop with a per-prop `origin` is still read-only — P1 · CONFIRMED (code)
- **Where:** `src/core/page-parser/types.ts:274` (`resolvedProps[k].origin` exists since R2). `src/core/page-tree/editConstraint.ts` `explainPropConstraint` returns `actions: []` for `resolved-expression`, and only a jump-to-source action elsewhere. The panel shows `CodeValueControl`.
- **Trigger:** `title={c.sheetTitle}`, `alt={copy.heroAlt}`, `placeholder={t.search}`. Each is a dictionary string with a known literal, exactly like text, and none is editable.
- **Auto-resolution:** extend the text rule to any scalar prop whose `resolvedProps[k].origin` names a string literal. Write through `kind:'literal'` at the origin, and show the existing shared-copy count ("used in N places"). Invariant 5 holds, because the binding is untouched.
- **Effort:** S–M. **Owner:** parser-surgeon + panel-designer. **Plan coverage:** none.

### WB-9 — `setJsxText` damages formatting and shifts ids — P1 · CONFIRMED
- **Where:** `src/core/ast-codemods/setJsxText.ts:73-107`.
- **Trigger (probe `probe-crlf.ts`):** a multi-line `<p>\n  Multi line\n  copy here\n</p>` becomes `<p>{"Multi line copy here!"}</p>`. Every text edit is rewritten as an expression container. A multi-line element collapses, which makes `shifted:true` and forces a resync. Every node id below the element changes, and a selected or multi-selected node below it loses its id (SUSPECTED; see WB-39). Git diffs show code nobody would write by hand.
- **Auto-resolution:** write raw `JsxText` when the text has no `{}<>` characters, and keep the original child's leading and trailing whitespace and newline layout (replace only the trimmed span). Fall back to `{"…"}` only when escaping is genuinely needed, or when the original already used that form.
- **Effort:** S. **Owner:** parser-surgeon. **Plan coverage:** none.

### WB-10 — `setJsxStyle` damages formatting — P1 · CONFIRMED
- **Trigger (probes `probe-crlf.ts`, `probe-dedupe.ts`):** `style={{ color: 'red' }}` plus `{color:'blue', marginTop:'4px'}` becomes `{{ color: "blue",\n          marginTop: "4px"\n    }}`. The file's quote style is lost, the indentation is odd, and the line count changes.
- **Auto-resolution:** splice the value text only. Detect the file's quote preference from the existing property, and add new properties on the same line when the object literal is single-line.
- **Effort:** S. **Owner:** parser-surgeon.

### WB-11 — The server has no writability guard, and the MCP tool description is wrong — P1 · CONFIRMED (code)
- **Where:**
  - `src/core/ast-codemods/setJsxProp.ts`: `existingAttribute.setInitializer(...)` runs unconditionally over `{expr}`. The only guard is the client's `codeProps`.
  - `server/ai/mcp/tools/studio/editTools.ts:94` says `shifted` is "never for the seven single-line value kinds". WB-9 and WB-10 prove text and style do shift.
- **Impact:** the agent (`studio_apply_edits`) can bake a literal over `title={c.x}`, deleting the binding (Invariant 5). The agent also trusts ids after value edits, and that trust feeds WB-1.
- **Auto-resolution:** in `setJsxProp`, refuse `binding-overwrite` when the existing initializer is not a string, number or boolean literal. If a `resolvedProps` origin exists, route the edit to the origin instead (WB-8). Fix the description text in the same change.
- **Effort:** S. **Owner:** parser-surgeon + mcp-tooling.

### WB-12 — Value-kind codemod failures become a generic red toast with the wrong explanation — P1 · CONFIRMED
- **Where:** `studioWriteback.ts:521-528`. `isRefusingEditKind` (`studioEditSchemas.ts:393`) excludes `prop`, `text`, `literal`, `tag` and `asset`, so `JsxTextTargetError`, `No JSX element found…`, `JsxTagNameTargetError`, `StringLiteralTargetError`, `ImportSpecifierTargetError`, the setJsxProp spread error, and `resolveClassNameTokens`/`resolveContainedRefPath` returning null all become `unexplainedSkips`. The client (`unexplainedSkipsNotice.ts:115`) shows an **error** toast, "Some changes were not saved to source", and always adds "Text that comes from a prop or a variable…", which is wrong for most of these causes.
- **Auto-resolution:** make every value kind a refusing kind with a typed reason: `mixed-children`, `element-moved` (a WB-1 re-locate miss, which should auto-reload rather than toast), `component-tag`, `not-a-literal`. Then give each the remedy it actually has.
- **Effort:** S. **Owner:** parser-surgeon + store-engineer.

### WB-13 — Every save-time refusal is a red `error` toast — P1 · CONFIRMED
- **Where:** `src/admin/pages/site/studio/refusalToasts.ts:91,107,130,192,241`. The titles are "Style not saved to source", "Class not attached in source" and "Override not saved to source", and the body says "will be lost on reload".
- **Fix:** route each through `RefusalDialog`/an inline notice with its auto-resolution (WB-16…WB-20, WB-30, WB-31). Where a refusal genuinely remains, use `warning` severity with a one-click remedy. This conflicts directly with the owner's zero-visible-errors bar.
- **Effort:** S (severity) + per-row work below. **Owner:** store-engineer + panel-designer.

### WB-14 — `shared-component` structural refusal (48.5% of nodes on the corpus) — P1 · CONFIRMED (doc and code)
- **Where:** `src/core/page-tree/sourceStructure.ts:354-359`. The remedies (`structuralConstraint.ts:67-80`) are "Open the component definition", "Detach", and "Duplicate as new file". None of them performs the gesture the user asked for.
- **Auto-resolution:** a two-choice dialog.
  - **"Change every instance (N)"** runs the move/delete/duplicate/wrap at the component's own tail location. That target is valid, and the codemods already work there. This matches what value edits already do (write and warn).
  - **"Only this one"** runs `detach` and then **replays** the original gesture against the node id `createdNodeIds` reports, when detach is possible. Otherwise it runs `extractComponentCopy` and replays.
  - "Change every instance" must refuse `out-of-scope` when the moved markup reads component-scope names. `subtreeFreeVariables` already answers that.
- **Effort:** M. **Owner:** store-engineer + parser-surgeon. **Plan coverage:** `studio-import.md` "Measured on the real corpus" names this as the follow-up (382 nodes). It is not in any active plan.

### WB-15 — `list-row` (14.9% of nodes): nothing on a `.map` row is structurally or stylistically editable — P1 · CONFIRMED (doc and code)
- **Auto-resolution:** the array literal behind a resolved `.map` is a real, single target.
  - **Reorder, delete or duplicate a row:** move, delete or duplicate the corresponding element of the array literal. This needs `ParsedNode` to carry the source location of each iterated item, which the evaluator already reads when it expands the loop (`staticLoopExpansion.ts`).
  - **Style, prop or class on a row:** write to the loop template's element (the id without `#n`) behind a "applies to all N rows" confirmation, the same blast-radius pattern shared components use.
  - Refuse only when the array is computed rather than a literal.
- **Effort:** M–L. **Owner:** parser-surgeon + store-engineer. **Plan coverage:** none (the current remedy is "Open the array in code").

### WB-16 — CSS cascade refusals refuse when the winning declaration is itself an honest target — P1 · CONFIRMED (code)
- **Where:** `src/core/css-codemods/analyzeDeclarationTarget.ts:171-245`.
- **Auto-resolution by reason:**
  - `duplicate-selector`: write to the **last** block that sets the property. That is the one on screen.
  - `duplicate-declaration`: write to the last declaration in the rule.
  - `shorthand-override`: insert the longhand *after* the covering shorthand in the same rule, or rewrite the shorthand's component.
  - `important-override`: keep as a dialog ("Edit `padding` (has !important)" / "Add !important").
  - The unparseable-stylesheet case reuses `duplicate-selector` with a parse-error message. Give it its own `css-syntax` reason with jump-to-line.
- **Effort:** M. **Owner:** parser-surgeon.

### WB-17 — `style-target` refuses on a spread or identifier `style` — P1 · CONFIRMED (code)
- **Where:** `src/core/ast-codemods/setJsxStyle.ts:96-157`.
- **Auto-resolution:**
  - Spread inside the object literal (`{...base, color}`): add or update keys **after** the last spread. JS semantics mean a later key wins, so canvas and code agree.
  - Identifier or call initializer (`style={s}`): rewrite to `style={{ ...s, k: v }}`, which keeps the binding.
  - Removing a key that lives only inside the spread still refuses.
- **Effort:** S. **Owner:** parser-surgeon.

### WB-18 — `className` refusals where an add has an honest target — P1 · CONFIRMED (code and probe)
- **Where:** `setJsxClassName.ts:214,316,441-549`.
- **Auto-resolution by reason:**
  - `unsupported-expression`, `unsupported-call` or `template-dynamic` on **add**: wrap as `` className={`${expr} token`} ``, or append the argument when `cn`/`clsx` is in scope. The binding is preserved and there is one target. Probe: a ternary `className={open?'on':'off'}` refuses today.
  - `css-module-import-missing`: add the `import styles from './X.module.css'` in a **post-batch pass**, the same shape as `pruneOrphanedImports`. That pass is the documented reason for refusing, and it already solves the line-shift hazard.
- Removes that target an interpolated token keep refusing.
- **Effort:** S–M. **Owner:** parser-surgeon.

### WB-19 — `binding-conflict` (insert/wrap/group/slot/transplant) — P2 · CONFIRMED (code)
- **Auto-resolution:** import under a free alias (`import { Button as Button2 }`) and write the alias in the markup. This is honest and single-target, and removes a whole refusal family.
- **Effort:** S. **Owner:** parser-surgeon.

### WB-20 — `expression-child` move/delete on `{cond && <X/>}` / ternary branches — P2 · CONFIRMED (code)
- **Auto-resolution:**
  - Delete: remove the whole `{cond && <X/>}` container when `<X/>` is its only JSX. For a ternary branch, replace that branch with `null`. Confirm with "removes it in every state".
  - Move: move the whole expression container as a unit, using `jsxChildRange` on the `JsxExpression`.
- **Effort:** M. **Owner:** parser-surgeon.

### WB-21 — `mixed-indentation` (reorder/group) — P2 · CONFIRMED (code)
- **Auto-resolution:** first split the one or two affected same-line siblings onto their own lines. This is a minimal, local reformat of the lines the gesture touches, reported in the success toast. Then run the normal move.
- **Effort:** S–M.

### WB-22 — `no-sibling-anchor` (7%) and multi-reorder — P2 · CONFIRMED (doc)
- **Auto-resolution:**
  - Allow the anchor to be a sibling **expression container** (`{items.map(...)}`) rather than only an element.
  - For multi-select reorder, apply the moves one at a time on the server, re-locating each through the `relocatedNodeIds` machinery `store-14` already has.
- **Effort:** M.

### WB-23 — A broken `tsconfig.json` makes the whole project load throw, with a raw message — P1 · CONFIRMED
- **Trigger (probe `probe-tsconfig.ts`):** a missing brace makes `loadStudioPages` throw `'}' expected.`. `studioRouteFailure` (`server/handlers/studio.ts:319-321`) returns it verbatim with a 500, so the board does not open. A mid-edit tsconfig from the agent or the user takes the entire project down.
- **Auto-resolution:** in `createWorkspaceProject` (`componentSources.ts:83`), catch the error and fall back to a project with no tsconfig, plus a `tsconfig-unreadable` warning. Path aliases are lost; everything else loads.
- **Effort:** S. **Owner:** parser-surgeon.

### WB-24 — A page with a syntax error parses by error recovery and stays editable — P1 · CONFIRMED (parse); write SUSPECTED
- **Trigger (probe `probe-broken.ts`):** an unclosed `<p>` still produces nodes (`"unclosed"` as text) with no indication. Codemods then run on a recovered AST and write into an already-broken file.
- **Auto-resolution:** read `sourceFile`'s syntactic diagnostics at parse time. If any exist, mark the page `syntax-error` with the line, lock writes to that file (the refusal names the line, with "Open in code"), and show a quiet in-frame badge. The load must keep the never-throws contract.
- **Effort:** S–M. **Owner:** parser-surgeon + canvas-engineer.

### WB-25 — Batch writeback is O(edits × parse) and runs under the project write lock — P1 · CONFIRMED
- **Where:** each `set*` codemod calls `createProject()` and re-parses. `applyStudioEdit` never passes the optional `project`. Separately, `findJsxElementAtLocation` walks every descendant for each lookup.
- **Measured (probe `probe-perf.ts`, 1,500-element file):** 40 prop edits take **3.8 s** (~95 ms each), all inside `withProjectWriteLock`, blocking git verbs and other saves. One text edit takes 117 ms; one delete takes 191 ms. Load takes 725 ms.
- **Fix:** one shared ts-morph `Project` per batch per file, with `refreshFromFileSystemSync` between edits, and a position-indexed lookup (`getDescendantAtPos` then walk up) instead of a full walk.
- **Effort:** S–M. **Owner:** perf-hunter + parser-surgeon.

### WB-26 — `<React.Fragment>` becomes a package module — P1 · CONFIRMED (moduleId); render impact SUSPECTED
- **Trigger (probe `probe-patterns3.ts`):** the node is `pkg.react.React.Fragment`. At Tier 0 a `pkg.*` node renders the package placeholder, so the whole page body sits inside a placeholder. `<Fragment>` imported from react, and `<></>`, should both map to the zero-DOM fragment.
- **Fix:** special-case `React.Fragment`/`Fragment` from `react` as a fragment in `processElement`.
- **Effort:** S. **Owner:** parser-surgeon.

### WB-27 — A `.map` over a prop that the call site passes as a resolvable value stays locked — P1 · CONFIRMED
- **Trigger (probe `probe-patterns.ts`):** `<List items={ITEMS}/>`, where `List<T>` does `items.map(...)`, gives `locked: dynamic — rendered in code`. The same root cause blocks guards on props (`{subtitle && …}`) and `??` defaults with an absent prop (`<Btn/>` rendering `{label ?? 'Default'}` loses "Default"; probe `probe-patterns3.ts`).
- **Root cause:** documented in `studio-import.md` parser-08. `inlineLocalComponents` parses the component's JSX before `applySubstitutions` binds the call-site scope.
- **Fix:** thread the call-site bindings into `parseJsxTree`'s eval context for the inlined parse. That is Tier A (reading call-site source), not Tier D.
- **Effort:** M–L. **Owner:** parser-surgeon. **Plan coverage:** named in the doc (15 of 20 undecidable evaluations on the corpus); not scheduled.

### WB-28 — Mixed text-and-element children are lost — P1 · CONFIRMED (documented)
- `<p>Price: {price}<strong>USD</strong> today</p>` renders only `<strong>`. `<button><Icon/> Save</button>` loses "Save". `studio-import.md` "What still does not import" documents this.
- **Fix:** a text-run child kind, where each `JsxText` run is its own node with its own `line:col` and is written by a run-level `setJsxText`.
- **Effort:** L. **Owner:** parser-surgeon + canvas-engineer.

### WB-29 — The unresolved `codeText` trace never reaches `codeProps` (board-27b known gap, still open) — P1 · CONFIRMED (code)
- **Where:** `parsedPageToSitePage.ts:169-178`. The fold sits inside `if (node.text !== undefined)`.
- **Impact:** `<p>{user.name}</p>` shows an empty, apparently editable text field. Typing into it ends in the WB-12 red toast.
- **Fix:** one line. Move the `codeText` push outside the `text` guard.
- **Effort:** S. **Owner:** parser-surgeon.

### WB-30 — A declaration edit on a compiled or Tailwind class is refused with "will be lost on reload" — P1 · CONFIRMED (code)
- **Where:** `refusalToasts.ts:125-138` (`unmapped`).
- **Auto-resolution:** offer "Apply to this element" as the default remedy:
  - For Tailwind, swap the utility token through `setJsxClassName` using the resolved theme scale (`tokenExtractTailwind.ts` already has the scale).
  - Otherwise, write a co-located override class (`insertRule` plus a `class` add) or an inline style.
  - Keep "edit every element with this class" refused, with the reason stated.
- **Effort:** M. **Owner:** parser-surgeon + panel-designer.

### WB-31 — `@container`/`@supports` overrides are refused — P2 · CONFIRMED (code)
- **Fix:** generalize `setDeclarationAtMedia` to any at-rule. postcss is indifferent to which one.
- **Effort:** S. **Owner:** parser-surgeon.

### WB-32 — Locale JSON writes reformat the whole file — P2 · CONFIRMED (code)
- **Where:** `server/handlers/studio/translationWrite.ts:178` (`JSON.stringify(parsed, null, 2)` plus LF). The file's own indentation (tabs, 4 spaces) is lost, CRLF is lost, and a one-key edit produces a whole-file diff.
- **Fix:** detect the indentation and EOL (`@core/utils/lineEndings`) and re-serialize with them, or splice only the value span.
- **Effort:** S.

### WB-33 — Raw exception text reaches the UI — P2 · CONFIRMED (code)
- `studio.ts:321,637` and `projectRoutes.ts` (about ten sites) return `err.message` with a 500. That text can include absolute paths or ts-morph internals.
- **Fix:** log the raw error and return a sentence mapped from a code.
- **Effort:** S. **Owner:** server-engineer.

### WB-34 — `board-27f`: a literal `className` with no matching `StyleRule` is removed from the DOM — P1 · CONFIRMED (documented)
- Vendor and utility classes lose their styling on the canvas even though the vendor CSS is injected.
- **Fix:** keep the literal class string on `PageNode` as a render passthrough, separate from `classIds`, as the doc designs.
- **Effort:** M. **Owner:** parser-surgeon + canvas-engineer.

### WB-35 — An unwritable edit holds the baseline back, so the whole batch is re-sent every autosave tick — P2 · SUSPECTED
- `fsCodemodAdapter.ts:620-631`. With `unexplainedSkips > 0`, nothing commits, so every tick re-sends all edits and re-toasts. Toast dedupe (Z1) limits the noise, but the server still does repeated work under the lock (see WB-25).
- **Fix:** per-edit outcomes in the response, and commit the successes.

### WB-36 — `useState([...])` arrays are not expanded — P2 · CONFIRMED (documented scoping)
- The literal default is read only for conditions, to protect `previewLocale`.
- **Fix:** allow the default-literal read for `.map` receivers only (not for element-access keys), which keeps the i18n concern untouched.
- **Effort:** S.

### WB-37 — Selection and undo after a line shift from a value edit — P2 · SUSPECTED
- The edited node keeps its id, but siblings below it get new ids after resync. No remap of multi-selection or history across a resync was found. WB-9 and WB-10 remove most of the triggers.

---

## 2. Full refusal inventory

"Surface" is how the user sees it today: **D** = RefusalDialog, **T-err** = red toast, **T-warn** = warning toast, **T-info** = info toast, **S** = silent (the store rejects the change and no write happens), **U** = generic unexplained-skip red toast.

### 2a. Client, before a write (`src/core/page-tree/sourceStructure.ts`, stores)

| Reason | Exact message (abridged) | Trigger | Surface | Auto-resolution |
|---|---|---|---|---|
| `list-row` | "…a row of a list that the code generates. One piece of source JSX renders every row…edit the array it maps over." | any structural gesture or edit on a `#n` id | D (remedy "Open the array in code") | WB-15: edit the array literal; template write with "all N rows" |
| `shared-component` | "…markup that lives in a shared component's own file, so the change would apply to every place…" | structural gesture on a `~` id | D (open / detach / duplicate-file) | WB-14: "Change every instance (N)" / detach-then-replay |
| `route-chrome` | "…markup from a layout file, which every page below it renders…" | Next `layout`/`template` | D (jump to source) | Same "apply to every route (N)" choice as WB-14 |
| `code-placed` | "The code decides where this element goes (${lockReason})…" | spread / dynamic lock | D (jump) | For a spread: move/delete are still single-target (only VALUES are unknown). Consider lifting the lock for move/delete |
| `multi-select` | "…several elements at once — Studio writes a move one element at a time…Drag them one by one." / wrap variant | multi reorder, reparent, wrap | T-warn | WB-22: sequential server relocation; multi-wrap → `group` (K3 exists) |
| `reparent` | "…needs a container that is itself an ordinary element in the code." | no destination | T-warn | Keep |
| `cross-file` | "This element is written in X and the container is in a different file…" | reorder/reparent across files | D (jump) | A cross-frame transplant exists; offer "Copy there" (the `duplicate-into-frame` pattern) |
| `no-sibling-anchor` | "This element has no plain sibling to be written next to…" | neighbour is `.map`/expression | T-warn | WB-22: anchor on an expression container |
| `insert` (minted) | "This element was created in the editor, so it has no markup…" | plugin/agent `applyTreeOperation` | throw → caller | Keep (it points at the working path) |
| `duplicate`/`wrap`/`reparent`/`group`/`ungroup` (minted copy) | "Studio {noun}s imported markup by editing your project's source…This path changes the canvas tree only…" | plugin/agent dispatcher | throw | Keep |
| `static-parent` (K6) | explains `position: static` | ⌘-drag by coordinates | D (write `position: relative`) | Already a one-click fix |
| codeProps (store) | none | `updateNodeProps` with any code-valued key | **S** | WB-8 (origin write), WB-6 |
| "This text is set in code" | inline edit on a code-valued text prop | double-click | T-info | WB-6 / WB-8 |
| `stylesheet-not-created-yet` | class whose stylesheet is being created this save | class add | held back and retried next save | Fine |
| `ambiguous-stylesheet` | "Studio found N candidate stylesheets…" | new class, N files, none co-located | D (choose file) | Fine (Z8) |
| `no-editable-stylesheet` | "…no stylesheet exists, and nothing names a page…" | new class, no files, no page | T-err | Create beside the open page (Z8) or use the inline hatch; should be unreachable |
| unmapped style rule | "…has no hand-editable CSS file…stays on the canvas only and will be lost on reload." | declaration edit on a Tailwind/compiled/Sass class | **T-err** | WB-30 |
| `breakpoint-override-unsupported` | "…cannot yet write @container or @supports…lost on reload." | container/supports context | **T-err** | WB-31 |
| class assignment on a `.map` row | `classAssignmentUnsavedNotice` | classIds drift on a `#n` node | T-err | WB-15 template write |
| "Too many changes at once" | "Studio is still writing the last N changes…" | structural queue overflow | T-warn | Raise the cap, or coalesce the queue |
| "Image was not saved to source" | "The import naming this image could not be rewritten…" | asset edit skipped | T-err | WB-1 re-locate, then auto-reload |

### 2b. Server, at write time (codemods and handlers)

| Reason | Source | Exact message (abridged) | Trigger | Auto-resolution |
|---|---|---|---|---|
| `stale-source` | move, delete, duplicate, insert, wrap, wrapJsxElements, unwrap, transplant | "This file changed on disk since the canvas last read it. Reload the project and try again." | disk text ≠ ts-morph text **within a run** | WB-1: re-locate, auto-reload, no toast |
| `not-found` | jsxChildRange, move, duplicate, insert, insertJsxIntoSlotProp, transplant, addSlotProp, structural handler | "No JSX element is written at line L, column C any more — the file changed…Reload and try again." | position empty | WB-1 re-locate |
| `expression-child` | jsxChildRange, wrapJsxElements | "In the code this element is produced by an expression…no place in the file to write a new one." / "Something the code decides…sits between these elements…" | `{cond && <X/>}` | WB-20 |
| `no-jsx-parent` | jsxChildRange, addSlotProp | "This element is the outermost thing its component returns…" | root of a return | Delete → offer "return null" / fragment; otherwise keep |
| `not-siblings` | move, wrapJsxElements, jsxChildPlacement ×2 | "These two elements are not siblings in the code…" | canvas order ≠ source nesting | Keep; phrase as "drag within X" |
| `mixed-indentation` | move, wrapJsxElements | "One of these elements is on a line of its own and the other shares a line…Reorder them in the file instead." | same-line siblings | WB-21 |
| `into-own-descendant` | move, duplicate | "That container is inside the element being moved…" | cyclic drop | Keep (canvas should prevent the drop) |
| `out-of-scope` | move, duplicate | "This element reads X from the code around it…not in scope where it would land…" | free variables | Keep; name the variables (already done) |
| `same-element` | move | "An element cannot be moved next to itself." | no-op drag | Make it a silent no-op |
| `no-anchor` | move | "A reorder is written as 'put this element next to that one'…" | missing anchor | WB-22 |
| `binding-conflict` | insert, insertJsxIntoSlotProp, wrap, wrapJsxElements, transplant | "This file already uses the name 'X' for something else…Rename one of them in the file first." | name clash | WB-19: aliased import |
| `not-a-container` | jsxChildPlacement | "Studio could not read where this element closes…" / "…could not resolve this element to something that can hold children." | odd shape | Keep |
| `void-element-children` | jsxSubtree | "<X> is a void element and cannot hold children…" | insert into `<img>`/`<input>` | Insert as the next sibling instead |
| `unsafe-tag` | jsxSubtree | "…starts with a capital letter…pass importSpecifier" / "…not a tag Studio will write…" | bad tag | Keep (security) |
| `content-model` | wrapperContentModel | "A <X> cannot go where these elements are without making the HTML invalid…" | invalid wrapper | Auto-pick a valid wrapper (the div/span fallback already exists) |
| `not-contiguous` | wrapJsxElements | "There are other elements in the code between the ones selected…" | gap in the run | Offer "group the whole run" |
| `no-targets` | wrapJsxElements | "A group is written around elements, and none were named." | empty | Keep |
| `has-behaviour` ×3 | unwrap | "<X> is a component…" / "This container spreads props…" / "This container carries `x`…" | ungroup of a non-plain wrapper | Keep; offer "move children out, keep wrapper" |
| `same-file` | transplant | "Both ends of this move are in the same file…" | misuse | Route to reparent automatically |
| `captured-scope` | transplant | "This element reads X from the component it is written in…" | cross-file drag | Offer a copy with the values' **expressions** as props? No: keep the refusal plus "Copy there" |
| `unexported-binding` | transplant | "…declares but does not export…Export X…first" | cross-file drag | Auto-add `export` to the declaration (single target) |
| `cross-file` ×4 | studioStructuralWriteback | "The element this move is written against is not in the same file…" etc. | foreign anchor or destination | See 2a |
| `style-target` | setJsxStyle ×6 (`JsxStyleTargetError`) | "the 'style' attribute is a spread attribute…" / "no object-literal expression…" / "not a plain object literal…" / "contains a spread element…" / "style key 'x' is not a plain 'key: value' property…" | non-literal style | WB-17 |
| `css-module-import-missing` | setJsxClassName | "this class lives in X, a CSS Module…but F does not import that stylesheet…" | module class, no import | WB-18: post-batch import pass |
| `css-module-binding` | setJsxClassName | "className is bound to a CSS Modules import…Edit the class's own declaration…" | remove from `styles.x` | Keep (remedy exists) |
| `template-dynamic` | setJsxClassName | "className is a template literal with an interpolated value…" | remove from a dynamic template | Keep for remove |
| `unsupported-call` | setJsxClassName | "className is set by a function call…only cn/clsx/classNames/classnames…" | other helper | WB-18: wrap for add |
| `spread-attribute` | setJsxClassName, insertJsxIntoSlotProp | "the 'className' attribute is a spread attribute…" | spread | Keep |
| `unsupported-expression` | setJsxClassName ×3 | "className is set by an expression…this codemod does not understand…" | identifier or ternary | WB-18: wrap for add |
| `duplicate-selector` | analyzeDeclarationTarget | "'sel' is declared more than once…a later block also sets 'p'…" (also reused for an unparseable CSS file) | cascade | WB-16 |
| `duplicate-declaration` | analyzeDeclarationTarget, setStyledDeclaration | "'p' is declared more than once inside 'sel'…" | duplicate | WB-16 |
| `shorthand-override` | analyzeDeclarationTarget | "…sets the 'padding' shorthand after 'padding-top', which resets it…edit 'padding' instead." | shorthand after | WB-16 |
| `important-override` | analyzeDeclarationTarget | "…sets 'x: … !important', which overrides…" | !important | Dialog |
| `duplicate-keyframes` | keyframes.ts | "This file declares @keyframes N k times. The last one wins…" | duplicate block | Write to the last block |
| `compiled-stylesheet` | studioCssWriteback | `editability.reason` | `.min.css`/`dist/` | Keep (source maps are L) |
| `stylesheet-import-shape-mismatch` ×2 | studioCssWriteback | "X is already imported without a binding, but…needs a CSS-Module default import…" (and the reverse) | import form | Add the binding in place (the css-module path already does this) |
| `unwritable-value` | setStyledDeclaration | "'v' cannot be written into a styled-component template — it contains a character that would end the declaration…" | backtick, `;`, `{`… | Keep |
| `template-not-found` ×2 | setStyledDeclaration | "Studio expected a styled-component template at…and no longer finds one. Reload…" | stale | WB-1 |
| `declaration-not-in-template` | setStyledDeclaration | "'p' is not written in X's own template. It comes from an interpolated block…" | mixin | Offer "add an override declaration to this template" (appending wins in the cascade) |
| `interpolated-value` ×2 | setStyledDeclaration | "'p' is set from an interpolation…" / "…spans an interpolation…Studio will not rewrite half a value." | `${theme.x}` | Keep; jump to the interpolation's origin when resolvable |
| detach: `not-a-component`, `package-component`, `unresolvable`, `unsupported-params`, `uses-hooks`, `maps-over-props`, `no-renderable-jsx` | detachComponent, resolveComponentCallSite | e.g. "X uses useState — detach can't inline a component that uses hooks." / "…maps over one of its own props…" / "…takes an undestructured props parameter…" | detach | Extract-copy remedy exists. `unsupported-params`: rewrite `props.x` → destructure (single file, mechanical) |
| swap: `not-a-component`, `same-component`, `name-shadow`, `unresolvable`, `package-component` | swapComponentInstance | "'X' is already used by another import/declaration in this file…" | swap | `name-shadow` → aliased import (WB-19) |
| extract-copy: `not-a-component`, `unresolvable`, `copy-exists` | extractComponentCopy | "X2.tsx already exists next to X.tsx." | suffix taken | Pick the next free suffix automatically |
| extract-subtree: `spread-props`, `slot-name-conflict` ×2, `name-taken` (+ refusePlacement set) | extractSubtreeToComponent | "This element spreads an arbitrary prop bag…" / "Two selected children both want the slot name…" | extract | `name-taken` → auto-suffix |
| slot: `replace-not-supported`, `spread-attribute`, `slot-ambiguous` ×2, `binding-conflict`, `not-found` | insertJsxIntoSlotProp | "The 'x' prop is set to an expression…Studio can't tell whether that currently means 'empty'…" | slot fill | Keep |
| addSlotProp: `unsupported-props-type` ×2, `not-found`, `no-jsx-parent`, `unsupported-params`, `prop-name-taken` | addSlotPropToComponent | "…'Props''s own declaration…" / "…already has a 'x' prop." | slot authoring | `prop-name-taken` → suggest a free name |
| i18n extract: `name-taken`, `invalid-key`, `not-found` ×2, `text-changed`, `outside-component` | extractStringsToDictionary | "F already binds 't'…" / "The text at F:L changed since it was scanned." | extract strings | `name-taken` → alias the hook |
| **generic (value kinds, → U)** | setJsxText `JsxTextTargetError` | "element has non-text children (nested elements or mixed content) — refusing…" | mixed children | WB-28 / WB-12 |
| generic | locateJsxElement | "No JSX element found at <abs path>:L:C (expected the column…)" | stale id | WB-1 |
| generic | setJsxProp | "Attribute 'x'…is a spread attribute…" | edge | WB-12 |
| generic | setJsxTagName `JsxTagNameTargetError` | "'x' is not a plain HTML tag name" / "<X> is a component, not an HTML element — renaming it would need an import" | tag edit | Component → offer Swap |
| generic | setStringLiteral / setImportSpecifier | "line/column is outside the file" / "no node at this position" / "expected a string literal…found K" / "…not an import declaration's module specifier" | stale origin | WB-1 |
| generic (`applied:false`) | `resolveClassNameTokens`/`resolveContainedRefPath`/`resolveContainedCssPath`/`studioEditLocation` returning null | none (becomes an unexplained skip) | unsafe or missing path | Typed reasons (WB-12) |
| hard throw | `createWorkspaceProject` | raw TS diagnostic ("'}' expected.") → 500 | broken tsconfig | WB-23 |

---

## 3. Checked and clean

- **CRLF:** a CRLF `.tsx` and `.css` file kept `\r\n` through text, style, class and css edits in one batch (`probe-crlf.ts`). `EolPreservingFileSystem` works. (JSON locale writes are the exception, WB-32.)
- **Path containment** (`studioEditLocation`, realpath-based): read, and no weakness found.
- **Parse never throws:** true for `parsePageFile`. It is **not** true for the load as a whole (WB-23).
- **An anonymous `export default () => …` page**, same-file local components, `{children}` layouts, and **branch selection via a `useState(false)` default**: all correct.

## 4. Suggested sequencing (for the master plan)

1. **Data-safety barrier (S each):** WB-1 guard (expected tag), WB-2, WB-7, WB-11, WB-23, WB-29.
2. **Visibility of ordinary React:** WB-3, WB-4, WB-26, WB-5.
3. **Refusals become writes:** WB-6, WB-8, WB-17, WB-18, WB-19, WB-16, WB-30, WB-31.
4. **Noise:** WB-12, WB-13 (retire every red save-time toast), WB-9/WB-10 (formatting), WB-25 (lock latency).
5. **Structural blast-radius choices:** WB-14, WB-15, WB-20, WB-21, WB-22.
6. **Larger parser work:** WB-1 re-locate plus watcher, WB-27, WB-28, WB-34.

Probe scripts in this folder (none of them touch the repo): `probe-dict-cache.ts`, `probe-stale-write.ts`, `probe-patterns{,2,3}.ts`, `probe-broken.ts`, `probe-perf.ts`, `probe-crlf.ts`, `probe-dedupe.ts`, `probe-tsconfig.ts`, plus `refusals-raw.txt` (the grep dump behind §2).
