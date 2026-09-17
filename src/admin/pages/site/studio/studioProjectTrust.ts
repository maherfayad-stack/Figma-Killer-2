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
 * L8 Phase A (`perf-06`, STATE.md) — the `/load` response's `projectKey`
 * (`null` below Tier 2): the `/p/<projectKey>` path segment
 * `server/liveOrigin.ts` (L2) routes on, which `LiveBoardFrame` joins onto
 * `useLiveOrigin`'s bare server-topology origin to build a real
 * `LiveFrameSource.liveOrigin`. A sibling external store to `trustTier`
 * above, not a field on it — same "ephemeral per-load client state" reason,
 * and the two are written by the SAME `loadSite` call but read by different
 * consumers (`registerProjectModules.ts` vs. `LiveBoardFrame.tsx`).
 */
let projectKey: string | null = null
const projectKeyListeners = new Set<() => void>()

export function getStudioProjectKey(): string | null {
  return projectKey
}

export function subscribeStudioProjectKey(listener: () => void): () => void {
  projectKeyListeners.add(listener)
  return () => projectKeyListeners.delete(listener)
}

/** Called by `fsCodemodAdapter.ts`'s `loadSite` with the key the `/load` response carried, right alongside `setStudioTrustTier`. */
export function setStudioProjectKey(next: string | null): void {
  if (next === projectKey) return
  projectKey = next
  for (const listener of projectKeyListeners) listener()
}

/**
 * Whether this project's REAL app could be run at all, decided server-side
 * (`server/handlers/studio/liveCapability.ts`) and reported so the
 * `Static · Live` pill can say which runtime is showing and, when it is the
 * static one, whether "Run the real app" is even on the table.
 *
 * Mirrors the wire shape only — the decision itself is never made here, for
 * the same reason `trustTier.ts` re-checks it before auto-promoting: a
 * capability the client asserts and the server trusts is not a gate.
 */
export const LiveCapabilitySchema = Type.Object({
  capable: Type.Boolean(),
  reason: Type.Optional(Type.Union([Type.Literal('not-vite'), Type.Literal('no-lockfile')])),
})
export type LiveCapability = Static<typeof LiveCapabilitySchema>

export const StudioTrustStatusSchema = Type.Object({
  trust: TrustTierSchema,
  live: LiveCapabilitySchema,
  /**
   * This project has already had its ONE automatic promotion (§6 decision 2).
   * A latch, not a current state: it stays true for a project whose owner
   * clicked Undo, which is precisely what stops the next open re-promoting it
   * and making that Undo a no-op with extra steps.
   */
  autoPromoted: Type.Boolean(),
})
export type StudioTrustStatus = Static<typeof StudioTrustStatusSchema>

/** `GET /admin/api/studio/trust-tier` — the tier and the live capability in one round trip. */
export async function fetchStudioTrustStatus(dir: string): Promise<StudioTrustStatus> {
  return apiRequest('/admin/api/studio/trust-tier', {
    schema: StudioTrustStatusSchema,
    query: { dir },
  })
}

/**
 * The ONE write path to `.studio/meta.json`'s `trust` field. Every promote and
 * every demote in the client goes through here — a second way to reach a tier
 * would be a second place for that boundary to be got wrong.
 *
 * Re-reads the tier afterwards (rather than assuming the POST landed what it
 * asked for) and pushes it into the external store above, so
 * `useRegisterProjectModules`'s effect and `BoardFrameView`'s tier fork both
 * see it without a full page reload.
 */
export async function setStudioProjectTrust(dir: string, trust: TrustTier): Promise<void> {
  await apiRequest('/admin/api/studio/trust-tier', {
    method: 'POST',
    body: { dir, trust },
    schema: Type.Object({ ok: Type.Boolean(), trust: TrustTierSchema }),
  })
  const status = await fetchStudioTrustStatus(dir)
  setStudioTrustTier(status.trust)
}

/**
 * The explicit consent action behind `NodeRenderer`'s "promote this project"
 * placeholder (`PackageComponentPlaceholder.tsx`) and the board's style-compile
 * banner — `meta-03` decision 1's promote affordance. Persists
 * `render-packages` (Tier 1) through the one write path above.
 */
export async function promoteProjectToTier1(dir: string): Promise<void> {
  await setStudioProjectTrust(dir, 'render-packages')
}

/**
 * §6 decision 2 — Studio's own one-time promotion of a Vite project to Tier 2
 * on first open. Separate from {@link setStudioProjectTrust} because it is a
 * genuinely different act with a different origin, recorded differently on
 * disk, and because the server REFUSES it (409) unless every condition of the
 * owner's override still holds. Nothing here decides anything: the caller
 * says "I believe this project qualifies", and the server checks.
 */
export async function autoPromoteProjectToTier2(dir: string): Promise<void> {
  await apiRequest('/admin/api/studio/trust-tier', {
    method: 'POST',
    body: { dir, trust: 'run-project', autoPromoted: true },
    schema: Type.Object({ ok: Type.Boolean(), trust: TrustTierSchema }),
  })
  const status = await fetchStudioTrustStatus(dir)
  setStudioTrustTier(status.trust)
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
