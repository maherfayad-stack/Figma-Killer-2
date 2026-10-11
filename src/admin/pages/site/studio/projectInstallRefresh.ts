/**
 * refreshProjectAfterInstall - an install or removal just landed, so what the
 * project declares, has on disk and can run may all have changed.
 *
 *   - the Dependencies panel's list and installed marks re-read the manifest;
 *   - the live capability is re-asked ("Live needs an install" -> runnable),
 *     which is what flips the Live pill and starts the dev server through
 *     `useDevServerPrewarm`;
 *   - any stale dev-server readiness is cleared so the poll watches the new
 *     boot instead of the old answer.
 *
 * Without this the pill said "needs an install" until the page was reloaded.
 */
import { useAdminUi } from '@admin/state/adminUi'
import { invalidateLiveCapability } from './liveCapabilityStore'
import { invalidateProjectManifest } from './projectManifestStore'
import { resetDevServerReadiness } from './useDevServerReadiness'

/** Refreshes the OPEN project - the same `dir` the panels and the pill key their reads on. */
export function refreshProjectAfterInstall(): void {
  const dir = useAdminUi.getState().studioProject?.dir
  if (!dir) return
  void invalidateProjectManifest(dir)
  void invalidateLiveCapability(dir).then(() => resetDevServerReadiness(dir))
}
