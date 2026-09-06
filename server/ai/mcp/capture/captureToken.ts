/**
 * Single-purpose capture tokens — the credential the headless capture page
 * (`/admin/agent-capture`) authenticates with.
 *
 * ## Why not the admin session cookie
 *
 * The obvious shortcut would be to hand the headless browser the operator's
 * session cookie. That would give a screenshot job the operator's ENTIRE
 * admin authority — publish, delete, connector management — for the lifetime
 * of the cookie, to a browser process this server spawned, over a URL that
 * ends up in a Playwright trace and a process argument list. Nothing about
 * taking a picture of a parsed page needs any of that.
 *
 * So this follows `sessionConnector.ts`'s turn-token pattern one notch
 * tighter. The shape is the same — minted BY THE SERVER for one operation,
 * never by a human, revoked in the caller's `finally`, with the TTL as a
 * safety net rather than the boundary. The differences are all reductions:
 *
 *   - **No capabilities at all.** A grant is not a principal. It authorises
 *     exactly two reads, both scoped to the ONE project directory recorded in
 *     the grant: the capture payload for its own `pageIds`, and the local
 *     image assets those pages reference. `dir` comes from the grant, never
 *     from the request's query string, so there is no traversal surface.
 *   - **Minutes, not days.** `createConnector`'s floor is one day because it
 *     is a day-granularity DB record; this registry is in-process, so the TTL
 *     can be what the operation actually needs.
 *   - **Single use in practice.** `consume` is called by the driver's
 *     `finally` the moment the capture ends, success or failure.
 *
 * The registry is in-memory and per-process, which is correct here: a capture
 * never outlives the server that started it, and a restart mid-capture SHOULD
 * invalidate the token rather than leave a credential behind.
 */
import type { PreviewAxes } from '@core/studio-board'

/**
 * How long a grant survives if the driver somehow never revokes it (process
 * killed mid-capture, an exception path that escapes the `finally`). Long
 * enough to cover a cold browser launch plus a 20-page batch on a slow
 * machine; short enough that a leaked URL is worthless by the time anyone
 * reads it out of a log.
 */
const CAPTURE_TOKEN_TTL_MS = 5 * 60_000

const TOKEN_BYTES = 32

export interface CaptureGrant {
  /** The user this capture is being performed on behalf of — carried for logging/attribution, never used to widen access. */
  readonly userId: string
  /** The ONE project directory this grant can read. Never taken from the request. */
  readonly dir: string
  /** The exact pages this grant can render. A page outside this list is not served. */
  readonly pageIds: readonly string[]
  readonly axes?: Partial<PreviewAxes>
  readonly expiresAt: number
}

const grants = new Map<string, CaptureGrant>()

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Drops every expired grant. Cheap (the map holds at most a handful of live captures) and keeps a long-lived process from accumulating dead entries. */
function sweepExpired(now: number): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token)
  }
}

export interface MintCaptureTokenInput {
  userId: string
  dir: string
  pageIds: readonly string[]
  axes?: Partial<PreviewAxes>
}

/** Mint a capture-only grant for one headless capture. The caller MUST revoke it in a `finally`. */
export function mintCaptureToken(input: MintCaptureTokenInput): string {
  const now = Date.now()
  sweepExpired(now)
  const token = `icap_${toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`
  grants.set(token, {
    userId: input.userId,
    dir: input.dir,
    pageIds: [...input.pageIds],
    ...(input.axes ? { axes: input.axes } : {}),
    expiresAt: now + CAPTURE_TOKEN_TTL_MS,
  })
  return token
}

/**
 * The live grant for a presented token, or `null` when it is unknown, expired,
 * or already revoked. Expiry is enforced here rather than by a timer so a
 * clock that jumped forward can never widen the window.
 */
export function resolveCaptureToken(token: string | null): CaptureGrant | null {
  if (!token) return null
  const grant = grants.get(token)
  if (!grant) return null
  if (grant.expiresAt <= Date.now()) {
    grants.delete(token)
    return null
  }
  return grant
}

/** Revoke a grant the instant its capture ends. Idempotent. */
export function revokeCaptureToken(token: string): void {
  grants.delete(token)
}

/** Test-only: how many grants are currently live. */
export function liveCaptureGrantCount(): number {
  sweepExpired(Date.now())
  return grants.size
}
