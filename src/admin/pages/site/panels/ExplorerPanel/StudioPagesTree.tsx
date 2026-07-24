/**
 * StudioPagesTree — the "Pages" section of the Studio explorer panel.
 *
 * Every page in `site.pages` is a top-level, independently expandable row,
 * stacked in normal document flow — an expanded page's subtree occupies
 * exactly the height of its own rows, and this section's own scroll
 * container (`.scroll`) is the ONLY scroller in this column; any leftover
 * space stays empty at the bottom of the list rather than being distributed
 * between rows. Expanding a page reveals its node tree:
 *   - the ACTIVE page renders the full `DomPanel` (drag-and-drop reordering,
 *     background context menu, keyboard nav — everything the old
 *     single-page Layers tab gave you, minus the search/insert row it drops
 *     in studio mode), in its content-height "embedded" mode
 *     (`DomPanel.module.css`'s `.panelEmbedded`/`.treeAreaEmbedded`) so it
 *     composes into this stacked list instead of stretching to fill it.
 *   - every OTHER page renders `PageLayerSubtree` — the same `TreeNode`
 *     rendering, lazily mounted only while expanded, without a live DnD
 *     context (see that component's doc for why dragging is inert there).
 *
 * Activation + edit routing: node mutations (`mutateActiveTree`) always act
 * on `activePageId`, never on "whichever page's rows happen to be on
 * screen". Every page row's `onPointerDownCapture` fires `openPageInCanvas`
 * BEFORE any click/context-menu/drag inside that row reaches node-selection
 * logic — same pattern `BoardFramesLayer`'s frame activation uses, and the
 * same "click a page to open it" convention `SiteExplorerPanel` already
 * follows.
 *
 * Expand/collapse state is local component state (a `Set<string>` of
 * expanded page ids) — UI-only, never persisted to `boards.json` or the
 * site document. The active page auto-expands the first time it becomes
 * active so opening/switching pages always reveals their layers.
 */
import { useEffect, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { Page } from '@core/page-tree'
import { DomPanel, PageLayerSubtree } from '@site/panels/DomPanel'
import { AddFramePicker } from '@site/canvas/BoardFramesLayer'
import { Input } from '@ui/components/Input'
import { TreeChevron, TreeContainer, TreeIconSlot, TreeLabel, TreeRow } from '@site/ui/Tree'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { useInlineRename } from '@site/hooks/useInlineRename'
import styles from './StudioPagesTree.module.css'

interface StudioPagesTreeProps {
  editable?: boolean
}

export function StudioPagesTree({ editable = true }: StudioPagesTreeProps) {
  const pages = useEditorStore((s) => s.site?.pages ?? [])
  const activePageId = useEditorStore((s) => s.activePageId)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const renamePage = useEditorStore((s) => s.renamePage)

  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(activePageId ? [activePageId] : []),
  )

  // Auto-reveal the active page's tree the moment it becomes active (covers
  // switching pages from the canvas/board, not just from this panel).
  useEffect(() => {
    if (!activePageId) return
    setExpandedIds((prev) => (prev.has(activePageId) ? prev : new Set(prev).add(activePageId)))
  }, [activePageId])

  const toggleExpanded = (pageId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(pageId)) next.delete(pageId)
      else next.add(pageId)
      return next
    })
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <span className={styles.heading}>Pages</span>
        {/* Permanent home for adding a frame to the active board — the
            `+ Frame` action `BoardSwitcher` used to own. `BoardFramesLayer`
            only renders `AddFramePicker` in its empty state, so once a board
            has any frames this header is the only remaining entry point. */}
        <AddFramePicker iconOnly ariaLabel="Add page to board" size="micro" />
      </div>
      <TreeContainer ariaLabel="Pages" testId="studio-pages-tree" className={styles.scroll}>
        {pages.map((page) => (
          <PageRow
            key={page.id}
            page={page}
            isActive={page.id === activePageId}
            expanded={expandedIds.has(page.id)}
            editable={editable}
            onToggleExpand={() => toggleExpanded(page.id)}
            onActivate={() => openPageInCanvas(page.id)}
            onRename={(title) => renamePage(page.id, title)}
          />
        ))}
      </TreeContainer>
    </div>
  )
}

interface PageRowProps {
  page: Page
  isActive: boolean
  expanded: boolean
  editable: boolean
  onToggleExpand: () => void
  onActivate: () => void
  onRename: (title: string) => void
}

function PageRow({ page, isActive, expanded, editable, onToggleExpand, onActivate, onRename }: PageRowProps) {
  const rename = useInlineRename({ onCommit: onRename })

  // Capture phase — fires before any click inside this row (the header, or a
  // node row in the revealed subtree), so `activePageId` is already this
  // page by the time selection/mutation logic runs. Mirrors
  // `BoardFramesLayer`'s `handleActivateCapture`.
  const handleActivateCapture = () => {
    if (!isActive) onActivate()
  }

  return (
    <div className={styles.pageRow} onPointerDownCapture={handleActivateCapture}>
      <TreeRow
        depth={0}
        selected={isActive}
        role="treeitem"
        aria-selected={isActive}
        aria-expanded={expanded}
        tabIndex={0}
        onClick={onToggleExpand}
        onDoubleClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          rename.start(page.title)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleExpand() }
        }}
      >
        <TreeChevron expanded={expanded} onClick={(e) => { e.stopPropagation(); onToggleExpand() }} />
        <TreeIconSlot icon={FileTextSolidIcon} iconSize={11} iconColor="var(--text-disabled)" />
        {rename.isRenaming ? (
          <Input
            ref={rename.inputRef}
            fieldSize="xs"
            autoFocus
            value={rename.value}
            onChange={(e) => rename.setValue(e.target.value)}
            onKeyDown={rename.handleKeyDown}
            onBlur={rename.commit}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Rename page ${page.title}`}
            className={styles.renameInput}
          />
        ) : (
          <TreeLabel>{page.title}</TreeLabel>
        )}
      </TreeRow>

      {expanded && (
        <div className={styles.pageSubtree}>
          {isActive ? (
            <DomPanel editable={editable} />
          ) : (
            <PageLayerSubtree page={page} editable={editable} />
          )}
        </div>
      )}
    </div>
  )
}
