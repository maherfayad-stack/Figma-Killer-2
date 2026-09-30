/**
 * CanvasLayerInspector — the Properties body for a selected loose layer.
 * Before it, selecting a vector drawn on the empty board CLOSED the panel
 * (the selection hook and the right-sidebar selector knew nodes, selectors
 * and frames only), so its fill and stroke had no control anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { Page, PageNode } from '@core/page-tree'
import { selectRightSidebarExpanded, useEditorStore } from '@site/store/store'
import { CanvasLayerInspector } from '../CanvasLayerInspector'
import { makePage } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const LAYER_ID = 'claaaaaaaaaa'
const ROOT = `.studio/canvas/${LAYER_ID}.tsx:6:5`

function layer(root: Partial<PageNode>): Page {
  const body = `canvas:${LAYER_ID}:body`
  return makePage({
    id: `canvas:${LAYER_ID}`,
    rootNodeId: body,
    nodes: {
      [body]: { id: body, moduleId: 'base.body', props: {}, children: [ROOT], classIds: [], breakpointOverrides: {} },
      [ROOT]: { id: ROOT, moduleId: 'base.svg', props: {}, children: [], classIds: [], breakpointOverrides: {}, parentId: body, ...root },
    },
  })
}

afterEach(cleanup)

beforeEach(() => {
  useEditorStore.setState({ selectedNodeId: null, selectedNodeIds: [], selectedCanvasLayerIds: [], canvasLayerPages: {} })
})

describe('CanvasLayerInspector', () => {
  it('a root <svg> gets the Vector controls, writing into the layer’s own node', () => {
    useEditorStore.setState({
      canvasLayerPages: {
        [`canvas:${LAYER_ID}`]: layer({ props: { svg: '<svg fill="none" stroke="currentColor"><path data-studio-svg-part="7:7" d="M0 0L9 9"/></svg>', tag: '' } }),
      },
      selectedCanvasLayerIds: [LAYER_ID],
    })
    render(<CanvasLayerInspector />)
    expect(screen.getByTestId('vector-paint')).toBeTruthy()
    expect((screen.getByRole('combobox', { name: 'Stroke type' }) as HTMLInputElement).value).toBe('Current colour')
    expect((screen.getByRole('combobox', { name: 'Fill type' }) as HTMLInputElement).value).toBe('None')
  })

  it('any other root says where its styles are edited, rather than offering controls that would miss', () => {
    useEditorStore.setState({
      canvasLayerPages: { [`canvas:${LAYER_ID}`]: layer({ moduleId: 'base.image', props: { src: '/a.png' } }) },
      selectedCanvasLayerIds: [LAYER_ID],
    })
    render(<CanvasLayerInspector />)
    expect(screen.getByTestId('canvas-layer-inspector').textContent).toContain('edited inside a frame for now')
    expect(screen.queryByTestId('vector-paint')).toBeNull()
  })

  it('a loose-layer selection keeps the docked right sidebar open', () => {
    useEditorStore.setState({ propertiesPanelMode: 'docked', selectedCanvasLayerIds: [LAYER_ID] })
    useEditorStore.setState((state) => {
      state.propertiesPanel.collapsed = false
    })
    expect(selectRightSidebarExpanded(useEditorStore.getState())).toBe(true)
  })
})
