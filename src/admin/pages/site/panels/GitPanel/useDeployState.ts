/**
 * useDeployState — the Deploy section's single source of "can this project be
 * deployed, and what happened to the last attempt".
 *
 * Two loaders in one hook, because they are two views of one thing:
 *
 *   - the STATUS (trust tier, provider detection, per-CLI auth probe, the last
 *     recorded deploy), fetched when the panel opens and again whenever a
 *     deploy settles — a deploy that just signed in, linked, or produced a URL
 *     changes every one of those answers;
 *   - the JOB, polled while one is running. A deploy is two subprocesses in
 *     sequence and takes minutes, so this follows `useDependencyInstallJob`'s
 *     shape exactly: start returns an id, poll until a terminal status, toast
 *     the outcome.
 *
 * `loading` is derived from a settled request KEY rather than set at the top of
 * the effect, for the same reason `useGitStatus.ts` derives it: a synchronous
 * `setLoading(true)` inside an effect body is what `react-hooks/set-state-in-
 * effect` rejects, and deriving it keeps the previous status on screen during a
 * refresh instead of blanking the section.
 *
 * Nothing here runs until the panel is actually open. Above the trust gate the
 * status request spawns a provider CLI, and a mounted-but-hidden panel probing
 * `vercel whoami` on every editor load would be a real cost for nobody.
 */
import { useCallback, useEffect, useState } from 'react'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import {
  getDeployJob,
  getDeployStatus,
  startPreviewDeploy,
  type DeployJob,
  type DeployProvider,
  type DeployStatus,
} from '@site/studio/deployRequests'

/** A build plus an upload; polling faster than this only adds requests, not information. */
const DEPLOY_POLL_INTERVAL_MS = 2000

interface SettledStatus {
  key: string
  status: DeployStatus | null
  error: string | null
}

export interface DeployState {
  loading: boolean
  error: string | null
  status: DeployStatus | null
  /** The live job while one is running, else the last recorded one. `null` when this project has never deployed. */
  job: DeployJob | null
  /** A start request is in flight — distinct from a running job, which has an id. */
  starting: boolean
  start: (provider: DeployProvider) => void
  refresh: () => void
}

export function useDeployState(dir: string | undefined, active: boolean): DeployState {
  const [settled, setSettled] = useState<SettledStatus | null>(null)
  const [nonce, setNonce] = useState(0)
  const [liveJob, setLiveJob] = useState<DeployJob | null>(null)
  const [starting, setStarting] = useState(false)

  // Referenced from dep arrays below, so it needs a stable identity the static
  // exhaustive-deps rule can see (React Compiler exception #1).
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const key = `${dir ?? ''}|${nonce}`

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    getDeployStatus(dir, controller.signal)
      .then((status) => setSettled({ key, status, error: null }))
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        console.error('[DeploySection] failed to read deploy status:', err)
        setSettled({ key, status: null, error: getErrorMessage(err, 'Could not read the deploy status') })
      })
    return () => controller.abort()
  }, [dir, active, key])

  const job = liveJob ?? settled?.status?.job ?? null
  const runningJobId = job?.status === 'running' ? job.id : null

  useEffect(() => {
    if (!active || !runningJobId) return
    const timer = setInterval(() => {
      getDeployJob(runningJobId, dir)
        .then((next) => {
          setLiveJob(next)
          if (next.status === 'running') return
          // Terminal: the tier, the CLI's auth state and the persisted record
          // may all have changed, so re-read the status rather than patching
          // the copy on screen.
          refresh()
          pushToast(
            next.status === 'succeeded'
              ? { kind: 'success', title: 'Preview deployed', body: next.url ?? next.message }
              : { kind: 'error', title: 'Deploy failed', body: next.message },
          )
        })
        .catch((err: unknown) => {
          console.error('[DeploySection] failed to poll the deploy job:', err)
          setLiveJob(null)
          pushToast({
            kind: 'error',
            title: 'Lost track of the deploy',
            body: getErrorMessage(err, 'The deploy job could not be read'),
          })
        })
    }, DEPLOY_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active, runningJobId, dir, refresh])

  function start(provider: DeployProvider) {
    if (starting || runningJobId) return
    setStarting(true)
    startPreviewDeploy(dir, provider)
      .then((jobId) => getDeployJob(jobId, dir))
      .then((first) => setLiveJob(first))
      .catch((err: unknown) => {
        console.error('[DeploySection] failed to start a deploy:', err)
        pushToast({ kind: 'error', title: 'Could not start the deploy', body: getErrorMessage(err, 'Unknown deploy error') })
      })
      .finally(() => setStarting(false))
  }

  return {
    loading: active && settled?.key !== key,
    error: settled?.error ?? null,
    status: settled?.status ?? null,
    job,
    starting,
    start,
    refresh,
  }
}
