/**
 * BoardSwitcher — top-center floating chrome for Studio's multiple boards.
 *
 * Mounted as an untransformed sibling of `CanvasTransformLayer` in
 * `CanvasRoot` (same pattern as `BoardNotesToolbar`), so it stays fixed in
 * the canvas viewport regardless of pan/zoom.
 *
 * Shows one chip per `boards.boards`:
 *   - click activates it (`setActiveBoard`)
 *   - double-click enters inline rename (an `Input` that commits on
 *     Enter/blur via `renameBoard`; Escape cancels)
 *   - a trailing "×" deletes it (`removeBoard`) — hidden when it's the only
 *     board, since a board can never remove its last sibling
 * A trailing "+" creates a new (empty) board and switches to it
 * (`addBoard`), and an `AddFramePicker` (`+ Frame`) is always available here
 * so curating the active board's frames doesn't require finding the
 * empty-state card first.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio board
 * mode.
 */
import { useState, type KeyboardEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import type { Board } from '@core/studio-board'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { AddFramePicker } from '../BoardFramesLayer'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from './BoardSwitcher.module.css'

export function BoardSwitcher() {
  const board = useEditorStore(selectActiveBoard)
  const boards = useEditorStore((s) => s.boards.boards)
  const activeBoardId = useEditorStore((s) => s.activeBoardId)
  const setActiveBoard = useEditorStore((s) => s.setActiveBoard)
  const renameBoard = useEditorStore((s) => s.renameBoard)
  const removeBoard = useEditorStore((s) => s.removeBoard)
  const addBoard = useEditorStore((s) => s.addBoard)

  if (!board) return null

  const canDelete = boards.length > 1

  return (
    <div className={styles.switcher}>
      <div className={styles.chips} role="tablist" aria-label="Boards">
        {boards.map((b) => (
          <BoardChip
            key={b.id}
            board={b}
            isActive={b.id === activeBoardId}
            canDelete={canDelete}
            onActivate={() => setActiveBoard(b.id)}
            onRename={(name) => renameBoard(b.id, name)}
            onDelete={() => removeBoard(b.id)}
          />
        ))}
      </div>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="New board"
        tooltip="New board"
        onClick={() => addBoard()}
      >
        <PlusIcon size={13} aria-hidden="true" />
      </Button>
      <div className={styles.divider} aria-hidden="true" />
      <AddFramePicker label="+ Frame" variant="ghost" size="xs" />
    </div>
  )
}

interface BoardChipProps {
  board: Board
  isActive: boolean
  canDelete: boolean
  onActivate: () => void
  onRename: (name: string) => void
  onDelete: () => void
}

function BoardChip({ board, isActive, canDelete, onActivate, onRename, onDelete }: BoardChipProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(board.name)

  function startEditing() {
    setDraft(board.name)
    setEditing(true)
  }

  function commit() {
    const trimmed = draft.trim()
    if (trimmed.length > 0) onRename(trimmed)
    setEditing(false)
  }

  function cancel() {
    setDraft(board.name)
    setEditing(false)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  if (editing) {
    return (
      <Input
        fieldSize="xs"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className={styles.chipInput}
        aria-label={`Rename board "${board.name}"`}
      />
    )
  }

  return (
    <div className={styles.chip}>
      <Button
        variant="secondary"
        size="xs"
        active={isActive}
        role="tab"
        aria-selected={isActive}
        onClick={onActivate}
        onDoubleClick={startEditing}
      >
        {board.name}
      </Button>
      {canDelete && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          className={styles.deleteButton}
          aria-label={`Delete board "${board.name}"`}
          tooltip="Delete board"
          onClick={onDelete}
        >
          <CloseIcon size={10} aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
