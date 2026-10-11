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

/**
 * The socket URL. Same-origin by default (production: the admin app and the API
 * share one origin). In development the admin app is served by Vite, whose
 * `/admin/api` proxy cannot carry a WebSocket under Bun (it hangs a good
 * upgrade and can crash on a refused one), so the dev scripts publish the
 * backend's port as `VITE_STUDIO_LIVE_BACKEND_PORT` and the socket connects to
 * it directly, on the page's own hostname so the session cookie goes along.
 */
export function liveSocketUrl(
  dir: string | null,
  location: Pick<Location, 'protocol' | 'host' | 'hostname'>,
  backendPort?: string,
): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = backendPort ? `${location.hostname}:${backendPort}` : location.host
  const query = dir ? `?dir=${encodeURIComponent(dir)}` : ''
  return `${scheme}//${host}${LIVE_ROUTE_PATH}${query}`
}

function devBackendPort(): string | undefined {
  const port: unknown = import.meta.env.VITE_STUDIO_LIVE_BACKEND_PORT
  return typeof port === 'string' && /^\d+$/.test(port) ? port : undefined
}

/** Connects this tab to `dir`'s room. Returns the disconnect. */
export function startStudioLive(dir: string | null): () => void {
  const store = useLivePresence.getState()
  const next = new LiveClient({
    url: liveSocketUrl(dir, window.location, devBackendPort()),
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
