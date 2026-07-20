import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { StudioCanvas, type StudioCanvasHandle } from '../src/index.js';
import 'tldraw/tldraw.css';

/**
 * P1 acceptance-demo harness page (BOUNDARIES: thin dev harness under
 * packages/canvas/, not studio chrome). Reads the real daemon's
 * control-ws port from `?daemonPort=`, defaulting to the sync-daemon's
 * documented default start port (4700) so `pnpm demo:daemon && pnpm
 * demo:harness` works with zero manual wiring in the common case.
 *
 * No `onCreateFrame` prop is passed — `StudioCanvas`'s default
 * implementation (ADR-0014) sends `create-frame` straight over this same
 * control-ws connection now that the daemon has a real API for it, so the
 * "+ New Frame" tool exercises that path rather than the older
 * dev-only HTTP endpoint (`dev/create-frame-server.ts`, now unused by this
 * harness — kept only for `dev/run-daemon.ts`'s manual-demo convenience).
 */

const DEFAULT_DAEMON_PORT = 4700;

function readDaemonPort(): number {
  const fromQuery = new URLSearchParams(window.location.search).get('daemonPort');
  const parsed = fromQuery ? Number.parseInt(fromQuery, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_PORT;
}

const daemonPort = readDaemonPort();
const daemonUrl = `ws://127.0.0.1:${daemonPort}`;

const root = document.getElementById('root');
if (!root) throw new Error('dev harness: #root not found');

/**
 * TEST-ONLY HOOK (not production wiring — `apps/studio` never imports this
 * file). `acceptance.spec.ts`'s test (a) needs to bring the `Hero` frame
 * into view/selection before asserting on its live iframe, matching what a
 * real user editing `Hero.tsx` would actually do (look at Hero), rather
 * than relying on it incidentally landing in `viewport-cull.ts`'s
 * nearest-8-to-viewport-center live budget after the perf fixture's extra
 * frames get tiled in around it by the mount-time `zoomToFit`. `onReady`
 * (`StudioCanvasHandle`, playbook §5.4 engine-agnostic camera-control
 * surface — identical shape for both the tldraw and custom engines) is
 * the least-invasive existing hook that already exposes exactly what's
 * needed (`zoomToFrame(fileFolder, framePath)`) — stashing it on `window`
 * here, rather than inventing new test-only wiring, lets the Playwright
 * test drive it via `page.evaluate`.
 */
declare global {
  interface Window {
    __ccsHandle?: StudioCanvasHandle;
  }
}

createRoot(root).render(
  <React.StrictMode>
    <StudioCanvas
      daemonUrl={daemonUrl}
      style={{ width: '100vw', height: '100vh' }}
      onReady={(handle) => {
        window.__ccsHandle = handle;
      }}
    />
  </React.StrictMode>,
);
