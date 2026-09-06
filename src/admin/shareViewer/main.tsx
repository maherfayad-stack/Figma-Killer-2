/**
 * Entry point for the public share viewer — Vite's THIRD HTML entry
 * (`share.html`), not a route inside the admin SPA.
 *
 * A separate entry for the same structural reason `agentCapture/main.tsx`
 * gives: a route inside the admin app would boot the router, the session
 * probe, the toast provider, the plugin runtime and the authenticated-shell
 * preload — every one of which either needs a session this visitor does not
 * have, or ships editor code to a stranger. A separate entry cannot. The only
 * things in this bundle are React, the HTTP client, the share wire schemas,
 * and the viewer itself.
 *
 * The token arrives one of two ways and the viewer accepts both: in the PATH
 * (`/share/<token>`, what a built deployment serves) or in the QUERY
 * (`/share.html?token=…`, where the dev-mode redirect lands, because Vite
 * serves its entry at a fixed filename). See `sharePublic.ts`.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isShareTokenShape, SHARE_ROUTE_PREFIX } from '@core/studio-share'
import '../../styles/globals.css'
import { ShareViewer } from './ShareViewer'
import { ShareUnavailable } from './ShareUnavailable'

function readToken(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get('token')
  if (fromQuery && isShareTokenShape(fromQuery)) return fromQuery
  const { pathname } = window.location
  if (!pathname.startsWith(SHARE_ROUTE_PREFIX)) return null
  const candidate = pathname.slice(SHARE_ROUTE_PREFIX.length).split('/')[0] ?? ''
  return isShareTokenShape(candidate) ? candidate : null
}

const rootElement = document.getElementById('root')
if (rootElement) {
  const token = readToken()
  createRoot(rootElement).render(
    <StrictMode>
      {token ? <ShareViewer token={token} /> : <ShareUnavailable />}
    </StrictMode>,
  )
}
