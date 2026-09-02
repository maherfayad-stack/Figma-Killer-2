/**
 * trustTier — `GET/POST /admin/api/studio/trust-tier`, the small read/write
 * surface for `.studio/meta.json`'s `trust` field (`studioMeta.ts`'s
 * `TrustTierSchema`) that WS-3.3's "one-click promote" placeholder needs and
 * that did not exist anywhere in the client before this change — every other
 * Tier-1-gated route (`componentBundle.ts`, `styleCompile.ts`) could REFUSE
 * with a "promote this project" message, but nothing could actually act on
 * it. This is that action.
 *
 *   GET  /admin/api/studio/trust-tier?dir=<abs>
 *     -> `{ trust }` — the CURRENT tier, defaulting to `'static'` (Tier 0,
 *        `meta-03` decision 1: never auto-promoted) exactly like every other
 *        reader of `readStudioMeta(dir).trust` in this codebase.
 *   POST /admin/api/studio/trust-tier { dir, trust }
 *     -> `{ ok: true, trust }` — persists the requested tier via
 *        `mergeStudioMeta`, which preserves every other `.studio/meta.json`
 *        field (`displayName`, `pagesDir`, the cached `profile`, …).
 *
 * Deliberately NOT a general-purpose meta-patch endpoint — one field, one
 * job, same "each concern owns its own sub-router" reasoning
 * `STUDIO_SUB_ROUTERS` documents in `studio.ts`. This is an explicit, EXPLICIT
 * user action (a click on "Promote this project"), never something a
 * background fetch triggers on its own — trust promotion is a real consent
 * boundary (`meta-03` decision 1), and consent has to come from a route a
 * button calls, not a side effect of loading a page.
 *
 * Same containment posture as every other project-scoped route:
 * `resolveProjectDir` + `isRealpathContained(dir, projectsRootDir())`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { DEFAULT_TRUST_TIER, mergeStudioMeta, readStudioMeta } from './studioMeta'

const ROUTE_PATH = '/admin/api/studio/trust-tier'

const TrustTierValueSchema = Type.Union([
  Type.Literal('static'),
  Type.Literal('render-packages'),
  Type.Literal('run-project'),
])

const TrustTierPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  trust: TrustTierValueSchema,
})
export type TrustTierPostBody = Static<typeof TrustTierPostBodySchema>

/** `GET/POST /admin/api/studio/trust-tier` — see module doc for the full contract. */
export async function tryServeStudioTrustTier(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
      const trust = readStudioMeta(dir).trust ?? DEFAULT_TRUST_TIER
      return jsonResponse({ trust })
    } catch (err) {
      console.error('[studio:trustTier]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, TrustTierPostBodySchema)
      if (!body) return badRequest('invalid trust-tier body')
      const dir = resolveProjectDir(body.dir)
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

      mergeStudioMeta(dir, { trust: body.trust })
      return jsonResponse({ ok: true, trust: body.trust })
    } catch (err) {
      console.error('[studio:trustTier]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
