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
 * ## The states, all honest
 *
 *   - `Live` + "Back to static" — Tier 2, the server says the project can run,
 *     AND its dev server reported `ready`. While it boots the pill says
 *     `Starting…`; if it gave up, `Live failed` with the log tail. The tier
 *     alone never earns the word "Live" (it is a default, not a running app).
 *   - `Static` + "Run the real app" — a Vite project with a lockfile that is
 *     currently at Tier 0/1, i.e. one the owner explicitly put back to static
 *     (auto-promotion, §6 decision 2, only ever happens once per project). The
 *     action promotes to Tier 2 and reloads.
 *   - `Live needs Vite` / `Live needs an install` — the real app cannot be run
 *     at all (§6 decision 5: non-Vite live frames are deferred; an install is
 *     missing). Says so instead of offering a button that would fail, and an
 *     install gap carries "Install dependencies", which opens the Dependencies
 *     panel. This holds at Tier 2 too. The capability is decided
 *     SERVER-side (`liveCapability.ts`); this only renders the answer.
 *
 * ## Revocable, not just an on-ramp (`sec-10`)
 *
 * Tier 2 is consent to execute the project's own code, and `CLAUDE.md`'s
 * invariant 1 requires that consent to be per project and revocable. Every
 * project starting at Tier 2 by default (2026-09-20) means the FIRST consent
 * is the product default, never a person's click — which is exactly why the
 * revocation has to be durable, not a one-session affordance: this pill's
 * "Back to static" is the ONE permanent way back to Tier 0 in the UI, present
 * on every load, and it goes through the same `setStudioProjectTrust` write
 * path, which stops the project's dev server as part of the demotion.
 *
 * Only rendered in Live view, by `CanvasModeToggle` — on the design board
 * every frame is its own answer to this question and there is no single
 * project-level runtime to label.
 */
import { useState, useSyncExternalStore } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { Button } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { retryWhileUnreachable } from '@core/http'
import { useEditorStore } from '@site/store/store'
import { useDevServerReadiness } from '@site/studio/useDevServerReadiness'
import { useLiveCapability } from '@site/studio/liveCapabilityStore'
import {
  getStudioTrustTier,
  setStudioProjectTrust,
  subscribeStudioTrustTier,
  type LiveCapability,
  type TrustTier,
} from '@site/studio/studioProjectTrust'
import styles from './LiveRuntimePill.module.css'

const BLOCKED_LABEL: Record<NonNullable<LiveCapability['reason']>, string> = {
  'not-vite': 'Live needs Vite',
  'not-installed': 'Live needs an install',
}

const BLOCKED_EXPLANATION: Record<NonNullable<LiveCapability['reason']>, string> = {
  'not-vite':
    'Running the real app means spawning its dev server, and Studio’s live pipeline is a Vite plugin. This project is not a Vite project, so the board renders the parsed tree through Studio’s own React instead. Next/CRA support is a decided-later, not a never.',
  'not-installed':
    'This project has a lockfile but its dependencies are not installed (there is no node_modules), so its dev server cannot start. The board is showing Studio’s own static render. Install the dependencies, then this becomes available.',
}

/** Reasons whose remedy is "install" — they get a one-click route to the Dependencies panel. */
function needsInstall(reason: NonNullable<LiveCapability['reason']>): boolean {
  return reason === 'not-installed'
}

export function LiveRuntimePill() {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)
  const live = useLiveCapability(projectDir)
  const [busy, setBusy] = useState(false)
  const readiness = useDevServerReadiness(projectDir)
  const setDependenciesPanelOpen = useEditorStore((s) => s.setDependenciesPanelOpen)

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
      // P3-A — setting a tier is idempotent: an unanswered write is retried
      // quietly before anything is said.
      await retryWhileUnreachable(() => setStudioProjectTrust(projectDir, next))
      requestCmsSiteReload()
    } catch (err) {
      console.error(`[LiveRuntimePill] writing trust tier ${next} failed:`, err)
      pushToast({
        kind: 'error',
        title: failureTitle,
        body: getErrorMessage(err, 'Unknown error writing the trust tier'),
        dedupeKey: 'studio-trust-run-project',
      })
    }
    setBusy(false)
  }

  // The tier is CONSENT to run the project, not proof that it is running. The
  // pill says "Live" only when the server says the app can run AND its dev
  // server has answered; everything else is named for what it is.
  const demoteButton = (
    /*
      The one permanent way back to Tier 0 — see "Revocable, not just
      undoable" in the module doc. The write stops the project's dev server as
      part of the demotion (`trustTier.ts`), so this genuinely stops the code
      rather than only recording that it should not run.
    */
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
  )

  if (trust === 'run-project' && live.capable) {
    const phase = readiness.phase
    const label = phase === 'ready' ? 'Live' : phase === 'failed' ? 'Live failed' : 'Starting…'
    const explanation =
      phase === 'ready'
        ? 'This is your real app, running its own dev server in this frame.'
        : phase === 'failed'
          ? `The dev server did not start, so the board is showing Studio’s static render. ${readiness.log.trim().slice(-300)}`
          : 'Starting the dev server. Until it answers, the board shows Studio’s static render.'
    return (
      <span className={styles.group}>
        <Tooltip content={explanation} size="wide">
          <span
            className={styles.pill}
            data-runtime={phase === 'ready' ? 'live' : phase === 'failed' ? 'failed' : 'starting'}
            data-testid="live-runtime-pill"
            role="status"
            tabIndex={0}
          >
            {label}
          </span>
        </Tooltip>
        {demoteButton}
      </span>
    )
  }

  if (!live.capable) {
    const reason = live.reason ?? 'not-vite'
    return (
      <span className={styles.group}>
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
        {needsInstall(reason) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setDependenciesPanelOpen(true)}
            data-testid="live-runtime-pill-install"
          >
            Install dependencies
          </Button>
        )}
        {trust === 'run-project' && demoteButton}
      </span>
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
