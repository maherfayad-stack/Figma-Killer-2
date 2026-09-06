/**
 * LayoutSection — G3 + G4 (STUDIO-INSPECTOR-DISCLOSURE-PLAN.md).
 *
 * Covers:
 *   1. The `AlignGrid` pad writes BOTH properties in one click (alignItems +
 *      justifyContent in flex mode, alignItems + justifyItems in grid mode)
 *      and clears both on a re-click of the already-active cell.
 *   2. `LayoutSettingsButton` is RESIDENT — reachable regardless of this
 *      element's own `display` — because `alignSelf` / `justifySelf` /
 *      `flex` / `gridColumn` / `gridRow` are item-level properties governed
 *      by the PARENT's display, not this element's own. Only the
 *      CONTAINER-level rows (`rowGap`/`columnGap`, `flexWrap`) are
 *      mode-filtered on this element's own `display`. A node with no
 *      `display` set at all can still open the popover and write
 *      `alignSelf`, and the value survives (the regression this order's
 *      review caught).
 *   3. `overflow` promoted to a "Clip content" checkbox — writes/clears the
 *      real `overflow` property, resident regardless of `display`.
 *   4. The wrap toggle round-trips `nowrap ↔ wrap`, and shows pressed (never
 *      lying about the state) when the stored value is `wrap-reverse`.
 *   5. The padding cluster: collapsed shows 2 fields, expanded shows 4, and
 *      expanding/collapsing never calls `onChange` on its own. Resident
 *      regardless of `display`.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { LayoutSection } from '../LayoutSection'

afterEach(cleanup)

function noop() {}

type LayoutProps = ComponentProps<typeof LayoutSection>

function renderLayout(overrides: Partial<LayoutProps> = {}) {
  return render(
    <LayoutSection
      storedStyles={{}}
      currentStyles={{}}
      activeTab="base"
      onChange={noop}
      onRemove={noop}
      onClearProperty={noop}
      onClearProperties={noop}
      {...overrides}
    />,
  )
}

// ---------------------------------------------------------------------------
// 1. AlignGrid — one gesture, both properties
// ---------------------------------------------------------------------------

describe('LayoutSection — AlignGrid (flex)', () => {
  it('clicking the center cell writes alignItems + justifyContent as center', () => {
    const calls: Array<[string, unknown]> = []
    renderLayout({
      storedStyles: { display: 'flex' },
      currentStyles: { display: 'flex' },
      onChange: (p, v) => calls.push([String(p), v]),
    })

    fireEvent.click(screen.getByTestId('css-align-grid-cell-1-1'))

    expect(calls).toContainEqual(['alignItems', 'center'])
    expect(calls).toContainEqual(['justifyContent', 'center'])
  })

  it('clicking the already-active cell clears both properties', () => {
    const cleared: string[] = []
    renderLayout({
      storedStyles: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      currentStyles: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      onClearProperty: (p) => cleared.push(String(p)),
    })

    fireEvent.click(screen.getByTestId('css-align-grid-cell-1-1'))

    expect(cleared).toContain('alignItems')
    expect(cleared).toContain('justifyContent')
  })
})

describe('LayoutSection — AlignGrid (grid)', () => {
  it('clicking a cell writes alignItems + justifyItems (not justifyContent)', () => {
    const calls: Array<[string, unknown]> = []
    renderLayout({
      storedStyles: { display: 'grid' },
      currentStyles: { display: 'grid' },
      onChange: (p, v) => calls.push([String(p), v]),
    })

    fireEvent.click(screen.getByTestId('css-align-grid-cell-0-0'))

    expect(calls).toContainEqual(['alignItems', 'flex-start'])
    expect(calls).toContainEqual(['justifyItems', 'flex-start'])
    expect(calls.some(([prop]) => prop === 'justifyContent')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Layout settings ⚙ — mode-filtered contents
// ---------------------------------------------------------------------------

describe('LayoutSection — Layout settings popover (resident)', () => {
  it('is reachable with no display set at all, and writes alignSelf', () => {
    const calls: Array<[string, unknown]> = []
    renderLayout({ onChange: (p, v) => calls.push([String(p), v]) })

    // No flex/grid block is rendered at all — the trigger still is.
    expect(screen.queryByTestId('css-align-grid')).toBeNull()
    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    const alignSelfRow = screen.getByTestId('css-property-row-alignSelf')
    const select = within(alignSelfRow).getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'center' } })

    expect(calls).toContainEqual(['alignSelf', 'center'])
  })

  it('the value survives being displayed with no display set (regression pin)', () => {
    renderLayout({ storedStyles: { alignSelf: 'center' }, currentStyles: { alignSelf: 'center' } })

    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    const alignSelfRow = screen.getByTestId('css-property-row-alignSelf')
    const select = within(alignSelfRow).getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('center')
  })

  it('shows the item-level rows (alignSelf/justifySelf/flex/gridColumn/gridRow) with no display set', () => {
    renderLayout()

    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    expect(screen.getByTestId('css-property-row-alignSelf')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-justifySelf')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-flex')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-gridColumn')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-gridRow')).toBeTruthy()
  })

  it('hides the container-only rows (rowGap/columnGap/flexWrap) with no display set', () => {
    renderLayout()

    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    expect(screen.queryByTestId('css-property-row-rowGap')).toBeNull()
    expect(screen.queryByTestId('css-property-row-columnGap')).toBeNull()
    expect(screen.queryByTestId('css-property-row-flexWrap')).toBeNull()
  })

  it('flex mode additionally shows rowGap/columnGap/flexWrap, alongside the always-shown item-level rows', () => {
    renderLayout({ storedStyles: { display: 'flex' }, currentStyles: { display: 'flex' } })

    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    expect(screen.getByTestId('css-property-row-alignSelf')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-gridColumn')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-rowGap')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-columnGap')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-flexWrap')).toBeTruthy()
  })

  it('grid mode additionally shows rowGap/columnGap but NOT flexWrap', () => {
    renderLayout({ storedStyles: { display: 'grid' }, currentStyles: { display: 'grid' } })

    fireEvent.click(screen.getByTestId('layout-settings-trigger'))

    expect(screen.getByTestId('css-property-row-alignSelf')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-rowGap')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-columnGap')).toBeTruthy()
    expect(screen.queryByTestId('css-property-row-flexWrap')).toBeNull()
  })
})

describe('LayoutSection — display clear does not prune item-level properties', () => {
  it('clearing display never touches alignSelf/justifySelf/flex/gridColumn/gridRow', () => {
    const cleared: string[] = []
    renderLayout({
      storedStyles: { display: 'flex', alignSelf: 'center', flex: '1', gridColumn: '2' },
      currentStyles: { display: 'flex', alignSelf: 'center', flex: '1', gridColumn: '2' },
      onClearProperties: (props) => cleared.push(...props.map(String)),
    })

    // Clicking the active Flex segment clears display (+ its container deps).
    fireEvent.click(screen.getByRole('button', { name: /^flex layout$/i }))

    expect(cleared).toContain('display')
    expect(cleared).not.toContain('alignSelf')
    expect(cleared).not.toContain('justifySelf')
    expect(cleared).not.toContain('flex')
    expect(cleared).not.toContain('gridColumn')
    expect(cleared).not.toContain('gridRow')
  })
})

// ---------------------------------------------------------------------------
// 3. Clip content — the promoted `overflow` checkbox
// ---------------------------------------------------------------------------

describe('LayoutSection — Clip content', () => {
  it('renders regardless of display', () => {
    renderLayout()
    expect(screen.getByTestId('css-clip-content-checkbox')).toBeTruthy()
  })

  it('checking it writes overflow: hidden', () => {
    const onChange = mock(() => {})
    renderLayout({ onChange })

    fireEvent.click(screen.getByTestId('css-clip-content-checkbox'))

    expect(onChange).toHaveBeenCalledWith('overflow', 'hidden')
  })

  it('unchecking it clears the overflow property', () => {
    const onRemove = mock(() => {})
    renderLayout({ storedStyles: { overflow: 'hidden' }, onRemove })

    fireEvent.click(screen.getByTestId('css-clip-content-checkbox'))

    expect(onRemove).toHaveBeenCalledWith('overflow')
  })
})

// ---------------------------------------------------------------------------
// 4. Wrap toggle — nowrap ↔ wrap, honest about wrap-reverse
// ---------------------------------------------------------------------------

describe('LayoutSection — wrap toggle', () => {
  it('round-trips nowrap -> wrap -> clear', () => {
    const onChange = mock(() => {})
    renderLayout({ storedStyles: { display: 'flex' }, currentStyles: { display: 'flex' }, onChange })

    const toggle = screen.getByTestId('css-layout-wrap-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith('flexWrap', 'wrap')
  })

  it('clicking while wrapping clears flexWrap rather than forcing nowrap', () => {
    const onClearProperty = mock(() => {})
    renderLayout({
      storedStyles: { display: 'flex', flexWrap: 'wrap' },
      currentStyles: { display: 'flex', flexWrap: 'wrap' },
      onClearProperty,
    })

    fireEvent.click(screen.getByTestId('css-layout-wrap-toggle'))
    expect(onClearProperty).toHaveBeenCalledWith('flexWrap')
  })

  it('shows pressed for wrap-reverse — never lies about the state', () => {
    renderLayout({
      storedStyles: { display: 'flex', flexWrap: 'wrap-reverse' },
      currentStyles: { display: 'flex', flexWrap: 'wrap-reverse' },
    })

    expect(screen.getByTestId('css-layout-wrap-toggle').getAttribute('aria-pressed')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 5. Padding cluster — collapsed 2 / expanded 4, expand writes nothing
// ---------------------------------------------------------------------------

function setPaddingExpanded(expected: boolean) {
  const toggle = screen.getByTestId('expandable-field-cluster-padding-toggle')
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true'
  if (isExpanded !== expected) fireEvent.click(toggle)
}

describe('LayoutSection — padding cluster', () => {
  it('is resident regardless of display', () => {
    renderLayout()
    expect(screen.getByTestId('expandable-field-cluster-padding')).toBeTruthy()
  })

  it('collapsed shows 2 fields (horizontal / vertical)', () => {
    renderLayout({ storedStyles: { paddingTop: '8px', paddingBottom: '8px' } })
    setPaddingExpanded(false)

    const fields = screen.getByTestId('expandable-field-cluster-padding-fields')
    expect(within(fields).getAllByRole('textbox').length).toBe(2)
  })

  it('expanded shows 4 fields, and toggling never calls onChange', () => {
    const onChange = mock(() => {})
    renderLayout({
      storedStyles: {
        paddingLeft: '4px',
        paddingTop: '8px',
        paddingRight: '4px',
        paddingBottom: '8px',
      },
      onChange,
    })

    setPaddingExpanded(true)
    const fields = screen.getByTestId('expandable-field-cluster-padding-fields')
    expect(within(fields).getAllByRole('textbox').length).toBe(4)

    setPaddingExpanded(false)
    setPaddingExpanded(true)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('editing the collapsed horizontal field writes both paddingLeft and paddingRight', () => {
    const calls: Array<[string, unknown]> = []
    renderLayout({ onChange: (p, v) => calls.push([String(p), v]) })
    setPaddingExpanded(false)

    const horizontal = screen.getByTestId('css-padding-horizontal') as HTMLInputElement
    fireEvent.change(horizontal, { target: { value: '12px' } })
    fireEvent.blur(horizontal)

    expect(calls).toContainEqual(['paddingLeft', '12px'])
    expect(calls).toContainEqual(['paddingRight', '12px'])
  })
})
