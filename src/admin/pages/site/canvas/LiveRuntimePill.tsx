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
 *   - `Live` — Tier 2. Nothing to click.
 *   - `Static` + "Run the real app" — a Vite project with a lockfile that is
 *     currently at Tier 0/1, i.e. one the owner explicitly put back to static
 *     (auto-promotion, §6 decision 2, only ever happens once per project). The
 *     action promotes to Tier 2 and reloads.
 *   - `Live needs Vite` / `Live needs an install` — the real app cannot be run
 *     at all (§6 decision 5: non-Vite live frames are deferred). Says so
 *     instead of offering a button that would fail. The capability is decided
 *     SERVER-side (`liveCapability.ts`); this only renders the answer.
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
  const [promoting, setPromoting] = useState(false)

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

  if (trust === 'run-project') {
    return (
      <Tooltip content="This is your real app, running its own dev server in this frame.">
        <span className={styles.pill} data-runtime="live" data-testid="live-runtime-pill" role="status">
          Live
        </span>
      </Tooltip>
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

  const handleRunLive = async () => {
    if (promoting) return
    setPromoting(true)
    try {
      await setStudioProjectTrust(projectDir, 'run-project')
      // Tier 2 also changes what `/load` returns (`projectKey`, which every
      // live frame's URL is built from), so the board has to re-read the
      // project — the tier alone is not enough. Same reason the style-compile
      // banner reloads after promoting.
      requestCmsSiteReload()
    } catch (err) {
      console.error('[LiveRuntimePill] promote to run-project failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not run this project live',
        body: getErrorMessage(err, 'Unknown error promoting this project'),
        dedupeKey: 'studio-trust-run-project',
      })
    } finally {
      setPromoting(false)
    }
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
        onClick={handleRunLive}
        disabled={promoting}
        aria-busy={promoting}
        data-testid="live-runtime-pill-promote"
      >
        {promoting ? 'Starting…' : 'Run the real app'}
      </Button>
    </span>
  )
}
