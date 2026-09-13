/**
 * liveOriginInfo — `GET /admin/api/studio/live-origin`, the one admin-origin
 * route that tells the client what origin the second, cookie-free
 * `Bun.serve` listener (`server/liveOrigin.ts`) is actually reachable at.
 *
 * This is genuinely new: nothing today exposes server-runtime config to the
 * client. It is NOT baked into a Vite env var — exactly like `PUBLIC_ORIGIN`
 * today, the live origin is resolved from environment/tunnel state at server
 * boot, not at build time, so a build-time constant would be wrong for any
 * self-hosted/tunneled deployment.
 *
 * No `dir`/capability parameter: this is server topology, not project-scoped
 * data, the same way no other endpoint needs a capability check to learn a
 * public URL.
 *
 * `liveOrigin` is `null` when the live listener never bound at boot (see
 * `getLiveOriginRuntimeOrigin`'s doc comment) — the client then knows not to
 * point an iframe `src` at a dead origin.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { jsonResponse, methodNotAllowed } from '../../http'
import { getLiveOriginRuntimeOrigin } from '../../liveOrigin'

const ROUTE_PATH = '/admin/api/studio/live-origin'

export const LiveOriginInfoSchema = Type.Object({
  liveOrigin: Type.Union([Type.String(), Type.Null()]),
})
export type LiveOriginInfo = Static<typeof LiveOriginInfoSchema>

/** `GET /admin/api/studio/live-origin` — see module doc for the full contract. */
export async function tryServeStudioLiveOriginInfo(
  req: Request,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const body: LiveOriginInfo = { liveOrigin: getLiveOriginRuntimeOrigin() }
  return jsonResponse(body)
}
