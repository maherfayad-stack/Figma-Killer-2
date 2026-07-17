import * as React from 'react';
import { Button, Icon, Tooltip } from '@ccs/ui';
import type { StudioCanvasHandle } from '@ccs/canvas';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useWorkspaceStore } from './workspace-store.js';
import { ZoomWidget } from './ZoomWidget.js';

/**
 * RightHeader — the right-pane header (FP-2, `.orchestrator/
 * FEATURE-PARITY-PLAN.md` §2; spec §5.1). Structure pulled from the real
 * Penpot source:
 *   - `../penpot/frontend/src/app/main/ui/workspace/right_header.cljs`
 *     (`right-header*`): `users-section` -> `progress-widget` -> a
 *     flex-grow `.separator` -> `.zoom-section` (`zoom-widget-workspace`,
 *     our `ZoomWidget.tsx`, relocated here per this task) -> a
 *     `.comments-section` toggle button (`deprecated-icon/comments`, an
 *     unread-dot overlay) -> a `.history-section` toggle -> share/viewer
 *     links. We have no presence/progress/share/viewer concepts (no
 *     multiplayer/backend yet), so those sections are dropped; the
 *     `.separator` -> zoom -> comments shape is kept 1:1.
 *   - `right_header.scss` — 52px-tall row, `justify-content: space-between`,
 *     28px square icon buttons at `border-radius: 8px`.
 *
 * Comments (FP-5, not built yet): rendered as a VISIBLE but disabled
 * no-op placeholder per this task's brief — clearly marked, to be wired
 * when FP-5 lands (local-first comment threads).
 *
 * Undo/redo: Penpot's own right-header has no dedicated undo/redo buttons
 * (it exposes a `.history-section` toggle that opens a history PANEL
 * instead — see `deprecated-icon/history` above). This task's brief
 * explicitly asks for undo/redo buttons here, so they're added as a
 * (non-Penpot-sourced) divergence, wired to the daemon's EXISTING
 * `sendUndo`/`sendRedo` (`daemon-connection.tsx`, ADR-0018) — the same
 * calls `TopBar.tsx` used to make and `use-workspace-keymap.ts` already
 * makes for Ctrl+Z/Ctrl+Shift+Z, so this is a visible affordance for
 * already-working plumbing, not new wiring. No dedicated undo/redo icon
 * exists in the vendored Penpot set (spec §3's inventory has none either —
 * Penpot doesn't expose one as a toolbar icon), so these render as small
 * text buttons rather than inventing a new SVG glyph not sourced from
 * Penpot.
 */
export interface RightHeaderProps {
  zoomPercent: number;
  canvasHandle: StudioCanvasHandle | null;
}

export function RightHeader({ zoomPercent, canvasHandle }: RightHeaderProps): React.ReactElement {
  const { sendUndo, sendRedo } = useDaemonConnection();
  const fileFolder = useWorkspaceStore((s) => s.fileFolder);

  return (
    <header
      data-testid="right-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 'var(--ccs-space-2)',
        paddingInline: 'var(--ccs-space-3)',
        blockSize: 'var(--ccs-header-height)',
        minBlockSize: 'var(--ccs-header-height)',
        background: 'var(--ccs-bg-panel)',
        borderBlockEnd: '1px solid var(--ccs-border)',
      }}
    >
      <div style={{ flex: 1 }} aria-hidden />

      <ZoomWidget zoomPercent={zoomPercent} handle={canvasHandle} />

      <Tooltip label="Comments — coming in FP-5">
        <Button variant="icon" aria-label="Comments (coming soon)" disabled data-testid="comments-toggle">
          <Icon name="comments" size={16} />
        </Button>
      </Tooltip>

      <span style={{ display: 'inline-flex', gap: 2 }}>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          disabled={!fileFolder}
          onClick={() => fileFolder && sendUndo(fileFolder)}
          data-testid="undo-button"
        >
          Undo
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!fileFolder}
          onClick={() => fileFolder && sendRedo(fileFolder)}
          data-testid="redo-button"
        >
          Redo
        </Button>
      </span>
    </header>
  );
}
