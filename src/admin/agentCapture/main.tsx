/**
 * Entry point for the headless capture page — Vite's SECOND HTML entry
 * (`agent-capture.html`), not a route inside the admin SPA.
 *
 * A separate entry rather than a lazy route because "no editor shell" has to
 * be structural, not a promise. A route inside `main.tsx` would still boot the
 * admin router, the boot probe, the toast provider, the plugin runtime and the
 * authenticated-shell preload — every one of which can mutate state, fire a
 * request, or paint something the capture would then contain. A separate entry
 * cannot: the only things in this bundle are the base modules (so the canvas
 * has renderers), the editor store, the canvas, and the capture app.
 *
 * `registerBaseModules` is imported for its side effect exactly as
 * `AdminEntry.tsx` imports it — the module registry is a global singleton and
 * `NodeRenderer` resolves every node through it.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@modules/base'
import '../../styles/globals.css'
import { CaptureApp } from './CaptureApp'
import { markCaptureLoading, publishCaptureError } from './captureReadiness'

// Published before anything can throw, so the driver's poll always finds a
// defined global — an undefined one is indistinguishable from a page that
// never executed, and it would sit in `waitForFunction` until its timeout
// instead of reporting the real failure.
markCaptureLoading()

const rootElement = document.getElementById('root')
const token = new URLSearchParams(window.location.search).get('token')

if (!rootElement) {
  publishCaptureError('The capture page has no #root element to mount into.')
} else if (!token) {
  publishCaptureError('The capture page was opened without a token.')
} else {
  createRoot(rootElement, {
    // Every render error becomes the report the driver reads. There is no user
    // here to toast at and no boundary to recover into — a capture that threw
    // must say so rather than hand back a blank screenshot.
    onUncaughtError: (error) => {
      console.error('[agent-capture] render failed:', error)
      publishCaptureError(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    },
  }).render(
    <StrictMode>
      <CaptureApp token={token} />
    </StrictMode>,
  )
}
