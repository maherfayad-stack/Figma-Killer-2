/**
 * deploy — `/admin/api/studio/deploy/*` (W5-4). "Build this project and give me
 * a preview URL", through the provider CLI the user already has.
 *
 *   GET  /admin/api/studio/deploy/status?dir=<abs>
 *       → `{ trust, requiredTrust, canDeploy, gateMessage, detection,
 *          providers, job }`
 *       `canDeploy: false` is a NORMAL answer, not an error — it is what makes
 *       the panel explain the tier instead of showing a button that refuses.
 *       `providers` (the per-CLI install/auth/link probe) is `null` below
 *       Tier 2: probing spawns the provider CLI, and a project whose code the
 *       user has not consented to run does not get subprocesses spawned on its
 *       behalf. `detection` is always present — it is three `existsSync` calls.
 *
 *   POST /admin/api/studio/deploy   { dir?, provider, confirm: true }
 *       → `{ jobId }`, or 409 `{ error, code }` for every refusal.
 *
 *   GET  /admin/api/studio/deploy/:id?dir=<abs>
 *       → the job's status, phase, capped log, and — when it finished — the
 *       preview URL.
 *
 * ## The gate
 *
 * **Tier 2 (`run-project`), no exceptions.** Deploying builds the project,
 * and a build runs the project's own code: `vite.config.ts`, every plugin it
 * loads, every `postinstall`-shaped hook the build script reaches. That is
 * exactly the consent `meta-03` decision 1 keeps at `'static'` for a fresh
 * import, and it is a strictly higher bar than the Tier 1 that
 * `componentBundle.ts` and `styleCompile.ts` require — those build a bounded
 * set of package components; this builds and then PUBLISHES the whole app.
 * The refusal is a 409 carrying `code: 'trust-tier-required'`, in the same
 * shape those two modules already use, so the panel can render an explanation
 * rather than a dead button.
 *
 * ## What this surface deliberately cannot do
 *
 *   - **No production deploys.** Neither argv in `deployProviders.ts` carries
 *     `--prod`, and no request field reaches an argv, so there is no input
 *     that could produce one.
 *   - **No credentials.** Studio stores no provider token, accepts none on
 *     this wire, and passes none to the subprocess (`deployRunner.ts`'s env
 *     allowlist). The CLI's own login on this machine is the credential; when
 *     it is missing, the answer is the login command to run in a terminal.
 *   - **No environment variables.** A deploy that needed a secret would need
 *     Studio to hold it. It does not, so the project's own provider settings
 *     are the only source of build-time configuration.
 *   - **No arbitrary arguments.** As with `git.ts`, the route surface IS the
 *     allowed command set.
 *   - **No linking or project creation.** `vercel link` / `netlify link`
 *     create or attach a remote resource under the user's account; Studio
 *     tells the user to run them and never runs them itself.
 *
 * A dirty working tree does NOT refuse — a preview of work in progress is the
 * point. The branch and the dirty flag are recorded on the job and shown in the
 * panel, so the user can see what they are shipping.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { resolveAppRoot } from './appRoot'
import { detectDeployProviders } from './deployProviders'
import { assertDeployableProject } from './deployRunner'
import { DeployProviderSchema, type DeployProvider } from './deploySchema'
import {
  probeProvider,
  resolveDeployJob,
  resolveLatestDeployJob,
  startDeployJob,
  type ProviderProbe,
} from './deployJobs'
import { DEFAULT_TRUST_TIER, readStudioMeta, type TrustTier } from './studioMeta'
import { requireTrustTier } from './trustGate'

const ROUTE_PREFIX = '/admin/api/studio/deploy'

const NOT_FOUND = () => new Response('Not found', { status: 404 })

/** The tier a deploy requires. Named once, here, so the gate and the message the client renders can never disagree. */
const REQUIRED_TRUST_TIER: TrustTier = 'run-project'

const TRUST_REFUSAL_MESSAGE =
  'Deploying builds this project, which runs its own code. That needs the highest trust tier (run-project) — promote the project deliberately if you want Studio to build it.'

/**
 * Body of `POST /admin/api/studio/deploy`. `confirm` is `Type.Literal(true)`
 * for the same reason `git.ts`'s `init` body is: publishing a build to a URL
 * other people can open is not something a stray request performs, and an
 * explicit literal puts the consent in the wire contract instead of in a
 * handler branch.
 */
const DeployBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  provider: DeployProviderSchema,
  confirm: Type.Literal(true),
})
export type DeployBody = Static<typeof DeployBodySchema>

/** `GET/POST /admin/api/studio/deploy*` — see the module doc for the full contract. */
export async function tryServeStudioDeploy(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return null

  try {
    if (pathname === `${ROUTE_PREFIX}/status` && req.method === 'GET') return await serveStatus(url)
    if (pathname === ROUTE_PREFIX && req.method === 'POST') return await serveStart(req)
    if (pathname.startsWith(`${ROUTE_PREFIX}/`) && req.method === 'GET') return serveJob(url, pathname)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    console.error('[studio:deploy]', err)
    return jsonResponse({ error: 'The deploy request could not be completed.' }, { status: 500 })
  }

  return null
}

async function serveStatus(url: URL): Promise<Response> {
  const guard = assertDeployableProject(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()

  const appRoot = resolveAppRoot(guard.dir)
  const trust = readStudioMeta(appRoot).trust ?? DEFAULT_TRUST_TIER
  const detection = detectDeployProviders(appRoot)
  const canDeploy = trust === REQUIRED_TRUST_TIER

  // Below the gate, nothing is spawned: the panel gets the tier and the
  // file-based detection, which is all it needs to explain itself honestly.
  const providers = canDeploy ? await probeCandidates(appRoot, detection.detected) : null

  return jsonResponse({
    trust,
    requiredTrust: REQUIRED_TRUST_TIER,
    canDeploy,
    gateMessage: canDeploy ? null : TRUST_REFUSAL_MESSAGE,
    detection,
    providers,
    // The last deploy this project recorded, resolved honestly across a
    // restart — `null` when none has ever run. Carries the live log and phase
    // when this process still owns the job, so a reopened panel can re-attach
    // its poll loop to a deploy that is still running.
    job: resolveLatestDeployJob(guard.dir),
  })
}

/**
 * Probes the provider(s) the panel might offer — the detected one alone, or
 * both when nothing (or everything) is configured and the panel therefore has
 * to offer a choice. Probing only what will be shown keeps the common case at
 * one subprocess instead of two.
 */
async function probeCandidates(
  appRoot: string,
  detected: DeployProvider | null,
): Promise<Record<DeployProvider, ProviderProbe | null>> {
  const wanted: DeployProvider[] = detected ? [detected] : ['vercel', 'netlify']
  const probes = await Promise.all(wanted.map((provider) => probeProvider(appRoot, provider)))
  const result: Record<DeployProvider, ProviderProbe | null> = { vercel: null, netlify: null }
  wanted.forEach((provider, index) => {
    result[provider] = probes[index] ?? null
  })
  return result
}

async function serveStart(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, DeployBodySchema)
  if (!body) return badRequest('invalid deploy body')

  const guard = assertDeployableProject(resolveProjectDir(body.dir))
  if (!guard.ok) return NOT_FOUND()

  const appRoot = resolveAppRoot(guard.dir)
  const gate = requireTrustTier(appRoot, REQUIRED_TRUST_TIER, TRUST_REFUSAL_MESSAGE)
  if (!gate.ok) return gate.response

  const jobId = await startDeployJob(guard.dir, body.provider)
  return jsonResponse({ jobId })
}

function serveJob(url: URL, pathname: string): Response {
  const id = pathname.slice(`${ROUTE_PREFIX}/`.length)
  if (!id || id === 'status') return NOT_FOUND()

  const guard = assertDeployableProject(resolveProjectDir(url.searchParams.get('dir')))
  if (!guard.ok) return NOT_FOUND()

  const job = resolveDeployJob(id, guard.dir)
  if (!job) return NOT_FOUND()
  return jsonResponse(job)
}
