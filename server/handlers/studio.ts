/**
 * Studio source-writeback endpoints — the filesystem side of the
 * "canvas edit ⇄ real .tsx source" loop.
 *
 *   GET  /admin/api/studio/load?dir=<abs>
 *       Recursively walks the project's pages directory — `<dir>/pages` by
 *       default, or `.studio/meta.json`'s `pagesDir` override for a
 *       real-world repo whose screens live elsewhere (e.g. `src/screens` —
 *       see `projectPagesDir`) — (Phase 7A — multi-file project backend;
 *       nested route/page dirs like `pages/marketing/Landing.tsx` are
 *       discovered, not just a flat top-level scan) and parses EVERY
 *       `.tsx`/`.jsx` file into an Studio `Page` (multi-frame board). Node ids
 *       stay `relFile:line:col`
 *       (from page-parser), `relFile` always relative to the WORKSPACE ROOT
 *       (not the pages dir), so the client can ask us to write a specific
 *       node's prop straight back to source no matter how deep its file
 *       sits, and the save handler below needs no changes to keep working.
 *       The parse → local-component-inline → Studio-`Page` conversion
 *       pipeline itself — including the `componentSources` local/package
 *       classification and the `STUDIO_ASSET_SENTINEL` → fetchable-URL
 *       rewrite (§5.1/§5.2) — lives in `loadStudioPages`; see
 *       `server/handlers/studioPageLoad.ts`'s module doc for the full
 *       walkthrough. This route is just dir resolution + error mapping.
 *       (Under /admin/api so the Vite dev proxy forwards it to the :3001 server.)
 *       `?pageIds=<comma-separated ids>` narrows `pages` to that subset (meta
 *       stays full); unmatched ids report via `missingPageIds` — see `studio/studioLoadResponse.ts`.
 *
 *   GET  /admin/api/studio/asset?dir=<abs>&path=<workspace-rel>
 *       Serves one workspace-relative asset file (an imported page's local
 *       images — §5) through the existing static-file pipeline. The
 *       resolution + adversarial-input guarding (absolute/UNC paths, `..`
 *       traversal on either separator, excluded dir names, symlink escape)
 *       lives in `resolveStudioAssetResponse` — see
 *       `server/handlers/studioAsset.ts`'s module doc for the full rationale.
 *       404 on anything rejected or missing.
 *
 *   POST /admin/api/studio/save   body: { dir, edits: StudioEdit[] }
 *       A batch of typed edits (`kind: 'prop' | 'text' | 'style'`). The edit
 *       model (`StudioEdit`), the bottom-to-top apply ordering, and the
 *       per-edit dir+edit→codemod dispatch (`applyStudioEdit`) live in
 *       `server/handlers/studioWriteback.ts` — see its module doc. Synthetic
 *       nodes (e.g. the `index:body` root) don't match the loc pattern and
 *       are skipped. Each edit is applied independently — one codemod
 *       throwing (e.g. a text edit landing on an element with mixed
 *       children) is logged and skipped by this route rather than aborting
 *       the whole batch.
 *
 *   POST /admin/api/studio/import-github   body: { url, ref?, subdir?, token?, pagesDir? }
 *       Phase 7B — GitHub-link import. Fetches the repo's zipball
 *       (`server/handlers/studioGithubImport.ts` owns URL parsing, the
 *       fetch, the zip-entry safety/size guards, and the write) into a
 *       repo-scoped `studio-workspace/<owner>-<repo>/` directory —
 *       never the hand-authored `studio-workspace/` — and returns
 *       `{ ok, dir, files, skipped }`. `pagesDir`, when given, is written to
 *       the new project's `.studio/meta.json` (see `GithubImportBodySchema`'s
 *       doc comment) so a repo whose screens don't live at the default
 *       `<dir>/pages` is still discoverable. The client then calls this same
 *       `/admin/api/studio/load?dir=<returned dir>` to load it: import is
 *       "fetch source, then load it via the existing multi-file loader," not
 *       a second parsing path.
 *
 *   GET  /admin/api/studio/download?dir=<abs>
 *       Phase 6D — "Download the code". NOT codegen: the filesystem is
 *       already the source of truth, so this just zips it up.
 *       `collectWorkspaceFiles` walks `dir` and returns every real source
 *       file (relPath + contents), applying a fixed exclusion/size/count
 *       policy (see its doc comment). The handler zips the result with
 *       `fflate` and streams it back as `application/zip`. If the workspace
 *       already has a `package.json` it is included as-is; otherwise a
 *       minimal one recording the `@alm-design/design-system` dependency is
 *       synthesized so `bun install && bun run dev` works in the unzipped
 *       copy. `node_modules` is never bundled either way.
 *
 * Routes owned by `studio/projectRoutes.ts` (its own sub-router, documented
 * there — see that module's doc for the full behavioural writeup):
 *
 *   GET  /admin/api/studio/projects
 *   POST /admin/api/studio/create   body: { name? }
 *   POST /admin/api/studio/rename   body: { dir?, name }
 *   POST /admin/api/studio/page     body: { dir?, name? }
 *
 *   GET  /admin/api/studio/framework?dir=<abs>
 *       Reads the project's `.studio/framework.json` sidecar (colors/
 *       typography/spacing/preferences). `{ framework: null }` when nothing
 *       is stored yet — the client keeps its own default in that case. See
 *       `studioFramework.ts`'s doc comment for why this file exists.
 *
 *   POST /admin/api/studio/framework   body: { dir?, framework }
 *       Validates `framework` against `FrameworkSettingsSchema` and writes it
 *       to `.studio/framework.json`. 400 on an invalid shape.
 *
 * Routes owned by a sub-router (see `STUDIO_SUB_ROUTERS` below), documented
 * in the module they live in rather than here:
 *
 *   GET/POST /admin/api/studio/probe          → `studio/projectProbe.ts`
 *       WS-1.2 — derives a `ProjectProfile` (framework, pages dir, style
 *       toolchain, aliases, component packages) by reading files only. GET
 *       serves the `.studio/meta.json` cache and never writes; POST re-probes
 *       and persists.
 *
 *   POST /admin/api/studio/import-upload      → `studio/importUpload.ts`
 *       WS-1.1 — the same ingest engine `import-github` uses, fed by an
 *       uploaded `.zip` or an `<input webkitdirectory>` folder instead of a
 *       fetched zipball. Entry decisions, size/count budgets, and the
 *       traversal guards all live in `studio/archiveIngest.ts` and are shared
 *       by both routes; the target directory is derived server-side here for
 *       the same reason `import-github`'s schema has no `dir` field.
 *
 *   POST/GET /admin/api/studio/component-bundle → `studio/componentBundle.ts`
 *       WS-3.2 — bundles the project's own package components for the canvas.
 *       Tier 1: `Bun.build` runs in a subprocess (a package may execute a Bun
 *       macro at build time), and React is `external`, resolved through the
 *       plugin runtime's existing import map so the bundle shares the admin's
 *       React instance — two copies would mean "Invalid hook call". Refuses at
 *       Tier 0 and on a React major mismatch rather than crashing later.
 *
 *   POST /admin/api/studio/asset-upload       → `studio/assetUpload.ts`
 *       WS-8.3 — writes an uploaded image into the workspace so an
 *       import-bound `<img src={heroImg}>` can be repointed. Content type is
 *       decided by magic-number sniffing, never by the declared filename or
 *       MIME; containment is checked on the real path after resolving
 *       symlinks, walking to the nearest existing ancestor for a target
 *       directory that does not exist yet.
 *
 *   POST/GET/DELETE /admin/api/studio/reference-upload → `studio/referenceUpload.ts`
 *       The durable design-reference store's browser HTTP surface — lands a
 *       lossless design comp (typically a Figma export) into
 *       `.studio/references/`, the same store `studio_register_design_
 *       reference`/`studio_list_design_references`/`studio_diff_frames`'s
 *       `referenceId` input read over MCP. GET/DELETE address "the project's
 *       most recently registered reference" and "remove by id" respectively.
 *
 *   GET/POST /admin/api/studio/trust-tier      → `studio/trustTier.ts`
 *       WS-3.3 — reads/writes `.studio/meta.json`'s `trust` field. The action
 *       behind the canvas's "promote this project" placeholder for an
 *       unregistered `pkg.*` node — see `NodeRenderer.tsx`'s
 *       `PackageComponentPlaceholder`.
 *
 *   POST /admin/api/studio/extract-component   → `studio/extractComponent.ts`
 *       instance-ui-01 — the detach-refusal escape hatch (`extractComponentCopy`)
 *       as a plain route the admin browser can call: duplicate a component
 *       under a fresh name and repoint just the one call site. The Properties
 *       panel's "Duplicate as Card2.tsx and edit that instead?" offer.
 *
 *   POST /admin/api/studio/install            → `studio/installDeps.ts`
 *   GET  /admin/api/studio/install/:id
 *   GET  /admin/api/studio/install/status
 *       WS-1.4 — `bun install --ignore-scripts` as a polled job. A 3-minute
 *       install cannot sit inside one HTTP round trip, and `--ignore-scripts`
 *       is mandatory: a postinstall script is arbitrary code execution, which
 *       must not happen before the user consents to a trust tier that allows
 *       it.
 *
 *   GET/POST /admin/api/studio/preview-axes    → `studio/previewAxes.ts`
 *       WS-10 Phase 1 — reads/writes `.studio/meta.json`'s `previewAxes`
 *       field (direction, color scheme; per-project, per D5). The toolbar's
 *       RTL / dark-mode toggle.
 *
 *   GET  /admin/api/studio/components          → `studio/components.ts`
 *       Track E1 (`STUDIO-FIGMA-PARITY-PLAN.md` §8) — the project-wide
 *       component catalog: every exported, PascalCase-named LOCAL component
 *       in the workspace, with its props' `PropKind` where a type annotation
 *       makes that readable. Read-only, off the same `createWorkspaceProject`
 *       ts-morph `Project` the page-parse pipeline already builds.
 *
 *   POST /admin/api/studio/reload-scope        → `studio/reloadScope.ts`
 *       Track C5 (`STUDIO-FIGMA-PARITY-PLAN.md` §6, reload surgery) — given
 *       the workspace-relative files a batch of edits just wrote (the `/save`
 *       response's `touchedFiles`), decides whether a targeted per-page
 *       reload (the existing `GET /load?pageIds=` filter) is safe, or the
 *       caller must fall back to a full, unfiltered reload. See that module's
 *       doc for exactly when a single-file reload is sufficient and when it
 *       widens.
 *
 * This module is the HTTP routing layer only — request wiring, body
 * validation, and error-envelope mapping. The actual page-parser/ast-codemods
 * work (Node/ts-morph, never the browser) lives in sibling modules by
 * responsibility: `studioAsset.ts` (asset serving), `studioWriteback.ts`
 * (source writeback), `studioPageLoad.ts` (the parse pipeline),
 * `studioProjects.ts`, `studioFramework.ts`, `studioDownload.ts`, and
 * `studioGithubImport.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { createBoardsFile, parseBoardsFile, serializeBoardsFile, type BoardsFile } from '@core/studio-board'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, ndjsonResponse, readValidatedBody } from '../http'
import { GithubImportError, parseGithubRepoUrl, runGithubImport } from './studioGithubImport'
import {
  mergeProjectFrameDefaults,
  projectDisplayName,
  resolveProjectDir,
  writeProjectMeta,
} from './studioProjects'
import { readStudioMeta, DEFAULT_TRUST_TIER } from './studio/studioMeta'
import { readStudioFrameworkFile, writeStudioFrameworkFile } from './studioFramework'
import { buildStudioDownloadResponse } from './studioDownload'
import { resolveStudioAssetResponse } from './studioAsset'
import { loadStudioPages } from './studioPageLoad'
import { filterStudioLoadPages, parseStudioLoadPageIdsParam, studioLoadStreamLines } from './studio/studioLoadResponse'
import { applyStudioEditBatch, StudioEditSchema } from './studioWriteback'
import { probeProject, tryServeStudioProbe } from './studio/projectProbe'
import { mergeStudioMeta } from './studio/studioMeta'
import { tryServeStudioInstall } from './studio/installDeps'
import { tryServeStudioIngest } from './studio/importUpload'
import { tryServeStudioAssetUpload } from './studio/assetUpload'
import { tryServeStudioReferenceUpload } from './studio/referenceUpload'
import { tryServeStudioComponentBundle } from './studio/componentBundle'
import { tryServeStudioTokens } from './studio/tokenExtract'
import { tryServeStudioTrustTier } from './studio/trustTier'
import { tryServeStudioExtractComponent } from './studio/extractComponent'
import { tryServeStudioPreviewAxes } from './studio/previewAxes'
import { tryServeStudioLocalizedPage } from './studio/localizedPage'
import { tryServeStudioComponents } from './studio/components'
import { tryServeStudioProjectRoutes } from './studio/projectRoutes'
import { tryServeStudioReloadScope } from './studio/reloadScope'

/**
 * Sub-routers for the newer studio namespaces, each owning one concern and its
 * own `/admin/api/studio/<name>` paths. They are consulted before this module's
 * own route table below.
 *
 * Route handling lives with the feature rather than in this file for the same
 * reason `server/router.ts` composes an array of `tryServe*` handlers instead
 * of one switch: a single shared route table is the file every concurrent
 * change has to touch, and it grows without bound. Each entry returns `null`
 * for a path it does not own, so ordering here is not load-bearing.
 */
const STUDIO_SUB_ROUTERS = [
  tryServeStudioProbe,
  tryServeStudioInstall,
  tryServeStudioIngest,
  tryServeStudioAssetUpload,
  tryServeStudioReferenceUpload,
  tryServeStudioComponentBundle,
  tryServeStudioTrustTier,
  tryServeStudioTokens,
  tryServeStudioExtractComponent,
  tryServeStudioPreviewAxes,
  tryServeStudioLocalizedPage,
  tryServeStudioComponents,
  tryServeStudioProjectRoutes,
  tryServeStudioReloadScope,
] as const

/** Body of POST /admin/api/studio/save — a batch of typed source writebacks. */
const SaveBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  edits: Type.Optional(Type.Array(StudioEditSchema)),
})

/**
 * Body of POST /admin/api/studio/boards. `boards` stays `Unknown` at the
 * boundary because `parseBoardsFile` is the real validator — it defensively
 * coerces any payload into a well-formed BoardsFile — so there is no parallel
 * TypeBox mirror of the board model to drift.
 */
const BoardsPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  boards: Type.Unknown(),
})

/**
 * Body of POST /admin/api/studio/framework. `framework` stays `Unknown` at
 * the boundary because `writeStudioFrameworkFile` is the real validator (via
 * `FrameworkSettingsSchema`) — no parallel mirror to drift.
 */
const FrameworkPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  framework: Type.Unknown(),
})

/**
 * Body of POST /admin/api/studio/frame-defaults (WS-7.2 — "apply to all
 * pages"). Both fields optional: a bulk width-only apply must be able to
 * merge without touching a previously-saved default height.
 */
const FrameDefaultsBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  width: Type.Optional(Type.Number({ minimum: 1 })),
  height: Type.Optional(Type.Number({ minimum: 1 })),
})

/**
 * Body of POST /admin/api/studio/import-github (Phase 7B).
 *
 * Deliberately has NO `dir` field. `runGithubImport` clears its target
 * directory before repopulating it, so a caller-supplied target would be an
 * arbitrary recursive-delete primitive driven by a request body. The import
 * target is therefore always derived server-side from the parsed repo
 * (`studio-workspace/<owner>-<repo>`); `runGithubImport`'s `dir`
 * option stays internal (tests only) and is never sourced from the wire.
 *
 * `token`, when present, is forwarded as a Bearer credential and never logged
 * or echoed back.
 *
 * `pagesDir`, when present, is NOT forwarded to `runGithubImport` at all — it
 * has nothing to do with fetching/writing the repo. It's persisted to the
 * freshly-imported project's `.studio/meta.json` afterwards (§1.1's
 * `pagesDir` override) so a repo whose screens don't live at the
 * hand-authored default of `<dir>/pages` (e.g. `src/screens`) is discoverable
 * without restructuring the imported source.
 */
const GithubImportBodySchema = Type.Object({
  url: Type.String(),
  ref: Type.Optional(Type.String()),
  subdir: Type.Optional(Type.String()),
  token: Type.Optional(Type.String()),
  pagesDir: Type.Optional(Type.String()),
})

export async function tryServeStudio(
  req: Request,
  _runtime: unknown,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  for (const subRouter of STUDIO_SUB_ROUTERS) {
    const response = await subRouter(req, url, pathname)
    if (response) return response
  }

  if (pathname === '/admin/api/studio/load' && req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const projectName = projectDisplayName(dir)
      const pageIdsParam = parseStudioLoadPageIdsParam(url.searchParams.get('pageIds')) // see studioLoadResponse.ts
      if (pageIdsParam === null) return badRequest('invalid pageIds query param')
      const loaded = await loadStudioPages(dir) // always full — meta is project-wide, filtered below
      const { componentSources, styleRules, styleRuleSources, conditions, vendorCss } = loaded
      const { pages, missingPageIds } = filterStudioLoadPages(loaded.pages, pageIdsParam)
      // WS-3.3 — the client needs the CURRENT trust tier to decide whether an
      // unregistered `pkg.*` node should fetch a component bundle (Tier ≥ 1)
      // or render the "promote to render" placeholder (Tier 0, the default
      // for every fresh import — `meta-03` decision 1). Read fresh, same
      // posture as every other read path here (never auto-promoted).
      const meta = readStudioMeta(dir)
      const trust = meta.trust ?? DEFAULT_TRUST_TIER
      const paletteHiddenModuleIds = meta.paletteHiddenModuleIds ?? []

      // WS-5.5 — `?stream=1` (the canvas's own loader, `fsCodemodAdapter.ts`)
      // gets the SAME computed result as an NDJSON stream instead of one
      // buffered JSON body: a meta line first, then one line per page. Every
      // other caller (tests, MCP tools reading over HTTP, tooling) keeps the
      // single-envelope response unchanged below — see `studioPageLoad.ts`'s
      // `pageParseCache.ts` doc for why the actual PARSE cost (the ts-morph
      // pass) is already resolved by the time either response starts: the
      // real win here is TTFB (the client starts receiving/parsing page 1's
      // bytes before the LAST page's `JSON.stringify` even runs) and
      // per-line parse/validate work overlapping with network I/O, not
      // interleaved server-side parsing — that would need `loadStudioStyles`'s
      // site-wide class-id registry to resolve per-page, which this change
      // does not attempt.
      if (url.searchParams.get('stream') === '1') {
        return ndjsonResponse(studioLoadStreamLines({
          dir, projectName, componentSources, styleRules, styleRuleSources, conditions, vendorCss, trust, paletteHiddenModuleIds, pages, missingPageIds,
        }))
      }

      return jsonResponse({
        dir,
        projectName,
        pages,
        componentSources,
        styleRules,
        styleRuleSources,
        conditions,
        vendorCss,
        trust,
        paletteHiddenModuleIds,
        missingPageIds,
      })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/studio/asset' && req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const rawPath = url.searchParams.get('path')
      if (!rawPath) return new Response('Not found', { status: 404 })
      const response = await resolveStudioAssetResponse(dir, rawPath, req)
      return response ?? new Response('Not found', { status: 404 })
    } catch (err) {
      console.error('[studio]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (pathname === '/admin/api/studio/save' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, SaveBodySchema)
      if (!body) return badRequest('invalid save body')
      const dir = resolveProjectDir(body.dir)
      const edits = body.edits ?? []

      // Ordering, dedup, per-edit try/catch, and shift/shared-component
      // detection all live in `applyStudioEditBatch` — the single engine both
      // this route and `studio_apply_edits` (MCP) run through.
      const { written, skipped, shifted, sharedComponents, refusals, swapDetails, createdStylesheets, unexplainedSkips, touchedFiles } =
        applyStudioEditBatch(dir, edits)

      if (skipped > 0) console.error(`[studio] save: ${written} written, ${skipped} skipped`)
      // WS-4.4/4.5 — `refusals` names WHY a `detach`/`swap` edit specifically
      // didn't write (a typed reason + message), so the client can show that
      // instead of a generic "skipped" toast — see `StudioEditRefusal`'s doc.
      // `swapDetails` — instance-ui-01 — is the mirror for a SUCCESSFUL swap:
      // which props were dropped / still need a value, per `StudioEditSwapDetail`.
      // `createdStylesheets` — Track B1 — is the mirror for a SUCCESSFUL
      // `css`/`create` edit: the stylesheet the server actually invented, so
      // the client can show WHICH file was created (never silent) and record
      // it writable for the next edit — see `StudioEditBatchResult`'s doc.
      // `unexplainedSkips` — item 0.7 — names the node(s) behind every skip
      // that ISN'T covered by `refusals`, so the client can point at them
      // instead of only reporting a bare count.
      // Track C5 — `touchedFiles`, workspace-ROOT-relative (never the raw
      // absolute path — same posture as every other client-facing field here),
      // so `commitStructural` can ask `/reload-scope` whether a targeted
      // per-page reload is safe instead of always reparsing the whole project.
      return jsonResponse({
        ok: true,
        written,
        skipped,
        shifted,
        sharedComponents,
        refusals,
        swapDetails,
        createdStylesheets,
        unexplainedSkips,
        touchedFiles: touchedFiles.map((file) => relative(dir, file).split(sep).join('/')),
      })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Board spatial metadata (frames + sticky notes) — editor-owned, lives in
  // <dir>/.studio/boards.json. Never affects the app runtime.
  if (pathname === '/admin/api/studio/boards' && req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const file = join(dir, '.studio', 'boards.json')
      const boards = existsSync(file) ? parseBoardsFile(readFileSync(file, 'utf8')) : createBoardsFile()
      return jsonResponse({ dir, boards })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/studio/boards' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, BoardsPostBodySchema)
      if (!body) return badRequest('invalid boards body')
      const dir = resolveProjectDir(body.dir)
      const file = join(dir, '.studio', 'boards.json')
      // Re-parse the incoming payload so we only ever write a valid, normalized file.
      const boards: BoardsFile = parseBoardsFile(body.boards)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, serializeBoardsFile(boards))
      return jsonResponse({ ok: true, boards })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // WS-7.2 — per-project default frame width/height, persisted in
  // <dir>/.studio/meta.json's `frameDefaults` (studioMeta.ts). Read at board
  // load so `addFrame`/`seedFramesForActiveBoard` can size a NEW frame to
  // match; written by the bulk frame inspector's "apply to all pages" action.
  if (pathname === '/admin/api/studio/frame-defaults' && req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const frameDefaults = readStudioMeta(dir).frameDefaults ?? {}
      return jsonResponse({ dir, frameDefaults })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/studio/frame-defaults' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, FrameDefaultsBodySchema)
      if (!body) return badRequest('invalid frame-defaults body')
      const dir = resolveProjectDir(body.dir)
      const frameDefaults = mergeProjectFrameDefaults(dir, { width: body.width, height: body.height })
      return jsonResponse({ ok: true, frameDefaults })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Framework design-token settings (colors/typography/spacing/preferences)
  // — editor-owned, lives in <dir>/.studio/framework.json. See
  // studioFramework.ts's doc comment for why this exists.
  if (pathname === '/admin/api/studio/framework' && req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const framework = readStudioFrameworkFile(dir)
      return jsonResponse({ framework })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/studio/framework' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, FrameworkPostBodySchema)
      if (!body) return badRequest('invalid framework body')
      const dir = resolveProjectDir(body.dir)
      const result = writeStudioFrameworkFile(dir, body.framework)
      if (!result.ok) return badRequest(result.message)
      return jsonResponse({ ok: true, framework: result.value })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // GitHub-link import (Phase 7B) — fetch a repo's zipball into its own
  // studio-workspace/<owner>-<repo>/ directory. Real work lives in
  // studioGithubImport.ts; this route is just body validation + error mapping.
  if (pathname === '/admin/api/studio/import-github' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, GithubImportBodySchema)
      if (!body) return badRequest('invalid import body')
      // Pass the wire fields explicitly — never spread the body, so a future
      // schema addition can't silently reach `runGithubImport`'s internal
      // `dir` option (which its target-clearing step would act on).
      const result = await runGithubImport({
        url: body.url,
        ref: body.ref,
        subdir: body.subdir,
        token: body.token,
      })
      // Persist the display name + pagesDir override into the freshly-created
      // project's meta.json. Safe to write unconditionally here: a successful
      // runGithubImport means the target had no pre-existing `.studio/` dir
      // (it refuses to import into one), so this always creates a fresh
      // meta.json rather than clobbering a prior one.
      const derivedDisplayName =
        parseGithubRepoUrl(body.url)?.repo ?? result.dir.split(/[\\/]+/).filter(Boolean).pop() ?? 'Untitled'
      writeProjectMeta(result.dir, { displayName: derivedDisplayName, pagesDir: body.pagesDir })
      // Probe the freshly-imported repo and cache the profile, so the very
      // first `/load` knows where its pages actually live.
      //
      // Without this the import "succeeds" and the canvas is EMPTY, which is
      // exactly what a real import of a nested repo did: eSIM keeps its app in
      // `journey-screens/`, so `projectPagesDir` fell back to `<dir>/pages`,
      // found nothing, and reported no error anywhere. WS-1.1 (ingest) and
      // WS-1.2 (probe) were built in parallel and each was correct alone —
      // nothing connected them. `profile.pagesDir` is the second source
      // `projectPagesDir` consults, after an explicit override, so caching it
      // here is the whole fix.
      //
      // Never fatal: a probe failure must not lose a repo that is already
      // safely on disk. The user can re-probe from the UI.
      try {
        mergeStudioMeta(result.dir, { profile: probeProject(result.dir) })
      } catch (probeErr) {
        console.error('[studio] post-import probe failed:', probeErr)
      }
      return jsonResponse({ ok: true, ...result })
    } catch (err) {
      console.error('[studio]', err)
      if (err instanceof GithubImportError) {
        return jsonResponse({ error: err.message }, { status: err.status })
      }
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // "Download the code" (Phase 6D) — zip the real .tsx source + local
  // component/style files. Real work lives in studioDownload.ts; this route
  // is just dir resolution + error mapping.
  if (pathname === '/admin/api/studio/download' && req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      return buildStudioDownloadResponse(dir)
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
