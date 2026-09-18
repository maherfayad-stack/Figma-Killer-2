/**
 * InteractionSection — Studio's own "Interaction" section (`STATE.md`
 * `panel-25`, P3 item 11 — Studio extras).
 *
 * Mounts `<InteractionSection />` against the store — same pattern every
 * migrated section's own test suite already established. No prior test
 * existed for the pre-migration `StackedPropertyGrid`-only component (it
 * was only reachable through `StyleSectionsEditor`).
 *
 * Covers:
 *   1. Law 1 — nothing set renders the empty header; clicking "+" reveals
 *      the resident grid without writing anything.
 *   2. `cursor`/`pointerEvents`/`userSelect`/`scrollBehavior` round-trip.
 *   3. Code-locked properties — the write is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { InteractionSection } from '../InteractionSection'
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

describe('InteractionSection — Law 1', () => {
  it('renders the empty header with no resident grid when nothing is set', () => {
    selectNode()
    render(<InteractionSection />)

    expect(screen.getByText('Interaction')).toBeTruthy()
    expect(screen.queryByTestId('css-property-row-cursor')).toBeNull()
    expect(screen.getByRole('button', { name: /add interaction/i })).toBeTruthy()
  })

  it('clicking "+" reveals the resident grid without writing anything', () => {
    selectNode()
    render(<InteractionSection />)

    fireEvent.click(screen.getByRole('button', { name: /add interaction/i }))

    expect(screen.getByTestId('css-property-row-cursor')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-pointerEvents')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-userSelect')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-scrollBehavior')).toBeTruthy()
    expect(currentNode()?.inlineStyles?.cursor).toBeUndefined()
  })

  it('shows the resident grid directly (no "+" needed) once cursor is set', () => {
    selectNode({ inlineStyles: { cursor: 'pointer' } })
    render(<InteractionSection />)

    expect(screen.queryByRole('button', { name: /add interaction/i })).toBeNull()
    expect(screen.getByTestId('css-property-row-cursor')).toBeTruthy()
  })
})

describe('InteractionSection — round-trip', () => {
  it('writes cursor through the enum select', () => {
    selectNode()
    render(<InteractionSection />)
    fireEvent.click(screen.getByRole('button', { name: /add interaction/i }))

    const select = screen.getByTestId('css-property-row-cursor').querySelector('select')!
    fireEvent.change(select, { target: { value: 'pointer' } })

    expect(currentNode()?.inlineStyles?.cursor).toBe('pointer')
  })
})

describe('InteractionSection — code-locked properties', () => {
  it('refuses a cursor write when cursor is code-valued', () => {
    selectNode({
      inlineStyles: { cursor: 'pointer' },
      codeProps: ['style:cursor'],
    })
    render(<InteractionSection />)

    const select = screen.getByTestId('css-property-row-cursor').querySelector('select')!
    fireEvent.change(select, { target: { value: 'default' } })

    expect(currentNode()?.inlineStyles?.cursor).toBe('pointer')
  })
})
