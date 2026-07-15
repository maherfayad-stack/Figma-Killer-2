import { describe, expect, it, beforeEach } from 'vitest';
import { useWorkspaceStore } from './workspace-store.js';

function resetStore(): void {
  useWorkspaceStore.setState({
    fileFolder: null,
    framePath: null,
    selectedUid: null,
    expandedUids: new Set(),
    activeTool: 'select',
    clipboardUid: null,
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

  it('currentTree resolves the mock fixture matching the selected framePath', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Hero.tsx');
    const tree = useWorkspaceStore.getState().currentTree();
    expect(tree?.tag).toBe('section');
    expect(tree?.children).toHaveLength(4);
  });

  it('currentTree is null when no frame is selected or the path has no fixture', () => {
    expect(useWorkspaceStore.getState().currentTree()).toBeNull();
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Unknown.tsx');
    expect(useWorkspaceStore.getState().currentTree()).toBeNull();
  });

  it('selectedNode resolves the selected uid within the current frame tree', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Hero.tsx');
    useWorkspaceStore.getState().selectNode('src/frames/Hero.tsx:d0.0');
    expect(useWorkspaceStore.getState().selectedNode()?.tag).toBe('h1');
  });

  it('a dynamic node (Testimonials fixture) is flagged dynamic:true', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Testimonials.tsx');
    useWorkspaceStore.getState().selectNode('src/frames/Testimonials.tsx:d0.1.0');
    expect(useWorkspaceStore.getState().selectedNode()?.dynamic).toBe(true);
  });

  it('toggleExpanded adds then removes a uid from expandedUids', () => {
    useWorkspaceStore.getState().toggleExpanded('x');
    expect(useWorkspaceStore.getState().expandedUids.has('x')).toBe(true);
    useWorkspaceStore.getState().toggleExpanded('x');
    expect(useWorkspaceStore.getState().expandedUids.has('x')).toBe(false);
  });

  it('clearSelection nulls out selectedUid without touching the active frame', () => {
    useWorkspaceStore.getState().selectFrame('demo', 'src/frames/Hero.tsx');
    useWorkspaceStore.getState().selectNode('src/frames/Hero.tsx:d0.0');
    useWorkspaceStore.getState().clearSelection();
    const state = useWorkspaceStore.getState();
    expect(state.selectedUid).toBeNull();
    expect(state.framePath).toBe('src/frames/Hero.tsx');
  });
});
