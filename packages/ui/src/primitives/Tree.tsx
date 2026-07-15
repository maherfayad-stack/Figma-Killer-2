import * as React from 'react';

/**
 * Tree — generic virtualized tree list backing `LayersPanel` (playbook
 * §2.2 `layers.cljs`/`layer_item.cljs`: rename, hide, lock, drag-reorder).
 * Generic over `T` so it has zero dependency on `@ccs/protocol`'s
 * `TreeNode` shape — `apps/studio` supplies the flatten/render glue.
 *
 * Virtualization: a fixed-row-height windowed list (no new dependency —
 * `react-window` is not in the workspace catalog and a JSX-tree rarely
 * exceeds a few hundred rows per frame, so a hand-rolled scroll-position
 * window is proportionate). Only rows within the viewport (+ overscan) are
 * mounted; the scroll container's block-size is held constant via a full
 * height spacer so native scrollbar behavior stays correct.
 *
 * Indentation uses `padding-inline-start` (logical) — nesting depth always
 * indents toward the reading-direction end regardless of `dir`.
 */
export interface FlatTreeRow<T> {
  id: string;
  depth: number;
  data: T;
  hasChildren: boolean;
}

export interface TreeProps<T> {
  rows: FlatTreeRow<T>[];
  renderRow: (row: FlatTreeRow<T>, state: { selected: boolean; expanded: boolean }) => React.ReactNode;
  selectedId?: string | null;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string) => void;
  rowHeight?: number;
  ariaLabel: string;
  /** Called on a row-to-row reorder drag gesture (playbook: drag-reorder ->
   * move-node op). Fires with the dragged row id and the id it was dropped
   * onto. */
  onReorder?: (draggedId: string, targetId: string) => void;
}

const OVERSCAN = 6;

export function Tree<T>({
  rows,
  renderRow,
  selectedId,
  expandedIds,
  onToggleExpand,
  onSelect,
  rowHeight = 28,
  ariaLabel,
  onReorder,
}: TreeProps<T>): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportHeight, setViewportHeight] = React.useState(400);
  const [dragId, setDragId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalHeight = rows.length * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + OVERSCAN * 2;
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const visibleRows = rows.slice(startIndex, endIndex);

  function onKeyDown(e: React.KeyboardEvent) {
    const idx = rows.findIndex((r) => r.id === selectedId);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, idx + 1)];
      if (next) onSelect(next.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = rows[Math.max(0, idx - 1)];
      if (prev) onSelect(prev.id);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const row = rows[idx];
      if (row?.hasChildren && !expandedIds.has(row.id)) onToggleExpand(row.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const row = rows[idx];
      if (row?.hasChildren && expandedIds.has(row.id)) onToggleExpand(row.id);
    }
  }

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      data-testid="layers-tree"
      style={{ position: 'relative', overflow: 'auto', blockSize: '100%', minBlockSize: 0 }}
    >
      <div style={{ blockSize: totalHeight, position: 'relative' }}>
        {visibleRows.map((row, i) => {
          const absoluteIndex = startIndex + i;
          const selected = row.id === selectedId;
          const expanded = expandedIds.has(row.id);
          return (
            <div
              key={row.id}
              role="treeitem"
              aria-selected={selected}
              aria-expanded={row.hasChildren ? expanded : undefined}
              aria-level={row.depth + 1}
              data-row-id={row.id}
              draggable={Boolean(onReorder)}
              onDragStart={() => setDragId(row.id)}
              onDragOver={(e) => onReorder && e.preventDefault()}
              onDrop={() => {
                if (onReorder && dragId && dragId !== row.id) onReorder(dragId, row.id);
                setDragId(null);
              }}
              onClick={() => onSelect(row.id)}
              style={{
                position: 'absolute',
                insetBlockStart: absoluteIndex * rowHeight,
                insetInlineStart: 0,
                insetInlineEnd: 0,
                blockSize: rowHeight,
                display: 'flex',
                alignItems: 'center',
                paddingInlineStart: 8 + row.depth * 14,
                paddingInlineEnd: 8,
                gap: 4,
                fontSize: 'var(--ccs-font-size-sm)',
                background: selected ? 'var(--ccs-bg-selected)' : 'transparent',
                borderInlineStart: selected ? '2px solid var(--ccs-accent)' : '2px solid transparent',
                cursor: 'pointer',
              }}
            >
              {row.hasChildren ? (
                <button
                  type="button"
                  aria-label={expanded ? 'Collapse' : 'Expand'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand(row.id);
                  }}
                  style={{
                    all: 'unset',
                    display: 'inline-flex',
                    inlineSize: 14,
                    blockSize: 14,
                    cursor: 'pointer',
                    color: 'var(--ccs-text-muted)',
                    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 100ms ease',
                  }}
                >
                  ▸
                </button>
              ) : (
                <span style={{ inlineSize: 14 }} />
              )}
              {renderRow(row, { selected, expanded })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Flattens a rooted tree into `FlatTreeRow[]`, honoring `expandedIds` —
 * shared helper so `apps/studio` doesn't reimplement the walk per panel. */
export function flattenTree<T>(
  roots: T[],
  getId: (node: T) => string,
  getChildren: (node: T) => T[],
  expandedIds: Set<string>,
  depth = 0,
): FlatTreeRow<T>[] {
  const out: FlatTreeRow<T>[] = [];
  for (const node of roots) {
    const id = getId(node);
    const children = getChildren(node);
    out.push({ id, depth, data: node, hasChildren: children.length > 0 });
    if (children.length > 0 && expandedIds.has(id)) {
      out.push(...flattenTree(children, getId, getChildren, expandedIds, depth + 1));
    }
  }
  return out;
}
