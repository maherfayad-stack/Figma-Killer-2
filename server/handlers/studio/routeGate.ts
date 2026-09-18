/**
 * The single gate every `/admin/api/studio/*` request passes before any
 * sub-router sees it.
 *
 * Four questions, in this order, and the order is the design:
 *
 *   1. **Is this a Studio path at all?** No → `null`, and `tryServeStudio`
 *      falls through to the rest of the router exactly as it did before.
 *   2. **Is the route declared?** `routeCapabilities.ts` is the only place a
 *      Studio route exists. An undeclared path answers 404 here, before a
 *      sub-router runs, before `resolveProjectDir` touches the filesystem.
 *   3. **CSRF.** A state-changing method must carry an acceptable `Origin`.
 *      Runs BEFORE the session lookup so a forged cross-origin POST costs a
 *      header comparison rather than a database round trip, and so the
 *      refusal cannot depend on whether the victim happened to be signed in.
 *   4. **Capability.** `requireCapability` with the declaration's capability
 *      for this method class. The resolved `AuthUser` is handed back so the
 *      sub-routers that act on behalf of somebody (a comment's byline, a
 *      share's owner, a capture's fallback tab) do not repeat the lookup.
 *
 * ## Why the gate resolves the user instead of each handler
 *
 * Before this module, six Studio sub-routers each called
 * `requireAuthenticatedUser`/`requireCapability` themselves and ~45 routes
 * called nothing (`sec-05` finding 2). Two policies — one written down in
 * six places and one that was an accident — cannot be kept in agreement.
 * Now there is one: the gate decides, and `StudioSessionRuntime` carries the
 * answer. A sub-router cannot be reached un-gated, and cannot disagree about
 * what gated it.
 *
 * ## CSRF scope
 *
 * `sec-13` extended `originAllowed` to the three git sub-routers and named
 * the rest of the surface as this wave's job; this is that job. The check
 * matters for the whole surface and not only for the routes that read a
 * session: `readValidatedBody` calls `req.json()` whatever the content type,
 * so a cross-origin `<form enctype="text/plain">` — no preflight, no CORS,
 * no opt-in from the browser — reaches any Studio POST with a body it fully
 * controls. `SameSite=Lax` does not cover the same-site-different-subdomain
 * case, and the routes that read no cookie were never covered by it at all.
 *
 * The four sub-routers that already run `originAllowed` themselves keep
 * doing so. It is the same function at a lower altitude, both refuse, and a
 * handler that is also reachable from a test harness is better for having
 * its own check.
 */
import { jsonResponse } from '../../http'
import { isStateChangingMethod, originAllowed } from '../../auth/security'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import type { AuthUser } from '../../repositories/users'
import {
  resolveStudioRouteCapability,
  studioRouteCapabilityFor,
  STUDIO_ROUTE_PREFIX,
} from './routeCapabilities'

/**
 * What a Studio sub-router that acts on behalf of a user receives. The `user`
 * is the one the gate already authenticated — never re-resolved downstream.
 */
export interface StudioSessionRuntime {
  db: DbClient
  user: AuthUser
}

/**
 * `null`  — not a Studio path; the caller returns `null` and the router
 *           continues.
 * `Response` — refused (404 undeclared / 403 origin / 401 or 403 capability).
 * `{ user }` — allowed; hand the user to the session sub-routers.
 */
export type StudioRouteGateResult = { user: AuthUser } | Response | null

/**
 * A path under `/admin/api/studio/` that this build does not serve. Answered
 * with the same shape as every other Studio failure so a client never has to
 * distinguish "no such route" from "route refused you" by parsing HTML.
 */
function notFound(): Response {
  return jsonResponse({ error: 'Not found' }, { status: 404 })
}

export async function gateStudioRequest(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<StudioRouteGateResult> {
  if (!pathname.startsWith(STUDIO_ROUTE_PREFIX)) return null

  const declaration = resolveStudioRouteCapability(pathname)
  if (!declaration) return notFound()

  const stateChanging = isStateChangingMethod(req.method)
  const capability = studioRouteCapabilityFor(declaration, stateChanging)
  // The route exists but has no method of this class — a GET on `/save`, a
  // POST on `/load`. 404 rather than 405: the method is not a variant of a
  // resource the caller may address, and naming which methods DO exist tells
  // an unauthenticated prober more than it tells anyone else.
  if (!capability) return notFound()

  if (stateChanging && !originAllowed(req)) {
    return jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 })
  }

  const user = await requireCapability(req, db, capability)
  if (user instanceof Response) return user
  return { user }
}
