/**
 * StyleCompileConsentBanner — the board's first-run answer to the single most
 * common way a real repository looks broken in Studio: a Tailwind, Sass, or
 * PostCSS project imports and renders completely unstyled, because compiling
 * it means running the project's own build tooling and a fresh import sits at
 * Tier 0, where nothing runs. WS-2.1 built that pipeline
 * (`server/handlers/studio/styleCompileTier1.ts`) and gated it correctly; what
 * was missing was anything on screen saying so. Its
 * `style-toolchain-requires-trust-promotion` warning had no consumer — it
 * isn't part of the `/load` wire shape — so the board just looked wrong.
 *
 * This is the PROJECT-level front door for that. `PackageComponentPlaceholder`
 * stays exactly as it is: it answers a different question (this ONE `pkg.*`
 * node cannot render) in the frame where that node would have been, and a
 * project whose styles compile fine can still hit it.
 *
 * Modelled on `InstallDependenciesPrompt.tsx`, the existing self-gating
 * prompt: probe on mount, render nothing at all unless there is genuinely
 * something to offer, act through the route that already owns the action, and
 * reload the workspace when the thing it fixed only takes effect on a re-parse.
 *
 * **The copy names the trust boundary and does not soften it.** Promoting to
 * Tier 1 runs code from the repository — the project's own `postcss.config.*`
 * is an arbitrary JS module — so the button says what it does. "Enable styles"
 * would be a lie about what the click authorises.
 *
 * Two actions, both durable:
 *   - Promote → `promoteProjectToTier1` (the ONE promotion path — this file
 *     does not invent a second) → `requestCmsSiteReload()`, because the
 *     compile happens server-side inside the `/load` pipeline. The reload IS
 *     the compile trigger; `compileProjectStyles` re-reads the tier from
 *     `.studio/meta.json` and its cache key includes it, so the promoted load
 *     cannot serve the Tier 0 cache entry.
 *   - Dismiss → persisted per project in `.studio/meta.json` (Studio state
 *     lives on disk, never in the database), optimistically hidden first so
 *     the click feels immediate.
 */
import { useEffect, useState } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { promoteProjectToTier1 } from '@site/studio/studioProjectTrust'
import {
  dismissStyleCompileConsent,
  fetchStyleCompileConsent,
  shouldOfferStyleCompile,
  styleToolchainLabel,
  type StyleCompileConsentStatus,
} from '@site/studio/styleCompileConsent'
import styles from './StyleCompileConsentBanner.module.css'

export function StyleCompileConsentBanner() {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const [status, setStatus] = useState<StyleCompileConsentStatus | null>(null)
  const [promoting, setPromoting] = useState(false)

  // Re-ask whenever the active project changes. Deliberately does NOT clear
  // `status` synchronously first (that trips the "setState in effect body"
  // rule) — same posture, and the same one-request-long staleness window, as
  // `InstallDependenciesPrompt`'s own probe effect.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    fetchStyleCompileConsent(projectDir)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((err) => {
        console.error('[StyleCompileConsentBanner] consent status fetch failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [projectDir])

  if (!projectDir || !status || !shouldOfferStyleCompile(status)) return null

  const handlePromote = async () => {
    if (promoting) return
    setPromoting(true)
    try {
      await promoteProjectToTier1(projectDir)
      // The compile itself runs server-side during the next `/load` — see the
      // module doc. Nothing on the board changes until this lands.
      requestCmsSiteReload()
    } catch (err) {
      console.error('[StyleCompileConsentBanner] promote failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not run this project’s compiler',
        body: getErrorMessage(err, 'Unknown error promoting this project'),
      })
    } finally {
      setPromoting(false)
    }
  }

  const handleDismiss = async () => {
    setStatus({ ...status, dismissed: true })
    try {
      await dismissStyleCompileConsent(projectDir)
    } catch (err) {
      console.error('[StyleCompileConsentBanner] dismiss failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not save that choice',
        body: getErrorMessage(err, 'This project will ask again next time it loads.'),
      })
    }
  }

  const toolchains = styleToolchainLabel(status.toolchains)

  return (
    <section className={styles.banner} role="region" aria-label="Project styles" data-testid="style-compile-consent">
      <ColorsSwatchSolidIcon size={14} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.title}>This project styles itself with {toolchains}, so the board is showing it unstyled.</p>
        <p className={styles.description}>
          Producing that CSS means running the project’s own compiler on this machine — its config files are code, and
          they will execute. Studio never does that on its own. Allowing it promotes this project to Tier&nbsp;1, which
          also lets its npm package components render; you can set it back to Tier&nbsp;0 in <code>.studio/meta.json</code>.
          {!status.dependenciesInstalled &&
            ' Install this project’s dependencies first — the compiler it needs is one of them.'}
        </p>
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" size="xs" onClick={handleDismiss} data-testid="style-compile-consent-dismiss">
          Not now
        </Button>
        <Button
          variant="primary"
          size="xs"
          onClick={handlePromote}
          disabled={promoting}
          aria-busy={promoting}
          data-testid="style-compile-consent-promote"
        >
          {promoting ? 'Starting…' : 'Run the project’s compiler'}
        </Button>
      </div>
    </section>
  )
}
