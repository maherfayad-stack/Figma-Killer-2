/**
 * The eight bespoke sections under a multi-selection that disagrees
 * (W8-3 phase 1's remaining gap, closed).
 *
 * The failure this pins: phase 1 taught the *primitives* to render "Mixed",
 * and routed the `MIXED` sentinel through `ClassPropertyRow`. Every section
 * that reads its raw cells directly — Spacing, Layout, Position, Size,
 * Typography, Appearance, Fill, Stroke — went on reading them through
 * `readString` / a local `pickString`, both of which return `undefined` for a
 * Symbol. So five layers with five different paddings drew an *empty* field,
 * indistinguishable from "nobody set a padding", and one wrong keystroke
 * from silently flattening all five. `String(MIXED)` was the other half of
 * the bug: Position and Size would have printed `Symbol(studio-mixed-value)`
 * into the field, because `hasStyleValue` is true for a Symbol.
 *
 * Each case below hands a section a bag holding `MIXED` and asserts the
 * control says so.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MIXED } from '@ui/components/MixedValue'
import type { CSSPropertyBag } from '@core/page-tree'
import { SpacingSection } from '../SpacingBoxControl/SpacingSection'
import { LayoutSection } from '../LayoutSection/LayoutSection'
import { PositionSection } from '../PositionSection'
import { SizeSection } from '../SizeSection'
import { TypographySection } from '../TypographySection'
import { AppearanceSection } from '../AppearanceSection'
import { FillSection } from '../FillSection'
import { StrokeSection } from '../StrokeSection'

afterEach(cleanup)

function noop() {}

const TYPOGRAPHY_PROPERTIES = ['textAlign'] as unknown as ReadonlyArray<keyof CSSPropertyBag>
const FILL_PROPERTIES = ['color', 'backgroundColor'] as unknown as ReadonlyArray<
  keyof CSSPropertyBag
>

/**
 * Force an `ExpandableFieldCluster` collapsed. Its open/closed state is
 * module-level and sticky per cluster id (by design — see that component's
 * doc), so a test that wants the LINKED field has to say so rather than
 * inherit whatever a sibling test left behind.
 */
function collapseCluster(id: string) {
  const toggle = screen.getByTestId(`expandable-field-cluster-${id}-toggle`)
  if (toggle.getAttribute('aria-expanded') === 'true') fireEvent.click(toggle)
}

/** A field's placeholder — the one surface every text control states Mixed on. */
function placeholderOf(label: string): string | null {
  return (screen.getByLabelText(label) as HTMLInputElement).getAttribute('placeholder')
}

describe('Spacing — margin', () => {
  it('reads Mixed on a linked axis when one side disagrees', () => {
    render(
      <SpacingSection
        storedStyles={{
          marginLeft: MIXED,
          marginRight: MIXED,
          marginTop: MIXED,
          marginBottom: MIXED,
        }}
        currentStyles={{}}
        onChange={noop}
        onRemove={noop}
      />,
    )
    collapseCluster('margin')
    expect(placeholderOf('Margin horizontal')).toBe('Mixed')
  })

  it('leaves an agreeing axis alone', () => {
    render(
      <SpacingSection
        storedStyles={{
          marginTop: '8px',
          marginBottom: '8px',
          marginLeft: '8px',
          marginRight: '8px',
        }}
        currentStyles={{}}
        onChange={noop}
        onRemove={noop}
      />,
    )
    collapseCluster('margin')
    expect(placeholderOf('Margin vertical')).not.toBe('Mixed')
  })
})

describe('Layout', () => {
  function renderLayout(overrides: Record<string, unknown>) {
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

  it('presses no layout mode when display disagrees', () => {
    renderLayout({ currentStyles: { display: MIXED } })
    expect(screen.getByTestId('css-layout-mode-row').getAttribute('data-mode')).toBe('mixed')
  })

  it('reads Mixed on gap', () => {
    renderLayout({
      currentStyles: { display: 'flex', gap: MIXED },
      storedStyles: { gap: MIXED },
    })
    expect(placeholderOf('Gap')).toBe('Mixed')
  })

  it('reads Mixed on padding', () => {
    renderLayout({ storedStyles: { paddingTop: MIXED } })
    collapseCluster('padding')
    expect(placeholderOf('Padding vertical')).toBe('Mixed')
  })
})

describe('Position', () => {
  function renderPosition(overrides: Record<string, unknown>) {
    return render(
      <PositionSection
        currentStyles={{}}
        storedStyles={{}}
        activeTab="base"
        onChange={noop}
        onRemove={noop}
        onClearProperty={noop}
        {...overrides}
      />,
    )
  }

  it('marks the position switcher mixed rather than pressing one member’s value', () => {
    renderPosition({ currentStyles: { position: MIXED } })
    expect(screen.getByTestId('css-position-switcher').getAttribute('data-position-value')).toBe(
      'mixed',
    )
  })

  it('never prints the sentinel into an offset field', () => {
    renderPosition({
      currentStyles: { position: 'relative' },
      storedStyles: { top: MIXED },
    })
    const field = screen.getByLabelText('Top offset') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})

describe('Size', () => {
  it('never prints the sentinel into the width field', () => {
    render(
      <SizeSection
        storedStyles={{ width: MIXED }}
        currentStyles={{}}
        activeTab="base"
        onChange={noop}
        onRemove={noop}
        onClearProperty={noop}
      />,
    )
    const field = screen.getByLabelText('Width') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})

describe('Typography', () => {
  it('marks the text-align group indeterminate', () => {
    render(
      <TypographySection
        currentStyles={{}}
        storedStyles={{ textAlign: MIXED }}
        visibleProperties={TYPOGRAPHY_PROPERTIES}
        activeTab="base"
        onChange={noop}
        onRemove={noop}
      />,
    )
    expect(screen.getByTestId('typography-text-align').getAttribute('data-mixed')).toBe('true')
  })
})

describe('Appearance — corner radius', () => {
  it('reads Mixed on the linked corner field', () => {
    render(
      <AppearanceSection
        storedStyles={{
          borderTopLeftRadius: MIXED,
          borderTopRightRadius: MIXED,
          borderBottomRightRadius: MIXED,
          borderBottomLeftRadius: MIXED,
        }}
        currentStyles={{}}
        activeTab="base"
        onChange={noop}
        onRemove={noop}
      />,
    )
    collapseCluster('radius')
    // `ScrubInput` puts `data-testid` on the field WRAPPER and `-field` on
    // the `<input>` — same convention `appearanceSection.test.tsx` documents.
    const field = screen.getByTestId('appearance-radius-all-field') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})

describe('Fill', () => {
  it('keeps the fill entry and labels it Mixed', () => {
    render(
      <FillSection
        storedStyles={{ backgroundColor: MIXED }}
        currentStyles={{}}
        visibleProperties={FILL_PROPERTIES}
        activeTab="base"
        onChange={noop}
        onRemove={noop}
      />,
    )
    // Without the wire-up the entry vanished entirely: `readString` returned
    // undefined, so `showColorEntry` was false and the section rendered empty.
    expect(screen.getByText('Mixed')).toBeTruthy()
  })
})

describe('Stroke', () => {
  it('reads Mixed on the weight field', () => {
    render(
      <StrokeSection
        activeTab="base"
        storedStyles={{
          borderTopWidth: MIXED,
          borderRightWidth: MIXED,
          borderBottomWidth: MIXED,
          borderLeftWidth: MIXED,
        }}
        currentStyles={{}}
        onChange={noop}
        onRemove={noop}
        onClearProperty={noop}
      />,
    )
    collapseCluster('stroke-sides')
    const field = screen.getByTestId('stroke-weight-all-field') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})
