import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { StudioCanvas } from '../src/index.js';
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

createRoot(root).render(
  <React.StrictMode>
    <StudioCanvas daemonUrl={daemonUrl} style={{ width: '100vw', height: '100vh' }} />
  </React.StrictMode>,
);
