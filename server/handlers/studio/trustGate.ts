/**
 * trustGate — the shared `trust-tier-required` refusal, extracted out of
 * `deploy.ts`'s inline check so `devServer.ts` (this project's second
 * consumer) doesn't hand-roll a third copy of "read `.studio/meta.json`'s
 * trust, compare against what this route needs, 409 if it doesn't match."
 * Same wire shape every existing Tier-2 refusal already used before this
 * extraction: `{ error, code: 'trust-tier-required' }` at HTTP 409.
 *
 * **Not** the Tier-1 gate `componentBundle.ts`/`styleCompile.ts` use
 * (`trust !== 'static'`, answered 200 `{ ok: false, code }`) — deliberately
 * left alone. Different contract (200 vs 409), different tier, different
 * caller expectations (a canvas placeholder vs. a route refusal) — unifying
 * it here would blur two things that need to stay distinguishable.
 */
import { jsonResponse } from '../../http'
import { DEFAULT_TRUST_TIER, readStudioMeta, type TrustTier } from './studioMeta'

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

/**
 * Reads `.studio/meta.json`'s `trust` field (defaulting to Tier 0, same as
 * every other `readStudioMeta(...).trust` reader) off whatever directory the
 * caller passes, and refuses with a 409 unless it equals `required` exactly.
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
  const trust = readStudioMeta(dir).trust ?? DEFAULT_TRUST_TIER
  if (trust !== required) {
    return { ok: false, response: jsonResponse({ error: message, code: 'trust-tier-required' }, { status: 409 }) }
  }
  return { ok: true, trust }
}
