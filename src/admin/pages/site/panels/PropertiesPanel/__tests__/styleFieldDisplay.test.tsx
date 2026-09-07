/**
 * The one display rule: a style field shows the value the element actually
 * renders, not an empty box behind a grey hint.
 *
 * The user's report: "when selecting anything overall the panel should be
 * prefilled already with the current values even if inline styles". These
 * cases pin both halves — the pure resolver, and the fact that a prefilled
 * field is still visibly NOT set on its target.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MIXED } from '@ui/components/MixedValue'
import { resolveStyleFieldDisplay } from '@site/panels/PropertiesPanel/styleFieldDisplay'
import { StackedPropertyGrid } from '@site/panels/PropertiesPanel/StackedPropertyGrid'
import { SizeSection } from '@site/panels/PropertiesPanel/SizeSection'
import type { SizingParentLayout } from '@site/panels/PropertiesPanel/elementSizing'

afterEach(cleanup)

const BLOCK_PARENT: SizingParentLayout = { display: 'block', flexDirection: 'row' }

describe('resolveStyleFieldDisplay', () => {
  it('shows the stored value when the target declares one', () => {
    expect(
      resolveStyleFieldDisplay({ storedValue: '24px', currentValue: '16px' }),
    ).toEqual({ value: '24px', placeholder: undefined, isSet: true, inherited: false })
  })

  it('shows the current value, muted and unset, when the target declares nothing', () => {
    expect(
      resolveStyleFieldDisplay({ storedValue: undefined, currentValue: '16px' }),
    ).toEqual({ value: '16px', placeholder: undefined, isSet: false, inherited: true })
  })

  it('treats an empty string as unset, in either bag', () => {
    expect(resolveStyleFieldDisplay({ storedValue: '', currentValue: '16px' }).value).toBe('16px')
    expect(resolveStyleFieldDisplay({ storedValue: '', currentValue: '' }).value).toBeUndefined()
  })

  it('falls back to the hint only when there is nothing real to show', () => {
    expect(
      resolveStyleFieldDisplay({ storedValue: undefined, currentValue: undefined, fallback: 'auto' }),
    ).toEqual({ value: undefined, placeholder: 'auto', isSet: false, inherited: false })
  })

  it('never prefills a disagreeing multi-selection', () => {
    // A value none of the selected elements necessarily has is not a value.
    expect(resolveStyleFieldDisplay({ storedValue: MIXED, currentValue: '16px' })).toEqual({
      value: MIXED,
      placeholder: undefined,
      isSet: false,
      inherited: false,
    })
    expect(resolveStyleFieldDisplay({ storedValue: undefined, currentValue: MIXED }).value).toBe(MIXED)
  })

  it('numbers count as values', () => {
    expect(resolveStyleFieldDisplay({ storedValue: 0, currentValue: '1' })).toEqual({
      value: '0',
      placeholder: undefined,
      isSet: true,
      inherited: false,
    })
  })
})

describe('a prefilled row still reads as unset', () => {
  it('fills the field with the current value and marks the row inherited', () => {
    render(
      <StackedPropertyGrid
        spec={['fontSize']}
        visibleProperties={['fontSize']}
        storedStyles={{}}
        currentStyles={{ fontSize: '18px' }}
        activeTab="base"
        onChange={() => {}}
        onRemove={() => {}}
      />,
    )

    const field = screen.getByLabelText('Font size') as HTMLInputElement
    expect(field.value).toBe('18px')
    const row = document.querySelector('[data-testid="css-property-row-fontSize"]')
    expect(row?.getAttribute('data-state')).toBe('unset')
    expect(row?.getAttribute('data-inherited')).toBe('true')
  })

  it('does not mark a row inherited when the target declares the value', () => {
    render(
      <StackedPropertyGrid
        spec={['fontSize']}
        visibleProperties={['fontSize']}
        storedStyles={{ fontSize: '24px' }}
        currentStyles={{ fontSize: '24px' }}
        activeTab="base"
        onChange={() => {}}
        onRemove={() => {}}
      />,
    )

    const field = screen.getByLabelText('Font size') as HTMLInputElement
    expect(field.value).toBe('24px')
    const row = document.querySelector('[data-testid="css-property-row-fontSize"]')
    expect(row?.getAttribute('data-state')).toBe('set')
    expect(row?.getAttribute('data-inherited')).toBeNull()
  })
})

describe('bespoke sections prefill too', () => {
  it('fills W/H from the frame reading when nothing is stored', () => {
    render(
      <SizeSection
        activeTab="base"
        storedStyles={{}}
        currentStyles={{ width: '320px', height: '48px' }}
        parentLayout={BLOCK_PARENT}
        onChange={() => {}}
        onRemove={() => {}}
        onClearProperty={() => {}}
        visibleProperties={['width', 'height']}
      />,
    )

    expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('320px')
    expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('48px')
    // …and the field says the value is not this target's own.
    expect(
      screen.getByTestId('css-size-input-width-scrub').getAttribute('data-inherited'),
    ).toBe('true')
  })

  it('leaves a stored value unmarked', () => {
    render(
      <SizeSection
        activeTab="base"
        storedStyles={{ width: '200px' }}
        currentStyles={{ width: '200px', height: '48px' }}
        parentLayout={BLOCK_PARENT}
        onChange={() => {}}
        onRemove={() => {}}
        onClearProperty={() => {}}
        visibleProperties={['width', 'height']}
      />,
    )

    expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('200px')
    expect(
      screen.getByTestId('css-size-input-width-scrub').getAttribute('data-inherited'),
    ).toBeNull()
  })
})
