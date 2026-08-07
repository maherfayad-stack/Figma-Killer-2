# Audit 11 — Colors & Fonts: the design-token experience

Read-only audit. Repo: `c:\Users\Admin\Documents\GitHub\Figma Killer 2`, branch `feat/alm-figma-killer-studio-shell`.
Scope: how easy is it to assign a colour or a font to an element on the Studio canvas.

**One-line verdict.** Colours *almost* work — the project's real `:root` custom properties do reach
the picker, but the picker offers ~19× more names than exist and the write target can only edit a
declaration that already exists. **Fonts do not work at all in Studio**: the only font picker in the
inspector reads `site.settings.fonts`, which Studio never populates (`DEFAULT_SITE_SETTINGS` has no
`fonts` key), so the menu shows exactly one option — "Inherit".

---

## 1. TOKEN MODEL MAP

Seven distinct token models live in this repo. Five of them describe *the same project's colours*.

| # | Model | Shape / storage | Producer | Consumers | Reaches the canvas? | Reaches the user's repo? |
|---|---|---|---|---|---|---|
| **M1** | **`FrameworkSettings`** — Studio's own token store | `FrameworkColorToken` (`slug`, `lightValue`, `darkValue`, `generateShades/Tints/Transparent`), `FrameworkTypographyGroup`/`FrameworkSpacingGroup` (fluid *size* ladders). Persisted at `<project>/.studio/framework.json` | `tokenExtractBuild.ts:168 buildFrameworkSettings`; hand edits in ColorsPanel/TypographyPanel/SpacingPanel | `TokenizedColorField.tsx:57`, `InspectPanel.tsx:55`, `ColorsPanel/*`, `tokenUtils.ts:86-101`, `canvasClassCss.ts:48`, `frameworkTokenTools.ts` (MCP `studio_list_tokens`) | **Yes** — `generateFrameworkRootCss` → `@layer user-authored` (`ClassStyleInjector.tsx:184`) | **No.** Nothing ever writes framework CSS into the project |
| **M2** | **`ClassifiedTokens`** — the extraction intermediate | `{colors[], spacing[], typographySizes[], typographyDetailCount, unclassifiedCount}` (in-memory only) | `tokenExtractCssScan.ts:471 classifyCssText`, `tokenExtractTailwind.ts` | `tokenExtractBuild.ts`, `designImport/parseCssTokens.ts` | n/a | n/a |
| **M3** | **`ProjectTokenIndex`** — the *measurement* index | `{colors[{name,hex,rgb}], fontSizes[], lengths[]}`, rebuilt per call from `compileProjectStyles().css + .vendorCss` | `projectTokenIndex.ts:92 buildProjectTokenIndex` | `referenceMeasure.ts` → MCP `studio_measure_reference`, `studio_compare` | n/a (agent-only) | n/a |
| **M4** | **`SiteFontsSettings`** — the CMS font library | `{items: FontEntry[], tokens: FontToken[]}` under `site.settings.fonts`; **DB-backed**, files on disk at `/uploads/fonts/<slug>/` | `server/fonts/googleFontsInstaller.ts:438`, `@core/persistence/cmsFonts` | `FontFamilyControl.tsx:52`, `TypographyPanel/FontsSection/*`, `generateFontsCss` → `canvasClassCss.ts:45` | Only if `site.settings.fonts` is populated — **never in Studio** | **No** |
| **M5** | **Design-import candidates** | `TokenCandidate[]` from an *external* GitHub repo / npm package; CSS copied verbatim to `<project>/styles/imported/<slug>/` | `server/handlers/designImport.ts`, `designImport/parseCssTokens.ts` | `designImport/DesignImportDialog.tsx` → `applyDesignImportTokens.ts` → **M1** | Via M1 + via `styles/imported/` if the project imports it | **Partially** — the CSS *file* lands; no `@import` is written for it |
| **M6** | **Design-system digest** | Markdown, `.claude/design-system.md`; five families incl. **radius** + **elevation** that M1 has no home for | `designSystemDigest.ts:180-198` | The Claude CLI agent reading the project's generated `CLAUDE.md` | No | No (it is a doc) |
| **M7** | **`StyleRule` registry** | The project's real parsed CSS rules (`studioCss.ts`), `id → (file, selector)` | `server/handlers/studioCss.ts` | `StyleSurface`, `ClassPicker`, `styleRuleWriteback.ts` | Yes | **Yes — but only by editing a declaration that already exists** |

### The fragmentation, stated plainly

For one project's colour `--color-aqua-100`, the repo holds **four** independent representations:

1. `M2.colors[{name:'--color-aqua-100', light:'#0c9ab0'}]` (extraction, transient)
2. `M1` `FrameworkColorToken{slug:'color-aqua-100', lightValue:'#0c9ab0', generateShades:{count:4}, …}` (`.studio/framework.json`)
3. `M3` `ColorTokenEntry{name:'--color-aqua-100', hex:'#0c9ab0'}` (agent measurement)
4. `M7` the actual `:root{--color-aqua-100:#0c9ab0}` declaration in the project's CSS file

`projectTokenIndex.ts:33-38` is explicit that (3) deliberately refuses (2):

> *"Deliberately NOT sourced from `.studio/framework.json`: that store holds Studio's OWN generated framework scale (`--text-xs`…`--text-4xl`), which is a different scale from the design system's, and offering both would answer 'which token is #0C9AB0' with two names from two systems."*

That comment is a correct diagnosis of a wrong architecture. The right fix is not a second index — it is deleting the second model.

---

## 2. FINDINGS

### T1 — Studio's font picker is structurally empty: `site.settings.fonts` is never populated
**Severity: CRITICAL** (this is the headline)

`FontFamilyControl` — the only font-family control in the inspector — sources its entire option list
from the editor store:

```ts
// src/admin/pages/site/property-controls/FontFamilyControl.tsx:52
const fonts = useEditorStore((state) => state.site?.settings.fonts ?? null)
...
const tokens = sortFontTokens(fonts?.tokens ?? EMPTY_FONT_TOKENS)   // :55
const entries = fonts?.items ?? EMPTY_FONT_ENTRIES                  // :56
```

The menu renders exactly three groups (`:134-181`): a hardcoded `Inherit` row, `Font tokens`
(M4 tokens), and `Installed fonts` (M4 items).

Studio's document shell is built by `createDefaultSiteDocument('Studio')`:

```ts
// src/admin/pages/site/studio/fsCodemodAdapter.ts:291
const site = createDefaultSiteDocument('Studio')
site.pages = pages
```
```ts
// src/admin/pages/site/store/slices/site/defaults.ts:45
settings: structuredClone(DEFAULT_SITE_SETTINGS),
```
```ts
// src/core/page-tree/siteSettings.ts:55-57
export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  shortcuts: {},
}
```

`loadSite` then overrides **only** `settings.framework` (`fsCodemodAdapter.ts:307-317`). There is no
`fonts` sidecar, no `GET /admin/api/studio/fonts`, no extraction of the project's fonts.
**Therefore in Studio mode `site.settings.fonts === undefined` on every load, and the font picker
shows one option: "Inherit".**

Corroborating the sibling audit: the Fonts panel that *would* populate M4 is CMS/DB-backed —
`FontsSection.tsx:29` imports `deleteCmsFontFamily` from `@core/persistence/cmsFonts`, and
`server/fonts/googleFontsInstaller.ts:438` writes to `/uploads/fonts/<slug>/`, which is the admin
server's upload namespace and is never read by the Studio parser or served into a project.

**Root cause.** Fonts were modelled as *site settings owned by the CMS database*, while every other
Studio token was moved to a per-project filesystem sidecar. The move stopped at colours.

**Proposed fix.**
- Extend the extraction pipeline with a font family: `tokenExtractCssScan.ts` already *finds*
  `--type-*-family` declarations and throws them away as `typography-detail` (`:409`). Classify
  them as a new `'font-family'` kind and carry them into `ClassifiedTokens.fontFamilies`.
- Add project `@font-face` discovery: scan `compileProjectStyles().css + .vendorCss` for
  `@font-face { font-family: X; src: url(Y) }` and for `next/font` calls in the app root
  (`projectProbe.ts` already parses the app root statically).
- Replace `FontFamilyControl`'s M4 source with the unified index (see UNIFIED TOKEN SPEC).
- Keep `src/core/fonts/**` and `TypographyPanel/FontsSection/**` for the dormant CMS half; do not
  build on them.

**Effort: M.** Depends on: T3 (unified index), T7 (a write path for new tokens) for the "install a
new Google font into the project" case.

---

### T2 — Font family CSS reaches the canvas but never the user's repo (and in Studio, neither)
**Severity: HIGH**

`canvasClassCss.ts` composes the canvas stylesheet from three generators:

```ts
// src/admin/pages/site/canvas/canvasClassCss.ts:45-54
const fontsCss = generateFontsCss(fonts)
if (fontsCss) blocks.push(fontsCss)
const frameworkCss = generateFrameworkRootCss({ colors: frameworkColors, ... })
if (frameworkCss) blocks.push(frameworkCss)
```

`generateFontsCss` (`src/core/fonts/css.ts:167`) emits `@font-face` rules whose `src` is
`/uploads/fonts/...` — the admin server's namespace, guarded by `isSafeFontSrc` so an arbitrary URL
is skipped (`css.ts:120`). Even if a user installed a font, the canvas would render it from the
admin server and **the user's real Next/Vite app would render nothing**, because no `@font-face`,
no `next/font` import, and no `<link>` tag is ever written into the project. There is no codemod
for any of these — `src/core/ast-codemods/` has `setJsxProp`/`setJsxText`/`setJsxStyle`/
`setStringLiteral`/`setJsxTagName`/`setImportSpecifier`/`move`/`delete`/`insertJsxElement`, and
nothing that inserts a CSS rule or an `@font-face`.

**Root cause.** The font pipeline is the CMS publisher's ("fonts must be self-hosted under
`/uploads/`"), grafted onto a canvas whose source of truth is a repo on disk.

**Proposed fix.** A Studio font install must (a) land the woff2 bytes in the project via
`assetLanding.ts:landAssetBytes` (already exists, symlink-safe, containment-checked), and (b) write
an `@font-face` into a project CSS file — which needs the missing insert-rule codemod (T7).

**Effort: L.** Depends on: T7 (CSS insert codemod), T1.

---

### T3 — The colour picker offers ~19 names per token, of which 1 exists in the project
**Severity: HIGH**

`TokenizedColorField` builds its swatch list from the *generated framework variable set*, not from
the project's declarations:

```ts
// src/admin/pages/site/property-controls/TokenizedColorField.tsx:57-59
const variables = generateFrameworkColorVariableSets(colorSettings).light
  .filter((variable) => variable.tokenId !== excludeTokenId)
const filteredVariables = computeFilteredVariables(value, variables)
```
```ts
// :97-101
function commitToken(variable: ColorVariable) {
  onTokenSelect(`var(${variable.name})`)
}
```

`generateFrameworkColorVariableSets` expands every token through
`buildColorVariants` (`src/core/framework/colors.ts:264-305`):

```ts
variableName: (slug) => `--${slug}`,          // :264  base
variableName: (slug) => `--${slug}-${step}`,  // :279  10 transparent steps
variableName: (slug) => `--${slug}-d-${index}`, // :292  4 shades
variableName: (slug) => `--${slug}-l-${index}`, // :305  4 tints
```

`tokenExtractBuild.ts:80-83` turns *every extracted project colour* on:

```ts
generateTransparent: true,
generateShades: { enabled: true, count: 4 },
generateTints: { enabled: true, count: 4 },
```

So one real project token `--color-aqua-100` produces 19 picker entries, of which exactly one
(`--color-aqua-100`, via `normalizeFrameworkColorSlug` stripping the `--`, `colors.ts:63`)
corresponds to a declaration that exists in the user's CSS. The other 18 resolve only against
Studio's injected `:root` block — which lives in the canvas iframe and nowhere else. **Pick
`var(--color-aqua-100-l-2)` and it renders correctly in Studio and renders as nothing in the real
app.** The menu also caps at 32 entries (`:206-207`), so on a real design system (ALM ships ~60
colour tokens ⇒ ~1,140 entries) a search for "brand" returns transparency steps before it returns
other real tokens.

**Root cause.** `FrameworkColorToken` was designed for a CMS that *generates* its palette. Studio
*reads* a palette it does not own, so every derived variant is a fiction.

**Proposed fix.** Extraction must mark tokens as read-from-source and disable variant generation
(`generateTransparent/Shades/Tints: false` in `tokenExtractBuild.ts:80-83`), and
`TokenizedColorField` must group by `category` with the source file named. Better: replace the
source with the unified index (UNIFIED TOKEN SPEC) so derived names cannot exist.

**Effort: S** for the flag flip; **M** for the grouped picker.

---

### T4 — The framework re-emits the project's own tokens with converted values, shadowing them
**Severity: HIGH**

Framework colour values are normalised to HSLA before emission
(`colors.ts:356-359 normalizeColorValue` → `formatHsla`), and the resulting `:root` block is
injected into the canvas in the same cascade layer as the project's own stylesheets:

```ts
// src/admin/pages/site/canvas/ClassStyleInjector.tsx:175-176
//   @layer user-authored  fonts + framework root CSS + the class registry,
//                         which must WIN over vendor CSS.
```
```ts
// src/admin/pages/site/canvas/UserStylesheetInjector.tsx:90
? `${CANVAS_CSS_LAYER_ORDER}\n@layer ${USER_AUTHORED_LAYER} {\n${css}\n}`
```

Both land in `@layer user-authored`, so within-layer order (document order of two `<style>`
elements) decides which `--color-aqua-100` wins. The canvas therefore may be rendering
`hsla(187,88%,37%,1)` where the real app renders `#0c9ab0` — close, but a round-trip through HSL is
lossy, and `oklch()`/`color-mix()` values fall back verbatim (`colors.ts:361-368`) while
`generateShades`/`generateTints` silently produce nothing for them.

**Root cause.** Injecting a *second* declaration of a variable the project already declares, instead
of reading the project's declaration as authoritative.

**Proposed fix.** When a token's provenance is `project-css`/`vendor-css`, do not re-emit it. The
canvas already loads the project's own `:root` — the framework block should carry only
Studio-authored tokens. Files: `canvasClassCss.ts:48`, `tokenExtractBuild.ts`, a new
`origin: 'project' | 'studio'` field on `FrameworkColorToken`.

**Effort: S–M.** Depends on: nothing.

---

### T5 — Dark-mode token values are extracted, stored, emitted — and land on a selector nothing sets
**Severity: HIGH**

Extraction resolves a project's dark palette correctly (`tokenExtractCssScan.ts:316-327` descends
into `@media (prefers-color-scheme: dark)` and recognises `.dark` / `[data-theme=dark]` /
`:root:not([data-theme=light])`, `:205`), and stores it:

```ts
// server/handlers/studio/tokenExtractBuild.ts:78-79
darkValue: c.dark ?? '',
darkModeEnabled: c.dark !== undefined && c.dark !== c.light,
```

Emission puts those values under a CMS-era class convention:

```ts
// src/core/framework/colors.ts:487-492
const ALT_THEME_SELECTOR = [
  ':root.theme-alt',
  ':root.theme-default .theme-inverted',
  ...
].join(',\n')
```

Studio's dark mode uses a *different* mechanism entirely — `previewAxesFrameEffect.ts` sets
`data-studio-scheme` on the frame's `<html>`, and `darkSchemeCssTransform.ts` rewrites
`@media (prefers-color-scheme: dark)` to `:where(html[data-studio-scheme='dark'])`. Grepping the
whole client for `theme-alt` returns **only** the definition in `colors.ts:482-491` and a doc
comment in `siteImport/rootScope.ts:10` — nothing ever adds the class to a canvas iframe.

**Consequence.** Toggling dark mode in the toolbar correctly re-scopes the *project's own* dark CSS
(good), but every `darkValue` Studio extracted is dead data, and the framework's light values keep
winning in the dark frame — which is the T4 shadowing bug, now visibly wrong.

**Root cause.** Two dark-mode conventions: the CMS's `.theme-alt` class swap and Studio's
`data-studio-scheme` attribute.

**Proposed fix.** Delete `DEFAULT_THEME_OVERRIDE_SELECTOR`/`ALT_THEME_SELECTOR` and emit framework
dark values under the same `html[data-studio-scheme='dark']` selector `darkSchemeCssTransform.ts`
targets. Files: `src/core/framework/colors.ts:163-174`, `src/admin/pages/site/canvas/canvasClassCss.ts`.
Do it with T4 — if project tokens stop being re-emitted, this only affects Studio-authored ones.

**Effort: S.** Depends on: T4.

---

### T6 — What token discovery misses
**Severity: MEDIUM** individually, **HIGH** collectively for real projects

Sources actually tried, in order (`tokenExtract.ts:129-152`): `project-css` (compiled output) →
`tailwind-theme` (only if the CSS found nothing AND the probe detected Tailwind) → `vendor-css`.

| Missed source | Evidence | Impact |
|---|---|---|
| **Tailwind v4 `@theme { --color-brand: … }`** | `tokenExtractCssScan.ts:185-192 isGlobalTokenHostSelector` accepts only `:root`/`html`/`body` (+ one `:where()`/`:is()` wrap). `@theme` is neither an at-rule `atRuleDescentContext` descends into (`:283-292` allows only `@layer` and colour-scheme-only `@media`) nor a global host selector. | A v4 project's source-of-truth token block is invisible. Mitigated only *after* Tier-1 promotion, when Tailwind compiles them into `@layer theme{:root{…}}` — and a fresh import never auto-runs Tier 1 (PROJECT-BRIEF §"What does NOT work") |
| **Tailwind v3 `theme.colors`** (replace, not `extend`) | `tokenExtractTailwind.ts` reads `theme.extend`'s `colors`/`spacing`/`fontSize` only (module doc :2-4) | a project that replaces the palette yields zero tokens |
| **Tailwind `fontFamily`** | absent from the `colors`/`spacing`/`fontSize` set | font tokens invisible even where declarative |
| **Theme built by function/spread/template literal** | `readShallowStringMap` — "silently skipped" (`tokenExtractTailwind.ts:36`) | common in real configs |
| **SCSS `$variables`** | Sass compiles at Tier 1 only, and `$vars` do not survive as custom properties unless re-exported | a Sass design system yields nothing |
| **JS/TS theme objects in the OPEN project** | `designImport/parseCssTokens.ts`'s `extractJsTokens` exists but is wired only to the external GitHub/npm wizard (`designImport.ts` preview route). `tokenExtract.ts` never calls it | a `theme.ts` in the user's own repo is ignored, while the identical file inside an npm package is parsed |
| **CSS-in-JS themes** (styled-components / emotion) | `styleToolchainDetect.ts` *detects* `cssInJs`; no extractor consumes it | zero tokens |
| **Figma variables** | no code path; the Figma MCP `get_variable_defs` output is never imported into any token model | manual copy only |
| **`rem`/`em` against a non-16px root** | `tokenExtractCssScan.ts:426-434 toPx` hardcodes 16; `projectTokenIndex.ts:73-74` refuses `rem` outright | wrong px on `html{font-size:62.5%}` projects, and the two models disagree |
| **radius / elevation** | `FrameworkSettings` has no family. `designSystemDigest.ts:180-183` adds `RADIUS_NAME_RE`/`ELEVATION_NAME_RE` **for the markdown digest only** | the picker cannot offer a radius or shadow token that the agent's own generated docs list |

**Proposed fix.** Add `@theme` to `atRuleDescentContext`'s allowlist — it is unconditional, exactly
like `@layer`, so this is a ~5-line change at `tokenExtractCssScan.ts:283-292` that unlocks every
Tailwind v4 project at Tier 0. Then promote `designSystemDigest.ts`'s radius/elevation classifiers
into `classifyDeclaration`, and wire `extractJsTokens` to the open project.

**Effort: S** (`@theme`) · **M** (radius/elevation) · **M** (JS theme objects).

---

### T7 — You cannot create a new token; the write ceiling is "edit a declaration that already exists"
**Severity: HIGH**

`styleRuleWriteback.ts`'s module doc is explicit that a rule with no mapped hand-authored `.css`
block is a **refusal**, not a write:

> *"a rule that came from compiled output … has no single hand-authored block to edit, so it is deliberately left unmapped … an unmapped rule is a first-class REFUSAL here, reported through `collectStyleRuleEdits`'s `unmapped` list"* — `styleRuleWriteback.ts:12-33`

And `src/core/ast-codemods/` contains no rule-insert codemod (see the full enumeration at
`docs/agent-refs/path-index.md:88`). Consequences:

- **Creating a colour token in the ColorsPanel** writes to `.studio/framework.json`
  (`fsCodemodAdapter.ts:582 POST /admin/api/studio/framework`) and injects a `:root` line into the
  canvas — and **never touches the project**. The user sees a token that does not exist in their
  code; their own `bun run build` renders it as undefined.
- **Creating a font token** has no persistence in Studio at all (T1).
- The design-import wizard is the only path that puts token CSS on disk
  (`designImport.ts:29-34` → `styles/imported/<slug>/`), and even then it writes the files but
  **never an `@import`**, so the project does not load them unless the user wires it up by hand.

**Root cause.** No CSS-insert codemod. Every token write is either a sidecar write or a
declaration-level edit of something that already exists.

**Proposed fix.** `src/core/css-codemods/insertRule.ts` + `insertDeclaration.ts`, plus a
`kind: 'css-insert'` StudioEdit in `studioCssWriteback.ts`, targeting a **declared token file** —
let `.studio/meta.json` name one writable stylesheet, defaulting to the file whose `:root` block
extraction sourced the most tokens from. Then "New token" appends `--brand-accent: #…;` there and
the picker offers a name that is true in both worlds.

**Effort: L.** Keystone for T2 and T8.

---

### T8 — Assigning a colour: the click count, and what actually gets written
**Severity: MEDIUM** (the flow works; the ceiling bites)

Trace for "make this heading's text `--text-brand`":

1. Select the node → PropertiesPanel opens (`usePropertiesPanelAutoOpen.ts`).
2. **Choose the write target** on `StyleTargetChip` — Element or Class. Two honest targets only
   (`StyleTargetChip.tsx:3-8`); `.class:hover` is a stated gap (`:41-46`).
3. Typography section → the `color` row renders `ColorControl` → `ColorValueInput` →
   `TokenizedColorField`.
4. Click the text field → the token listbox opens on focus (`TokenizedColorField.tsx:74-76`).
5. Type to filter / arrow to a swatch → Enter or click → `commitToken` writes
   `onTokenSelect('var(' + variable.name + ')')` (`TokenizedColorField.tsx:99`).

**≈4–5 interactions, and the value written is `var(--text-brand)` — a token reference, not a hex.**
That half is right. What happens next depends on the target:

- **Element** → `setJsxStyle` writes `style={{ color: 'var(--text-brand)' }}` into the `.tsx`.
  Always lands — but it is an inline style, which defeats the project's own class system and is
  precisely what a design system exists to prevent.
- **Class** → three outcomes (`StyleTargetChip.tsx:26-37`): `plain-css` reaches the file;
  `compiled` refuses with a reason; `unmapped` refuses. On a Tailwind or CSS-Modules project — i.e.
  most React repos — **the class path refuses**, leaving the inline style as the only working path.
- **A Tailwind utility class edit** (`text-brand-500`) does not exist. `styleRuleWriteback.ts:29`
  names it as the eventual fix (`meta-03`) and states it is not built.

There is also a native `<input type="color">` behind the swatch (`ColorInput.tsx:65`) which
**cannot represent `var(--x)`**: the token is resolved to a hex for display
(`TokenizedColorField.tsx:60 resolveTokenReferenceValue`), and touching the swatch fires
`onSwatchChange` (`:92-95`), writing a **raw hex** and silently detaching the value from the token.
A one-click token-destroying action sits directly beside the token field.

**Proposed fix.** Make the swatch open the token menu rather than the OS colour dialog; put "raw
colour" behind an explicit *Custom* affordance. Add the Tailwind class-edit target. Files:
`TokenizedColorField.tsx`, `ColorValueInput.tsx`, `StyleTargetChip.tsx`.

**Effort: S** (swatch) · **L** (Tailwind target).

---

### T9 — `contrastRatio` exists and is not in the UI
**Severity: MEDIUM** — highest value-per-line item in this audit

```
server/handlers/studio/colorMath.ts:110  export function contrastRatio(a: Rgb, b: Rgb): number
```

Consumers, exhaustively: `referenceMeasure.ts:52,357-359` (the MCP `studio_measure_reference`
engine) and `projectTokenIndex.ts:44` (`parseHexColor` only). **Zero imports from `src/`** — the
client bundle never sees it. The agent can report a design's contrast ratio; the human picking the
colour in the inspector gets no AA/AAA badge and no warning when text lands on a background it
cannot be read against.

The module also carries `colorDifference` (CIE76 ΔE over CIELAB) — exactly what a "nearest token"
badge in the picker needs.

**Proposed fix.** Move `colorMath.ts` to `src/core/color/` (it is pure and imports nothing) so both
sides can use it; render an AA/AAA chip in `TokenizedColorField` when the control is `color` and a
`backgroundColor` is resolvable from the same style bag.

**Effort: S.** Depends on: nothing.

---

### T10 — No eyedropper, and no sampling from a registered design reference
**Severity: MEDIUM**

`grep -rn "EyeDropper|eyedropper|eyeDropper" src server` returns **zero matches**. No
`window.EyeDropper`, no canvas colour sampling, no "pick from the reference image".

Conspicuous, because the server machinery already exists: `designReferenceStore.ts` holds the pasted
comp, `referenceMeasure.ts` already computes per-region background/foreground palettes reporting the
modal *exact* value, and `extractReferenceAsset.ts` already crops a rectangle out of it. Everything
needed to let a user marquee the reference and get "`#0c9ab0` — nearest token `--color-aqua-100`
(ΔE 0.0)" is built; only the UI is missing.

**Proposed fix.** (a) `window.EyeDropper` for the canvas, feature-detected and hidden otherwise;
(b) a reference-sampling mode POSTing a rect to a thin route over `referenceMeasure.ts`, returning
hex + nearest token straight into `TokenizedColorField`.

**Effort: S** (a) · **M** (b). Depends on: T9 for the nearest-token badge.

---

### T11 — Font families are discovered, counted, and thrown away
**Severity: MEDIUM**

`classifyDeclaration` deliberately routes `--type-display-family` into the discard bucket:

```ts
// server/handlers/studio/tokenExtractCssScan.ts:389
const TYPOGRAPHY_DETAIL_SUFFIX_RE = /-(weight|lh|line-height|ls|letter-spacing|family)$/i
// :408-412
if (TYPOGRAPHY_NAME_HINT_RE.test(name)) {
  if (TYPOGRAPHY_DETAIL_SUFFIX_RE.test(name)) return 'typography-detail'
  ...
}
```

and the user is told so, honestly (`tokenExtract.ts:165-171`):

> *"N typography declaration(s) (font family/weight/line-height/letter-spacing) were found but Studio's typography model only represents a size scale — they were not imported. **Fix:** Set font family/weight/line-height directly on the relevant elements or classes in the panel."*

The suggested fix is impossible: T1 means there is no family to pick, T7 means the class edit usually
refuses. `FrameworkTypographyGroup` genuinely has no field for family/weight/line-height — it is a
size ladder only (`framework-schema/schemas.ts:251-261`), documented as "lossy by design"
(`tokenExtractBuild.ts:8-19`). The honesty is admirable; the outcome is a dead end.

**Proposed fix.** Add `fontFamilies` and `fontWeights` to the unified token model and make them the
font picker's primary source. Same work as T1's first bullet.

**Effort: M.** Depends on: T1, T3.

---

### T12 — Two extraction engines and two indexes disagree about the same CSS
**Severity: MEDIUM**

`tokenExtractCssScan.ts` and `projectTokenIndex.ts` scan the same bytes with different rules:

| | `tokenExtractCssScan.ts` (M1/M2) | `projectTokenIndex.ts` (M3) |
|---|---|---|
| Scope | `:root`/`html`/`body` + `:where()`/`:is()`, `@layer`, colour-scheme `@media` (`:185-192`, `:283-292`) | **any rule anywhere** — `CUSTOM_PROPERTY_RE` over raw text (`:70`, `:96-98`) |
| `var()` chains | depth 8, cycle-safe (`:344-357`) | **one level** (`:101-105`) |
| `rem`/`em` | converted at 16px (`:426-434`) | **refused** (`:73-74`) |
| Colour parsing | `isCssColorValue` (hex/rgb/hsl/named) | `parseHexColor` — **hex only** |
| Dark values | yes | **no** |
| Font-size naming | `TYPOGRAPHY_NAME_HINT_RE` + `-size$` (`:378`, `:410`) | `FONT_SIZE_NAME_RE` minus `NON_TYPE_SIZE_NAME_RE` (`:76-78`) |

So `studio_measure_reference` can name a token the picker never offers, and vice versa; a
`--brand: hsl(187 88% 37%)` is a colour to the picker and *invisible* to the agent. This is the
concrete cost of the split `projectTokenIndex.ts:33-38` chose deliberately.

**Proposed fix.** One scanner. Delete `buildProjectTokenIndex`'s own regexes; have it consume the
unified index below, keeping `nearestSizeToken`/`colorDifference` as ranking helpers over it.

**Effort: M.** Depends on: the UNIFIED TOKEN SPEC.

---

## 3. UNIFIED TOKEN SPEC

### 3.1 One token model

Replace M1, M2, M3 and the font half of M4 with a single shape. Place it as a pure schema leaf at
`src/core/design-tokens/` (browser-safe, no ts-morph, no Node) so the server extractor, the picker,
the MCP tools, and the write path all import the same thing.

```ts
// src/core/design-tokens/schemas.ts  (TypeBox; type = Static<typeof …>)
DesignToken = {
  name:   string          // the REAL custom property, e.g. '--color-aqua-100'.
                          //   The identity. Never re-slugged, never re-minted.
  family: 'color' | 'font-family' | 'font-size' | 'font-weight'
        | 'space' | 'radius' | 'elevation' | 'line-height' | 'letter-spacing'
  value:  string          // resolved light/default value, verbatim from source
  darkValue?: string      // resolved under the project's own dark selector
  origin: {
    kind: 'project-css' | 'vendor-css' | 'tailwind-theme' | 'js-theme' | 'studio-authored'
    file?: string         // project-relative; the file the declaration lives in
    line?: number
  }
  category?: string       // grouping label for the picker (name prefix, or Tailwind key)
  px?: number             // for length families; null when unit is not resolvable
  aliasOf?: string        // when the source value was var(--other)
}

ProjectTokenSet = {
  tokens: DesignToken[]
  writeTarget: { file: string; selector: string } | null   // where a NEW token lands
  warnings: ProbeWarning[]                                  // honest gaps, unchanged
}
```

**Rules that make it one model.**
- `name` is the project's own property name. There is no slug, no re-minting, no derived variant.
  A name in the picker is a name in the user's CSS. (Kills T3, T4, T12.)
- No `generateShades`/`generateTints`/`generateTransparent`. Derived colours are a *Studio-authored*
  token you explicitly create (T7), never an invisible expansion.
- `darkValue` is emitted under the project's own dark selector, discovered by
  `projectProbe.detectColorScheme` and applied by `previewAxesFrameEffect.ts`. `.theme-alt` is
  deleted. (Kills T5.)
- `origin.file` makes provenance visible in the picker and gives the write path a target.

**Deleted by this:** `FrameworkColorToken`'s variant fields, `buildProjectTokenIndex`'s private
regexes, `TokenizedColorField`'s dependency on `generateFrameworkColorVariableSets`,
`FontFamilyControl`'s dependency on `site.settings.fonts`. Per CLAUDE.md, delete — do not shim.
`src/core/framework/**` and `src/core/fonts/**` stay only for the dormant CMS publisher.

### 3.2 One resolution path: source → picker → write target

```
                       ┌─ project's own .css / .module.css      (Tier 0)
  DISCOVER             ├─ vendor package .css in node_modules   (Tier 0)
  one scanner          ├─ Tailwind config theme (v3) / @theme   (Tier 0)  ← add @theme
  tokenScan.ts         ├─ compiled Sass/PostCSS/Tailwind output (Tier 1)
                       └─ JS/TS theme objects in the open repo  (Tier 0)  ← wire extractJsTokens
                                    │
                                    ▼
  CLASSIFY             classifyDeclaration()  — value first, name second,
  one classifier       + radius/elevation/font-family families promoted in
                       from designSystemDigest.ts and TYPOGRAPHY_DETAIL
                                    │
                                    ▼
  PERSIST              .studio/tokens.json   { tokens[], writeTarget, warnings[] }
  one sidecar          (replaces .studio/framework.json; never clobbers
                        studio-authored entries — same whole-family merge rule)
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
  PICKER (browser)          MCP / agent                   CANVAS
  useProjectTokens()        studio_list_tokens            NO re-emission of
  → colour + font + size    studio_measure_reference      project tokens; the
    controls                  (nearest by ΔE / px)        project's own :root
        │                                                 already cascades.
        │                                                 Only studio-authored
        ▼                                                 tokens are injected.
  WRITE TARGET — one decision, stated on the chip:
    A. token reference into an existing declaration
       → styleRuleWriteback  (kind:'css')      when the rule maps to a hand-authored file
    B. token reference into the element        → setJsxStyle
    C. Tailwind utility class on the element   → setJsxProp on className   ← NEW (meta-03)
    D. a NEW token declaration                 → css-codemods/insertDeclaration
                                                  into ProjectTokenSet.writeTarget  ← NEW (T7)
    E. a NEW @font-face                        → landAssetBytes + insertRule         ← NEW (T2)
```

The invariant that makes this honest: **anything the picker offers must be reachable by one of
A–E.** If a token cannot be written anywhere, it is not offered — it is listed under a "read-only"
heading with its origin file, exactly as `StyleTargetChip` already does for compiled classes.

### 3.3 The colour control

One control, three regions, opened from a single click on the swatch or the field.

```
┌─────────────────────────────────────────────────┐
│ [■] var(--text-brand)                    AA 7.2 │  ← swatch opens the MENU (not the
└─────────────────────────────────────────────────┘     OS dialog); contrast chip from
┌─────────────────────────────────────────────────┐     colorMath.contrastRatio (T9),
│ 🔍 brand                                        │     computed against the resolved
├─────────────────────────────────────────────────┤     backgroundColor in the same bag
│ TEXT              tokens/colors.css             │  ← group = DesignToken.category,
│  ■ --text-brand          #0c9ab0     AA 7.2     │     subtitle = origin.file
│  ■ --text-brand-hover    #0a7f92     AA 8.9     │
│ SURFACE           @alm-design/design-system     │  ← vendor origin, read-only marker
│  ■ --background-primary  #ffffff                │
├─────────────────────────────────────────────────┤
│ 💧 Pick from screen        🎯 Pick from design   │  ← EyeDropper (T10a) / reference
│ ✎  Custom value…            + New token…        │     sampling (T10b); Custom is the
└─────────────────────────────────────────────────┘     ONLY route to a raw hex
```

- Nearest-token badge on a sampled or pasted hex: `colorDifference` ΔE, "≈ `--text-brand` (ΔE 1.2)"
  with a one-click snap. Never auto-snaps.
- Contrast chip is live on hover of each option, so the failing choice is visible before the click.
- **New token…** is enabled only when `writeTarget !== null`; otherwise it renders disabled with the
  reason ("this project has no writable token stylesheet — add one, or style the element"), matching
  `PreviewAxesControls.tsx`'s probe-honesty pattern.
- Raw hex is reachable but never accidental — the native `<input type="color">` moves behind
  *Custom value…*.

### 3.4 The font control

```
┌─────────────────────────────────────────────────┐
│ var(--type-display-family)                      │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ Inherit                                         │
├─────────────────────────────────────────────────┤
│ PROJECT TOKENS         tokens/typography.css    │  ← family:'font-family' tokens (T11)
│  Aa  --type-display-family   Sora               │     rendered in the real face
│  Aa  --type-body-family      Inter              │
├─────────────────────────────────────────────────┤
│ PROJECT FONTS          app/fonts.css            │  ← discovered @font-face + next/font
│  Aa  Sora           4 weights · woff2 local     │
│  Aa  Inter          variable · next/font/google │
├─────────────────────────────────────────────────┤
│ SYSTEM                                          │
│  Aa  system-ui / ui-serif / ui-monospace        │
├─────────────────────────────────────────────────┤
│ + Add a font to this project…                   │  ← T2: bytes via landAssetBytes,
└─────────────────────────────────────────────────┘     @font-face via insertRule,
                                                        or a next/font import codemod
```

- Options are rendered in their own face. The faces are already loading in the canvas because they
  are the *project's* `@font-face` rules — the admin shell needs the same injection, which
  `useInstalledFontFaces.ts` already implements; repoint it at project fonts.
- Picking a token writes `var(--type-display-family)`; picking a discovered family writes the
  family's own stack. Both are values that exist in the real app.
- **Add a font** is the only place a new face is created, and it goes through E — bytes into the
  project, `@font-face` into the write-target stylesheet, with a Next.js variant that writes a
  `next/font` import instead. Disabled with a reason when `writeTarget === null`.

### 3.5 Sequencing

| Step | Delivers | Effort | Blocks |
|---|---|---|---|
| 1 | `@theme` descent in `tokenExtractCssScan.ts` | S | — |
| 2 | Move `colorMath.ts` → `src/core/color/`; AA/AAA chip in the picker | S | — |
| 3 | Stop generating colour variants + stop re-emitting project tokens on the canvas | S | — |
| 4 | Dark values onto `data-studio-scheme`; delete `.theme-alt` | S | 3 |
| 5 | `src/core/design-tokens/` + `.studio/tokens.json`; repoint picker, MCP tools, `projectTokenIndex` | M | 1,3 |
| 6 | `font-family`/`font-weight`/`radius`/`elevation` families; new font control | M | 5 |
| 7 | `css-codemods/insertDeclaration` + `insertRule`; `writeTarget`; "New token" | L | 5 |
| 8 | Tailwind utility-class write target (`meta-03`) | L | 5 |
| 9 | EyeDropper + reference sampling | S/M | 2,5 |

Steps 1–4 are four small, independent changes that remove four classes of *silently wrong output*
before any refactor begins. That is the order to run them in.

---

## 4. Verification notes

Read-only audit; no files in the repo were modified and no tests were run. Every claim above cites
a file:line read directly during this session. Two claims are structural negatives established by
exhaustive grep and are worth re-confirming before acting:

- `grep -rn "EyeDropper|eyedropper|eyeDropper" src server` → **0 matches** (T10).
- `grep -rn "contrastRatio" src/` → **0 matches**; all hits are under `server/` (T9).
- `grep -rn "theme-alt" src/` → only `src/core/framework/colors.ts:482-491` and a doc comment at
  `src/core/siteImport/rootScope.ts:10` (T5).
- `DEFAULT_SITE_SETTINGS` at `src/core/page-tree/siteSettings.ts:55-57` has no `fonts` key, and
  `fsCodemodAdapter.ts:291-317` overrides only `settings.framework` (T1).
