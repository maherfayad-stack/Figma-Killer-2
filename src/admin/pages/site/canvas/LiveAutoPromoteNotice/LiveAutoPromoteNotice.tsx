/**
 * LiveAutoPromoteNotice — the visible half of §6 decision 2.
 *
 * ## What the owner decided, and what that costs
 *
 * On 2026-09-17 the owner overrode the "trust promotion is always an explicit
 * click" rule for exactly one case: **a Vite project with a lockfile is
 * promoted to Tier 2 (`run-project`) on first open**, because being asked to
 * consent to running your own app, in your own editor, on your own machine, is
 * a question with only one sensible answer and asking it once per project is
 * still once too many.
 *
 * The price of not asking is that the user must still be TOLD, and must be
 * able to take it back in one click. That is this component, and it is the
 * whole of what makes the override defensible:
 *
 *   - it says what happened, in one line, in the board chrome — not a toast,
 *     which would be gone before anyone read it;
 *   - **Undo** writes `trust` back to `static` and reloads, which also stops
 *     the project's dev server (`trustTier.ts` enforces a demotion on the
 *     process, not just on the file), and the project is never auto-promoted
 *     again (`.studio/meta.json`'s `trustAutoPromotedAt` is the latch, and the
 *     undo deliberately leaves it set);
 *   - a project that is not Vite, or has never been installed, is never
 *     touched. The pill says "Live needs Vite" instead (§6 decision 5).
 *
 * This card only exists in the session that did the promoting, so it is the
 * IMMEDIATE way back, not the only one: `LiveRuntimePill`'s "Back to static"
 * is the permanent one, on every later load (`sec-10`). Consent to run a
 * project's code has to stay revocable after the notice is gone.
 *
 * ## The promotion happens HERE, on purpose
 *
 * Not in a hook mounted somewhere invisible. The component that performs the
 * promotion is the component that announces it, so there is no arrangement of
 * the code in which the promotion runs and the notice does not — which would
 * be the override without the thing that justifies it.
 *
 * Modelled on `StyleCompileConsentBanner`: probe on mount, render nothing
 * unless there is something to say, act through the route that owns the
 * action, reload when the effect only lands on a re-parse.
 */
import { useEffect, useState } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ZapSolidIcon } from 'pixel-art-icons/icons/zap-solid'
import {
  autoPromoteProjectToTier2,
  fetchStudioTrustStatus,
  setStudioProjectTrust,
} from '@site/studio/studioProjectTrust'
import styles from './LiveAutoPromoteNotice.module.css'

type Phase = 'idle' | 'promoted' | 'undoing'

export function LiveAutoPromoteNotice() {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const [phase, setPhase] = useState<Phase>('idle')

  // One probe-and-maybe-promote per project. `cancelled` matters more than
  // usual here: the promotion is a WRITE, so a project switch mid-flight must
  // not leave this component announcing a promotion for a project nobody is
  // looking at any more.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    void (async () => {
      try {
        const status = await fetchStudioTrustStatus(projectDir)
        if (cancelled) return
        // Every clause is also re-checked server-side; these are here so the
        // common case costs one GET and no write at all.
        if (status.trust !== 'static' || !status.live.capable || status.autoPromoted) return
        await autoPromoteProjectToTier2(projectDir)
        if (cancelled) return
        setPhase('promoted')
        // Tier 2 changes what `/load` returns (`projectKey`, which every live
        // frame's URL is built from), so the board has to re-read the project.
        requestCmsSiteReload()
      } catch (err) {
        // Deliberately silent: a failed automatic promotion means the board
        // keeps rendering exactly as it did before, which is a working
        // editor. Toasting it would make Studio's own optional optimisation
        // look like the user's problem.
        console.error('[LiveAutoPromoteNotice] automatic Tier 2 promotion failed:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectDir])

  if (!projectDir || phase === 'idle') return null

  const handleUndo = async () => {
    if (phase === 'undoing') return
    setPhase('undoing')
    try {
      await setStudioProjectTrust(projectDir, 'static')
      requestCmsSiteReload()
      setPhase('idle')
    } catch (err) {
      console.error('[LiveAutoPromoteNotice] undo failed:', err)
      setPhase('promoted')
      pushToast({
        kind: 'error',
        title: 'Could not put this project back to static',
        body: getErrorMessage(err, 'Unknown error writing the trust tier'),
        dedupeKey: 'studio-trust-undo',
      })
    }
  }

  return (
    <section className={styles.notice} role="status" aria-label="Live runtime" data-testid="live-auto-promote-notice">
      <ZapSolidIcon size={13} className={styles.icon} aria-hidden="true" />
      <p className={styles.text}>Running your app live — its dev server renders these frames.</p>
      <Button
        variant="ghost"
        size="xs"
        onClick={handleUndo}
        disabled={phase === 'undoing'}
        aria-busy={phase === 'undoing'}
        data-testid="live-auto-promote-undo"
      >
        {phase === 'undoing' ? 'Undoing…' : 'Undo'}
      </Button>
    </section>
  )
}
