/**
 * P5-F / UX-9 — the nothing-selected Properties panel is the screen's own
 * properties, not one sentence: the open screen (with Copy as PNG) and the
 * two snap toggles, whose state it shows and flips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { EmptySelectionPanel } from '@site/panels/PropertiesPanel/EmptySelectionPanel'
import { DEFAULT_SNAP_PREFERENCES } from '@site/canvas/snapPreferences'
import { makeNode, makePage, makeSite } from '../fixtures'

beforeEach(() => {
  useEditorStore.setState({
    site: makeSite({ pages: [makePage({ id: 'home', title: 'Home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) } })] }),
    activePageId: 'home',
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    snapPreferences: DEFAULT_SNAP_PREFERENCES,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  useEditorStore.setState({ snapPreferences: DEFAULT_SNAP_PREFERENCES } as Parameters<typeof useEditorStore.setState>[0])
})

describe('UX-9 — the empty selection is the screen', () => {
  it('names the open screen and offers Copy as PNG', () => {
    render(<EmptySelectionPanel />)
    expect(screen.getByText('Home')).toBeTruthy()
    expect(screen.getByTestId('empty-selection-copy-png')).toBeTruthy()
  })

  it('shows the snap toggles and flips the same preference the keys do', () => {
    render(<EmptySelectionPanel />)
    const objects = screen.getByTestId('empty-selection-snap-objects')
    expect(objects.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(objects)
    expect(useEditorStore.getState().snapPreferences).toEqual({ objects: false, guides: true })
    fireEvent.click(screen.getByTestId('empty-selection-snap-guides'))
    expect(useEditorStore.getState().snapPreferences).toEqual({ objects: false, guides: false })
  })

  it('a Visual Component document has no screen to photograph', () => {
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', id: 'vc' } } as Parameters<typeof useEditorStore.setState>[0])
    render(<EmptySelectionPanel />)
    expect(screen.queryByTestId('empty-selection-copy-png')).toBeNull()
  })
})
