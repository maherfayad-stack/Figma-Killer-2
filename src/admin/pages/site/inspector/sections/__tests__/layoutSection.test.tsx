/**
 * LayoutSection — Penpot's LAYOUT section (`STATE.md` `panel-25`, P3 item
 * 4).
 *
 * Covers, ported onto `LayoutSection`'s store-backed write path
 * (`commitApi` instead of the retired `onChange` prop) from the old
 * `layoutSection.test.tsx`/`spacingSection.test.tsx`:
 *   0. `resolveLayoutMode` / `layoutModePatch` — unchanged pure logic, still
 *      exercised through the section (not re-derived; see `layoutMode.ts`).
 *   1. `LayoutModeRow` renders resident, always, regardless of `display`.
 *   2. The `AlignGrid` pad writes both properties in one gesture (flex and
 *      grid modes).
 *   3. `LayoutSettingsButton` is resident regardless of `display` and
 *      writes `flex`/`gridColumn`/`gridRow` — `alignSelf`/`justifySelf` are
 *      NOT ported here (dropped from the popover; ported to `AlignSection`'s
 *      own coverage instead, see `LayoutSettingsButton.tsx`'s own doc for
 *      why keeping them here would race Align's write).
 *   4. `overflow` promoted to "Clip content", resident regardless of
 *      `display`.
 *   5. The wrap toggle round-trips `nowrap ↔ wrap`.
 *   6. The padding cluster: 2 fields collapsed, 4 expanded.
 *   7. NEW coverage — the margin cluster (folded in from the retired
 *      `SpacingSection.tsx`) and its independence from the padding cluster's
 *      sticky expand state.
 *   8. NEW coverage — the Row gap / Column gap split (`GapRow.tsx`) and its
 *      disable rule on the F3-evidenced single-row/single-column case.
 *   9. NEW coverage — code-locked properties disable only their own field.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { LayoutSection } from '../LayoutSection'
import { DISPLAY_DEPENDENT_PROPS, layoutModePatch, resolveLayoutMode } from '../LayoutSection/layoutMode'
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

function setPaddingExpanded(expected: boolean) {
  const toggle = screen.getByTestId('expandable-field-cluster-padding-toggle')
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true'
  if (isExpanded !== expected) fireEvent.click(toggle)
}

function setMarginExpanded(expected: boolean) {
  const toggle = screen.getByTestId('expandable-field-cluster-margin-toggle')
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true'
  if (isExpanded !== expected) fireEvent.click(toggle)
}

// ---------------------------------------------------------------------------
// 0. resolveLayoutMode / layoutModePatch — pure, exhaustive (unchanged)
// ---------------------------------------------------------------------------

describe('resolveLayoutMode', () => {
  it('classifies flex + row (and undefined direction) as horizontal', () => {
    expect(resolveLayoutMode('flex', 'row')).toBe('horizontal')
    expect(resolveLayoutMode('flex', undefined)).toBe('horizontal')
  })

  it('classifies grid as grid regardless of flexDirection', () => {
    expect(resolveLayoutMode('grid', undefined)).toBe('grid')
  })

  it('classifies unset display as none', () => {
    expect(resolveLayoutMode(undefined, undefined)).toBe('none')
  })
})

describe('layoutModePatch', () => {
  it('none clears display + every flex/grid dependent prop, never the item-level ones', () => {
    const patch = layoutModePatch('none')
    expect(patch.set).toEqual({})
    expect(patch.clear).toContain('display')
    for (const prop of DISPLAY_DEPENDENT_PROPS) expect(patch.clear).toContain(prop)
    expect(patch.clear).not.toContain('flex')
    expect(patch.clear).not.toContain('gridColumn')
    expect(patch.clear).not.toContain('gridRow')
  })
})

// ---------------------------------------------------------------------------
// 1. LayoutModeRow — resident regardless of display
// ---------------------------------------------------------------------------

describe('LayoutSection — LayoutModeRow (resident)', () => {
  it('renders with no layout mode set, highlighting "No auto layout"', () => {
    selectNode()
    render(<LayoutSection />)
    expect(screen.getByRole('button', { name: /^no auto layout$/i }).getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking Vertical stack writes display: flex + flex-direction: column in one write', () => {
    selectNode()
    render(<LayoutSection />)

    fireEvent.click(screen.getByRole('button', { name: /^vertical stack$/i }))

    expect(currentNode()?.inlineStyles?.display).toBe('flex')
    expect(currentNode()?.inlineStyles?.flexDirection).toBe('column')
  })

  it('clicking Grid writes display: grid', () => {
    selectNode()
    render(<LayoutSection />)

    fireEvent.click(screen.getByRole('button', { name: /^grid$/i }))

    expect(currentNode()?.inlineStyles?.display).toBe('grid')
  })
})

// ---------------------------------------------------------------------------
// 2. AlignGrid — one gesture, both properties
// ---------------------------------------------------------------------------

describe('LayoutSection — AlignGrid (flex)', () => {
  it('clicking the center cell writes alignItems + justifyContent as center', () => {
    selectNode({ inlineStyles: { display: 'flex' } })
    render(<LayoutSection />)

    fireEvent.click(screen.getByTestId('css-align-grid-cell-1-1'))

    expect(currentNode()?.inlineStyles?.alignItems).toBe('center')
    expect(currentNode()?.inlineStyles?.justifyContent).toBe('center')
  })
})

describe('LayoutSection — AlignGrid (grid)', () => {
  it('clicking a cell writes alignItems + justifyItems (not justifyContent)', () => {
    selectNode({ inlineStyles: { display: 'grid' } })
    render(<LayoutSection />)

    fireEvent.click(screen.getByTestId('css-align-grid-cell-0-0'))

    expect(currentNode()?.inlineStyles?.alignItems).toBe('flex-start')
    expect(currentNode()?.inlineStyles?.justifyItems).toBe('flex-start')
    expect(currentNode()?.inlineStyles?.justifyContent).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Layout settings ⚙ — item-level rows only, alignSelf/justifySelf dropped
// ---------------------------------------------------------------------------

describe('LayoutSection — Layout settings popover (resident, item-level only)', () => {
  it('is reachable with no display set at all, and writes flex', () => {
    selectNode()
    render(<LayoutSection />)

    expect(screen.queryByTestId('css-align-grid')).toBeNull()
    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    const flexRow = screen.getByTestId('css-property-row-flex')
    const input = within(flexRow).getByRole('textbox')
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)

    expect(currentNode()?.inlineStyles?.flex).toBe('1')
  })

  it('does NOT expose alignSelf/justifySelf — AlignSection owns them exclusively', () => {
    selectNode()
    render(<LayoutSection />)

    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    expect(screen.queryByTestId('css-property-row-alignSelf')).toBeNull()
    expect(screen.queryByTestId('css-property-row-justifySelf')).toBeNull()
    expect(screen.getByTestId('css-property-row-gridColumn')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-gridRow')).toBeTruthy()
  })

  it('hides the container-only rows (rowGap/columnGap/flexWrap) with no display set', () => {
    selectNode()
    render(<LayoutSection />)

    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    expect(screen.queryByTestId('css-property-row-rowGap')).toBeNull()
    expect(screen.queryByTestId('css-property-row-columnGap')).toBeNull()
    expect(screen.queryByTestId('css-property-row-flexWrap')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. Clip content — the promoted `overflow` checkbox
// ---------------------------------------------------------------------------

describe('LayoutSection — Clip content', () => {
  it('renders regardless of display', () => {
    selectNode()
    render(<LayoutSection />)
    expect(screen.getByTestId('css-clip-content-checkbox')).toBeTruthy()
  })

  it('checking it writes overflow: hidden', () => {
    selectNode()
    render(<LayoutSection />)

    fireEvent.click(screen.getByTestId('css-clip-content-checkbox'))

    expect(currentNode()?.inlineStyles?.overflow).toBe('hidden')
  })
})

// ---------------------------------------------------------------------------
// 5. Wrap toggle
// ---------------------------------------------------------------------------

describe('LayoutSection — wrap toggle', () => {
  it('round-trips nowrap -> wrap', () => {
    selectNode({ inlineStyles: { display: 'flex' } })
    render(<LayoutSection />)

    const toggle = screen.getByTestId('css-layout-wrap-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    expect(currentNode()?.inlineStyles?.flexWrap).toBe('wrap')
  })
})

// ---------------------------------------------------------------------------
// 6. Padding cluster
// ---------------------------------------------------------------------------

describe('LayoutSection — padding cluster', () => {
  it('is resident regardless of display, collapsed shows 2 fields', () => {
    selectNode({ inlineStyles: { paddingTop: '8px', paddingBottom: '8px' } })
    render(<LayoutSection />)
    setPaddingExpanded(false)

    const fields = screen.getByTestId('expandable-field-cluster-padding-fields')
    expect(within(fields).getAllByRole('textbox').length).toBe(2)
  })

  it('editing the collapsed horizontal field writes both paddingLeft and paddingRight', () => {
    selectNode()
    render(<LayoutSection />)
    setPaddingExpanded(false)

    const horizontal = screen.getByTestId('css-padding-horizontal') as HTMLInputElement
    fireEvent.change(horizontal, { target: { value: '12px' } })
    fireEvent.blur(horizontal)

    expect(currentNode()?.inlineStyles?.paddingLeft).toBe('12px')
    expect(currentNode()?.inlineStyles?.paddingRight).toBe('12px')
  })
})

// ---------------------------------------------------------------------------
// 7. Margin cluster — folded in from the retired SpacingSection.tsx
// ---------------------------------------------------------------------------

describe('LayoutSection — margin cluster', () => {
  it('is independent of the padding cluster\'s sticky expand state', () => {
    selectNode()
    render(<LayoutSection />)

    const paddingToggle = screen.getByTestId('expandable-field-cluster-padding-toggle')
    if (paddingToggle.getAttribute('aria-expanded') === 'true') fireEvent.click(paddingToggle)

    setMarginExpanded(true)

    expect(paddingToggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('editing the collapsed horizontal field writes both marginLeft and marginRight', () => {
    selectNode()
    render(<LayoutSection />)
    setMarginExpanded(false)

    const horizontal = screen.getByTestId('css-margin-horizontal') as HTMLInputElement
    fireEvent.change(horizontal, { target: { value: '16px' } })
    fireEvent.blur(horizontal)

    expect(currentNode()?.inlineStyles?.marginLeft).toBe('16px')
    expect(currentNode()?.inlineStyles?.marginRight).toBe('16px')
  })

  it('the "Box model" popover reaches all 8 padding+margin sides', () => {
    selectNode({ inlineStyles: { paddingTop: '4px', marginTop: '8px' } })
    render(<LayoutSection />)

    expect(screen.queryByLabelText('padding top')).toBeNull()
    fireEvent.click(screen.getByTestId('spacing-box-model-trigger'))

    expect((screen.getByLabelText('padding top') as HTMLInputElement).value).toBe('4px')
    expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe('8px')
  })
})

// ---------------------------------------------------------------------------
// 8. Row gap / Column gap split
// ---------------------------------------------------------------------------

describe('LayoutSection — Row gap / Column gap', () => {
  it('both fields are live for a wrapping flex row', () => {
    selectNode({ inlineStyles: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap' } })
    render(<LayoutSection />)

    expect(screen.getByTestId('css-row-gap-input')).not.toHaveProperty('disabled', true)
    expect(screen.getByTestId('css-column-gap-input')).not.toHaveProperty('disabled', true)
  })

  it('disables Row gap for a single, non-wrapping flex row', () => {
    selectNode({ inlineStyles: { display: 'flex', flexDirection: 'row' } })
    render(<LayoutSection />)

    const rowGapInput = screen.getByTestId('css-row-gap-input') as HTMLInputElement
    expect(rowGapInput.disabled).toBe(true)
    const columnGapInput = screen.getByTestId('css-column-gap-input') as HTMLInputElement
    expect(columnGapInput.disabled).toBe(false)
  })

  it('disables Column gap for a single, non-wrapping flex column', () => {
    selectNode({ inlineStyles: { display: 'flex', flexDirection: 'column' } })
    render(<LayoutSection />)

    const columnGapInput = screen.getByTestId('css-column-gap-input') as HTMLInputElement
    expect(columnGapInput.disabled).toBe(true)
    const rowGapInput = screen.getByTestId('css-row-gap-input') as HTMLInputElement
    expect(rowGapInput.disabled).toBe(false)
  })

  it('writes rowGap/columnGap as longhands, not the gap shorthand', () => {
    selectNode({ inlineStyles: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap' } })
    render(<LayoutSection />)

    const rowGapInput = screen.getByTestId('css-row-gap-input') as HTMLInputElement
    fireEvent.change(rowGapInput, { target: { value: '8px' } })
    fireEvent.blur(rowGapInput)

    expect(currentNode()?.inlineStyles?.rowGap).toBe('8px')
    expect(currentNode()?.inlineStyles?.gap).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 9. Code-locked properties — the field disables, never the whole section
// ---------------------------------------------------------------------------

describe('LayoutSection — code-locked properties', () => {
  it('refuses a padding write when paddingTop is code-valued', () => {
    selectNode({ codeProps: ['style:paddingTop'] })
    render(<LayoutSection />)
    setPaddingExpanded(true)

    const field = screen.getByTestId('css-padding-top') as HTMLInputElement
    fireEvent.change(field, { target: { value: '20px' } })
    fireEvent.blur(field)

    expect(currentNode()?.inlineStyles?.paddingTop).toBeUndefined()
  })
})
