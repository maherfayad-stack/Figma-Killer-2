import { create } from 'zustand';
import type { TreeNode } from '@ccs/protocol';
import { findNodeByUid } from '../engine/tree-fixtures.js';

/**
 * Chrome-local UI state (playbook §5.1 One Rule: purely ephemeral, never
 * persisted to `.studio/canvas.json` or anywhere on disk — a reload starts
 * fresh, same discipline as `@ccs/canvas`'s `selection-store.ts`).
 *
 * Selection here is driven by the LAYERS PANEL (clicking a tree row), not
 * by a real canvas click — see `ws-ops-client.ts`'s module doc for why:
 * `@ccs/canvas` doesn't export its click-to-select overlay state. This is
 * legitimate Penpot UX too (its own layers panel selection drives the same
 * inspector canvas-click does) — just not synchronized with the canvas's
 * own overlay, which is the CR this phase reports upstream.
 *
 * P5 RESUME (STATE.md "P5 RESUME HERE" item 2): `trees` is now populated
 * from LIVE `tree-snapshot` `DaemonEvent`s (`packages/sync-daemon`'s
 * `tree-snapshot.ts`), not the hand-authored `tree-fixtures.ts` mock — see
 * `use-tree-snapshot-sync.ts` for the wiring (daemon-connection's
 * `onEvent` -> `setTreeSnapshot`). `tree-fixtures.ts`'s `MOCK_FRAME_TREES`
 * is kept ONLY for unit tests (`workspace-store.test.ts` seeds `trees`
 * directly via `setTreeSnapshot` instead of relying on an automatic
 * fixture lookup) — production code never imports it anymore.
 */

export type ToolId = 'select' | 'frame' | 'insert-component' | 'text' | 'image' | 'comment';

export interface WorkspaceSelectionState {
  fileFolder: string | null;
  framePath: string | null;
  selectedUid: string | null;
  expandedUids: Set<string>;
  activeTool: ToolId;
  clipboardUid: string | null;
  /** Live tree-snapshots, keyed by file-folder-relative framePath (matches
   * `TreeSnapshotEvent.file` — `packages/sync-daemon/src/paths.ts`
   * `toFileFolderRelative`'s doc explains why that event follows the same
   * convention `framePath` already does, rather than the daemon's usual
   * project-relative wire convention). Replaces the P5-WIP mock fixture
   * lookup. */
  trees: Record<string, TreeNode>;
  /** FIX 5 (human dogfood: "when I click the icon in the side pane of any
   * layer I want it to get me directly to that element in the canvas" —
   * Penpot `layers.cljs`/`layer_item.cljs` parity). Bumped by a Layers-
   * panel row's TYPE-ICON click (distinct from a plain row click, which
   * only selects via `selectNode` below) — `WorkspaceShell.tsx`'s studio->
   * canvas sync effect watches this and calls
   * `StudioCanvasHandle.zoomToNode` instead of `.selectNode` for exactly
   * one render when it changes. A monotonic `seq` (not a boolean) so
   * re-clicking the SAME element's icon twice in a row still re-triggers
   * the zoom — a boolean flipping true->true wouldn't register as a
   * change. */
  zoomToNodeRequest: { uid: string; seq: number } | null;
  /** The BOARD-row equivalent of `zoomToNodeRequest` — a Layers-panel
   * board row's icon click. */
  zoomToFrameRequest: { fileFolder: string; framePath: string; seq: number } | null;

  selectFrame: (fileFolder: string, framePath: string) => void;
  selectNode: (uid: string) => void;
  /** FIX 5: records a request to zoom the canvas to `uid` — see
   * `zoomToNodeRequest`'s own doc. Callers combine this with `selectFrame`/
   * `selectNode` (a row's icon click means BOTH "select this" and "zoom to
   * this"). */
  zoomToNode: (uid: string) => void;
  /** FIX 5: the board-row equivalent of `zoomToNode` — see
   * `zoomToFrameRequest`'s own doc. */
  zoomToFrame: (fileFolder: string, framePath: string) => void;
  clearSelection: () => void;
  toggleExpanded: (uid: string) => void;
  setTool: (tool: ToolId) => void;
  setClipboard: (uid: string | null) => void;
  /** Ingests one live `tree-snapshot` `DaemonEvent` (wired by
   * `use-tree-snapshot-sync.ts`); also the seam unit tests use to inject a
   * fixture tree instead of a real daemon connection. */
  setTreeSnapshot: (file: string, tree: TreeNode) => void;
  /** Resolves the currently selected node against the live tree — the one
   * place UI code should reach for "what is selected right now". */
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
  trees: {},
  zoomToNodeRequest: null,
  zoomToFrameRequest: null,

  selectFrame(fileFolder, framePath) {
    set({ fileFolder, framePath, selectedUid: null });
  },
  selectNode(uid) {
    set({ selectedUid: uid });
  },
  zoomToNode(uid) {
    set((state) => ({ zoomToNodeRequest: { uid, seq: (state.zoomToNodeRequest?.seq ?? 0) + 1 } }));
  },
  zoomToFrame(fileFolder, framePath) {
    set((state) => ({
      zoomToFrameRequest: { fileFolder, framePath, seq: (state.zoomToFrameRequest?.seq ?? 0) + 1 },
    }));
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
  setTreeSnapshot(file, tree) {
    set((state) => ({ trees: { ...state.trees, [file]: tree } }));
  },
  currentTree() {
    const { framePath, trees } = get();
    if (!framePath) return null;
    return trees[framePath] ?? null;
  },
  selectedNode() {
    const { selectedUid } = get();
    const tree = get().currentTree();
    if (!selectedUid || !tree) return null;
    return findNodeByUid(tree, selectedUid);
  },
}));
