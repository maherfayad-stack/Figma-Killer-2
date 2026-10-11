/**
 * The WebSocket upgrade for `GET /admin/api/studio/live?dir=`.
 *
 * `routeGate` only runs its CSRF `Origin` rule for state-changing methods, and
 * a WebSocket handshake is a GET - so this module does that check itself
 * (cross-origin WebSocket hijacking). A browser always sends `Origin` on a
 * handshake, so an absent one is refused too. Then the same gate every other
 * Studio route passes: the path must be declared, the session must hold the
 * capability the declaration names (`site.read`).
 *
 * Refusals are plain JSON 4xx - never a partial upgrade, never a path in the
 * message.
 */
import { LIVE_ROUTE_PATH } from '@core/studio-live'
import { jsonResponse } from '../../../http'
import { originAllowed } from '../../../auth/security'
import { requireCapability } from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { resolveProjectDir } from '../../studioProjects'
import { gateStudioRequest } from '../routeGate'
import { lockKey } from '../projectWriteLock'
import { FrameRateLimiter } from './rateLimit'
import { existingRoom } from './registry'
import type { LiveSocketData } from './socketHandler'

/** The minimal slice of `Bun.Server` the upgrade needs; lets tests pass a fake. */
export interface LiveUpgrader {
  upgrade(req: Request, options: { data: LiveSocketData }): boolean
}

/** Whether `pathname` is the presence socket's route (the only one this module serves). */
export function isLiveUpgradePath(pathname: string): boolean {
  return pathname === LIVE_ROUTE_PATH
}

function displayNameOf(user: { displayName: string; email: string }): string {
  return user.displayName.trim() || user.email.split('@')[0] || 'Someone'
}

/**
 * `undefined` when the socket was upgraded (Bun's convention: the handshake
 * response is sent by the runtime), a refusal `Response` otherwise.
 */
export async function handleLiveUpgrade(
  req: Request,
  server: LiveUpgrader,
  db: DbClient,
): Promise<Response | undefined> {
  const url = new URL(req.url)
  if (req.method !== 'GET') return jsonResponse({ error: 'Not found' }, { status: 404 })

  // CSWSH: the handshake carries cookies, so the page that opened it must be ours.
  if (!req.headers.get('origin') || !originAllowed(req)) {
    return jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 })
  }

  const gate = await gateStudioRequest(req, db, LIVE_ROUTE_PATH)
  if (gate === null) return jsonResponse({ error: 'Not found' }, { status: 404 })
  if (gate instanceof Response) return gate

  let roomKey: string
  try {
    roomKey = lockKey(resolveProjectDir(url.searchParams.get('dir')))
  } catch {
    return jsonResponse({ error: 'Not found' }, { status: 404 })
  }

  if (existingRoom(roomKey)?.isFull()) {
    return jsonResponse({ error: 'This board is full' }, { status: 503 })
  }

  // The handshake's own credentials, replayed for the periodic re-check.
  const sessionCookie = req.headers.get('cookie') ?? ''
  const sessionUrl = `${url.origin}${LIVE_ROUTE_PATH}`
  const data: LiveSocketData = {
    roomKey,
    identity: {
      userId: gate.user.id,
      name: displayNameOf(gate.user),
      avatarUrl: gate.user.avatarUrl,
      kind: 'user',
    },
    revalidate: async () => {
      const recheck = new Request(sessionUrl)
      recheck.headers.set('cookie', sessionCookie)
      const result = await requireCapability(recheck, db, 'site.read')
      return !(result instanceof Response)
    },
    limiter: new FrameRateLimiter(),
    memberId: null,
    helloTimer: null,
  }

  // Bun decides whether this is a real WebSocket handshake; a plain GET is not.
  if (!server.upgrade(req, { data })) {
    return jsonResponse({ error: 'Upgrade required' }, { status: 426 })
  }
  return undefined
}
