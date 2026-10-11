/**
 * An open rename field owns the keyboard. Typing "Flow A" into a board row's
 * rename input lost the space because the row's own Space handler (activate)
 * saw the key bubble out of the input, and a typed letter reached the editor's
 * document-level tool shortcuts.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useInlineRename } from '@site/hooks/useInlineRename'

afterEach(cleanup)

function Harness({ onRowKey, onCommit }: { onRowKey: (key: string) => void; onCommit: (v: string) => void }) {
  const [rename, inputRef] = useInlineRename({ onCommit })
  return (
    <div role="treeitem" tabIndex={0} onKeyDown={(e) => onRowKey(e.key)}>
      <button type="button" onClick={() => rename.start('Flow')}>
        start
      </button>
      {rename.isRenaming && (
        <input
          ref={inputRef}
          aria-label="rename"
          value={rename.value}
          onChange={(e) => rename.setValue(e.target.value)}
          onKeyDown={rename.handleKeyDown}
        />
      )}
    </div>
  )
}

describe('useInlineRename keyboard ownership', () => {
  it('no key typed into the field reaches the row or the document', () => {
    const onRowKey = mock((_key: string) => {})
    const onDocumentKey = mock((_key: string) => {})
    const listener = (e: KeyboardEvent) => onDocumentKey(e.key)
    document.addEventListener('keydown', listener)
    try {
      render(<Harness onRowKey={onRowKey} onCommit={() => {}} />)
      fireEvent.click(screen.getByText('start'))
      const input = screen.getByLabelText('rename')

      for (const key of [' ', 'a', 'r', 'ArrowRight']) fireEvent.keyDown(input, { key })

      expect(onRowKey).not.toHaveBeenCalled()
      expect(onDocumentKey).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', listener)
    }
  })

  it('Enter still commits the trimmed value', () => {
    const onCommit = mock((_v: string) => {})
    render(<Harness onRowKey={() => {}} onCommit={onCommit} />)
    fireEvent.click(screen.getByText('start'))
    const input = screen.getByLabelText('rename')

    fireEvent.change(input, { target: { value: ' Flow A ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onCommit).toHaveBeenCalledWith('Flow A')
  })
})
