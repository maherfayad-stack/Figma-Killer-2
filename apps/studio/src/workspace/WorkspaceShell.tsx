import * as React from 'react';
import 'tldraw/tldraw.css';
import { StudioCanvas } from '@ccs/canvas';
import { Tabs } from '@ccs/ui';
import { DaemonConnectionProvider, useDaemonConnection } from '../engine/daemon-connection.js';
import { EngineApiContext } from '../engine/engine-api-context.js';
import type { EngineApi } from '../engine/engine-api.js';
import { useWorkspaceStore } from './workspace-store.js';
import { useComponentInsert } from './use-component-insert.js';
import { useWorkspaceKeymap } from './use-workspace-keymap.js';
import { useTreeSnapshotSync } from './use-tree-snapshot-sync.js';
import { TopBar } from './TopBar.js';
import { Toolbar } from './Toolbar.js';
import { PagesPanel } from './PagesPanel.js';
import { LayersPanel } from './LayersPanel.js';
import { ComponentsPanel } from './ComponentsPanel.js';
import { TokensPanel } from './TokensPanel.js';
import { Inspector } from './Inspector.js';

/**
 * WorkspaceShell — the per-file workspace (playbook §2.1 `workspace.cljs`):
 * top toolbar, left dock (Pages/Layers/Assets/Tokens), center canvas
 * (mounts `@ccs/canvas`'s `StudioCanvas`, P1), right dock (Inspector),
 * bottom status bar. Owns the daemon connection + engine-API provider for
 * everything beneath it.
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
  const [leftTab, setLeftTab] = React.useState('pages');
  const insertComponent = useComponentInsert();
  useWorkspaceKeymap();
  useTreeSnapshotSync();

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
      <div style={{ display: 'grid', gridTemplateColumns: 'var(--ccs-dock-width) 1fr var(--ccs-dock-width)', minBlockSize: 0 }}>
        <aside
          data-testid="dock-left"
          style={{ borderInlineEnd: '1px solid var(--ccs-border)', background: 'var(--ccs-bg-panel)', display: 'flex', minBlockSize: 0 }}
        >
          <Tabs
            ariaLabel="Left dock"
            value={leftTab}
            onValueChange={setLeftTab}
            items={[
              { id: 'pages', label: 'Pages', content: <PagesPanel /> },
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
            <StudioCanvas daemonUrl={daemonUrl} style={{ inlineSize: '100%', blockSize: '100%' }} />
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
