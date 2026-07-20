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
  // Only the setter is used directly (the current drag id is read via the
  // functional-update form inside `handleDrop` below, so `handleDrop` itself
  // doesn't need `dragId` in its own dependency array) — the read half of
  // this tuple is intentionally discarded.
  const [, setDragId] = React.useState<string | null>(null);

  // PERF (Phase 0, fix 3): stable per-Tree-render callbacks handed to the
  // memoized `TreeRowItem` below. Scrolling only changes `scrollTop`/
  // `viewportHeight` (this component's OWN state) — it does NOT re-run
  // `Tree`'s parent, so `onSelect`/`onToggleExpand`/`onReorder`/`renderRow`
  // (this component's OWN props) stay referentially identical across a
  // scroll-driven re-render, and so do these two handlers (their deps are
  // just `onReorder`, itself unchanged in that scenario) — so a row that
  // stays mounted across a small scroll delta (the common case, since
  // `absoluteIndex` is a row's fixed position in the full `rows` array, not
  // a function of scroll offset) genuinely skips re-rendering instead of
  // reconstructing on every scroll tick.
  const handleDragStart = React.useCallback((id: string) => setDragId(id), []);
  const handleDragOver = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (onReorder) e.preventDefault();
    },
    [onReorder],
  );
  const handleDrop = React.useCallback(
    (targetId: string) => {
      setDragId((prev) => {
        if (onReorder && prev && prev !== targetId) onReorder(prev, targetId);
        return null;
      });
    },
    [onReorder],
  );

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
            <TreeRowItem
              key={row.id}
              row={row}
              absoluteIndex={absoluteIndex}
              rowHeight={rowHeight}
              selected={selected}
              expanded={expanded}
              draggable={Boolean(onReorder)}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              renderRow={renderRow}
            />
          );
        })}
      </div>
    </div>
  );
}

/** A single row, extracted from `Tree`'s own render and wrapped in
 * `React.memo` (Phase 0, fix 3) so a row that stays mounted across a small
 * scroll delta (its `absoluteIndex` is fixed — a row's position in the
 * FULL `rows` array, not a function of scroll offset) skips re-rendering
 * entirely instead of reconstructing on every scroll tick. Every prop here
 * is exactly what the inline JSX it replaces used to close over; behavior
 * is unchanged. NOTE (disclosed, not chased down this pass): `onSelect`/
 * `onToggleExpand`/`onReorder`/`renderRow` are `Tree`'s own props — if
 * `LayersPanel` (the current sole caller) passes fresh inline closures for
 * these on every ITS OWN render, this memo only pays off for
 * `Tree`-internal (scroll-driven) re-renders, not ones triggered by
 * `LayersPanel` re-rendering; making those callbacks stable is a larger,
 * separate refactor. Generic over `T` like `Tree` itself — `React.memo`
 * would otherwise erase that generic, so the memoized value is cast back to
 * the un-memoized function's own (generic) type, a standard, safe pattern
 * for memoizing a generic component (the runtime behavior is identical;
 * only the compile-time type is restored). */
function TreeRowItemImpl<T>({
  row,
  absoluteIndex,
  rowHeight,
  selected,
  expanded,
  draggable,
  onSelect,
  onToggleExpand,
  onDragStart,
  onDragOver,
  onDrop,
  renderRow,
}: {
  row: FlatTreeRow<T>;
  absoluteIndex: number;
  rowHeight: number;
  selected: boolean;
  expanded: boolean;
  draggable: boolean;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (id: string) => void;
  renderRow: (row: FlatTreeRow<T>, state: { selected: boolean; expanded: boolean }) => React.ReactNode;
}): React.ReactElement {
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={row.hasChildren ? expanded : undefined}
      aria-level={row.depth + 1}
      data-row-id={row.id}
      draggable={draggable}
      onDragStart={() => onDragStart(row.id)}
      onDragOver={onDragOver}
      onDrop={() => onDrop(row.id)}
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
}

const TreeRowItem = React.memo(TreeRowItemImpl) as typeof TreeRowItemImpl;

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
