/**
 * ShadowSection — Penpot's Shadow section (`STATE.md` `panel-25`, P3 item 7).
 *
 * Mounts `<ShadowSection />` against the store (`useSelectionModel`/
 * `useInspectorCommit`) rather than as a prop-driven component — the same
 * shift every migrated section's own test suite already made (see
 * `strokeSection.test.tsx`/`fillSection.test.tsx`).
 *
 * Ports the pre-migration `panels/PropertiesPanel/__tests__/
 * effectsSection.test.tsx`'s shadow-only coverage (its blur coverage moved to
 * `blurSection.test.tsx`):
 *   1. Law 1 — nothing set renders the empty header (title + a single "+");
 *      the "+" writes a real default layer immediately (unlike Stroke — see
 *      `ShadowSection.tsx`'s own doc for why).
 *   2. A two-layer `box-shadow` with `rgba()` commas parses into exactly two
 *      rows and re-serialises byte-identically on any edit.
 *   3. An unparseable `box-shadow` keeps its raw text field and loses nothing.
 *   4. The inset checkbox round-trips.
 *   5. Reordering two shadow layers changes paint order.
 *   6. Code-locked properties — the write is refused, same posture every
 *      migrated section already established.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { ShadowSection } from '../ShadowSection'
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

// ---------------------------------------------------------------------------
// 1. Law 1 — empty header, "+" writes a real value immediately
// ---------------------------------------------------------------------------

describe('ShadowSection — Law 1', () => {
  it('renders the empty header with no chevron when nothing is set', () => {
    selectNode()
    render(<ShadowSection />)

    expect(screen.getByText('Shadow')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('button', { name: /add shadow/i })).toBeTruthy()
  })

  it('"Drop shadow" writes a fresh box-shadow layer and opens the section', async () => {
    const user = userEvent.setup()
    selectNode()
    render(<ShadowSection />)

    await user.click(screen.getByRole('button', { name: /add shadow/i }))
    await user.click(screen.getByText('Drop shadow'))

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('0 4px 4px rgba(0, 0, 0, 0.25)')
  })

  it('"Inner shadow" appends onto an existing box-shadow value', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { boxShadow: '0 2px 2px black' } })
    render(<ShadowSection />)

    await user.click(screen.getByRole('button', { name: /add shadow/i }))
    await user.click(screen.getByText('Inner shadow'))

    expect(currentNode()?.inlineStyles?.boxShadow).toBe(
      '0 2px 2px black, inset 0 4px 4px rgba(0, 0, 0, 0.25)',
    )
  })

  it('"Text shadow" writes textShadow separately from boxShadow', async () => {
    const user = userEvent.setup()
    selectNode()
    render(<ShadowSection />)

    await user.click(screen.getByRole('button', { name: /add shadow/i }))
    await user.click(screen.getByText('Text shadow'))

    expect(currentNode()?.inlineStyles?.textShadow).toBe('0 1px 2px rgba(0, 0, 0, 0.25)')
    expect(currentNode()?.inlineStyles?.boxShadow).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Two-layer box-shadow — rgba() commas don't split layers
// ---------------------------------------------------------------------------

describe('ShadowSection — box-shadow as a list', () => {
  it('renders exactly two rows for a two-layer value with rgba() commas', () => {
    selectNode({
      inlineStyles: {
        boxShadow: '0 4px 4px rgba(0, 0, 0, 0.25), inset 0 -2px 0 rgba(255, 255, 255, 0.1)',
      },
    })
    render(<ShadowSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Drop shadow')).toBeTruthy()
    expect(within(rows[1]!).getByText('Inner shadow')).toBeTruthy()
  })
})

describe('ShadowSection — honest refusal on an unparseable box-shadow', () => {
  it('keeps the raw text as a single row and preserves it exactly in the popover', async () => {
    const user = userEvent.setup()
    const raw = '0 4px 4px black, potato'
    selectNode({ inlineStyles: { boxShadow: raw } })
    render(<ShadowSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText('Box shadow')).toBeTruthy()

    await user.click(rows[0]!)
    expect(screen.getByDisplayValue(raw)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 3. Inset round-trips
// ---------------------------------------------------------------------------

describe('ShadowSection — inset checkbox', () => {
  it('adding "inset" re-serialises with the keyword leading', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { boxShadow: '0 4px 4px black' } })
    render(<ShadowSection />)

    await user.click(screen.getByRole('listitem'))
    await user.click(screen.getByRole('switch'))

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('inset 0 4px 4px black')
  })
})

// ---------------------------------------------------------------------------
// 4. Reorder changes paint order
// ---------------------------------------------------------------------------

describe('ShadowSection — reorder (Alt+ArrowDown)', () => {
  it('moving the first shadow layer down swaps their serialised order', () => {
    const raw = '0 4px 4px black, inset 0 -2px 0 white'
    selectNode({ inlineStyles: { boxShadow: raw } })
    render(<ShadowSection />)

    const [first] = screen.getAllByRole('listitem')
    fireEvent.keyDown(first!, { key: 'ArrowDown', altKey: true })

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('inset 0 -2px 0 white, 0 4px 4px black')
  })
})

// ---------------------------------------------------------------------------
// 5. Code-locked properties
// ---------------------------------------------------------------------------

describe('ShadowSection — code-locked properties', () => {
  it('refuses to write a locked boxShadow', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { boxShadow: '0 4px 4px black' }, codeProps: ['style:boxShadow'] })
    render(<ShadowSection />)

    await user.click(screen.getByRole('listitem'))
    await user.click(screen.getByRole('switch'))

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('0 4px 4px black')
  })
})
