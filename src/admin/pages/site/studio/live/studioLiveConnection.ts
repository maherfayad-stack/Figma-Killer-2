/**
 * studioLiveConnection - the one live channel of this tab.
 *
 * Module state, not a React concern: the senders (cursor, selection, viewport)
 * and the follow logic all talk to the same client, and a re-render must never
 * be able to open a second socket. `useLiveConnection` starts/stops it.
 */
import { LIVE_ROUTE_PATH } from '@core/studio-live'
import { LiveClient, type LiveSocketLike } from './liveClient'
import { INITIAL_LIVE_STATE, useLivePresence } from './livePresenceStore'

let client: LiveClient | null = null

/** The live client, or `null` while no project is connected. */
export function getLiveClient(): LiveClient | null {
  return client
}

export function liveSocketUrl(dir: string | null, location: Pick<Location, 'protocol' | 'host'>): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = dir ? `?dir=${encodeURIComponent(dir)}` : ''
  return `${scheme}//${location.host}${LIVE_ROUTE_PATH}${query}`
}

/** Connects this tab to `dir`'s room. Returns the disconnect. */
export function startStudioLive(dir: string | null): () => void {
  const store = useLivePresence.getState()
  const next = new LiveClient({
    url: liveSocketUrl(dir, window.location),
    createSocket: (url) => new WebSocket(url) as unknown as LiveSocketLike,
    onMessage: (message) => useLivePresence.getState().apply(message),
    onStatus: (status) => {
      const live = useLivePresence.getState()
      if (status === 'reconnecting') {
        // The room forgot us with the old socket; stale peers would linger.
        useLivePresence.setState({ ...INITIAL_LIVE_STATE, status })
      } else if (status !== 'live') {
        live.setStatus(status)
      }
    },
  })
  client = next
  store.reset()
  next.start()
  return () => {
    next.stop()
    if (client === next) client = null
    useLivePresence.getState().reset()
  }
}
