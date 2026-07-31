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
| 🟢 `server/handlers/studio/projectProbe.ts` | WS-1.2 — `dir → ProjectProfile`: framework, pages dir, style toolchain, aliases, component packages, and (`approot-01`) app-root detection (`detectAppRoot`) — a project's app root is not always its project directory (monorepos, `journey-screens/`-style named subdirectories). Every OTHER detector runs rooted at the resolved app root; every returned path is re-prefixed with `appRoot` to stay project-relative. `pagesDir` ranking (`rankPagesDirCandidates`) scores a candidate's whole RECURSIVE subtree, not just its direct files. Also exports `tryServeStudioProbe`, wired into `STUDIO_SUB_ROUTERS`. |
| 🟢 `server/handlers/studio/projectProfileSchema.ts` | Pure schema leaf: `ProjectProfileSchema`/`ProjectProfile`, `ProbeWarning` — kept separate from `projectProbe.ts` to avoid a load cycle with `studioMeta.ts` (which persists a probe result and is read back by the probe for caching). |
| 🟢 `server/handlers/studio/appRoot.ts` | `approot-01` — `resolveAppRoot(dir)`/`joinAppRoot(dir, appRoot)`: `dir → absolute, real-path containment-checked app root`. The one place every `node_modules`/toolchain-touching consumer (`installDeps.ts`, `styleCompile.ts`, `componentBundle.ts`, `packageManifest.ts`'s callers) resolves the app root, instead of five separate joins that can drift apart. |
| 🟢 `server/handlers/studio/studioMeta.ts` | Schema-validated `.studio/meta.json` (`StudioMetaSchema`): `displayName`, `pagesDir` override, `previewLocale`, `trust`, cached `profile` (`ProjectProfileSchema`, includes `appRoot`), `frameDefaults`, `paletteHiddenModuleIds`. |
| 🟢 `server/handlers/studio/styleCompile.ts` | WS-2.1/2.3 — `dir + ProjectProfile → CompiledStyles`. CSS Modules (Tier 0, own transform) + vendor package CSS (`vendorCss` — bare-specifier `.css` imports resolved against the project's own `node_modules`, Tier 0 safe, no trust gate) + `compileProjectStyles`'s overall orchestration + the on-disk cache, cached under `.studio/cache/styles-<hash>.*`. Tier 1 (Sass/PostCSS/Tailwind) itself lives in `styleCompileTier1.ts` (split out to stay under the module-size budget). |
| 🟢 `server/handlers/studio/styleCompileTier1.ts` | `compileSass`/`compilePostcssPipeline` — resolves the workspace's own `sass`/`postcss`/`@tailwindcss/postcss`, gated on trust, spawns `styleCompileWorker.ts` to actually run them. |
| 🟢 `server/handlers/studio/styleCompileWorker.ts` | `sec-01` — the Tier 1 SUBPROCESS entry point. Runs `sass`/`postcss`/`postcss.config.js`/plugin packages OUT of the admin server's own process; reads one `WorkerTask` from argv, writes one `WorkerResult` to stdout. |
| 🟢 `server/handlers/studio/styleCompileFileRead.ts` | Tiny shared leaf: `readCappedFile`, `CSS_MODULE_FILE_RE`, `MAX_STYLESHEET_BYTES` — used by both `styleCompile.ts` and `styleCompileTier1.ts` without a cycle. |
| 🟢 `server/handlers/studio/subprocessRunner.ts` | `sec-01` — the shared spawn+timeout+capped-capture primitive (`runCappedSubprocess`/`captureSubprocess`) and `minimalSubprocessEnv`, used by `styleCompileTier1.ts` and `installDeps.ts`. |
| 🟢 `server/handlers/studio/workspacePackageResolve.ts` | `sec-01` — `resolveWorkspacePackageEntry`/`isRealpathContained`: symlink-containment-checked `<dir>/node_modules/<pkg>` resolution, used by the parent (`styleCompileTier1.ts`) and the subprocess (`styleCompileWorker.ts`) alike. |
| 🟢 `server/handlers/studio/installDeps.ts` | WS-1.4 — `bun install`/etc as a polled job. `sec-01`: uses `subprocessRunner.ts`'s shared capture primitive, explicit minimal env. `approot-01`: `cwd` is the resolved app root (`appRoot.ts`), not necessarily the project directory. `infra-01`: mirrors every job to `.studio/install-job.json` (`installJobStore.ts`) so a `bun --watch` restart resolves to a terminal `'interrupted'` status instead of a phantom `'running'` the client polls forever — see `resolveInstallJobStatus`/`resolvePersistedJobStatus`. |
| 🟢 `server/handlers/studio/installJobStore.ts` | `infra-01` — read/write for `<appRoot>/.studio/install-job.json`, the durability sidecar `installDeps.ts` mirrors its job registry to. Defensive read (never throws), unconditional overwrite (single most-recent job per project, no merge/history). |
| 🟢 `server/handlers/studio/packageManifestSchema.ts` | `pkg-01`/WS-3.1 — pure schema leaf: `PropKind` (the string/number/boolean/enum/color/image/node/handler/unknown classification), `PropSpec`, `ComponentSpec`. |
| 🟢 `server/handlers/studio/packageManifest.ts` | `pkg-01`/WS-3.1 — `dir + package name → ComponentSpec[]`, purely syntactic (`.d.ts` then `.tsx` source, never the type checker, never executes anything — Tier 0 safe on its own). Replaces `scripts/gen-alm-manifest.mjs`'s build-time, `@alm-design`-only extraction with a per-project, per-package one. |
| 🟢 `server/handlers/studio/componentBundle.ts` | `pkg-01`/WS-3.2 — `POST/GET /admin/api/studio/component-bundle`: `tryServeStudioComponentBundle` sub-router. Tier 1 gate, React major-version skew check, demand list (`ProjectProfile.componentPackages`), barrel generation, `.studio/cache/bundle-<hash>.{js,json}`. Wired into `STUDIO_SUB_ROUTERS`. `approot-01`: the react-version check, cache key, manifest extraction, and the generated barrel entry (placed directly at the resolved app root so `Bun.build`'s upward `node_modules` walk finds it) all resolve against the app root, not necessarily the project directory; the artefact itself stays at `.studio/cache/` under the project directory. |
| 🟢 `server/handlers/studio/componentBundleWorker.ts` | `pkg-01`/WS-3.2 — the Tier 1 SUBPROCESS entry point: runs `Bun.build` (a package can execute a Bun macro at build time) out of the admin server's own process, via `subprocessRunner.ts`/`minimalSubprocessEnv()`, same posture as `styleCompileWorker.ts`. |
| 🟢 `server/handlers/studio/trustTier.ts` | `pkg-02`/WS-3.3 — `GET/POST /admin/api/studio/trust-tier`: `tryServeStudioTrustTier` sub-router. Reads/writes `.studio/meta.json`'s `trust` field — the action behind the canvas's "promote this project" placeholder. |
| 🟢 `src/core/module-engine/packageModuleId.ts` | `pkg-02`/WS-3.3 — `packageModuleId`/`sanitizePackageName`: the one `pkg.<sanitized-package>.<ComponentName>` naming scheme, shared by `studioPageLoad.ts`'s `resolveModuleId`, `componentBundle.ts`'s barrel generation, and `registerProjectModules.ts`. |
| 🟢 `src/core/utils/studioSlotSentinel.ts` | `pkg-02`/WS-3.4 — `studio-slot:<nodeId>` sentinel: a package-component prop value referencing a materialized slot child node. Dependency-free (no ts-morph) so both the parser (server) and `registerProjectModules.ts` (browser) can import it. |
| 🟢 `server/handlers/studioAsset.ts` | `GET /admin/api/studio/asset` + all path-containment guards. |
| 🟢 `server/handlers/studioGithubImport.ts` | GitHub zipball fetch (URL parsing, zipball URL, download). |
| 🟢 `server/handlers/studio/archiveIngest.ts` | Shared ingest engine (entry decision, budgets, target-dir clear+write) behind both the GitHub and upload import routes. |
| 🟢 `server/handlers/studio/importUpload.ts` | `POST /admin/api/studio/import-upload` — uploaded `.zip` or a picked folder, via `archiveIngest.ts`. |
| 🟢 `server/handlers/studio/assetUpload.ts` | WS-8.3 — `POST /admin/api/studio/asset-upload`: `tryServeStudioAssetUpload` sub-router. Symlink-aware `targetDir` containment, byte-sniffed content type, collision-safe filename. Not yet wired into `STUDIO_SUB_ROUTERS` — see `asset-01` in `STATE.md`. |
| 🟢 `server/handlers/studioDownload.ts` | "Download the code" — zips the workspace. Not codegen. |
| 🟢 `server/handlers/studioFramework.ts` | `.studio/framework.json` sidecar (colors/typography/spacing). |
| 🟢 `server/handlers/studio/tokenExtract.ts` | `tokens-01` — `GET/POST /admin/api/studio/tokens`: `tryServeStudioTokens` sub-router. Orchestrates the three token sources (project-css / tailwind-theme / vendor-css), `extractProjectTokens`, and the never-clobber `mergeExtractedFramework`. Wired into `STUDIO_SUB_ROUTERS`. |
| 🟢 `server/handlers/studio/tokenExtractCssScan.ts` | `tokens-01` — the `:root` custom-property scan + `var()` resolution + value-first classification engine (`classifyCssText`). `infra-01`: `classifyDeclaration`/`resolveVarValue`/`collectRootScopeMaps`/`toPx` are exported and now ALSO the classification engine behind `server/handlers/designImport/parseCssTokens.ts` — one engine, two triggers (automatic vs. manual/external import). |
| 🟢 `server/handlers/studio/tokenExtractTailwind.ts` | `tokens-01` — static (non-executing) `theme.extend` colors/spacing/fontSize reader for a Tailwind config file. |
| 🟢 `server/handlers/studio/tokenExtractBuild.ts` | `tokens-01` — `ClassifiedTokens → FrameworkSettings` (color tokens, one spacing/typography scale group per naming prefix). |

## Studio: parsing and codegen (the engine)

| Path | What it owns |
|---|---|
| 🟢 `src/core/page-parser/parsePageFile.ts` | The ts-morph JSX walk → `ParsedPage`. **Never throws.** |
| 🟢 `src/core/page-parser/inlineLocalComponents.ts` | Local-component expansion, composite ids — WS-4.2: the call site becomes an `instanceOf`-carrying "instance" node (`children` = the inlined subtree), never deleted/spliced. |
| 🟢 `src/core/page-parser/componentSubstitution.ts` | Call-site props → the component's own JSX (`applySubstitutions`). |
| 🟢 `src/core/page-parser/staticLoopExpansion.ts` | `.map` over a resolved array → one node per item. |
| 🟢 `src/core/page-parser/staticEval.ts` | Public composer for the value evaluator. |
| 🟢 `src/core/page-parser/staticEvalCore.ts` | Tier A + recursive walker + binding resolution. |
| 🟢 `src/core/page-parser/staticEvalCalls.ts` | Tier B (hook → provider) + Tier C (pure calls). |
| 🟢 `src/core/page-parser/staticEvalOperators.ts` | Tier A operators, `Math.*`, `\|\|`/`&&`/`??`. |
| 🟢 `src/core/page-parser/defaultLiteralBindings.ts` | parser-07: a binding's own FIRST-PAINT literal — a `useState(<default>)` arg or a destructured param's `= <default>`. Pure AST leaf; returns the `Node`, never a value. |
| 🟢 `src/core/page-parser/branchSelection.ts` | Which branch renders: multi-return, `? :`, `&&`, `\|\|`, `??`. Records the untaken side as `branchAlternatives`. |
| 🟢 `src/core/page-parser/componentSources.ts` | local vs package classification; the workspace-wide ts-morph `Project` (**tsconfig `paths` already resolve here**). |
| 🟢 `src/core/page-parser/assetImports.ts` | `?raw` text imports, image imports → `studio-asset:` sentinel + `ParsedNode.assetOrigin` (WS-8.3, the import specifier's own location), `.module.css` imports → `{ localName: globalName }` (WS-2.2, sourced from `styleCompile.ts`'s `moduleClassMaps`). |
| 🟢 `src/core/page-parser/inlineSvg.ts` | `<svg>` written as JSX → markup for `base.svg`. |
| 🟢 `src/core/page-parser/jsxAttributeReaders.ts` | How each attribute shape is read. |
| 🟢 `src/core/page-parser/resolutionLock.ts` | Resolved value → lock + `resolution`. |
| 🟢 `src/core/ast-codemods/` | **Every source write.** `setJsxProp`, `setJsxText`, `setJsxStyle`, `setStringLiteral`, `setJsxTagName`, `setImportSpecifier` (WS-8.3), `detachComponent`/`extractComponentCopy`/`swapComponentInstance` (WS-4.4/4.5), `resolveComponentCallSite` (shared "what does this JSX tag refer to" resolution the three of them share). |
| 🟢 `src/core/studio-sync/parsedPageToSitePage.ts` | `ParsedPage` → editor `Page` (moduleId, text prop, classIds, codeProps) — WS-4.2: an `instanceOf` node's `props` become `{componentName, source, sourceFile, callSiteProps}`, codeProps prefixed `callSiteProps:<name>`. |
| 🟢 `src/modules/base/instance/` | WS-4.2 — `studio.instance` module: renders `<>{children}</>`, zero DOM. |
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
| 🟢 `src/admin/pages/site/studio/designImport/` | **Manual** design-token import — user pastes a GitHub URL or npm package spec, previews classified candidates, picks which to apply. Server side: `server/handlers/designImport.ts` + `designImport/parseCssTokens.ts`. `infra-01`: CSS classification now calls straight into `tokenExtractCssScan.ts`'s shared engine (value-first, `var()`-resolved) instead of a separately-drifting name-hint-first classifier — JSON/JS extraction (`extractJsonTokens`/`extractJsTokens`, unique to this manual wizard) stays local, classified through the SAME shared `classifyDeclaration`. Distinct TRIGGER from `tokens-01`'s `tokenExtract.ts` (manual/external source vs. automatic against the currently-open project's own CSS) — one engine, two triggers, not two engines. |
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
| 🟢 `src/modules/alm/register.tsx` | Design-system components as modules, hardcoded to `@alm-design/design-system`, build-time manifest. **Kept per `standing-07`** — not deleted until `registerProjectModules.ts` is PROVEN to render the eSIM board equivalently. |
| 🟢 `src/modules/alm/manifest.generated.json` | 39 component specs. Produced by `scripts/gen-alm-manifest.mjs`. |
| 🟢 `src/admin/pages/site/studio/registerProjectModules.ts` | `pkg-02`/WS-3.3 + WS-3.4 — the generic consumer of `pkg-01`'s manifest/bundle work. `useRegisterProjectModules()` (mounted from `AdminCanvasEditorBody.tsx`) fetches `POST /admin/api/studio/component-bundle` and registers a `pkg.*` module per component, lazily (Tier ≥ 1 + an unregistered `pkg.*` node on the board), undoable on project switch. `revivePropValue` renders WS-3.4 slot sentinels through `NodeRenderer`. |
| 🟢 `src/admin/pages/site/studio/studioProjectTrust.ts` | `pkg-02`/WS-3.3 — per-project trust-tier external store + `promoteProjectToTier1` (the "promote this project" consent action) + the last `component-bundle` refusal status. Split out of `fsCodemodAdapter.ts` to stay under the module-size ceiling. |
| 🟢 `src/admin/pages/site/canvas/PackageComponentPlaceholder.tsx` | `pkg-02`/WS-3.3 — `NodeRenderer.tsx`'s fallback for an unregistered `pkg.*` node: Tier-0 "promote this project" button, a bundle-refusal message, or a loading state. Styled via `EditorChromeInjector.tsx`'s `[data-studio-package-placeholder]` (renders inside the per-frame iframe — CSS Modules don't reach there). |
| 🟡 `src/core/module-engine/` | Module registry, schema, validation. |

## AI / MCP

| Path | What it owns |
|---|---|
| 🟡 `server/ai/mcp/registry.ts` | Which tools MCP exposes + capability filtering. |
| 🟡 `server/ai/mcp/editorBridge.ts` | Routes browser tools to the open workspace. |
| 🟡 `server/ai/mcp/tools/` | `contextTool`, `documentTools`, `styleTools`, `publishTool`, `studioImportTool`, `studio/` (WS-9: project orientation, bulk edits, codemods, fidelity report, visual-audit trio — `exportFrames.ts`/`referenceRender.ts`/`diffFrames.ts`). |
| 🟡 `server/ai/mcp/resources.ts` | Static MCP resources (`studio://guidelines`) — read-only reference content, not tools. |
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
