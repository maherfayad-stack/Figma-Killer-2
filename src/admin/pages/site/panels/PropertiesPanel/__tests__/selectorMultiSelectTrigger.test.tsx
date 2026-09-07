/**
 * The Selectors panel's checkbox set must reach TWO before the Properties
 * panel swaps in the bulk inspector (W8-3 phase 1).
 *
 * `isSelectorMultiSelect` used to be `selectedSelectorClassIds.length > 0`,
 * so ticking ONE checkbox handed a one-item set to `MultiSelectorInspector` —
 * a bulk action bar reading "1 class will be removed from every element" over
 * a one-row list, in place of the ordinary single-selector inspector the same
 * selection reaches by clicking the row instead of its checkbox. The layer
 * side of the panel has always used `> 1`; this is the selector side matching.
 *
 * Covers:
 *   1. Zero checked selectors → neither surface.
 *   2. One checked selector → the SINGLE-selector inspector, resolved from
 *      the checkbox set (`toggleSelectorMultiSelect` clears
 *      `selectedSelectorClassId`, so without this the one-box case would fall
 *      through to "nothing selected").
 *   3. Two checked selectors → the bulk surface.
 */
import { afterEach, describe, expect, it, beforeEach } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { usePropertiesPanelData } from '../usePropertiesPanelData'
import '@modules/base/index'

afterEach(cleanup)

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedSelectorClassId: null,
    selectedSelectorClassIds: [],
    activeClassId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

/** Seed a site with `count` classes and return their ids. */
function seedClasses(count: number): string[] {
  useEditorStore.getState().createSite('Selectors')
  return Array.from(
    { length: count },
    (_unused, i) => useEditorStore.getState().createClass(`c${i}`).id,
  )
}

describe('selector multi-select triggers at 2, not 1', () => {
  it('shows neither surface with no checked selectors', () => {
    seedClasses(2)
    const { result } = renderHook(() => usePropertiesPanelData())
    expect(result.current.isSelectorMultiSelect).toBe(false)
    expect(result.current.selectedSelectorClass).toBeNull()
  })

  it('routes ONE checked selector to the single-selector inspector', () => {
    const [a] = seedClasses(2)
    useEditorStore.getState().toggleSelectorMultiSelect(a)

    const { result } = renderHook(() => usePropertiesPanelData())

    expect(result.current.isSelectorMultiSelect).toBe(false)
    // Resolved from the checkbox set, since checking a box clears the
    // single-select id.
    expect(useEditorStore.getState().selectedSelectorClassId).toBeNull()
    expect(result.current.selectedSelectorClass?.id).toBe(a)
    expect(result.current.selectedSelectorClassId).toBe(a)
  })

  it('routes TWO checked selectors to the bulk inspector', () => {
    const [a, b] = seedClasses(2)
    useEditorStore.getState().toggleSelectorMultiSelect(a)
    useEditorStore.getState().toggleSelectorMultiSelect(b)

    const { result } = renderHook(() => usePropertiesPanelData())

    expect(result.current.isSelectorMultiSelect).toBe(true)
    expect(result.current.selectedSelectorClassIds).toEqual([a, b])
  })

  it('falls back to the single inspector when a set of two drops to one', () => {
    const [a, b] = seedClasses(2)
    useEditorStore.getState().toggleSelectorMultiSelect(a)
    useEditorStore.getState().toggleSelectorMultiSelect(b)
    useEditorStore.getState().toggleSelectorMultiSelect(b)

    const { result } = renderHook(() => usePropertiesPanelData())

    expect(result.current.isSelectorMultiSelect).toBe(false)
    expect(result.current.selectedSelectorClass?.id).toBe(a)
  })
})
