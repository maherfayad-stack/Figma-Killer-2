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
 * Classification (value-first, `var()`-resolved for the CSS path) is the
 * SAME engine `server/handlers/studio/tokenExtract.ts` uses for the
 * automatic, currently-open-project import — see
 * `designImport/parseCssTokens.ts`'s module doc for why this module no
 * longer carries its own, separately-drifting classifier.
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
 *
 * ## AUTH (`sec-16`)
 *
 * Both routes require the **`studio.write`** capability and an acceptable
 * `Origin`, and the namespace answers 404 for anything else under it.
 *
 * Until `sec-16` neither route authenticated at all. That made `copy-css` an
 * UNAUTHENTICATED write of caller-supplied bytes into the operator's real
 * repository: `readValidatedBody` calls `req.json()` whatever the content
 * type, so a cross-origin `<form enctype="text/plain">` on any page the
 * operator happened to visit could POST here and plant `.css` files under
 * `studio-workspace/<project>/styles/imported/<slug>/` — no cookie needed,
 * because no cookie was read. `preview` was the same shape one step earlier:
 * an unauthenticated server-side fetch of an arbitrary GitHub URL or npm
 * package spec, with a caller-supplied `token` forwarded to GitHub.
 *
 * `studio.write` is the right capability for both halves, not just the
 * writing one: this is one wizard, the preview exists only to feed the copy,
 * and its outbound fetch is an effect of its own. It is the same capability
 * `POST /admin/api/studio/save` takes, which is what the copied CSS ends up
 * sitting next to. Owner and Admin hold it; the Client role deliberately does
 * not — importing a design system is not reviewing one.
 *
 * This namespace gates itself rather than joining `routeCapabilities.ts`
 * because it is not under `/admin/api/studio/`; `tryServeStudio`'s gate is
 * keyed on that prefix and must stay keyed on exactly what it owns.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../http'
import { requireCapability } from '../auth/authz'
import { isStateChangingMethod, originAllowed } from '../auth/security'
import type { DbClient } from '../db/client'
import { isSafeRelPath } from './studio/archiveIngest'
import { resolveProjectDir, safeProjectFolderName, rethrowProjectDirRefusal } from './studioProjects'
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

/** Every path this module governs starts here. Nothing outside it is its own. */
const DESIGN_IMPORT_PREFIX = '/admin/api/design-import/'

/** The only `(path, method)` pairs that exist. Anything else under the prefix is a 404. */
const DESIGN_IMPORT_ROUTES: readonly string[] = [
  `${DESIGN_IMPORT_PREFIX}preview`,
  `${DESIGN_IMPORT_PREFIX}copy-css`,
]

export async function tryServeDesignImport(
  req: Request,
  runtime: { db: DbClient },
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (!pathname.startsWith(DESIGN_IMPORT_PREFIX)) return null

  // Undeclared path, or a method neither route has → 404 before any auth,
  // any body read, and any filesystem work. Returning `null` here would let
  // an API path continue down the router table to `tryServeAdminApp`, which
  // hands an API caller the admin SPA's HTML.
  if (!DESIGN_IMPORT_ROUTES.includes(pathname) || req.method !== 'POST') {
    return jsonResponse({ error: 'Not found' }, { status: 404 })
  }

  // CSRF before the session lookup, so a forged cross-origin POST costs a
  // header comparison rather than a database round trip — and so the refusal
  // does not depend on whether the victim happened to be signed in.
  if (isStateChangingMethod(req.method) && !originAllowed(req)) {
    return jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 })
  }

  const user = await requireCapability(req, runtime.db, 'studio.write')
  if (user instanceof Response) return user

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
      rethrowProjectDirRefusal(err)
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
      rethrowProjectDirRefusal(err)
      console.error('[designImport]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Unreachable: the two declared `(path, method)` pairs above are exactly the
  // set the guard at the top admits. Kept as a total return rather than a
  // throw so a future third route that forgets its branch 404s, never falls
  // through to the SPA.
  return jsonResponse({ error: 'Not found' }, { status: 404 })
}
