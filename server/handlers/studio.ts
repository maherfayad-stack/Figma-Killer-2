/**
 * Studio source-writeback endpoints — the filesystem side of the
 * "canvas edit ⇄ real .tsx source" loop.
 *
 *   GET  /studio/load?dir=<abs>&page=<rel>
 *       Parse a real React page file into an Instatic `Page`. Node ids are
 *       `relFile:line:col` (from page-parser), so the client can later ask us
 *       to write a specific node's prop straight back to source.
 *
 *   POST /studio/save   body: { dir, edits: [{ nodeId, prop, value }] }
 *       Decode each nodeId back to a source location and rewrite that JSX
 *       attribute via the ts-morph codemod. Synthetic nodes (e.g. the
 *       `index:body` root) don't match the loc pattern and are skipped.
 *
 * page-parser and ast-codemods run here (Node/ts-morph), not in the browser.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parsePageFile } from '@core/page-parser'
import { parsedPageToSitePage } from '@core/studio-sync/parsedPageToSitePage'
import { setJsxProp } from '@core/ast-codemods'
import { jsonResponse } from '../http'

const NODE_LOC_ID = /^(.*):(\d+):(\d+)$/

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

function defaultWorkspaceDir(): string {
  return join(process.cwd(), 'studio-workspace')
}

interface SaveBody {
  dir?: string
  edits?: Array<{ nodeId: string; prop: string; value: string | number | boolean }>
}

export async function tryServeStudio(
  req: Request,
  _runtime: unknown,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname === '/studio/load' && req.method === 'GET') {
    try {
      const dir = resolve(url.searchParams.get('dir') ?? defaultWorkspaceDir())
      const rel = url.searchParams.get('page') ?? 'pages/Home.tsx'
      const file = join(dir, rel)
      if (!existsSync(file)) return jsonResponse({ error: `page not found: ${file}` }, { status: 404 })

      const parsed = parsePageFile(file, dir)
      const page = parsedPageToSitePage(parsed, {
        pageId: 'index',
        slug: 'index',
        title: 'Home',
        resolveModuleId,
      })
      return jsonResponse({ dir, page })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/studio/save' && req.method === 'POST') {
    try {
      const body = (await req.json()) as SaveBody
      const dir = resolve(body.dir ?? defaultWorkspaceDir())
      let written = 0
      for (const edit of body.edits ?? []) {
        const m = NODE_LOC_ID.exec(edit.nodeId)
        if (!m) continue // synthetic node (e.g. body) — no source location
        const [, rel, line, col] = m
        setJsxProp({ file: join(dir, rel), line: Number(line), col: Number(col), prop: edit.prop, value: edit.value })
        written += 1
      }
      return jsonResponse({ ok: true, written })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
