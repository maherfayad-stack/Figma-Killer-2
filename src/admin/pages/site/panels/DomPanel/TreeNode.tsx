/**
 * TreeNode — ONE row in the Layers tree. Presentational: it renders the row it
 * is told to render and reads nothing about the tree it belongs to.
 *
 * It used to be recursive — a `TreeNode` rendered a `role="group"` of more
 * `TreeNode`s — and it carried 17 `useEditorStore` subscriptions per row. On a
 * deep imported page with every branch open that was 2,441 rows x 17 = ~41,500
 * selector invocations before React started work on ANY store commit.
 * `LayerRowList` now flattens the tree, mounts only the visible slice, and
 * hands each row everything that is a fact about the TREE (the node, the page
 * root, class names, VC names, prefs, drop state) as a prop. What is left here
 * is the one fact that is genuinely per-row and changes independently:
 *
 *     const isHovered = useEditorStore((s) => s.hoveredNodeId === nodeId)
 *
 * Everything else reaches the store through `getState()` inside an event
 * handler, which costs no subscription at all (the pattern `BoardFrameView`
 * adopted in `perf-02`).
 *
 * Drag-and-drop:
 * - Each row is a @dnd-kit draggable item with DOMPanel-owned targets.
 * - Visual indicators render as overlays (no DOM reorder during drag).
 * - moveNode() called once on DragEndEvent at the DomPanel level.
 *
 * Accessibility:
 * - role="treeitem" + aria-selected + aria-expanded on THE SAME element as
 *   tabIndex={0} and keyboard handlers (Guideline #234 / WCAG SC 4.1.2).
 * - A windowed tree has no nested `role="group"` DOM to convey depth, so each
 *   row states its own position: `aria-level` / `aria-posinset` /
 *   `aria-setsize`, the flat-DOM form the WAI-ARIA tree pattern defines.
 * - onFocus/onBlur focus ring (WCAG SC 2.4.7).
 * - height: 28px (Guideline #357 — compact density; WCAG 2.5.5 touch target
 *   NOT required for editor chrome per user directive / Guideline #357).
 */
import { memo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import type { PageNode } from '@core/page-tree'
import { useDraggable } from '@dnd-kit/core'
import { useExpansionStore } from './DomTreeContext'
import { useDomPanelRowRegistry } from './DomPanelDndContext'
import { LayerNodeContextMenu } from './LayerNodeContextMenu'
import { Input } from '@ui/components/Input'
import { cn } from '@ui/cn'
import {
  TreeRow,
  treeDropStyles,
} from '@site/ui/Tree'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { LayerTreeNodeContent } from './LayerTreeNodeContent'
import { isNarrowEditorChromeViewport } from '@site/layout/responsiveChrome'
import type { LayerRowSpanPosition } from './layerRows'
import styles from './TreeNode.module.css'

export interface TreeNodeProps {
  /** The node itself — resolved once by the list, never re-selected per row. */
  node: PageNode
  depth: number
  /** This node is the page body: forced open, no chevron, not draggable. */
  isRoot: boolean
  expanded: boolean
  hasChildren: boolean
  selected: boolean
  editable: boolean
  /** Resolved label — VC names and class registry live on the list, not here. */
  displayName: string
  htmlTag: string | null
  /** Joined class chip (e.g. ".header.padding-m"), or null. */
  classSelectorChip: string | null
  showIcon: boolean
  showTag: boolean
  showClasses: boolean
  /** Drop indicator for THIS row, if the pointer currently resolves to it. */
  dropPosition?: 'before' | 'after' | 'inside'
  /** This row is the refused drop target. */
  invalidDrop: boolean
  /** G5 — the refusal message, when the refusal is a source write. */
  invalidReason: string | null
  /** This row is the dragged node, or inside its subtree. */
  dragSource: boolean
  /** Position inside the highlighted open-container span, if any. */
  openGroupPosition?: LayerRowSpanPosition
  /** This row is the head of that span (drives `data-open-container-group`). */
  openGroupHead: boolean
  ariaLevel: number
  ariaPosInSet: number
  ariaSetSize: number
}

interface ContextMenuState {
  x: number
  y: number
}

// React.memo re-render bailout — exception #2: the hot, list-rendered row of the
// Layers tree. The windowed list re-renders on every scroll tick, every drag
// move and every selection change; without this bailout each of those would
// re-render all ~40 mounted rows instead of the one or two whose props moved.
// Every prop above is a primitive or a store-stable object reference, so the
// shallow compare is honest. Measured in `layersTreePerf.test.tsx`.
export const TreeNode = memo(function TreeNode({
  node,
  depth,
  isRoot,
  expanded,
  hasChildren,
  selected,
  editable,
  displayName,
  htmlTag,
  classSelectorChip,
  showIcon,
  showTag,
  showClasses,
  dropPosition,
  invalidDrop,
  invalidReason,
  dragSource,
  openGroupPosition,
  openGroupHead,
  ariaLevel,
  ariaPosInSet,
  ariaSetSize,
}: TreeNodeProps) {
  const nodeId = node.id

  // The ONLY per-row store subscription. Hover flips on every pointer move
  // across the tree and affects exactly two rows, so it stays per-row rather
  // than becoming a prop that would re-render the whole mounted window.
  const isHovered = useEditorStore((s) => s.hoveredNodeId === nodeId)

  // Delete confirmation — gated by `confirmBeforeDelete` preference. The
  // hook returns a function that either runs `commit` immediately (pref off)
  // or routes through the central confirm dialog (pref on).
  const confirmDelete = useConfirmDelete()

  const store = useExpansionStore()
  const { registerRow } = useDomPanelRowRegistry()

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [isFocused, setIsFocused] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const rowRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const selectLayerNode = (mode?: 'replace' | 'toggle' | 'range') => {
    useEditorStore.getState().selectNode(nodeId, mode, {
      preservePropertiesPanelCollapse: isNarrowEditorChromeViewport(),
    })
  }

  // ── dnd-kit draggable ─────────────────────────────────────────────────────
  const draggableEnabled = editable && !isRoot && !node.locked && !isRenaming
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({
    id: nodeId,
    disabled: !draggableEnabled,
  })
  const draggableAttributes = draggableEnabled ? attributes : undefined
  const draggableListeners = draggableEnabled ? listeners : undefined

  const setRowNodeRef = (element: HTMLDivElement | null) => {
    rowRef.current = element
    setNodeRef(element)
    registerRow(nodeId, element)
  }

  const isOpenContainerGroup = openGroupHead

  const requestDeleteLayer = () => {
    if (!editable || isRoot || node.locked) return
    confirmDelete({
      title: 'Delete layer?',
      description: `${displayName} and any of its children will be removed. This can be undone with Ctrl/Cmd+Z.`,
      commit: () => useEditorStore.getState().deleteNode(nodeId),
    })
  }

  const requestDeleteSelection = () => {
    if (!editable || isRoot || node.locked) return

    const state = useEditorStore.getState()
    const page = selectActiveCanvasPage(state)
    if (!page) return

    const selection = state.selectedNodeIds.includes(nodeId)
      ? state.selectedNodeIds
      : [nodeId]
    const deletableIds = selection.filter((id) => {
      const candidate = page.nodes[id]
      return Boolean(candidate) && id !== page.rootNodeId && !candidate?.locked
    })
    if (deletableIds.length === 0) return

    if (!state.selectedNodeIds.includes(nodeId)) {
      selectLayerNode()
    }

    if (deletableIds.length === 1) {
      requestDeleteLayer()
      return
    }

    confirmDelete({
      title: 'Delete layers?',
      description: `${deletableIds.length} layers and any children will be removed. This can be undone with Ctrl/Cmd+Z.`,
      commit: () => useEditorStore.getState().deleteNodes([...deletableIds]),
    })
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // When the rename input is active, all key handling is delegated to
    // handleRenameKeyDown on the input itself — don't intercept here.
    if (isRenaming) return

    if (getKeybindingForCommand('layers.delete')?.match(e)) {
      e.preventDefault()
      e.stopPropagation()
      requestDeleteSelection()
      return
    }

    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault()
        selectLayerNode()
        if (hasChildren && !isRoot) store.toggle(nodeId)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (hasChildren && !isRoot && !expanded) store.toggle(nodeId)
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (!isRoot && expanded) store.toggle(nodeId)
        break
      case 'F2':
        if (!editable) return
        e.preventDefault()
        openRename()
        break
    }
  }

  // ── Inline rename ─────────────────────────────────────────────────────────
  const openRename = () => {
    if (!editable) return
    setRenameValue(node.label ?? displayName)
    setIsRenaming(true)
    setContextMenu(null)
    // Focus the input after it renders
    requestAnimationFrame(() => renameInputRef.current?.select())
  }

  const commitRename = () => {
    if (!editable) {
      setIsRenaming(false)
      return
    }
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== displayName) {
      useEditorStore.getState().renameNode(nodeId, trimmed)
    }
    setIsRenaming(false)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // stopPropagation prevents bubbling to the parent row's handleKeyDown,
    // which would otherwise intercept Enter/Space and call selectNode().
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitRename() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setIsRenaming(false) }
  }

  return (
    // One wrapper per row (NOT per subtree — the tree is flat now). It carries
    // the row-identity data attributes the canvas, the tests and the
    // scroll-to-selection path address rows by, and the group/drag-source
    // backgrounds that must sit BEHIND the row's own selected/hover fill.
    <div
      data-node-id={nodeId}
      data-layer-row={nodeId}
      data-open-container-group={isOpenContainerGroup ? 'true' : undefined}
      data-drag-source={dragSource ? 'true' : undefined}
      className={cn(
        node.moduleId === 'base.slot-instance' && styles.slotInstanceRow,
        openGroupPosition && styles.openContainerGroup,
        openGroupPosition === 'start' && styles.openContainerGroupStart,
        openGroupPosition === 'middle' && styles.openContainerGroupMiddle,
        openGroupPosition === 'end' && styles.openContainerGroupEnd,
        dragSource && styles.dragSource,
      )}
    >
      {/* ── Row: role="treeitem" + tabIndex + handlers all on ONE element ── */}
      {/*
          IMPORTANT: {…attributes} from useDraggable injects role="button".
          role="treeitem" is placed AFTER the spread to override it back
          (Guideline #234 / WAI-ARIA tree pattern — treeitem role is non-negotiable).
      */}
      <TreeRow
        ref={setRowNodeRef}
        depth={depth}
        selected={selected}
        hovered={isHovered}
        focused={isFocused}
        locked={node.locked}
        hidden={node.hidden}
        dragging={isDragging}
        className={cn(
          dropPosition === 'before' && treeDropStyles.dropBefore,
          dropPosition === 'after' && treeDropStyles.dropAfter,
          dropPosition === 'inside' && treeDropStyles.dropInside,
          invalidDrop && treeDropStyles.dropInvalid,
        )}
        {...draggableAttributes}
        {...draggableListeners}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren && !isRoot ? expanded : undefined}
        // Flat-DOM tree: depth and sibling position are stated, not implied by
        // nesting, because the rows above and below may not be mounted.
        aria-level={ariaLevel}
        aria-posinset={ariaPosInSet}
        aria-setsize={ariaSetSize}
        // aria-label names the row for AT, including locked/hidden state so screen
        // reader users get the full picture without relying on the emoji indicators
        // (which are aria-hidden and therefore invisible to AT).
        aria-label={[
          displayName,
          node.locked ? 'locked' : null,
          node.hidden ? 'hidden' : null,
        ].filter(Boolean).join(', ')}
        data-drop-position={dropPosition}
        // G5 — a real title on the row: unlike the canvas overlay's
        // `pointer-events: none` invalid box, this row is a normal
        // interactive element, so a native title tooltip actually fires on
        // hover here. Only set when THIS row is the refused drop target AND
        // the refusal is a source-write one (not an ordinary structural
        // rejection, which has no message to show).
        title={invalidDrop ? (invalidReason ?? undefined) : undefined}
        // Stable agent-addressable handles. `dom-tree-item` is keyed by the
        // node id (matches `data-studio-node-id` on the canvas) so a single id
        // round-trips between the canvas and the layers tree. `data-studio-tag`
        // mirrors the resolved HTML tag so agents can disambiguate two
        // "Container" rows by `[data-studio-tag="nav"]` vs `[data-studio-tag="footer"]`.
        data-testid={`dom-tree-item-${nodeId}`}
        data-studio-node-id={nodeId}
        data-studio-tag={htmlTag ?? undefined}
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          // Modifier-aware selection (multi-select): Cmd/Ctrl-click toggles,
          // Shift-click extends a range from the anchor. Modifier-clicks do
          // NOT toggle expansion — that's reserved for plain clicks so users
          // can build a multi-selection without accidentally rearranging the
          // tree's visible structure.
          if (e.shiftKey) {
            selectLayerNode('range')
            return
          }
          if (e.metaKey || e.ctrlKey) {
            selectLayerNode('toggle')
            return
          }
          selectLayerNode()
          if (hasChildren && !isRoot) store.toggle(nodeId)
        }}
        onDoubleClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openRename()
        }}
        onKeyDown={handleKeyDown}
        onContextMenu={(e) => {
          e.preventDefault(); e.stopPropagation()
          if (!editable) return
          // Right-click on a node already in the multi-selection keeps the set;
          // otherwise replace with just this node. Matches the canvas + Figma.
          const currentIds = useEditorStore.getState().selectedNodeIds
          if (!currentIds.includes(nodeId)) {
            selectLayerNode()
          }
          setContextMenu({ x: e.clientX, y: e.clientY })
        }}
        onMouseEnter={() => useEditorStore.getState().hoverNode(nodeId)}
        onMouseLeave={() => useEditorStore.getState().hoverNode(null)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
      >
        <LayerTreeNodeContent
          moduleId={node.moduleId}
          displayName={displayName}
          htmlTag={htmlTag}
          classSelectorChip={classSelectorChip}
          hasChildren={hasChildren}
          expanded={expanded}
          showIcon={showIcon}
          showTag={showTag}
          showClasses={showClasses}
          isRoot={isRoot}
          locked={node.locked}
          hidden={node.hidden}
          onToggle={(e) => { e.stopPropagation(); if (!isRoot) store.toggle(nodeId) }}
          labelSlot={isRenaming ? (
            <Input
              ref={renameInputRef}
              fieldSize="xs"
              // autoFocus ensures the input receives keyboard focus as soon as it
              // mounts — more reliable than the requestAnimationFrame fallback.
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              // Stop pointer events from bubbling to the row's dnd-kit listeners.
              // Without this, a click inside the input triggers the PointerSensor
              // on the row div, which can steal focus away from the input.
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={`Rename ${displayName}`}
              className={styles.renameInput}
            />
          ) : undefined}
        />
      </TreeRow>

      {/* Context menu — rendered via portal at document.body to escape the
          DomPanel's transform: translateZ(0) stacking context.
          Without the portal, position:fixed inside a transformed ancestor is
          positioned relative to that ancestor, not the viewport, causing the
          menu to appear ~40px below the cursor (Task #413). */}
      {editable && contextMenu && createPortal(
        <LayerNodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={nodeId}
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            setContextMenu(null)
            requestDeleteLayer()
          }}
          onDuplicate={() => { useEditorStore.getState().duplicateNode(nodeId); setContextMenu(null) }}
          onRename={() => { setContextMenu(null); openRename() }}
          onWrapInContainer={() => {
            useEditorStore.getState().wrapNode(nodeId, 'base.container')
            setContextMenu(null)
          }}
          onCopy={() => { useEditorStore.getState().copyNode(nodeId); setContextMenu(null) }}
          onCut={() => { useEditorStore.getState().cutNode(nodeId); setContextMenu(null) }}
          onPaste={() => { useEditorStore.getState().pasteNode(nodeId); setContextMenu(null) }}
          onPasteHtml={async (targetNodeId) => {
            setContextMenu(null)
            let prefillHtml = ''
            try {
              prefillHtml = await navigator.clipboard.readText()
            } catch (_err) {
              // Clipboard permission denied or API unavailable — open with an empty editor.
            }
            useEditorStore.getState().openImportHtmlModal({ parentId: targetNodeId, prefillHtml })
          }}
        />,
        document.body,
      )}
    </div>
  )
})
