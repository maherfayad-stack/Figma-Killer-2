# Audit 03 — Creative design from scratch

## C1 — BLOCKER — CSS write-back can EDIT but cannot CREATE
- `src/admin/pages/site/studio/styleRuleWriteback.ts:200-267` — `collectStyleRuleEdits`: any rule with no `styleRuleSources` entry goes to `unmapped`, never written.
- `server/handlers/studioCss.ts:87-104,270-304` — `sources` map built ONLY from already-existing `.css` files: `mappable = sourceFile !== undefined && /\.css$/i.test(sourceFile)`.
- `src/core/css-codemods/` contains only `setDeclaration.ts`, `analyzeDeclarationTarget.ts`, `classifyStylesheetEditability.ts`. No `insertRule` / `createSelector` / `createStylesheet`.
- `src/admin/pages/site/store/slices/styleRule/crudActions.ts:288-315` — `createClass()` works on canvas, then dies at save.

Root cause: `panel-02` built CSS write-back as a targeted patch of an existing declaration, not a CSS authoring engine.

Consequence: no new selector, no new `@font-face`, no new `@keyframes`, no new stylesheet can ever reach disk. Most of a creative session is ephemeral.

Fix: `insertRule(cssText, selector, declarations)` codemod; synthesize a `sources` entry for editor-created classes (append to the page's own stylesheet or a new `<Page>.module.css`); extend `CssEditSchema`/`applyCssEdit` with an "insert" kind.
Effort: L. Depends on: parser-surgeon (css-codemods), server-engineer (studioCssWriteback.ts).

## C2 — BLOCKER — every new project is force-seeded with one hardcoded design system
- `server/handlers/studio.ts:608-637` — `POST /admin/api/studio/create` calls `applyProjectSeed(dir)`.
- `server/handlers/studio/projectSeed.ts:112-165` — `SEED_PACKAGE = '@alm-design/design-system'`, copied out of Studio's own `node_modules`, `package.json` written declaring it. Best-effort, never fatal, ON BY DEFAULT.

Consequence: "no design system, invent one" is not an available starting state. Always the same library, because it is the only package the `pkg.*` registration path is proven against.
Fix: make seeding an explicit launcher choice ("Start blank" vs "Start with ALM"). Effort: M, but blank is only usable after C1/C3.

## C3 — MAJOR — Fonts panel is CMS/DB-backed, disconnected from the project on disk
- `src/admin/pages/site/panels/TypographyPanel/FontsSection/FontsSection.tsx:29` — imports `deleteCmsFontFamily` from `@core/persistence/cmsFonts`.
- `server/handlers/cms/fonts.ts:1-21` — installs woff2 into `<uploads>/fonts/<slug>/`, metadata persisted via `PUT /admin/api/cms/site` (the dormant CMS DB row).
- `server/fonts/googleFontsInstaller.ts:9,408,438` — writes to `join(uploadsDir,'fonts',slug)`, returns `/uploads/fonts/...` — NOT `studio-workspace/<project>/`.
- `server/handlers/studioFramework.ts` has zero font handling.

Consequence: installing a webfont writes to the CMS database/uploads tree, which the Studio parse pipeline never reads. It never becomes an `@font-face` in the user's repo, and "download the code" won't include it.
Fix: Studio-native font pipeline — land bytes via `assetLanding.ts`, write `@font-face` via the C1 codemod, register family in `.studio/framework.json`. Effort: L. Depends on C1.

## C4 — MAJOR — no free-form/absolute placement; every insert is DOM-flow relative to a sibling
- `src/admin/pages/site/canvas/canvasInsertionDrop.ts:1-40` → `resolveCanvasInsertionTarget` in `canvasDnd.ts` — always a before/after/inside anchor. No "drop at (x,y), pin absolute".
- `src/admin/pages/site/panels/PropertiesPanel/PositionSection.tsx:70-189` — absolute + offsets control exists, but writes `kind:'css'` edits, so gated by C1.

Intentional per CLAUDE.md trap #1 (canvas DOM must be the DOM React renders). Board gives free x/y at FRAME level only (`src/core/studio-board/`), not per element.
Fix: document plainly; prioritize C1 so `position:absolute` becomes writable.

## C5 — MAJOR — no aesthetic self-evaluation without a reference image
- `server/ai/mcp/tools/studio/compare.ts:1-63` — requires `resolveDesignReference` at steps 1 and 5.
- Same pattern in `measureReference.ts`, `referenceResolve.ts`. No reference-free quality scorer exists.

Consequence: on a from-scratch brief the only signal is `studio_screenshot` + subjective judgement.
Fix: reference-free passes — contrast audit reusing `server/handlers/studio/colorMath.ts` `contrastRatio`; token-adherence check (declared scale vs one-off values); spacing-rhythm check. Effort: M, no new infra.

## C6 — MINOR — motion authored blind
- `src/admin/pages/site/canvas/CanvasAnimationInjector.tsx:1-50` — freezes animations, kills transitions, pauses media.
- Live mode exists (`canvasSlice.ts` `canvasView`, `CanvasLiveSurface.tsx`) but nothing bridges author → preview → confirm.
Compounded by C1: new `@keyframes` can't be written anyway. Effort: S once C1 lands.

## C7 — MINOR — no image generation; imagery is fetch-URL or crop-a-reference only
- `server/handlers/studio/remoteAssetFetch.ts:1-40`; `server/ai/mcp/tools/studio/extractReferenceAsset.ts`.
- No image-gen driver anywhere under `server/ai/`.
Ceiling on creative work, not a bug in this repo's architecture.

## C8 — MINOR — DOC DRIFT: CSS write-back to disk DOES work (for edits)
- `server/handlers/studioCssWriteback.ts:1-158` — `applyCssEdit`, real postcss CST round-trip, three refusal gates. STATE.md:957 `panel-02` done, browser-verified.
- PROJECT-BRIEF.md:149 lists "CSS write-back to disk" under "does NOT work" — stale. Correct framing is C1's.

## C9 — MINOR — POSITIVE: blank-canvas onboarding is solid
- `server/handlers/studio.ts:608-637` writes a real `pages/Home.tsx` + co-located `.module.css`.
- `server/handlers/studioProjects.ts:387-452` `starterPage` — deliberately fluid, token-free, `clamp()`-based.
- `src/admin/pages/site/canvas/BoardFramesLayer/NewPageButton.tsx:1-85` — one-click New page writes a real file and reloads.

## TOP 5 REASONS CREATIVE-FROM-SCRATCH FAILS
1. CSS write-back cannot create anything (C1) — most of a creative session is lost on reload.
2. Every project force-seeded with one hardcoded design system (C2).
3. Fonts panel writes to the CMS DB, not the repo (C3).
4. No aesthetic feedback loop without an external reference (C5).
5. No imagery generation and no true free-form placement (C7/C4).
