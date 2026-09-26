/**
 * trustGate — the shared `trust-tier-required` refusal, extracted out of
 * `deploy.ts`'s inline check so `devServer.ts` (this project's second
 * consumer) doesn't hand-roll a third copy of "read `.studio/meta.json`'s
 * trust, compare against what this route needs, 409 if it doesn't match."
 * Same wire shape every existing Tier-2 refusal already used before this
 * extraction: `{ error, code: 'trust-tier-required' }` at HTTP 409.
 *
 * ## Two renderings of one check
 *
 * `checkTrustTier` is the decision — a plain, transport-free verdict. Two
 * consumers render it differently and neither may re-derive it:
 *
 *   - **HTTP routes** (`deploy.ts`, `devServer.ts`) call `requireTrustTier`,
 *     which wraps the verdict in the ready-made 409.
 *   - **Agent / MCP tools** (`referenceRender.ts`) call `checkTrustTier` and
 *     return a structured `toolRefusal('trust-tier-required', …)` instead,
 *     because a tool result is a JSON payload the model reads, not a
 *     `Response` — handing it an HTTP object would strip the code.
 *
 * Both exist because A10 (STUDIO-FIGMA-FEEL-PLAN.md) closed `sec-05`
 * finding 1: `studio_render_reference` was gated ONLY by the connector
 * capability `studio.run.project`, so a connector holding it could boot ANY
 * project's dev server — including one whose owner never promoted it. The
 * capability answers "may this caller run project code at all"; the project's
 * own tier answers "may THIS project be run". A Tier-2 tool needs both, and
 * the per-project half is this function.
 *
 * **Not** the Tier-1 gate `componentBundle.ts`/`styleCompile.ts` use
 * (`trust !== 'static'`, answered 200 `{ ok: false, code }`) — deliberately
 * left alone. Different contract (200 vs 409), different tier, different
 * caller expectations (a canvas placeholder vs. a route refusal) — unifying
 * it here would blur two things that need to stay distinguishable.
 */
import { jsonResponse } from '../../http'
import { DEFAULT_TRUST_TIER, readStudioMeta, type TrustTier } from './studioMeta'

export interface TrustTierCheckOk {
  ok: true
  trust: TrustTier
}

export interface TrustTierCheckRefused {
  ok: false
  /** The tier the project is actually at. */
  trust: TrustTier
  /** The tier the caller needed. */
  required: TrustTier
}

export type TrustTierCheck = TrustTierCheckOk | TrustTierCheckRefused

export interface TrustTierGateOk {
  ok: true
  trust: TrustTier
}

export interface TrustTierGateRefusal {
  ok: false
  /** Ready-made 409 `{ error, code: 'trust-tier-required' }` — the caller returns this directly. */
  response: Response
}

export type TrustTierGateResult = TrustTierGateOk | TrustTierGateRefusal

/** The one refusal code every Tier-2 gate answers with, HTTP route or agent tool. */
export const TRUST_TIER_REQUIRED_CODE = 'trust-tier-required'

/**
 * Reads `.studio/meta.json`'s `trust` field (defaulting to
 * `DEFAULT_TRUST_TIER`, which is `run-project` (Tier 2) per the owner's
 * decision recorded in `studioMeta.ts`, the same default every other
 * `readStudioMeta(...).trust` reader applies) and reports whether it equals
 * `required` exactly. A project whose meta says `static` is refused.
 *
 * ## `projectDir`, never an app root — this is the whole contract
 *
 * `.studio/` is a **project-directory** sidecar. It is created at the
 * directory `resolveProjectDir` returns, it is listed in
 * `EXCLUDED_WORKSPACE_DIR_NAMES` so nothing ever walks into it, and every one
 * of the ~60 `readStudioMeta` call sites in this tree keys on the project
 * directory. A monorepo import whose real `package.json` sits at
 * `<project>/apps/web` has an app root (`resolveAppRoot`) that is NOT the
 * project directory — and `<project>/apps/web/.studio/meta.json` does not
 * exist, so reading the tier there silently answers `DEFAULT_TRUST_TIER`
 * forever, whatever tier the owner actually chose for the project.
 *
 * **Since the default became `run-project`, that misread FAILS OPEN.** A
 * project whose owner lowered it to `static` would be granted Tier 2 (its own
 * dev server, a preview deploy) because the lookup missed the file that says
 * `static`. Under the old Tier 0 default the same misread failed closed. So
 * a wrong `projectDir` here is now a privilege grant, not a harmless refusal.
 *
 * That was a real, shipped defect, not a hypothetical: `deploy.ts` read the
 * tier off `resolveAppRoot(dir)` while `devServer.ts` and `referenceRender.ts`
 * read the project directory, so a monorepo project could be promoted to Tier
 * 2, boot a dev server, and still never deploy (`sec-12`). Both callers now
 * pass the project directory and the parameter is named for it.
 *
 * The app root is still the right answer for everything that needs the
 * project's CODE — the install cwd, `node_modules`, the provider CLI's working
 * directory. It is never the right answer for Studio's own sidecar.
 *
 * Transport-free on purpose: an HTTP route renders this as a 409
 * (`requireTrustTier`), an agent tool renders it as a structured refusal.
 * Neither re-reads the meta file itself, so the two can never disagree about
 * what a project's tier is.
 */
export function checkTrustTier(projectDir: string, required: TrustTier): TrustTierCheck {
  const trust = readStudioMeta(projectDir).trust ?? DEFAULT_TRUST_TIER
  if (trust !== required) return { ok: false, trust, required }
  return { ok: true, trust }
}

/**
 * The HTTP rendering of `checkTrustTier`: refuses with a 409 carrying
 * `code: 'trust-tier-required'` unless the project's tier equals `required`
 * exactly.
 *
 * `projectDir` is the PROJECT directory — see {@link checkTrustTier} for why
 * an app root is never acceptable here.
 */
export function requireTrustTier(projectDir: string, required: TrustTier, message: string): TrustTierGateResult {
  const check = checkTrustTier(projectDir, required)
  if (!check.ok) {
    return {
      ok: false,
      response: jsonResponse({ error: message, code: TRUST_TIER_REQUIRED_CODE }, { status: 409 }),
    }
  }
  return { ok: true, trust: check.trust }
}
