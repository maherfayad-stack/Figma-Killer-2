import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { CustomEngineCanvas } from '../src/CustomEngineCanvas.js';
import { useCameraStore } from '../src/camera-store.js';
import { useSelectionStore } from '../src/selection-store.js';
import { onFrameGeometryCommitted } from '../src/frame-geometry-commit.js';
import type { StudioCanvasHandle } from '../src/index.js';

/**
 * Sub-workstream 2d-ii (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — extends
 * the 2b/2c isolated `<Canvas>`-only harness to mount the FULL
 * `CustomEngineCanvas` assembly (daemon connection, `frames` state,
 * create/duplicate-frame, `StudioCanvasHandle`, edit-mode overlay) for
 * real, against a real running daemon — mirrors `dev/main.tsx`'s
 * `?daemonPort=` convention exactly (defaulting to `demo:daemon`'s
 * documented default port 4700) so `pnpm demo:daemon && pnpm
 * demo:custom-engine` works with zero manual wiring, same as the tldraw
 * harness always has.
 *
 * Still NOT wired into `StudioCanvas.tsx`/`apps/studio` — this harness is
 * how the custom-engine path is dogfooded in isolation before Phase 3
 * parity-verification signs off on it as `apps/studio`'s real default.
 */

const DEFAULT_DAEMON_PORT = 4700;

function readDaemonPort(): number {
  const fromQuery = new URLSearchParams(window.location.search).get('daemonPort');
  const parsed = fromQuery ? Number.parseInt(fromQuery, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_PORT;
}

const daemonPort = readDaemonPort();
const daemonUrl = `ws://127.0.0.1:${daemonPort}`;

// Sub-workstream 2c/2d-ii manual/scripted verification hook — DEV-ONLY, this
// harness is a throwaway acceptance-demo page (never shipped), so exposing
// internals on `window` here for a browser-automation script to inspect
// camera/selection/geometry state is fine and matches this file's existing
// "isolated, checkable" purpose. Not present in any production bundle.
(
  window as unknown as {
    __ccsCameraStore: typeof useCameraStore;
    __ccsSelectionStore: typeof useSelectionStore;
    __ccsCanvasHandle: StudioCanvasHandle | null;
  }
).__ccsCameraStore = useCameraStore;
(window as unknown as { __ccsSelectionStore: typeof useSelectionStore }).__ccsSelectionStore = useSelectionStore;
(window as unknown as { __ccsCanvasHandle: StudioCanvasHandle | null }).__ccsCanvasHandle = null;

onFrameGeometryCommitted((geometry) => {
  console.log('[ccs] geometry committed', JSON.stringify(geometry));
});

function Harness(): React.ReactElement {
  const [zoomPercent, setZoomPercent] = React.useState(100);
  return (
    <>
      <CustomEngineCanvas
        daemonUrl={daemonUrl}
        style={{ width: '100vw', height: '100vh' }}
        onReady={(handle) => {
          (window as unknown as { __ccsCanvasHandle: StudioCanvasHandle }).__ccsCanvasHandle = handle;
          console.log('[ccs] CustomEngineCanvas onReady fired');
        }}
        onZoomChange={setZoomPercent}
        onFrameSelect={(record) => console.log('[ccs] onFrameSelect', record?.id ?? null)}
        onElementSelect={(selection) => console.log('[ccs] onElementSelect', selection)}
      />
      <div
        data-testid="ccs-zoom-readout"
        style={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          zIndex: 10,
          fontFamily: 'system-ui, sans-serif',
          fontSize: 12,
          background: '#18181b',
          color: '#fff',
          padding: '4px 8px',
          borderRadius: 4,
        }}
      >
        {zoomPercent}%
      </div>
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('custom-engine-harness: #root not found');

createRoot(root).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
