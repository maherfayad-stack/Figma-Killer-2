import * as React from 'react';
import { Panel } from '@ccs/ui';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useWorkspaceStore } from './workspace-store.js';

/**
 * PagesPanel (playbook §2.2 `sitemap.cljs`: "lists frames = files in
 * `src/frames/`"). Backed by `DaemonConnectionProvider`'s best-effort frame
 * tracker (see that module's CR doc) rather than `@ccs/canvas`'s internal
 * `CanvasFrameRecord[]` state, which isn't exported.
 */
export function PagesPanel(): React.ReactElement {
  const { frames, connected } = useDaemonConnection();
  const framePath = useWorkspaceStore((s) => s.framePath);
  const selectFrame = useWorkspaceStore((s) => s.selectFrame);

  return (
    <Panel title="Pages" id="pages">
      {!connected && (
        <p style={{ color: 'var(--ccs-text-subtle)', fontSize: 'var(--ccs-font-size-sm)' }}>Connecting to daemon…</p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {frames.map((frame) => {
          const selected = frame.framePath === framePath;
          return (
            <li key={`${frame.fileFolder}:${frame.framePath}`}>
              <button
                type="button"
                onClick={() => selectFrame(frame.fileFolder, frame.framePath)}
                aria-current={selected}
                style={{
                  all: 'unset',
                  display: 'block',
                  inlineSize: '100%',
                  cursor: 'pointer',
                  paddingInline: 8,
                  paddingBlock: 5,
                  borderRadius: 'var(--ccs-radius-sm)',
                  fontSize: 'var(--ccs-font-size-sm)',
                  background: selected ? 'var(--ccs-bg-selected)' : 'transparent',
                  color: selected ? 'var(--ccs-text)' : 'var(--ccs-text-muted)',
                }}
              >
                {frame.name}
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
