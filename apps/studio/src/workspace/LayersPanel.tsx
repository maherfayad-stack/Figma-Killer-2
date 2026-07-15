import * as React from 'react';
import type { TreeNode } from '@ccs/protocol';
import { Panel, Tree, flattenTree, ContextMenu, type MenuItemSpec } from '@ccs/ui';
import { useWorkspaceStore } from './workspace-store.js';
import { useNodeOps } from './use-node-ops.js';

/**
 * LayersPanel (playbook §2.2 `layers.cljs`/`layer_item.cljs`): a
 * virtualized, DERIVED view of the AST tree (playbook §5 pitfall #4: "layers
 * tree = derived view of the AST, NEVER a store") — it reads
 * `workspace-store`'s `currentTree()`, which resolves against the mock
 * `tree-snapshot` fixtures (daemon gap, see `tree-fixtures.ts`). Nothing
 * about a layer's identity is stored here; the tree is recomputed from the
 * source of truth (mock today, real `tree-snapshot` events at integration)
 * on every render.
 *
 * Lock/hide are STUDIO-ONLY visual aids (playbook: "stored in canvas.json")
 * — modeled here as local component state (`hiddenUids`/`lockedUids`) since
 * writing them into `.studio/canvas.json` requires a daemon API this phase
 * doesn't add (CR, same daemon-gap family as tree-snapshot); the toggle UX
 * itself is real and wired for that swap-in.
 */
export function LayersPanel(): React.ReactElement {
  const framePath = useWorkspaceStore((s) => s.framePath);
  const selectedUid = useWorkspaceStore((s) => s.selectedUid);
  const expandedUids = useWorkspaceStore((s) => s.expandedUids);
  const selectNode = useWorkspaceStore((s) => s.selectNode);
  const toggleExpanded = useWorkspaceStore((s) => s.toggleExpanded);
  const currentTree = useWorkspaceStore((s) => s.currentTree);
  const [hiddenUids, setHiddenUids] = React.useState<Set<string>>(new Set());
  const [lockedUids, setLockedUids] = React.useState<Set<string>>(new Set());
  const nodeOps = useNodeOps();

  const tree = currentTree();

  if (!framePath || !tree) {
    return (
      <Panel title="Layers" id="layers">
        <p style={{ color: 'var(--ccs-text-subtle)', fontSize: 'var(--ccs-font-size-sm)' }}>
          Select a frame in Pages to see its layers.
        </p>
      </Panel>
    );
  }

  // Flatten the FRAME's children, not `[tree]` itself: Penpot's layers panel
  // lists the shapes inside a page/frame, not the frame as a layer of
  // itself (the frame is already represented by the Pages tab). Rendering
  // `tree` as its own collapsed treeitem meant every frame's top-level
  // elements were hidden behind an extra, redundant expand click — fixed
  // here (found via this phase's own e2e acceptance run, test (b)).
  const rows = flattenTree<TreeNode>(
    tree.children,
    (n) => n.uid,
    (n) => n.children,
    expandedUids,
  );

  function contextItemsFor(node: TreeNode): MenuItemSpec[] {
    return [
      { id: 'copy', label: 'Copy', onSelect: () => nodeOps.copy(node), disabled: node.dynamic },
      { id: 'paste', label: 'Paste', onSelect: () => nodeOps.paste(node), disabled: node.dynamic },
      { id: 'duplicate', label: 'Duplicate', onSelect: () => nodeOps.duplicate(node), disabled: node.dynamic },
      {
        id: 'wrap',
        label: 'Wrap in container',
        onSelect: () => nodeOps.wrapInContainer(node),
        disabled: node.dynamic,
      },
      { id: 'delete', label: 'Delete', onSelect: () => nodeOps.remove(node), danger: true, disabled: node.dynamic, separatorBefore: true },
      {
        id: 'open-ide',
        label: 'Open in IDE',
        onSelect: () => nodeOps.openInIde(node),
        separatorBefore: true,
      },
    ];
  }

  return (
    <Panel title="Layers" id="layers">
      <div style={{ blockSize: 320 }}>
        <Tree<TreeNode>
          rows={rows}
          ariaLabel="Layers"
          selectedId={selectedUid}
          expandedIds={expandedUids}
          onToggleExpand={toggleExpanded}
          onSelect={selectNode}
          onReorder={(draggedId, targetId) => nodeOps.reorder(draggedId, targetId)}
          renderRow={(row) => {
            const node = row.data;
            const hidden = hiddenUids.has(node.uid);
            const locked = lockedUids.has(node.uid);
            return (
              <ContextMenu items={() => contextItemsFor(node)}>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flex: 1,
                    minInlineSize: 0,
                    opacity: hidden ? 0.4 : 1,
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: node.kind === 'component-instance' ? 'var(--ccs-text-accent)' : 'var(--ccs-text)',
                    }}
                  >
                    {node.component ?? node.tag ?? '(text)'}
                  </span>
                  {node.dynamic && (
                    <span
                      title="Dynamic — generated in code (.map()/conditional). Edit in code."
                      data-testid="dynamic-badge"
                      style={{
                        fontSize: 'var(--ccs-font-size-xs)',
                        color: 'var(--ccs-locked)',
                        border: '1px solid var(--ccs-locked)',
                        borderRadius: 3,
                        paddingInline: 4,
                        lineHeight: 1.4,
                      }}
                    >
                      dynamic
                    </span>
                  )}
                  <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 2 }}>
                    <button
                      type="button"
                      aria-label={locked ? 'Unlock layer' : 'Lock layer'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLockedUids((prev) => {
                          const next = new Set(prev);
                          if (next.has(node.uid)) next.delete(node.uid);
                          else next.add(node.uid);
                          return next;
                        });
                      }}
                      style={{ all: 'unset', cursor: 'pointer', color: 'var(--ccs-text-subtle)', fontSize: 11 }}
                    >
                      {locked ? '🔒' : '🔓'}
                    </button>
                    <button
                      type="button"
                      aria-label={hidden ? 'Show layer' : 'Hide layer'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setHiddenUids((prev) => {
                          const next = new Set(prev);
                          if (next.has(node.uid)) next.delete(node.uid);
                          else next.add(node.uid);
                          return next;
                        });
                      }}
                      style={{ all: 'unset', cursor: 'pointer', color: 'var(--ccs-text-subtle)', fontSize: 11 }}
                    >
                      {hidden ? '🙈' : '👁'}
                    </button>
                  </span>
                </span>
              </ContextMenu>
            );
          }}
        />
      </div>
    </Panel>
  );
}
