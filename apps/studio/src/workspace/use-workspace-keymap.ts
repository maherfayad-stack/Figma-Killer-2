import * as React from 'react';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useWorkspaceStore } from './workspace-store.js';
import { useNodeOps } from './use-node-ops.js';

/**
 * Global keyboard map (playbook §2.1 `shortcuts.cljs`: "Figma-like
 * bindings"). Skips when focus is inside a text-entry control so typing in
 * an Inspector field doesn't accidentally delete the selected layer.
 */
export function useWorkspaceKeymap(): void {
  const nodeOps = useNodeOps();
  const selectedNode = useWorkspaceStore((s) => s.selectedNode);
  const clearSelection = useWorkspaceStore((s) => s.clearSelection);
  const fileFolder = useWorkspaceStore((s) => s.fileFolder);
  const { sendUndo, sendRedo } = useDaemonConnection();

  React.useEffect(() => {
    function isTextEntry(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (isTextEntry(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        clearSelection();
        return;
      }

      const node = selectedNode();
      if ((e.key === 'Delete' || e.key === 'Backspace') && node) {
        e.preventDefault();
        nodeOps.remove(node);
        return;
      }

      if (mod && e.key.toLowerCase() === 'd' && node) {
        e.preventDefault();
        nodeOps.duplicate(node);
        return;
      }

      if (mod && e.key.toLowerCase() === 'c' && node) {
        nodeOps.copy(node);
        return;
      }

      if (mod && e.key.toLowerCase() === 'v' && node) {
        nodeOps.paste(node);
        return;
      }

      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && fileFolder) {
        e.preventDefault();
        sendUndo(fileFolder);
        return;
      }

      if (mod && e.shiftKey && e.key.toLowerCase() === 'z' && fileFolder) {
        e.preventDefault();
        sendRedo(fileFolder);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nodeOps, selectedNode, clearSelection, fileFolder, sendUndo, sendRedo]);
}
