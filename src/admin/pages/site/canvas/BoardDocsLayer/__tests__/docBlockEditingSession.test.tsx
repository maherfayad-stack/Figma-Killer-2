/**
 * DocBlockView — leaving an editing session must not duplicate the document.
 *
 * The regression this locks down: the editor and the reader used to be the
 * same host element as far as React was concerned (a `<div>` in the same
 * child slot, no key), so React kept the DOM node across the switch and only
 * swapped its props. The editor's children are NOT React's — they are written
 * with `el.innerHTML` — so on the way out React believed the node was empty,
 * mounted the reader's markup and APPENDED it beside the text that was
 * already there. The card then showed the document twice: once unstyled
 * (the leftover, no longer carrying `.rendered`) and once styled.
 *
 * That is one bug behind two reported symptoms — "text duplicates when
 * unhovered" and "styles don't apply" — which is why both are asserted here.
 *
 * `BoardDocsLayer` is rendered rather than `DocBlockView` directly: the card
 * reads its own html back out of the store after committing, so a test that
 * passed the doc in as a fixed prop would never see the committed value.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createBoard, createBoardsFile, type DocBlock } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { BoardDocsLayer } from '../BoardDocsLayer'

const DOC: DocBlock = { id: 'doc-1', x: 0, y: 0, w: 320, h: 240, html: '<p>Assads</p>' }

function seedBoard(doc: DocBlock = DOC) {
  const board = { ...createBoard('board-1', 'Board 1'), docs: [doc] }
  useEditorStore.setState({
    boards: { ...createBoardsFile(), boards: [board] },
    activeBoardId: board.id,
    boardsLoaded: true,
    boardsDirty: false,
    selectedAnnotations: [],
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** Neutral board state — `useEditorStore` is a process-wide singleton shared by every test file. */
function resetBoardState() {
  useEditorStore.setState({
    boards: createBoardsFile(),
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    selectedAnnotations: [],
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  cleanup()
  seedBoard()
  render(<BoardDocsLayer />)
})
afterEach(cleanup)
afterAll(resetBoardState)

/** Enters the editing session the way a user does — double-clicking the card's header. */
function beginEditing(): HTMLElement {
  fireEvent.doubleClick(screen.getByText('Doc'))
  return screen.getByRole('textbox')
}

describe('DocBlockView editing session', () => {
  it('renders the stored html once before any editing', () => {
    const card = screen.getByTestId('doc-block')
    expect(card.querySelectorAll('p')).toHaveLength(1)
    expect(card.textContent).toContain('Assads')
  })

  it('leaves exactly one copy of the document behind when the session ends', () => {
    const editable = beginEditing()
    // What a toolbar command leaves behind: `execCommand` writes the DOM
    // directly, so the editor's content is imperative from React's view.
    editable.innerHTML = '<h1>Assads</h1>'
    fireEvent.keyDown(editable, { key: 'Escape' })

    const card = screen.getByTestId('doc-block')
    expect(card.querySelectorAll('h1')).toHaveLength(1)
    expect(card.textContent?.match(/Assads/g) ?? []).toHaveLength(1)
  })

  it('keeps the committed html inside the styled reader, not loose in the scroll box', () => {
    const editable = beginEditing()
    editable.innerHTML = '<h1>Assads</h1>'
    fireEvent.keyDown(editable, { key: 'Escape' })

    // The "styles don't apply" half of the same bug: the leftover copy sat
    // DIRECTLY in the scroll box, as a sibling of the reader, and so outside
    // the element carrying the doc typography — it rendered as unstyled body
    // text. Asserted structurally rather than by class name because CSS
    // Modules resolve to nothing under the test runner.
    const card = screen.getByTestId('doc-block')
    const [, scrollBox] = card.children
    expect(scrollBox.children).toHaveLength(1)
    expect(scrollBox.children[0]?.querySelector('h1')).not.toBeNull()
  })

  it('re-opening the session shows the committed text once, not the previous session as well', () => {
    const first = beginEditing()
    first.innerHTML = '<h1>Assads</h1>'
    fireEvent.keyDown(first, { key: 'Escape' })

    const second = beginEditing()
    expect(second.querySelectorAll('h1')).toHaveLength(1)
    expect(second.textContent?.match(/Assads/g) ?? []).toHaveLength(1)
  })

  it('shows the placeholder — and only the placeholder — for an empty card', () => {
    cleanup()
    seedBoard({ ...DOC, html: '' })
    render(<BoardDocsLayer />)
    expect(screen.getByText('Double-click to write docs')).toBeDefined()
    expect(screen.getByTestId('doc-block').querySelectorAll('p')).toHaveLength(0)
  })
})
