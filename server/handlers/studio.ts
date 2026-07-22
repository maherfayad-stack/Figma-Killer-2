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
 * page-parser and ast-codemods run here (Node/ts-morph), not in the browser.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parsePageFile } from '@core/page-parser'
import { parsedPageToSitePage } from '@core/studio-sync/parsedPageToSitePage'
import { setJsxProp, setJsxStyle, setJsxText } from '@core/ast-codemods'
import { createBoardsFile, parseBoardsFile, serializeBoardsFile, type BoardsFile } from '@core/studio-board'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../http'

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

  return null
}
