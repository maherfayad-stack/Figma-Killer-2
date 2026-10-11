/**
 * UX-6 (P2-F) — the ClassPicker's bottom fade shows only once the Design tab
 * has scrolled.
 *
 * The fade used to hang over the top of the scroll area permanently, so at
 * rest — with nothing scrolled under the picker — it simply dimmed the Module
 * block's title. The CSS half (`opacity: 0` at rest, `1` under
 * `:has(~ [data-scrolled='true'])`) is pinned in
 * `src/__tests__/inspector/measurement.test.ts`, because happy-dom resolves
 * neither CSS Modules nor `:has()`. This file pins the other half: the scroll
 * container reports `data-scrolled` exactly while `scrollTop > 0`, and a
 * fresh selection does not inherit a stale value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PropertiesPanel } from '@site/panels/PropertiesPanel/PropertiesPanel'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: 'desktop',
    activeClassId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    focusedPanel: 'canvas',
  } as Parameters<typeof useEditorStore.setState>[0])
})

function selectTextNode(): void {
  const rootId = 'root-1'
  const nodeId = 'text-1'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
      [nodeId]: makeNode({ id: nodeId, moduleId: 'base.text', props: { text: 'Hello', tag: 'p' }, children: [] }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: nodeId,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function scrollTo(element: HTMLElement, top: number): void {
  element.scrollTop = top
  fireEvent.scroll(element)
}

describe('UX-6 — the scroll container reports whether anything is under the ClassPicker', () => {
  it('is unset at rest, set once scrolled, and unset again back at the top', () => {
    selectTextNode()
    render(<PropertiesPanel />)
    const scroll = screen.getByTestId('properties-panel-scroll')

    expect(scroll.hasAttribute('data-scrolled')).toBe(false)

    act(() => scrollTo(scroll, 40))
    expect(scroll.getAttribute('data-scrolled')).toBe('true')

    act(() => scrollTo(scroll, 0))
    expect(scroll.hasAttribute('data-scrolled')).toBe(false)
  })

  it('is a later sibling of the ClassPicker row, which is what the fade rule selects on', () => {
    selectTextNode()
    render(<PropertiesPanel />)
    const scroll = screen.getByTestId('properties-panel-scroll')
    const classInput = screen.getByRole('textbox', { name: /add or create a css selector/i })

    // The `.headerClassPicker:has(~ [data-scrolled='true'])` rule needs the
    // scroll container to follow the picker's own wrapper as a sibling.
    const pickerRow = Array.from(scroll.parentElement?.children ?? []).find(
      (child) => child !== scroll && child.contains(classInput),
    )
    expect(pickerRow).toBeDefined()
    expect(pickerRow!.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
