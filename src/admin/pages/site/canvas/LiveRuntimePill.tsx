/**
 * LiveRuntimePill — P8(b): which runtime is actually drawing the screen you
 * are looking at.
 *
 * ## Why it has to be said out loud
 *
 * Studio has two ways of putting a screen on the Live surface and they look
 * almost identical:
 *
 *   - **Static** — Studio renders the parsed tree through its OWN React. Fast,
 *     always available, Tier-0 safe, and by design: nothing of the user's runs.
 *     But `useEffect` never fired, no data was fetched, and the component's own
 *     conditional logic was resolved statically, not executed.
 *   - **Live** — the project's real dev server, in a cross-origin frame. The
 *     actual app.
 *
 * Someone debugging "why doesn't my fetch show anything" needs to know which of
 * those they are looking at, and until now nothing on screen said. That is the
 * whole job: the pill is a LABEL first and an action second.
 *
 * ## Three states, all honest
 *
 *   - `Live` + "Back to static" — Tier 2. See "Revocable, not just undoable".
 *   - `Static` + "Run the real app" — a Vite project with a lockfile that is
 *     currently at Tier 0/1, i.e. one the owner explicitly put back to static
 *     (auto-promotion, §6 decision 2, only ever happens once per project). The
 *     action promotes to Tier 2 and reloads.
 *   - `Live needs Vite` / `Live needs an install` — the real app cannot be run
 *     at all (§6 decision 5: non-Vite live frames are deferred). Says so
 *     instead of offering a button that would fail. The capability is decided
 *     SERVER-side (`liveCapability.ts`); this only renders the answer.
 *
 * ## Revocable, not just undoable (`sec-10`)
 *
 * Tier 2 is consent to execute the project's own code, and `CLAUDE.md`'s
 * invariant 1 requires that consent to be "explicit, per project, and
 * revocable". §6 decision 2 trades the "explicit" half for a notice plus an
 * Undo — but `LiveAutoPromoteNotice`'s Undo lives on a component that only
 * renders in the session that did the promoting, so on the next page load the
 * project was running with no way back. That made the revocation a property of
 * one session rather than of the project.
 *
 * So the `Live` state is an action too. It is the ONE permanent way back to
 * Tier 0 in the UI, and it goes through the same `setStudioProjectTrust` write
 * path, which stops the project's dev server as part of the demotion.
 *
 * Only rendered in Live view, by `CanvasModeToggle` — on the design board
 * every frame is its own answer to this question and the board's own
 * auto-promote notice is the place that speaks for the project.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { Button } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  fetchStudioTrustStatus,
  getStudioTrustTier,
  setStudioProjectTrust,
  subscribeStudioTrustTier,
  type LiveCapability,
  type TrustTier,
} from '@site/studio/studioProjectTrust'
import styles from './LiveRuntimePill.module.css'

const BLOCKED_LABEL: Record<NonNullable<LiveCapability['reason']>, string> = {
  'not-vite': 'Live needs Vite',
  'no-lockfile': 'Live needs an install',
}

const BLOCKED_EXPLANATION: Record<NonNullable<LiveCapability['reason']>, string> = {
  'not-vite':
    'Running the real app means spawning its dev server, and Studio’s live pipeline is a Vite plugin. This project is not a Vite project, so the board renders the parsed tree through Studio’s own React instead. Next/CRA support is a decided-later, not a never.',
  'no-lockfile':
    'This project has no lockfile, so there is no resolved dependency set to boot a dev server against. Install its dependencies from the Dependencies panel, then this becomes available.',
}

export function LiveRuntimePill() {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)
  const [live, setLive] = useState<LiveCapability | null>(null)
  const [busy, setBusy] = useState(false)

  // Re-ask whenever the active project changes. Same posture as
  // `StyleCompileConsentBanner`'s probe effect: no synchronous clear first
  // (that trips the "setState in effect body" rule), one request of staleness.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    fetchStudioTrustStatus(projectDir)
      .then((status) => {
        if (!cancelled) setLive(status.live)
      })
      .catch((err) => {
        console.error('[LiveRuntimePill] trust status fetch failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [projectDir])

  if (!projectDir || !live) return null

  /**
   * Both directions, one write path. Either tier change also changes what
   * `/load` returns (`projectKey`, which every live frame's URL is built from),
   * so the board has to re-read the project — the tier alone is not enough.
   * Same reason the style-compile banner reloads after promoting.
   */
  const applyTier = async (next: TrustTier, failureTitle: string) => {
    if (busy) return
    setBusy(true)
    try {
      await setStudioProjectTrust(projectDir, next)
      requestCmsSiteReload()
    } catch (err) {
      console.error(`[LiveRuntimePill] writing trust tier ${next} failed:`, err)
      pushToast({
        kind: 'error',
        title: failureTitle,
        body: getErrorMessage(err, 'Unknown error writing the trust tier'),
        dedupeKey: 'studio-trust-run-project',
      })
    } finally {
      setBusy(false)
    }
  }

  if (trust === 'run-project') {
    return (
      <span className={styles.group}>
        <Tooltip content="This is your real app, running its own dev server in this frame.">
          <span className={styles.pill} data-runtime="live" data-testid="live-runtime-pill" role="status">
            Live
          </span>
        </Tooltip>
        {/*
          The one permanent way back to Tier 0 — see "Revocable, not just
          undoable" in the module doc. The write stops the project's dev
          server as part of the demotion (`trustTier.ts`), so this genuinely
          stops the code rather than only recording that it should not run.
        */}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void applyTier('static', 'Could not put this project back to static')}
          disabled={busy}
          aria-busy={busy}
          data-testid="live-runtime-pill-demote"
        >
          {busy ? 'Stopping…' : 'Back to static'}
        </Button>
      </span>
    )
  }

  if (!live.capable) {
    const reason = live.reason ?? 'not-vite'
    return (
      <Tooltip content={BLOCKED_EXPLANATION[reason]} size="wide" openOnFocus>
        <span
          className={styles.pill}
          data-runtime="blocked"
          data-testid="live-runtime-pill"
          role="status"
          tabIndex={0}
        >
          {BLOCKED_LABEL[reason]}
        </span>
      </Tooltip>
    )
  }

  return (
    <span className={styles.group}>
      <Tooltip content="Studio is rendering the parsed source through its own React. Nothing of your project is executing: no effects, no data fetching.">
        <span className={styles.pill} data-runtime="static" data-testid="live-runtime-pill" role="status" tabIndex={0}>
          Static
        </span>
      </Tooltip>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => void applyTier('run-project', 'Could not run this project live')}
        disabled={busy}
        aria-busy={busy}
        data-testid="live-runtime-pill-promote"
      >
        {busy ? 'Starting…' : 'Run the real app'}
      </Button>
    </span>
  )
}
