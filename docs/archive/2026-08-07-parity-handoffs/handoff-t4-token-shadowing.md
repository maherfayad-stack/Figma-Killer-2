# T4 — framework no longer shadows the project's own tokens + reachability gate promoted

Stage: **done**, both tasks in scope. `canvas-engineer` pass (canvas +
`src/core/framework/**` emission change + `src/__tests__/architecture/**`).

## Task 1 — T4 fix

### What Studio now injects vs. what it no longer echoes

**Before:** `canvasClassCss.ts`'s `buildCanvasClassCSS` called
`generateFrameworkRootCss({ colors: frameworkColors, ... })` with the RAW,
unfiltered `FrameworkColorSettings` — every color token, extracted or
studio-authored, got a `:root { --<slug>: <HSLA-normalized value>; }`
declaration injected by `ClassStyleInjector` into `@layer user-authored`,
the SAME layer `UserStylesheetInjector` injects the project's own real CSS
into. For an EXTRACTED token (read out of the project's own CSS/Tailwind
theme/Sass/JS-theme by `tokenExtractBuild.ts`), that meant the SAME custom
property was declared twice in the canvas document — once by the real
project file, once by Studio's own HSLA-renormalized copy — with the winner
decided by injector mount order, not by anything meaningful.

**After:**
- `FrameworkColorToken` gained an optional `origin` field
  (`src/core/framework-schema/schemas.ts`): `'project-css' | 'tailwind-theme'
  | 'vendor-css' | 'scss-vars' | 'js-theme' | 'studio-authored'`, undefaulted
  (`Type.Optional`, no `withFallback`) so legacy persisted data reads as
  `undefined`.
- `tokenExtractBuild.ts`'s `buildColorTokens` now takes an
  `origin: ExtractedColorOrigin` parameter and stamps it onto every token it
  builds — the value comes straight from `tokenExtract.ts`'s existing
  per-run `TokenExtractionSource` (`'project-css' | 'tailwind-theme' |
  'vendor-css' | 'scss-vars' | 'js-theme'`, i.e. `TokenExtractionSource`
  minus `'none'` — `'none'` never reaches `buildColorTokens` with a
  non-empty `colors` array, since `hasAnyTokens` gates it). `
  buildFrameworkSettings(tokens, origin)` is now a 2-arg function; its one
  real caller (`tokenExtract.ts`) passes `source === 'none' ? 'project-css'
  : source` — a type-satisfying placeholder never actually read in that
  branch, since `tokens.colors` is guaranteed empty when `source === 'none'`.
- New exported helper `filterReemittableColorTokens(settings)` in
  `src/core/framework/colors.ts` (barrel-exported from `@core/framework`):
  drops every token whose `origin` is a real extraction source, keeps
  `undefined` (legacy data — same behaviour as before this field existed)
  and `'studio-authored'`.
- `canvasClassCss.ts`'s `buildCanvasClassCSS` calls
  `filterReemittableColorTokens(frameworkColors)` before handing colors to
  `generateFrameworkRootCss` — **canvas-only**, not applied inside
  `generateFrameworkRootCss`/`buildFrameworkPlan` themselves, so the
  publisher's `framework.css` (`src/core/publisher/frameworkCss.ts`) and the
  AI-agent-facing `describeFrameworkTokens` (`src/core/framework/describe.ts`)
  are byte-for-byte unchanged. Utility classes
  (`generateFrameworkColorUtilityClasses` → `reconcileFrameworkClasses`,
  materialized into `site.styleRules`) are **also unaffected** — a locked
  `.text-<slug> { color: var(--<slug>) }` rule still gets generated for
  every token regardless of origin; only the SECOND `:root` declaration is
  suppressed, and the variable still resolves because the project's own
  stylesheet (loaded by `UserStylesheetInjector`/`ProjectCssInjector`)
  supplies it.
- New/cloned tokens created in the Colors panel
  (`src/admin/pages/site/store/slices/site/framework/colors.ts`) are stamped
  `origin: 'studio-authored'` — including clones, which mint a brand-new
  `-copy` slug that (unlike the source token's) does NOT exist in the
  project's real CSS, so a clone must re-emit even when its source didn't.
- **Adjacent correctness fix found while implementing, not in Track H's
  spec but a direct consequence of the new field:**
  `src/admin/pages/site/store/slices/site/importedColorTokens.ts`
  (`addImportedColorTokens`/`overwriteImportedColorTokens` — the "Super
  Import" site-import color-token path, `commitPlan.ts` → `addColorTokens`/
  `overwriteColorTokens` store actions) leaves `origin` unset on add
  (correct — an externally-imported-site token has no declaration anywhere
  in the CURRENT project, so `undefined`'s "still re-emit" treatment is
  exactly right) and **explicitly clears `origin` to `undefined` on
  overwrite** — if the token being overwritten had previously been
  `origin: 'project-css'` (a slug collision between a `tokenExtractBuild.ts`
  extraction and a site-import conflict-resolution overwrite), leaving the
  stale origin would have silently suppressed re-emission of the just
  -imported value, showing the OLD real-project value instead of the
  user's overwrite.

**What's deliberately NOT done** (matches Track H's own scoping, item 3 of
"the precise fix"): spacing/typography groups
(`FrameworkSpacingGroup`/`FrameworkTypographyGroup`) have the identical
defect shape but no `origin` field and no filter — `tokenExtractBuild.ts`'s
`buildSpacingGroups`/`buildTypographyGroups` don't stamp provenance, and
`generateFrameworkRootCss`'s spacing/typography emission
(`generateFrameworkSpacingVariables`/`generateFrameworkTypographyVariables`,
`src/core/framework/{spacing,typography}.ts`) is unfiltered. I did not audit
those call sites for symmetry with the color path — the promoted gate's doc
(and its own module doc) says this explicitly ("Scope: colours only"). This
remains open work for whoever picks up spacing/typography T4 parity.

### Known interaction NOT fixed this pass (documented, not silently left)

Editing an EXTRACTED token's `slug` in the Colors panel
(`ColorTokenEditor.tsx`, freely editable for any token) does **not** flip
`origin` to `studio-authored`. Before this fix, renaming an extracted
token's slug always worked on canvas (every token was always re-emitted, so
the renamed `--<new-slug>` always got declared). After this fix, renaming
an extracted token's slug leaves `origin` still pointing at the original
extraction source, so `filterReemittableColorTokens` now suppresses
re-emission of the RENAMED name too — the renamed variable resolves to
nothing on canvas (there's no write-back to the real CSS file yet, T7,
still unbuilt) until the token's origin is otherwise reset. Editing
`lightValue`/`darkValue` (not slug) of an extracted token is, by contrast,
now CORRECTLY inert on canvas — per the thesis ("the repository is the
document"), an unwritten-back value edit should have no visible effect
until it's actually written to the file, which is exactly what suppressing
re-emission achieves; this was previously a genuine "canvas is lying"
defect (a picker edit rendered on canvas with no basis in the real file)
that this fix incidentally also closes. The SLUG-rename case is the one
asymmetric gap — flagged here as a landmine, not fixed (out of Track H's
specified scope; would need `applyFrameworkColorTokenPatch` to flip origin
on a slug patch, a design decision Track H's handoff didn't make).

### Verification — both directions

New tests, all pass:
- `src/__tests__/framework/colors.test.ts` — `filterReemittableColorTokens`
  describe block: drops `origin: 'project-css'`, keeps
  `origin: 'studio-authored'`, keeps `origin: undefined` (legacy), and an
  end-to-end `generateFrameworkRootCss` assertion that an extracted token's
  `--aqua:` never appears while a studio-authored `--brand:` does. Plus a
  null/undefined passthrough case.
- `src/__tests__/canvas/classStyleInjector.test.ts` — new test: an
  `origin: 'project-css'` token's `:root` declaration (`--aqua:`) is absent
  from `generateCanvasClassCSS`'s output, while its locked utility class
  (`.text-aqua { color: var(--aqua) }`) is still present.
- `src/admin/pages/site/store/slices/site/importedColorTokens.test.ts` — new
  tests for the add/overwrite origin semantics above.
- `src/__tests__/architecture/token-offered-is-reachable.test.ts` (promoted,
  see Task 2) — new 4th test: every token `buildFrameworkSettings` produces
  from `REALISTIC_PROJECT_CSS` is stamped `origin: 'project-css'`, never
  `'studio-authored'`.

## Task 2 — reachability gate promoted

- Moved `src/__tests__/studio/token-offered-is-reachable.test.ts` →
  `src/__tests__/architecture/token-offered-is-reachable.test.ts`. Relative
  import depth to `server/handlers/studio/*` (`../../../server/...`) is
  IDENTICAL from both locations (same nesting depth under `src/__tests__/`),
  so no path rewriting was needed — only the `buildFrameworkSettings(classified)`
  call sites needed updating to `buildFrameworkSettings(classified,
  'project-css')` for the new required `origin` parameter, and a 4th test
  (above) was added for the T4 half of the invariant.
- This gate does no filesystem/directory scanning (pure fixture-driven CSS
  string pipeline test) — `toPosixPath()` from `pathHelpers.ts` doesn't
  apply to it; confirmed by inspection, not assumption.
- **Proof of failure** — introduced a token that's offered but unreachable
  by temporarily reverting `tokenExtractBuild.ts`'s
  `generateTransparent: false` back to `generateTransparent: true` (the
  literal Phase-0.13 regression this gate exists to catch: an extracted
  token generating derived variant names — `--aqua-100-20`, etc. — that
  don't exist in the source CSS):
  ```
  bun test src/__tests__/architecture/token-offered-is-reachable.test.ts
  # 1 pass / 3 fail — the 3 "reachability" tests all go red:
  #   expect(declared.has(variable.name)).toBe(true)  →  Received: false
  #   expect(token.generateTransparent).toBe(false)    →  Received: true
  ```
  Reverted immediately after confirming; re-ran to confirm back to
  `4 pass / 0 fail`.
- **Bonus, low-risk, explicitly requested by Track H's own handoff** (§1,
  "not registered in `no-core-barrel-deep-imports.test.ts`... whoever owns
  `src/__tests__/architecture/` next should add `@core/design-tokens`"):
  added `'design-tokens'` to `BARRELLED_MODULES` in
  `no-core-barrel-deep-imports.test.ts`. Confirmed no-op (still `1 pass / 0
  fail`) — no file outside `src/core/design-tokens/` currently deep-imports
  into it, exactly as Track H predicted.

## Files touched

- `src/core/framework-schema/schemas.ts` — `FrameworkColorTokenOrigin`
  schema/type, `origin` field on `FrameworkColorTokenSchema` (optional,
  undefaulted).
- `src/core/framework/colors.ts` — `filterReemittableColorTokens` (new,
  exported, barrel-picked-up via `export * from './colors'`).
- `src/admin/pages/site/canvas/canvasClassCss.ts` — filters
  `frameworkColors` before `generateFrameworkRootCss` in
  `buildCanvasClassCSS`.
- `src/admin/pages/site/store/slices/site/framework/colors.ts` — stamps
  `origin: 'studio-authored'` on `createFrameworkColorTokenFromInput` and
  `cloneFrameworkColorToken`.
- `src/admin/pages/site/store/slices/site/importedColorTokens.ts` — doc
  comment on `addImportedColorTokens` (why `origin` stays unset) +
  `overwriteImportedColorTokens` now clears `existing.origin = undefined`.
- `server/handlers/studio/tokenExtractBuild.ts` — `ExtractedColorOrigin`
  type, `buildColorTokens(colors, origin)`, `buildFrameworkSettings(tokens,
  origin)`.
- `server/handlers/studio/tokenExtract.ts` — passes the extraction
  `source` (mapped) into `buildFrameworkSettings`.
- `src/__tests__/architecture/token-offered-is-reachable.test.ts` — moved
  from `src/__tests__/studio/`, updated call sites, added the T4 origin
  assertion.
- `src/__tests__/architecture/no-core-barrel-deep-imports.test.ts` —
  registered `@core/design-tokens`.
- `src/__tests__/framework/colors.test.ts` — new
  `filterReemittableColorTokens` describe block.
- `src/__tests__/canvas/classStyleInjector.test.ts` — new T4 regression
  test.
- `src/admin/pages/site/store/slices/site/importedColorTokens.test.ts` —
  new origin-semantics tests for add/overwrite.

**Not touched:** `src/admin/pages/site/panels/PropertiesPanel/**`,
`InspectPanel/**`, `usePropertiesPanelData.ts`, `cssControlTypes.ts`,
`uiStateActions.ts`, `editConstraint.ts`, `nodeResolution.ts`,
`propLockReason.ts`, notice components, `src/core/ast-codemods/**`,
`server/handlers/studioSlotWriteback.ts`, `TokenizedColorField.tsx` (all
per ownership boundaries). `src/core/framework/{spacing,typography}.ts`
and their `generateFramework*Variables` (spacing/typography T4 parity is
explicitly out of scope, see above).

## Verification run

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.json
# clean, zero errors

./node_modules/.bin/eslint <every file listed above>
# clean, zero errors/warnings

bun test src/__tests__/architecture/token-offered-is-reachable.test.ts \
  src/__tests__/architecture/no-core-barrel-deep-imports.test.ts \
  src/__tests__/architecture/module-size-budgets.test.ts \
  src/__tests__/framework/colors.test.ts src/__tests__/framework/generate.test.ts \
  src/__tests__/canvas/classStyleInjector.test.ts \
  src/__tests__/canvas/userStylesheetInjectorRenderScope.test.tsx \
  src/admin/pages/site/store/slices/site/importedColorTokens.test.ts \
  src/__tests__/editor-store/frameworkColors.test.ts \
  src/__tests__/panels/colorsPanel.test.tsx src/__tests__/panels/frameworkChangeConfirmDialog.test.tsx \
  src/__tests__/persistence.test.ts src/__tests__/admin/propertyControls/tokenizedColorField.test.tsx \
  src/__tests__/publisher/render.test.ts src/__tests__/server/siteCssBundle.test.ts
# 190 pass / 0 fail — includes C3's userStylesheetInjectorRenderScope render-
# count regression tests, still green (I did not touch UserStylesheetInjector.tsx
# — that file's diff in the working tree is from D2/D3, not this pass)

bun test server/handlers/studio/
# 320 pass / 7 fail / 1 error — the 7 failures + 1 error are the SAME
# pre-existing Windows-environment failures Track H's own handoff already
# documented (path-separator assertions in projectGuide.test.ts/
# projectSeed.test.ts, a missing sibling module in
# projectMcpApprovals.test.ts, network-mock plumbing in
# remoteAssetFetch.test.ts, an SVG-reference rejection in
# turnDesignReferences.test.ts) — confirmed via `git diff --stat` none of
# those 5 files are in my diff.

bun test src/__tests__/canvas src/__tests__/framework <+ everything above>
# 703 pass / 6 fail — the 6 failures are in canvasFrameMounting.test.tsx,
# canvasFormControls.test.tsx, boardFrameVariantSelection.test.tsx (iframe
# mounting/pointer-capture/selection-ring tests, 5000ms timeouts). Confirmed
# via `git diff --stat -- <those 3 files>` — EMPTY diff, they are not mine.
# Their failures trace to the concurrent D2/D3 canvas dnd track's changes
# already sitting in the shared working tree (BoardFramesLayer.tsx alone
# shows -446 lines in the tree right now) — unrelated to token/CSS
# generation, not touched or caused by this pass.
```

Did NOT run `bun run build`/`bun run lint`/`npx tsc` per instructions (they
collide with sibling agents' `dist/`/`.tsbuildinfo`).

## What the human must dogfood

Route: `/admin/site?studio`, open a project that has real CSS custom
properties in its `:root` (any project that already went through Studio's
token auto-extraction — check the Colors panel has entries with a name
that matches something in the project's own `.css`/`globals.css`).

1. Open DevTools on the canvas iframe (right-click a design frame →
   Inspect, or use the browser's iframe picker) and look at
   `<style id="mc-classes">`'s content. For an extracted color token (one
   whose name you can find verbatim in the project's own CSS file), the
   `:root { }` block inside `@layer user-authored` should **no longer**
   contain a `--<that-name>:` declaration. `<style id="mc-user-styles">`
   (also `@layer user-authored`, mounted right after `mc-classes`) should
   still contain the real one, unchanged.
2. Pick that token's swatch in `TokenizedColorField` on an element that uses
   it (e.g. a `.text-<slug>`/`.bg-<slug>` utility, or an inline style bound
   to `var(--<slug>)`) — the element should render the SAME color it does
   in a real build of the project (no HSLA-normalization drift, no
   `oklch()`/`color-mix()` values silently reinterpreted as HSLA).
3. Zoom level and frame count don't matter for this check — it's a
   `<style>`-tag-content inspection, not a layout/visual regression. Any
   single design frame at any zoom is sufficient.
4. Separately: create a NEW color token from the Colors panel ("+ Add
   token"), give it a value, and confirm it DOES still show up as a
   `--<slug>:` declaration in `mc-classes`'s `:root` block and renders
   correctly — this exercises the "studio-authored, still re-emitted" path.
