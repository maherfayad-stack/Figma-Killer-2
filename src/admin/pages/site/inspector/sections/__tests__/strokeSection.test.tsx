/**
 * StrokeSection — Penpot's Stroke section (`STATE.md` `panel-25`, P3 item 6).
 *
 * Mounts `<StrokeSection />` against the store (`useSelectionModel`/
 * `useInspectorCommit`) rather than as a prop-driven component — the same
 * shift every migrated section's own test suite already made (see
 * `measuresSection.test.tsx`/`fillSection.test.tsx`).
 *
 * Covers, ported from the pre-migration `panels/PropertiesPanel/
 * __tests__/strokeSection.test.tsx`:
 *   1. Law 1 — nothing set renders the empty header (title + a single "+"),
 *      no resident controls, no chevron; clicking "+" reveals the resident
 *      row without writing anything.
 *   2. The colour entry appears once any border longhand is set, and its
 *      inline `%` opacity field (`02-measurements.md`'s "Color field
 *      chrome" — NEW in this migration, closing the same gap Fill's own
 *      migration closed for fill/stroke rows).
 *   3. The sides menu's "All sides" / "Custom" items (F18/F19).
 *   4. The ⚙ settings popover reaches `borderStyle`, `outline`,
 *      `outlineOffset`.
 *   5. Stroke position ships only the two CSS-honest values.
 *   6. Code-locked properties — the write is refused, same posture every
 *      migrated section already established.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { StrokeSection } from '../StrokeSection'
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
// 1. Law 1 — empty renders one line, "+" reveals without writing
// ---------------------------------------------------------------------------

describe('StrokeSection — Law 1', () => {
  it('renders the empty header with no chevron and no resident controls when nothing is set', () => {
    selectNode()
    render(<StrokeSection />)

    expect(screen.getByText('Stroke')).toBeTruthy()
    expect(screen.queryByRole('button', { expanded: true })).toBeNull()
    expect(screen.queryByTestId('stroke-position')).toBeNull()
    expect(screen.getByRole('button', { name: /add stroke/i })).toBeTruthy()
  })

  it('clicking "+" reveals the resident row without writing anything', () => {
    selectNode()
    render(<StrokeSection />)

    fireEvent.click(screen.getByRole('button', { name: /add stroke/i }))

    expect(screen.getByTestId('stroke-position')).toBeTruthy()
    expect(screen.getByTestId('stroke-weight-all')).toBeTruthy()
    expect(screen.getByTestId('stroke-settings-trigger')).toBeTruthy()
    expect(screen.getByTestId('stroke-sides-trigger')).toBeTruthy()
    expect(currentNode()?.inlineStyles?.borderTopWidth).toBeUndefined()
  })

  it('shows the resident row directly (no "+" needed) once any border longhand is set', () => {
    selectNode({
      inlineStyles: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: '#ff0000' },
    })
    render(<StrokeSection />)

    expect(screen.queryByRole('button', { name: /add stroke/i })).toBeNull()
    expect(screen.getByTestId('stroke-position')).toBeTruthy()
    expect(screen.getByLabelText('Stroke color')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 2. Colour entry + the Color field chrome's `%` opacity field
// ---------------------------------------------------------------------------

describe('StrokeSection — colour entry', () => {
  it("the colour entry's remove button clears every side's width/style/color", () => {
    selectNode({
      inlineStyles: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: '#ff0000' },
    })
    render(<StrokeSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Stroke' }))

    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      for (const field of ['Width', 'Style', 'Color']) {
        expect(currentNode()?.inlineStyles?.[`border${side}${field}`]).toBeUndefined()
      }
    }
  })

  it('shows an inline `%` opacity field once a real colour is stored', () => {
    selectNode({
      inlineStyles: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: '#112233' },
    })
    render(<StrokeSection />)

    const row = screen.getByRole('listitem')
    expect(within(row).getByRole('textbox', { name: 'Stroke color opacity' })).toHaveProperty('value', '100')
  })

  it('the opacity field commits the alpha channel to every side', () => {
    selectNode({
      inlineStyles: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: '#112233' },
    })
    render(<StrokeSection />)

    const opacity = screen.getByRole('textbox', { name: 'Stroke color opacity' })
    fireEvent.focus(opacity)
    fireEvent.change(opacity, { target: { value: '50' } })
    fireEvent.blur(opacity)

    expect(currentNode()?.inlineStyles?.borderTopColor).toBe('#11223380')
    expect(currentNode()?.inlineStyles?.borderRightColor).toBe('#11223380')
    expect(currentNode()?.inlineStyles?.borderBottomColor).toBe('#11223380')
    expect(currentNode()?.inlineStyles?.borderLeftColor).toBe('#11223380')
  })

  it('omits the opacity field when only weight is set (no real colour stored yet)', () => {
    selectNode({ inlineStyles: { borderTopWidth: '2px' } })
    render(<StrokeSection />)

    expect(screen.queryByRole('textbox', { name: 'Stroke color opacity' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. Sides menu (F18) → Custom (F19)
// ---------------------------------------------------------------------------

describe('StrokeSection — sides menu', () => {
  it('"All sides" writes the current weight to all four side-width longhands', () => {
    selectNode({ inlineStyles: { borderTopWidth: '3px' } })
    render(<StrokeSection />)

    fireEvent.click(screen.getByTestId('stroke-sides-trigger'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'All sides' }))

    expect(currentNode()?.inlineStyles?.borderTopWidth).toBe('3px')
    expect(currentNode()?.inlineStyles?.borderRightWidth).toBe('3px')
    expect(currentNode()?.inlineStyles?.borderBottomWidth).toBe('3px')
    expect(currentNode()?.inlineStyles?.borderLeftWidth).toBe('3px')
  })

  it('"Custom" reveals four independent weight fields and writes nothing on its own', () => {
    selectNode()
    render(<StrokeSection />)
    fireEvent.click(screen.getByRole('button', { name: /add stroke/i }))

    expect(screen.queryByTestId('stroke-weight-top')).toBeNull()

    fireEvent.click(screen.getByTestId('stroke-sides-trigger'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Custom' }))

    expect(screen.getByTestId('stroke-weight-top')).toBeTruthy()
    expect(screen.getByTestId('stroke-weight-right')).toBeTruthy()
    expect(screen.getByTestId('stroke-weight-bottom')).toBeTruthy()
    expect(screen.getByTestId('stroke-weight-left')).toBeTruthy()
    expect(screen.queryByTestId('stroke-weight-all')).toBeNull()

    expect(currentNode()?.inlineStyles?.borderTopWidth).toBeUndefined()
  })

  it('editing one of the four Custom fields writes only that side', () => {
    selectNode({ inlineStyles: { borderTopWidth: '2px', borderRightWidth: '4px' } })
    render(<StrokeSection />)

    // Sides already disagree, so the Custom view is showing without any menu
    // interaction — the honest default, matching ExpandableFieldCluster's
    // "never hide real divergence behind a collapsed field" behaviour.
    const bottomField = screen.getByLabelText('Stroke weight, bottom')
    fireEvent.change(bottomField, { target: { value: '6px' } })
    fireEvent.blur(bottomField)

    expect(currentNode()?.inlineStyles?.borderBottomWidth).toBe('6px')
    expect(currentNode()?.inlineStyles?.borderTopWidth).toBe('2px')
  })
})

// ---------------------------------------------------------------------------
// 4. Settings popover (F17) — Style + Outline
// ---------------------------------------------------------------------------

describe('StrokeSection — settings popover', () => {
  it('reaches Style (fanned to all sides), outline and outlineOffset', () => {
    selectNode({ inlineStyles: { borderTopWidth: '1px' } })
    render(<StrokeSection />)

    fireEvent.click(screen.getByTestId('stroke-settings-trigger'))

    expect(screen.getByTestId('css-property-row-outline')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-outlineOffset')).toBeTruthy()

    fireEvent.click(screen.getByTestId('stroke-style'))
    fireEvent.click(screen.getByRole('option', { name: 'dashed' }))

    expect(currentNode()?.inlineStyles?.borderTopStyle).toBe('dashed')
    expect(currentNode()?.inlineStyles?.borderRightStyle).toBe('dashed')
    expect(currentNode()?.inlineStyles?.borderBottomStyle).toBe('dashed')
    expect(currentNode()?.inlineStyles?.borderLeftStyle).toBe('dashed')
  })
})

// ---------------------------------------------------------------------------
// 5. Stroke position — honest values only
// ---------------------------------------------------------------------------

describe('StrokeSection — position honesty', () => {
  it('ships only Inside and Outside — no Center, which has no CSS equivalent', () => {
    selectNode({ inlineStyles: { borderTopWidth: '1px' } })
    render(<StrokeSection />)

    fireEvent.click(screen.getByTestId('stroke-position'))

    expect(screen.getByRole('option', { name: 'Inside' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Outside' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /center/i })).toBeNull()
  })

  it('"Inside" writes a real box-sizing: border-box declaration', () => {
    selectNode({ inlineStyles: { borderTopWidth: '1px' } })
    render(<StrokeSection />)

    fireEvent.click(screen.getByTestId('stroke-position'))
    fireEvent.click(screen.getByRole('option', { name: 'Inside' }))

    expect(currentNode()?.inlineStyles?.boxSizing).toBe('border-box')
  })

  it('"Outside" writes a real box-sizing: content-box declaration', () => {
    selectNode({ inlineStyles: { borderTopWidth: '1px' } })
    render(<StrokeSection />)

    fireEvent.click(screen.getByTestId('stroke-position'))
    fireEvent.click(screen.getByRole('option', { name: 'Outside' }))

    expect(currentNode()?.inlineStyles?.boxSizing).toBe('content-box')
  })
})

// ---------------------------------------------------------------------------
// 6. Code-locked properties — the write is refused, never the whole row
// ---------------------------------------------------------------------------

describe('StrokeSection — code-locked properties', () => {
  it('refuses a borderTopWidth write when borderTopWidth is code-valued', () => {
    selectNode({
      // All four sides uniform (`2px`) so the collapsed "all sides" weight
      // field renders instead of the four-way Custom view — the write this
      // test exercises goes through THAT field.
      inlineStyles: {
        borderTopWidth: '2px',
        borderRightWidth: '2px',
        borderBottomWidth: '2px',
        borderLeftWidth: '2px',
      },
      codeProps: ['style:borderTopWidth'],
    })
    render(<StrokeSection />)

    const weightField = screen.getByLabelText('Stroke weight, all sides')
    fireEvent.change(weightField, { target: { value: '9px' } })
    fireEvent.blur(weightField)

    expect(currentNode()?.inlineStyles?.borderTopWidth).toBe('2px')
  })
})
