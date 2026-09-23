# Track H — One token model (scanner + model half)

Stage: **done** (this pass's scope). Sidecar migration and full write-path
(T7) explicitly deferred — see "What remains" below.

## What landed

### 1. New shared model — `src/core/design-tokens/` (new module)

- `schemas.ts` — `DesignTokenFamilySchema`/`DesignTokenFamily` (9-way:
  `color | font-family | font-size | font-weight | line-height |
  letter-spacing | space | radius | elevation`), `DesignTokenOriginSchema`
  (`kind: project-css | vendor-css | tailwind-theme | scss-source | js-theme
  | studio-authored`, optional `file`/`line`), `DesignTokenSchema` (`name`
  — the project's REAL property name, never re-slugged — `family`, `value`,
  optional `darkValue`/`category`/`px`/`aliasOf`, `origin`), and
  `DesignTokenWriteTargetSchema` (`{file, selector} | null` — the "where
  would a NEW token land" answer, `null` meaning "nowhere, disable the
  create action and say why").
- `colorMath.ts` — **moved verbatim** from `server/handlers/studio/colorMath.ts`
  (deleted; no shim), **plus new `cssColorToRgb`** (hex + `rgb()`/`rgba()` +
  `hsl()`/`hsla()` → `Rgb`, used by T12's reconciliation) and **new
  `contrastLevel(ratio, isLargeText?)`** → `'AAA' | 'AA' | 'fail'` (WCAG
  4.5/7 normal, 3/4.5 large text) — this is the T9 fix.
- `index.ts` — barrel (`export * from './schemas'` / `'./colorMath'`), same
  shape as `@core/framework-schema`'s barrel.
- Consumers repointed: `server/handlers/studio/{qualityAudit,referenceMeasure,
  projectTokenIndex}.ts` now import `parseHexColor`/`colorDifference`/
  `contrastRatio`/`relativeLuminance`/`rgbToHex`/`cssColorToRgb`/
  `contrastLevel` from `@core/design-tokens`. **`contrastRatio` now has a
  real `src/` import** (`TokenizedColorField.tsx`) — it was zero before this
  (T9's "cheapest high-value fix," confirmed: `grep -rn "contrastRatio" src/`
  now hits `property-controls/TokenizedColorField.tsx`).
- Test moved+extended: `src/core/design-tokens/colorMath.test.ts` (was
  `server/handlers/studio/colorMath.test.ts`, deleted) + new coverage for
  `cssColorToRgb`/`contrastLevel`.

⚠️ **Not registered in `no-core-barrel-deep-imports.test.ts`** — that file
is under `src/__tests__/architecture/**`, explicitly off-limits this pass
(concurrent owner). `@core/design-tokens` follows the SAME convention
(`index.ts` barrel, internal relative imports, `export * from`) as the
already-gated modules, but the gate itself doesn't know about it yet.
**Whoever owns `src/__tests__/architecture/` next should add
`@core/design-tokens` to that test's list** — nothing outside
`src/core/design-tokens/` currently deep-imports into it (confirmed by
inspection: every consumer added this pass imports from the bare
`@core/design-tokens` specifier), so adding the gate should be a no-op
addition, not a migration.

### 2. Which of the seven models are now unified vs. still separate

| # | Model | Status after this pass |
|---|---|---|
| M1 `FrameworkSettings` | **Unchanged model**, still the picker's color source via `generateFrameworkColorVariableSets`. Phase 0.13's variant-disable fix (already landed before this pass, confirmed still in place) is now covered by a regression test (see `token-offered-is-reachable.test.ts` below). |
| M2 `ClassifiedTokens` | **Unchanged shape**, but the SCANNER behind it (`tokenExtractCssScan.ts`) gained `@theme` descent, a 9-way `classifyDesignTokenFamily` (additional, not a replacement — see below), non-16px `rem` support, and two new sources feed it (`tokenExtractScss.ts`, `tokenExtractJsTheme.ts`). |
| M3 `ProjectTokenIndex` | **Reconciled onto M2's engine (T12)** — `projectTokenIndex.ts` no longer carries its own regex scan/colour-parser/px-parser. It now calls `collectRootScopeMaps`/`resolveVarValue`/`toPx`/`detectRootFontSizePx` from `tokenExtractCssScan.ts` and `cssColorToRgb` from `@core/design-tokens`. `buildProjectTokenIndex`/`nearestSizeToken`'s public shape is UNCHANGED (all current callers, including MCP's `measureReference.ts`, keep working) — only the internals are now the same engine. |
| M4 `SiteFontsSettings` | **Untouched** — CMS-DB-backed font library, out of scope this pass (T1/T11 in the audit, blocked on the model unification this pass only partially advances — see "What remains"). |
| M5 design-import candidates | **Untouched wizard**, but its classification engine (`designImport/parseCssTokens.ts`) already shared `classifyDeclaration`/`resolveVarValue`/`collectRootScopeMaps`/`toPx` before this pass (infra-01) — unaffected by my changes since I didn't touch that file's own logic, only the shared engine it calls into (backward compatible signature). |
| M6 design-system digest | **Its own radius/elevation regexes DELETED**, now imports `RADIUS_NAME_HINT_RE`/`ELEVATION_NAME_HINT_RE` from `tokenExtractCssScan.ts` (promoted, not duplicated — see `designSystemDigest.ts` diff). One definition of "what counts as radius/elevation," shared by the digest and the new 9-way classifier. |
| M7 `StyleRule` registry | **Untouched** — still the only real write path, per B1/B1b having landed `insertRule`/co-located-stylesheet creation this session (owned by other agents, not this pass). |

**Net effect:** M3 is now built FROM M2's engine (T12 closed for scope, `var()`
depth, `rem`, colour syntax — dark values remain M2-only by design, see the
module doc's "Only LIGHT values are indexed" note: a static design reference
has no dark-mode concept to measure against). M1/M4/M5/M7 are still
independent models — the plan's own sequencing note (step 5, "`.studio/
tokens.json`; repoint picker, MCP tools, `projectTokenIndex`") is what fully
collapses M1 into the new `DesignToken` shape, and that step was explicitly
out of scope this pass.

### 3. T6 — discovery gaps closed

| Gap | Fix | File |
|---|---|---|
| Tailwind v4 `@theme { … }` invisible at Tier 0 | `@theme`/`@theme inline`/`@theme reference`/`@theme static` now collected DIRECTLY (its body has no nested selector, unlike `@layer`) — new branch in `collectScopedRules`, `AT_THEME_RE` | `tokenExtractCssScan.ts:280,326-333` |
| Tailwind v3 `theme.colors` REPLACE form dropped when the same config also has an unrelated `theme.extend` for another key | `readMergedThemeFamily` reads BOTH `theme.<key>` (with the `extend` sub-block's own text cut out first) and `theme.extend.<key>`, merging extend-wins-on-collision | `tokenExtractTailwind.ts` (`findBracedBlockSpan`, `readMergedThemeFamily`) |
| Tailwind `fontFamily` never read | Read via the same merged-family reader; counted into `typographyDetailCount` (no field for it in `ClassifiedTokens`/`FrameworkSettings` yet — honest count, not silence) | `tokenExtractTailwind.ts` |
| SCSS `$variables` (Tier 0, no compile) | New `extractScssVariableTokens`/`findScssFileCandidates` — top-level-only `$name: value;` scan, classified through the shared engine | `tokenExtractScss.ts` (new) |
| JS/TS theme objects in the OPEN project | New `extractJsThemeTokens`/`findJsThemeFileCandidates` — wires `designImport/parseCssTokens.ts`'s `extractJsTokens`/`extractJsonTokens` (previously wired ONLY to the external wizard) to a conventionally-named file (`theme`/`tokens`/`design-tokens`/`colors`/`palette`) in the currently open project | `tokenExtractJsTheme.ts` (new) |
| Non-16px root for `rem` | New `detectRootFontSizePx(css)` (reads an unconditional `html`/`:root { font-size }`, px or `%`); `toPx(value, rootFontSizePx = 16)` gained an optional second arg. Threaded through `classifyCssText` (its own detected root) and `projectTokenIndex.buildProjectTokenIndex` (first non-16 source wins) | `tokenExtractCssScan.ts:506-555`, `projectTokenIndex.ts` |
| radius/elevation (classifiers existed only in `designSystemDigest.ts`) | Promoted to `RADIUS_NAME_HINT_RE`/`ELEVATION_NAME_HINT_RE`, exported, reused by BOTH the digest and the new `classifyDesignTokenFamily` | `tokenExtractCssScan.ts:462-465`, `designSystemDigest.ts` |
| Function/spread-built Tailwind themes | **Still silently skipped**, unchanged, documented behaviour (`readShallowStringMap`'s doc) — genuinely out of reach for a non-executing text scanner; not attempted |
| CSS-in-JS themes | **Not built this pass** — `styleToolchainDetect.ts` still only DETECTS `cssInJs`; no extractor consumes it. Flagging as a real remaining gap, not silently dropped |
| Figma variables | **Not built this pass** — no code path; out of the plan's explicit scope for this track (T6's own gap table lists it but the "Proposed fix" paragraph doesn't schedule it in S/M effort — reasonably read as future work) |

`tokenExtract.ts`'s orchestrator now tries, in order: `project-css` →
`tailwind-theme` → `vendor-css` → `scss-vars` (new, gated on
`profile.styleToolchain.sass`) → `js-theme` (new, unconditional file-pattern
scan) → `none`. `TokenExtractionSource` union extended with `'scss-vars' |
'js-theme'`.

### 4. T12 — the two scanners now agree

`projectTokenIndex.ts` rewritten to consume `tokenExtractCssScan.ts`'s
`collectRootScopeMaps`/`resolveVarValue`/`toPx`/`detectRootFontSizePx`
instead of its own private `CUSTOM_PROPERTY_RE`/`VAR_ALIAS_RE`/`PX_VALUE_RE`.
Reconciled:
- **Scope** — now includes `@layer`/colour-scheme-`@media` descent (was
  `:root`-anywhere-in-text only).
- **`var()` depth** — now depth-8 cycle-safe (was one level).
- **`rem`/`em`** — now resolved (was refused outright).
- **Colour syntax** — now hex + `rgb()`/`hsl()` via `cssColorToRgb` (was
  hex-only via `parseHexColor`).
- **Dark values** — still M2-only, BY DESIGN (a static reference image has
  no dark-mode concept — see the module doc).
- **Font-size naming** — unchanged (`FONT_SIZE_NAME_RE`/
  `NON_TYPE_SIZE_NAME_RE` kept, since they're this module's own
  measurement-specific heuristic, not part of the scan/resolve engine being
  reconciled).

`rgbToHex`/`nearestSizeToken`/`ColorTokenEntry`/`SizeTokenEntry`/
`ProjectTokenIndex`/`buildProjectTokenIndex` — public shape UNCHANGED, so
`referenceMeasure.ts` (my file) and `measureReference.ts` (MCP, NOT touched —
off-limits) both compile and pass unmodified except the one import-path
line in `referenceMeasure.ts`.

Tests: `server/handlers/studio/projectTokenIndex.test.ts` — old "ignores
rem" test replaced with "resolves rem at the standard 16px root, agreeing
with the picker scan," plus new hsl()/rgb() and deep-var()-chain and
non-16px-root cases.

### 5. T9 — `contrastRatio` shareable + AA/AAA badge

- Moved to `@core/design-tokens` (see §1). Zero-to-nonzero `src/` import
  confirmed.
- `TokenizedColorField.tsx` (`src/admin/pages/site/property-controls/`):
  new optional `contrastAgainst?: string` prop. When supplied, renders a
  `colorContrastBadge` next to the current value AND next to every token
  option in the menu (`contrastBadgeFor`), computed via `cssColorToRgb` +
  `contrastRatio` + `contrastLevel`. Achromatic by default; `AA`/`AAA` render
  in `--success`, a failing ratio renders the bare ratio (`2.3:1`, never a
  false pass label) in `--danger` — colour as STATE, per the two-layer model.
  **`contrastAgainst` is additive-only and currently unwired from any real
  background** — threaded through `ColorValueInput.tsx` → `ColorControl.tsx`
  as an optional pass-through prop, but no caller supplies a value yet (no
  regression risk; every existing call site is unaffected). **Remaining
  work:** wiring a real resolved-background value from the style bag a node/
  class is being edited in (`StyleSectionsEditor`/`PropertiesPanel`, F1's
  territory this cycle) is the next step to make the badge actually appear
  in the running app.

### 6. T8 — the raw-hex escape hatch demoted

`TokenizedColorField.tsx`:
- The swatch is now a `Button` (`size="micro"`, `iconOnly`) that OPENS THE
  TOKEN MENU (`handleSwatchTriggerClick` → `setOpen`) — same target the text
  field already opens on focus.
- The native `<input type="color">` (`ColorInput`) is still rendered (a
  `ref` lets the app trigger the OS colour dialog programmatically) but is
  now visually hidden (`.hiddenColorInput`, `aria-hidden`, `tabIndex={-1}`)
  and reachable ONLY via a new **"Custom color…"** row at the bottom of the
  token menu (`openCustomColorPicker` → `hiddenColorInputRef.current?.click()`).
  A raw hex is still reachable in one extra click — it is simply never
  accidental.
- `ColorInput.tsx` itself (the shared `src/ui/` primitive) is **UNCHANGED** —
  it's still the correct control for its OTHER call sites (`ColorsPanel`'s
  `ColorTokenCard`/`ColorVariantPreview`, `ParamRow.tsx`), where editing the
  raw base value IS the intended interaction (there's no token concept to
  detach from).

Tests: `src/__tests__/admin/propertyControls/tokenizedColorField.test.tsx`
(new) — swatch opens the listbox (not a native dialog), the native input is
tab-unreachable and only revealed by "Custom color…", and the AA/AAA badge
renders/doesn't render/shows a bare ratio on fail.

### 7. Reachability gate — `token-offered-is-reachable.test.ts`

`src/__tests__/studio/token-offered-is-reachable.test.ts` (new — **not** under
`src/__tests__/architecture/`, which is off-limits this pass; whoever owns
that folder next should consider promoting this into it). Exercises the REAL
production pipeline (`classifyCssText` → `buildFrameworkSettings` →
`generateFrameworkColorVariableSets`, exactly what `tokenExtract.ts` and
`TokenizedColorField` actually call) and asserts every colour variable name
the picker would offer for an EXTRACTED token exists verbatim as a declared
custom property in the source CSS. Also pins the Phase-0.13 regression
directly: `generateTransparent`/`generateShades.enabled`/
`generateTints.enabled` must be `false` for every extracted token.
**Scope: colours only** — spacing/typography steps are Studio's OWN
generated scale (always re-emitted regardless of provenance), which is
exactly the T4 defect below, not a colour-picker regression this test can
catch.

## T4 — the precise fix, for the canvas owner (NOT built this pass)

**Do not build this — `src/admin/pages/site/canvas/**` is owned by a D2
agent this cycle.** Specifying exactly what to do:

**Symptom:** `ClassStyleInjector.tsx:175` (module doc, "`@layer
user-authored` fonts + framework root CSS + the class registry") injects
`generateFrameworkRootCss`'s output into the SAME cascade layer
(`user-authored`) that `UserStylesheetInjector.tsx:90` injects the project's
own CSS into. For an EXTRACTED colour token, the framework re-emits
`--color-aqua-100` a second time (HSLA-normalized —
`src/core/framework/colors.ts:356-359`), and within-layer order (document
order of the two `<style>` elements) decides which one wins. The canvas can
therefore render `hsla(187,88%,37%,1)` where the real app renders
`#0c9ab0` — visually close, but a real divergence, and `oklch()`/
`color-mix()` values fall back to the RAW string unconverted (silently
wrong when interpreted as HSLA-family syntax downstream).

**Fix, precisely:**
1. `FrameworkColorToken` needs an `origin` marker distinguishing
   `'project-css' | 'vendor-css' | 'tailwind-theme' | 'scss-source' |
   'js-theme'` (extracted — the token ALREADY exists in a stylesheet the
   canvas loads) from `'studio-authored'` (created via the Colors panel —
   nothing else declares this name). The cleanest source for this value:
   `tokenExtract.ts`'s `TokenExtractionResult.source` is already computed
   per-EXTRACTION-RUN (not per-token) — the simplest correct change is to
   stamp this source onto each `FrameworkColorToken` in
   `tokenExtractBuild.ts`'s `buildColorTokens` (a new field, additive,
   TypeBox schema change in `@core/framework-schema` — additive optional
   field, no migration needed since this is client-JSON, not DB schema).
2. `canvasClassCss.ts`'s call into `generateFrameworkRootCss` (or
   `generateFrameworkRootCss` itself, `src/core/framework/colors.ts`) must
   FILTER to `origin === 'studio-authored' || origin === undefined`
   (backward-compatible: an old project file predating this field defaults
   to re-emitting, same as today, until the next `POST /admin/api/studio/
   tokens` re-extraction stamps it) before generating the `:root` block.
3. This closes T4 for COLOURS. Spacing/typography groups
   (`FrameworkSpacingGroup`/`FrameworkTypographyGroup`) have the identical
   defect but no `origin` field at all today — `tokenExtractBuild.ts`'s
   `buildSpacingGroups`/`buildTypographyGroups` would need the same
   stamping, and `generateFrameworkRootCss`'s spacing/typography emission
   (also in `colors.ts` — check for a sibling `generateFrameworkSpacingCss`/
   `generateFrameworkTypographyCss`, not audited this pass) the same filter.
   **I did not audit the spacing/typography CSS-generation call sites** —
   the canvas owner should locate them before assuming symmetry with the
   colour path.
4. T5 (dark values landing on `.theme-alt`, a dead CMS selector, instead of
   `data-studio-scheme`) is the same file family (`colors.ts:482-491`
   `ALT_THEME_SELECTOR`) and the plan explicitly says "do it with T4" — same
   canvas owner, same change window, since fixing T4 without T5 leaves an
   extracted token's (now correctly non-re-emitted) LIGHT value with no dark
   companion, while a studio-authored token's dark value still targets a
   selector nothing sets.

## What remains for the `.studio/tokens.json` sidecar migration

**Not attempted this pass, per the work order.** What's needed for a future
pass, concretely:

1. **A real `ProjectTokenSet` builder** — `src/core/design-tokens/schemas.ts`
   defines the SHAPE (`DesignTokenSchema`, `DesignTokenWriteTargetSchema`)
   but there is no function that walks a project (CSS + Tailwind + SCSS +
   JS-theme, all four sources this pass wired) and emits `DesignToken[]`
   directly — today those four sources still produce the LEGACY
   `ClassifiedTokens` shape (colors/spacing/typographySizes/counts), which
   `tokenExtractBuild.ts` turns into `FrameworkSettings`. A `DesignToken[]`
   builder would sit where `tokenExtractBuild.ts` sits today, consuming the
   SAME four sources' raw scan output (not `ClassifiedTokens` — that shape
   already lost the `family`/`origin.file`/`px`/`aliasOf` richness a
   `DesignToken` needs) but is a genuinely new function, not a refactor of
   an existing one.
2. **`.studio/tokens.json` read/write** — mirror `studioFramework.ts`'s
   `readStudioFrameworkFile`/`writeStudioFrameworkFile` pair, TypeBox-
   validated against `DesignTokenSchema[]` (or a `ProjectTokenSet` wrapper).
   Needs the SAME "never clobber" merge rule `tokenExtract.ts`'s
   `mergeExtractedFramework` implements today, but keyed by `origin.kind`
   (never re-classify/overwrite a `studio-authored` entry) rather than by
   whole-family emptiness.
3. **Repoint every M1 consumer** — `TokenizedColorField.tsx` (currently
   `generateFrameworkColorVariableSets(colorSettings)`),
   `frameworkTokenTools.ts` (MCP `studio_list_tokens`), `ColorsPanel/*`,
   `InspectPanel.tsx`. This is the single largest remaining piece of work in
   this whole track — it touches the live picker UI end to end and needs
   its own work order (per CLAUDE.md, "no old-and-new side by side" — once
   `tokens.json` exists, `framework.json`'s COLOR half should be deleted,
   not kept as a second path).
4. **`DesignTokenWriteTarget` resolution** — deciding, for a real project,
   which file+selector a NEW token should land in (`.studio/meta.json`
   naming one writable stylesheet, per the original audit's T7 proposal).
   Not started; the schema has the SHAPE (`{file, selector} | null`) but no
   resolver.
5. **Migration of `M4` (fonts)** — genuinely a separate, larger piece (T1/T2/
   T11 in the original audit) that depends on this sidecar existing first.
   Not attempted; `src/core/fonts/**`/`TypographyPanel/FontsSection/**`
   remain CMS-era and untouched.

This is consciously scoped as "the model and the scanner exist; the
persisted sidecar and the picker's live rewiring are a separate work order"
— exactly the boundary the task description drew.

## Files changed

**New:**
- `src/core/design-tokens/{schemas.ts,colorMath.ts,colorMath.test.ts,index.ts}`
- `server/handlers/studio/tokenExtractScss.ts` + `__tests__/tokenExtractScss.test.ts`
- `server/handlers/studio/tokenExtractJsTheme.ts` + `__tests__/tokenExtractJsTheme.test.ts`
- `server/handlers/studio/__tests__/tokenExtractTailwind.test.ts`
- `src/__tests__/studio/token-offered-is-reachable.test.ts`
- `src/__tests__/admin/propertyControls/tokenizedColorField.test.tsx`

**Deleted:**
- `server/handlers/studio/colorMath.ts`, `server/handlers/studio/colorMath.test.ts`
  (moved to `src/core/design-tokens/`, not shimmed)

**Modified:**
- `server/handlers/studio/{projectTokenIndex.ts,projectTokenIndex.test.ts,
  tokenExtractCssScan.ts,tokenExtractTailwind.ts,tokenExtract.ts,
  designSystemDigest.ts,qualityAudit.ts,referenceMeasure.ts}`
- `server/handlers/studio/__tests__/tokenExtractCssScan.test.ts`
- `src/admin/pages/site/property-controls/{TokenizedColorField.tsx,
  ColorValueInput.tsx,ColorControl.tsx,controls.module.css}`

**Not touched** (confirmed via `git diff --stat` before/after each session
resume): `src/core/framework/**`, `src/core/framework-schema/**` (read only,
imported not modified — `FrameworkColorToken`/`FrameworkSettings` types
unchanged), `src/admin/pages/site/canvas/**`, `src/core/ast-codemods/**`,
`server/handlers/studioEditSchemas.ts`, `server/handlers/studioWriteback.ts`,
`src/core/css-codemods/**`, `styleRuleWriteback.ts`,
`server/handlers/studioCss*.ts`, `src/admin/pages/site/panels/
PropertiesPanel/**`, `InspectPanel/**`, `uiStateActions.ts`,
`src/core/page-tree/**`, `keybindings.ts`, `src/__tests__/architecture/**`,
`server/ai/**` (except reading, never editing, `measureReference.ts`'s
import of `projectTokenIndex.ts`'s unchanged public API).

## Verification

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.json
# clean, zero errors — run repeatedly through the session, always clean

./node_modules/.bin/eslint <every file listed above>
# clean, zero errors/warnings

bun test server/handlers/studio/ server/handlers/designImport/ \
  src/core/design-tokens/ src/__tests__/studio/ \
  src/__tests__/admin/propertyControls/ src/__tests__/framework/
# 460 pass / 7 fail / 1 error — all 7 failures + the 1 error are PRE-EXISTING
# Windows-environment failures outside my diff (path-separator assertions in
# projectGuide.test.ts/projectSeed.test.ts, a genuinely missing sibling
# module in projectMcpApprovals.test.ts, network-mock plumbing in
# remoteAssetFetch.test.ts, an SVG-reference rejection in
# turnDesignReferences.test.ts) — confirmed via `git diff --stat` these
# files are not mine; matches STATE.md's standing-01 baseline note.

bun test src/__tests__/architecture/module-size-budgets.test.ts \
  src/__tests__/architecture/no-core-barrel-deep-imports.test.ts \
  src/__tests__/architecture/css-token-policy.test.ts \
  src/__tests__/architecture/no-css-var-fallbacks.test.ts \
  src/__tests__/architecture/button-primitive-usage.test.ts
# all pass — confirms the new module/CSS/control changes don't drift any
# existing gate (read-only run; did not edit any architecture test)
```

Did NOT run `bun run build`/`bun run lint`/`npx tsc` per instructions.

## Landmines / things the next agent should know

- **`toPx`'s signature gained an optional second parameter**
  (`rootFontSizePx = 16`). Every existing single-argument call site is
  unaffected (default unchanged), but `designImport/parseCssTokens.ts`'s
  own `toPx` calls were deliberately left un-threaded with a detected root
  size (that wizard imports EXTERNAL files where "the project's own root
  font-size" isn't a coherent concept the way it is for the currently open
  project) — this is intentional, not an oversight.
- **`classifyDeclaration` (5-way, legacy) was deliberately left BYTE-FOR-BYTE
  unchanged.** I added `classifyDesignTokenFamily` (9-way) as a SEPARATE,
  additional function rather than reshaping the legacy one, specifically
  because `FrameworkSettings`'s existing spacing group already depends on
  `--radius-*` landing in `'spacing'` (via `SPACING_NAME_HINT_RE`'s literal
  "radius" substring) — changing that would silently reshuffle a persisted
  scale group for every project that already ran extraction. If a future
  pass migrates `FrameworkSettings` itself onto `DesignToken`, this
  divergence disappears along with `classifyDeclaration`'s own callers.
- **The AA/AAA contrast badge has no live caller yet** (see T9 above) — it
  is fully built and tested, but `contrastAgainst` is threaded only as far
  as `ColorControl.tsx`, and nothing currently constructs a resolved
  background value to pass it. Building that is real work (reading the
  style bag a node/class panel already has), explicitly deferred to avoid
  colliding with F1's in-flight `PropertiesPanel`/value-provenance rework.
- **`findJsThemeFileCandidates`'s filename allowlist is deliberately narrow**
  (`theme|tokens|design-tokens|designtokens|colors|palette`, exact
  basename match). A project whose token file is named something else
  (`brand.ts`, `styles/config.ts`) will not be found. Documented as a
  deliberate scope boundary in the module doc, not a bug — a broader scan
  would risk false-positive "theme" hits on ordinary application code.
- **SCSS `$variable` extraction is TOP-LEVEL ONLY** (brace-depth 0) — a
  design system that computes its scale via `@each`/`@function` (common in
  larger Sass systems) will not be discovered. This matches the same
  "silently skip what can't be read without executing code" posture
  `tokenExtractTailwind.ts` already documents for function/spread-built
  Tailwind themes.
- **`.scss`-only, not `.sass` indented syntax** — `findScssFileCandidates`
  filters strictly on the `.scss` extension. Real-world `.sass` (indented,
  no braces) usage is rare enough that I judged this an acceptable,
  documented gap rather than building a second brace-free scanner.
- **No integration test for `tokenExtract.ts`'s full orchestrator** (the
  `extractProjectTokens` function itself, exercising all six sources
  end-to-end against a real temp project directory via
  `compileProjectStyles`). Each new source (`tokenExtractScss.ts`,
  `tokenExtractJsTheme.ts`) has its own focused unit tests, and the
  wiring itself typechecks and the existing `tokenExtractCssScan`/
  `tokenExtractTailwind`/`designImport` suites all still pass, but nobody
  has exercised "open a project with only a `theme.ts`, extract, get a
  real `FrameworkSettings` back" end-to-end. Worth adding if a future pass
  touches this file again.
- **Windows path separators**: `findJsThemeFileCandidates`/
  `findScssFileCandidates` return `listWorkspaceFiles`'s POSIX-separated
  relative paths (confirmed by that module's own doc comment — "as a
  POSIX-separated path relative to `dir`"); my `join(dir, ...relPath.split('/'))`
  calls convert them back to platform paths before reading, mirroring the
  existing pattern in `tokenExtract.ts`'s Tailwind-config read. Tests for
  both new modules pass on this Windows dev box, so this conversion is
  confirmed working, not just assumed.
