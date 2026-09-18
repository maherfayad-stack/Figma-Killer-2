/**
 * An authenticated caller for the Studio HTTP surface.
 *
 * `tryServeStudio` now gates every `/admin/api/studio/*` request on a session
 * and a capability (`studio/routeGate.ts`), so a route test that builds a bare
 * `Request` gets a 401 and proves nothing about the route. This helper boots
 * the same in-memory database the capability tests use, syncs the system roles
 * exactly as `server/index.ts` does at boot, signs in as the Owner — the
 * single-operator posture, which holds every capability — and stamps that
 * session cookie onto each request.
 *
 * The response is returned RAW, `null` and thrown `ProjectDirOutsideWorkspaceError`
 * included, because that is what `server/router.ts` sees and several route
 * tests assert on exactly those.
 */
import { syncSystemRoles } from '../../../repositories/roles'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../../../../src/__tests__/helpers/capabilityHarness'
import { tryServeStudio } from '../../studio'

export interface StudioRouteTestHarness {
  /** Drive one request through `tryServeStudio` as the signed-in Owner. */
  serve(req: Request, url: URL): Promise<Response | null>
  /** The Owner's session cookie, for a test that needs to build the request itself. */
  readonly ownerCookie: string
  cleanup(): Promise<void>
}

export async function createStudioRouteTestHarness(): Promise<StudioRouteTestHarness> {
  const harness: CapabilityTestHarness = await createCapabilityTestHarness()
  await syncSystemRoles(harness.db)
  const ownerCookie = await harness.setupOwner()

  return {
    ownerCookie,
    serve(req, url) {
      req.headers.set('cookie', ownerCookie)
      return tryServeStudio(req, { db: harness.db }, url, url.pathname)
    },
    cleanup: harness.cleanup,
  }
}
