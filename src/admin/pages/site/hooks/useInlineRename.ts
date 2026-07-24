/**
 * useInlineRename — shared double-click-to-rename interaction, extracted
 * from the pattern `TreeNode` (DomPanel) already implements for layer rows.
 *
 * Used by the Studio explorer's board rows, page rows, and the board-frame
 * header's rename action so all three get the exact same commit/cancel
 * contract as the layers tree instead of a separate hand-rolled version each:
 *   - `start(currentValue)` opens the inline `Input`, seeded with the
 *     current name, and selects its text.
 *   - Enter or blur commits the trimmed value (no-op if empty).
 *   - Escape cancels without committing.
 */
import { useRef, useState, type KeyboardEvent } from 'react'

interface UseInlineRenameOptions {
  /** Called with the trimmed value on commit. Never called with an empty string. */
  onCommit: (trimmedValue: string) => void
}

export function useInlineRename({ onCommit }: UseInlineRenameOptions) {
  const [isRenaming, setIsRenaming] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const start = (currentValue: string) => {
    setValue(currentValue)
    setIsRenaming(true)
    // Focus the input after it renders.
    requestAnimationFrame(() => inputRef.current?.select())
  }

  const commit = () => {
    const trimmed = value.trim()
    if (trimmed) onCommit(trimmed)
    setIsRenaming(false)
  }

  const cancel = () => setIsRenaming(false)

  // stopPropagation prevents bubbling to the row's own key handling (e.g. a
  // parent row's expand/collapse on Enter).
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
  }

  return { isRenaming, value, setValue, inputRef, start, commit, cancel, handleKeyDown }
}
