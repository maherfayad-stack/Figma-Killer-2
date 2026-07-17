import * as React from 'react';
import type { TreeNode } from '@ccs/protocol';
import { Tree, flattenTree, ContextMenu, Icon, type MenuItemSpec, type IconName } from '@ccs/ui';
import { useDaemonConnection, type FrameSummary } from '../engine/daemon-connection.js';
import { useWorkspaceStore } from './workspace-store.js';
import { useNodeOps } from './use-node-ops.js';
import { PagesSection } from './PagesPanel.js';

/**
 * LayersPanel — the combined "Layers" tab content (spec §5.2/§5.4,
 * ADR-0024 D3): `PagesSection` (the one-page sitemap strip) stacked over
 * the LAYERS TREE, which is now BOARDS (real frame files, from
 * `useDaemonConnection().frames`) as top-level rows, each expandable to its
 * own AST element subtree.
 *
 * A row is either a BOARD (`{ kind: 'board', frame }`) or an AST ELEMENT
 * (`{ kind: 'element', node, frame }` — `frame` is carried along so an
 * element row always knows which board it belongs to, needed to make that
 * board "current" — `selectFrame` — before acting on one of its nodes; see
 * `onSelect` below). This is a DERIVED view (playbook §5 pitfall #4: "layers
 * tree = derived view of the AST, never a store") built fresh every render
 * from `workspace-store`'s live `trees` map — which already tracks a
 * snapshot per framePath for EVERY frame (not just the selected one; the
 * daemon broadcasts an initial `tree-snapshot` for every frame at boot, see
 * `use-tree-snapshot-sync.ts`), so no store changes were needed to source
 * multiple boards' trees at once.
 */
export function LayersPanel(): React.ReactElement {
  const { frames, connected } = useDaemonConnection();
  const framePath = useWorkspaceStore((s) => s.framePath);
  const selectedUid = useWorkspaceStore((s) => s.selectedUid);
  const expandedUids = useWorkspaceStore((s) => s.expandedUids);
  const selectFrame = useWorkspaceStore((s) => s.selectFrame);
  const selectNode = useWorkspaceStore((s) => s.selectNode);
  const zoomToNode = useWorkspaceStore((s) => s.zoomToNode);
  const zoomToFrame = useWorkspaceStore((s) => s.zoomToFrame);
  const toggleExpanded = useWorkspaceStore((s) => s.toggleExpanded);
  // NOTE (same pitfall `Inspector.tsx`/this file's own prior version
  // documents for `currentTree()`/`selectedNode()`): subscribe to the
  // `trees` FIELD directly, not a computed function — `trees` is a plain
  // piece of state whose reference already changes on every
  // `setTreeSnapshot` call, so this re-renders live as every board's
  // snapshot arrives/updates. (`currentTree()` wouldn't help here anyway:
  // it only resolves the ONE currently-selected frame's tree, but this
  // panel needs ALL frames' trees at once — every board is a top-level
  // row, expanded or not.)
  const trees = useWorkspaceStore((s) => s.trees);
  const [hiddenIds, setHiddenIds] = React.useState<Set<string>>(new Set());
  const [lockedIds, setLockedIds] = React.useState<Set<string>>(new Set());
  const nodeOps = useNodeOps();

  const roots: LayerRow[] = frames.map((frame) => ({ kind: 'board', frame }));
  const rows = flattenTree<LayerRow>(roots, rowId, (row) => rowChildren(row, trees), expandedUids);
  const rowById = new Map(rows.map((r) => [r.id, r.data]));
  const selectedRowId = selectedUid ?? framePath ?? null;

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
    <div style={{ display: 'flex', flexDirection: 'column', blockSize: '100%', minBlockSize: 0 }}>
      <div style={{ flexShrink: 0 }}>
        <PagesSection />
      </div>
      <div
        style={{
          flex: 1,
          minBlockSize: 0,
          display: 'flex',
          flexDirection: 'column',
          borderBlockStart: '1px solid var(--ccs-border)',
        }}
      >
        {frames.length === 0 ? (
          <p style={{ color: 'var(--ccs-text-subtle)', fontSize: 'var(--ccs-font-size-sm)', paddingInline: 'var(--ccs-space-3)', paddingBlockStart: 'var(--ccs-space-3)' }}>
            {connected ? 'No boards yet.' : 'Connecting to daemon…'}
          </p>
        ) : (
          <Tree<LayerRow>
            rows={rows}
            ariaLabel="Layers"
            selectedId={selectedRowId}
            expandedIds={expandedUids}
            rowHeight={32} /* --ccs-row-height */
            onToggleExpand={toggleExpanded}
            onSelect={(id) => {
              const row = rowById.get(id);
              if (!row) return;
              selectFrame(row.frame.fileFolder, row.frame.framePath);
              if (row.kind === 'element') selectNode(row.node.uid);
            }}
            onReorder={(draggedId, targetId) => {
              const dragged = rowById.get(draggedId);
              const target = rowById.get(targetId);
              if (dragged?.kind !== 'element' || target?.kind !== 'element') return;
              nodeOps.reorder(draggedId, targetId);
            }}
            renderRow={(row, { selected }) => {
              if (row.data.kind === 'board') {
                const frame = row.data.frame;
                return (
                  <BoardRow
                    frame={frame}
                    selected={selected}
                    hidden={hiddenIds.has(row.id)}
                    locked={lockedIds.has(row.id)}
                    onToggleHidden={() => toggleInSet(setHiddenIds, row.id)}
                    onToggleLocked={() => toggleInSet(setLockedIds, row.id)}
                    onZoomToNode={() => {
                      // FIX 5 (board-row icon): select AND navigate the
                      // canvas to this board's own bounds — the board-row
                      // equivalent of an element row's icon click below.
                      selectFrame(frame.fileFolder, frame.framePath);
                      zoomToFrame(frame.fileFolder, frame.framePath);
                    }}
                  />
                );
              }
              const node = row.data.node;
              const frame = row.data.frame;
              return (
                <ContextMenu items={() => contextItemsFor(node)}>
                  <ElementRow
                    node={node}
                    selected={selected}
                    hidden={hiddenIds.has(node.uid)}
                    locked={lockedIds.has(node.uid)}
                    onToggleHidden={() => toggleInSet(setHiddenIds, node.uid)}
                    onToggleLocked={() => toggleInSet(setLockedIds, node.uid)}
                    onZoomToNode={() => {
                      // FIX 5 (human dogfood): clicking the layer's TYPE
                      // ICON is a distinct "zoom to this element" affordance
                      // (Penpot `layers.cljs`/`layer_item.cljs` parity) —
                      // select the owning board + this node (same as a
                      // plain row click would) AND additionally request the
                      // canvas navigate/frame the element in view. A plain
                      // click anywhere ELSE on the row (handled by `Tree`'s
                      // own `onSelect` above) still only selects.
                      selectFrame(frame.fileFolder, frame.framePath);
                      selectNode(node.uid);
                      zoomToNode(node.uid);
                    }}
                  />
                </ContextMenu>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

// --- row model -------------------------------------------------------

type LayerRow = { kind: 'board'; frame: FrameSummary } | { kind: 'element'; node: TreeNode; frame: FrameSummary };

function rowId(row: LayerRow): string {
  return row.kind === 'board' ? row.frame.framePath : row.node.uid;
}

function rowChildren(row: LayerRow, trees: Record<string, TreeNode>): LayerRow[] {
  if (row.kind === 'board') {
    const tree = trees[row.frame.framePath];
    return tree ? tree.children.map((n) => ({ kind: 'element', node: n, frame: row.frame }) as LayerRow) : [];
  }
  return row.node.children.map((n) => ({ kind: 'element', node: n, frame: row.frame }) as LayerRow);
}

/** Type icon from node kind/tag (spec §5.4: "board/group/text/component/
 * image/path"); our AST has no vector `path`/`board` kinds of its own, so
 * `element` falls back to `group` except for a couple of recognizable tags. */
function iconForNode(node: TreeNode): IconName {
  if (node.kind === 'component-instance') return 'component';
  if (node.kind === 'text') return 'text';
  if (node.kind === 'fragment') return 'group';
  if (node.tag === 'img') return 'img';
  if (node.tag === 'svg' || node.tag === 'path') return 'path';
  return 'group';
}

function toggleInSet(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

// --- row renderers -----------------------------------------------------

interface HideLockProps {
  hidden: boolean;
  locked: boolean;
  onToggleHidden: () => void;
  onToggleLocked: () => void;
}

function HideLockButtons({ hidden, locked, onToggleHidden, onToggleLocked }: HideLockProps): React.ReactElement {
  return (
    <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 2 }}>
      <button
        type="button"
        aria-label={locked ? 'Unlock layer' : 'Lock layer'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleLocked();
        }}
        style={{ all: 'unset', display: 'inline-flex', cursor: 'pointer', color: 'var(--ccs-text-subtle)' }}
      >
        <Icon name={locked ? 'lock' : 'unlock'} size={12} />
      </button>
      <button
        type="button"
        aria-label={hidden ? 'Show layer' : 'Hide layer'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleHidden();
        }}
        style={{ all: 'unset', display: 'inline-flex', cursor: 'pointer', color: 'var(--ccs-text-subtle)' }}
      >
        <Icon name={hidden ? 'hide' : 'shown'} size={12} />
      </button>
    </span>
  );
}

function BoardRow({
  frame,
  selected,
  hidden,
  locked,
  onToggleHidden,
  onToggleLocked,
  onZoomToNode,
}: HideLockProps & { frame: FrameSummary; selected: boolean; onZoomToNode: () => void }): React.ReactElement {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flex: 1,
        minInlineSize: 0,
        opacity: hidden ? 0.4 : 1,
        color: selected ? 'var(--ccs-accent)' : 'var(--ccs-text)',
        fontWeight: 600,
      }}
    >
      <ZoomToNodeIcon icon="board" label={`Zoom to board ${frame.name}`} onZoomToNode={onZoomToNode} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{frame.name}</span>
      <HideLockButtons hidden={hidden} locked={locked} onToggleHidden={onToggleHidden} onToggleLocked={onToggleLocked} />
    </span>
  );
}

/** FIX 5: the layer row's type icon, wrapped as its OWN click target
 * (`e.stopPropagation()` — same pattern `HideLockButtons`'s own buttons
 * already use to keep a click on THEM from also re-triggering the row's
 * `Tree`-level `onSelect`) — a click here means "zoom to this", distinct
 * from a click anywhere else on the row (which only selects). */
function ZoomToNodeIcon({
  icon,
  label,
  color,
  onZoomToNode,
}: {
  icon: IconName;
  label: string;
  color?: string;
  onZoomToNode: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onZoomToNode();
      }}
      style={{
        all: 'unset',
        display: 'inline-flex',
        cursor: 'zoom-in',
        flexShrink: 0,
        color,
      }}
    >
      <Icon name={icon} size={16} style={{ color }} />
    </button>
  );
}

function ElementRow({
  node,
  selected,
  hidden,
  locked,
  onToggleHidden,
  onToggleLocked,
  onZoomToNode,
}: HideLockProps & { node: TreeNode; selected: boolean; onZoomToNode: () => void }): React.ReactElement {
  let color = 'var(--ccs-text)';
  if (node.kind === 'component-instance') color = 'var(--ccs-accent-component)';
  if (selected) color = 'var(--ccs-accent)';

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minInlineSize: 0, opacity: hidden ? 0.4 : 1 }}>
      <ZoomToNodeIcon
        icon={iconForNode(node)}
        label={`Zoom to ${node.component ?? node.tag ?? 'element'}`}
        color={color}
        onZoomToNode={onZoomToNode}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color }}>
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
            flexShrink: 0,
          }}
        >
          dynamic
        </span>
      )}
      <HideLockButtons hidden={hidden} locked={locked} onToggleHidden={onToggleHidden} onToggleLocked={onToggleLocked} />
    </span>
  );
}
