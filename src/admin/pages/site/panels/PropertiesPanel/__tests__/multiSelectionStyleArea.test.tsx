/**
 * The multi-selection style area: which target is on offer, and what the user
 * is told before a class edit reaches elements they never selected
 * (W8-3 phase 3).
 *
 * Covers:
 *   1. No shared class → the chip is pinned to Element, exactly as phase 1
 *      shipped it, and the inline composer is what mounts.
 *   2. A shared class used ONLY by the selection → the class chip is a real
 *      button and switching to it needs no gate.
 *   3. A shared class that also lives elsewhere → switching raises the gate,
 *      naming the count; cancelling leaves the target on Element; confirming
 *      switches to the class composer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { MultiSelectionStyleArea } from '../MultiSelectionStyleArea'
import '@modules/base/index'

afterEach(cleanup)

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeClassId: null,
    activeConditionId: null,
    activeBreakpointId: 'desktop',
    _historyPast: [],
    _historyFuture: [],
  } as Parameters<typeof useEditorStore.setState>[0])
})

/** N sibling text nodes on a fresh site's first page. */
function seedNodes(count: number): string[] {
  const site = useEditorStore.getState().createSite('Bulk')
  const root = site.pages[0].rootNodeId
  return Array.from({ length: count }, () =>
    useEditorStore.getState().insertNode('base.text', {}, root),
  )
}

/** Create one class and put it on every listed node. */
function shareClass(name: string, nodeIds: string[]): string {
  const cls = useEditorStore.getState().createClass(name)
  for (const nodeId of nodeIds) useEditorStore.getState().addNodeClass(nodeId, cls.id)
  return cls.id
}

describe('MultiSelectionStyleArea', () => {
  it('pins to Element when the selection shares no class', () => {
    const ids = seedNodes(2)
    render(<MultiSelectionStyleArea selectedNodeIds={ids} />)

    expect(screen.getByTestId('style-target-chip').getAttribute('data-pinned-target')).toBe(
      'element',
    )
    expect(screen.getByTestId('style-target-chip-class').textContent).toBe('Class')
  })

  it('offers the shared class as a real target', () => {
    const ids = seedNodes(2)
    shareClass('card', ids)

    render(<MultiSelectionStyleArea selectedNodeIds={ids} />)

    const chip = screen.getByTestId('style-target-chip-class')
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.textContent).toContain('.card')
  })

  it('switches straight to the class when only the selection carries it', () => {
    const ids = seedNodes(2)
    shareClass('card', ids)

    render(<MultiSelectionStyleArea selectedNodeIds={ids} />)
    fireEvent.click(screen.getByTestId('style-target-chip-class'))

    expect(screen.queryByTestId('multi-select-class-gate')).toBeNull()
    expect(screen.getByTestId('style-target-chip-class').getAttribute('data-active')).toBe('true')
  })

  it('asks first — naming the count — when the class reaches outside the selection', () => {
    const ids = seedNodes(3)
    // Selected: the first two. The third node carries the class as well, so
    // editing it moves an element the user did not select.
    shareClass('card', ids)
    const selected = [ids[0], ids[1]]

    render(<MultiSelectionStyleArea selectedNodeIds={selected} />)
    fireEvent.click(screen.getByTestId('style-target-chip-class'))

    const gate = screen.getByTestId('multi-select-class-gate')
    expect(gate.textContent).toContain('1 other element outside this selection')
    // Not switched yet — the question is unanswered.
    expect(screen.getByTestId('style-target-chip-class').getAttribute('data-active')).toBe('false')
  })

  it('cancelling the gate leaves the target on Element', () => {
    const ids = seedNodes(3)
    shareClass('card', ids)

    render(<MultiSelectionStyleArea selectedNodeIds={[ids[0], ids[1]]} />)
    fireEvent.click(screen.getByTestId('style-target-chip-class'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByTestId('multi-select-class-gate')).toBeNull()
    expect(screen.getByTestId('style-target-chip-class').getAttribute('data-active')).toBe('false')
  })

  it('confirming the gate switches to the class target', () => {
    const ids = seedNodes(3)
    shareClass('card', ids)

    render(<MultiSelectionStyleArea selectedNodeIds={[ids[0], ids[1]]} />)
    fireEvent.click(screen.getByTestId('style-target-chip-class'))
    fireEvent.click(screen.getByTestId('multi-select-class-gate-confirm'))

    expect(screen.queryByTestId('multi-select-class-gate')).toBeNull()
    expect(screen.getByTestId('style-target-chip-class').getAttribute('data-active')).toBe('true')
  })
})
