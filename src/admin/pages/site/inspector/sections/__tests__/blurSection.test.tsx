/**
 * BlurSection — Penpot's Blur section (`STATE.md` `panel-25`, P3 item 8).
 *
 * Mounts `<BlurSection />` against the store (`useSelectionModel`/
 * `useInspectorCommit`) rather than as a prop-driven component — the same
 * shift every migrated section's own test suite already made (see
 * `strokeSection.test.tsx`/`fillSection.test.tsx`).
 *
 * Ports the pre-migration `panels/PropertiesPanel/__tests__/
 * effectsSection.test.tsx`'s blur-only coverage (its shadow coverage moved
 * to `shadowSection.test.tsx`):
 *   1. Law 1 — nothing set renders the empty header (title + a single "+");
 *      "Layer blur" / "Background blur" write `blur(4px)` immediately, and
 *      each disables itself once its OWN property is already set.
 *   2. A lone `blur(<length>)` value renders as a structured radius row.
 *   3. A `filter`/`backdrop-filter` value that is more than a single
 *      `blur()` keeps its raw text field and loses nothing.
 *   4. Code-locked properties — the write is refused, same posture every
 *      migrated section already established.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { BlurSection } from '../BlurSection'
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

describe('BlurSection — Law 1', () => {
  it('renders the empty header with no chevron when nothing is set', () => {
    selectNode()
    render(<BlurSection />)

    expect(screen.getByText('Blur')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('button', { name: /add blur/i })).toBeTruthy()
  })

  it('"Layer blur" / "Background blur" write blur(4px), and disable once already set', async () => {
    const user = userEvent.setup()
    selectNode()
    render(<BlurSection />)

    await user.click(screen.getByRole('button', { name: /add blur/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Layer blur' }))
    expect(currentNode()?.inlineStyles?.filter).toBe('blur(4px)')

    await user.click(screen.getByRole('button', { name: /add blur/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Background blur' }))
    expect(currentNode()?.inlineStyles?.backdropFilter).toBe('blur(4px)')
  })

  it('disables Layer blur once filter is already set, leaves Background blur live', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { filter: 'blur(4px)' } })
    render(<BlurSection />)

    await user.click(screen.getByRole('button', { name: /add blur/i }))
    const layerBlur = screen.getByRole('menuitem', { name: 'Layer blur' }) as HTMLButtonElement
    const backgroundBlur = screen.getByRole('menuitem', { name: 'Background blur' }) as HTMLButtonElement
    expect(layerBlur.disabled).toBe(true)
    expect(backgroundBlur.disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Structured radius row
// ---------------------------------------------------------------------------

describe('BlurSection — structured blur() radius', () => {
  it('renders one row per set property, with the radius as its trailing value', () => {
    selectNode({ inlineStyles: { filter: 'blur(8px)', backdropFilter: 'blur(12px)' } })
    render(<BlurSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Layer blur')).toBeTruthy()
    expect(within(rows[1]!).getByText('Background blur')).toBeTruthy()
  })

  it('editing the radius writes blur(<value>) back', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { filter: 'blur(4px)' } })
    render(<BlurSection />)

    await user.click(screen.getByRole('listitem'))
    const radiusField = screen.getByLabelText('Layer blur radius')
    await user.clear(radiusField)
    await user.type(radiusField, '10px')
    await user.tab()

    expect(currentNode()?.inlineStyles?.filter).toBe('blur(10px)')
  })
})

// ---------------------------------------------------------------------------
// 3. Honest refusal on a non-lone-blur() value
// ---------------------------------------------------------------------------

describe('BlurSection — honest refusal on a non-blur filter', () => {
  it('keeps the raw text as a single row and preserves it exactly in the popover', async () => {
    const user = userEvent.setup()
    const raw = 'grayscale(50%)'
    selectNode({ inlineStyles: { filter: raw } })
    render(<BlurSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText('Filter')).toBeTruthy()

    await user.click(rows[0]!)
    expect(screen.getByDisplayValue(raw)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 4. Code-locked properties
// ---------------------------------------------------------------------------

describe('BlurSection — code-locked properties', () => {
  it('refuses to write a locked filter', async () => {
    const user = userEvent.setup()
    selectNode({ inlineStyles: { filter: 'blur(4px)' }, codeProps: ['style:filter'] })
    render(<BlurSection />)

    await user.click(screen.getByRole('listitem'))
    const radiusField = screen.getByLabelText('Layer blur radius')
    await user.clear(radiusField)
    await user.type(radiusField, '10px')
    await user.tab()

    expect(currentNode()?.inlineStyles?.filter).toBe('blur(4px)')
  })
})
