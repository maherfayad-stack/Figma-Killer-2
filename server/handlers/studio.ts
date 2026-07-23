/**
 * Studio source-writeback endpoints — the filesystem side of the
 * "canvas edit ⇄ real .tsx source" loop.
 *
 *   GET  /admin/api/studio/load?dir=<abs>
 *       Recursively walks the workspace's `pages/` directory (Phase 7A —
 *       multi-file project backend; nested route/page dirs like
 *       `pages/marketing/Landing.tsx` are discovered, not just a flat
 *       top-level scan) and parses EVERY `.tsx` file into an Instatic `Page`
 *       (multi-frame board). Node ids stay `relFile:line:col`
 *       (from page-parser), `relFile` always relative to the WORKSPACE ROOT
 *       (not the pages dir), so the client can ask us to write a specific
 *       node's prop straight back to source no matter how deep its file
 *       sits, and the save handler below needs no changes to keep working.
 *       Every page is parsed against one shared, workspace-wide ts-morph
 *       `Project` (`createWorkspaceProject`) so a page's local-component
 *       imports resolve to real files elsewhere in the tree;
 *       `resolveComponentSources` classifies each `kind: 'component'` node as
 *       **local** (import resolves inside the workspace — recorded as a
 *       workspace-relative file path) or **package** (an npm dependency like
 *       `@alm-design/design-system`, read-only prop surface). The merged
 *       classification for every page is returned as `componentSources`,
 *       keyed by node id.
 *       (Under /admin/api so the Vite dev proxy forwards it to the :3001 server.)
 *
 *   POST /admin/api/studio/save   body: { dir, edits: StudioEdit[] }
 *       A batch of typed edits (`kind: 'prop' | 'text' | 'style'`). Each edit's
 *       nodeId is decoded back to a source location and dispatched to the
 *       matching `ast-codemods` writer (`setJsxProp` / `setJsxText` /
 *       `setJsxStyle`) via `applyStudioEdit`. Synthetic nodes (e.g. the
 *       `index:body` root) don't match the loc pattern and are skipped. Each
 *       edit is applied independently — one codemod throwing (e.g. a text
 *       edit landing on an element with mixed children) is logged and
 *       skipped rather than aborting the whole batch.
 *
 *   POST /admin/api/studio/import-github   body: { url, ref?, subdir?, token?, dir? }
 *       Phase 7B — GitHub-link import. Fetches the repo's zipball
 *       (`server/handlers/studioGithubImport.ts` owns URL parsing, the
 *       fetch, the zip-entry safety/size guards, and the write) into a
 *       repo-scoped `studio-workspace-imports/<owner>-<repo>/` directory —
 *       never the hand-authored `studio-workspace/` — and returns
 *       `{ ok, dir, files, skipped }`. The client then calls this same
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
 * page-parser and ast-codemods run here (Node/ts-morph), not in the browser.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import {
  createWorkspaceProject,
  listWorkspaceFiles,
  parsePageFile,
  resolveComponentSources,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_FILES,
  type ComponentSource,
} from '@core/page-parser'
import { parsedPageToSitePage } from '@core/studio-sync/parsedPageToSitePage'
import { setJsxProp, setJsxStyle, setJsxText } from '@core/ast-codemods'
import { createBoardsFile, parseBoardsFile, serializeBoardsFile, type BoardsFile } from '@core/studio-board'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../http'
import { binaryResponse } from '../binary'
import { GithubImportError, runGithubImport } from './studioGithubImport'

const NODE_LOC_ID = /^(.*):(\d+):(\d+)$/

/** One prop attribute writeback — `setJsxProp`. */
const PropEditSchema = Type.Object({
  kind: Type.Literal('prop'),
  nodeId: Type.String(),
  prop: Type.String(),
  value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
})

/** One element-text-children writeback — `setJsxText`. */
const TextEditSchema = Type.Object({
  kind: Type.Literal('text'),
  nodeId: Type.String(),
  text: Type.String(),
})

/** One `style={{ ... }}` merge writeback — `setJsxStyle`. */
const StyleEditSchema = Type.Object({
  kind: Type.Literal('style'),
  nodeId: Type.String(),
  style: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
})

/** Discriminated union of every studio edit kind — `kind` is the discriminator. */
const StudioEditSchema = Type.Union([PropEditSchema, TextEditSchema, StyleEditSchema])
export type StudioEdit = Static<typeof StudioEditSchema>

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
 * Body of POST /admin/api/studio/import-github (Phase 7B).
 *
 * Deliberately has NO `dir` field. `runGithubImport` clears its target
 * directory before repopulating it, so a caller-supplied target would be an
 * arbitrary recursive-delete primitive driven by a request body. The import
 * target is therefore always derived server-side from the parsed repo
 * (`studio-workspace-imports/<owner>-<repo>`); `runGithubImport`'s `dir`
 * option stays internal (tests only) and is never sourced from the wire.
 *
 * `token`, when present, is forwarded as a Bearer credential and never logged
 * or echoed back.
 */
const GithubImportBodySchema = Type.Object({
  url: Type.String(),
  ref: Type.Optional(Type.String()),
  subdir: Type.Optional(Type.String()),
  token: Type.Optional(Type.String()),
})

/** Map a parsed node to an Instatic moduleId (design-system → alm.*, host tags → base.*). */
function resolveModuleId(node: { kind: 'element' | 'component'; name: string }): string {
  if (node.kind === 'component') return `alm.${node.name}`
  const tag = node.name.toLowerCase()
  if (['div', 'section', 'main', 'header', 'footer', 'nav', 'article', 'aside'].includes(tag)) {
    return 'base.container'
  }
  if (tag === 'button') return 'base.button'
  if (tag === 'a') return 'base.link'
  if (tag === 'img') return 'base.image'
  return 'base.text'
}

/**
 * Map a resolved moduleId to the single prop key its module's
 * `inlineTextEdit` declares. MUST stay in sync with the base modules'
 * `inlineTextEdit.prop` (`src/modules/base/{text,button,link}/index.ts`) —
 * the browser-side `fsCodemodAdapter` reads the same contract off the actual
 * module registry (`@core/module-engine`), which this server-side handler
 * intentionally does not import (page-parser/ast-codemods run here in Node,
 * decoupled from the browser module bundle). `alm.*` design-system
 * components declare no `inlineTextEdit` — out of scope for source
 * writeback this slice.
 */
function resolveTextProp(moduleId: string): string | null {
  switch (moduleId) {
    case 'base.text':
      return 'text'
    case 'base.button':
      return 'label'
    case 'base.link':
      return 'text'
    default:
      return null
  }
}

/**
 * Order a save batch BOTTOM-TO-TOP: descending line, then descending column.
 * Node ids encode a `line:col` source location, and a codemod can change a
 * file's line count (e.g. `setJsxStyle` collapsing a multiline `style={{…}}`
 * to one line). Applying the lowest positions first guarantees an edit can
 * never invalidate the source location of another edit still pending in the
 * same batch. Edits whose id has no decodable location (synthetic nodes like
 * `index:body`) sort last — `applyStudioEdit` no-ops on them anyway. Pure, so
 * the ordering is unit-testable without touching the filesystem.
 */
export function orderStudioEditsForApply<T extends { nodeId: string }>(edits: readonly T[]): T[] {
  return [...edits].sort((a, b) => {
    const la = NODE_LOC_ID.exec(a.nodeId)
    const lb = NODE_LOC_ID.exec(b.nodeId)
    if (!la) return 1
    if (!lb) return -1
    return Number(lb[2]) - Number(la[2]) || Number(lb[3]) - Number(la[3])
  })
}

/**
 * Applies one typed studio edit to the .tsx source under `dir`, dispatching
 * on `edit.kind` to the matching `ast-codemods` writer. Extracted as a pure
 * helper (dir + edit in, codemod side effect out) so it's unit-testable
 * against temp fixture files without a full Request/Response round trip.
 *
 * Returns `false` for a synthetic node id (e.g. the `index:body` root) that
 * has no source location — nothing to write, not an error. Returns `true`
 * once the matching codemod has written the file. Propagates whatever the
 * underlying codemod throws (e.g. `JsxTextTargetError`, `JsxStyleTargetError`)
 * for a real source location it refuses to touch — callers decide whether to
 * skip-and-log or let it bubble.
 */
export function applyStudioEdit(dir: string, edit: StudioEdit): boolean {
  const m = NODE_LOC_ID.exec(edit.nodeId)
  if (!m) return false // synthetic node (e.g. body) — no source location
  const [, rel, line, col] = m
  const loc = { file: join(dir, rel), line: Number(line), col: Number(col) }

  switch (edit.kind) {
    case 'prop':
      setJsxProp({ ...loc, prop: edit.prop, value: edit.value })
      return true
    case 'text':
      setJsxText({ ...loc, text: edit.text })
      return true
    case 'style':
      setJsxStyle({ ...loc, style: edit.style })
      return true
  }
}

function defaultWorkspaceDir(): string {
  return join(process.cwd(), 'studio-workspace')
}

/** One real source file collected from the workspace for the download zip. */
export interface WorkspaceFile {
  /** Path relative to the workspace root, using `/` separators (zip-safe). */
  relPath: string
  contents: Buffer
}

interface CollectWorkspaceFilesOptions {
  /** Files larger than this are skipped outright — never partially included. */
  maxFileBytes?: number
  /** Total file count cap — collection stops (not truncates a file) once hit. */
  maxFiles?: number
}

/**
 * Recursively collects every real source file under `dir` for the "Download
 * code" export (Phase 6D). Pure-ish (dir + options in, file list out) so it's
 * unit-testable against a temp fixture directory without a Request/Response
 * round trip — mirrors `applyStudioEdit`'s testing shape.
 *
 * The recursive walk + exclusion rule (`.studio/`, `.git/`, `node_modules/`,
 * `dist/`, `.next/`, `.turbo/`, never following symlinks) is shared with the
 * Phase 7A workspace-discovery walk via `listWorkspaceFiles`
 * (`@core/page-parser`) — one exclusion list, not a duplicated one per
 * call site.
 *
 * Beyond that shared walk, this function adds: oversized files (> `maxFileBytes`)
 * are skipped whole, never truncated; collection stops (does not throw) once
 * `maxFiles` is reached, so the caller still gets a valid, if partial, zip
 * rather than an unbounded one.
 */
export function collectWorkspaceFiles(
  dir: string,
  options: CollectWorkspaceFilesOptions = {},
): WorkspaceFile[] {
  const maxFileBytes = options.maxFileBytes ?? WORKSPACE_MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? WORKSPACE_MAX_FILES
  const results: WorkspaceFile[] = []

  for (const relPath of listWorkspaceFiles(dir)) {
    if (results.length >= maxFiles) break
    const filePath = join(dir, ...relPath.split('/'))
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      continue
    }
    if (size > maxFileBytes) continue // skip whole — never emit a partial file
    results.push({ relPath, contents: readFileSync(filePath) })
  }

  return results
}

/** Minimal package.json synthesized when the workspace ships none of its own. */
function synthesizedPackageJson(): Uint8Array {
  return strToU8(
    `${JSON.stringify(
      {
        name: 'studio-workspace',
        private: true,
        dependencies: { '@alm-design/design-system': '*' },
      },
      null,
      2,
    )}\n`,
  )
}

/**
 * Recursively discovers every page file under the workspace's `pages/`
 * directory (Phase 7A — nested route/page dirs like
 * `pages/marketing/Landing.tsx`, not just a flat top-level scan), returning
 * POSIX paths relative to `pagesDir`, in deterministic sorted order (shared
 * walk/exclusion rule with `collectWorkspaceFiles` via `listWorkspaceFiles`).
 */
export function discoverPageFiles(pagesDir: string): string[] {
  return listWorkspaceFiles(pagesDir).filter((relPath) => relPath.endsWith('.tsx'))
}

/**
 * Derive a stable page id (also used as the slug) from a page file's path,
 * relative to the workspace's `pages/` dir — kebab-casing every path segment
 * and joining with `-` so nested files don't collide with a differently-
 * nested one that merely shares a basename: "Home.tsx" -> "home",
 * "MyPage.tsx" -> "my-page", "marketing/Landing.tsx" -> "marketing-landing".
 * Pure so it's unit-testable without touching the filesystem.
 *
 * Two DIFFERENT relPaths can still slugify to the same string (e.g.
 * "Marketing/Landing.tsx" and "marketing-landing.tsx" both ->
 * "marketing-landing") — `assignPageIds` is the layer that guarantees
 * uniqueness across a whole discovered set; this function only derives the
 * per-path slug.
 */
export function pageIdFromRelPath(relPath: string): string {
  const segments = relPath.split('/').filter((segment) => segment.length > 0)
  const slug = segments
    .map((segment, i) => {
      const base = i === segments.length - 1 ? segment.replace(/\.tsx$/, '') : segment
      return base
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    })
    .filter((segment) => segment.length > 0)
    .join('-')
  return slug.length > 0 ? slug : 'page'
}

/**
 * Assigns a unique pageId (also used as the slug) to each entry of
 * `relPaths`, processed in the given order. `pageIdFromRelPath` is
 * deterministic per path, but two different nested paths can slugify to the
 * same string (see its doc comment) — on a collision, every path after the
 * first gets a numeric suffix (`-2`, `-3`, …), so ids stay unique for a given
 * input ordering. Pure; callers get reproducible ids by passing a
 * consistently-ordered list (`discoverPageFiles` already returns sorted paths).
 */
export function assignPageIds(relPaths: readonly string[]): Map<string, string> {
  const seenCounts = new Map<string, number>()
  const assigned = new Map<string, string>()
  for (const relPath of relPaths) {
    const base = pageIdFromRelPath(relPath)
    const seen = seenCounts.get(base) ?? 0
    seenCounts.set(base, seen + 1)
    assigned.set(relPath, seen === 0 ? base : `${base}-${seen + 1}`)
  }
  return assigned
}

export async function tryServeStudio(
  req: Request,
  _runtime: unknown,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname === '/admin/api/studio/load' && req.method === 'GET') {
    try {
      const dir = resolve(url.searchParams.get('dir') ?? defaultWorkspaceDir())
      const pagesDir = join(dir, 'pages')
      if (!existsSync(pagesDir)) return jsonResponse({ dir, pages: [], componentSources: {} })

      const relPaths = discoverPageFiles(pagesDir)
      const pageIds = assignPageIds(relPaths)

      // One shared, workspace-wide ts-morph Project so a page's local
      // component imports resolve to real files elsewhere in the tree —
      // a fresh per-file Project (parsePageFile's own default) can't see
      // across files at all. See createWorkspaceProject's doc comment.
      const project = createWorkspaceProject(dir)
      const componentSources: Record<string, ComponentSource> = {}

      const pages = relPaths.map((relPath) => {
        const file = join(pagesDir, ...relPath.split('/'))
        const pageId = pageIds.get(relPath)!
        const parsed = parsePageFile(file, dir, project)
        Object.assign(componentSources, resolveComponentSources(project, file, dir, parsed))
        return parsedPageToSitePage(parsed, {
          pageId,
          slug: pageId,
          title: relPath.split('/').pop()!.replace(/\.tsx$/, ''),
          resolveModuleId,
          resolveTextProp,
        })
      })

      return jsonResponse({ dir, pages, componentSources })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/studio/save' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, SaveBodySchema)
      if (!body) return badRequest('invalid save body')
      const dir = resolve(body.dir ?? defaultWorkspaceDir())
      const edits = body.edits ?? []

      // Apply edits bottom-to-top so a line-count-changing codemod can't
      // invalidate another edit's location mid-batch (see the helper's doc).
      const ordered = orderStudioEditsForApply(edits)

      // Snapshot each touched file's line count so we can tell the client
      // whether any write shifted line numbers. If so, the client's in-memory
      // `line:col` node ids are now stale against disk and it must re-parse to
      // re-sync them (see `shifted` handling in fsCodemodAdapter).
      const touchedFiles = new Set<string>()
      for (const edit of ordered) {
        const m = NODE_LOC_ID.exec(edit.nodeId)
        if (m) touchedFiles.add(join(dir, m[1]))
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
      return jsonResponse({ ok: true, written, skipped, shifted })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Board spatial metadata (frames + sticky notes) — editor-owned, lives in
  // <dir>/.studio/boards.json. Never affects the app runtime.
  if (pathname === '/admin/api/studio/boards' && req.method === 'GET') {
    try {
      const dir = resolve(url.searchParams.get('dir') ?? defaultWorkspaceDir())
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
      const dir = resolve(body.dir ?? defaultWorkspaceDir())
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

  // GitHub-link import (Phase 7B) — fetch a repo's zipball into its own
  // studio-workspace-imports/<owner>-<repo>/ directory. Real work lives in
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
  // component/style files. Not codegen: the workspace's filesystem IS the
  // source of truth, so this endpoint only packages what's already there.
  if (pathname === '/admin/api/studio/download' && req.method === 'GET') {
    try {
      const dir = resolve(url.searchParams.get('dir') ?? defaultWorkspaceDir())
      if (!existsSync(dir)) {
        return jsonResponse({ error: `Workspace directory not found: ${dir}` }, { status: 404 })
      }

      const files = collectWorkspaceFiles(dir)
      const zipInput: Record<string, Uint8Array> = {}
      let hasPackageJson = false
      for (const file of files) {
        zipInput[file.relPath] = file.contents
        if (file.relPath === 'package.json') hasPackageJson = true
      }
      // The design-system dependency (`@alm-design/design-system`) is an npm
      // package, never bundled as source — record it in package.json instead
      // so `bun install` resolves it. Only synthesize one when the workspace
      // doesn't already ship its own (which is included as-is, above).
      if (!hasPackageJson) {
        zipInput['package.json'] = synthesizedPackageJson()
      }

      const zipped = zipSync(zipInput)
      return binaryResponse(zipped, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="studio-workspace.zip"',
        },
      })
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
