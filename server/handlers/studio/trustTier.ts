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
 *     -> `{ trust, live }` — the CURRENT tier, defaulting to
 *        `DEFAULT_TRUST_TIER` (`run-project`, Tier 2 — owner decision,
 *        2026-09-20) exactly like every other reader of
 *        `readStudioMeta(dir).trust` in this codebase, plus whether this
 *        project's real app could be run at all (`./liveCapability.ts`).
 *   POST /admin/api/studio/trust-tier { dir, trust }
 *     -> `{ ok: true, trust }` — persists the requested tier via
 *        `mergeStudioMeta`, which preserves every other `.studio/meta.json`
 *        field (`displayName`, `pagesDir`, the cached `profile`, …). The ONE
 *        write path to the field — every promote and every demote in the
 *        client goes through here.
 *
 * Deliberately NOT a general-purpose meta-patch endpoint — one field, one
 * job, same "each concern owns its own sub-router" reasoning
 * `STUDIO_SUB_ROUTERS` documents in `studio.ts`.
 *
 * ## Every project starts at Tier 2 — owner decision, 2026-09-20
 *
 * This module used to state an intermediate rule (`STUDIO-FIGMA-FEEL-PLAN.md`
 * §6 decision 2): a Vite project with a lockfile was promoted to Tier 2 on
 * first open, once, with a visible notice and an Undo. **That mechanism is
 * gone.** The owner's later call was narrower and simpler: every project
 * starts at `run-project` (`DEFAULT_TRUST_TIER`), full stop — there is
 * nothing left to auto-promote, because there is no lower default to promote
 * FROM. `trust` is now purely a per-project fact the owner can lower (the
 * Live pill's "Back to static") and raise again; nothing writes it as a side
 * effect of loading a page. `CLAUDE.md`'s invariant 1 and `PROJECT-BRIEF.md`
 * §2/§3 carry the same statement.
 *
 * Containment is `resolveProjectDir`'s, once for every project-scoped route:
 * a `dir` outside `studio-workspace/` throws there and the router answers 404,
 * so this handler never sees one.
 *
 * This module only reads/writes the field — it is not where a Tier-2
 * (`run-project`) route refuses. That check is `./trustGate.ts`'s
 * `requireTrustTier`, shared by `deploy.ts` and `devServer.ts` (Track L,
 * `live-01`); it answers a 409, not the 200 this endpoint always returns.
 *
 * It does, however, ENFORCE a demotion on the process that tier was already
 * authorising: a write that leaves the project below `run-project` stops its
 * dev server before answering. See {@link enforceTierOnRunningProcesses} for
 * why a demotion that only edits a file is not a demotion.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody, internalServerError } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { stopDevServer } from './devServer'
import { resolveLiveCapability } from './liveCapability'
import { DEFAULT_TRUST_TIER, mergeStudioMeta, readStudioMeta, type TrustTier, TrustTierSchema } from './studioMeta'

const ROUTE_PATH = '/admin/api/studio/trust-tier'

const TrustTierPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  trust: TrustTierSchema,
})
export type TrustTierPostBody = Static<typeof TrustTierPostBodySchema>

/**
 * A demotion has to STOP the project, not merely record that it should no
 * longer be running.
 *
 * Writing `trust: 'static'` closes the two Tier-2 ROUTES (`devServer.ts`'s
 * `status`/`start`, `deploy.ts`) and makes `/load` stop handing out a
 * `projectKey`. It does nothing at all to a dev server that is ALREADY
 * running, and `useDevServerPrewarm` starts one the instant a project reaches
 * Tier 2 — so before this call existed, the board's "Undo" (and every explicit
 * demotion) left the user's own dev server executing indefinitely: the
 * browser-facing `startDevServer` never schedules an idle teardown, and
 * `server/liveOrigin.ts` deliberately does not re-read `.studio/meta.json`
 * ("a project only ever reaches `phase: 'ready'` in that registry if it was
 * allowed to boot"), so the unauthenticated `/p/<projectKey>/` proxy kept
 * serving it too. The undo was cosmetic with respect to the one property it
 * exists to restore.
 *
 * Here rather than in the client's demote handler for the usual reason: this
 * is the ONE write path to the field, so every demotion — the Live pill's
 * "Back to static", any future settings toggle — inherits it, and none of
 * them can forget. Idempotent: `stopDevServer` is a no-op for a project that
 * has no process in the registry.
 */
function enforceTierOnRunningProcesses(dir: string, trust: TrustTier): void {
  if (trust === 'run-project') return
  stopDevServer(dir)
}

/** `GET/POST /admin/api/studio/trust-tier` — see module doc for the full contract. */
export async function tryServeStudioTrustTier(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const meta = readStudioMeta(dir)
      return jsonResponse({
        trust: meta.trust ?? DEFAULT_TRUST_TIER,
        live: resolveLiveCapability(dir),
      })
    } catch (err) {
      rethrowProjectDirRefusal(err)
      console.error('[studio:trustTier]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, TrustTierPostBodySchema)
      if (!body) return badRequest('invalid trust-tier body')
      const dir = resolveProjectDir(body.dir)

      // The one write path to the field — every promote and every demote in
      // the client goes through here.
      mergeStudioMeta(dir, { trust: body.trust })
      enforceTierOnRunningProcesses(dir, body.trust)
      return jsonResponse({ ok: true, trust: body.trust })
    } catch (err) {
      rethrowProjectDirRefusal(err)
      return internalServerError('[studio:trustTier]', err)
    }
  }

  return null
}
