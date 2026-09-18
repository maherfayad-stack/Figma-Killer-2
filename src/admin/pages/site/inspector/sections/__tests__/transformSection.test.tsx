/**
 * TransformSection — Studio's own "Transform" section (`STATE.md`
 * `panel-25`, P3 item 11 — Studio extras).
 *
 * Mounts `<TransformSection />` against the store (`useSelectionModel`/
 * `useInspectorCommit`) — the same pattern every migrated section's own
 * test suite already established (see `strokeSection.test.tsx`/
 * `blurSection.test.tsx`). No prior test existed (the pre-migration file
 * had no dedicated component — see `TransformSection.tsx`'s own doc).
 *
 * Covers:
 *   1. Law 1 — nothing set renders the empty header (title + a single "+"),
 *      no resident controls; clicking "+" reveals the resident rows without
 *      writing anything.
 *   2. `transform`/`transformOrigin` round-trip through the resident rows
 *      once set.
 *   3. Code-locked properties — the write is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { TransformSection } from '../TransformSection'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const NODE_ID = 'node-1'
const ROOT_ID = 'root'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

function selectNode(overrides: Parameters<typeof makeNode>[0] = {}) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.div', ...overrides }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: NODE_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function currentNode() {
  return useEditorStore.getState().site?.pages[0]?.nodes[NODE_ID]
}

describe('TransformSection — Law 1', () => {
  it('renders the empty header with no resident controls when nothing is set', () => {
    selectNode()
    render(<TransformSection />)

    expect(screen.getByText('Transform')).toBeTruthy()
    expect(screen.queryByTestId('css-property-row-transform')).toBeNull()
    expect(screen.getByRole('button', { name: /add transform/i })).toBeTruthy()
  })

  it('clicking "+" reveals the resident rows without writing anything', () => {
    selectNode()
    render(<TransformSection />)

    fireEvent.click(screen.getByRole('button', { name: /add transform/i }))

    expect(screen.getByTestId('css-property-row-transform')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-transformOrigin')).toBeTruthy()
    expect(currentNode()?.inlineStyles?.transform).toBeUndefined()
  })

  it('shows the resident rows directly (no "+" needed) once transform is set', () => {
    selectNode({ inlineStyles: { transform: 'rotate(10deg)' } })
    render(<TransformSection />)

    expect(screen.queryByRole('button', { name: /add transform/i })).toBeNull()
    expect(screen.getByTestId('css-property-row-transform')).toBeTruthy()
  })
})

describe('TransformSection — round-trip', () => {
  it('writes transform through the resident text row', () => {
    selectNode()
    render(<TransformSection />)
    fireEvent.click(screen.getByRole('button', { name: /add transform/i }))

    const field = screen.getByTestId('css-property-row-transform').querySelector('input')!
    fireEvent.change(field, { target: { value: 'scale(1.2)' } })
    fireEvent.blur(field)

    expect(currentNode()?.inlineStyles?.transform).toBe('scale(1.2)')
  })
})

describe('TransformSection — code-locked properties', () => {
  it('refuses a transform write when transform is code-valued', () => {
    selectNode({
      inlineStyles: { transform: 'rotate(10deg)' },
      codeProps: ['style:transform'],
    })
    render(<TransformSection />)

    const field = screen.getByTestId('css-property-row-transform').querySelector('input')!
    fireEvent.change(field, { target: { value: 'scale(2)' } })
    fireEvent.blur(field)

    expect(currentNode()?.inlineStyles?.transform).toBe('rotate(10deg)')
  })
})
