/**
 * The Studio route gate, driven adversarially against the REAL route table.
 *
 * Every case here walks `STUDIO_ROUTE_CAPABILITIES` rather than naming paths,
 * so a route added next week is covered the moment its declaration lands —
 * which is the whole point of declaring capabilities as data. A per-route
 * hand-written case list would have been stale by the third new endpoint, and
 * "the CSRF check reached half the git surface" (`sec-13`) is exactly what
 * that staleness looks like in production.
 *
 * Three properties, asserted for every declared route:
 *
 *   1. No session → 401. The refusal happens in the gate, so nothing under
 *      `studio-workspace/` is read, written, cloned, deployed or spawned.
 *   2. A signed-in user with no Studio capability → 403 `{ error: 'Forbidden' }`.
 *   3. A cross-origin `text/plain` form POST → 403 `{ error: 'Forbidden: invalid origin' }`,
 *      BEFORE the session is even looked up. `readValidatedBody` calls
 *      `req.json()` whatever the content type, so `text/plain` is the shape
 *      that reaches a JSON route with no preflight and no CORS opt-in.
 *
 * `Origin` is a forbidden header in the `Request` constructor — it is set with
 * `req.headers.set('origin', …)` afterwards. A test that passes it in the
 * constructor's `headers` bag silently sends no Origin at all, and
 * `originAllowed` trusts a missing Origin (curl, server-to-server), so such a
 * test passes for the wrong reason. See `githubAuth.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../../../src/__tests__/helpers/capabilityHarness'
import {
  resolveStudioRouteCapability,
  STUDIO_ROUTE_CAPABILITIES,
} from '../studio/routeCapabilities'
import { syncSystemRoles } from '../../repositories/roles'
import { SYSTEM_ROLES } from '../../auth/capabilities'

const EVIL_ORIGIN = 'https://evil.test'

let harness: CapabilityTestHarness
/** Owner — holds every capability, which is the single-operator posture this gate must not break. */
let ownerCookie: string
/** A real session that holds nothing Studio cares about. */
let powerlessCookie: string

const READ_ROUTES = STUDIO_ROUTE_CAPABILITIES.filter((entry) => entry.read !== null)
const MUTATING_ROUTES = STUDIO_ROUTE_CAPABILITIES.filter((entry) => entry.mutate !== null)

beforeAll(async () => {
  harness = await createCapabilityTestHarness()
  // `server/index.ts` runs this after the migrations on every boot; the test
  // DB stops at the migrations' seed, which is a snapshot of the capability
  // list at the time that migration was written. Without it the harness Owner
  // is NOT the Owner a real installation has, and "the default operator holds
  // every capability" would be tested against the wrong row.
  await syncSystemRoles(harness.db)
  ownerCookie = await harness.setupOwner()
  // `dashboard.read` only: enough to be a real, logged-in user, and not one
  // of the five capabilities any Studio route accepts.
  const powerless = await harness.createRoleUser({
    name: 'Studio Nobody',
    slug: 'studio-nobody',
    capabilities: ['dashboard.read'],
  })
  powerlessCookie = powerless.cookie
})

afterAll(async () => {
  await harness.cleanup()
})

/** A cross-origin `<form enctype="text/plain">` POST — no preflight, no CORS, full control of the body. */
function crossOriginFormPost(path: string): Request {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ dir: 'C:/anything', confirm: true }),
  })
  req.headers.set('origin', EVIL_ORIGIN)
  // The victim IS signed in — that is the only interesting version of this
  // attack. The origin check must refuse anyway.
  req.headers.set('cookie', ownerCookie)
  return req
}

describe('studio route gate — the table is non-trivial', () => {
  it('declares both reads and mutations across the surface', () => {
    expect(READ_ROUTES.length).toBeGreaterThan(20)
    expect(MUTATING_ROUTES.length).toBeGreaterThan(20)
  })
})

describe('studio route gate — no session', () => {
  it.each(READ_ROUTES.map((entry) => [entry.path] as const))(
    'GET %s refuses an unauthenticated caller with 401',
    async (path) => {
      const res = await harness.studio(path)
      expect(res.status).toBe(401)
      expect((await readJson<{ error?: string }>(res)).error).toBe('Unauthorized')
    },
  )

  it.each(MUTATING_ROUTES.map((entry) => [entry.path] as const))(
    'POST %s refuses an unauthenticated caller with 401',
    async (path) => {
      const res = await harness.studio(path, { method: 'POST', json: { dir: 'C:/anything' } })
      expect(res.status).toBe(401)
    },
  )
})

describe('studio route gate — under-privileged session', () => {
  it.each(READ_ROUTES.map((entry) => [entry.path] as const))(
    'GET %s refuses a session without the capability with 403',
    async (path) => {
      const res = await harness.studio(path, { cookie: powerlessCookie })
      expect(res.status).toBe(403)
      expect((await readJson<{ error?: string }>(res)).error).toBe('Forbidden')
    },
  )

  it.each(MUTATING_ROUTES.map((entry) => [entry.path] as const))(
    'POST %s refuses a session without the capability with 403',
    async (path) => {
      const res = await harness.studio(path, {
        cookie: powerlessCookie,
        method: 'POST',
        json: { dir: 'C:/anything' },
      })
      expect(res.status).toBe(403)
      expect((await readJson<{ error?: string }>(res)).error).toBe('Forbidden')
    },
  )
})

describe('studio route gate — CSRF', () => {
  it.each(MUTATING_ROUTES.map((entry) => [entry.path] as const))(
    'a cross-origin text/plain form POST to %s is refused',
    async (path) => {
      const res = await harness.studioRequest(crossOriginFormPost(path))
      expect(res.status).toBe(403)
      expect((await readJson<{ error?: string }>(res)).error).toBe('Forbidden: invalid origin')
    },
  )

  it('refuses the forged origin before the session is consulted', async () => {
    // Same request, no cookie at all. A gate that authenticated first would
    // answer 401 here; answering 403-invalid-origin proves the order.
    const req = new Request('http://localhost/admin/api/studio/save', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ dir: 'C:/anything', edits: [] }),
    })
    req.headers.set('origin', EVIL_ORIGIN)

    const res = await harness.studioRequest(req)
    expect(res.status).toBe(403)
    expect((await readJson<{ error?: string }>(res)).error).toBe('Forbidden: invalid origin')
  })

  it('allows a same-origin POST from the operator', async () => {
    const req = new Request('http://localhost/admin/api/studio/boards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: 'C:/definitely-not-a-project', boards: {} }),
    })
    req.headers.set('origin', 'http://localhost')
    req.headers.set('cookie', ownerCookie)

    const res = await harness.studioRequest(req)
    // Past both gates. The 404 that remains is the project-dir guard refusing
    // a `dir` outside `studio-workspace/` — an auth answer would be 401/403.
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
    expect(res.status).toBe(404)
  })
})

describe('studio route gate — capability separation', () => {
  it('a Studio editor without site.structure.edit cannot push, run, or deploy', async () => {
    // Files yes, history no: `studio.write` edits the project's source, while
    // rewriting the repository's history is `site.structure.edit` and running
    // its code is `studio.run.project`.
    const editor = await harness.createRoleUser({
      name: 'Studio Editor',
      slug: 'studio-editor',
      capabilities: ['site.read', 'site.content.edit', 'studio.write'],
    })

    const push = await harness.studio('/admin/api/studio/git/push', {
      cookie: editor.cookie,
      method: 'POST',
      json: { dir: 'C:/anything' },
    })
    expect(push.status).toBe(403)

    const devServer = await harness.studio('/admin/api/studio/dev-server/start', {
      cookie: editor.cookie,
      method: 'POST',
      json: { dir: 'C:/anything' },
    })
    expect(devServer.status).toBe(403)

    const deploy = await harness.studio('/admin/api/studio/deploy', {
      cookie: editor.cookie,
      method: 'POST',
      json: { dir: 'C:/anything', provider: 'vercel', confirm: true },
    })
    expect(deploy.status).toBe(403)

    const trustTier = await harness.studio('/admin/api/studio/trust-tier', {
      cookie: editor.cookie,
      method: 'POST',
      json: { dir: 'C:/anything', trust: 'run-project' },
    })
    expect(trustTier.status).toBe(403)

    // The same session still reaches the routes it IS meant to reach.
    const projects = await harness.studio('/admin/api/studio/projects', { cookie: editor.cookie })
    expect(projects.status).toBe(200)
  })

  it('a reviewer with only site.read cannot write, but can read and comment', async () => {
    const reviewer = await harness.createRoleUser({
      name: 'Studio Reviewer',
      slug: 'studio-reviewer',
      capabilities: ['site.read', 'site.content.edit'],
    })

    const save = await harness.studio('/admin/api/studio/save', {
      cookie: reviewer.cookie,
      method: 'POST',
      json: { dir: 'C:/anything', edits: [] },
    })
    expect(save.status).toBe(403)

    const trash = await harness.studio('/admin/api/studio/trash', { cookie: reviewer.cookie })
    expect(trash.status).toBe(200)

    const purge = await harness.studio('/admin/api/studio/trash/purge', {
      cookie: reviewer.cookie,
      method: 'POST',
      json: { entry: 'anything' },
    })
    expect(purge.status).toBe(403)
  })
})

describe('studio route gate — undeclared paths', () => {
  const probes = [
    '/admin/api/studio/not-a-route',
    // `/save` is an exact entry, not a namespace — a sub-path of it is not a
    // route. (`save/../projects` is NOT tested here: the URL parser
    // normalises it to `/admin/api/studio/projects` before any handler sees
    // it, so it is a declared route by the time the gate runs.)
    '/admin/api/studio/save/extra',
    '/admin/api/studio/SAVE',
    '/admin/api/studio/loadx',
  ] as const

  it('resolves no capability for a path the table does not name', () => {
    for (const path of probes) {
      expect(resolveStudioRouteCapability(path)).toBeNull()
    }
    // …but a declared namespace root still resolves, so `git/<new-action>`
    // inherits `studio.git.write` instead of arriving ungated.
    expect(resolveStudioRouteCapability('/admin/api/studio/git/brand-new-verb')?.mutate)
      .toBe('site.structure.edit')
  })

  it('answers 404 for an undeclared path, even for the owner', async () => {
    for (const path of probes) {
      const res = await harness.studio(path, { cookie: ownerCookie })
      expect(res.status).toBe(404)
      expect((await readJson<{ error?: string }>(res)).error).toBe('Not found')
    }
  })

  it('answers 404 for a declared route asked with a method it does not have', async () => {
    // `/save` is POST-only; `/load` is GET-only. Neither may fall through to
    // the admin SPA, and neither may report which methods DO exist.
    const getSave = await harness.studio('/admin/api/studio/save', { cookie: ownerCookie })
    expect(getSave.status).toBe(404)

    const postLoad = await harness.studio('/admin/api/studio/load', {
      cookie: ownerCookie,
      method: 'POST',
      json: {},
    })
    expect(postLoad.status).toBe(404)
  })

  it('the Owner role holds every capability the table can require', () => {
    // The single-operator posture: gating the surface must not make the
    // default installation owner unable to use it.
    const owner = SYSTEM_ROLES.find((role) => role.id === 'owner')
    expect(owner).toBeDefined()
    for (const entry of STUDIO_ROUTE_CAPABILITIES) {
      for (const capability of [entry.read, entry.mutate]) {
        if (capability) expect(owner!.capabilities).toContain(capability)
      }
    }
  })

  it('leaves non-Studio paths to the rest of the router', async () => {
    const res = await harness.studio('/admin/api/cms/pages', { cookie: ownerCookie })
    // `tryServeStudio` returned null; the harness turned that into its own 404
    // envelope rather than a gate refusal.
    expect(res.status).toBe(404)
  })
})
