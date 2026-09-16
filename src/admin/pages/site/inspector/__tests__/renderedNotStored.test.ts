import { describe, expect, it } from 'bun:test'
import { rendersUnstoredValue } from '../renderedNotStored'
import type { PropertyProvenance } from '../../panels/PropertiesPanel/stylePropertyProvenance'

function provenance(overrides: Partial<PropertyProvenance>): PropertyProvenance {
  return {
    property: 'backgroundColor',
    sources: [],
    confidence: 'none',
    computedValue: undefined,
    inherited: false,
    ...overrides,
  }
}

describe('rendersUnstoredValue', () => {
  it('is false when a source already declares the property — it is stored, not "rendered not stored"', () => {
    const result = rendersUnstoredValue(
      provenance({
        sources: [{ kind: 'inline', label: 'Element', value: '#fff', winner: true }],
        confidence: 'inline',
        computedValue: '#fff',
      }),
    )
    expect(result).toBe(false)
  })

  it('is false when there is no computed value at all (no frame truth yet)', () => {
    expect(rendersUnstoredValue(provenance({ computedValue: undefined }))).toBe(false)
  })

  it('is true for an inherited property with a real computed value and nothing stored', () => {
    expect(
      rendersUnstoredValue(
        provenance({ property: 'color', computedValue: 'rgb(0, 0, 0)', inherited: true }),
      ),
    ).toBe(true)
  })

  it('is false for a non-inherited property whose computed value IS the true CSS initial', () => {
    expect(
      rendersUnstoredValue(
        provenance({ property: 'backgroundColor', computedValue: 'rgba(0, 0, 0, 0)', inherited: false }),
      ),
    ).toBe(false)
  })

  it('is true for a non-inherited property whose computed value differs from the true CSS initial', () => {
    expect(
      rendersUnstoredValue(
        provenance({ property: 'backgroundColor', computedValue: 'rgb(255, 255, 255)', inherited: false }),
      ),
    ).toBe(true)
  })

  it('is false when there is no provenance at all', () => {
    expect(rendersUnstoredValue(undefined)).toBe(false)
  })
})
