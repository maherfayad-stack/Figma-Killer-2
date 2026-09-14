/**
 * MultiInlineStyleComposer + the pinned style-target chip (W8-3 phase 1).
 *
 * P3 is complete (`STATE.md` `panel-25`, item 11 — Studio extras): every
 * CURATED CSS category (including the `cursor`/`pointerEvents` pair tests
 * 1-3 used to exercise here) migrated to its own node-selection-scoped
 * `INSPECTOR_SECTIONS` manifest entry, so `MultiInlineStyleComposer` now
 * renders only `CustomPropertiesSection` (the uncurated long tail) — see
 * that file's own doc. Tests 1-3 below exercise an uncurated property
 * (`gridAutoFlow`) instead, the same substitution `mixedValueControls.
 * test.tsx`'s own doc note makes for the deleted `StyleSectionsEditor`
 * suite.
 *
 * Covers:
 *   1. `CustomPropertiesSection` mounts for an N-node selection, with a
 *      disagreeing uncurated property rendered as "Mixed" rather than one
 *      node's value.
 *   2. The first edit writes that one value to EVERY selected node.
 *   3. A property every node agrees on shows the shared value, not "Mixed".
 *   4. `StyleTargetChip` pins to Element and states the reason, instead of
 *      offering a class target the bulk surface cannot honour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { MultiInlineStyleComposer } from '../MultiInlineStyleComposer'
import { StyleTargetChip } from '../StyleTargetChip'
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

function seedNodes(count: number): string[] {
  const site = useEditorStore.getState().createSite('Bulk')
  const root = site.pages[0].rootNodeId
  return Array.from({ length: count }, () =>
    useEditorStore.getState().insertNode('base.text', {}, root),
  )
}

function inlineStylesOf(nodeId: string): Record<string, unknown> | undefined {
  return useEditorStore.getState().site!.pages[0].nodes[nodeId]?.inlineStyles
}

describe('MultiInlineStyleComposer', () => {
  it('renders a disagreeing uncurated property as Mixed', () => {
    const [a, b] = seedNodes(2)
    // `gridAutoFlow` is uncurated — the only kind of property this composer
    // still renders now that every curated category has its own node-
    // selection-scoped `INSPECTOR_SECTIONS` entry (`STATE.md` `panel-25`,
    // item 11). It disagrees between the two nodes.
    useEditorStore.getState().setNodeInlineStyles(a, { gridAutoFlow: 'row' })
    useEditorStore.getState().setNodeInlineStyles(b, { gridAutoFlow: 'column' })

    render(<MultiInlineStyleComposer nodeIds={[a, b]} />)

    const field = screen.getByLabelText('grid-auto-flow value') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })

  it('shows the shared value when every node agrees', () => {
    const [a, b] = seedNodes(2)
    useEditorStore.getState().setNodeInlineStyles(a, { gridAutoFlow: 'column' })
    useEditorStore.getState().setNodeInlineStyles(b, { gridAutoFlow: 'column' })

    render(<MultiInlineStyleComposer nodeIds={[a, b]} />)

    expect((screen.getByLabelText('grid-auto-flow value') as HTMLInputElement).value).toBe('column')
  })

  it('writes the first edit to every selected node', () => {
    const [a, b] = seedNodes(2)
    useEditorStore.getState().setNodeInlineStyles(a, { gridAutoFlow: 'row' })
    useEditorStore.getState().setNodeInlineStyles(b, { gridAutoFlow: 'column' })

    render(<MultiInlineStyleComposer nodeIds={[a, b]} />)
    fireEvent.change(screen.getByLabelText('grid-auto-flow value'), { target: { value: 'dense' } })

    expect(inlineStylesOf(a)?.gridAutoFlow).toBe('dense')
    expect(inlineStylesOf(b)?.gridAutoFlow).toBe('dense')
  })
})

describe('StyleTargetChip — pinned to Element', () => {
  const REASON = 'Bulk edits write inline styles — class edits need a single selection'

  it('reads as the active, non-switchable target and drops the class selector', () => {
    render(<StyleTargetChip elementVisible lockedToElementReason={REASON} />)

    const chip = screen.getByTestId('style-target-chip')
    expect(chip.getAttribute('data-pinned-target')).toBe('element')

    const element = screen.getByTestId('style-target-chip-element')
    expect(element.getAttribute('aria-pressed')).toBe('true')
    expect(element.getAttribute('aria-disabled')).toBe('true')

    // No class selector is claimed — there is no single class to name.
    expect(screen.getByTestId('style-target-chip-class').textContent).toBe('Class')
  })

  it('states the reason on hover', () => {
    render(<StyleTargetChip elementVisible lockedToElementReason={REASON} />)
    fireEvent.mouseEnter(screen.getByTestId('style-target-chip-element'))
    expect(screen.getAllByRole('tooltip')[0].textContent).toContain('Bulk edits write inline styles')
  })

  it('behaves as before when not pinned', () => {
    render(
      <StyleTargetChip
        elementVisible={false}
        onToggleElement={() => {}}
        classSelector=".card"
        classCssEditability={{ kind: 'plain-css', file: 'src/Home.css' }}
      />,
    )
    const chip = screen.getByTestId('style-target-chip')
    expect(chip.getAttribute('data-pinned-target')).toBeNull()
    expect(screen.getByTestId('style-target-chip-class').textContent).toBe('.card')
  })
})
