/**
 * InstallDependenciesPrompt — WS-1.4 client half. An imported repo has no
 * `node_modules`, so package CSS, Tailwind, package components, and the
 * already-shipped `?raw` package-icon resolution all silently resolve to
 * nothing until dependencies are installed. This offers that as a background
 * job (never a blocking request — a real install runs 30s-3min) and reloads
 * the workspace once it lands so package-backed features light up.
 *
 * Studio-only: the install targets a real on-disk project directory, which
 * only exists in Studio (filesystem-as-truth) mode — see `isStudioMode`.
 * Renders nothing outside Studio mode, and nothing once `node_modules`
 * already exists or the project has no dependencies to install.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { isStudioMode } from '@site/studio/studioMode'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import {
  getDependencyInstallJob,
  probeDependencyInstall,
  startDependencyInstall,
  type InstallJob,
  type InstallProbeStatus,
} from '@site/studio/installDeps'
import styles from './InstallDependenciesPrompt.module.css'

const POLL_INTERVAL_MS = 1500
/** How many trailing log lines the status chip shows — a hint, not a console. */
const LOG_TAIL_LINES = 2

function tailLines(log: string, count: number): string {
  return log.split('\n').filter((line) => line.trim().length > 0).slice(-count).join('\n')
}

export function InstallDependenciesPrompt() {
  const dir = getStudioWorkspaceDir()
  const [probe, setProbe] = useState<InstallProbeStatus | null>(null)
  const [job, setJob] = useState<InstallJob | null>(null)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // `pollJob` is called from a `setInterval` closure captured inside the two
  // effects below (deliberately excluded from the mount effect's own dep
  // array further down, else it would re-run on every render) — wrapped in
  // `useCallback` so BOTH effects that reference it stay correct across
  // renders without re-subscribing on every one (React Compiler exception
  // #1: a function referenced from a dep array needs a stable identity).
  const pollJob = useCallback((jobId: string) => {
    getDependencyInstallJob(jobId, dir)
      .then((result) => {
        setJob(result)
        if (result.status === 'running') return

        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }

        if (result.status === 'done') {
          pushToast({
            kind: result.warnings.length > 0 ? 'warning' : 'success',
            title: 'Dependencies installed',
            body: result.warnings[0] ?? `Installed with ${result.packageManager}.`,
          })
          // Package-backed features (package CSS, Tailwind, package
          // components, ?raw icon resolution) only light up after the
          // workspace re-parses with a real node_modules on disk.
          requestCmsSiteReload()
          probeDependencyInstall(dir)
            .then(setProbe)
            .catch((err) => console.error('[InstallDependenciesPrompt] re-probe failed:', err))
        } else {
          const title =
            result.status === 'timeout'
              ? 'Dependency install timed out'
              : result.status === 'interrupted'
                ? 'Dependency install was interrupted'
                : 'Dependency install failed'
          const body =
            result.status === 'interrupted'
              ? 'The server restarted while this install was running, so its outcome is unknown. Check whether dependencies landed, then try again.'
              : tailLines(result.log, 4) || 'The install did not complete — see the server log.'
          pushToast({ kind: 'error', title, body })
        }
      })
      .catch((err) => {
        console.error('[InstallDependenciesPrompt] poll failed:', err)
      })
  }, [dir])

  // Re-probe whenever the active project changes, and drop any poll left
  // running for the PREVIOUS project. Deliberately does NOT clear `probe`/
  // `job` synchronously first (that trips the "setState in effect body"
  // rule) — the previous project's status just holds until the new probe
  // resolves, which is a one-request-long flash in the rare case a project
  // switch happens while this panel is already open.
  //
  // `infra-01`: the probe's `job` field can report a job STILL `'running'` —
  // e.g. this component remounted (panel closed/reopened, page reload) while
  // an install kicked off earlier is genuinely still going, whether or not
  // the server itself restarted in between. Resume polling it instead of
  // silently re-offering "Install dependencies" over a job already in
  // flight (which would start a SECOND, concurrent install into the same
  // `node_modules`).
  useEffect(() => {
    let cancelled = false
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    probeDependencyInstall(dir)
      .then((result) => {
        if (cancelled) return
        setProbe(result)
        if (result.job?.status === 'running') {
          setJob(result.job)
          pollRef.current = setInterval(() => pollJob(result.job!.id), POLL_INTERVAL_MS)
        } else {
          setJob(null)
        }
      })
      .catch((err) => {
        console.error('[InstallDependenciesPrompt] probe failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [dir, pollJob])

  // Belt-and-braces: stop polling on unmount no matter what state we're in.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const handleInstall = () => {
    if (starting || job?.status === 'running') return
    setStarting(true)
    startDependencyInstall(dir)
      .then((jobId) => {
        pollJob(jobId)
        pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS)
      })
      .catch((err) => {
        pushToast({
          kind: 'error',
          title: 'Could not start dependency install',
          body: getErrorMessage(err, 'Unknown install error'),
        })
      })
      .finally(() => setStarting(false))
  }

  if (!isStudioMode()) return null
  if (!probe) return null

  const jobRunning = job?.status === 'running'

  if (jobRunning) {
    return (
      <div className={styles.statusChip} role="status" data-testid="install-deps-status">
        <div className={styles.statusHeader}>
          <PackageSolidIcon size={11} aria-hidden="true" />
          <span>Installing dependencies ({job.packageManager})…</span>
        </div>
        {job.log && <pre className={styles.logTail}>{tailLines(job.log, LOG_TAIL_LINES)}</pre>}
      </div>
    )
  }

  // Nothing left to install (or nothing declared) — render nothing.
  if (!probe.hasPackageJson || probe.hasNodeModules || probe.dependencyCount === 0) return null

  return (
    <EmptyState
      compact
      icon={<PackageSolidIcon size={14} aria-hidden="true" />}
      title="Dependencies not installed"
      description={`${probe.dependencyCount} package${probe.dependencyCount === 1 ? '' : 's'} in package.json. Package CSS, Tailwind, and package components won't render until they're installed.`}
      action={
        <Button
          variant="primary"
          size="xs"
          onClick={handleInstall}
          disabled={starting}
          aria-busy={starting}
          data-testid="install-deps-button"
        >
          {starting ? 'Starting…' : 'Install dependencies'}
        </Button>
      }
      data-testid="install-deps-empty-state"
      className={styles.emptyState}
    />
  )
}
