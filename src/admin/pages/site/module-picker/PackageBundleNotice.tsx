/**
 * PackageBundleNotice — E4 (`STUDIO-FIGMA-PARITY-PLAN.md`) — the "way
 * forward" half of the BLOCKER fix. `registerProjectModules.ts` now fetches
 * a project's component bundle regardless of board contents, so an empty
 * Modules/palette list can mean either "this project genuinely has no
 * component-package dependency" or "it has one, but the trust tier/React
 * version/build blocks it." Never silent: this reads the SAME external
 * stores `PackageComponentPlaceholder.tsx` (the per-node canvas fallback)
 * already reads and renders the identical refusal — with a one-click
 * "Promote project" action for the one actionable code
 * (`trust-tier-required`) — at the PICKER level instead.
 *
 * Shared by both picker surfaces (`ModulePicker.tsx`'s compact context-menu
 * flow and `ModuleInserterDialog.tsx`'s toolbar "+ Add to canvas" dialog) so
 * the message and the promote action are defined once, not drifted twice.
 * Returns `null` outside Studio mode, or when there is nothing to report.
 */
import { useState, useSyncExternalStore } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import {
  getPackageBundleStatus,
  promoteProjectToTier1,
  subscribePackageBundleStatus,
} from '@site/studio/studioProjectTrust'
import styles from './PackageBundleNotice.module.css'

interface PackageBundleNoticeProps {
  /** Only shown inside Studio mode — pass `insertionContext.isStudio`. */
  isStudio: boolean
  /**
   * Clicks inside a `ContextMenuSubmenu` must not bubble to the panel-level
   * dismiss handler (`ModulePicker.tsx`'s own `searchHeader` does the same).
   * `ModuleInserterDialog.tsx`'s modal backdrop click-to-close already only
   * fires on the backdrop itself, so it doesn't need this.
   */
  stopPropagationOnInteraction?: boolean
  size?: 'compact' | 'roomy'
}

export function PackageBundleNotice({
  isStudio,
  stopPropagationOnInteraction = false,
  size = 'compact',
}: PackageBundleNoticeProps) {
  const bundleStatus = useSyncExternalStore(
    subscribePackageBundleStatus,
    getPackageBundleStatus,
    getPackageBundleStatus,
  )
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const [promoting, setPromoting] = useState(false)

  if (!isStudio || !bundleStatus || bundleStatus.ok) return null

  const handlePromote = async () => {
    if (!projectDir || promoting) return
    setPromoting(true)
    try {
      await promoteProjectToTier1(projectDir)
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Could not promote project',
        body: getErrorMessage(err, 'Unknown error promoting this project'),
      })
    } finally {
      setPromoting(false)
    }
  }

  const stopProps = stopPropagationOnInteraction
    ? { onClick: (e: React.MouseEvent) => e.stopPropagation(), onMouseDown: (e: React.MouseEvent) => e.stopPropagation() }
    : {}

  return (
    <div className={styles.notice} data-size={size} role="status" {...stopProps}>
      <WarningDiamondSolidIcon size={size === 'compact' ? 12 : 13} aria-hidden="true" />
      <span className={styles.noticeText}>{bundleStatus.message}</span>
      {bundleStatus.code === 'trust-tier-required' && (
        <Button
          variant="secondary"
          size="xs"
          onClick={handlePromote}
          disabled={promoting || !projectDir}
        >
          {promoting ? 'Promoting…' : 'Promote project'}
        </Button>
      )}
    </div>
  )
}
