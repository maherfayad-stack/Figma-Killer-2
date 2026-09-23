# Track B2 — `setJsxClassName` — handoff

## Scope (files touched)

- `src/core/page-parser/staticEvalCalls.ts` — exported `CLASS_NAME_JOIN_BUILTIN_NAMES` (was a private const) so the codemod can recognize the identical `cn`/`clsx`/`classNames`/`classnames` call shapes the read-side evaluator already understands.
- `src/core/page-parser/index.ts` — re-exported `CLASS_NAME_JOIN_BUILTIN_NAMES` from the barrel.
- `src/core/ast-codemods/setJsxClassName.ts` — **new.** The codemod itself.
- `src/core/ast-codemods/index.ts` — barrel exports for `setJsxClassName` + its types.
- `src/core/ast-codemods/__tests__/setJsxClassName.test.ts` — **new.** 22 tests, every table row (success and refusal).
- `server/handlers/studioEditSchemas.ts` — added `ClassEditSchema` (`kind: 'class'`) to `StudioEditSchema`.
- `server/handlers/studioWriteback.ts` — imports `setJsxClassName`, dispatches `case 'class'` in `applyStudioEdit`, added `'class'` to `StudioEditRefusal['kind']` and `isRefusingEditKind`.
- `src/admin/pages/site/studio/classNameWriteback.ts` — **new.** Client-side `collectClassNameEdits`: turns `classIds` drift into `kind:'class'` edits + the genuinely-unwritable residual.
- `src/admin/pages/site/studio/fsCodemodAdapter.ts` — wired `collectClassNameEdits` into `saveSite`; removed the old "always toast, never write" block; added `class: 'Class change not saved to source'` to the `REFUSAL_TITLES` map; removed the now-dead `getNodeDisplayName`/`collectClassIdsDrift` imports (moved into `classNameWriteback.ts`).
- `src/admin/pages/site/panels/classAssignmentUnsavedNotice.ts` — doc + message rewritten to describe the new, narrower scope (genuinely-unwritable nodes only), function/exports unchanged.
- `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` — rewrote the "0.6 seam" describe block into two: one proving the write happens on a writable node (+ refusal-toast path), one proving the honest-refusal toast is unchanged for a genuinely unwritable node (`.map` row).

I did **not** touch `styleRuleWriteback.ts`, `server/handlers/studioCss*.ts`, `src/core/css-codemods/**`, the store, canvas, or `server/ai/**` — all off-limits per the work order.

## The `class` edit-kind schema shape (E2.4 extends this next)

```ts
// server/handlers/studioEditSchemas.ts
const ClassEditSchema = Type.Object({
  kind: Type.Literal('class'),
  nodeId: Type.String(),
  add: Type.Array(Type.String()),
  remove: Type.Array(Type.String()),
})
```

Folded into `StudioEditSchema`'s union right after `StyleEditSchema`. `add`/`remove` carry class **names** (`site.styleRules[id].name`), never `sc-<hash>` ids — the codemod edits literal token text in the user's `className`, and ids are Studio's own bookkeeping with no meaning in source.

Server dispatch (`studioWriteback.ts`'s `applyStudioEdit`, `case 'class'`):

```ts
case 'class': {
  const result = setJsxClassName({ ...loc, add: edit.add, remove: edit.remove })
  if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
  return { applied: true }
}
```

Same "leaf returns `{ok,refusal}`, dispatcher throws `StudioEditRefusalError`" shape `detach`/`swap`/`css` already use — `'class'` refusals surface through `StudioEditBatchResult.refusals` exactly like those three, and ride `applyStudioEditBatch`/MCP's `studio_apply_edits` for free (no MCP code change needed — see landmine below).

## `setJsxClassName(params): { ok: true } | { ok: false, refusal: { reason, message } }`

`src/core/ast-codemods/setJsxClassName.ts`. Params: `{ file, line, col, add: string[], remove: string[], project? }`. Never throws except the shared `findJsxElementAtLocationOrThrow` "no JSX element at this location" error (same contract every sibling codemod has).

## Refusal vocabulary (`ClassNameRefusalReason`)

| Reason | Trigger |
|---|---|
| `spread-attribute` | `className` is a spread attribute (defensive — see landmine, effectively unreachable in practice, same as `setJsxStyle`'s identical guard) |
| `css-module-binding` | `className={styles.card}` where `styles` is a **default import** from a `*.module.css` file (detected via `sourceFile.getImportDeclarations()`, matching the READ-side `resolveCssModuleImport`'s default-import-only convention) |
| `template-dynamic` | `` className={`a ${x}`} `` **and** a `remove` was requested — a token might live in the interpolated part, which cannot be read from source text |
| `unsupported-call` | `className={someFn(...)}` where `someFn` is not `cn`/`clsx`/`classNames`/`classnames` |
| `unsupported-expression` | everything else: bare identifier, ternary, a member access that is NOT a CSS-module binding, an empty expression container `{}`, a JSX-element/fragment initializer |

## What now works vs. still refuses

**Works (writes to disk):**
- absent `className` → creates `className="…"`
- `className="a b"` (plain literal, either quote style — preserves the file's existing quote char via ts-morph's `StringLiteral.setLiteralValue`, which splices in place rather than rebuilding with a project default)
- `className={"a b"}` / `` className={`a b`} `` (static string in an expression container)
- `` className={`a ${x}`} `` — **ADD only**, appended to the static head (`` `a ${x}` `` + add `b` → `` `a b ${x}` ``); REMOVE refuses `template-dynamic`
- `className={cn('a', x)}` / `clsx`/`classNames`/`classnames` — ADD merges into (or appends as a new arg to) a literal string argument; REMOVE strips a token from every literal string arg it appears in, removing the whole arg if it becomes empty. A token reachable only through a non-literal argument (`isActive && 'active'`) is left alone — best-effort, matches every other Tier A/B/C "never guess" degrade.
- **Tailwind fill swap end to end**: `className="rounded bg-red-500"` + `remove:['bg-red-500'], add:['bg-blue-600']` → `className="rounded bg-blue-600"` (tested).
- A no-op request (every add token already present, every remove token already absent, or both arrays empty) never inspects the attribute shape at all and never refuses — so a re-sent already-applied edit is silent, not a spurious refusal.

**Still refuses (named, not silent):**
- `className={styles.card}` (CSS Modules binding) → offers "edit the class's own declaration instead"
- a dynamic template's REMOVE
- an unrecognized function call
- a bare identifier / ternary / any other expression shape

## Phase 0.6 → Track B2 conversion — proven, not just asserted

**Consumer named and verified called:** `fsCodemodAdapter.ts`'s `saveSite` calls `collectClassNameEdits(site.pages, site.styleRules, site.visualComponents)` (from `classNameWriteback.ts`), pushes `classPlan.edits` into the same `edits` array as every prop/style/text edit, and POSTs them in the same `/admin/api/studio/save` batch. Proven end-to-end in `fsCodemodAdapter.test.ts`'s new `'class assignment on a writable node reaches disk (Track B2)'` describe block:
- assigning a class → `POST /admin/api/studio/save` body contains exactly `{ kind:'class', nodeId, add:['card'], remove:[] }`, **and zero toasts**.
- removing a class → `{ add:[], remove:['card'] }`.
- unchanged classIds on the next tick → **no POST at all** (baseline advanced, matches CSS's own "advance unconditionally" discipline).
- a server-side refusal (e.g. `css-module-binding`) → surfaces as an `error` toast titled "Class change not saved to source" via the existing `REFUSAL_TITLES` loop — same channel `detach`/`swap`/`css` already use.

**The old refusal path is genuinely deleted**, not left running in parallel: the old `collectClassIdsDrift(site.pages)` → always-toast block in `fsCodemodAdapter.ts` is gone; `classAssignmentUnsavedNotice.ts`'s `notifyClassAssignmentUnsaved` is now called ONLY with `classPlan.unwritable` (nodes with no writable source location at all — a `.map` row, a synthetic root). Proven in the second describe block (`'class assignment on a node with no writable source location still warns (0.6 residual)'`), using a `pages/Home.tsx:3:1#2` fixture id (a `.map` iteration, `hasWritableSourceLocation` → `false`): still gets exactly one warning toast, still sends **no** edit — this is the genuine remaining gap, not a regression.

## Decisions (the four questions, for the record)

`class` is a **structural-adjacent value edit**, same family as `prop`/`style`/`tag`:
1. **Locks the node?** No — matches every other value-edit kind. `classIds` assignment was never gated on `locked` before (doc: "Classes are unaffected either way") and still isn't.
2. **Adds to `codeProps`?** No — `classIds` isn't a `props` entry at all; writability is decided per-node by `hasWritableSourceLocation`, not per-prop by `isPropWritableToSource`. (`classAssignment` has no analogous "read-only sibling props stay editable" story — it's all-or-nothing per node, same granularity `struct-01`'s structural gate uses, because there is exactly one `className` attribute per element.)
3. **Carries an `origin`?** No — `add`/`remove` are USER-CHOSEN class names from the CSS Classes panel, never a value *read* out of source. `origin` is reserved for a literal the evaluator read; nothing here is computed OR read, it's authored fresh by the user picking a class.
4. **Panel?** No new control — `classIds` assignment already has its own UI (`ClassPicker`/`SelectorsPanel`/`MultiSelectorInspector`, store-engineer territory this wave). This work order only converts what happens to that assignment at SAVE time; the panel itself is unchanged.

## `applyTreeOperation` — deliberately NOT touched (item 3 of the work order)

Checked and concluded not applicable. `applyTreeOperation`/`TreeOperation` (`src/core/page-tree/treeOperations.ts`) dispatches the 11 named **in-memory tree mutations** (insertNode, updateNodeProps, …) for plugins/agents via `cms.content.tree.mutate`. `classIds` is a top-level `PageNode` field, not part of `props`, and is mutated by dedicated store actions (`addNodeClass`/`removeNodeClass`/`reorderNodeClass`, store-engineer-owned this wave) that were never part of the 11 and never routed through `applyTreeOperation` — that's a pre-existing gap (plugins/agents have no in-tree verb to touch `classIds` at all), unrelated to and out of scope for B2. **`class` (the new `StudioEditSchema` kind) lives entirely on the SAVE-TIME disk-write side** — exactly where every other VALUE kind (`prop`/`style`/`text`/`tag`/`asset`/`css`) already lives, and none of those are wired into `applyTreeOperation` either. So "add it to `applyTreeOperation`" would be inventing a new capability outside this task's scope, not preserving an existing pattern. MCP/plugins already ride the SAME gate for free — see below.

## Landmines found (not in the 578-line doc) — tell `studio-scribe`

0. **`docs/features/studio-import.md:693` is now a false claim.** It reads:
   > "A rule with no mapped `.css` source — a Tailwind/Sass/PostCSS-generated
   > class or a CSS Modules compile. The correct edit for Tailwind is an
   > element `className` change, which is a separate feature; until it exists
   > the user is told the change is canvas-only."
   That "separate feature" is exactly what this change ships. The CSS-rule
   side (`css` edit kind, `styleRuleWriteback.ts`'s `unmapped` list) is
   unchanged and still correctly reports an unmapped Tailwind/generated CSS
   *rule* as canvas-only — that part of the sentence stays true. What's now
   false is "which is a separate feature; until it exists" — a Tailwind
   *element* `className` edit (the fill-swap example the doc itself uses
   elsewhere) now DOES reach disk via `kind: 'class'`/`setJsxClassName`. This
   line (and the near-identical one at `docs/features/studio-import.md:23`'s
   "CSS is one-way" summary, if it still says nothing else can write) needs a
   forward pointer to Track B2 / `setJsxClassName`.

1. **`server/ai/mcp/tools/studio/editTools.ts`'s `studio_apply_edits` tool description text is now stale.** It imports `StudioEditSchema` directly and calls `applyStudioEditBatch`, so the new `'class'` kind rides through the dispatcher with **zero code change** — but the tool's hand-written description string (`"kind: prop|text|style|literal|tag|asset|detach|swap|insert|delete|move|css"`) doesn't mention `class`, so an AI agent reading the tool description won't know class-token edits exist. `server/ai/**` was off-limits to me this wave (owned by a concurrent agent) — **mcp-tooling should add `class` to that description string** (and ideally a one-line usage note: `add`/`remove` are class NAMES, not `sc-` ids).
2. **`ts-morph`'s `StringLiteral.setLiteralValue`/`NoSubstitutionTemplateLiteral.setLiteralValue` already preserve the file's existing quote character** (they splice text between the existing delimiters rather than rebuilding with the project's default `QuoteKind`) — unlike `setJsxProp`'s `buildInitializerText`, which always picks fresh quotes. Worth knowing before reaching for `setStringLiteral.ts`'s manual quote-preservation dance in a future codemod that only needs `setLiteralValue` — it's already free.
3. **CSS Modules binding detection is default-import-only** (`isCssModuleBinding` in `setJsxClassName.ts`), matching `resolveCssModuleImport`'s existing read-side convention (`assetImports.ts`) — a named import from a `.module.css` file (`import { card } from './x.module.css'`, non-standard but not impossible) is NOT detected and falls through to the generic `unsupported-expression` refusal instead of the more specific `css-module-binding` one. Same limitation the read side already has; not a regression, just worth naming if a future agent wonders why the reason differs.
4. **`className`'s `spread-attribute` refusal path is effectively unreachable in real code**, same as `setJsxStyle`'s identical guard (`element.getAttribute('className')` only matches a spread attribute if its literal text happens to equal `"...expr"`, which normal spread syntax never produces) — kept as defensive code per precedent, but there is no realistic fixture that exercises it, so (matching `setJsxStyle.test.ts`'s own precedent) I did not write a test asserting that specific reason string. If a future refactor of `getAttribute` ever makes it reachable, it needs a test then.
5. **A pure class-token REORDER writes nothing, by design** — `classNameWriteback.ts`'s `collectClassNameEdits` skips any drift where `addedClassIds`/`removedClassIds` are both empty (reorder-only). Rationale: class-attribute token order has no effect on CSS cascade order (that's decided by declaration order in the stylesheet), so there's nothing honest to persist. Not documented anywhere before this change — worth a line in `docs/features/studio-import.md`'s CSS/class section if scribe wants it.

## Verification run

- `bun test src/core/ast-codemods/__tests__/setJsxClassName.test.ts` — 22 pass, 0 fail.
- `bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio` — 470 pass, 6 fail. **All 6 failures are in `src/__tests__/studio/styleRuleWriteback.test.ts` against `styleRuleWriteback.ts`** (a file explicitly off-limits to me, owned by the concurrent B1 track — its `resolveCssInsertDestination` result shape and `STUDIO_BREAKPOINT_ID` sync are mid-change in this same working tree). Confirmed via `git status` that I never touched `styleRuleWriteback.ts` or its test — not mine.
- `bun test server/handlers/__tests__/studioWriteback.test.ts` — 57 pass, 0 fail.
- `bun test src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` — 32 pass, 0 fail (includes the rewritten 0.6-seam tests).
- `bun test server/handlers server/ai/mcp/tools/studio` — 1132 pass, 7 fail, 1 error, all pre-existing/unrelated (`projectGuide.ts` legacy-artefact sweep, `projectSeed.ts`, GitHub-import URL parsing, sass worker stdout parsing, a live-reload-push transport test) — none touch className/classIds/StudioEditSchema.
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — clean, no errors.
- `./node_modules/.bin/eslint` on every file in Scope above — clean, no errors/warnings.
- Did **not** run `bun run lint` / `bun run build` per instructions (sibling `dist`/`.tsbuildinfo` collision risk in this heavily parallel working tree).

## Note on the working tree

This session's `git status` shows ~140 modified/untracked files across many concurrent tracks (B1's CSS insert work, canvas rulers, MCP quality tools, etc.) — a large multi-agent parallel wave. I only edited the files listed under **Scope** above; everything else was already dirty before I started (confirmed via `git diff --stat` on my own edits only, and by not editing anything in the explicit "concurrent siblings own" list).
