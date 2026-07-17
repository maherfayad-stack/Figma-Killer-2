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
import { useToolKeymap } from './use-tool-keymap.js';
import { useTreeSnapshotSync } from './use-tree-snapshot-sync.js';
import { useResize } from './use-resize.js';
import { LeftHeader } from './LeftHeader.js';
import { RightHeader } from './RightHeader.js';
import { Toolbar } from './Toolbar.js';
import { LayersPanel } from './LayersPanel.js';
import { ComponentsPanel } from './ComponentsPanel.js';
import { TokensPanel } from './TokensPanel.js';
import { Inspector } from './Inspector.js';

/**
 * WorkspaceShell — the per-file workspace (playbook §2.1 `workspace.cljs`).
 *
 * FP-2 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2; spec §5.1) restructure:
 * Penpot has NO single global top bar — a LEFT header and a RIGHT header,
 * each 52px, pinned atop their own sidebar, flank the viewport. This shell
 * used to render one global `TopBar` row above a 3-column grid (see git
 * history / that file's former module doc); it now renders NO top-level
 * header row at all — each `<aside>` is its own `[header][content]` flex
 * column (`LeftHeader.tsx` / `RightHeader.tsx`), and the middle (canvas)
 * column has no header of its own. The zoom widget (FP-1, `ZoomWidget.tsx`)
 * no longer floats over the canvas; it's mounted inside `RightHeader`.
 * FP-3 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-3) makes `Toolbar.tsx`
 * itself the thing that DOES float over the canvas now — it's rendered as a
 * sibling of `<StudioCanvas>` inside the `position: relative` `canvas-area`
 * div, absolutely positioned top-center (spec §5.8 / Penpot's
 * `top_toolbar.scss`), overlaying the viewport instead of occupying a flow
 * row above it.
 *
 * Panels are now resizable (`use-resize.ts`, a reimplementation of Penpot's
 * `resize.cljs`): drag either sidebar's inner edge (the one facing the
 * canvas), clamped and persisted per-project in localStorage.
 */
export interface WorkspaceShellProps {
  fileName: string;
  /** Stable per-project id (`ProjectEntry.id`, `projects-registry.ts`) —
   * scopes both the localStorage panel-width persistence (`use-resize.ts`)
   * and inline-rename writes to exactly this project's registry entry. */
  projectId: string;
  daemonUrl: string;
  engineApi: EngineApi;
  onBackToDashboard: () => void;
  onRenameFile: (name: string) => void;
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

function WorkspaceShellInner({
  fileName,
  projectId,
  daemonUrl,
  onBackToDashboard,
  onRenameFile,
}: WorkspaceShellProps): React.ReactElement {
  const [leftTab, setLeftTab] = React.useState('layers');
  const insertComponent = useComponentInsert();
  useWorkspaceKeymap();
  useTreeSnapshotSync();

  // FP-2 (spec §2.2): left panel 318–500px, right panel 318–768px,
  // persisted per-project (`projectId`) in localStorage — see
  // `use-resize.ts`'s module doc for the Penpot `resize.cljs` mechanics
  // this reimplements.
  const left = useResize({ projectId, panelId: 'left', initial: 318, min: 318, max: 500 });
  const right = useResize({ projectId, panelId: 'right', initial: 318, min: 318, max: 768 });

  // FP-1 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2): camera-control handle
  // from `StudioCanvas.onReady` + the live zoom % from `onZoomChange` — see
  // `ZoomWidget.tsx` (now mounted in `RightHeader`) and `use-zoom-keymap.ts`,
  // both driven from these two pieces of state, never a tldraw type
  // (playbook §5.4).
  const [canvasHandle, setCanvasHandle] = React.useState<StudioCanvasHandle | null>(null);
  const [zoomPercent, setZoomPercent] = React.useState(100);
  useZoomKeymap(canvasHandle);

  // FP-3 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-3): V/F/T/I/C
  // keyboard shortcuts, routed through the same `useToolActions` bridge
  // `Toolbar.tsx`'s buttons use — see `use-tool-keymap.ts`'s doc.
  const openComponentPalette = React.useCallback(() => setLeftTab('assets'), []);
  useToolKeymap(canvasHandle, openComponentPalette);

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
        gridTemplateRows: '1fr var(--ccs-statusbar-height)',
        blockSize: '100vh',
        inlineSize: '100%',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${left.size}px 1fr ${right.size}px`,
          minBlockSize: 0,
        }}
      >
        <aside
          data-testid="dock-left"
          style={{
            position: 'relative',
            borderInlineEnd: '1px solid var(--ccs-border)',
            background: 'var(--ccs-bg-panel)',
            display: 'flex',
            flexDirection: 'column',
            minBlockSize: 0,
          }}
        >
          <LeftHeader fileName={fileName} onBackToDashboard={onBackToDashboard} onRenameFile={onRenameFile} />
          <div style={{ flex: 1, display: 'flex', minBlockSize: 0 }}>
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
          </div>
          <ResizeHandle testId="resize-handle-left" edge="end" {...left.handleProps} />
        </aside>

        <main style={{ display: 'flex', flexDirection: 'column', minBlockSize: 0, minInlineSize: 0 }}>
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
            <Toolbar onOpenComponentPalette={openComponentPalette} canvasHandle={canvasHandle} />
          </div>
        </main>

        <aside
          data-testid="dock-right"
          style={{
            position: 'relative',
            borderInlineStart: '1px solid var(--ccs-border)',
            background: 'var(--ccs-bg-panel)',
            display: 'flex',
            flexDirection: 'column',
            minBlockSize: 0,
          }}
        >
          <RightHeader zoomPercent={zoomPercent} canvasHandle={canvasHandle} />
          <div style={{ flex: 1, overflow: 'auto', minBlockSize: 0 }}>
            <Inspector />
          </div>
          <ResizeHandle testId="resize-handle-right" edge="start" {...right.handleProps} />
        </aside>
      </div>

      <StatusBar />
    </div>
  );
}

/** Drag handle for `use-resize.ts` — sits on the panel's INNER edge (the
 * one facing the canvas), expressed LOGICALLY (`edge: 'start' | 'end'` ->
 * `insetInlineStart`/`insetInlineEnd`) so it mirrors correctly under
 * `dir="rtl"` (playbook §5.9, ADR-0022) rather than a hardcoded physical
 * left/right. `edge="end"` = left panel's resize edge (its logical end,
 * facing the canvas); `edge="start"` = right panel's resize edge (its
 * logical start, facing the canvas). */
function ResizeHandle({
  testId,
  edge,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  testId: string;
  edge: 'start' | 'end';
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}): React.ReactElement {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        insetBlockStart: 0,
        insetBlockEnd: 0,
        [edge === 'end' ? 'insetInlineEnd' : 'insetInlineStart']: -3,
        inlineSize: 6,
        cursor: 'col-resize',
        zIndex: 5,
        background: hover ? 'var(--ccs-accent)' : 'transparent',
        opacity: hover ? 0.5 : 1,
        touchAction: 'none',
      }}
    />
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
      <span data-testid="connection-status" data-connected={connected}>
        {connected ? 'daemon: connected' : 'daemon: offline'}
      </span>
      {selectedUid && <span style={{ fontFamily: 'var(--ccs-font-mono)' }}>selected: {selectedUid}</span>}
    </div>
  );
}
