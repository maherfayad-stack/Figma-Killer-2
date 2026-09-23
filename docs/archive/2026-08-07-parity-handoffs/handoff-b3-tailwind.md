# Track B3 — Tailwind read path: the `@layer` defect (standing-09)

Stage: **done**

## Reproduced first, before any fix

Confirmed empirically, before writing the fix:

```
cssToStyleRules('@layer base { .x { color: red } }')  →  { rules: [], warnings: [] }
```

Also checked the statement form and the anonymous-block form — both also
produced `{ rules: [], warnings: [] }`. Worse than "dropped silently with a
signal": **zero warnings were emitted either** — `replaceSync` strips
`@layer` before the rule ever reaches `sheet.cssRules`, so the existing
`dropped-at-rule` path (which only fires for rules the CSSOM *does* surface)
never even sees it. This matches the plan's framing exactly: not "some
styling is off," a Tailwind v4 project imported **zero rules** and nothing
anywhere said why.

## The fix

New pre-pass, `unwrapCssLayers(cssText, warnings)` in
`src/core/siteImport/unwrapCssLayers.ts`, runs on the raw CSS text before
`encodeSubstitutionDeclarations` + `sheet.replaceSync()`. It parses with
`postcss.parse` (postcss is already a repo dependency, used the same way by
`src/core/css-codemods/` — no hand-rolled brace scanner), collects every
`@layer` at-rule in the pristine tree up front (so nested layers are found
too), then for each one:

- **statement form** (`@layer a, b, c;`, no `nodes`) — nothing to splice;
  the node is removed. Its comma-separated names are recorded as
  `declaredOrder`.
- **named block** (`@layer base { ... }`) — `atRule.replaceWith(atRule.nodes)`
  splices its children into its parent at the block's own source position.
  Its name is recorded as the first-appearance `sourceOrder`.
- **anonymous block** (`@layer { ... }`) — same splice, no name recorded.

**Nesting** (`@layer a { @layer b { ... } }`) unwraps correctly because every
`@layer` node in the tree is collected by reference before any mutation
starts; hoisting the outer block's children doesn't invalidate the still-held
reference to the inner block, so it gets its own splice turn when its turn
comes up in the loop. **`@layer` inside `@media`/`@supports`/`@container`,
and the reverse**, both work for the same reason — the splice always happens
at that node's own position in the tree; every other at-rule is untouched.
Verified all of the above with a standalone postcss repro script before
writing it into the module (two-pass collect-then-splice, confirmed correct
output CSS text for: statement, named block, anonymous block, `@layer` in
`@media`, `@media` in `@layer`, and `@layer a { @layer b { ... } }`).

A fast-path regex check (`/@layer\b/i`) skips the postcss round-trip entirely
when no `@layer` construct is present, so ordinary non-Tailwind CSS is
byte-for-byte unaffected (no formatting churn from an unnecessary
parse/serialize round-trip).

## Where flattening is NOT faithful to the browser cascade, and what I did

Flattening replaces layer PRIORITY (order established by first appearance —
independent of source position) with plain SOURCE order.

- **Faithful case (the common one, and the one this fix exists for):**
  Tailwind v4's canonical `@layer theme, base, components, utilities;`
  statement followed by blocks in that same sequence. Declared order already
  equals source order, so flattening reproduces the browser's cascade
  exactly.
- **NOT faithful:** a stylesheet that declares `@layer a, b, c;` and then
  writes the named blocks in a *different* order than declared. The browser
  cascades by the statement's declared order regardless of where the text
  sits; this flattening cascades by source position instead — a
  later-declared-but-earlier-written layer will win in the flattened import
  when the browser would have made it lose.

I did **not** silently accept that divergence. `unwrapCssLayers` compares the
declared statement order against the order named blocks first appear in
source and, when they disagree, pushes one new warning kind:
`layer-order-flattened` (added to `ImportWarningKind` in
`src/core/siteImport/cssImportTypes.ts`), naming both orders in the message.
Covered by a dedicated test (`a layer written out of its declared order gets
a layer-order-flattened warning...`) that asserts the warning fires and
mentions both layer names. When there is no explicit statement at all,
first-appearance order *is* source order by construction, so flattening is
always faithful and no warning is possible or needed — also covered by a
passing test with zero `layer-order-flattened` warnings for the canonical
case.

A parse failure inside the pre-pass (postcss chokes on the CSS) is also not
swallowed: it pushes an `invalid-rule` warning explicitly saying "@layer
content may be dropped" before falling back to the original text (which then
still goes through `replaceSync`'s own existing malformed-CSS handling).

## Consumer verified — this reaches a real Tailwind v4 project

`server/handlers/studioCss.ts:275` — `mergeParsedCss` — calls
`cssToStyleRules(cssText, { sheetConstructor: SheetCtor })` directly. Its own
module doc comment (lines 56–62) states this is the SAME call fed
`server/handlers/studio/styleCompile.ts`'s `CompiledStyles.css` — "Sass,
PostCSS/Tailwind output... already concatenated into one blob" — i.e. this
is the actual Studio project-CSS import path (not just the static-site
"Site Import" wizard's `siteImport` pipeline, which also calls the same
function via `src/core/siteImport/planCss.ts`/`cssImports.ts`). Since the fix
lives in the shared `cssToStyleRules` engine both paths call, a real Tailwind
v4 project's compiled CSS (wrapped in
`@layer theme, base, components, utilities { ... }`) now imports its rules
instead of zero. I did not edit `studioCss.ts` itself (owned by the B1
agent this cycle) — I verified the call site and its argument shape only.

I confirmed this end-to-end with a realistic sample in the test file (`a
realistic Tailwind v4 sample imports every rule, in source order, no
warnings`): a `@layer theme, base, components, utilities;` statement
followed by 4 named blocks (`theme`, `base`, `components`, `utilities`)
containing a `:root` custom property, an ambient `h1` rule, a `.btn` class,
and two utility classes — all 5 rules land, in exact source order
(`order: [0,1,2,3,4]`), with zero warnings.

## Second Tailwind blocker — NOT touched (per scope)

The Tier-0 trust-promotion gap (a fresh Tailwind import never auto-runs
compilation, so it still renders unstyled until trust is promoted) is a
human product decision and out of scope for this track. I did not build a
detection signal for it either — flagging the seam here per the work order:
a natural place for a "this project appears to use Tailwind and its CSS
hasn't been compiled" signal would be wherever `styleCompile.ts` decides
whether to run PostCSS/Tailwind (gated by trust tier) vs. read plain `.css`
files — that decision point already knows both facts (declared Tailwind
dependency + trust tier) and could surface a warning without auto-promoting
anything. Not built; noting the seam only, as instructed.

## Files changed

- `src/core/siteImport/cssToStyleRules.ts` — removed the local `truncate`
  helper and the (my own, first-draft) inline `unwrapCssLayers` +
  `splitLayerStatementNames`; now imports both from new leaf modules. Calls
  `unwrapCssLayers(cssText, warnings)` before `encodeSubstitutionDeclarations`
  + `replaceSync`. Updated the module doc comment ("@layer pre-pass" section)
  and the stale `default:` case comment that used to list `@layer` as
  "genuinely unsupported" (it's now flattened, never reaches that branch).
- `src/core/siteImport/unwrapCssLayers.ts` — **new**. The `@layer` pre-pass
  itself: `unwrapCssLayers` + `splitLayerStatementNames`, full doc comment
  (forms handled, cascade-order caveat). Exists as its own module because (a)
  it's a self-contained text→text transform independent of the CSSOM
  rule-walking `cssToStyleRules` does afterward, and (b) `cssToStyleRules.ts`
  was pushed to 827 lines (685 at HEAD + my +142) by the inline version,
  crossing the `module-size-budgets` gate's 700-line CEILING. Extracting this
  plus `truncate` brought it to **699 lines** — the split the coordinator
  asked for, not a line-shaving trick; `unwrapCssLayers.ts` now owns exactly
  one responsibility (the `@layer` flatten) and is independently unit-testable
  in isolation from CSSOM parsing.
- `src/core/siteImport/truncate.ts` — **new**. The 4-line `truncate` helper,
  extracted to its own leaf module because both `cssToStyleRules.ts` and
  `unwrapCssLayers.ts` need it and putting it in either one and importing it
  back from the other would be a needless same-folder circular dependency.
- `src/core/siteImport/cssImportTypes.ts` — added `layer-order-flattened` to
  `ImportWarningKind`; corrected the `dropped-at-rule` doc comment (no longer
  lists `@layer`, since it's flattened not dropped) and documented the new
  kind.
- `src/__tests__/siteImport/cssToStyleRules.test.ts` — new `describe`
  block "`cssToStyleRules — @layer flattening (not dropped)`": named block,
  anonymous block, bare statement (alone, produces 0 rules/0 warnings),
  nested `@layer`, `@layer` inside `@media`, `@media` inside `@layer`, a
  realistic Tailwind v4 sample (order-preservation assertion, not just
  count), the faithful-order case (no warning), and the out-of-order case
  (warning fires, names both layers).
- `docs/features/site-import.md` — updated the TL;DR bullet, the "CSS rule
  mapping" table, and the "Warning kinds" table: `@layer` is no longer listed
  as dropped; it's flattened, with the new `layer-order-flattened` kind
  documented alongside `dropped-at-rule`.

No changes to any file owned by a concurrent agent (`src/core/css-codemods/**`,
`server/handlers/studioCss*.ts`, `styleRuleWriteback.ts`,
`store/slices/styleRule/**`, `src/core/ast-codemods/**`,
`src/core/page-tree/sourceStructure.ts`, `src/core/page-parser/parsePageFile.ts`,
`src/modules/studio/slot/`, `src/admin/pages/site/canvas/**`,
`src/admin/pages/site/store/**`, `fsCodemodAdapter.ts`, `panels/DepsSection.tsx`,
`ModulePicker.tsx`, `registerProjectModules.ts`, `server/ai/**`). Confirmed via
`git status -sb` — my diff touches exactly the 4 modified files + 2 new files
listed above.

## Verification

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json     # clean, no errors
bun test src/__tests__/siteImport/                     # 269 pass / 0 fail
bun test src/__tests__/fonts/fontFaceImport.test.ts    # part of the above run, passes
bun test src/__tests__/canvas/styleRuleDarkModeRoundTrip.test.ts   # passes
bun test src/__tests__/admin/siteImport/               # 62 pass / 0 fail
bun test src/__tests__/architecture/module-size-budgets.test.ts   # my file no
  longer flagged; 3 pre-existing unrelated offenders remain
  (server/ai/handlers/chat.ts, server/handlers/studio.ts,
  server/handlers/studioWriteback.ts) — confirmed via `git status -sb` these
  are modified by other concurrent agents this cycle, not by me
bun test src/__tests__/architecture/no-core-barrel-deep-imports.test.ts
bun test src/__tests__/architecture/siteImport-headless.test.ts
```

All targeted suites green. Did NOT run `bun run build` / `bun run lint` per
instructions (concurrent siblings collide on `dist/`/`.tsbuildinfo`). Did NOT
run `npx tsc` (standing-08 — phantom errors against the wrong TS version).

Final line counts: `cssToStyleRules.ts` 699 (under the 700 ceiling — margin is
thin, worth knowing if the next change to this file adds anything of size),
`unwrapCssLayers.ts` 140, `truncate.ts` 14.

## Landmines / things the next agent should know

- The `layer-order-flattened` fidelity check only fires when the source has
  an explicit `@layer a, b, c;` **statement**. If a project uses `@layer`
  blocks with no such statement, first-appearance order is source order by
  definition, so it's always faithful — this is not a gap, it's provably
  correct for that case.
- The fidelity check does not model CSS's dotted nested-layer naming
  (`@layer a { @layer b {...} }` is technically layer `"a.b"` per spec, not
  two independent layers named `"a"` and `"b"`). This module treats nested
  layer names as flat/independent strings for the order check. This is a
  simplification, not a correctness bug in the *flattening* itself (the
  actual rule content is always spliced correctly regardless); it only means
  the order-mismatch *detector* could in theory miss or over-fire on an
  exotic nested-layer-name scenario. Given how rare authored (non-Tailwind)
  nested named layers are, I judged this an acceptable, documented
  simplification rather than a silent gap — flagging it explicitly here per
  the "say so" instruction.
- `unwrapCssLayers` only unwraps `@layer` — it doesn't touch any other at-rule.
  `@media`/`@supports`/`@container` continue to be handled entirely by the
  existing CSSOM-walking code in `cssToStyleRules.ts`, unchanged.
