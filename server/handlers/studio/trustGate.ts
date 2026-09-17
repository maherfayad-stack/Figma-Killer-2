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
 * Reads `.studio/meta.json`'s `trust` field (defaulting to Tier 0, same as
 * every other `readStudioMeta(...).trust` reader) off whatever directory the
 * caller passes, and reports whether it equals `required` exactly.
 *
 * Transport-free on purpose: an HTTP route renders this as a 409
 * (`requireTrustTier`), an agent tool renders it as a structured refusal.
 * Neither re-reads the meta file itself, so the two can never disagree about
 * what a project's tier is.
 */
export function checkTrustTier(dir: string, required: TrustTier): TrustTierCheck {
  const trust = readStudioMeta(dir).trust ?? DEFAULT_TRUST_TIER
  if (trust !== required) return { ok: false, trust, required }
  return { ok: true, trust }
}

/**
 * The HTTP rendering of `checkTrustTier`: refuses with a 409 carrying
 * `code: 'trust-tier-required'` unless the project's tier equals `required`
 * exactly.
 *
 * `dir` is deliberately whatever the caller already resolved `.studio/
 * meta.json` from before this extraction — for most routes that is the
 * project directory itself (`.studio/` always lives there, never at a nested
 * app root), which is what `devServer.ts` passes. `deploy.ts`'s pre-
 * extraction check read it off the project's resolved APP ROOT instead;
 * that call site is preserved unchanged here (extraction must not silently
 * change deploy's existing behavior) — see that module's call site.
 */
export function requireTrustTier(dir: string, required: TrustTier, message: string): TrustTierGateResult {
  const check = checkTrustTier(dir, required)
  if (!check.ok) {
    return {
      ok: false,
      response: jsonResponse({ error: message, code: TRUST_TIER_REQUIRED_CODE }, { status: 409 }),
    }
  }
  return { ok: true, trust: check.trust }
}
