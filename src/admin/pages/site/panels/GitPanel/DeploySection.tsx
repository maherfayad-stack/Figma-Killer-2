/**
 * DeploySection — "give me a preview URL", inside the Version control panel.
 *
 * It lives here rather than on its own rail entry because deploying is the last
 * step of the same sentence the rest of this panel writes: *branch → what
 * changed → commit → push → **see it live***. The branch and dirty state the
 * section reports come straight from the panel's existing git status, so the
 * user can see what they are about to publish without leaving the flow.
 *
 * ## What this surface says honestly, rather than hiding
 *
 * - **The trust gate.** Deploying builds the project, which runs the project's
 *   own code, so it needs Tier 2 (`run-project`). Below that the section does
 *   NOT render a button that refuses on click — it explains the tier and where
 *   it is set. Promoting to Tier 2 is deliberately not a button here: it is the
 *   consent that lets Studio execute this repository, and it should not be one
 *   click away from "Deploy".
 * - **Whose credential this is.** Studio holds no Vercel or Netlify token. The
 *   provider CLI's own login on this machine is the credential, so when it is
 *   missing the section shows the command to run in a terminal — it never asks
 *   for one.
 * - **Previews only.** There is no production deploy in v1 and no control here
 *   that could request one; the server has no route for it.
 *
 * When neither `vercel.json` nor `netlify.toml` exists, both providers are
 * offered with a note saying nothing was detected — rather than Studio picking
 * one, which would publish under a URL the user did not choose.
 */
import { Alert } from '@ui/components/Alert'
import { Button } from '@ui/components/Button'
import { Code } from '@ui/components/Code'
import { EmptyState } from '@ui/components/EmptyState'
import { Section } from '@ui/components/Section'
import { pushToast } from '@ui/components/Toast'
import type { DeployJob, DeployProvider, DeployStatus, ProviderProbe } from '@site/studio/deployRequests'
import { useDeployState } from './useDeployState'
import styles from './DeploySection.module.css'

const PROVIDER_LABEL: Record<DeployProvider, string> = { vercel: 'Vercel', netlify: 'Netlify' }

const PHASE_LABEL: Record<DeployJob['phase'], string> = {
  checking: 'Checking the CLI…',
  building: 'Building the project…',
  deploying: 'Uploading the preview…',
  finished: 'Finished',
}

interface DeploySectionProps {
  dir: string | undefined
  /** From the panel's git status — what this deploy would ship. */
  branch: string | null
  /** How many files have uncommitted changes. A preview of work in progress is allowed; the user should just be able to see that that is what it is. */
  dirtyCount: number
  /** The panel is open. Nothing is fetched — and above the gate, no CLI is spawned — while it is not. */
  active: boolean
}

export function DeploySection({ dir, branch, dirtyCount, active }: DeploySectionProps) {
  const { loading, error, status, job, starting, start } = useDeployState(dir, active)

  return (
    <Section title="Deploy" meta={job?.status === 'running' ? 'running' : undefined}>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {!status && loading ? <p className={styles.hint}>Reading the deploy status…</p> : null}

      {status && !status.canDeploy ? (
        <Alert tone="warning" title="Deploying needs the run-project trust tier">
          {status.gateMessage}
          <span className={styles.gateHint}>
            This project is at <strong>{status.trust}</strong>. Set <code>&quot;trust&quot;</code> to{' '}
            <code>&quot;run-project&quot;</code> in its <code>.studio/meta.json</code> to allow it.
          </span>
        </Alert>
      ) : null}

      {status?.canDeploy ? (
        <>
          {status.detection.detected === null ? (
            <p className={styles.hint}>
              No <code>vercel.json</code> or <code>netlify.toml</code> here, so Studio has nothing to go on — pick the
              provider you want. Its CLI decides how this project builds.
            </p>
          ) : null}

          <div className={styles.providers}>
            {candidateProviders(status).map((provider) => (
              <ProviderRow
                key={provider}
                provider={provider}
                probe={status.providers?.[provider] ?? null}
                busy={starting || job?.status === 'running'}
                onDeploy={() => start(provider)}
              />
            ))}
          </div>

          <p className={styles.shipping}>
            {branch ? (
              <>
                Deploys <strong>{branch}</strong> as it is on disk
              </>
            ) : (
              'Deploys this project as it is on disk'
            )}
            {dirtyCount > 0
              ? ` — including ${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}.`
              : ' — everything is committed.'}
          </p>
        </>
      ) : null}

      {job ? <JobView job={job} /> : null}
      {!job && status?.canDeploy ? (
        <EmptyState compact plain title="Nothing deployed yet." description="A preview URL will appear here." />
      ) : null}
    </Section>
  )
}

/** The detected provider alone, or both when nothing (or everything) is configured — Studio never guesses between two. */
function candidateProviders(status: DeployStatus): DeployProvider[] {
  return status.detection.detected ? [status.detection.detected] : ['vercel', 'netlify']
}

interface ProviderRowProps {
  provider: DeployProvider
  probe: ProviderProbe | null
  busy: boolean
  onDeploy: () => void
}

/**
 * One provider: what its CLI says about this machine, and the button — or the
 * one command that has to be run in a terminal first. Studio never runs
 * `login` or `link` itself: one is a credential exchange, the other creates a
 * remote project under the user's account.
 */
function ProviderRow({ provider, probe, busy, onDeploy }: ProviderRowProps) {
  const label = PROVIDER_LABEL[provider]
  const blocker = probeBlocker(probe)

  return (
    <div className={styles.providerRow}>
      <div className={styles.providerHead}>
        <strong className={styles.providerName}>{label}</strong>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || blocker !== null}
          tooltip={blocker?.tooltip ?? `Build and deploy a preview to ${label}`}
          onClick={onDeploy}
        >
          Deploy preview
        </Button>
      </div>
      {probe?.authenticated && !blocker ? (
        <p className={styles.hint}>Signed in{probe.account ? ` as ${probe.account}` : ''}.</p>
      ) : null}
      {blocker ? (
        <div className={styles.blocker}>
          <p className={styles.hint}>{blocker.message}</p>
          {blocker.command ? <CommandToRun command={blocker.command} /> : null}
        </div>
      ) : null}
    </div>
  )
}

interface ProbeBlocker {
  message: string
  /** The command the user runs in their own terminal. Studio shows it and never runs it. */
  command: string | null
  tooltip: string
}

function probeBlocker(probe: ProviderProbe | null): ProbeBlocker | null {
  if (!probe) return { message: 'Studio could not check this CLI.', command: null, tooltip: 'The CLI could not be checked.' }
  if (!probe.installed) {
    return {
      message: 'This CLI is not installed on this machine. Studio deploys through your own CLI and its own login.',
      command: null,
      tooltip: 'The CLI is not installed.',
    }
  }
  if (!probe.authenticated) {
    return {
      message: 'Not signed in. Studio holds no provider token — run this in a terminal, then reopen this panel.',
      command: probe.loginCommand,
      tooltip: 'Not signed in to this provider.',
    }
  }
  if (probe.unlinked) {
    return {
      message: 'This folder is not linked to a project yet. Linking creates or attaches a remote project, so Studio leaves it to you.',
      command: probe.linkCommand,
      tooltip: 'This folder is not linked to a project.',
    }
  }
  return null
}

/** A command with a copy button. Purely a convenience — the text is the point. */
function CommandToRun({ command }: { command: string }) {
  return (
    <div className={styles.command}>
      <Code>{command}</Code>
      <Button variant="ghost" size="xs" onClick={() => void copyText(command, 'Command copied')}>
        Copy
      </Button>
    </div>
  )
}

function JobView({ job }: { job: DeployJob }) {
  const running = job.status === 'running'
  return (
    <div className={styles.job}>
      <p className={styles.jobStatus} role="status">
        <span className={statusClass(job.status)}>{running ? PHASE_LABEL[job.phase] : STATUS_LABEL[job.status]}</span>
        {job.branch ? <span className={styles.jobBranch}>{job.branch}{job.dirty ? ' (uncommitted)' : ''}</span> : null}
      </p>
      <p className={styles.hint}>{job.message}</p>

      {job.url ? (
        <div className={styles.urlRow}>
          {/* External https link — the admin router's ban is on internal /admin hrefs. */}
          <a className={styles.url} href={job.url} target="_blank" rel="noreferrer noopener">
            {job.url}
          </a>
          <Button variant="ghost" size="xs" onClick={() => void copyText(job.url ?? '', 'Preview URL copied')}>
            Copy
          </Button>
        </div>
      ) : null}

      {job.log ? (
        <>
          <Code className={styles.log}>{job.log}</Code>
          {job.truncated ? <p className={styles.hint}>This log was too long to keep in full.</p> : null}
        </>
      ) : null}
    </div>
  )
}

const STATUS_LABEL: Record<DeployJob['status'], string> = {
  running: 'Running',
  succeeded: 'Deployed',
  failed: 'Failed',
  timeout: 'Timed out',
  interrupted: 'Interrupted',
}

function statusClass(status: DeployJob['status']): string {
  if (status === 'succeeded') return styles.statusOk
  if (status === 'running') return styles.statusRunning
  return styles.statusBad
}

async function copyText(value: string, title: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    pushToast({ kind: 'error', title: 'Could not copy', body: 'This browser did not offer clipboard access.' })
    return
  }
  try {
    await navigator.clipboard.writeText(value)
    pushToast({ kind: 'success', title })
  } catch (err) {
    console.error('[DeploySection] copy failed:', err)
    pushToast({ kind: 'error', title: 'Could not copy', body: 'The clipboard refused the write.' })
  }
}
