import { create } from 'zustand';
import type { TreeNode } from '@ccs/protocol';
import { MOCK_FRAME_TREES, findNodeByUid } from '../engine/tree-fixtures.js';

/**
 * Chrome-local UI state (playbook §5.1 One Rule: purely ephemeral, never
 * persisted to `.studio/canvas.json` or anywhere on disk — a reload starts
 * fresh, same discipline as `@ccs/canvas`'s `selection-store.ts`).
 *
 * Selection here is driven by the LAYERS PANEL (clicking a tree row), not
 * by a real canvas click — see `ws-ops-client.ts`'s module doc for why:
 * `@ccs/canvas` doesn't export its click-to-select overlay state, and the
 * daemon doesn't emit real `tree-snapshot`s yet (`tree-fixtures.ts`'s doc).
 * This is legitimate Penpot UX too (its own layers panel selection drives
 * the same inspector canvas-click does) — just not YET synchronized with
 * the canvas's own overlay, which is the CR this phase reports upstream.
 */

export type ToolId = 'select' | 'frame' | 'insert-component' | 'text' | 'image' | 'comment';

export interface WorkspaceSelectionState {
  fileFolder: string | null;
  framePath: string | null;
  selectedUid: string | null;
  expandedUids: Set<string>;
  activeTool: ToolId;
  clipboardUid: string | null;

  selectFrame: (fileFolder: string, framePath: string) => void;
  selectNode: (uid: string) => void;
  clearSelection: () => void;
  toggleExpanded: (uid: string) => void;
  setTool: (tool: ToolId) => void;
  setClipboard: (uid: string | null) => void;
  /** Resolves the currently selected node against the mock tree fixtures
   * (see `tree-fixtures.ts` CR doc) — the one place UI code should reach
   * for "what is selected right now", so a future real-tree-snapshot swap
   * only touches this one function. */
  selectedNode: () => TreeNode | null;
  currentTree: () => TreeNode | null;
}

export const useWorkspaceStore = create<WorkspaceSelectionState>((set, get) => ({
  fileFolder: null,
  framePath: null,
  selectedUid: null,
  expandedUids: new Set(),
  activeTool: 'select',
  clipboardUid: null,

  selectFrame(fileFolder, framePath) {
    set({ fileFolder, framePath, selectedUid: null });
  },
  selectNode(uid) {
    set({ selectedUid: uid });
  },
  clearSelection() {
    set({ selectedUid: null });
  },
  toggleExpanded(uid) {
    set((state) => {
      const next = new Set(state.expandedUids);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return { expandedUids: next };
    });
  },
  setTool(tool) {
    set({ activeTool: tool });
  },
  setClipboard(uid) {
    set({ clipboardUid: uid });
  },
  currentTree() {
    const { framePath } = get();
    if (!framePath) return null;
    const fixture = MOCK_FRAME_TREES.find((f) => f.framePath === framePath);
    return fixture?.tree ?? null;
  },
  selectedNode() {
    const { selectedUid } = get();
    const tree = get().currentTree();
    if (!selectedUid || !tree) return null;
    return findNodeByUid(tree, selectedUid);
  },
}));
