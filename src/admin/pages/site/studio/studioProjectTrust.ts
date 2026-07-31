/**
 * studioProjectTrust — WS-3.3's per-project trust-tier state and the
 * "promote this project" consent action. Split out of `fsCodemodAdapter.ts`
 * to keep that file under the architecture's 700-line module-size ceiling
 * (`module-size-budgets.test.ts`) — this is a genuinely self-contained
 * concern (read the tier, promote it, remember the last bundle refusal)
 * whose only real coupling to the rest of that file is one call:
 * `loadSite` hands `setStudioTrustTier` the tier the `/load` response
 * already carried.
 *
 * Same "tiny external store" pattern the rest of this folder uses for
 * ephemeral, per-load client state (`getStudioComponentSources`,
 * `getStudioVendorCss` in `fsCodemodAdapter.ts`) — not a Zustand slice,
 * because none of this belongs in the persisted `SiteDocument`.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * Mirrors `TrustTierSchema` in `server/handlers/studio/studioMeta.ts` (this
 * file runs in the browser, so — same reasoning as `fsCodemodAdapter.ts`'s
 * `ComponentSourceSchema` — it only needs to agree on the wire shape, not
 * import the Node-only server module). Gates whether
 * `registerProjectModules.ts` fetches a component bundle for an
 * unregistered `pkg.*` node (Tier ≥ 1) or leaves the canvas showing the
 * "promote this project" placeholder (Tier 0).
 */
export const TrustTierSchema = Type.Union([
  Type.Literal('static'),
  Type.Literal('render-packages'),
  Type.Literal('run-project'),
])
export type TrustTier = Static<typeof TrustTierSchema>

/**
 * The current project's trust tier, from the last load. `registerProjectModules.ts`
 * needs to know when a FRESH value lands (a promote action re-fetches the
 * tier and this is how it hears about it) without subscribing to `site`
 * itself, whose reference changes on every unrelated node edit.
 */
let trustTier: TrustTier = 'static'
const trustTierListeners = new Set<() => void>()

export function getStudioTrustTier(): TrustTier {
  return trustTier
}

export function subscribeStudioTrustTier(listener: () => void): () => void {
  trustTierListeners.add(listener)
  return () => trustTierListeners.delete(listener)
}

/** Called by `fsCodemodAdapter.ts`'s `loadSite` with the tier the `/load` response carried, and internally by `promoteProjectToTier1` after a successful promote. */
export function setStudioTrustTier(next: TrustTier): void {
  if (next === trustTier) return
  trustTier = next
  for (const listener of trustTierListeners) listener()
}

/**
 * The explicit consent action behind `NodeRenderer`'s "promote this project"
 * placeholder (`PackageComponentPlaceholder.tsx`) — `meta-03` decision 1's
 * promote affordance, now with somewhere to actually land
 * (`server/handlers/studio/trustTier.ts`, which did not exist before WS-3.3).
 * Persists `render-packages` (Tier 1) to `.studio/meta.json`, then re-reads
 * the tier into the external store above so `useRegisterProjectModules`'s
 * effect re-runs and fetches the bundle — no full page reload needed.
 */
export async function promoteProjectToTier1(dir: string): Promise<void> {
  await apiRequest('/admin/api/studio/trust-tier', {
    method: 'POST',
    body: { dir, trust: 'render-packages' },
    schema: Type.Object({ ok: Type.Boolean(), trust: Type.String() }),
  })
  const { trust } = await apiRequest('/admin/api/studio/trust-tier', {
    schema: Type.Object({ trust: TrustTierSchema }),
    query: { dir },
  })
  setStudioTrustTier(trust)
}

/**
 * The last `component-bundle` response for the CURRENTLY active project —
 * consulted by `PackageComponentPlaceholder.tsx` so an unregistered `pkg.*`
 * node can show WHY (a refusal message, e.g. a React version mismatch)
 * instead of a bare "unavailable". Written by `registerProjectModules.ts`'s
 * `syncProjectModules`.
 *
 * A separate external store from `trustTier` above, deliberately: the two
 * change on different triggers (a project load/promote vs. a bundle fetch
 * resolving), and `PackageComponentPlaceholder.tsx` subscribes to both
 * independently via `useSyncExternalStore`.
 */
export type PackageBundleStatus =
  | { ok: true }
  | { ok: false; code: string; message: string }

let lastBundleStatus: PackageBundleStatus | null = null
const bundleStatusListeners = new Set<() => void>()

export function getPackageBundleStatus(): PackageBundleStatus | null {
  return lastBundleStatus
}

export function subscribePackageBundleStatus(listener: () => void): () => void {
  bundleStatusListeners.add(listener)
  return () => bundleStatusListeners.delete(listener)
}

/** Written by `registerProjectModules.ts` — exported (not module-private) because the writer lives in a different file. */
export function setPackageBundleStatus(next: PackageBundleStatus | null): void {
  lastBundleStatus = next
  for (const listener of bundleStatusListeners) listener()
}
