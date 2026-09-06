/**
 * LayerRowList — the windowed body of the Layers tree.
 *
 * One component owns everything that is a fact about the TREE; `TreeNode` owns
 * only what is a fact about a ROW. That split is the whole point:
 *
 *   - The tree is flattened to an array of rows (`flattenLayerRows`), walking
 *     expanded branches only. A collapsed 40,000-node page is one row.
 *   - Only the rows inside the scroll viewport (plus overscan) are mounted;
 *     the rest are two spacer blocks (`useRowWindow`).
 *   - The page, the class registry, the Visual Component names, the layer
 *     display preferences, the selection set and the live drag state are read
 *     ONCE here instead of once per row. Before this split each row carried 17
 *     `useEditorStore` subscriptions, so every store commit cost
 *     `rows x 17` selector invocations before React did any work.
 *
 * There is deliberately no scroller here. `StudioPagesTree`'s page list is the
 * single scroll container for the column, shared by every expanded page's
 * subtree, so windowing is computed against that ancestor — which is also why
 * a page whose subtree has scrolled off screen mounts zero rows instead of a
 * full tree per board frame.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore, selectCanvasPageFor } from '@site/store/store'
import { registry } from '@core/module-engine'
import {
  getAncestors,
  getNodeClassNames,
  getNodeDisplayName,
  getNodeHtmlTag,
} from '@core/page-tree'
import { TreeContainer } from '@site/ui/Tree'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { TreeNode } from './TreeNode'
import { useDomTreePageId, useExpansionStore } from './DomTreeContext'
import {
  useDomPanelDropState,
  useDomPanelRowRegistry,
  DomPanelRowRegistryContext,
  type DomPanelRowRegistry,
} from './DomPanelDndContext'
import { computeRowSpans, findLayerRowIndex, flattenLayerRows, subtreeRowRange, type LayerRow } from './layerRows'
import { useRowWindow } from './useRowWindow'
import styles from './LayerRowList.module.css'

/**
 * Stable server/initial snapshot for `useSyncExternalStore`. Expansion is
 * client-only UI state in an admin SPA; returning a fresh Set here would make
 * React think the store changed on every render.
 */
const EMPTY_EXPANDED_IDS: ReadonlySet<string> = new Set<string>()
const getEmptyExpandedIds = (): ReadonlySet<string> => EMPTY_EXPANDED_IDS

interface LayerRowListProps {
  ariaLabel: string
  testId?: string
  /**
   * Top-level rows. One entry (the page body) normally; the body's children
   * when the structural root is hidden in Visual Component mode.
   */
  rootNodeIds: readonly string[]
  /**
   * The node that is forced open and has no chevron — the page body. `null`
   * when the body is hidden and its children are the roots.
   */
  alwaysExpandedId: string | null
  editable: boolean
  /**
   * React to canvas selection: expand the selected node's ancestors and scroll
   * it into view. Only the ACTIVE page's tree does this — a background page's
   * subtree must never hijack the shared scroller.
   */
  revealSelection: boolean
}

export function LayerRowList({
  ariaLabel,
  testId,
  rootNodeIds,
  alwaysExpandedId,
  editable,
  revealSelection,
}: LayerRowListProps) {
  const pageId = useDomTreePageId()
  const expansion = useExpansionStore()
  const containerRef = useRef<HTMLDivElement>(null)

  // ── Per-TREE subscriptions (four, regardless of row count) ────────────────
  const page = useEditorStore((s) => selectCanvasPageFor(s, pageId))
  // Subscribe to visualComponents so VC renames re-label every ref's row, and
  // to the class registry so renaming a class updates every row using it.
  const visualComponents = useEditorStore((s) => s.site?.visualComponents)
  const classes = useEditorStore((s) => s.site?.styleRules)
  const selectedNodeIds = useEditorStore(useShallow((s) => s.selectedNodeIds))

  // Expansion is UI-only state in an external store; ONE snapshot for the whole
  // tree replaced N per-row subscriptions. The snapshot is the expanded SET
  // (copy-on-write in `ExpansionStore`) rather than a predicate, so it is a
  // real input to the flatten below — a predicate closure would never change
  // identity and the React Compiler would hand back a stale row list.
  const expandedIds = useSyncExternalStore(
    expansion.subscribe,
    expansion.getExpandedIds,
    getEmptyExpandedIds,
  )

  // Layer display preferences — read once, passed down. Three per row before.
  const showIcon = useEditorPreference('layersShowIcon')
  const showTag = useEditorPreference('layersShowTag')
  const showClasses = useEditorPreference('layersShowClasses')

  // Live drop state — consumed here, turned into per-row props, so a drag move
  // re-renders only the rows whose indicator actually moved.
  const dropState = useDomPanelDropState()

  const rows: LayerRow[] = page
    ? flattenLayerRows(page.nodes, rootNodeIds, expandedIds, alwaysExpandedId)
    : []

  const { window: rowWindow, scrollerRef, rowHeight } = useRowWindow(containerRef, rows.length)

  // ── Row element registry ──────────────────────────────────────────────────
  // `useState` lazy init (an initializer, not memoization): one object for the
  // list's lifetime so the context never invalidates a memoized row. It both
  // feeds the drag hit-tester and lets focus follow a row through the window.
  // Capturing `dndRegistry` once is safe by construction — that context value
  // is created once per panel and never replaced (see `DomPanelDndContext`).
  const dndRegistry = useDomPanelRowRegistry()
  const [rowRegistry] = useState(() => {
    const elements = new Map<string, HTMLElement>()
    const value: DomPanelRowRegistry & { elements: Map<string, HTMLElement> } = {
      elements,
      registerRow: (nodeId, element) => {
        if (element) elements.set(nodeId, element)
        else elements.delete(nodeId)
        dndRegistry.registerRow(nodeId, element)
      },
    }
    return value
  })

  // ── Focus that survives windowing ─────────────────────────────────────────
  // A focused row can scroll out of the window and unmount. Park focus on the
  // tree container (which is always mounted) and give it back the moment the
  // row returns, so tab position and keyboard control are never lost to a
  // scroll the user did with the wheel.
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)
  useEffect(() => {
    if (!focusedNodeId) return
    const container = containerRef.current
    if (!container) return
    const rowElement = rowRegistry.elements.get(focusedNodeId)
    const active = document.activeElement

    if (!rowElement) {
      if (!active || active === document.body) container.focus({ preventScroll: true })
      return
    }
    if (active === container) rowElement.focus({ preventScroll: true })
  })

  // ── Ancestor auto-expand + scroll-to-selected ─────────────────────────────
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const autoExpandSelected = useEditorPreference('layersAutoExpandSelected')
  const smoothScroll = useEditorPreference('layersSmoothScroll')

  // Refs so the post-render scroll can read the CURRENT row list and geometry
  // without re-running the effect on every flatten. Written in an effect, never
  // during render.
  const rowsRef = useRef<LayerRow[]>(rows)
  const rowHeightRef = useRef(rowHeight)
  useEffect(() => {
    rowsRef.current = rows
    rowHeightRef.current = rowHeight
  })

  useEffect(() => {
    if (!revealSelection || !page || !selectedNodeId) return

    // O(depth), not O(tree): `getAncestors` walks the denormalised `parentId`
    // pointers. The BFS this replaced re-walked every node of the page on every
    // selection change.
    if (autoExpandSelected) {
      for (const ancestor of getAncestors(page, selectedNodeId)) {
        expansion.expand(ancestor.id)
      }
    }

    // After the expand-driven re-render has committed.
    const frame = requestAnimationFrame(() => {
      const behavior: ScrollBehavior = smoothScroll ? 'smooth' : 'auto'
      const rowElement = rowRegistry.elements.get(selectedNodeId)
      const scroller = scrollerRef.current
      const container = containerRef.current
      const currentRowHeight = rowHeightRef.current

      // The row may be outside the mounted window — there is nothing to call
      // scrollIntoView on. Scroll by index instead, which works whether or not
      // the row is mounted.
      if (scroller && container && currentRowHeight > 0) {
        const index = findLayerRowIndex(rowsRef.current, selectedNodeId)
        if (index < 0) return
        const listTop =
          scroller.scrollTop +
          (container.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
        const rowTop = listTop + index * currentRowHeight
        const rowBottom = rowTop + currentRowHeight
        if (rowTop < scroller.scrollTop) {
          scroller.scrollTo({ top: rowTop, behavior })
        } else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
          scroller.scrollTo({ top: rowBottom - scroller.clientHeight, behavior })
        }
        return
      }

      rowElement?.scrollIntoView({ behavior, block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [
    revealSelection,
    selectedNodeId,
    page,
    autoExpandSelected,
    smoothScroll,
    expansion,
    rowRegistry,
    scrollerRef,
  ])

  // ── Derived spans (open container group, drag source subtree) ─────────────
  const openGroupPositions = computeRowSpans(rows, (row) => {
    const node = page?.nodes[row.nodeId]
    return (
      node?.moduleId === 'base.container' &&
      row.hasChildren &&
      row.expanded &&
      selectedNodeIds.includes(row.nodeId)
    )
  })
  const dragRange = dropState.activeId ? subtreeRowRange(rows, dropState.activeId) : null

  const visibleRows = rows.slice(rowWindow.start, rowWindow.end)

  return (
    <DomPanelRowRegistryContext.Provider value={rowRegistry}>
      <TreeContainer
        ariaLabel={ariaLabel}
        testId={testId}
        containerRef={containerRef}
        data-studio-layer-tree="true"
        // Focus parking spot for a row that scrolled out of the window. NOT an
        // `aria-activedescendant` tree: the rows keep their own `tabIndex={0}`
        // and take real DOM focus, and the two mechanisms are mutually
        // exclusive in the ARIA tree pattern. A dangling `aria-activedescendant`
        // pointing at an unmounted row would be worse than no attribute.
        tabIndex={-1}
        className={styles.tree}
        onFocus={(e) => {
          const rowId = (e.target as HTMLElement).getAttribute?.('data-studio-node-id')
          if (rowId) setFocusedNodeId(rowId)
        }}
      >
        {rowWindow.padTopPx > 0 && (
          <div
            role="presentation"
            aria-hidden="true"
            className={styles.spacer}
            style={{ '--layer-spacer-h': `${rowWindow.padTopPx}px` } as React.CSSProperties}
          />
        )}

        {visibleRows.map((row, offset) => {
          const index = rowWindow.start + offset
          const node = page?.nodes[row.nodeId]
          if (!node) return null
          const definition = registry.get(node.moduleId)
          const classNames = getNodeClassNames(node, classes)
          const isRoot = page?.rootNodeId === row.nodeId
          const target = dropState.target
          const dropPosition =
            target?.overId === row.nodeId && target.position !== 'inside'
              ? target.position
              : target?.parentId === row.nodeId && target.position === 'inside'
                ? 'inside'
                : undefined

          return (
            <TreeNode
              key={row.nodeId}
              node={node}
              depth={row.depth}
              isRoot={isRoot}
              expanded={row.expanded}
              hasChildren={row.hasChildren}
              selected={selectedNodeIds.includes(row.nodeId)}
              editable={editable}
              displayName={getNodeDisplayName(node, definition, visualComponents)}
              htmlTag={getNodeHtmlTag(node, definition)}
              classSelectorChip={classNames.length > 0 ? `.${classNames.join('.')}` : null}
              showIcon={showIcon}
              showTag={showTag}
              showClasses={showClasses}
              dropPosition={dropPosition}
              invalidDrop={dropState.invalidOverId === row.nodeId}
              invalidReason={dropState.invalidReason}
              dragSource={Boolean(dragRange && index >= dragRange.start && index < dragRange.end)}
              openGroupPosition={openGroupPositions[index]}
              openGroupHead={openGroupPositions[index] === 'start' || openGroupPositions[index] === 'single'}
              ariaLevel={row.depth + 1}
              ariaPosInSet={row.posInSet}
              ariaSetSize={row.setSize}
            />
          )
        })}

        {rowWindow.padBottomPx > 0 && (
          <div
            role="presentation"
            aria-hidden="true"
            className={styles.spacer}
            style={{ '--layer-spacer-h': `${rowWindow.padBottomPx}px` } as React.CSSProperties}
          />
        )}
      </TreeContainer>
    </DomPanelRowRegistryContext.Provider>
  )
}
