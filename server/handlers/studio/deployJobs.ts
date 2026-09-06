/**
 * deployJobs — a preview deploy as a polled job, never a blocking request.
 *
 * A deploy is two subprocesses in sequence — the project's own build, then the
 * upload — and either can take minutes. So this follows `installDeps.ts`'s
 * shape exactly: start returns a job id immediately, the client polls, and the
 * log grows in memory while the phases advance.
 *
 * ## The pipeline, and why each step is separate
 *
 *   1. **check** — `vercel whoami` / `netlify status`. Cheap, reads local
 *      state, changes nothing. It exists so the two failures that are not the
 *      user's code — the CLI is not installed, or nobody is signed in — are
 *      reported in seconds with the exact command that fixes them, instead of
 *      after a five-minute build.
 *   2. **build** — the project's own build, run by the provider's CLI so the
 *      output lands where that CLI knows to look for it (see
 *      `deployProviders.ts`). This is the step that EXECUTES THE USER'S CODE,
 *      and it is the whole reason the route is Tier-2 gated.
 *   3. **deploy** — upload the built output as a preview. Never `--prod`.
 *
 * ## What survives a restart
 *
 * The in-memory registry is per-process and the dev server runs under
 * `bun --watch`, so a file edit empties it. `.studio/meta.json`'s `lastDeploy`
 * (`deploySchema.ts`) is written at start and at completion, and doubles as
 * both the durability net and the thing the panel shows when you reopen a
 * project days later. A record found `'running'` with no live job resolves to
 * `'interrupted'` — never a phantom `'running'` a client would poll forever —
 * the same reconciliation, for the same reason, as
 * `installDeps.ts`'s `resolvePersistedJobStatus`.
 *
 * The persisted record deliberately carries no log: `meta.json` is a small,
 * hand-editable settings sidecar, not a place for a 200 kB CLI transcript.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { resolveAppRoot } from './appRoot'
import {
  mentionsUnlinkedProject,
  parseAuthProbe,
  parsePreviewUrl,
  PROVIDER_COMMANDS,
} from './deployProviders'
import {
  clientSafeDeployOutput,
  runDeployCli,
  DEPLOY_BUILD_TIMEOUT_MS,
  DEPLOY_PROBE_TIMEOUT_MS,
  DEPLOY_UPLOAD_TIMEOUT_MS,
  type DeployRunResult,
} from './deployRunner'
import {
  DeployJobStatusSchema,
  DeployPhaseSchema,
  DeployProviderSchema,
  type DeployPhase,
  type DeployProvider,
  type LastDeploy,
} from './deploySchema'
import { isGitFailure, readGitStatus } from './gitOperations'
import { hasGitRepo } from './gitRunner'
import { mergeStudioMeta, readStudioMeta } from './studioMeta'
import type { SubprocessSpawnFn } from './subprocessRunner'

// ---------------------------------------------------------------------------
// Auth / installation probe
// ---------------------------------------------------------------------------

export const ProviderProbeSchema = Type.Object({
  installed: Type.Boolean(),
  authenticated: Type.Boolean(),
  /** The account the CLI names, so the user can see WHICH account is about to publish. Never a token. */
  account: Type.Union([Type.String(), Type.Null()]),
  /** The CLI itself said this directory is not linked to a remote project — a deploy would prompt, and a prompted deploy fails. */
  unlinked: Type.Boolean(),
  /** What to run in a terminal when `authenticated` is false. Studio never collects the credential itself. */
  loginCommand: Type.String(),
  /** What to run when `unlinked` is true — it creates or attaches a remote project, which is not Studio's decision to make. */
  linkCommand: Type.String(),
})
export type ProviderProbe = Static<typeof ProviderProbeSchema>

/**
 * "Is this machine able to deploy to `provider` from this directory?" — one
 * short-lived subprocess that reads state and changes nothing.
 *
 * This is the only part of the feature that runs a subprocess without building
 * anything, and it is still behind the Tier-2 gate at the route: at Tier 0/1
 * the panel is told the tier and shows the explanation instead, rather than
 * quietly running CLIs for a project whose code the user has not consented to
 * execute.
 */
export async function probeProvider(
  dir: string,
  provider: DeployProvider,
  spawn?: SubprocessSpawnFn,
): Promise<ProviderProbe> {
  const commands = PROVIDER_COMMANDS[provider]
  const result = await runDeployCli(dir, commands.probe, { timeoutMs: DEPLOY_PROBE_TIMEOUT_MS, spawn })
  if (result.notInstalled) {
    return {
      installed: false,
      authenticated: false,
      account: null,
      unlinked: false,
      loginCommand: commands.loginCommand,
      linkCommand: commands.linkCommand,
    }
  }
  const auth = parseAuthProbe(provider, result)
  return {
    installed: true,
    authenticated: auth.authenticated,
    account: auth.account,
    unlinked: mentionsUnlinkedProject(`${result.stdout}\n${result.stderr}`),
    loginCommand: commands.loginCommand,
    linkCommand: commands.linkCommand,
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface DeployJobOverrides {
  /** Test seam — a fake CLI stands in for a real one, so everything up to the subprocess boundary is exercised without an account. */
  spawn?: SubprocessSpawnFn
  buildTimeoutMs?: number
  uploadTimeoutMs?: number
}

interface JobRecord extends LastDeploy {
  /** The app root the CLI actually ran in — also the directory whose `.studio/meta.json` holds this record. */
  dir: string
  phase: DeployPhase
  log: string
  truncated: boolean
}

/** In-memory, per-process. See the module doc for the `.studio/meta.json` net that backs it up. */
const jobs = new Map<string, JobRecord>()

export const PublicDeployJobSchema = Type.Object({
  id: Type.String(),
  provider: DeployProviderSchema,
  status: DeployJobStatusSchema,
  phase: DeployPhaseSchema,
  url: Type.Union([Type.String(), Type.Null()]),
  branch: Type.Union([Type.String(), Type.Null()]),
  dirty: Type.Boolean(),
  message: Type.String(),
  log: Type.String(),
  truncated: Type.Boolean(),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
})
export type PublicDeployJob = Static<typeof PublicDeployJobSchema>

function toPublicJob(job: JobRecord): PublicDeployJob {
  const { id, provider, status, phase, url, branch, dirty, message, log, truncated, startedAt, finishedAt } = job
  return { id, provider, status, phase, url, branch, dirty, message, log, truncated, startedAt, finishedAt }
}

function toPersisted(job: JobRecord): LastDeploy {
  const { id, provider, status, url, branch, dirty, message, startedAt, finishedAt } = job
  return { id, provider, status, url, branch, dirty, message, startedAt, finishedAt }
}

/** The last deploy this project recorded, or `null`. A plain read of `.studio/meta.json` — no subprocess, safe to call on every status poll. */
function readLastDeploy(dir: string): LastDeploy | null {
  return readStudioMeta(resolveAppRoot(dir)).lastDeploy ?? null
}

/**
 * The most recent deploy for this project, resolved the same way a by-id
 * lookup is — live from memory when this process owns it (so the log and the
 * phase are current), from `.studio/meta.json` otherwise. This is what a freshly
 * opened panel reads: it both shows "last preview: <url>" for a deploy that
 * finished days ago and lets the client re-attach its poll loop to one that is
 * still running.
 */
export function resolveLatestDeployJob(dir: string): PublicDeployJob | null {
  const last = readLastDeploy(dir)
  return last ? resolveDeployJob(last.id, dir) : null
}

/**
 * By-id lookup with the restart fallback: this process's live registry first,
 * then `.studio/meta.json`'s `lastDeploy` when it names the same job. A
 * persisted `'running'` with no live job is corrected to `'interrupted'` and
 * written back, so repeated polls do not recompute it and no client waits on a
 * job nobody is running.
 */
export function resolveDeployJob(id: string, dir: string): PublicDeployJob | null {
  const live = jobs.get(id)
  if (live) return toPublicJob(live)

  const appRoot = resolveAppRoot(dir)
  const persisted = readStudioMeta(appRoot).lastDeploy
  if (!persisted || persisted.id !== id) return null

  if (persisted.status === 'running') {
    const interrupted: LastDeploy = {
      ...persisted,
      status: 'interrupted',
      finishedAt: persisted.finishedAt ?? Date.now(),
      message:
        'The server restarted while this deploy was running, so its outcome could not be observed. Check the provider dashboard before deploying again.',
    }
    mergeStudioMeta(appRoot, { lastDeploy: interrupted })
    return fromPersisted(interrupted)
  }
  return fromPersisted(persisted)
}

/** A persisted record has no log — say so rather than showing an empty pane as if the CLI had printed nothing. */
function fromPersisted(record: LastDeploy): PublicDeployJob {
  return {
    ...record,
    phase: 'finished',
    log: '',
    truncated: false,
  }
}

/**
 * What HEAD looked like when the deploy started. A preview of uncommitted work
 * is legitimate and is not refused — but the record should be able to answer
 * "which of my edits is that URL showing?", and the panel puts the same two
 * facts next to the button.
 *
 * A project with no repository at all reports `{ branch: null, dirty: false }`
 * rather than failing: deploying a project nobody has put under version control
 * is allowed.
 */
async function readShippedState(dir: string): Promise<{ branch: string | null; dirty: boolean }> {
  if (!hasGitRepo(dir)) return { branch: null, dirty: false }
  const status = await readGitStatus(dir)
  if (isGitFailure(status)) return { branch: null, dirty: false }
  return { branch: status.branch.branch, dirty: status.entries.length > 0 }
}

/**
 * Starts a deploy and returns its id immediately. `dir` is the PROJECT
 * directory, already resolved and containment-checked by the caller; the CLI
 * runs in its APP ROOT (`approot-01`), because that is where `package.json`,
 * `vercel.json`/`netlify.toml`, and the framework config actually live.
 *
 * The trust-tier gate is the CALLER'S (see `deploy.ts`) — this function does
 * not re-check it, so a direct or test caller must not treat it as the
 * consent boundary.
 */
export async function startDeployJob(
  dir: string,
  provider: DeployProvider,
  overrides: DeployJobOverrides = {},
): Promise<string> {
  const appRoot = resolveAppRoot(dir)
  const shipped = await readShippedState(dir)
  const job: JobRecord = {
    id: crypto.randomUUID(),
    dir: appRoot,
    provider,
    status: 'running',
    phase: 'checking',
    url: null,
    branch: shipped.branch,
    dirty: shipped.dirty,
    message: `Starting a ${PROVIDER_COMMANDS[provider].label} preview deploy…`,
    log: '',
    truncated: false,
    startedAt: Date.now(),
    finishedAt: null,
  }
  jobs.set(job.id, job)
  // Initial write — if this process dies before the pipeline writes a terminal
  // record, the next status query still finds THIS record and resolves it to
  // 'interrupted' rather than to a job nobody has heard of.
  mergeStudioMeta(appRoot, { lastDeploy: toPersisted(job) })

  void runDeployPipeline(job, overrides).catch((err) => {
    console.error('[studio:deploy]', err)
    finish(job, 'failed', 'The deploy could not be completed.')
  })

  return job.id
}

/** Appends one step's transcript under a heading, so a reader can tell the build's output from the upload's. */
function appendLog(job: JobRecord, heading: string, result: DeployRunResult): void {
  const body = clientSafeDeployOutput(result, '(no output)')
  job.log = `${job.log}${job.log ? '\n\n' : ''}$ ${heading}\n${body}`
  job.truncated = job.truncated || result.stdoutTruncated || result.stderrTruncated
}

function finish(job: JobRecord, status: LastDeploy['status'], message: string, url: string | null = null): void {
  job.status = status
  job.phase = 'finished'
  job.message = message
  job.url = url
  job.finishedAt = Date.now()
  mergeStudioMeta(job.dir, { lastDeploy: toPersisted(job) })
}

async function runDeployPipeline(job: JobRecord, overrides: DeployJobOverrides): Promise<void> {
  const commands = PROVIDER_COMMANDS[job.provider]
  const spawn = overrides.spawn

  // 1 — check. Seconds, and it saves the user a five-minute build when the
  // answer is "you are not signed in".
  const probe = await probeProvider(job.dir, job.provider, spawn)
  if (!probe.installed) {
    finish(
      job,
      'failed',
      `The ${commands.label} CLI is not installed on this machine. Install it, then try again — Studio deploys through your own CLI and its own login.`,
    )
    return
  }
  if (!probe.authenticated) {
    finish(job, 'failed', `Not signed in to ${commands.label}. Run \`${commands.loginCommand}\` in a terminal, then try again.`)
    return
  }
  if (probe.unlinked) {
    finish(
      job,
      'failed',
      `This project is not linked to a ${commands.label} project. Run \`${commands.linkCommand}\` in a terminal — linking creates or attaches a remote project, which is not Studio's decision to make.`,
    )
    return
  }
  job.message = `Signed in${probe.account ? ` as ${probe.account}` : ''}. Building…`

  // 2 — build. This is the step that runs the project's own code.
  job.phase = 'building'
  const build = await runDeployCli(job.dir, commands.build, {
    timeoutMs: overrides.buildTimeoutMs ?? DEPLOY_BUILD_TIMEOUT_MS,
    spawn,
  })
  appendLog(job, commands.build.join(' '), build)
  if (!build.ok) {
    finish(job, build.timedOut ? 'timeout' : 'failed', buildFailureMessage(build, commands.label))
    return
  }

  // 3 — deploy. Preview only.
  job.phase = 'deploying'
  job.message = 'Build finished. Uploading…'
  const deploy = await runDeployCli(job.dir, commands.deploy, {
    timeoutMs: overrides.uploadTimeoutMs ?? DEPLOY_UPLOAD_TIMEOUT_MS,
    spawn,
  })
  appendLog(job, commands.deploy.join(' '), deploy)
  if (!deploy.ok) {
    const output = `${deploy.stdout}\n${deploy.stderr}`
    const message = mentionsUnlinkedProject(output)
      ? `${commands.label} refused because this project is not linked. Run \`${commands.linkCommand}\` in a terminal, then try again.`
      : deploy.timedOut
        ? `The ${commands.label} upload did not finish in time and was stopped.`
        : `${commands.label} refused the deploy — see the log.`
    finish(job, deploy.timedOut ? 'timeout' : 'failed', message)
    return
  }

  const url = parsePreviewUrl(job.provider, deploy.stdout, deploy.stderr)
  if (!url) {
    // The CLI succeeded but printed no URL we recognise. Saying so is the
    // honest answer: something IS deployed, and pretending otherwise (or
    // inventing a URL) is worse than telling the user to read the log.
    finish(
      job,
      'succeeded',
      `${commands.label} reported success but did not print a preview URL Studio could read. The log has its full output.`,
    )
    return
  }
  finish(job, 'succeeded', `Preview deployed to ${commands.label}.`, url)
}

function buildFailureMessage(build: DeployRunResult, label: string): string {
  if (build.timedOut) return 'The build did not finish in time and was stopped.'
  if (mentionsUnlinkedProject(`${build.stdout}\n${build.stderr}`)) {
    return `${label} could not build because this project is not linked to a remote project yet.`
  }
  return 'The project’s own build failed, so nothing was deployed — see the log.'
}
