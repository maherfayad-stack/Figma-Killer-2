import * as React from 'react';
import { Button, DropdownMenu } from '@ccs/ui';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useWorkspaceStore } from './workspace-store.js';

/**
 * TopBar (playbook §2.1 `left_header.cljs` + `right_header.cljs` +
 * `main_menu.cljs`, collapsed into one row for this phase's scope). Left:
 * file name + main menu. Right: connection status + undo/redo (ADR-0018
 * daemon undo/redo control requests) + a "Back to dashboard" exit.
 */
export interface TopBarProps {
  fileName: string;
  onBackToDashboard: () => void;
}

export function TopBar({ fileName, onBackToDashboard }: TopBarProps): React.ReactElement {
  const { connected, sendUndo, sendRedo } = useDaemonConnection();
  const fileFolder = useWorkspaceStore((s) => s.fileFolder);

  return (
    <div
      data-testid="topbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingInline: 12,
        blockSize: 'var(--ccs-topbar-height)',
        background: 'var(--ccs-bg-panel)',
        borderBlockEnd: '1px solid var(--ccs-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <DropdownMenu
          trigger={(p) => (
            <Button variant="ghost" onClick={p.onClick} aria-expanded={p['aria-expanded']}>
              File
            </Button>
          )}
          items={[
            { id: 'dashboard', label: 'Back to dashboard', onSelect: onBackToDashboard },
            { id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z', onSelect: () => fileFolder && sendUndo(fileFolder) },
            {
              id: 'redo',
              label: 'Redo',
              shortcut: 'Ctrl+Shift+Z',
              onSelect: () => fileFolder && sendRedo(fileFolder),
            },
          ]}
        />
        <strong style={{ fontSize: 'var(--ccs-font-size-md)' }}>{fileName}</strong>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          data-testid="connection-status"
          data-connected={connected}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--ccs-font-size-xs)',
            color: connected ? 'var(--ccs-success)' : 'var(--ccs-text-subtle)',
          }}
        >
          <span
            aria-hidden
            style={{
              inlineSize: 8,
              blockSize: 8,
              borderRadius: '50%',
              background: connected ? 'var(--ccs-success)' : 'var(--ccs-text-subtle)',
            }}
          />
          {connected ? 'Connected' : 'Connecting…'}
        </span>
      </div>
    </div>
  );
}
