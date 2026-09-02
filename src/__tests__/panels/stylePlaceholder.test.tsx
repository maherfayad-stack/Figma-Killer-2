/**
 * What an unset property row offers as its placeholder.
 *
 * Track F1 made this the frame's real `getComputedStyle` value, which fixed a
 * genuine lie ("a field can confidently read `transparent` on an element
 * rendering red") and introduced two smaller ones nobody caught:
 * `getComputedStyle` answers in the browser's vocabulary, so an applied
 * colour style rendered as `rgb(135, 91, 247)` rather than the
 * `var(--brand-500)` the user actually wrote, and every shorthand came back
 * fully expanded.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { resolveStylePlaceholder } from '@site/panels/PropertiesPanel/stylePlaceholder'
import type { PropertyProvenance } from '@site/panels/PropertiesPanel/stylePropertyProvenance'
import { StackedPropertyGrid } from '@site/panels/PropertiesPanel/StackedPropertyGrid'

afterEach(cleanup)

function provenance(
  property: keyof CSSPropertyBag,
  sources: Array<{ label: string; value: string; winner: boolean }>,
  computedValue?: string,
): PropertyProvenance {
  return {
    property,
    sources: sources.map((s) => ({ kind: 'class', classId: s.label, ...s })),
    confidence: sources.some((s) => s.winner) ? 'exact-match' : 'ambiguous',
    computedValue,
    inherited: false,
  }
}

describe('resolveStylePlaceholder', () => {
  it("quotes the winning declaration's own text, not the browser's resolution of it", () => {
    const result = resolveStylePlaceholder({
      property: 'color',
      provenance: provenance('color', [
        { label: '.brand-ink', value: 'var(--brand-500)', winner: true },
      ], 'rgb(135, 91, 247)'),
      currentValue: 'rgb(135, 91, 247)',
    })

    expect(result).toBe('var(--brand-500)')
  })

  it('falls back to the computed value when the cascade is ambiguous', () => {
    // Two classes declare it and neither could be crowned honestly — see
    // `stylePropertyProvenance`'s "refuse rather than guess". The row still
    // shows the truth, it just stops claiming to know who wrote it.
    const result = resolveStylePlaceholder({
      property: 'color',
      provenance: provenance('color', [
        { label: '.a', value: 'red', winner: false },
        { label: '.b', value: 'blue', winner: false },
      ], 'rgb(0, 0, 255)'),
      currentValue: 'rgb(0, 0, 255)',
    })

    expect(result).toBe('rgb(0, 0, 255)')
  })

  it('shows nothing rather than an expanded shorthand', () => {
    // What this actually looked like in the panel:
    // `rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box`
    expect(
      resolveStylePlaceholder({
        property: 'background',
        currentValue: 'rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box',
      }),
    ).toBeUndefined()

    expect(
      resolveStylePlaceholder({
        property: 'animation',
        currentValue: 'none 0s ease 0s 1 normal none running',
      }),
    ).toBeUndefined()
  })

  it('still shows a shorthand the user actually declared', () => {
    // The suppression is about the BROWSER's expansion, not about the
    // property. If the CSS literally says this, it belongs in the field.
    const result = resolveStylePlaceholder({
      property: 'background',
      provenance: provenance('background', [
        { label: '.hero', value: 'url(hero.png) center / cover', winner: true },
      ]),
      currentValue: 'rgba(0, 0, 0, 0) none repeat scroll 0% 0%',
    })

    expect(result).toBe('url(hero.png) center / cover')
  })

  it('keeps the longhands, which are the readable half of a shorthand', () => {
    expect(
      resolveStylePlaceholder({ property: 'backgroundRepeat', currentValue: 'repeat' }),
    ).toBe('repeat')
  })
})

describe('provenance reaches the compact sections', () => {
  it('places the winning declaration in the placeholder of a grid row', () => {
    // The four grid-backed sections (Typography, Background, Effects,
    // Interaction) never received provenance — so applying a colour style
    // left the row reading as unset with a raw `rgb(…)` beneath it and no
    // indication anything had happened.
    render(
      <StackedPropertyGrid
        spec={['color']}
        visibleProperties={['color']}
        currentStyles={{ color: 'rgb(135, 91, 247)' }}
        storedStyles={{}}
        activeTab="base"
        onChange={() => {}}
        onRemove={() => {}}
        provenanceByProperty={
          new Map([
            ['color', provenance('color', [
              { label: '.brand-ink', value: 'var(--brand-500)', winner: true },
            ], 'rgb(135, 91, 247)')],
          ])
        }
      />,
    )

    const field = screen.getByRole('textbox', { name: 'Color' }) as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('var(--brand-500)')
  })

  it('draws the losing declarations, and nothing when there are none', () => {
    const { rerender } = render(
      <StackedPropertyGrid
        spec={['color']}
        visibleProperties={['color']}
        currentStyles={{}}
        storedStyles={{}}
        activeTab="base"
        onChange={() => {}}
        onRemove={() => {}}
        provenanceByProperty={
          new Map([
            ['color', provenance('color', [
              { label: '.brand-ink', value: 'var(--brand-500)', winner: true },
              { label: '.legacy', value: '#333', winner: false },
            ])],
          ])
        }
      />,
    )
    expect(screen.getByTestId('css-property-provenance-color').textContent).toContain('.legacy')

    // An inherited-but-undeclared property draws no strip at all. It used to
    // draw an `inherited` chip, which fired on all ten Typography rows at
    // once the moment provenance reached that section.
    rerender(
      <StackedPropertyGrid
        spec={['color']}
        visibleProperties={['color']}
        currentStyles={{}}
        storedStyles={{}}
        activeTab="base"
        onChange={() => {}}
        onRemove={() => {}}
        provenanceByProperty={
          new Map([
            ['color', { ...provenance('color', []), inherited: true }],
          ])
        }
      />,
    )
    expect(screen.queryByTestId('css-property-provenance-color')).toBeNull()
  })
})
