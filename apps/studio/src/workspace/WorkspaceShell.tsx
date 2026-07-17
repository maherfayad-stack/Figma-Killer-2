import * as React from 'react';
import 'tldraw/tldraw.css';
import { StudioCanvas, type StudioCanvasHandle, type CanvasFrameRecord } from '@ccs/canvas';
import { Tabs } from '@ccs/ui';
import { DaemonConnectionProvider, useDaemonConnection } from '../engine/daemon-connection.js';
import { EngineApiContext } from '../engine/engine-api-context.js';
import type { EngineApi } from '../engine/engine-api.js';
import { useWorkspaceStore } from './workspace-store.js';
import { useComponentInsert } from './use-component-insert.js';
import { useWorkspaceKeymap } from './use-workspace-keymap.js';
import { useZoomKeymap } from './use-zoom-keymap.js';
import { useTreeSnapshotSync } from './use-tree-snapshot-sync.js';
import { TopBar } from './TopBar.js';
import { Toolbar } from './Toolbar.js';
import { LayersPanel } from './LayersPanel.js';
import { ComponentsPanel } from './ComponentsPanel.js';
import { TokensPanel } from './TokensPanel.js';
import { Inspector } from './Inspector.js';
import { ZoomWidget } from './ZoomWidget.js';

/**
 * WorkspaceShell — the per-file workspace (playbook §2.1 `workspace.cljs`):
 * top toolbar, left dock (Layers/Assets/Tokens — spec §5.1/§5.2: "Pages" is
 * no longer a separate top-level tab, it's the top strip of the "Layers"
 * tab, see `LayersPanel.tsx`), center canvas (mounts `@ccs/canvas`'s
 * `StudioCanvas`, P1), right dock (Inspector), bottom status bar. Owns the
 * daemon connection + engine-API provider for everything beneath it.
 */
export interface WorkspaceShellProps {
  fileName: string;
  daemonUrl: string;
  engineApi: EngineApi;
  onBackToDashboard: () => void;
}

export function WorkspaceShell(props: WorkspaceShellProps): React.ReactElement {
  return (
    <DaemonConnectionProvider daemonUrl={props.daemonUrl}>
      <EngineApiContext.Provider value={props.engineApi}>
        <WorkspaceShellInner {...props} />
      </EngineApiContext.Provider>
    </DaemonConnectionProvider>
  );
}

function WorkspaceShellInner({ fileName, daemonUrl, onBackToDashboard }: WorkspaceShellProps): React.ReactElement {
  const [leftTab, setLeftTab] = React.useState('layers');
  const insertComponent = useComponentInsert();
  useWorkspaceKeymap();
  useTreeSnapshotSync();

  // FP-1 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2): camera-control handle
  // from `StudioCanvas.onReady` + the live zoom % from `onZoomChange` — see
  // `ZoomWidget.tsx` and `use-zoom-keymap.ts`, both driven from these two
  // pieces of state, never a tldraw type (playbook §5.4).
  const [canvasHandle, setCanvasHandle] = React.useState<StudioCanvasHandle | null>(null);
  const [zoomPercent, setZoomPercent] = React.useState(100);
  useZoomKeymap(canvasHandle);

  // FP-1 §2 item 4: clicking/marquee-selecting a frame on the canvas
  // (tldraw native) reflects in the studio's own selection store exactly
  // the same way `LayersPanel`'s board-row click already does — reuses
  // `selectFrame` rather than adding a parallel selection path.
  const selectFrame = useWorkspaceStore((s) => s.selectFrame);
  const handleFrameSelect = React.useCallback(
    (record: CanvasFrameRecord | null) => {
      if (record) selectFrame(record.fileFolder, record.framePath);
    },
    [selectFrame],
  );

  return (
    <div
      className="ccs-root"
      data-testid="workspace-shell"
      style={{
        display: 'grid',
        gridTemplateRows: 'var(--ccs-topbar-height) 1fr var(--ccs-statusbar-height)',
        blockSize: '100vh',
        inlineSize: '100%',
      }}
    >
      <TopBar fileName={fileName} onBackToDashboard={onBackToDashboard} />
      <div style={{ display: 'grid', gridTemplateColumns: 'var(--ccs-sidebar-left-width) 1fr var(--ccs-sidebar-right-width)', minBlockSize: 0 }}>
        <aside
          data-testid="dock-left"
          style={{ borderInlineEnd: '1px solid var(--ccs-border)', background: 'var(--ccs-bg-panel)', display: 'flex', minBlockSize: 0 }}
        >
          <Tabs
            ariaLabel="Left dock"
            value={leftTab}
            onValueChange={setLeftTab}
            items={[
              { id: 'layers', label: 'Layers', content: <LayersPanel /> },
              { id: 'assets', label: 'Assets', content: <ComponentsPanel /> },
              { id: 'tokens', label: 'Tokens', content: <TokensPanel /> },
            ]}
          />
        </aside>

        <main style={{ display: 'flex', flexDirection: 'column', minBlockSize: 0, minInlineSize: 0 }}>
          <Toolbar onOpenComponentPalette={() => setLeftTab('assets')} />
          <div
            data-testid="canvas-area"
            style={{ flex: 1, position: 'relative', minBlockSize: 0 }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const name = e.dataTransfer.getData('text/ccs-component');
              if (name) insertComponent(name);
            }}
          >
            <StudioCanvas
              daemonUrl={daemonUrl}
              style={{ inlineSize: '100%', blockSize: '100%' }}
              onReady={setCanvasHandle}
              onZoomChange={setZoomPercent}
              onFrameSelect={handleFrameSelect}
            />
            {/* FP-1 §2 item 2: floating zoom widget. Per the brief, FP-2
                hasn't restructured the header into left/right panes yet, so
                this is a floating overlay for now. Top-end corner, offset
                below the canvas package's own "+ New Frame" control (same
                corner, see `StudioCanvas.tsx`) rather than bottom-end:
                verified live that tldraw's own (unlicensed-build) watermark
                badge occupies the bottom-end corner and fully intercepts
                pointer events there, which would make the widget
                unclickable — FP-2 relocates this into the right-pane
                header anyway, so this is a placement of convenience. */}
            <div style={{ position: 'absolute', insetBlockStart: 54, insetInlineEnd: 12, zIndex: 10 }}>
              <ZoomWidget zoomPercent={zoomPercent} handle={canvasHandle} />
            </div>
          </div>
        </main>

        <aside
          data-testid="dock-right"
          style={{ borderInlineStart: '1px solid var(--ccs-border)', background: 'var(--ccs-bg-panel)', overflow: 'auto', minBlockSize: 0 }}
        >
          <Inspector />
        </aside>
      </div>

      <StatusBar />
    </div>
  );
}

function StatusBar(): React.ReactElement {
  const { connected } = useDaemonConnection();
  const selectedUid = useWorkspaceStore((s) => s.selectedUid);
  return (
    <div
      data-testid="statusbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        paddingInline: 12,
        fontSize: 'var(--ccs-font-size-xs)',
        color: 'var(--ccs-text-subtle)',
        background: 'var(--ccs-bg-panel)',
        borderBlockStart: '1px solid var(--ccs-border)',
      }}
    >
      <span>{connected ? 'daemon: connected' : 'daemon: offline'}</span>
      {selectedUid && <span style={{ fontFamily: 'var(--ccs-font-mono)' }}>selected: {selectedUid}</span>}
    </div>
  );
}
