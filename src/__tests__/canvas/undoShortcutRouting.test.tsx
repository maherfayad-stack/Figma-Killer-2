/**
 * Who owns Ctrl/⌘+Z — the editor, or the focused text field?
 *
 * `UndoRedoButtons` owns the undo/redo keystroke (it is listed in
 * `shortcutDispatch.ts`'s `COMPONENT_OWNED_SHORTCUTS`, so the spotlight
 * dispatcher deliberately does not also fire it). Its guard used to be a
 * blanket "target is INPUT / TEXTAREA / contentEditable → do nothing".
 *
 * That was survivable while inspector fields were empty boxes. Since the
 * prefill change every style row renders a live, populated `<input>`, and
 * every inspector field keeps focus after a commit (`ScrubInput` /
 * `TokenAwareInput` both re-select on Enter, Figma-style). So the ⌘Z a user
 * presses right after an edit lands on a React-CONTROLLED input whose native
 * undo stack has nothing to give — the keystroke was swallowed and the editor
 * never undid anything. "Ctrl+Z doesn't work."
 *
 * The honest rule, and what these tests pin:
 *   - focus outside any text field                 → editor undo
 *   - focus in a field with an uncommitted draft    → native text undo
 *   - focus in a field with NO uncommitted draft    → editor undo
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { UndoRedoButtons } from '@site/canvas/UndoRedoButtons'

afterEach(cleanup)

function seedSiteWithOneUndoableEdit(): { rootId: string; nodeCount: number } {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hasUnsavedChanges: false,
  })
  const site = useEditorStore.getState().createSite('Undo routing')
  const rootId = site.pages[0]!.rootNodeId
  const before = Object.keys(site.pages[0]!.nodes).length
  useEditorStore.getState().insertNode('base.text', {}, rootId)
  return { rootId, nodeCount: before }
}

function nodeCount(): number {
  return Object.keys(useEditorStore.getState().site!.pages[0]!.nodes).length
}

function pressUndo(target: Element | Document) {
  fireEvent.keyDown(target, { key: 'z', ctrlKey: true })
}

describe('Ctrl/⌘+Z routing', () => {
  let seeded: { rootId: string; nodeCount: number }

  beforeEach(() => {
    seeded = seedSiteWithOneUndoableEdit()
  })

  it('runs the editor undo when focus is not in a text field', () => {
    render(<UndoRedoButtons />)
    expect(nodeCount()).toBe(seeded.nodeCount + 1)
    pressUndo(document)
    expect(nodeCount()).toBe(seeded.nodeCount)
  })

  it('runs the editor undo when focus is in a field with no uncommitted draft', () => {
    const { container } = render(
      <>
        <UndoRedoButtons />
        <input aria-label="Width" defaultValue="320px" />
      </>,
    )
    const input = container.querySelector('input[aria-label="Width"]')!
    fireEvent.focus(input)
    expect(nodeCount()).toBe(seeded.nodeCount + 1)
    pressUndo(input)
    expect(nodeCount()).toBe(seeded.nodeCount)
  })

  it('leaves ⌘Z to the field when it holds an uncommitted draft', () => {
    const { container } = render(
      <>
        <UndoRedoButtons />
        <input aria-label="Width" defaultValue="320px" />
      </>,
    )
    const input = container.querySelector('input[aria-label="Width"]')! as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: '340px' } })
    pressUndo(input)
    // The store must be untouched — the text field's own undo owns this one.
    expect(nodeCount()).toBe(seeded.nodeCount + 1)
  })

  it('hands ⌘Z back to the editor once the field commits its draft', () => {
    const { container } = render(
      <>
        <UndoRedoButtons />
        <input aria-label="Width" defaultValue="320px" />
      </>,
    )
    const input = container.querySelector('input[aria-label="Width"]')! as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: '340px' } })
    // Enter commits and KEEPS focus (Figma behaviour) — the draft is no longer
    // pending, so the next ⌘Z is the editor's.
    fireEvent.keyDown(input, { key: 'Enter' })
    pressUndo(input)
    expect(nodeCount()).toBe(seeded.nodeCount)
  })

  it('a fresh focus clears a previous field draft', () => {
    const { container } = render(
      <>
        <UndoRedoButtons />
        <input aria-label="Width" defaultValue="320px" />
        <input aria-label="Height" defaultValue="200px" />
      </>,
    )
    const width = container.querySelector('input[aria-label="Width"]')! as HTMLInputElement
    const height = container.querySelector('input[aria-label="Height"]')! as HTMLInputElement
    fireEvent.focus(width)
    fireEvent.input(width, { target: { value: '340px' } })
    fireEvent.focus(height)
    pressUndo(height)
    expect(nodeCount()).toBe(seeded.nodeCount)
  })

  it('a textarea keeps native undo while its draft is pending', () => {
    const { container } = render(
      <>
        <UndoRedoButtons />
        <textarea aria-label="Prompt" defaultValue="" />
      </>,
    )
    const ta = container.querySelector('textarea')! as HTMLTextAreaElement
    fireEvent.focus(ta)
    fireEvent.input(ta, { target: { value: 'make it blue' } })
    // Enter in a textarea inserts a newline; it is NOT a commit, so the draft
    // stays pending and native undo keeps the keystroke.
    fireEvent.keyDown(ta, { key: 'Enter' })
    pressUndo(ta)
    expect(nodeCount()).toBe(seeded.nodeCount + 1)
  })
})
