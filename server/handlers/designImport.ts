/**
 * Design-token import endpoints — fetch colors/typography/spacing tokens
 * (and the raw CSS itself) from a GitHub repo or npm package. Three source
 * shapes are scanned: CSS custom properties, JSON token files (recursive
 * walk, including the DTCG `{value, type}` leaf convention), and JS/TS token
 * files (a text-only regex over `key: 'string'` object-literal entries — the
 * source is never parsed as code or executed). Non-CSS files are only
 * scanned when their name looks like a token definition — see
 * `designImport/shared.ts`'s `isCandidateTokenFile`.
 *
 *   POST /admin/api/design-import/preview   body: { source: 'github'|'npm', ... }
 *       Fetches the source's matching files (nothing written to disk yet)
 *       and returns the CSS files alongside classified token candidates
 *       aggregated from ALL matching files (CSS + JSON + JS/TS). See
 *       `designImport/parseCssTokens.ts` for the extraction/classification
 *       rules and `designImport/{githubSource,npmSource}.ts` for the fetches.
 *       Read-only: this is a preview, the user selects what to keep before
 *       anything is applied.
 *
 *   POST /admin/api/design-import/copy-css   body: { dir?, sourceSlug, files }
 *       Writes the (client-held, from the preview response) CSS files
 *       verbatim into `<project>/styles/imported/<sourceSlug>/`. This is the
 *       ONLY server-side effect of "applying" an import — the Colors/
 *       Typography/Spacing token writes themselves happen entirely client-side
 *       through the normal editor-store framework actions (same ones the
 *       panels use for a manual edit), which is what persists them via the
 *       already-existing `/admin/api/studio/framework` round trip. This route
 *       never touches that file.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../http'
import { isSafeRelPath } from './studioGithubImport'
import { resolveProjectDir, safeProjectFolderName } from './studioProjects'
import { fetchGithubCssSource } from './designImport/githubSource'
import { fetchNpmCssSource } from './designImport/npmSource'
import { buildTokenCandidates } from './designImport/parseCssTokens'
import { DesignImportError, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_FILES } from './designImport/shared'

const PreviewBodySchema = Type.Union([
  Type.Object({
    source: Type.Literal('github'),
    url: Type.String(),
    ref: Type.Optional(Type.String()),
    subdir: Type.Optional(Type.String()),
    token: Type.Optional(Type.String()),
  }),
  Type.Object({
    source: Type.Literal('npm'),
    packageSpec: Type.String(),
  }),
])

const CopyCssBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  /** Folder name the files land under (`styles/imported/<sourceSlug>/`) — slugified server-side, never trusted as a literal path. */
  sourceSlug: Type.String(),
  files: Type.Array(Type.Object({ relPath: Type.String(), contents: Type.String() })),
})

export async function tryServeDesignImport(
  req: Request,
  _runtime: unknown,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname === '/admin/api/design-import/preview' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, PreviewBodySchema)
      if (!body) return badRequest('invalid preview body')

      const fetched = body.source === 'github'
        ? await fetchGithubCssSource({ url: body.url, ref: body.ref, subdir: body.subdir, token: body.token })
        : await fetchNpmCssSource({ packageSpec: body.packageSpec })

      // Token files (JSON/JS/TS) are scanned but never offered for copy-back
      // — only `cssFiles` round-trips to the client for the later
      // `copy-css` step (a raw `tokens.ts` isn't a stylesheet to copy in).
      const candidates = buildTokenCandidates(fetched.cssFiles, fetched.tokenFiles)
      return jsonResponse({
        label: fetched.label,
        truncated: fetched.truncated,
        files: fetched.cssFiles,
        colors: candidates.colors,
        typography: candidates.typography,
        spacing: candidates.spacing,
        otherCount: candidates.otherCount,
      })
    } catch (err) {
      console.error('[designImport]', err)
      if (err instanceof DesignImportError) {
        return jsonResponse({ error: err.message }, { status: err.status })
      }
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/design-import/copy-css' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, CopyCssBodySchema)
      if (!body) return badRequest('invalid copy-css body')
      const slug = safeProjectFolderName(body.sourceSlug) || 'source'
      const dir = resolveProjectDir(body.dir)
      const destRoot = join(dir, 'styles', 'imported', slug)

      let written = 0
      let skipped = 0
      for (const file of body.files) {
        if (written >= MAX_SOURCE_FILES) { skipped += 1; continue }
        if (!isSafeRelPath(file.relPath) || !file.relPath.toLowerCase().endsWith('.css')) { skipped += 1; continue }
        if (Buffer.byteLength(file.contents, 'utf8') > MAX_SOURCE_FILE_BYTES) { skipped += 1; continue }

        const dest = join(destRoot, ...file.relPath.split('/'))
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, file.contents)
        written += 1
      }

      return jsonResponse({ ok: true, dir: destRoot, written, skipped })
    } catch (err) {
      console.error('[designImport]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
