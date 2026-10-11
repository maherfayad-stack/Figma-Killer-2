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
  it('a root <svg> gets the Vector controls, writing into the layer’s own node', async () => {
    useEditorStore.setState({
      canvasLayerPages: {
        [`canvas:${LAYER_ID}`]: layer({ props: { svg: '<svg fill="none" stroke="currentColor"><path data-studio-svg-part="7:7" d="M0 0L9 9"/></svg>', tag: '' } }),
      },
      selectedCanvasLayerIds: [LAYER_ID],
    })
    render(<CanvasLayerInspector />)
    expect(await screen.findByTestId('vector-paint')).toBeTruthy()
    expect((screen.getByRole('combobox', { name: 'Stroke type' }) as HTMLInputElement).value).toBe('Current colour')
    expect((screen.getByRole('combobox', { name: 'Fill type' }) as HTMLInputElement).value).toBe('None')
  })

  it('any other root gets the style controls, filled from the element’s own inline styles', async () => {
    useEditorStore.setState({
      canvasLayerPages: {
        [`canvas:${LAYER_ID}`]: layer({
          moduleId: 'base.container',
          inlineStyles: { width: '120px', height: '80px', background: '#d9d9d9', borderRadius: '8px', border: '2px solid #ff0000', opacity: 0.5 },
        }),
      },
      selectedCanvasLayerIds: [LAYER_ID],
    })
    render(<CanvasLayerInspector />)
    expect(await screen.findByTestId('layer-style')).toBeTruthy()
    expect((screen.getByLabelText('Layer width') as HTMLInputElement).value).toBe('120')
    expect((screen.getByLabelText('Layer height') as HTMLInputElement).value).toBe('80')
    expect((screen.getByLabelText('Layer fill colour') as HTMLInputElement).value).toBe('#d9d9d9')
    expect((screen.getByLabelText('Layer stroke colour') as HTMLInputElement).value).toBe('#ff0000')
    expect((screen.getByLabelText('Layer stroke weight') as HTMLInputElement).value).toBe('2')
    expect((screen.getByLabelText('Layer corner radius') as HTMLInputElement).value).toBe('8')
    expect((screen.getByLabelText('Layer opacity') as HTMLInputElement).value).toBe('50')
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
