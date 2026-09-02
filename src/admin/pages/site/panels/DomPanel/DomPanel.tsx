/**
 * DomPanel — the Layers tree, embedded once per expanded active-page row
 * inside `StudioPagesTree` (see that component's doc). Content-sized rather
 * than filling a panel: `StudioPagesTree`'s page list is the single scroll
 * container, so DomPanel has no chrome, no own scroller, and no fill/grow
 * behavior of its own — a second nested scroller (or a box stretching to
 * fill leftover height) would push every following page row toward the
 * bottom.
 *
 * Guideline #357 (Compact UI Density):
 * - Row height: 28px (WCAG touch target NOT required for editor chrome)
 * - Font: 12px, icons: 14px
 *
 * Guideline #318 (Phase 3 Perf):
 * - Per-node Zustand selectors: only affected rows re-render on selection/hover
 * - DnD drag position tracked via refs; store updated once on dragEnd
 * - ExpansionStore is an external observable in DomTreeContext (UI-only) — never in siteSlice
 *
 * Guideline #321 (Phase 3 Architecture):
 * - DndContext wraps the whole tree; SortableContexts are per-parent group
 * - Ancestor auto-expand + scroll-to-selected on canvas selection change
 *
 * Accessibility:
 * - role="tree" on tree container
 * - data-panel attribute for event propagation guard (Guideline #192)
 * - data-testid="dom-panel" and "dom-panel-ready" for Playwright (Guideline #221)
 */
import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { createPortal } from 'react-dom'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { flattenSubtree } from '@core/page-tree'
import { getAncestorIds } from '@site/hooks/useTreeWalkOrder'
import { TreeNode } from './TreeNode'
import { TreeBackgroundContextMenu } from './TreeBackgroundContextMenu'
import { useExpansionStore } from './DomTreeContext'
import { DomTreeProvider } from './DomTreeProvider'
import { DomPanelDndContext } from './DomPanelDndContext'
import { useDomPanelDnd } from './useDomPanelDnd'
import { TreeContainer, TreeIconSlot, TreeLabel, TreeRow } from '@site/ui/Tree'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { SkeletonTree } from '@ui/components/Skeleton'
import type { IconComponent } from 'pixel-art-icons/types'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import styles from './DomPanel.module.css'

// ─── Inner panel (needs context from DomTreeProvider) ─────────────────────────

function DomPanelInner({ editable = true }: { editable?: boolean }) {
  const page = useEditorStore(selectActiveCanvasPage)
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const focusedPanel = useEditorStore((s) => s.focusedPanel)
  // Per-node selector — only this ref updates when selection changes (Guideline #318)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)

  // Behavioural prefs for the tree's reaction to canvas selection.
  const autoExpandSelected = useEditorPreference('layersAutoExpandSelected')
  const smoothScroll = useEditorPreference('layersSmoothScroll')

  const treeRef = useRef<HTMLDivElement>(null)
  const store = useExpansionStore()

  // Right-click on the empty background of the tree area opens a small
  // context menu with Paste + Insert module options targeting the page root.
  // Per-row right-clicks are handled by `LayerNodeContextMenu` via `TreeNode`,
  // which calls `e.stopPropagation()` so this handler only fires on truly
  // empty space (padding around / below the rendered rows).
  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null)
  const rootNode = page?.nodes[page.rootNodeId] ?? null
  const hideStructuralRoot = activeDocument?.kind === 'visualComponent' && rootNode?.moduleId === 'base.body'
  const visibleRootNodeIds = page
    ? hideStructuralRoot
      ? rootNode?.children ?? []
      : [page.rootNodeId]
    : []

  // Panel landmark ref — used by the F6 focus-cycle effect to move focus into
  // the Layers tree. The Explorer shell owns positioning/visibility.
  const panelRef = useRef<HTMLDivElement>(null)

  // ─── DnD sensors ──────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },  // small threshold prevents accidental drags
    }),
  )

  const treeAreaRef = useRef<HTMLDivElement>(null)
  const dnd = useDomPanelDnd({ page, treeAreaRef, expandNode: store.expand, isExpanded: store.isExpanded })

  // ─── Ancestor auto-expand + scroll-to-selected ────────────────────────────
  // When the canvas selection changes, ensure the selected node is visible in
  // the tree (expand all its ancestors) and scroll the tree to it.
  //
  // `store` is the stable ExpansionStore instance from context — it never
  // changes reference for the lifetime of the DomTreeProvider. Listing it in
  // deps satisfies exhaustive-deps without ever causing effect re-runs.
  useEffect(() => {
    if (!page || !selectedNodeId) return

    // Auto-expand all ancestors of the selected node so it is visible in the
    // tree. Skipped when the user opts out via `layersAutoExpandSelected` —
    // the row remains hidden under collapsed parents until the user expands
    // them manually.
    if (autoExpandSelected) {
      const ancestorIds = getAncestorIds(page.nodes, page.rootNodeId, selectedNodeId)
      for (const ancestorId of ancestorIds) {
        store.expand(ancestorId)
      }
    }

    // Scroll the selected row into view after the expand animation settles.
    // The `smooth` vs `auto` choice is user-controllable via the
    // `layersSmoothScroll` preference (some users find smooth scrolling
    // distracting when bouncing between many nodes quickly).
    requestAnimationFrame(() => {
      const row = treeRef.current?.querySelector(`[data-node-id="${selectedNodeId}"]`)
      if (row) {
        row.scrollIntoView({
          behavior: smoothScroll ? 'smooth' : 'auto',
          block: 'nearest',
        })
      }
    })
  }, [selectedNodeId, page, autoExpandSelected, smoothScroll, store])

  // ─── Focus management: F6 moves focus into panel ──────────────────────────
  // The panel landmark is the landing target when the user cycles focus into
  // the DOM panel via F6. We must NOT pull focus to it when the
  // user has already clicked something inside the panel on first interaction
  // after page reload — `focusedPanel` is persisted, so this effect fires on
  // every mount with `'domTree'` as the default and races the user's click.
  // The `panelRef.contains()` guard prevents the steal.
  useEffect(() => {
    if (focusedPanel !== 'domTree') return
    const panel = panelRef.current
    if (!panel) return
    if (panel.contains(document.activeElement)) return
    panel.focus({ preventScroll: true })
  }, [focusedPanel, panelRef])

  // ─── Keyboard shortcuts at panel level ────────────────────────────────────
  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'F6') {
      e.preventDefault()
      useEditorStore.getState().cycleFocusedPanel()
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+E = expand all, Ctrl+W = collapse all
      if (e.key === 'e' && page) {
        e.preventDefault()
        store.expandAll(flattenSubtree(page, page.rootNodeId))
      }
      if (e.key === 'w') {
        e.preventDefault()
        store.collapseAll()
      }
    }
  }

  // ─── Background right-click → tree-background context menu ───────────────
  // Fires only for clicks on the empty padding/space of the tree area —
  // TreeNode's onContextMenu calls e.stopPropagation() so per-row right-clicks
  // don't reach this handler.
  const handleBackgroundContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!editable) return
    if (!page) return
    e.preventDefault()
    e.stopPropagation()
    setBgContextMenu({ x: e.clientX, y: e.clientY })
  }

  // ─── DnD drag-end: commit one validated move to store ────────────────────
  const handleDragEnd = (event: DragEndEvent) => {
    if (!editable) return
    const target = dnd.handleDragEnd(event)
    if (!target) return

    try {
      // Multi-drag: route to `moveNodes` so every dragged id is moved in a
      // single undo step. For single-drag, `target.draggedIds` is `[draggedId]`
      // and `moveNodes` collapses to `moveNode` internally.
      useEditorStore.getState().moveNodes(target.draggedIds, target.parentId, target.index)
    } catch (err) {
      console.warn('[DomPanel] Ignored stale drag/drop target:', err)
    }
  }

  const dragOverlay = (
    <DragOverlay dropAnimation={null}>
      {dnd.activeId && dnd.activeLabel && dnd.activeModuleId ? (
        <TreeRow depth={0} className={styles.dragOverlayRow}>
          <TreeIconSlot
            icon={getModuleIcon(dnd.activeModuleId)}
            iconSize={11}
            iconColor="var(--text-disabled)"
          />
          {dnd.activeCount > 1 ? (
            <TreeLabel>{dnd.activeCount} layers</TreeLabel>
          ) : (
            <TreeLabel>{dnd.activeLabel}</TreeLabel>
          )}
        </TreeRow>
      ) : null}
    </DragOverlay>
  )

  return (
    <div
      ref={panelRef}
      data-panel=""
      data-testid={page ? 'dom-panel-ready' : 'dom-panel'}
      role="complementary"
      aria-label="DOM tree panel"
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
      onFocus={() => setFocusedPanel('domTree')}
      onClick={(e) => e.stopPropagation()}
      className={styles.panel}
    >
      {/* onContextMenu fires only for right-clicks on EMPTY space inside this
          area; TreeNode rows stop propagation so they keep their per-row
          context menu. */}
      <div
        ref={treeAreaRef}
        className={styles.treeArea}
        onContextMenu={handleBackgroundContextMenu}
      >
        {!page ? (
          <SkeletonTree ariaLabel="Loading layers" />
        ) : (
          <DndContext
            sensors={sensors}
            // dnd-kit's built-in auto-scroll is disabled: `useDomPanelDnd`
            // (`runAutoScroll`, AUTO_SCROLL_EDGE_PX) already implements
            // auto-scroll for this tree, and re-measures row rects
            // (`measureRows`) + re-resolves the drop target on every scroll
            // tick. Running BOTH scrolled the list at ~double speed near an
            // edge, and dnd-kit's own scroll happened without a matching
            // `measureRows()` — so cached row rects went stale under the
            // pointer and no drop target ever resolved near a scroll edge
            // (STUDIO-FIGMA-PARITY-PLAN.md 0.9 / STATE.md standing note;
            // audit docs/audits/2026-08-06/07-drag-and-drop.md G11).
            autoScroll={false}
            onDragStart={editable ? dnd.handleDragStart : undefined}
            onDragMove={editable ? dnd.handleDragMove : undefined}
            onDragEnd={handleDragEnd}
            onDragCancel={editable ? dnd.handleDragCancel : undefined}
          >
            <DomPanelDndContext.Provider value={dnd.contextValue}>
              <TreeContainer
                ariaLabel="Page element tree"
                testId="dom-panel-tree"
                containerRef={treeRef}
                data-studio-layer-tree="true"
              >
                {/*
                  Page mode shows the `base.body` root because it represents
                  the document body and anchors page-level insertion.
                  Component mode hides that same structural wrapper and
                  promotes its children to top-level rows so the panel shows
                  authored component content instead of an implementation
                  anchor. Background insert/paste still targets the hidden
                  root through TreeBackgroundContextMenu.
                */}
                {visibleRootNodeIds.map((nodeId) => (
                  <TreeNode key={nodeId} nodeId={nodeId} depth={0} editable={editable} />
                ))}
              </TreeContainer>
            </DomPanelDndContext.Provider>
            {typeof document === 'undefined'
              ? dragOverlay
              : createPortal(dragOverlay, document.body)}
          </DndContext>
        )}
      </div>

      {/* Tree-background context menu — rendered via portal at document.body
          to escape the panel's transform: translateZ(0) stacking context.
          Without the portal, position:fixed inside a transformed ancestor is
          positioned relative to that ancestor, not the viewport. */}
      {editable && bgContextMenu && createPortal(
        <TreeBackgroundContextMenu
          x={bgContextMenu.x}
          y={bgContextMenu.y}
          onClose={() => setBgContextMenu(null)}
        />,
        document.body,
      )}
    </div>
  )
}

export function DomPanel({ editable = true }: { editable?: boolean }) {
  return (
    <DomTreeProvider>
      <DomPanelInner editable={editable} />
    </DomTreeProvider>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getModuleIcon(moduleId: string): IconComponent {
  switch (moduleId) {
    case 'base.container':
      return LayoutSolidIcon
    case 'base.text':
      return TextStartTIcon
    case 'base.image':
      return ImageSolidIcon
    case 'base.link':
      return LinkIcon
    case 'base.list':
      return ListBoxSolidIcon
    case 'base.body':
      return FileTextSolidIcon
    case 'base.video':
      return VideoSolidIcon
    case 'base.button':
    default:
      return SquareSolidIcon
  }
}
