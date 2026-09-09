/**
 * devServerRequests — the wire contract for `/admin/api/studio/dev-server/*`
 * (`server/handlers/studio/devServer.ts`). Same posture as
 * `deployRequests.ts`: every call goes through `apiRequest` with a TypeBox
 * schema, and the exported type is `Static<typeof …>`, never a hand-written
 * mirror.
 *
 * The status shape never carries the dev server's own URL — only `phase`/
 * `pid`/`startedAt`/`log`. Sending a bare `localhost:<port>` to the browser
 * would invite the same same-origin misuse the live-origin design (Track L,
 * L2) exists to avoid; the URL stays server-internal.
 *
 * `status` and `start` answer 409 `{ error, code: 'trust-tier-required' }`
 * below Tier 2 — `apiRequest` surfaces that as a thrown `ApiError`, same as
 * `startPreviewDeploy`'s equivalent refusal.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'

const DevServerStatusSchema = Type.Object({
  phase: Type.Union([
    Type.Literal('stopped'),
    Type.Literal('booting'),
    Type.Literal('ready'),
    Type.Literal('failed'),
  ]),
  pid: Type.Union([Type.Number(), Type.Null()]),
  startedAt: Type.Union([Type.Number(), Type.Null()]),
  log: Type.String(),
})
export type DevServerStatus = Static<typeof DevServerStatusSchema>

const BASE = '/admin/api/studio/dev-server'

/** Current status without starting anything. Refuses below Tier 2. */
export async function getDevServerStatus(dir: string | undefined): Promise<DevServerStatus> {
  return apiRequest(`${BASE}/status`, { schema: DevServerStatusSchema, query: { dir } })
}

/** Starts (or reuses) `dir`'s dev server. Returns immediately — does not wait for boot. Refuses below Tier 2. */
export async function startDevServer(dir: string | undefined): Promise<DevServerStatus> {
  return apiRequest(`${BASE}/start`, { method: 'POST', body: { dir }, schema: DevServerStatusSchema })
}

/** Kills `dir`'s dev server if one is running. Never refuses — a project demoted mid-session must still be killable. */
export async function stopDevServer(dir: string | undefined): Promise<DevServerStatus> {
  return apiRequest(`${BASE}/stop`, { method: 'POST', body: { dir }, schema: DevServerStatusSchema })
}
