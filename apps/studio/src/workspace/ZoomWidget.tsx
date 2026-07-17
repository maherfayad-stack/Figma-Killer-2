import * as React from 'react';
import { Button, Icon, MenuList, type MenuItemSpec } from '@ccs/ui';
import type { StudioCanvasHandle } from '@ccs/canvas';

/**
 * ZoomWidget — the Penpot-fidelity zoom control (`.orchestrator/
 * FEATURE-PARITY-PLAN.md` §2 FP-1 item 2). Structure, item ordering, and
 * labels are pulled directly from the real Penpot source (studied per
 * orchestrator directive, not just the spec):
 *   - `../penpot/frontend/src/app/main/ui/workspace/right_header.cljs`
 *     (`zoom-widget-workspace`) — the trigger (`%` readout) + dropdown
 *     shape: a top row with [zoom-out icon][live % text][zoom-in icon] on
 *     one side and a "Reset" button on the other, then two plain menu rows
 *     ("Zoom to fit all" / "Zoom to selected") each showing their shortcut.
 *   - `right_header.scss` — proportions this mirrors: 48px-ish trigger,
 *     28px row height, 8px radius, a ~240–272px dropdown.
 *   - `../penpot/frontend/translations/en.po` — exact English strings used
 *     below (`shortcuts.increase-zoom`="Zoom in", `shortcuts.decrease-zoom`
 *     ="Zoom out", `workspace.header.reset-zoom`="Reset",
 *     `workspace.header.zoom-fit-all`="Zoom to fit all",
 *     `workspace.header.zoom-selected`="Zoom to selected").
 *   - `../penpot/frontend/src/app/main/data/workspace/shortcuts.cljs` — the
 *     shortcut labels shown (`Shift 0` / `Shift 1` / `Shift 2`; see
 *     `use-zoom-keymap.ts` for the matching keydown wiring).
 *
 * FP-2 will relocate this into the (not-yet-built) right-pane header per
 * the plan; for FP-1 it's a floating overlay in the top-end corner of the
 * canvas area (see `WorkspaceShell.tsx` — bottom-end was tried first but
 * collides with tldraw's own unlicensed-build watermark badge, which
 * intercepts pointer events there) and opens DOWNWARD, matching Penpot's
 * own top-anchored, downward-opening dropdown exactly.
 */
export interface ZoomWidgetProps {
  /** Live zoom level as a rounded percentage (100 = 100%) — see
   * `StudioCanvasProps.onZoomChange`. */
  zoomPercent: number;
  /** `null` until `StudioCanvas`'s `onReady` fires (see `WorkspaceShell.tsx`)
   * — every action is a no-op while `null` (nothing to do before the canvas
   * has mounted). */
  handle: StudioCanvasHandle | null;
}

export function ZoomWidget({ zoomPercent, handle }: ZoomWidgetProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const label = `${zoomPercent}%`;

  React.useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const fitItems: MenuItemSpec[] = [
    { id: 'zoom-fit-all', label: 'Zoom to fit all', shortcut: 'Shift 1', onSelect: () => handle?.zoomToFit() },
    { id: 'zoom-selected', label: 'Zoom to selected', shortcut: 'Shift 2', onSelect: () => handle?.zoomToSelection() },
  ];

  return (
    <div ref={rootRef} data-testid="zoom-widget" style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label="Zoom"
        aria-expanded={open}
        title="Zoom"
        onClick={() => setOpen((o) => !o)}
        style={{
          all: 'unset',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minInlineSize: 48,
          blockSize: 28,
          paddingInline: 8,
          borderRadius: 'var(--ccs-radius)',
          border: '1px solid var(--ccs-border)',
          background: open ? 'var(--ccs-bg-hover)' : 'var(--ccs-bg-panel-raised)',
          color: open ? 'var(--ccs-text)' : 'var(--ccs-text-muted)',
          fontSize: 'var(--ccs-font-size-sm)',
          cursor: 'pointer',
          boxShadow: 'var(--ccs-shadow-panel)',
        }}
      >
        {label}
      </button>

      {open && (
        <div
          role="group"
          aria-label="Zoom options"
          style={{
            position: 'absolute',
            insetBlockStart: '100%',
            insetInlineEnd: 0,
            marginBlockStart: 4,
            zIndex: 1000,
            inlineSize: 240,
            background: 'var(--ccs-bg-overlay)',
            border: '1px solid var(--ccs-border-strong)',
            borderRadius: 'var(--ccs-radius-md)',
            boxShadow: 'var(--ccs-shadow-overlay)',
            padding: 4,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingInline: 6, paddingBlock: 6 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Button variant="icon" size="sm" aria-label="Zoom out" title="Zoom out (-)" onClick={() => handle?.zoomOut()} style={{ paddingInline: 4 }}>
                <Icon name="remove" size={12} />
              </Button>
              <span
                style={{
                  minInlineSize: 40,
                  textAlign: 'center',
                  fontSize: 'var(--ccs-font-size-sm)',
                  color: 'var(--ccs-text)',
                }}
              >
                {label}
              </span>
              <Button variant="icon" size="sm" aria-label="Zoom in" title="Zoom in (+)" onClick={() => handle?.zoomIn()} style={{ paddingInline: 4 }}>
                <Icon name="add" size={12} />
              </Button>
            </span>
            <button
              type="button"
              onClick={() => handle?.resetZoom()}
              style={{
                all: 'unset',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                paddingInline: 8,
                paddingBlock: 4,
                borderRadius: 'var(--ccs-radius-sm)',
                fontSize: 'var(--ccs-font-size-xs)',
                color: 'var(--ccs-text-muted)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--ccs-text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--ccs-text-muted)';
              }}
            >
              Reset <span style={{ opacity: 0.6 }}>Shift 0</span>
            </button>
          </div>
          <div role="separator" style={{ blockSize: 1, background: 'var(--ccs-border)', marginBlock: 4 }} />
          <MenuList items={fitItems} onClose={() => setOpen(false)} autoFocus={false} />
        </div>
      )}
    </div>
  );
}
