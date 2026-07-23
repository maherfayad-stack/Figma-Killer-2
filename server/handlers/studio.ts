/**
 * Studio source-writeback endpoints — the filesystem side of the
 * "canvas edit ⇄ real .tsx source" loop.
 *
 *   GET  /admin/api/studio/load?dir=<abs>
 *       Scan the workspace's `pages/` directory for `*.tsx` files and parse
 *       EVERY one into an Instatic `Page` (multi-frame board — Phase 1
 *       Increment 1B). Node ids stay `relFile:line:col` (from page-parser),
 *       so the client can later ask us to write a specific node's prop
 *       straight back to source, and the save handler below needs no changes
 *       to keep working across multiple pages.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { parsePageFile } from '@core/page-parser'
import { parsedPageToSitePage } from '@core/studio-sync/parsedPageToSitePage'
import { setJsxProp, setJsxStyle, setJsxText } from '@core/ast-codemods'
import { createBoardsFile, parseBoardsFile, serializeBoardsFile, type BoardsFile } from '@core/studio-board'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../http'
import { binaryResponse } from '../binary'

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

/** Skip these directories entirely — never descended into, anywhere in the tree. */
const EXCLUDED_DIR_NAMES = new Set(['.studio', '.git', 'node_modules', 'dist', '.next', '.turbo'])

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB — generous for source/text/small assets
const DEFAULT_MAX_FILES = 5000

/**
 * Recursively collects every real source file under `dir` for the "Download
 * code" export (Phase 6D). Pure-ish (dir + options in, file list out) so it's
 * unit-testable against a temp fixture directory without a Request/Response
 * round trip — mirrors `applyStudioEdit`'s testing shape.
 *
 * Exclusions (decisions, not oversights):
 *   - `.studio/`     — editor-owned spatial metadata (boards.json). Not app code.
 *   - `.git/`, `node_modules/`, `dist/`, `.next/`, `.turbo/` — VCS internals,
 *     installed deps, and build output. Never authored, never bundled.
 *   - Symlinks       — never followed, so a symlink can't walk the export
 *     outside `dir` (path-traversal guard alongside the fact that every
 *     collected path is built from a `readdirSync` of `dir` itself).
 *   - Oversized files (> `maxFileBytes`) — skipped whole, never truncated.
 *
 * Everything else under `dir` is included verbatim — `.tsx`/`.ts`/`.css`/
 * `.json`/`.js` source and ordinary asset files — preserving relative paths.
 * Stops collecting (does not throw) once `maxFiles` is reached; the caller
 * still gets a valid, if partial, zip rather than an unbounded one.
 */
export function collectWorkspaceFiles(
  dir: string,
  options: CollectWorkspaceFilesOptions = {},
): WorkspaceFile[] {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const results: WorkspaceFile[] = []

  function walk(currentDir: string, relDir: string): void {
    if (results.length >= maxFiles) return
    let entries: Dirent[]
    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return
      // Never follow symlinks — the export must stay confined to `dir`.
      if (entry.isSymbolicLink()) continue
      const entryRelPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
        walk(join(currentDir, entry.name), entryRelPath)
        continue
      }
      if (!entry.isFile()) continue
      const filePath = join(currentDir, entry.name)
      let size: number
      try {
        size = statSync(filePath).size
      } catch {
        continue
      }
      if (size > maxFileBytes) continue // skip whole — never emit a partial file
      results.push({ relPath: entryRelPath, contents: readFileSync(filePath) })
    }
  }

  walk(dir, '')
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
 * Derive a stable, unique page id (also used as the slug) from a page file's
 * basename — "Home.tsx" -> "home", "About.tsx" -> "about", "MyPage.tsx" ->
 * "my-page". Pure so it's unit-testable without touching the filesystem.
 */
export function pageIdFromFileName(fileName: string): string {
  const base = fileName.replace(/\.tsx$/, '')
  const slug = base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'page'
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
      if (!existsSync(pagesDir)) return jsonResponse({ dir, pages: [] })

      const fileNames = readdirSync(pagesDir)
        .filter((name) => name.endsWith('.tsx'))
        .sort()

      const pages = fileNames.map((fileName) => {
        const file = join(pagesDir, fileName)
        const parsed = parsePageFile(file, dir)
        const pageId = pageIdFromFileName(fileName)
        return parsedPageToSitePage(parsed, {
          pageId,
          slug: pageId,
          title: fileName.replace(/\.tsx$/, ''),
          resolveModuleId,
          resolveTextProp,
        })
      })

      return jsonResponse({ dir, pages })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/studio/save' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, SaveBodySchema)
      if (!body) return badRequest('invalid save body')
      const dir = resolve(body.dir ?? defaultWorkspaceDir())
      let written = 0
      let skipped = 0
      for (const edit of body.edits ?? []) {
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
      if (skipped > 0) console.error(`[studio] save: ${written} written, ${skipped} skipped`)
      return jsonResponse({ ok: true, written })
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
