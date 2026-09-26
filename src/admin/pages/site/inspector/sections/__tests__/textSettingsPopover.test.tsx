/**
 * TextSettingsPopover — the Text section's ⚙ popover (`STATE.md` `panel-25`,
 * P3 item 9). Renamed and relocated from the pre-migration
 * `panels/PropertiesPanel/__tests__/typographySection.test.tsx`'s own
 * `TypographySettings` coverage — a leaf, props-driven component with no
 * store dependency, kept as its own file (not folded into
 * `textSection.test.tsx`) the same way `imageFill.test.tsx` splits out of
 * `fillSection.test.tsx` for a `FillSection` sub-part.
 *
 * Covers: opening on demand, every Basics property reachable and writing
 * correctly across control shapes, the Details tab's uncurated properties,
 * the Variable tab's presence/absence and writes, and sticky-per-id tab
 * memory.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Button } from '@ui/components/Button'
import { TextSettingsPopover } from '../TextSettingsPopover'
import type { FontVariationAxis } from '@core/fonts'

afterEach(cleanup)

function noop() {}

function TextSettingsPopoverHarness({
  variationAxes = [],
  id = 'text-settings',
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
      <TextSettingsPopover
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

describe('TextSettingsPopover — opens on demand', () => {
  it('every Basics property is reachable through the ⚙', () => {
    render(<TextSettingsPopoverHarness />)

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
    function SpyHarness() {
      const ref = useRef<HTMLButtonElement>(null)
      return (
        <>
          <Button ref={ref} variant="ghost" size="xs">Trigger</Button>
          <TextSettingsPopover
            id="text-settings"
            anchorRef={ref}
            onClose={noop}
            storedStyles={{}}
            onChange={(p, v) => { written = [String(p), v] }}
            onRemove={noop}
            variationAxes={[]}
          />
        </>
      )
    }
    render(<SpyHarness />)

    // fontStyle: icon toggle group (getIconEnumOptions).
    fireEvent.click(screen.getByRole('button', { name: /font style: italic/i }))
    expect(written).toEqual(['fontStyle', 'italic'])

    // whiteSpace: the Select combobox (no icon enum) — a custom listbox, not
    // a native <select>, per Select.tsx.
    const whiteSpaceCombobox = screen.getByRole('combobox', { name: 'White space' })
    fireEvent.click(whiteSpaceCombobox.nextElementSibling as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'nowrap' }))
    expect(written).toEqual(['whiteSpace', 'nowrap'])

    // textIndent: a plain text/length control — not curated in cssControlTypes.ts,
    // reached through the same generic row machinery via the `as keyof CSSPropertyBag` cast.
    // It commits on blur, not per keystroke (`TextControl`'s draft, P2-G).
    const textIndent = screen.getByLabelText('Text indent')
    fireEvent.change(textIndent, { target: { value: '2em' } })
    fireEvent.blur(textIndent)
    expect(written).toEqual(['textIndent', '2em'])
  })
})

describe('TextSettingsPopover — Details tab', () => {
  it('curates fontVariantNumeric / fontFeatureSettings / hangingPunctuation / fontKerning, uncurated anywhere else', () => {
    render(<TextSettingsPopoverHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByTestId('css-property-row-fontVariantNumeric')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-fontFeatureSettings')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-hangingPunctuation')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-fontKerning')).toBeTruthy()
  })
})

describe('TextSettingsPopover — Variable tab', () => {
  it('is absent when the font exposes no axes (the static-font case)', () => {
    render(<TextSettingsPopoverHarness variationAxes={[]} />)
    expect(screen.queryByRole('tab', { name: 'Variable' })).toBeNull()
  })

  it('is present, with one row per axis, when the font exposes axes', () => {
    const axes: FontVariationAxis[] = [
      { tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 },
      { tag: 'wdth', name: 'Width', min: 75, max: 125, default: 100 },
    ]
    render(<TextSettingsPopoverHarness variationAxes={axes} />)
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
          <TextSettingsPopover
            id="text-settings"
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

describe('TextSettingsPopover — sticky tab per id', () => {
  it('remembers the last active tab across close/reopen for the same id', async () => {
    function ToggleHarness({ open, id }: { open: boolean; id: string }) {
      const ref = useRef<HTMLButtonElement>(null)
      return (
        <>
          <Button ref={ref} variant="ghost" size="xs">Trigger</Button>
          {open && (
            <TextSettingsPopover
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

    const { rerender } = render(<ToggleHarness open={true} id="text-settings-sticky-test" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')

    rerender(<ToggleHarness open={false} id="text-settings-sticky-test" />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    rerender(<ToggleHarness open={true} id="text-settings-sticky-test" />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')
    })
  })
})
