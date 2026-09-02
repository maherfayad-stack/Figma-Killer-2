/**
 * StudioBoardsList — the "Boards" section of the Studio explorer panel.
 *
 * The sole surface for browsing/switching/renaming/deleting boards — the
 * floating bottom-center `BoardSwitcher` canvas chrome this replaced has
 * been removed (boards now live only here, alongside the page tree). A
 * short, compact list of `boards.boards` (this is deliberately NOT a full
 * tree — boards have no nested content of their own here; their contents are
 * the pages shown below in `StudioPagesTree`, filtered to the active board):
 *   - click activates the board (`setActiveBoard`)
 *   - double-click renames it inline (`renameBoard`)
 *   - right-click opens a small context menu with Delete (`removeBoard`),
 *     hidden for the last remaining board — a board can never remove its
 *     last sibling.
 *   - a trailing "+" creates a new board and switches to it (`addBoard`)
 *
 * The section header also carries a collapse toggle (hides the list, keeping
 * just the header) and, when expanded, a bottom-edge resize handle (drag to
 * grow/shrink the list's height — useful once there are enough boards that
 * the list scrolls). Both are sticky per-browser via `studioBoardsListPrefs`
 * (localStorage) — UI chrome, not board content, so they don't belong in
 * `.studio/boards.json`. List rows are fixed-height regardless of board count
 * (`TreeRow`'s `flex-shrink: 0`): more boards make the list SCROLL within its
 * height, never squish individual rows.
 *
 * Adding a FRAME (curating a page onto the active board) is a separate
 * action, homed in `StudioPagesTree`'s section header (`AddFramePicker`) —
 * see that component's doc.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import type { Board } from '@core/studio-board'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { TreeContainer, TreeIconSlot, TreeLabel, TreeRow } from '@site/ui/Tree'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { useInlineRename } from '@site/hooks/useInlineRename'
import { cn } from '@ui/cn'
import {
  BOARDS_LIST_MAX_HEIGHT,
  BOARDS_LIST_MIN_HEIGHT,
  getBoardsListCollapsed,
  getBoardsListHeight,
  setBoardsListCollapsed,
  setBoardsListHeight,
} from './studioBoardsListPrefs'
import styles from './StudioBoardsList.module.css'

export function StudioBoardsList() {
  const boards = useEditorStore((s) => s.boards.boards)
  const activeBoardId = useEditorStore((s) => s.activeBoardId)
  const setActiveBoard = useEditorStore((s) => s.setActiveBoard)
  const renameBoard = useEditorStore((s) => s.renameBoard)
  const removeBoard = useEditorStore((s) => s.removeBoard)
  const addBoard = useEditorStore((s) => s.addBoard)

  const [collapsed, setCollapsed] = useState(getBoardsListCollapsed)
  const [height, setHeight] = useState(getBoardsListHeight)

  const canDelete = boards.length > 1

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev
      setBoardsListCollapsed(next)
      return next
    })
  }

  function handleHeightChange(next: number) {
    setHeight(next)
    setBoardsListHeight(next)
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          <ChevronRightIcon
            size={10}
            aria-hidden="true"
            className={cn(styles.disclosureChevron, !collapsed && styles.disclosureChevronExpanded)}
          />
          <span className={styles.heading}>Boards</span>
        </button>
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label="New board"
          tooltip="New board"
          onClick={() => addBoard()}
        >
          <PlusIcon size={11} aria-hidden="true" />
        </Button>
      </div>
      {!collapsed && (
        <>
          <TreeContainer
            ariaLabel="Boards"
            testId="studio-boards-list"
            className={styles.list}
            style={{ height }}
          >
            {boards.map((board) => (
              <BoardRow
                key={board.id}
                board={board}
                isActive={board.id === activeBoardId}
                canDelete={canDelete}
                onActivate={() => setActiveBoard(board.id)}
                onRename={(name) => renameBoard(board.id, name)}
                onDelete={() => removeBoard(board.id)}
              />
            ))}
          </TreeContainer>
          <ResizeHandle height={height} onHeightChange={handleHeightChange} />
        </>
      )}
    </div>
  )
}

interface ResizeHandleProps {
  height: number
  onHeightChange: (next: number) => void
}

/** Bottom-edge drag handle — grows/shrinks the boards list. Mirrors the
 *  dashboard Block library's `ResizeHandle` (same pointer-capture pattern). */
function ResizeHandle({ height, onHeightChange }: ResizeHandleProps) {
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    dragRef.current = { startY: event.clientY, startHeight: height }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = dragRef.current
    if (!state) return
    const dy = event.clientY - state.startY
    onHeightChange(Math.max(BOARDS_LIST_MIN_HEIGHT, Math.min(BOARDS_LIST_MAX_HEIGHT, state.startHeight + dy)))
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
    setDragging(false)
  }

  return (
    <div
      className={cn(styles.resizeHandle, dragging && styles.resizeHandleActive)}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize boards list"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  )
}

interface BoardRowProps {
  board: Board
  isActive: boolean
  canDelete: boolean
  onActivate: () => void
  onRename: (name: string) => void
  onDelete: () => void
}

function BoardRow({ board, isActive, canDelete, onActivate, onRename, onDelete }: BoardRowProps) {
  const [rename, renameInputRef] = useInlineRename({ onCommit: onRename })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <TreeRow
      depth={0}
      selected={isActive}
      role="treeitem"
      aria-selected={isActive}
      tabIndex={0}
      onClick={onActivate}
      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); rename.start(board.name) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate() }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!canDelete) return
        onActivate()
        setContextMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <TreeIconSlot icon={LayoutSolidIcon} iconSize={11} iconColor="var(--text-disabled)" />
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
          aria-label={`Rename board ${board.name}`}
          className={styles.renameInput}
        />
      ) : (
        <TreeLabel>{board.name}</TreeLabel>
      )}

      {/* Only ever opened when canDelete is true — see onContextMenu above. */}
      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Board options"
          animateExit
          onClose={() => setContextMenu(null)}
        >
          <ContextMenuItem
            danger
            onClick={() => { onDelete(); setContextMenu(null) }}
          >
            <span aria-hidden="true"><TrashSolidIcon size={13} /></span>
            Delete
          </ContextMenuItem>
        </ContextMenu>,
        document.body,
      )}
    </TreeRow>
  )
}
