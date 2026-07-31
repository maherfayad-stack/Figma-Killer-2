# Path index — where everything lives

Written for agents. Look here **before** grepping the repo.

Legend: 🟢 Studio (active work) · 🟡 shared infrastructure Studio depends on ·
⚪ dormant CMS — do not build on it, do not delete it.

---

## Studio: server side

| Path | What it owns |
|---|---|
| 🟢 `server/handlers/studio.ts` | **HTTP routing only** for every `/admin/api/studio/*` endpoint. Its module doc lists all routes — read it first. |
| 🟢 `server/handlers/studioPageLoad.ts` | The parse → inline → CSS → convert pipeline. `resolveModuleId` (element → module) lives here. |
| 🟢 `server/handlers/studioProjects.ts` | Project discovery, `.studio/meta.json`, `discoverPageFiles`, `projectPagesDir`. |
| 🟢 `server/handlers/studioWriteback.ts` | `StudioEdit` shapes, `studioEditLocation`, dedupe, path containment, `applyStudioEdit`. |
| 🟢 `server/handlers/studioCss.ts` | Imported `.css` → `StyleRule` registry, deterministic ids, happy-dom CSSOM. `loadStudioStyles`'s `extraCss` param merges in `styleCompile.ts`'s compiled output. |
| 🟢 `server/handlers/studio/styleCompile.ts` | WS-2.1/2.3 — `dir + ProjectProfile → CompiledStyles`. CSS Modules (Tier 0, own transform) + vendor package CSS (`vendorCss` — bare-specifier `.css` imports resolved against the project's own `node_modules`, Tier 0 safe, no trust gate) + `compileProjectStyles`'s overall orchestration + the on-disk cache, cached under `.studio/cache/styles-<hash>.*`. Tier 1 (Sass/PostCSS/Tailwind) itself lives in `styleCompileTier1.ts` (split out to stay under the module-size budget). |
| 🟢 `server/handlers/studio/styleCompileTier1.ts` | `compileSass`/`compilePostcssPipeline` — resolves the workspace's own `sass`/`postcss`/`@tailwindcss/postcss`, gated on trust, spawns `styleCompileWorker.ts` to actually run them. |
| 🟢 `server/handlers/studio/styleCompileWorker.ts` | `sec-01` — the Tier 1 SUBPROCESS entry point. Runs `sass`/`postcss`/`postcss.config.js`/plugin packages OUT of the admin server's own process; reads one `WorkerTask` from argv, writes one `WorkerResult` to stdout. |
| 🟢 `server/handlers/studio/styleCompileFileRead.ts` | Tiny shared leaf: `readCappedFile`, `CSS_MODULE_FILE_RE`, `MAX_STYLESHEET_BYTES` — used by both `styleCompile.ts` and `styleCompileTier1.ts` without a cycle. |
| 🟢 `server/handlers/studio/subprocessRunner.ts` | `sec-01` — the shared spawn+timeout+capped-capture primitive (`runCappedSubprocess`/`captureSubprocess`) and `minimalSubprocessEnv`, used by `styleCompileTier1.ts` and `installDeps.ts`. |
| 🟢 `server/handlers/studio/workspacePackageResolve.ts` | `sec-01` — `resolveWorkspacePackageEntry`/`isRealpathContained`: symlink-containment-checked `<dir>/node_modules/<pkg>` resolution, used by the parent (`styleCompileTier1.ts`) and the subprocess (`styleCompileWorker.ts`) alike. |
| 🟢 `server/handlers/studio/installDeps.ts` | WS-1.4 — `bun install`/etc as a polled job. `sec-01`: uses `subprocessRunner.ts`'s shared capture primitive, explicit minimal env. |
| 🟢 `server/handlers/studio/packageManifestSchema.ts` | `pkg-01`/WS-3.1 — pure schema leaf: `PropKind` (the string/number/boolean/enum/color/image/node/handler/unknown classification), `PropSpec`, `ComponentSpec`. |
| 🟢 `server/handlers/studio/packageManifest.ts` | `pkg-01`/WS-3.1 — `dir + package name → ComponentSpec[]`, purely syntactic (`.d.ts` then `.tsx` source, never the type checker, never executes anything — Tier 0 safe on its own). Replaces `scripts/gen-alm-manifest.mjs`'s build-time, `@alm-design`-only extraction with a per-project, per-package one. |
| 🟢 `server/handlers/studio/componentBundle.ts` | `pkg-01`/WS-3.2 — `POST/GET /admin/api/studio/component-bundle`: `tryServeStudioComponentBundle` sub-router. Tier 1 gate, React major-version skew check, demand list (`ProjectProfile.componentPackages`), barrel generation, `.studio/cache/bundle-<hash>.{js,json}`. Not yet wired into `STUDIO_SUB_ROUTERS` — see `pkg-01` in `STATE.md`. |
| 🟢 `server/handlers/studio/componentBundleWorker.ts` | `pkg-01`/WS-3.2 — the Tier 1 SUBPROCESS entry point: runs `Bun.build` (a package can execute a Bun macro at build time) out of the admin server's own process, via `subprocessRunner.ts`/`minimalSubprocessEnv()`, same posture as `styleCompileWorker.ts`. |
| 🟢 `server/handlers/studioAsset.ts` | `GET /admin/api/studio/asset` + all path-containment guards. |
| 🟢 `server/handlers/studioGithubImport.ts` | GitHub zipball fetch (URL parsing, zipball URL, download). |
| 🟢 `server/handlers/studio/archiveIngest.ts` | Shared ingest engine (entry decision, budgets, target-dir clear+write) behind both the GitHub and upload import routes. |
| 🟢 `server/handlers/studio/importUpload.ts` | `POST /admin/api/studio/import-upload` — uploaded `.zip` or a picked folder, via `archiveIngest.ts`. |
| 🟢 `server/handlers/studio/assetUpload.ts` | WS-8.3 — `POST /admin/api/studio/asset-upload`: `tryServeStudioAssetUpload` sub-router. Symlink-aware `targetDir` containment, byte-sniffed content type, collision-safe filename. Not yet wired into `STUDIO_SUB_ROUTERS` — see `asset-01` in `STATE.md`. |
| 🟢 `server/handlers/studioDownload.ts` | "Download the code" — zips the workspace. Not codegen. |
| 🟢 `server/handlers/studioFramework.ts` | `.studio/framework.json` sidecar (colors/typography/spacing). |

## Studio: parsing and codegen (the engine)

| Path | What it owns |
|---|---|
| 🟢 `src/core/page-parser/parsePageFile.ts` | The ts-morph JSX walk → `ParsedPage`. **Never throws.** |
| 🟢 `src/core/page-parser/inlineLocalComponents.ts` | Local-component expansion, composite ids, `spliceReference`. |
| 🟢 `src/core/page-parser/componentSubstitution.ts` | Call-site props → the component's own JSX (`applySubstitutions`). |
| 🟢 `src/core/page-parser/staticLoopExpansion.ts` | `.map` over a resolved array → one node per item. |
| 🟢 `src/core/page-parser/staticEval.ts` | Public composer for the value evaluator. |
| 🟢 `src/core/page-parser/staticEvalCore.ts` | Tier A + recursive walker + binding resolution. |
| 🟢 `src/core/page-parser/staticEvalCalls.ts` | Tier B (hook → provider) + Tier C (pure calls). |
| 🟢 `src/core/page-parser/staticEvalOperators.ts` | Tier A operators, `Math.*`, `\|\|`/`&&`/`??`. |
| 🟢 `src/core/page-parser/componentSources.ts` | local vs package classification; the workspace-wide ts-morph `Project` (**tsconfig `paths` already resolve here**). |
| 🟢 `src/core/page-parser/assetImports.ts` | `?raw` text imports, image imports → `studio-asset:` sentinel + `ParsedNode.assetOrigin` (WS-8.3, the import specifier's own location), `.module.css` imports → `{ localName: globalName }` (WS-2.2, sourced from `styleCompile.ts`'s `moduleClassMaps`). |
| 🟢 `src/core/page-parser/inlineSvg.ts` | `<svg>` written as JSX → markup for `base.svg`. |
| 🟢 `src/core/page-parser/jsxAttributeReaders.ts` | How each attribute shape is read. |
| 🟢 `src/core/page-parser/resolutionLock.ts` | Resolved value → lock + `resolution`. |
| 🟢 `src/core/ast-codemods/` | **Every source write.** `setJsxProp`, `setJsxText`, `setJsxStyle`, `setStringLiteral`, `setJsxTagName`, `setImportSpecifier` (WS-8.3). |
| 🟢 `src/core/studio-sync/parsedPageToSitePage.ts` | `ParsedPage` → editor `Page` (moduleId, text prop, classIds, codeProps). |
| 🟢 `src/core/studio-sync/collectPageStylesheets.ts` | Which `.css` a page depends on, in cascade order. |
| 🟢 `src/core/page-tree/sourceNodeId.ts` | **The node-id grammar.** Separators, decode, "is there one place to write this?" |
| 🟢 `src/core/page-tree/sourceWritability.ts` | `isPropWritableToSource` — the ONE predicate every edit surface asks. |

## Studio: client side

| Path | What it owns |
|---|---|
| 🟢 `src/admin/pages/site/studio/studioMode.ts` | Is Studio mode on? URL `?studio` + sticky localStorage. |
| 🟢 `src/admin/pages/site/studio/fsCodemodAdapter.ts` | Client → save-route adapter. **Mirrors** `INLINE_ID_SEPARATOR` and `ComponentSource` literals on purpose (importing the parser barrel drags ts-morph into the browser bundle). `saveStudioAssetEdit` (WS-8.3) commits one `kind: 'asset'` edit immediately, outside the ordinary diff loop. |
| 🟢 `src/admin/pages/site/studio/uploadStudioAsset.ts` | WS-8.3 — XHR client for `POST /admin/api/studio/asset-upload` (progress events; the one sanctioned `apiRequest` exception, same as `useUploadQueue`). |
| 🟢 `src/admin/pages/site/studio/boardsApi.ts` | `/admin/api/studio/boards` client. |
| 🟢 `src/admin/pages/site/studio/ImportProjectDialog.tsx` | The import dialog — GitHub / Upload / Local folder tabs, one ingest engine. |
| 🟢 `src/admin/pages/site/studio/importGithubProject.ts` | GitHub import request helper. |
| 🟢 `src/admin/pages/site/studio/importUploadProject.ts` | Upload/local-folder import client (XHR, for progress). |
| 🟢 `src/admin/pages/site/studio/downloadStudioCode.ts` | Download-the-code client. |
| 🟢 `src/admin/pages/site/studio/designImport/` | Design-token import (CSS tokens from a package/repo). |
| 🟢 `src/core/studio-board/` | `Board`, `BoardFrame`, `StickyNote`, `DocBlock`, `parseBoardsFile`, `devicePresets`. |

## Canvas

| Path | What it owns |
|---|---|
| 🟡 `src/admin/pages/site/canvas/IframeFrameSurface.tsx` | The iframe primitive: srcDoc boot, portal, event forwarding. |
| 🟡 `src/admin/pages/site/canvas/CanvasRoot.tsx` | Canvas shell, mode switching, centering, agent snapshot mounting. |
| 🟡 `src/admin/pages/site/canvas/CanvasTransformLayer.tsx` | Pan/zoom container; renders all frames. |
| 🟡 `src/admin/pages/site/canvas/BreakpointFrame.tsx` | One viewport frame (CMS-style responsive frames). |
| 🟢 `src/admin/pages/site/canvas/BoardFramesLayer/` | **The Studio board.** Frames, resize, grid, `frameVirtualization.ts`. |
| 🟢 `src/admin/pages/site/canvas/StudioBoardLayers.tsx` | Board layer composition. |
| 🟡 `src/admin/pages/site/canvas/BreakpointSelectionOverlay.tsx` | Selection/hover rings + chrome placement. |
| 🟡 `src/admin/pages/site/canvas/canvasSelectionOverlayPositioning.ts` | Overlay geometry + write-phase no-op cache. |
| 🟡 `src/admin/pages/site/canvas/canvasDomGeometry.ts` | Cross-iframe measurement, `nodeVisualRect`, `panToCenterBreakpointFrame`. |
| 🟢 `src/admin/pages/site/canvas/InPlaceInspector/` | Floating prop editor for a selected component. |
| 🟡 `src/admin/pages/site/canvas/NodeRenderer.tsx` | Node → React element. Inline-edit binding. |
| 🟡 `src/admin/pages/site/canvas/EditorChromeInjector.tsx` | Unlayered editor chrome CSS into each iframe. |
| 🟡 `src/admin/pages/site/canvas/ClassStyleInjector.tsx` | Class registry CSS (`@layer user-authored`). |
| 🟡 `src/admin/pages/site/canvas/UserStylesheetInjector.tsx` | User stylesheets. |
| 🟢 `src/admin/pages/site/canvas/CanvasAnimationInjector.tsx` | Freeze CSS animations in design frames. |
| 🟢 `src/admin/pages/site/canvas/ProjectCssInjector.tsx` | Read-only vendor package CSS into iframes (`@layer vendor`) — Alm's bundled CSS + the open project's own bare-specifier package CSS (WS-2.3). |
| 🟡 `src/admin/pages/site/canvas/canvasCssLayers.ts` | `vendor`/`user-authored` cascade-layer names + ordering pre-declaration. |
| 🟡 `src/admin/pages/site/canvas/useIframeFrameAutoHeight.ts` | Frame height + the definite `body` height `%` chains need. |
| 🟡 `src/admin/pages/site/canvas/AgentSnapshotFrame.tsx` | Offscreen deterministic frame for agent screenshots. |

## Editor store

| Path | What it owns |
|---|---|
| 🟡 `src/admin/pages/site/store/store.ts` | The composed Zustand store. |
| 🟡 `src/admin/pages/site/store/slices/siteSlice.ts` | Site document, `loadSite`, `saveSite`, tree mutations. |
| 🟡 `src/admin/pages/site/store/slices/site/helpers.ts` | `resolveActiveTreeTarget`, `mutateActiveTree` — **the only place that knows which tree is active**. |
| 🟢 `src/admin/pages/site/store/slices/boardSlice.ts` | Boards, frames, positions, sizes. |
| 🟡 `src/admin/pages/site/store/slices/selectionSlice.ts` | Node selection, multi-select. |
| 🟡 `src/admin/pages/site/store/slices/canvasSlice.ts` | `canvasView` (design/live), zoom/pan, `runScripts`, `activeBreakpointId`. |
| 🟡 `src/admin/pages/site/store/slices/inlineEditSlice.ts` | In-place contentEditable sessions. |
| 🟡 `src/admin/pages/site/store/slices/styleRuleSlice.ts` | Class registry mutations. |
| 🟡 `src/core/page-tree/mutations.ts` | **All tree mutations**, tree-agnostic. |

## Panels / UI

| Path | What it owns |
|---|---|
| 🟢 `src/admin/pages/site/panels/PropertiesPanel/` | The right sidebar. `StyleSurface`, `ClassPicker`, `LayoutSection`, `SizeSection`, `PositionSection`, `TypographySection`, `BackgroundSection`, `SpacingBoxControl`, `SourceLockedNotice`, `SharedComponentNotice`, `ImageSourceSection` (WS-8.3 image picker, dispatched from `renderModuleTabContent`). |
| 🟢 `src/admin/pages/site/property-controls/` | Per-prop control dispatch. `CodeValueControl` = read-only stand-in. |
| 🟡 `src/admin/pages/site/sidebars/` | LeftSidebar, RightSidebar, PanelRail. |
| 🟡 `src/admin/pages/site/panels/DomPanel/` | Layer tree. |
| 🟢 `src/admin/pages/site/panels/DependenciesPanel/` | Project dependencies. |
| 🟡 `src/ui/components/` | **Shared primitives — every interactive control must use these.** |
| 🟡 `src/styles/globals.css` | **All design tokens.** No hex anywhere else. |

## Modules

| Path | What it owns |
|---|---|
| 🟡 `src/modules/base/` | `base.container`, `base.text`, `base.button`, `base.image`, `base.link`, `base.svg`, … |
| 🟢 `src/modules/alm/register.tsx` | Design-system components as modules. Build-time manifest. **WS-3 replaces this.** |
| 🟢 `src/modules/alm/manifest.generated.json` | 39 component specs. Produced by `scripts/gen-alm-manifest.mjs`. |
| 🟡 `src/core/module-engine/` | Module registry, schema, validation. |

## AI / MCP

| Path | What it owns |
|---|---|
| 🟡 `server/ai/mcp/registry.ts` | Which tools MCP exposes + capability filtering. |
| 🟡 `server/ai/mcp/editorBridge.ts` | Routes browser tools to the open workspace. |
| 🟡 `server/ai/mcp/tools/` | `contextTool`, `documentTools`, `styleTools`, `publishTool`, `studioImportTool`. |
| 🟡 `server/ai/tools/site/` | The built-in agent's site tools, incl. `site_render_snapshot`. |

## Tests

| Path | What it owns |
|---|---|
| 🟡 `src/__tests__/architecture/` | ~90 gate tests. **If you change a structural rule, change its gate here.** |
| 🟢 `src/core/page-parser/__tests__/` | Evaluator, inlining, loop expansion, generic repo shapes. |
| 🟢 `src/__tests__/studio/` | Studio behaviour tests. |
| 🟡 `src/__tests__/setup.ts` | happy-dom setup, iframe global patching. |
| 🟡 `src/admin/pages/site/canvas/__tests__/iframeCanvasQuery.ts` | **Required** to query canvas DOM in tests. |
| 🟡 `tests/e2e/` | Playwright. Studio-relevant specs only. |

## Not ours (dormant CMS)

⚪ `server/handlers/cms/` · `server/repositories/` · `server/db/` ·
`server/publish/` · `server/plugins/` · `src/admin/pages/{content,data,dashboard,media,plugins,users}/` ·
`src/core/publisher/` · `src/core/plugin-sdk/` · `src/core/plugins/`

Touch only when a Studio change genuinely requires it, and say so in the handoff.
