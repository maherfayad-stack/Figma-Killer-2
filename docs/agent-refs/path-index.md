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
| 🟢 `server/handlers/studioCss.ts` | Imported `.css` → `StyleRule` registry, deterministic ids, happy-dom CSSOM. |
| 🟢 `server/handlers/studioAsset.ts` | `GET /admin/api/studio/asset` + all path-containment guards. |
| 🟢 `server/handlers/studioGithubImport.ts` | GitHub zipball fetch, zip-entry safety, target-dir rules. |
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
| 🟢 `src/core/page-parser/assetImports.ts` | `?raw` text imports, image imports → `studio-asset:` sentinel. |
| 🟢 `src/core/page-parser/inlineSvg.ts` | `<svg>` written as JSX → markup for `base.svg`. |
| 🟢 `src/core/page-parser/jsxAttributeReaders.ts` | How each attribute shape is read. |
| 🟢 `src/core/page-parser/resolutionLock.ts` | Resolved value → lock + `resolution`. |
| 🟢 `src/core/ast-codemods/` | **Every source write.** `setJsxProp`, `setJsxText`, `setJsxStyle`, `setStringLiteral`, `setJsxTagName`. |
| 🟢 `src/core/studio-sync/parsedPageToSitePage.ts` | `ParsedPage` → editor `Page` (moduleId, text prop, classIds, codeProps). |
| 🟢 `src/core/studio-sync/collectPageStylesheets.ts` | Which `.css` a page depends on, in cascade order. |
| 🟢 `src/core/page-tree/sourceNodeId.ts` | **The node-id grammar.** Separators, decode, "is there one place to write this?" |
| 🟢 `src/core/page-tree/sourceWritability.ts` | `isPropWritableToSource` — the ONE predicate every edit surface asks. |

## Studio: client side

| Path | What it owns |
|---|---|
| 🟢 `src/admin/pages/site/studio/studioMode.ts` | Is Studio mode on? URL `?studio` + sticky localStorage. |
| 🟢 `src/admin/pages/site/studio/fsCodemodAdapter.ts` | Client → save-route adapter. **Mirrors** `INLINE_ID_SEPARATOR` and `ComponentSource` literals on purpose (importing the parser barrel drags ts-morph into the browser bundle). |
| 🟢 `src/admin/pages/site/studio/boardsApi.ts` | `/admin/api/studio/boards` client. |
| 🟢 `src/admin/pages/site/studio/ImportGithubDialog.tsx` | The import dialog. |
| 🟢 `src/admin/pages/site/studio/importGithubProject.ts` | Import request helper. |
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
| 🟢 `src/admin/pages/site/canvas/AlmDesignSystemCssInjector.tsx` | Design-system CSS into iframes. |
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
| 🟢 `src/admin/pages/site/panels/PropertiesPanel/` | The right sidebar. `StyleSurface`, `ClassPicker`, `LayoutSection`, `SizeSection`, `PositionSection`, `TypographySection`, `BackgroundSection`, `SpacingBoxControl`, `SourceLockedNotice`, `SharedComponentNotice`. |
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
