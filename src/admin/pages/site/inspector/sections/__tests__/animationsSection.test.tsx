/**
 * AnimationsSection — Studio's own "Animations" section (`STATE.md`
 * `panel-25`, P3 item 11 — Studio extras).
 *
 * Mounts `<AnimationsSection />` against the store — same pattern every
 * migrated section's own test suite already established. No prior
 * component-level test existed for the pre-migration file either (it was
 * only reachable through `StyleSectionsEditor`, itself untested at the
 * component level for this section — see `animationValue.test.ts` for the
 * pure-fn coverage this file doesn't duplicate).
 *
 * Covers:
 *   1. Law 1 — nothing set anywhere renders the empty header (title + a
 *      single "+"), no resident list.
 *   2. The "+" menu adds a transition immediately (`all 200ms ease`), and
 *      the resulting entry renders in the list.
 *   3. Removing the transition entry clears it.
 *   4. Code-locked properties — the write is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { AnimationsSection } from '../AnimationsSection'
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

describe('AnimationsSection — Law 1', () => {
  it('renders the empty header with no resident list when nothing is set', () => {
    selectNode()
    render(<AnimationsSection />)

    expect(screen.getByText('Animations')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Animations' })).toBeNull()
    expect(screen.getByTestId('animations-section-add')).toBeTruthy()
  })

  it('shows the resident list directly (no menu needed) once a transition is set', () => {
    selectNode({ inlineStyles: { transition: 'all 200ms ease' } })
    render(<AnimationsSection />)

    expect(screen.getByRole('list', { name: 'Animations' })).toBeTruthy()
    expect(screen.getByText(/Transition/)).toBeTruthy()
  })
})

describe('AnimationsSection — add / remove a transition', () => {
  it('the "+" menu adds a transition immediately', () => {
    selectNode()
    render(<AnimationsSection />)

    fireEvent.click(screen.getByTestId('animations-section-add'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Transition' }))

    expect(currentNode()?.inlineStyles?.transition).toBe('all 200ms ease')
    expect(screen.getByRole('list', { name: 'Animations' })).toBeTruthy()
  })

  it('removing the transition entry clears it', () => {
    selectNode({ inlineStyles: { transition: 'all 200ms ease' } })
    render(<AnimationsSection />)

    fireEvent.click(screen.getByRole('button', { name: /remove transition/i }))

    expect(currentNode()?.inlineStyles?.transition).toBeUndefined()
  })
})

describe('AnimationsSection — code-locked properties', () => {
  it('refuses removal when transition is code-valued', () => {
    selectNode({
      inlineStyles: { transition: 'all 200ms ease' },
      codeProps: ['style:transition'],
    })
    render(<AnimationsSection />)

    fireEvent.click(screen.getByRole('button', { name: /remove transition/i }))

    expect(currentNode()?.inlineStyles?.transition).toBe('all 200ms ease')
  })
})
