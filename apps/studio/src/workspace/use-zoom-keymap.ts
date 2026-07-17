import * as React from 'react';
import type { StudioCanvasHandle } from '@ccs/canvas';

/**
 * FP-1 zoom keyboard map (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 item 3).
 * Bindings match Penpot's own zoom-workspace shortcuts exactly (`../penpot/
 * frontend/src/app/main/data/workspace/shortcuts.cljs`, `ZOOM-WORKSPACE`
 * section): `increase-zoom` = `["+" "="]`, `decrease-zoom` = `["-" "_"]`,
 * `reset-zoom` = `["shift+0" "shift+num0"]`, `fit-all` = `["shift+1"
 * "shift+num1"]`, `zoom-selected` = `["shift+2" "shift+num2"]`.
 *
 * A separate hook from `useWorkspaceKeymap` (node ops/undo/redo/delete) —
 * this one only needs the canvas's camera handle (see `StudioCanvasHandle`),
 * not node/selection state, so it stays independent rather than growing
 * that hook's already-wide dependency list.
 *
 * The shift+digit bindings match on `event.code` (`Digit0`/`Numpad0`, etc.),
 * not `event.key` — on a US keyboard layout `shift+1` reports `key: "!"`,
 * not `"1"`, but `code` stays `"Digit1"` regardless of the shift state, so
 * matching by code is what actually makes "Shift+1" reliable. `+`/`-` match
 * by `key` instead (mirroring Penpot's own `["+" "="]`/`["-" "_"]` command
 * arrays), since those are already the literal characters produced by the
 * physical key with/without shift on a standard layout.
 */
export function useZoomKeymap(handle: StudioCanvasHandle | null): void {
  React.useEffect(() => {
    if (!handle) return;
    // Local const so `onKeyDown` below closes over an already-narrowed
    // (non-null) binding — TS doesn't retain the early-return narrowing of
    // the outer `handle` param across a nested function declaration.
    const canvas = handle;

    function isTextEntry(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (isTextEntry(e.target)) return;
      // Leave Ctrl/Cmd/Alt-held combinations alone — those are browser/OS
      // zoom shortcuts (e.g. Ctrl+=/Ctrl+- native page zoom), not ours.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.shiftKey && (e.code === 'Digit0' || e.code === 'Numpad0')) {
        e.preventDefault();
        canvas.resetZoom();
        return;
      }
      if (e.shiftKey && (e.code === 'Digit1' || e.code === 'Numpad1')) {
        e.preventDefault();
        canvas.zoomToFit();
        return;
      }
      if (e.shiftKey && (e.code === 'Digit2' || e.code === 'Numpad2')) {
        e.preventDefault();
        canvas.zoomToSelection();
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        canvas.zoomIn();
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        canvas.zoomOut();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handle]);
}
