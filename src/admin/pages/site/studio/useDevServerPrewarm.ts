/**
 * useDevServerPrewarm — starts a Tier-2 project's dev server the instant its
 * canvas mounts, so the expensive cold boot (module graph + Vite/webpack
 * compile) is already underway by the time something actually needs it — a
 * live-runtime frame (Track L, later) or an agent's `studio_render_reference`
 * call — instead of paying that latency on first use.
 *
 * Fire-and-forget: never blocks render on the result, never retried beyond
 * this one mount-time (and tier-change) call. A manual "restart" affordance
 * is `stopDevServer` + another `startDevServer` from wherever that surface
 * lands, not this hook's job.
 *
 * A separate hook from `useRegisterProjectModules` (`canvasModuleSet.ts`)
 * despite reading the same two pieces of state — they change for different
 * reasons and would only share code by accident: that one registers React
 * module definitions the renderer needs synchronously, this one kicks off an
 * unrelated, best-effort background subprocess.
 *
 * Skips entirely below Tier 2 — `POST start` would just 409 for anything
 * else, and there is no reason to make that round trip on every mount.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { getStudioTrustTier, subscribeStudioTrustTier } from './studioProjectTrust'
import { startDevServer } from './devServerRequests'

export function useDevServerPrewarm(): void {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)

  useEffect(() => {
    if (!projectDir || trust !== 'run-project') return
    startDevServer(projectDir).catch((err: unknown) => {
      console.error('[useDevServerPrewarm] could not prewarm the dev server', err)
    })
  }, [projectDir, trust])
}
