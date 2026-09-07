/**
 * TypographySection — G9 (docs/features/inspector-disclosure.md).
 *
 * Covers:
 *   1. The four F23 rows at rest (family; weight+size; line-height+letter-
 *      spacing; text-align + vertical-align + the settings ⚙) — plus the
 *      still-resident color/textShadow rows this pass deliberately did not
 *      move (see TypographySection.tsx's header doc).
 *   2. The settings popover opens on demand and every Basics property is
 *      reachable through it and writes correctly.
 *   3. Row 4 stays reachable via search even when only a settings-only
 *      property (e.g. `whiteSpace`) — not `textAlign` — survives the filter.
 *   4. `TypographySettings`'s Details tab, Variable tab presence/absence,
 *      and per-`id` sticky tab memory.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { Button } from '@ui/components/Button'
import { TypographySection } from '../TypographySection'
import { TypographySettings } from '../TypographySettings'
import { CLASS_STYLE_SECTIONS } from '../classStyleSections'
import type { FontVariationAxis } from '@core/fonts'

afterEach(cleanup)

function noop() {}

const TYPOGRAPHY_PROPERTIES = CLASS_STYLE_SECTIONS.find((s) => s.id === 'typography')!.properties

type SectionProps = ComponentProps<typeof TypographySection>

function renderSection(overrides: Partial<SectionProps> = {}) {
  return render(
    <TypographySection
      currentStyles={{}}
      storedStyles={{}}
      visibleProperties={TYPOGRAPHY_PROPERTIES}
      activeTab="base"
      onChange={noop}
      onRemove={noop}
      {...overrides}
    />,
  )
}

// ---------------------------------------------------------------------------
// 1. The four rows at rest
// ---------------------------------------------------------------------------

describe('TypographySection — F23 rows at rest', () => {
  it('renders family, weight+size, and line-height+letter-spacing', () => {
    renderSection({
      currentStyles: { fontFamily: 'Inter', fontSize: '16px', lineHeight: '1.5' },
      storedStyles: { fontFamily: 'Inter', fontSize: '16px', lineHeight: '1.5' },
    })
    expect(screen.getByTestId('css-property-row-fontFamily')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-fontWeight')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-fontSize')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-lineHeight')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-letterSpacing')).toBeTruthy()
  })

  it('renders row 4 as a text-align group, a vertical-align group, and one settings trigger — not five resident property rows', () => {
    renderSection()
    expect(screen.getByTestId('typography-text-align')).toBeTruthy()
    expect(screen.getByTestId('typography-vertical-align')).toBeTruthy()
    expect(screen.getByTestId('typography-settings-trigger')).toBeTruthy()
    // The properties row 4 replaces are NOT drawn as their own resident rows.
    expect(screen.queryByTestId('css-property-row-fontStyle')).toBeNull()
    expect(screen.queryByTestId('css-property-row-textDecoration')).toBeNull()
    expect(screen.queryByTestId('css-property-row-textTransform')).toBeNull()
    expect(screen.queryByTestId('css-property-row-whiteSpace')).toBeNull()
  })

  // G9's target shape, completed in W8-1: a text node's colour is its FILL and
  // a text shadow is an EFFECT. Both moved out of this section once Fill (G6)
  // and Effects (G8) existed to receive them, which is what finally makes this
  // section literally F23's four rows.
  it('no longer draws color or textShadow — they belong to Fill and Effects now', () => {
    renderSection()
    expect(screen.queryByTestId('css-property-row-color')).toBeNull()
    expect(screen.queryByTestId('css-property-row-textShadow')).toBeNull()
  })

  it('clicking a text-align segment writes textAlign', () => {
    let written: [string, unknown] | null = null
    renderSection({ onChange: (p, v) => { written = [String(p), v] } })
    fireEvent.click(screen.getByRole('button', { name: /text align: align center/i }))
    expect(written).toEqual(['textAlign', 'center'])
  })
})

// ---------------------------------------------------------------------------
// 2. Vertical align — honest write / disabled with a reason
// ---------------------------------------------------------------------------

describe('TypographySection — vertical align honesty', () => {
  it('disables the vertical-align group with a reason when the element is not display:flex', () => {
    renderSection({ currentStyles: {}, storedStyles: {} })
    const group = screen.getByTestId('typography-vertical-align')
    const buttons = group.querySelectorAll('button')
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
    }
  })

  it('disables vertical align when flex-direction is column even though display is flex', () => {
    renderSection({ currentStyles: { display: 'flex', flexDirection: 'column' } })
    const group = screen.getByTestId('typography-vertical-align')
    expect(group.querySelector('button')!.getAttribute('aria-disabled')).toBe('true')
  })

  it('enables vertical align and writes alignItems for a flex-row element', () => {
    let written: [string, unknown] | null = null
    renderSection({
      currentStyles: { display: 'flex', flexDirection: 'row' },
      onChange: (p, v) => { written = [String(p), v] },
    })
    const middleBtn = screen.getByRole('button', { name: 'Align middle' })
    expect(middleBtn.getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.click(middleBtn)
    expect(written).toEqual(['alignItems', 'center'])
  })

  it('reflects a stored alignItems value back as the pressed vertical-align edge', () => {
    renderSection({
      currentStyles: { display: 'flex' },
      storedStyles: { alignItems: 'flex-end' },
    })
    expect(screen.getByRole('button', { name: 'Align bottom' }).getAttribute('aria-pressed')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 3. Search reachability — settings-only properties keep the ⚙ reachable
// ---------------------------------------------------------------------------

describe('TypographySection — search reachability', () => {
  it('shows only the settings trigger (no align groups) when the search matches a settings-only property', () => {
    renderSection({ visibleProperties: ['whiteSpace'] })
    expect(screen.getByTestId('typography-settings-trigger')).toBeTruthy()
    expect(screen.queryByTestId('typography-text-align')).toBeNull()
  })

  it('shows nothing from row 4 when the search matches neither textAlign nor a settings-only property', () => {
    renderSection({ visibleProperties: ['fontFamily'] })
    expect(screen.queryByTestId('typography-settings-trigger')).toBeNull()
    expect(screen.queryByTestId('typography-text-align')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. The settings popover — opens on demand, Basics writes, Details renders
//    uncurated properties, Variable tab presence/absence, sticky tab per id.
// ---------------------------------------------------------------------------

describe('TypographySection — settings popover', () => {
  it('is closed by default and opens on the ⚙ trigger', () => {
    renderSection()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('typography-settings-trigger'))
    expect(screen.getByRole('dialog', { name: /typography settings/i })).toBeTruthy()
  })

  it('every Basics property is reachable through the ⚙', () => {
    renderSection()
    fireEvent.click(screen.getByTestId('typography-settings-trigger'))

    for (const testId of [
      'css-property-row-fontStyle',
      'css-property-row-textDecoration',
      'css-property-row-textTransform',
      'css-property-row-whiteSpace',
      'css-property-row-textOverflow',
      'css-property-row-textIndent',
      'css-property-row-marginBlock',
    ]) {
      expect(screen.getByTestId(testId)).toBeTruthy()
    }
  })

  it('writes correctly across every Basics control shape — icon toggle, dropdown, and plain text', () => {
    let written: [string, unknown] | null = null
    renderSection({ onChange: (p, v) => { written = [String(p), v] } })
    fireEvent.click(screen.getByTestId('typography-settings-trigger'))

    // fontStyle: icon toggle group (getIconEnumOptions).
    fireEvent.click(screen.getByRole('button', { name: /font style: italic/i }))
    expect(written).toEqual(['fontStyle', 'italic'])

    // whiteSpace: the Select combobox (no icon enum) — a custom listbox, not
    // a native <select>, per Select.tsx; same open/click pattern
    // positionSection.test.tsx uses for the same primitive.
    const whiteSpaceCombobox = screen.getByRole('combobox', { name: 'White space' })
    fireEvent.click(whiteSpaceCombobox.nextElementSibling as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'nowrap' }))
    expect(written).toEqual(['whiteSpace', 'nowrap'])

    // textIndent: a plain text/length control — not curated in cssControlTypes.ts,
    // reached through the same generic row machinery via the `as keyof CSSPropertyBag` cast.
    fireEvent.change(screen.getByLabelText('Text indent'), { target: { value: '2em' } })
    expect(written).toEqual(['textIndent', '2em'])
  })
})

// ---------------------------------------------------------------------------
// TypographySettings — Details tab, Variable tab, sticky-per-id tab memory.
// Tested directly (not through TypographySection's live network hook) —
// see useFontVariationAxes.ts's doc for why.
// ---------------------------------------------------------------------------

function TypographySettingsHarness({
  variationAxes = [],
  id = 'typography-settings',
}: {
  variationAxes?: ReadonlyArray<FontVariationAxis>
  id?: string
}) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button ref={ref} variant="ghost" size="xs">
        Trigger
      </Button>
      <TypographySettings
        id={id}
        anchorRef={ref}
        onClose={noop}
        storedStyles={{}}
        onChange={noop}
        onRemove={noop}
        variationAxes={variationAxes}
      />
    </>
  )
}

describe('TypographySettings — Details tab', () => {
  it('curates fontVariantNumeric / fontFeatureSettings / hangingPunctuation / fontKerning, uncurated anywhere else', () => {
    render(<TypographySettingsHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByTestId('css-property-row-fontVariantNumeric')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-fontFeatureSettings')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-hangingPunctuation')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-fontKerning')).toBeTruthy()
  })
})

describe('TypographySettings — Variable tab', () => {
  it('is absent when the font exposes no axes (the static-font case)', () => {
    render(<TypographySettingsHarness variationAxes={[]} />)
    expect(screen.queryByRole('tab', { name: 'Variable' })).toBeNull()
  })

  it('is present, with one row per axis, when the font exposes axes', () => {
    const axes: FontVariationAxis[] = [
      { tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 },
      { tag: 'wdth', name: 'Width', min: 75, max: 125, default: 100 },
    ]
    render(<TypographySettingsHarness variationAxes={axes} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Variable' }))
    expect(screen.getByLabelText('Weight (wght)')).toBeTruthy()
    expect(screen.getByLabelText('Width (wdth)')).toBeTruthy()
  })

  it('writes font-variation-settings when an axis field changes', () => {
    let written: [string, unknown] | null = null
    const axes: FontVariationAxis[] = [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }]
    function SpyHarness() {
      const ref = useRef<HTMLButtonElement>(null)
      return (
        <>
          <Button ref={ref} variant="ghost" size="xs">Trigger</Button>
          <TypographySettings
            id="typography-settings"
            anchorRef={ref}
            onClose={noop}
            storedStyles={{}}
            onChange={(p, v) => { written = [String(p), v] }}
            onRemove={noop}
            variationAxes={axes}
          />
        </>
      )
    }
    render(<SpyHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Variable' }))
    fireEvent.change(screen.getByLabelText('Weight (wght)'), { target: { value: '650' } })
    expect(written).toEqual(['fontVariationSettings', '"wght" 650'])
  })
})

describe('TypographySettings — sticky tab per id', () => {
  it('remembers the last active tab across close/reopen for the same id', async () => {
    function ToggleHarness({ open, id }: { open: boolean; id: string }) {
      const ref = useRef<HTMLButtonElement>(null)
      return (
        <>
          <Button ref={ref} variant="ghost" size="xs">Trigger</Button>
          {open && (
            <TypographySettings
              id={id}
              anchorRef={ref}
              onClose={noop}
              storedStyles={{}}
              onChange={noop}
              onRemove={noop}
              variationAxes={[]}
            />
          )}
        </>
      )
    }

    const { rerender } = render(<ToggleHarness open={true} id="typography-settings-sticky-test" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')

    rerender(<ToggleHarness open={false} id="typography-settings-sticky-test" />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    rerender(<ToggleHarness open={true} id="typography-settings-sticky-test" />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')
    })
  })
})
