/**
 * localizedPage — `GET /admin/api/studio/localized-page`, WS-10 §4.2/§4.4
 * (Phase 4)'s read surface for a single `(pageId, locale)` tree.
 *
 *   GET /admin/api/studio/localized-page?dir=<abs>&pageId=<id>&locale=<key>
 *     -> `{ page: Page | null }` — `null` when `pageId` doesn't exist on
 *        this project (never a 404/500 for that case — see
 *        `loadStudioPageInLocale`'s own doc for why "not found" degrades to
 *        a value, not an error).
 *
 * Deliberately its OWN small route, not folded into `/admin/api/studio/load`:
 * that endpoint returns the WHOLE site at the board's default locale; this
 * one is fetched ON DEMAND, per board frame, only when a frame's own
 * `axes.locale` differs from the board default (`localizedPageSlice.ts`'s
 * `ensureLocalizedPage` — client-side caching means this fires at most once
 * per `(pageId, locale)` pair per session, not per render).
 *
 * Same containment posture as every other project-scoped route:
 * `resolveProjectDir` + `isRealpathContained(dir, projectsRootDir())`.
 */
import { jsonResponse } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { loadStudioPageInLocale } from '../studioPageLoad'

const ROUTE_PATH = '/admin/api/studio/localized-page'

/**
 * `GET /admin/api/studio/localized-page` — see module doc for the full
 * contract. Response shape (`{ page: Page | null }`) is validated CLIENT-side
 * by `localizedPageSlice.ts`'s `LocalizedPageResponseSchema` (`@core/page-tree`'s
 * `PageSchema`) — no schema declared here, matching every other GET route in
 * this folder (`previewAxes.ts`, `projectProbe.ts`).
 */
export async function tryServeStudioLocalizedPage(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'GET') return null

  try {
    const dir = resolveProjectDir(url.searchParams.get('dir'))
    if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

    const pageId = url.searchParams.get('pageId')
    const locale = url.searchParams.get('locale')
    if (!pageId || !locale) return jsonResponse({ error: 'pageId and locale query params are required' }, { status: 400 })

    const page = await loadStudioPageInLocale(dir, pageId, locale)
    return jsonResponse({ page })
  } catch (err) {
    console.error('[studio:localizedPage]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
