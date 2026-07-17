import * as React from 'react';
import type { StudioCanvasHandle } from '@ccs/canvas';
import { useWorkspaceStore } from './workspace-store.js';
import { useToolActions } from './use-tool-actions.js';

/**
 * FP-3 tool keymap (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-3; Penpot
 * `../penpot/frontend/src/app/main/data/workspace/shortcuts.cljs`): V=move/
 * select, F=frame/board, T=text, I=insert-component, C=comment (stub) — the
 * same bindings `Toolbar.tsx`'s buttons trigger, routed through the SAME
 * `useToolActions` bridge so a keyboard shortcut and its toolbar button do
 * exactly the same thing (never a parallel/second implementation).
 *
 * Kept as its own hook, parallel to `use-zoom-keymap.ts` — same "stays
 * independent of the wider node-ops/undo-redo keymap" rationale that hook's
 * own doc already gives (this one needs the canvas handle + tool-action
 * bridge, not node/selection/undo state `use-workspace-keymap.ts` owns).
 *
 * Penpot's own binding for "board" is `B` (`draw-frame` is bound to both
 * `b`/`B` in its shortcuts map) — our spec (§5.8) keeps `F` only ("Frame
 * (F)"), so `B` is intentionally NOT bound here; see `Toolbar.tsx`'s label.
 * Image has no key binding (Penpot's own `insert-image` shortcut is a
 * secondary/menu action, not a bare letter either — not in this task's
 * required V/F/T/I/C set).
 */
export function useToolKeymap(canvasHandle: StudioCanvasHandle | null, onOpenComponentPalette: () => void): void {
  const actions = useToolActions(canvasHandle);
  const setTool = useWorkspaceStore((s) => s.setTool);

  React.useEffect(() => {
    function isTextEntry(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (isTextEntry(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'v':
          setTool('select');
          break;
        case 'f':
          if (!actions.canCreateFrame) return;
          setTool('frame');
          actions.createFrame();
          break;
        case 't':
          if (!actions.hasActiveFrame) return;
          setTool('text');
          actions.insertText();
          break;
        case 'i':
          setTool('insert-component');
          onOpenComponentPalette();
          break;
        case 'c':
          setTool('comment');
          break;
        default:
          return;
      }
      e.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions, setTool, onOpenComponentPalette]);
}
