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
 *     -> `{ trust, live, autoPromoted }` — the CURRENT tier, defaulting to
 *        `'static'` (Tier 0) exactly like every other reader of
 *        `readStudioMeta(dir).trust` in this codebase, plus whether this
 *        project's real app could be run at all (`./liveCapability.ts`) and
 *        whether Studio has already spent its one automatic promotion on it.
 *   POST /admin/api/studio/trust-tier { dir, trust, autoPromoted? }
 *     -> `{ ok: true, trust }` — persists the requested tier via
 *        `mergeStudioMeta`, which preserves every other `.studio/meta.json`
 *        field (`displayName`, `pagesDir`, the cached `profile`, …).
 *        `autoPromoted: true` additionally records the once-per-project
 *        latch, and is refused with 409 unless every condition of the owner's
 *        override still holds — see {@link refuseAutoPromotion}.
 *
 * Deliberately NOT a general-purpose meta-patch endpoint — one field, one
 * job, same "each concern owns its own sub-router" reasoning
 * `STUDIO_SUB_ROUTERS` documents in `studio.ts`.
 *
 * ## The rule this route used to state, and what replaced it
 *
 * This module's doc used to say trust promotion was "an explicit user action,
 * never something a background fetch triggers on its own". **The owner
 * narrowed that on 2026-09-17** (`STUDIO-FIGMA-FEEL-PLAN.md` §6 decision 2):
 * a Vite project with a lockfile is promoted to Tier 2 on first open, once,
 * with a visible notice and an Undo in the board chrome. Everything else is
 * unchanged — Tier 1 promotion is still a click, a non-Vite project is never
 * touched, and a project whose owner clicked Undo is never promoted again.
 * `CLAUDE.md`'s invariant 1 and `PROJECT-BRIEF.md` §2/§3 carry the same
 * amendment.
 *
 * Containment is `resolveProjectDir`'s, once for every project-scoped route:
 * a `dir` outside `studio-workspace/` throws there and the router answers 404,
 * so this handler never sees one.
 *
 * This module only reads/writes the field — it is not where a Tier-2
 * (`run-project`) route refuses. That check is `./trustGate.ts`'s
 * `requireTrustTier`, shared by `deploy.ts` and `devServer.ts` (Track L,
 * `live-01`); it answers a 409, not the 200 this endpoint always returns.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { resolveLiveCapability } from './liveCapability'
import { DEFAULT_TRUST_TIER, mergeStudioMeta, readStudioMeta, TrustTierSchema } from './studioMeta'

const ROUTE_PATH = '/admin/api/studio/trust-tier'

const TrustTierPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  trust: TrustTierSchema,
  /**
   * P8 / §6 decision 2 — this write is Studio's own one-time automatic
   * promotion of a Vite project, not a user's click. Every condition is
   * RE-CHECKED here before anything is written (see {@link refuseAutoPromotion}):
   * a client that sets this flag is asking for a gate, not passing one.
   */
  autoPromoted: Type.Optional(Type.Boolean()),
})
export type TrustTierPostBody = Static<typeof TrustTierPostBodySchema>

/**
 * The three conditions an automatic promotion must satisfy, re-checked
 * server-side on every request. Returns the refusal message, or `null` when
 * the promotion is allowed.
 *
 * The owner's 2026-09-17 override is narrow and each clause is one word of it:
 * **a Vite project with a lockfile** is promoted **to Tier 2** **on first
 * open**. A client that could widen any of the three — promote a Next project,
 * promote to a tier the rule never mentioned, or re-promote a project whose
 * owner already clicked Undo — would have turned a bounded override into
 * "Studio runs whatever it finds". So none of this is taken on trust from the
 * request; the request only says which case it believes it is in.
 */
function refuseAutoPromotion(dir: string, trust: string): string | null {
  if (trust !== 'run-project') {
    return 'Automatic promotion only ever writes run-project. Ask for that tier or promote explicitly.'
  }
  const capability = resolveLiveCapability(dir)
  if (!capability.capable) {
    return capability.reason === 'not-vite'
      ? 'This project is not a Vite project, so Studio never promotes it automatically.'
      : 'This project has no lockfile, so Studio never promotes it automatically.'
  }
  if (readStudioMeta(dir).trustAutoPromotedAt !== undefined) {
    return 'This project has already had its one automatic promotion. Promote it explicitly instead.'
  }
  return null
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
        // The once-per-project latch, not "is it currently auto-promoted":
        // true also for a project whose owner clicked Undo, which is exactly
        // what stops the next open from promoting it again.
        autoPromoted: meta.trustAutoPromotedAt !== undefined,
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

      if (body.autoPromoted === true) {
        const refusal = refuseAutoPromotion(dir, body.trust)
        if (refusal) return jsonResponse({ error: refusal }, { status: 409 })
        mergeStudioMeta(dir, { trust: body.trust, trustAutoPromoted: true, trustAutoPromotedAt: Date.now() })
        return jsonResponse({ ok: true, trust: body.trust })
      }

      // An explicit user action: a bare `trust` write, never touching the
      // auto-promotion fields. That is what keeps the two origins — and the
      // once-per-project latch — distinguishable on disk afterwards.
      mergeStudioMeta(dir, { trust: body.trust })
      return jsonResponse({ ok: true, trust: body.trust })
    } catch (err) {
      rethrowProjectDirRefusal(err)
      console.error('[studio:trustTier]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
