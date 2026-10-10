/**
 * The Bun `websocket` handler for the live channel.
 *
 * Authority was decided once, at the upgrade (`upgrade.ts`): origin, session,
 * `site.read`. Per-message, nothing a client sends can widen that: the frame is
 * validated against the TypeBox union, budgeted per socket, and applied to the
 * room as presence only. Session validity is re-checked every 30 s by the room.
 */
import type { ServerWebSocket, WebSocketHandler } from 'bun'
import { LIVE_MAX_FRAME_BYTES, LIVE_TTL_MS, parseLiveClientMessage } from '@core/studio-live'
import { FrameRateLimiter } from './rateLimit'
import { releaseRoomIfEmpty, roomFor } from './registry'
import type { LiveIdentity } from './room'

export interface LiveSocketData {
  roomKey: string
  identity: LiveIdentity
  /** Resolves `false` once the upgrade's session stops granting `site.read`. */
  revalidate: () => Promise<boolean>
  limiter: FrameRateLimiter
  memberId: string | null
  /** Closes a socket that connects but never says hello. */
  helloTimer: ReturnType<typeof setTimeout> | null
}

function leave(ws: ServerWebSocket<LiveSocketData>): void {
  const { data } = ws
  if (data.helloTimer) clearTimeout(data.helloTimer)
  data.helloTimer = null
  if (data.memberId) {
    roomFor(data.roomKey).leave(data.memberId)
    data.memberId = null
  }
  releaseRoomIfEmpty(data.roomKey)
}

export const liveWebsocketHandler: WebSocketHandler<LiveSocketData> = {
  maxPayloadLength: LIVE_MAX_FRAME_BYTES,
  idleTimeout: 0,
  open(ws) {
    ws.data.helloTimer = setTimeout(() => {
      if (!ws.data.memberId) ws.close(1008, 'hello required')
    }, LIVE_TTL_MS)
  },
  message(ws, raw) {
    const { data } = ws
    if (typeof raw !== 'string') {
      ws.close(1003, 'text frames only')
      return
    }
    const message = parseLiveClientMessage(raw)
    if (!message) {
      ws.close(1008, 'invalid frame')
      return
    }
    const now = Date.now()
    if (!data.limiter.allow(message.t === 'presence' ? 'presence' : 'control', now)) {
      ws.close(1008, 'rate limit')
      return
    }
    if (message.t === 'hello') {
      if (data.memberId) return
      const room = roomFor(data.roomKey)
      const member = room.join(data.identity, ws, now, data.revalidate)
      if (!member) {
        ws.close(1013, 'room full')
        releaseRoomIfEmpty(data.roomKey)
        return
      }
      data.memberId = member.memberId
      if (data.helloTimer) clearTimeout(data.helloTimer)
      data.helloTimer = null
      return
    }
    if (!data.memberId) {
      ws.close(1008, 'hello required')
      return
    }
    roomFor(data.roomKey).receive(data.memberId, message, now)
  },
  close(ws) {
    leave(ws)
  },
}
