/**
 * previewAxes — `GET/POST /admin/api/studio/preview-axes`, WS-10's read/write
 * surface for `.studio/meta.json`'s `previewAxes` field (`studioMeta.ts`'s
 * `PersistedPreviewAxesSchema`). Same shape as `trustTier.ts` (WS-3.3) — one
 * small, project-scoped, `mergeStudioMeta`-backed sub-router, deliberately
 * NOT folded into the big `/admin/api/studio/load` response: axes are
 * editor-session UI state that changes via clicks on a toolbar control, not
 * something every page load needs to compute, and this keeps that
 * already-delicate NDJSON payload (`studioPageLoad.ts`, `fsCodemodAdapter.ts`'s
 * `StudioLoadStreamLineSchema`) untouched.
 *
 *   GET  /admin/api/studio/preview-axes?dir=<abs>
 *     -> `{ previewAxes }` — the persisted value merged onto
 *        `DEFAULT_PREVIEW_AXES`, so a project that has never touched a
 *        toggle still gets a fully-resolved triple back (`locale` stays
 *        `undefined` when nothing has ever set it — there is no sensible
 *        static default for a per-project dictionary key).
 *   POST /admin/api/studio/preview-axes { dir, previewAxes: Partial<...> }
 *     -> `{ ok: true, previewAxes }` — merges the given fields onto whatever
 *        is already persisted (via `mergeStudioMeta`, itself a merge), so a
 *        direction toggle can never clobber a previously-saved color scheme
 *        or locale and vice versa, and every OTHER `.studio/meta.json` field
 *        (`displayName`, `pagesDir`, the cached `profile`, …) survives
 *        untouched.
 *
 * `locale` (WS-10 §4.2, Phase 3) IS in the wire schema now — this route is
 * the ONE place a client sets it (`PreviewAxesControls.tsx`'s locale
 * `Select`), replacing the old hand-typed `previewLocale` JSON field.
 * `readStudioMeta` folds an already-imported project's legacy top-level
 * `previewLocale` into `previewAxes.locale` on read (`studioMeta.ts`'s
 * `foldLegacyPreviewLocale`), so `resolvePreviewAxes` below never has to know
 * which shape a given `meta.json` was written in — see that fold's own doc
 * for why this is a data migration on the read path, not two code paths.
 * Unlike `direction`/`colorScheme` (render-time, applied via a frame
 * attribute effect — see `previewAxesFrameEffect.ts`), setting `locale` is
 * PARSE-TIME: the caller (`PreviewAxesControls.tsx`) must also trigger
 * `requestCmsSiteReload()` after this POST resolves, or the board keeps
 * showing whatever locale it last parsed in.
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
  locale: Type.Optional(Type.String({ minLength: 1 })),
})

const PreviewAxesPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  previewAxes: PreviewAxesPatchSchema,
})
export type PreviewAxesPostBody = Static<typeof PreviewAxesPostBodySchema>

/** Resolved, fully-populated axes for a project — persisted partial fields win, everything else falls back to the default. `locale` stays `undefined` unless a POST (or a folded legacy `previewLocale`) has set one — `DEFAULT_PREVIEW_AXES` deliberately carries no locale (see its own doc). */
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
