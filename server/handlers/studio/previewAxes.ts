/**
 * previewAxes — `GET/POST /admin/api/studio/preview-axes`, WS-10 Phase 1's
 * read/write surface for `.studio/meta.json`'s `previewAxes` field
 * (`studioMeta.ts`'s `PersistedPreviewAxesSchema`). Same shape as
 * `trustTier.ts` (WS-3.3) — one small, project-scoped, `mergeStudioMeta`-
 * backed sub-router, deliberately NOT folded into the big `/admin/api/studio/load`
 * response: axes are editor-session UI state that changes via clicks on a
 * toolbar control, not something every page load needs to compute, and this
 * keeps that already-delicate NDJSON payload (`studioPageLoad.ts`,
 * `fsCodemodAdapter.ts`'s `StudioLoadStreamLineSchema`) untouched.
 *
 *   GET  /admin/api/studio/preview-axes?dir=<abs>
 *     -> `{ previewAxes }` — the persisted value merged onto
 *        `DEFAULT_PREVIEW_AXES`, so a project that has never touched the
 *        toggle still gets a fully-resolved triple back.
 *   POST /admin/api/studio/preview-axes { dir, previewAxes: Partial<...> }
 *     -> `{ ok: true, previewAxes }` — merges the given fields onto whatever
 *        is already persisted (via `mergeStudioMeta`, itself a merge), so a
 *        direction toggle can never clobber a previously-saved color scheme
 *        and vice versa, and every OTHER `.studio/meta.json` field
 *        (`displayName`, `pagesDir`, the cached `profile`, …) survives
 *        untouched.
 *
 * `locale` is deliberately not in the wire schema here — Phase 2 territory,
 * a different persistence field (the existing `previewLocale`). See
 * `previewAxes.ts` (the `@core/studio-board` leaf)'s module doc.
 *
 * Same containment posture as every other project-scoped route:
 * `resolveProjectDir` + `isRealpathContained(dir, projectsRootDir())`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { DEFAULT_PREVIEW_AXES, type PreviewAxes } from '@core/studio-board'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { mergeStudioMeta, readStudioMeta } from './studioMeta'

const ROUTE_PATH = '/admin/api/studio/preview-axes'

const PreviewAxesPatchSchema = Type.Object({
  direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
  colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
})

const PreviewAxesPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  previewAxes: PreviewAxesPatchSchema,
})
export type PreviewAxesPostBody = Static<typeof PreviewAxesPostBodySchema>

/** Resolved, fully-populated axes for a project — persisted partial fields win, everything else falls back to the default. `locale` always comes from the default (Phase 1 never persists it here). */
function resolvePreviewAxes(dir: string): PreviewAxes {
  const persisted = readStudioMeta(dir).previewAxes
  return { ...DEFAULT_PREVIEW_AXES, ...persisted }
}

/** `GET/POST /admin/api/studio/preview-axes` — see module doc for the full contract. */
export async function tryServeStudioPreviewAxes(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
      return jsonResponse({ previewAxes: resolvePreviewAxes(dir) })
    } catch (err) {
      console.error('[studio:previewAxes]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, PreviewAxesPostBodySchema)
      if (!body) return badRequest('invalid preview-axes body')
      const dir = resolveProjectDir(body.dir)
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

      const existing = readStudioMeta(dir).previewAxes ?? {}
      mergeStudioMeta(dir, { previewAxes: { ...existing, ...body.previewAxes } })
      return jsonResponse({ ok: true, previewAxes: resolvePreviewAxes(dir) })
    } catch (err) {
      console.error('[studio:previewAxes]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
