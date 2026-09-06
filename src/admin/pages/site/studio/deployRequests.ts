/**
 * deployRequests — the wire contract for `/admin/api/studio/deploy/*`
 * (`server/handlers/studio/deploy.ts`).
 *
 * Same posture as `gitRequests.ts`: every call goes through `apiRequest` with a
 * TypeBox schema, so a response that drifts from the server fails at the
 * boundary instead of producing `undefined` three components deep. The exported
 * types are `Static<typeof …>`, never hand-written mirrors.
 *
 * Two things about the shape are worth knowing:
 *
 *   - **`canDeploy: false` is data, not an error.** A project below the
 *     `run-project` trust tier answers 200 with the tier, the tier it needs,
 *     and a written explanation. That is what lets the panel explain itself
 *     instead of rendering a button that refuses on click.
 *   - **`providers` is `null` below the gate.** Probing a CLI spawns it, and a
 *     project whose code the user has not consented to run does not get
 *     subprocesses spawned for it. `detection` (three file checks) is always
 *     present.
 *
 * There is no `--prod` parameter here and nowhere to add one: the server has no
 * route for a production deploy, and no field on this wire reaches an argv.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'

const DeployProviderSchema = Type.Union([Type.Literal('vercel'), Type.Literal('netlify')])

const TrustTierSchema = Type.Union([
  Type.Literal('static'),
  Type.Literal('render-packages'),
  Type.Literal('run-project'),
])

const ProviderPresenceSchema = Type.Object({
  /** `vercel.json` / `netlify.toml` — the project declares this provider. */
  config: Type.Boolean(),
  /** `.vercel/project.json` / `.netlify/state.json` — the directory is linked to a remote project. */
  linked: Type.Boolean(),
})

const DeployDetectionSchema = Type.Object({
  /** `null` when nothing is configured, or when BOTH are — the panel offers a choice rather than guessing. */
  detected: Type.Union([DeployProviderSchema, Type.Null()]),
  vercel: ProviderPresenceSchema,
  netlify: ProviderPresenceSchema,
})

const ProviderProbeSchema = Type.Object({
  installed: Type.Boolean(),
  authenticated: Type.Boolean(),
  /** The account the CLI names, so the user can see which one is about to publish. Never a token. */
  account: Type.Union([Type.String(), Type.Null()]),
  unlinked: Type.Boolean(),
  /** The command to run in a terminal to sign in. Studio never collects the credential itself. */
  loginCommand: Type.String(),
  linkCommand: Type.String(),
})

const DeployJobSchema = Type.Object({
  id: Type.String(),
  provider: DeployProviderSchema,
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('timeout'),
    /** The server restarted mid-deploy — a terminal status, never a phantom "running". */
    Type.Literal('interrupted'),
  ]),
  phase: Type.Union([
    Type.Literal('checking'),
    Type.Literal('building'),
    Type.Literal('deploying'),
    Type.Literal('finished'),
  ]),
  url: Type.Union([Type.String(), Type.Null()]),
  branch: Type.Union([Type.String(), Type.Null()]),
  dirty: Type.Boolean(),
  message: Type.String(),
  /** Both subprocesses' transcripts, capped server-side. Empty for a job restored from `.studio/meta.json`, which stores no log. */
  log: Type.String(),
  truncated: Type.Boolean(),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
})

const DeployStatusResponseSchema = Type.Object({
  trust: TrustTierSchema,
  requiredTrust: TrustTierSchema,
  canDeploy: Type.Boolean(),
  /** The written explanation to show in place of the button when `canDeploy` is false. */
  gateMessage: Type.Union([Type.String(), Type.Null()]),
  detection: DeployDetectionSchema,
  /** `null` below the trust gate — see the module doc. */
  providers: Type.Union([
    Type.Object({
      vercel: Type.Union([ProviderProbeSchema, Type.Null()]),
      netlify: Type.Union([ProviderProbeSchema, Type.Null()]),
    }),
    Type.Null(),
  ]),
  /** The last deploy this project recorded, live when this server still owns it. `null` when none has ever run. */
  job: Type.Union([DeployJobSchema, Type.Null()]),
})

const DeployStartResponseSchema = Type.Object({ jobId: Type.String() })

export type DeployProvider = Static<typeof DeployProviderSchema>
export type DeployDetection = Static<typeof DeployDetectionSchema>
export type ProviderProbe = Static<typeof ProviderProbeSchema>
export type DeployJob = Static<typeof DeployJobSchema>
export type DeployStatus = Static<typeof DeployStatusResponseSchema>

const BASE = '/admin/api/studio/deploy'

/** Trust tier, provider detection, per-CLI auth probe, and the last deploy. Cheap below the gate; one subprocess per candidate provider above it. */
export async function getDeployStatus(dir: string | undefined, signal?: AbortSignal): Promise<DeployStatus> {
  return apiRequest(`${BASE}/status`, { schema: DeployStatusResponseSchema, query: { dir }, signal })
}

/**
 * Starts a preview deploy and returns its job id. `confirm: true` is a required
 * literal on the wire — the consent is part of the contract, not a handler
 * branch — matching `initGitRepository`'s precedent.
 *
 * Refuses with 409 `code: 'trust-tier-required'` below Tier 2.
 */
export async function startPreviewDeploy(dir: string | undefined, provider: DeployProvider): Promise<string> {
  const { jobId } = await apiRequest(BASE, {
    method: 'POST',
    body: { dir, provider, confirm: true },
    schema: DeployStartResponseSchema,
  })
  return jobId
}

/** One poll of a deploy job. `dir` is how the server finds the persisted record when it restarted since the job started. */
export async function getDeployJob(jobId: string, dir: string | undefined): Promise<DeployJob> {
  return apiRequest(`${BASE}/${encodeURIComponent(jobId)}`, { schema: DeployJobSchema, query: { dir } })
}
