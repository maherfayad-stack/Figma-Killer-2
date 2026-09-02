/**
 * StudioPagesTree — the "Pages" section of the Studio explorer panel.
 *
 * Shows only the pages CURATED ONTO THE ACTIVE BOARD (`board.frames`), not
 * every page in the project — a project can accumulate many pages across
 * boards, and a board's own page list is what the user is actually working
 * with. Switching the active board (in `StudioBoardsList` above) narrows this
 * list to that board's frames; `AddFramePicker` / `NewPageButton` in the
 * header are how a page joins the active board in the first place. Falls back
 * to every page while boards haven't loaded yet (`!boardsLoaded`), so there's
 * no empty flash during the brief window before `.studio/boards.json` returns.
 *
 * Each page is a top-level, independently expandable row, stacked in normal
 * document flow — an expanded page's subtree occupies exactly the height of
 * its own rows, and this section's own scroll container (`.scroll`) is the
 * ONLY scroller in this column; any leftover space stays empty at the bottom
 * of the list rather than being distributed between rows. Expanding a page
 * reveals its node tree:
 *   - the ACTIVE page renders the full `DomPanel` (drag-and-drop reordering,
 *     background context menu, keyboard nav) in its content-height
 *     mode (`DomPanel.module.css`'s `.panel`/`.treeArea`) so it composes
 *     into this stacked list instead of stretching to fill it.
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
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import type { Page } from '@core/page-tree'
import { DomPanel, PageLayerSubtree } from '@site/panels/DomPanel'
import { AddFramePicker, NewPageButton } from '@site/canvas/BoardFramesLayer'
import { Input } from '@ui/components/Input'
import { TreeChevron, TreeContainer, TreeIconSlot, TreeLabel, TreeRow } from '@site/ui/Tree'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { useInlineRename } from '@site/hooks/useInlineRename'
import styles from './StudioPagesTree.module.css'

// Stable fallback reference — `?? []` inline would hand back a NEW array every
// render, which a Zustand selector must never do (breaks useSyncExternalStore's
// "did this change" check and can spiral into a "Maximum update depth
// exceeded" render loop once anything downstream reacts to the selected value).
const EMPTY_PAGES: Page[] = []

interface StudioPagesTreeProps {
  editable?: boolean
}

export function StudioPagesTree({ editable = true }: StudioPagesTreeProps) {
  const allPages = useEditorStore((s) => s.site?.pages ?? EMPTY_PAGES)
  const board = useEditorStore(selectActiveBoard)
  const boardsLoaded = useEditorStore((s) => s.boardsLoaded)
  const activePageId = useEditorStore((s) => s.activePageId)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const renamePage = useEditorStore((s) => s.renamePage)

  // Narrow to the active board's own pages once boards have loaded — see the
  // doc comment above. `board.frames` order isn't meaningful for reading, so
  // keep `allPages`' existing (sorted) order rather than the frame array's.
  const pages = !boardsLoaded || !board
    ? allPages
    : allPages.filter((page) => board.frames.some((f) => f.pageId === page.id))

  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(activePageId ? [activePageId] : []),
  )
  // Tracks the `activePageId` this component last reacted to — lets the
  // auto-reveal below run as a render-time state adjustment (React's
  // documented "adjust state when a prop changes" pattern) instead of an
  // Effect, which would commit once, then immediately re-render again for a
  // change already known this render.
  const [lastSyncedActivePageId, setLastSyncedActivePageId] = useState(activePageId)

  // Auto-reveal the active page's tree the moment it becomes active (covers
  // switching pages from the canvas/board, not just from this panel).
  if (activePageId !== lastSyncedActivePageId) {
    setLastSyncedActivePageId(activePageId)
    if (activePageId && !expandedIds.has(activePageId)) {
      setExpandedIds(new Set(expandedIds).add(activePageId))
    }
  }

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
        {/* Two entry points for populating the board: `NewPageButton` creates a
            brand-new page file, `AddFramePicker` curates an already-made page
            onto the active board. `BoardFramesLayer` only renders these in its
            empty state, so once a board has any frames this header is the only
            remaining home for them. */}
        <div className={styles.headerActions}>
          <NewPageButton iconOnly ariaLabel="New page" size="micro" />
          <AddFramePicker iconOnly ariaLabel="Add existing page to board" size="micro" />
        </div>
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
  const [rename, renameInputRef] = useInlineRename({ onCommit: onRename })

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
            ref={renameInputRef}
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
