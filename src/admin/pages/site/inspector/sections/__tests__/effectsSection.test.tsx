/**
 * EffectsSection — shadows and blurs in one section (P2-F, owner decision
 * OD-4). Merges the former `shadowSection.test.tsx` and `blurSection.test.tsx`
 * — every case they pinned still runs, against the one section and its one
 * `+` menu — plus the facts the merge itself introduces:
 *
 *   0. One header titled "Effects", one "Add effect" trigger whose menu
 *      offers all five effect kinds, and one list holding shadow AND blur
 *      rows together; a reorder never crosses from a shadow onto a blur.
 *   1. Law 1 — nothing set renders the empty header (title + a single "+");
 *      each menu item writes a real default immediately, and a blur item
 *      disables once its own property is set.
 *   2. A two-layer `box-shadow` with `rgba()` commas parses into exactly two
 *      rows; a lone `blur()` is a structured radius row.
 *   3. An unparseable `box-shadow`, or a `filter` that is more than one
 *      `blur()`, keeps its raw text field and loses nothing.
 *   4. The inset switch round-trips; reordering shadow layers changes paint
 *      order.
 *   5. Code-locked properties — the write is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { EffectsSection } from '../EffectsSection'
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
// 0. One section
// ---------------------------------------------------------------------------

describe('EffectsSection — one section for shadows and blurs', () => {
  it('renders one "Effects" header and one add trigger offering every effect kind', async () => {
    const user = userEvent.setup()
    selectNode()
    render(<EffectsSection />)

    expect(screen.getByText('Effects')).toBeTruthy()
    expect(screen.queryByText('Shadow')).toBeNull()
    expect(screen.queryByText('Blur')).toBeNull()
    expect(screen.getAllByRole('button', { name: /add effect/i })).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /add effect/i }))
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual(['Drop shadow', 'Inner shadow', 'Text shadow', 'Layer blur', 'Background blur'])
  })

  it('lists shadow rows before blur rows, in one list', () => {
    selectNode({ inlineStyles: { boxShadow: '0 4px 4px black', filter: 'blur(8px)' } })
    render(<EffectsSection />)

    expect(screen.getAllByRole('list')).toHaveLength(1)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Drop shadow')).toBeTruthy()
    expect(within(rows[1]!).getByText('Layer blur')).toBeTruthy()
  })

  it('ignores a reorder that would move a shadow onto a blur row', () => {
    selectNode({ inlineStyles: { boxShadow: '0 4px 4px black', filter: 'blur(8px)' } })
    render(<EffectsSection />)

    const [shadowRow] = screen.getAllByRole('listitem')
    fireEvent.keyDown(shadowRow!, { key: 'ArrowDown', altKey: true })

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('0 4px 4px black')
    expect(currentNode()?.inlineStyles?.filter).toBe('blur(8px)')
  })
})

// ---------------------------------------------------------------------------
// 1. Law 1 — empty header, "+" writes a real value immediately
// ---------------------------------------------------------------------------

describe('EffectsSection — shadows, Law 1', () => {
  it('renders the empty header with no chevron when nothing is set', () => {
    selectNode()
    render(<EffectsSection />)

    expect(screen.getByText('Effects')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('button', { name: /add effect/i })).toBeTruthy()
  })

  it('"Drop shadow" writes a fresh box-shadow layer and opens the section', async () => {
    const user = userEvent.setup()
    selectNode()
    render(<EffectsSection />)

    await user.click(screen.getByRole('button', { name: /add effect/i }))
    await user.click(screen.getByText('Drop shadow'))

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('0 4px 4px rgba(0, 0, 0, 0.25)')
  })

  it('"Inner shadow" appends onto an existing box-shadow value', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { boxShadow: '0 2px 2px black' } })
    render(<EffectsSection />)

    await user.click(screen.getByRole('button', { name: /add effect/i }))
    await user.click(screen.getByText('Inner shadow'))

    expect(currentNode()?.inlineStyles?.boxShadow).toBe(
      '0 2px 2px black, inset 0 4px 4px rgba(0, 0, 0, 0.25)',
    )
  })

  it('"Text shadow" writes textShadow separately from boxShadow', async () => {
    const user = userEvent.setup()
    selectNode()
    render(<EffectsSection />)

    await user.click(screen.getByRole('button', { name: /add effect/i }))
    await user.click(screen.getByText('Text shadow'))

    expect(currentNode()?.inlineStyles?.textShadow).toBe('0 1px 2px rgba(0, 0, 0, 0.25)')
    expect(currentNode()?.inlineStyles?.boxShadow).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Two-layer box-shadow — rgba() commas don't split layers
// ---------------------------------------------------------------------------

describe('EffectsSection — box-shadow as a list', () => {
  it('renders exactly two rows for a two-layer value with rgba() commas', () => {
    selectNode({
      inlineStyles: {
        boxShadow: '0 4px 4px rgba(0, 0, 0, 0.25), inset 0 -2px 0 rgba(255, 255, 255, 0.1)',
      },
    })
    render(<EffectsSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Drop shadow')).toBeTruthy()
    expect(within(rows[1]!).getByText('Inner shadow')).toBeTruthy()
  })
})

describe('EffectsSection — honest refusal on an unparseable box-shadow', () => {
  it('keeps the raw text as a single row and preserves it exactly in the popover', async () => {
    const user = userEvent.setup()
    const raw = '0 4px 4px black, potato'
    selectNode({ inlineStyles: { boxShadow: raw } })
    render(<EffectsSection />)

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

describe('EffectsSection — inset checkbox', () => {
  it('adding "inset" re-serialises with the keyword leading', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { boxShadow: '0 4px 4px black' } })
    render(<EffectsSection />)

    await user.click(screen.getByRole('listitem'))
    await user.click(screen.getByRole('switch'))

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('inset 0 4px 4px black')
  })
})

// ---------------------------------------------------------------------------
// 4. Reorder changes paint order
// ---------------------------------------------------------------------------

describe('EffectsSection — reorder (Alt+ArrowDown)', () => {
  it('moving the first shadow layer down swaps their serialised order', () => {
    const raw = '0 4px 4px black, inset 0 -2px 0 white'
    selectNode({ inlineStyles: { boxShadow: raw } })
    render(<EffectsSection />)

    const [first] = screen.getAllByRole('listitem')
    fireEvent.keyDown(first!, { key: 'ArrowDown', altKey: true })

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('inset 0 -2px 0 white, 0 4px 4px black')
  })
})

// ---------------------------------------------------------------------------
// 5. Code-locked properties
// ---------------------------------------------------------------------------

describe('EffectsSection — code-locked boxShadow', () => {
  it('refuses to write a locked boxShadow', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { boxShadow: '0 4px 4px black' }, codeProps: ['style:boxShadow'] })
    render(<EffectsSection />)

    await user.click(screen.getByRole('listitem'))
    await user.click(screen.getByRole('switch'))

    expect(currentNode()?.inlineStyles?.boxShadow).toBe('0 4px 4px black')
  })
})

// ---------------------------------------------------------------------------
// 1b. Law 1 (blurs) — empty header, "+" writes a real value immediately
// ---------------------------------------------------------------------------

describe('EffectsSection — blurs, Law 1', () => {
  it('"Layer blur" / "Background blur" write blur(4px), and disable once already set', async () => {
    const user = userEvent.setup()
    selectNode()
    render(<EffectsSection />)

    await user.click(screen.getByRole('button', { name: /add effect/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Layer blur' }))
    expect(currentNode()?.inlineStyles?.filter).toBe('blur(4px)')

    await user.click(screen.getByRole('button', { name: /add effect/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Background blur' }))
    expect(currentNode()?.inlineStyles?.backdropFilter).toBe('blur(4px)')
  })

  it('disables Layer blur once filter is already set, leaves Background blur live', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { filter: 'blur(4px)' } })
    render(<EffectsSection />)

    await user.click(screen.getByRole('button', { name: /add effect/i }))
    // `Button` turns `disabled` + `tooltip` into `aria-disabled`, so the
    // reason ("already has a filter") can still be hovered.
    const layerBlur = screen.getByRole('menuitem', { name: 'Layer blur' })
    const backgroundBlur = screen.getByRole('menuitem', { name: 'Background blur' })
    expect(layerBlur.getAttribute('aria-disabled')).toBe('true')
    expect(backgroundBlur.getAttribute('aria-disabled')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2b. Structured radius row
// ---------------------------------------------------------------------------

describe('EffectsSection — structured blur() radius', () => {
  it('renders one row per set property, with the radius as its trailing value', () => {
    selectNode({ inlineStyles: { filter: 'blur(8px)', backdropFilter: 'blur(12px)' } })
    render(<EffectsSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Layer blur')).toBeTruthy()
    expect(within(rows[1]!).getByText('Background blur')).toBeTruthy()
  })

  it('editing the radius writes blur(<value>) back', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { filter: 'blur(4px)' } })
    render(<EffectsSection />)

    await user.click(screen.getByRole('listitem'))
    const radiusField = screen.getByLabelText('Layer blur radius')
    await user.clear(radiusField)
    await user.type(radiusField, '10px')
    await user.tab()

    expect(currentNode()?.inlineStyles?.filter).toBe('blur(10px)')
  })
})

// ---------------------------------------------------------------------------
// 3b. Honest refusal on a non-lone-blur() value
// ---------------------------------------------------------------------------

describe('EffectsSection — honest refusal on a non-blur filter', () => {
  it('keeps the raw text as a single row and preserves it exactly in the popover', async () => {
    const user = userEvent.setup()
    const raw = 'grayscale(50%)'
    selectNode({ inlineStyles: { filter: raw } })
    render(<EffectsSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText('Filter')).toBeTruthy()

    await user.click(rows[0]!)
    expect(screen.getByDisplayValue(raw)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 5b. Code-locked properties
// ---------------------------------------------------------------------------

describe('EffectsSection — code-locked filter', () => {
  it('refuses to write a locked filter', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { filter: 'blur(4px)' }, codeProps: ['style:filter'] })
    render(<EffectsSection />)

    await user.click(screen.getByRole('listitem'))
    const radiusField = screen.getByLabelText('Layer blur radius')
    await user.clear(radiusField)
    await user.type(radiusField, '10px')
    await user.tab()

    expect(currentNode()?.inlineStyles?.filter).toBe('blur(4px)')
  })
})
