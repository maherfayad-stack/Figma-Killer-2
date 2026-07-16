import { describe, expect, it, beforeEach } from 'vitest';
import { useWorkspaceStore } from './workspace-store.js';
import { heroTree, testimonialsTree } from '../engine/tree-fixtures.js';

/**
 * P5 RESUME item 2: `currentTree()`/`selectedNode()` now resolve against
 * LIVE `tree-snapshot` data (`trees`), populated in production via
 * `use-tree-snapshot-sync.ts` subscribing to the real daemon connection.
 * These unit tests have no daemon, so they seed `trees` directly through
 * the same `setTreeSnapshot` action the real subscriber calls — using the
 * hand-authored fixtures from `tree-fixtures.ts` (kept test-only, see that
 * file's doc) purely as convenient sample data, exactly the way a real
 * `tree-snapshot` event's payload would look.
 */
function resetStore(): void {
  useWorkspaceStore.setState({
    fileFolder: null,
    framePath: null,
    selectedUid: null,
    expandedUids: new Set(),
    activeTool: 'select',
    clipboardUid: null,
    trees: {},
  });
}

beforeEach(resetStore);

describe('useWorkspaceStore', () => {
  it('selectFrame sets fileFolder/framePath and clears any prior selection', () => {
    useWorkspaceStore.getState().selectNode('some-uid');
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Hero.tsx');
    const state = useWorkspaceStore.getState();
    expect(state.fileFolder).toBe('demo');
    expect(state.framePath).toBe('src/frames/Hero.tsx');
    expect(state.selectedUid).toBeNull();
  });

  it('setTreeSnapshot ingests a live tree-snapshot event and currentTree resolves it for the selected framePath', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Hero.tsx');
    useWorkspaceStore.getState().setTreeSnapshot('src/frames/Hero.tsx', heroTree);
    const tree = useWorkspaceStore.getState().currentTree();
    expect(tree?.tag).toBe('section');
    expect(tree?.children).toHaveLength(4);
  });

  it('currentTree is null when no frame is selected, or no tree-snapshot has arrived yet for the selected path', () => {
    expect(useWorkspaceStore.getState().currentTree()).toBeNull();
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Unknown.tsx');
    expect(useWorkspaceStore.getState().currentTree()).toBeNull();
  });

  it('selectedNode resolves the selected uid within the current live tree', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Hero.tsx');
    useWorkspaceStore.getState().setTreeSnapshot('src/frames/Hero.tsx', heroTree);
    useWorkspaceStore.getState().selectNode('src/frames/Hero.tsx:d0.0');
    expect(useWorkspaceStore.getState().selectedNode()?.tag).toBe('h1');
  });

  it('a dynamic node (Testimonials fixture) is flagged dynamic:true', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Testimonials.tsx');
    useWorkspaceStore.getState().setTreeSnapshot('src/frames/Testimonials.tsx', testimonialsTree);
    useWorkspaceStore.getState().selectNode('src/frames/Testimonials.tsx:d0.1.0');
    expect(useWorkspaceStore.getState().selectedNode()?.dynamic).toBe(true);
  });

  it('a later tree-snapshot for the same framePath replaces the earlier one (live update, not a one-shot fixture)', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Hero.tsx');
    useWorkspaceStore.getState().setTreeSnapshot('src/frames/Hero.tsx', heroTree);
    expect(useWorkspaceStore.getState().currentTree()?.children).toHaveLength(4);

    const editedTree = { ...heroTree, children: heroTree.children.slice(0, 2) };
    useWorkspaceStore.getState().setTreeSnapshot('src/frames/Hero.tsx', editedTree);
    expect(useWorkspaceStore.getState().currentTree()?.children).toHaveLength(2);
  });

  it('toggleExpanded adds then removes a uid from expandedUids', () => {
    useWorkspaceStore.getState().toggleExpanded('x');
    expect(useWorkspaceStore.getState().expandedUids.has('x')).toBe(true);
    useWorkspaceStore.getState().toggleExpanded('x');
    expect(useWorkspaceStore.getState().expandedUids.has('x')).toBe(false);
  });

  it('clearSelection nulls out selectedUid without touching the active frame', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Hero.tsx');
    useWorkspaceStore.getState().setTreeSnapshot('src/frames/Hero.tsx', heroTree);
    useWorkspaceStore.getState().selectNode('src/frames/Hero.tsx:d0.0');
    useWorkspaceStore.getState().clearSelection();
    const state = useWorkspaceStore.getState();
    expect(state.selectedUid).toBeNull();
    expect(state.framePath).toBe('src/frames/Hero.tsx');
  });
});
