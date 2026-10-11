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
 * else, and there is no reason to make that round trip on every mount. Also
 * skips while the server says the project cannot run (no Vite script, nothing
 * installed): that `start` could only be refused, and the refusal used to land
 * in the console on every open. The capability is re-read when an install
 * finishes, which is what starts the dev server then.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { getStudioTrustTier, subscribeStudioTrustTier } from './studioProjectTrust'
import { startDevServer } from './devServerRequests'
import { useLiveCapability } from './liveCapabilityStore'

export function useDevServerPrewarm(): void {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)

  const capable = useLiveCapability(trust === 'run-project' ? projectDir : null)?.capable === true

  useEffect(() => {
    if (!projectDir || trust !== 'run-project' || !capable) return
    startDevServer(projectDir)
      .then((status) => {
        // A refused boot RESOLVES (`phase: 'failed'` + the reason in `log`), it
        // does not reject — dropping it here is what let the Live pill claim
        // a running app. `useDevServerReadiness` carries the same status to
        // the pill; this keeps the reason in the console too.
        if (status.phase === 'failed') {
          console.error('[useDevServerPrewarm] the dev server did not start:', status.log)
        }
      })
      .catch((err: unknown) => {
        console.error('[useDevServerPrewarm] could not prewarm the dev server', err)
      })
  }, [projectDir, trust, capable])
}
