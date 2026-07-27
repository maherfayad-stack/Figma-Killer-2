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
 *       `.tsx`/`.jsx` file into an Instatic `Page` (multi-frame board). Node ids
 *       stay `relFile:line:col`
 *       (from page-parser), `relFile` always relative to the WORKSPACE ROOT
 *       (not the pages dir), so the client can ask us to write a specific
 *       node's prop straight back to source no matter how deep its file
 *       sits, and the save handler below needs no changes to keep working.
 *       The parse → local-component-inline → Instatic-`Page` conversion
 *       pipeline itself — including the `componentSources` local/package
 *       classification and the `STUDIO_ASSET_SENTINEL` → fetchable-URL
 *       rewrite (§5.1/§5.2) — lives in `loadStudioPages`; see
 *       `server/handlers/studioPageLoad.ts`'s module doc for the full
 *       walkthrough. This route is just dir resolution + error mapping.
 *       (Under /admin/api so the Vite dev proxy forwards it to the :3001 server.)
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
 *   GET  /admin/api/studio/projects
 *       Lists every on-disk studio project the Overview launcher can open:
 *       one entry per immediate subfolder of `studio-workspace/`, whether
 *       hand-authored or GitHub-imported (they all live there now). Read-only
 *       — this endpoint never creates, clears, or writes a directory. The
 *       listing logic itself lives in `listStudioProjects`, a pure(ish)
 *       dir-in/project-list-out helper so it's unit-testable against a temp
 *       fixture tree, same pattern as `collectWorkspaceFiles`.
 *
 *   POST /admin/api/studio/create   body: { name }
 *       Scaffolds a new project: one slugified folder under `studio-workspace/`
 *       with a starter `pages/Home.tsx`. Returns the created `{ project }`.
 *
 *   POST /admin/api/studio/page   body: { dir?, name? }
 *       Scaffolds a new page in a project: one `pages/<Component>.tsx` starter
 *       file. `name` is optional — omit it for the one-click "New page" action
 *       and the server auto-names it `Page`, `Page2`, …. Returns
 *       `{ ok, relPath, pageId, title }` so the client can drop a board frame
 *       for it, then reload the workspace to render it.
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
 * This module is the HTTP routing layer only — request wiring, body
 * validation, and error-envelope mapping. The actual page-parser/ast-codemods
 * work (Node/ts-morph, never the browser) lives in sibling modules by
 * responsibility: `studioAsset.ts` (asset serving), `studioWriteback.ts`
 * (source writeback), `studioPageLoad.ts` (the parse pipeline),
 * `studioProjects.ts`, `studioFramework.ts`, `studioDownload.ts`, and
 * `studioGithubImport.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createBoardsFile, parseBoardsFile, serializeBoardsFile, type BoardsFile } from '@core/studio-board'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../http'
import { GithubImportError, parseGithubRepoUrl, runGithubImport } from './studioGithubImport'
import {
  discoverPageFiles,
  listStudioProjects,
  nextPageName,
  nextProjectName,
  pageComponentNameFromInput,
  projectDisplayName,
  projectPagesDir,
  projectsRootDir,
  renameProjectDisplayName,
  resolveProjectDir,
  safeProjectFolderName,
  starterPage,
  writeProjectMeta,
  type StudioProjectSummary,
} from './studioProjects'
import { readStudioFrameworkFile, writeStudioFrameworkFile } from './studioFramework'
import { buildStudioDownloadResponse } from './studioDownload'
import { resolveStudioAssetResponse } from './studioAsset'
import { pageIdFromRelPath, loadStudioPages } from './studioPageLoad'
import {
  applyStudioEdit,
  dedupeStudioEdits,
  isInlinedNodeId,
  orderStudioEditsForApply,
  studioEditFile,
  StudioEditSchema,
} from './studioWriteback'

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
 * Body of POST /admin/api/studio/create — scaffold a new project folder.
 * `name` is optional: the "New project" dashboard action omits it entirely
 * (no name-prompt UI) and the server auto-names it `Untitled`, `Untitled 2`, ….
 */
const CreateProjectBodySchema = Type.Object({
  name: Type.Optional(Type.String()),
})

/** Body of POST /admin/api/studio/rename — change a project's display name. */
const RenameProjectBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  name: Type.String(),
})

/**
 * Body of POST /admin/api/studio/page — scaffold a new page in a project.
 * `name` is optional: when omitted (the one-click "New page" action) the server
 * auto-names it `Page`, `Page2`, ….
 */
const CreatePageBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
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
  if (pathname === '/admin/api/studio/load' && req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const projectName = projectDisplayName(dir)
      const { pages, componentSources, styleRules, conditions } = await loadStudioPages(dir)
      return jsonResponse({ dir, projectName, pages, componentSources, styleRules, conditions })
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

      // Apply edits bottom-to-top so a line-count-changing codemod can't
      // invalidate another edit's location mid-batch (see the helper's doc).
      // Dedupe first: several board nodes can share one writeback target when
      // they are instances of the same inlined component.
      const ordered = orderStudioEditsForApply(dedupeStudioEdits(edits))

      // An edit on an inlined node rewrites the component's own file, so every
      // OTHER instance on the board is now stale. The client reloads on this.
      const sharedComponents = edits.some((edit) => isInlinedNodeId(edit.nodeId))

      // Snapshot each touched file's line count so we can tell the client
      // whether any write shifted line numbers. If so, the client's in-memory
      // `line:col` node ids are now stale against disk and it must re-parse to
      // re-sync them (see `shifted` handling in fsCodemodAdapter).
      const touchedFiles = new Set<string>()
      for (const edit of ordered) {
        const file = studioEditFile(dir, edit.nodeId)
        if (file) touchedFiles.add(file)
      }
      const lineCountBefore = new Map<string, number>()
      for (const file of touchedFiles) {
        lineCountBefore.set(file, existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : 0)
      }

      let written = 0
      let skipped = 0
      for (const edit of ordered) {
        try {
          if (applyStudioEdit(dir, edit)) written += 1
        } catch (err) {
          // One edit's codemod refusing to write (e.g. mixed-content text
          // target, non-object-literal style attribute) must not abort the
          // rest of the batch.
          console.error('[studio]', err)
          skipped += 1
        }
      }

      let shifted = false
      for (const file of touchedFiles) {
        const after = existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : 0
        if (after !== lineCountBefore.get(file)) {
          shifted = true
          break
        }
      }

      if (skipped > 0) console.error(`[studio] save: ${written} written, ${skipped} skipped`)
      return jsonResponse({ ok: true, written, skipped, shifted, sharedComponents })
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
      return jsonResponse({ ok: true, ...result })
    } catch (err) {
      console.error('[studio]', err)
      if (err instanceof GithubImportError) {
        return jsonResponse({ error: err.message }, { status: err.status })
      }
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // List every on-disk studio project for the Overview launcher. Read-only:
  // never creates, clears, or writes a directory.
  if (pathname === '/admin/api/studio/projects' && req.method === 'GET') {
    try {
      const projects = listStudioProjects(projectsRootDir())
      return jsonResponse({ projects })
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Scaffold a new project — one folder under studio-workspace/ with a starter
  // page. An explicit name (if any) is slugified to a filesystem-safe folder
  // (never `..`, never a separator) so it can't escape the projects root; when
  // omitted, the folder is slugified from an auto-generated "Untitled" name
  // instead. Either way, the DISPLAY name (which may differ from the folder
  // once renamed later) is recorded in `.studio/meta.json`.
  if (pathname === '/admin/api/studio/create' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, CreateProjectBodySchema)
      if (!body) return badRequest('invalid create body')
      const requested = body.name?.trim()
      const displayName = requested || nextProjectName(projectsRootDir())
      const folder = safeProjectFolderName(displayName)
      if (!folder) return badRequest('project name must contain at least one letter or digit')
      const dir = join(projectsRootDir(), folder)
      if (existsSync(dir)) {
        return jsonResponse({ error: `A project named "${folder}" already exists.` }, { status: 409 })
      }
      const pagesDir = projectPagesDir(dir)
      mkdirSync(pagesDir, { recursive: true })
      writeFileSync(join(pagesDir, 'Home.tsx'), starterPage('Home'))
      writeProjectMeta(dir, { displayName })
      const project: StudioProjectSummary = { dir, name: displayName, pageCount: 1 }
      return jsonResponse({ project })
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Rename a project's DISPLAY name — never touches the folder (a stable
  // identifier assigned once at creation; renaming it mid-session would
  // invalidate any already-open `studioWorkspaceDir` pointer). Just rewrites
  // `.studio/meta.json`.
  if (pathname === '/admin/api/studio/rename' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, RenameProjectBodySchema)
      if (!body) return badRequest('invalid rename body')
      const displayName = body.name.trim()
      if (!displayName) return badRequest('project name must not be empty')
      const dir = resolveProjectDir(body.dir)
      if (!existsSync(dir)) return jsonResponse({ error: 'Project not found.' }, { status: 404 })
      renameProjectDisplayName(dir, displayName)
      const pagesDir = projectPagesDir(dir)
      const pageCount = existsSync(pagesDir) ? discoverPageFiles(pagesDir).length : 0
      const project: StudioProjectSummary = { dir, name: displayName, pageCount }
      return jsonResponse({ project })
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Scaffold a new page in a project — one `pages/<Component>.tsx` starter file.
  // The name is turned into a PascalCase identifier (never `..`, never a
  // separator) so it can't escape the project's pages/ dir. Returns the derived
  // `pageId` (kebab of the file path) so the client can drop a board frame for
  // it immediately, then reload the workspace to render it.
  if (pathname === '/admin/api/studio/page' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, CreatePageBodySchema)
      if (!body) return badRequest('invalid page body')
      const dir = resolveProjectDir(body.dir)
      const pagesDir = projectPagesDir(dir)
      // A supplied name wins; otherwise auto-name `Page`, `Page2`, … (one-click).
      const componentName = pageComponentNameFromInput(body.name ?? '') || nextPageName(pagesDir)
      const relPath = `${componentName}.tsx`
      const file = join(pagesDir, relPath)
      if (existsSync(file)) {
        return jsonResponse({ error: `A page named "${componentName}" already exists.` }, { status: 409 })
      }
      mkdirSync(pagesDir, { recursive: true })
      writeFileSync(file, starterPage(componentName))
      return jsonResponse({ ok: true, relPath, pageId: pageIdFromRelPath(relPath), title: componentName })
    } catch (err) {
      console.error('[studio]', err)
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
