/**
 * githubDeviceFlow — GitHub's OAuth **device authorization grant**, which is
 * the only browser sign-in shape that works for a tool like this.
 *
 * The ordinary web flow needs a registered redirect URI and a client SECRET.
 * Studio runs on whatever host and port the operator chose — `localhost:3001`,
 * a tunnel, a LAN address — so there is no redirect URI that can be registered
 * once and be right everywhere, and shipping a client secret in a self-hosted
 * binary makes it not a secret. The device flow needs neither: the user is
 * shown a short code, types it at github.com/login/device, and this server
 * polls until GitHub hands over a token.
 *
 * Two GitHub endpoints, both on `github.com` (NOT `api.github.com`):
 *
 *   POST /login/device/code          → device_code, user_code, verification_uri
 *   POST /login/oauth/access_token   → access_token, or an `error` string
 *
 * ## What the browser is told, and what it is not
 *
 * The browser gets an opaque `flowId`, the `user_code` to type, and the URL
 * to type it at. It never gets the `device_code`: that value is the bearer of
 * the pending authorization, and it stays in this process, in a map keyed by
 * `flowId` AND stamped with the user id that started the flow. A poll from a
 * different account cannot advance someone else's sign-in, and a poll for an
 * unknown flow is a 404.
 *
 * ## Scopes
 *
 * `repo` only. Not `workflow`: a token carrying it may rewrite `.github/
 * workflows/*`, which is arbitrary code execution on the user's CI, and
 * nothing Studio does needs it. Not `delete_repo`, not `admin:*`. The panel
 * displays the scopes GitHub actually granted, read back off the token, so a
 * token with more than this is visible rather than assumed away.
 *
 * ## The interval GitHub asks for is obeyed
 *
 * The poll route rate-limits itself to the `interval` GitHub returned (and to
 * the longer one it demands after a `slow_down`). Polling faster gets the
 * whole flow rejected, and a client that polls in a tight loop would do
 * exactly that — so the pacing lives here, on the server, not in the panel.
 *
 * ## The registry is bounded
 *
 * `device/start` is the only route in this feature that allocates without a
 * database write, so the map is the thing that grows. Two bounds, both
 * enforced here: an entry expires (clamped to {@link FLOW_TTL_MS} whatever
 * GitHub's `expires_in` claims) and is pruned on the next start, and
 * one account may hold at most {@link MAX_PENDING_FLOWS_PER_USER} pending
 * flows — its own oldest is dropped to make room, never anyone else's.
 */
import { randomUUID } from 'node:crypto'
import { Type } from '@core/utils/typeboxHelpers'
import { parseJsonResponse } from '@core/utils/jsonValidate'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
/** See the module doc — `repo` and nothing else. */
export const GITHUB_OAUTH_SCOPE = 'repo'
/** GitHub's own default when it sends no `interval`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5
/**
 * The longest a pending flow may sit in memory, whatever `expires_in` says.
 * GitHub's own device codes last 15 minutes; this is the ceiling applied to
 * the number in the response, so a wrong (or hostile) `expires_in` cannot
 * pin an entry in the map forever.
 */
const FLOW_TTL_MS = 20 * 60 * 1000
/**
 * How many pending sign-ins one account may hold at once. `device/start` does
 * real work — a GitHub round trip and a map entry — and nothing else bounds
 * how often an authenticated caller may ask for one, so the oldest of that
 * user's flows is dropped to make room.
 *
 * Per USER, and evicting only that user's own entries, deliberately: a global
 * cap that evicted the oldest entry would let one account's loop cancel
 * everyone else's sign-in. Three is well past "I misclicked and started
 * again"; the map's size is then bounded by the number of accounts, which on a
 * self-hosted install is a number the operator chose.
 */
const MAX_PENDING_FLOWS_PER_USER = 3
const REQUEST_TIMEOUT_MS = 15_000

/**
 * The GitHub OAuth App client id, from `GITHUB_OAUTH_CLIENT_ID`.
 *
 * A client id is **not a secret** — it is printed in every OAuth redirect URL
 * on the web — so reading it from the environment does not violate the "never
 * read a credential from the environment for a user-supplied operation" rule.
 * The credential in this feature is the TOKEN, and that only ever arrives in a
 * request or out of the encrypted store.
 *
 * Unset is a supported state, not a crash: the device routes answer 501 with
 * "ask your operator to configure a GitHub OAuth App", and the paste-a-PAT
 * path keeps working with no configuration at all.
 */
export function githubOAuthClientId(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.GITHUB_OAUTH_CLIENT_ID
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

const DeviceCodeResponseSchema = Type.Object(
  {
    device_code: Type.String(),
    user_code: Type.String(),
    verification_uri: Type.String(),
    expires_in: Type.Number(),
    interval: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

/**
 * GitHub answers the token endpoint with 200 in BOTH cases — a granted token
 * and a pending/denied/expired error — so the union is the honest shape and
 * the caller branches on which half is present.
 */
const AccessTokenResponseSchema = Type.Object(
  {
    access_token: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    interval: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

/** One pending sign-in. Held in memory only: a restart loses it, and the user starts again — there is nothing durable worth persisting about ten seconds of typing. */
interface PendingDeviceFlow {
  id: string
  /** The account that started this flow. A poll from any other user id is a 404. */
  userId: string
  /** The bearer of the pending authorization. Never leaves this process. */
  deviceCode: string
  intervalSeconds: number
  /** Epoch ms of the earliest moment the next poll may hit GitHub. */
  nextPollAt: number
  expiresAt: number
}

const flows = new Map<string, PendingDeviceFlow>()

function pruneExpiredFlows(now: number): void {
  for (const [id, flow] of flows) {
    if (flow.expiresAt <= now) flows.delete(id)
  }
}

/**
 * Drops this user's oldest pending flows until they hold fewer than the cap,
 * so the one about to be created fits. Touches nobody else's entries — see
 * {@link MAX_PENDING_FLOWS_PER_USER}.
 */
function evictOldestFlowsForUser(userId: string): void {
  // A `Map` iterates in insertion order and a flow is only ever appended, so
  // this list is already oldest-first — no timestamp to sort by, and no
  // ambiguity when several flows were started in the same millisecond.
  const mine = [...flows.values()].filter((flow) => flow.userId === userId)
  for (let i = 0; i <= mine.length - MAX_PENDING_FLOWS_PER_USER; i++) {
    flows.delete(mine[i]!.id)
  }
}

/** What the panel needs to render the "type this code at that URL" step. No `device_code` — see the module doc. */
export interface DeviceFlowStart {
  flowId: string
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

export interface GithubDeviceFlowDeps {
  /** Injected by tests so no case ever reaches github.com. Production passes nothing. */
  fetchImpl?: typeof fetch
  /**
   * The clock. A test seam — the pacing below is the one behaviour here that
   * is defined in seconds, and asserting it by sleeping would put real
   * multi-second waits in the suite for a rule that is pure arithmetic.
   */
  now?: () => number
}

/** Thrown when GitHub itself would not start or advance a flow. `status` is what the route answers. */
export class GithubDeviceFlowError extends Error {
  readonly status: number

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GithubDeviceFlowError'
    this.status = status
  }
}

async function postForm(
  url: string,
  body: Record<string, string>,
  deps: GithubDeviceFlowDeps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'studio-git-integration',
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new GithubDeviceFlowError('Could not reach GitHub to start the sign-in.', 502, { cause: err })
  }
}

/**
 * Asks GitHub for a device code and registers the pending flow against
 * `userId`. The returned `flowId` is what the panel polls with.
 */
export async function startGithubDeviceFlow(
  clientId: string,
  userId: string,
  deps: GithubDeviceFlowDeps = {},
): Promise<DeviceFlowStart> {
  const now = (deps.now ?? Date.now)()
  pruneExpiredFlows(now)

  const res = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: GITHUB_OAUTH_SCOPE }, deps)
  if (!res.ok) {
    throw new GithubDeviceFlowError(
      `GitHub would not start a device sign-in (status ${res.status}). Check the configured OAuth App client id.`,
      502,
    )
  }
  const parsed = await parseJsonResponse(res, DeviceCodeResponseSchema)

  const intervalSeconds = Math.max(1, Math.trunc(parsed.interval ?? DEFAULT_POLL_INTERVAL_SECONDS))
  const flow: PendingDeviceFlow = {
    id: randomUUID(),
    userId,
    deviceCode: parsed.device_code,
    intervalSeconds,
    // First poll is allowed immediately: the user has not typed the code yet,
    // so the first answer is certainly `authorization_pending`, and getting it
    // is how the panel knows the flow is alive.
    nextPollAt: now,
    // Clamped at BOTH ends. The floor keeps a nonsense-small `expires_in` from
    // producing a flow that is already dead; the ceiling keeps a nonsense-large
    // one from pinning a map entry forever, since `pruneExpiredFlows` is the
    // only thing that reclaims an abandoned flow.
    expiresAt: now + Math.min(FLOW_TTL_MS, Math.max(60_000, Math.trunc(parsed.expires_in) * 1000)),
  }
  evictOldestFlowsForUser(userId)
  flows.set(flow.id, flow)

  return {
    flowId: flow.id,
    userCode: parsed.user_code,
    verificationUri: parsed.verification_uri,
    expiresInSeconds: Math.trunc((flow.expiresAt - now) / 1000),
    intervalSeconds,
  }
}

/**
 * One poll's outcome.
 *
 * - `pending` — nobody has typed the code yet. `retryInSeconds` is what the
 *   client should wait, already adjusted for a `slow_down`.
 * - `authorized` — `token` and the scopes GitHub granted.
 * - `denied` / `expired` — terminal; the flow is forgotten.
 */
export type DeviceFlowPollResult =
  | { status: 'pending'; retryInSeconds: number }
  | { status: 'authorized'; token: string; scopes: string[] }
  | { status: 'denied' }
  | { status: 'expired' }

/**
 * Advances the flow `flowId`, which must belong to `userId`. Returns `null`
 * when there is no such flow for that user — the route answers 404, which
 * covers "never existed", "already finished", and "someone else's".
 *
 * The pacing GitHub asked for is enforced here: a poll that arrives early is
 * answered `pending` WITHOUT touching GitHub, so a client in a tight loop
 * slows itself down instead of getting the whole authorization rejected.
 */
export async function pollGithubDeviceFlow(
  clientId: string,
  userId: string,
  flowId: string,
  deps: GithubDeviceFlowDeps = {},
): Promise<DeviceFlowPollResult | null> {
  const now = (deps.now ?? Date.now)()
  // Deliberately NOT pruned here: an expired flow the caller is asking about
  // must answer `expired` (the branch below deletes it), not the 404 a pruned
  // entry would produce. Reclaiming everyone else's is `device/start`'s job.
  const flow = flows.get(flowId)
  if (!flow || flow.userId !== userId) return null

  if (flow.expiresAt <= now) {
    flows.delete(flow.id)
    return { status: 'expired' }
  }
  if (now < flow.nextPollAt) {
    return { status: 'pending', retryInSeconds: Math.ceil((flow.nextPollAt - now) / 1000) }
  }
  flow.nextPollAt = now + flow.intervalSeconds * 1000

  const res = await postForm(
    ACCESS_TOKEN_URL,
    {
      client_id: clientId,
      device_code: flow.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    deps,
  )
  if (!res.ok) {
    throw new GithubDeviceFlowError(`GitHub answered the sign-in poll with status ${res.status}.`, 502)
  }
  const parsed = await parseJsonResponse(res, AccessTokenResponseSchema)

  if (parsed.access_token) {
    flows.delete(flow.id)
    const scopes = (parsed.scope ?? '')
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
    return { status: 'authorized', token: parsed.access_token, scopes }
  }

  switch (parsed.error) {
    case 'authorization_pending':
      return { status: 'pending', retryInSeconds: flow.intervalSeconds }
    case 'slow_down': {
      // GitHub's documented response to polling too fast: it sends a NEW,
      // longer interval and expects it to be honoured from now on.
      flow.intervalSeconds = Math.max(flow.intervalSeconds + 5, Math.trunc(parsed.interval ?? 0))
      flow.nextPollAt = now + flow.intervalSeconds * 1000
      return { status: 'pending', retryInSeconds: flow.intervalSeconds }
    }
    case 'access_denied':
      flows.delete(flow.id)
      return { status: 'denied' }
    case 'expired_token':
      flows.delete(flow.id)
      return { status: 'expired' }
    default:
      flows.delete(flow.id)
      throw new GithubDeviceFlowError('GitHub refused the sign-in. Start again.', 502)
  }
}

/** Test-only: empties the registry between cases so a leaked flow cannot make a later assertion pass. */
export function clearGithubDeviceFlowsForTest(): void {
  flows.clear()
}
