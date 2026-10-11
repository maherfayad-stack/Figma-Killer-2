/**
 * useLiveSurfaceSource — the Live view's answer to "is the real app ready to be
 * the thing on screen?".
 *
 * The Live view used to render Studio's own static React render unconditionally
 * while `LiveRuntimePill` said "Live — your real app". The two now read the same
 * facts (Tier 2, dev server `ready`, live origin + project key known), so what
 * the pill says is what the surface draws: this returns the `LiveFrameSource`
 * the bridge iframe loads once all of them hold, and `undefined` while the
 * static render is still the honest answer.
 */
import { useSyncExternalStore } from 'react'
import type { Page } from '@core/page-tree'
import { useAdminUi } from '@admin/state/adminUi'
import { useResolvedFrameAxes } from './previewAxesFrameEffect'
import type { LiveFrameSource } from './resolveLiveFrameSrc'
import { useLiveOrigin } from '@site/studio/useLiveOrigin'
import { useDevServerReadiness } from '@site/studio/useDevServerReadiness'
import {
  getStudioProjectKey,
  getStudioTrustTier,
  subscribeStudioProjectKey,
  subscribeStudioTrustTier,
} from '@site/studio/studioProjectTrust'

export function useLiveSurfaceSource(page: Page | null, enabled: boolean): LiveFrameSource | undefined {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)
  const bareLiveOrigin = useLiveOrigin()
  const projectKey = useSyncExternalStore(subscribeStudioProjectKey, getStudioProjectKey, getStudioProjectKey)
  const readiness = useDevServerReadiness(projectDir)
  const axes = useResolvedFrameAxes()

  if (!enabled || !page || trust !== 'run-project' || readiness.phase !== 'ready') return undefined
  if (!bareLiveOrigin || !projectKey) return undefined
  return {
    liveOrigin: `${bareLiveOrigin}/p/${projectKey}`,
    screenKey: page.id,
    // `liveNodeResolve.ts`: a NodeTree's key order IS document order.
    nodeIdsInTreeOrder: Object.keys(page.nodes),
    axes,
  }
}
