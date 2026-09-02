/**
 * useDependencyInstallJob — E3 (`STUDIO-FIGMA-PARITY-PLAN.md`) — the Studio
 * install/remove job orchestration `DepsSection.tsx`'s Add/Remove actions
 * ride, split out to keep that component under the architecture's 700-line
 * ceiling (`module-size-budgets.test.ts`). Riding the EXISTING WS-1.4 install
 * job (`server/handlers/studio/installDeps.ts`), never a second install path:
 * `startDependencyInstall`'s optional `add`/`remove` mutation runs a real
 * `bun add`/`bun remove` (or the project's own detected package manager)
 * against the on-disk project, then this hook polls it to completion the same
 * way `InstallDependenciesPrompt.tsx` polls the bulk install job.
 *
 * A successful install/remove requests a site reload
 * (`requestCmsSiteReload`) so the workspace re-parses with the change on
 * disk, and ALSO calls `resyncActiveProjectModules` (E4) directly — the
 * reload alone is not enough: `useRegisterProjectModules`'s effect only
 * re-fires on a project-dir or trust-tier change, and installing a
 * dependency touches NEITHER, so without this explicit call a
 * freshly-installed design-system package would sit unregistered until the
 * user happened to switch projects or promote. This is the actual
 * install → register seam, not just an assumption that a reload implies it.
 *
 * Callers should still update their own in-memory `packageJson` mirror via
 * `setDependency`/`removeDependency` unconditionally; this hook only ever
 * adds the REAL, on-disk half of that action.
 */
import { useEffect, useRef, useState } from 'react'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { resyncActiveProjectModules } from '@site/studio/registerProjectModules'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { invalidateStudioIconCatalog } from '@site/studio/iconCatalog'
import {
  getDependencyInstallJob,
  startDependencyInstall,
  type InstallJob,
} from '@site/studio/installDeps'

const INSTALL_POLL_INTERVAL_MS = 1500

/** The single in-flight Studio install/remove this hook started, if any — guards against firing a second concurrent job into the same `node_modules` (see `installDeps.ts`'s own doc on why that's unsafe). */
export interface DependencyInstallState {
  kind: 'add' | 'remove'
  name: string
}

/** Last few non-empty log lines — a hint in a toast body, not a console. */
function tailLines(log: string, count = 4): string {
  return log.split('\n').filter((line) => line.trim().length > 0).slice(-count).join('\n')
}

function installFailureToast(kind: 'add' | 'remove', name: string, job: InstallJob): { title: string; body: string } {
  const verb = kind === 'add' ? 'install' : 'remove'
  if (job.status === 'interrupted') {
    return {
      title: `Could not ${verb} ${name}`,
      body: 'The server restarted while this was running, so its outcome is unknown. Check whether it landed, then try again.',
    }
  }
  const title = job.status === 'timeout' ? `${verb === 'install' ? 'Install' : 'Remove'} timed out` : `Could not ${verb} ${name}`
  return { title, body: tailLines(job.log) || 'The operation did not complete — see the server log.' }
}

export function useDependencyInstallJob() {
  const [installState, setInstallState] = useState<DependencyInstallState | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Belt-and-braces: stop polling on unmount no matter what state we're in
  // (same posture as `InstallDependenciesPrompt.tsx`'s own cleanup effect).
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  /** Polls a Studio install/remove job to completion, toasting the result and — on success — asking the workspace to reload. */
  function pollJob(jobId: string, kind: 'add' | 'remove', name: string) {
    getDependencyInstallJob(jobId, getStudioWorkspaceDir())
      .then((job) => {
        if (job.status === 'running') return
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        setInstallState(null)
        if (job.status === 'done') {
          pushToast({
            kind: job.warnings.length > 0 ? 'warning' : 'success',
            title: kind === 'add' ? `${name} installed` : `${name} removed`,
            body: job.warnings[0] ?? `Done with ${job.packageManager}.`,
          })
          requestCmsSiteReload()
          resyncActiveProjectModules()
          // Both panel catalogues are cached per project for the whole
          // session, so an install/remove that changes which components and
          // icons exist has to drop them — otherwise the slot picker keeps
          // offering the pre-install answer until the user switches projects.
          invalidateLocalComponentCatalog()
          invalidateStudioIconCatalog()
        } else {
          pushToast({ kind: 'error', ...installFailureToast(kind, name, job) })
        }
      })
      .catch((err) => {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        setInstallState(null)
        pushToast({
          kind: 'error',
          title: `Could not ${kind === 'add' ? 'install' : 'remove'} ${name}`,
          body: getErrorMessage(err, 'Unknown install error'),
        })
      })
  }

  /** Starts a Studio install/remove job for `mutation` and begins polling it — no-op while one is already in flight. */
  function runDependencyMutation(
    kind: 'add' | 'remove',
    name: string,
    mutation: Parameters<typeof startDependencyInstall>[1],
  ) {
    if (installState) return
    setInstallState({ kind, name })
    startDependencyInstall(getStudioWorkspaceDir(), mutation)
      .then((jobId) => {
        pollJob(jobId, kind, name)
        pollRef.current = setInterval(() => pollJob(jobId, kind, name), INSTALL_POLL_INTERVAL_MS)
      })
      .catch((err) => {
        setInstallState(null)
        pushToast({
          kind: 'error',
          title: `Could not ${kind === 'add' ? 'install' : 'remove'} ${name}`,
          body: getErrorMessage(err, 'Unknown install error'),
        })
      })
  }

  return { installState, runDependencyMutation }
}
