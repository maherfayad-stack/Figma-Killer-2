/**
 * DesignSystemMigrateBanner — the board's offer to move a project off the
 * retired `@alm-design/design-system` npm and onto its own Studio-written
 * `design-system/` folder.
 *
 * ## Why this is a banner and not something Studio just does
 *
 * The package is gone, so a project that still imports it does not build — and
 * the repair is a rewrite of the user's own `.tsx`. Studio's rule for editing
 * a repository is the same one it applies to trust promotion: it happens
 * because a person asked, never because a page loaded. Doing it silently on
 * open would also mean a user who pulls their repo in git sees a diff nobody
 * authored.
 *
 * Modelled on `StyleCompileConsentBanner` — probe on mount, render nothing at
 * all unless there is genuinely something to offer, act through the route that
 * already owns the action, and reload the workspace, because the change only
 * shows up on a re-parse.
 *
 * ## No "not now"
 *
 * Unlike the style-compile prompt, there is nothing to dismiss: that one asks
 * to run code, which is a choice a user is entitled to decline forever. This
 * one reports that the project is broken in a way only this button fixes, and
 * a persisted refusal would just hide the explanation. Closing the board is
 * the dismissal.
 */
import { useEffect, useState } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import {
  fetchDesignSystemMigrateStatus,
  migrateProjectDesignSystem,
  migratedFilesLabel,
  shouldOfferDesignSystemMigrate,
  type DesignSystemMigrateStatus,
} from '@site/studio/designSystemMigrateRequests'
import styles from './DesignSystemMigrateBanner.module.css'

export function DesignSystemMigrateBanner() {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const [status, setStatus] = useState<DesignSystemMigrateStatus | null>(null)
  const [migrating, setMigrating] = useState(false)

  // Re-ask whenever the active project changes. Deliberately does NOT clear
  // `status` synchronously first (that trips the "setState in effect body"
  // rule) — the same posture, and the same one-request-long staleness window,
  // as `StyleCompileConsentBanner`'s own probe effect.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    fetchDesignSystemMigrateStatus(projectDir)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((err) => {
        console.error('[DesignSystemMigrateBanner] status fetch failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [projectDir])

  if (!projectDir || !status || !shouldOfferDesignSystemMigrate(status)) return null

  const handleMigrate = async () => {
    if (migrating) return
    setMigrating(true)
    try {
      const result = await migrateProjectDesignSystem(projectDir)
      setStatus({ ...status, declaresDependency: false, hasInstalledCopy: false, importsRetiredPackage: false })
      pushToast({
        kind: 'success',
        title: 'Design system moved into the project',
        body: `${migratedFilesLabel(result)} now import it from this project’s own design-system folder.`,
      })
      // The imports the board reads are the ones just rewritten, so nothing on
      // screen is right until the project is parsed again.
      requestCmsSiteReload()
    } catch (err) {
      console.error('[DesignSystemMigrateBanner] migrate failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not move the design system into this project',
        body: getErrorMessage(err, 'Unknown error migrating this project'),
      })
    } finally {
      setMigrating(false)
    }
  }

  return (
    <section
      className={styles.banner}
      role="region"
      aria-label="Design system"
      data-testid="design-system-migrate"
    >
      <PackageSolidIcon size={14} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.title}>This project imports the retired design-system package.</p>
        <p className={styles.description}>
          Studio no longer ships it as a dependency. Moving it into the project writes the design system’s source
          to <code>design-system/</code> and rewrites every import to point there, so this repository builds — and
          downloads — with nothing but React and Vite. Your pages are edited in place; nothing else is touched.
        </p>
      </div>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="xs"
          onClick={handleMigrate}
          disabled={migrating}
          aria-busy={migrating}
          data-testid="design-system-migrate-run"
        >
          {migrating ? 'Moving…' : 'Move it into the project'}
        </Button>
      </div>
    </section>
  )
}
