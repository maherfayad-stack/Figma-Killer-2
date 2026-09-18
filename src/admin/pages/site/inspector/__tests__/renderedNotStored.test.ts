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
  it('is false whenever the ACTIVE CONTEXT already stores the property, regardless of provenance', () => {
    const result = rendersUnstoredValue(
      provenance({
        sources: [{ kind: 'inline', label: 'Element', value: '#fff', winner: true }],
        confidence: 'inline',
        computedValue: '#fff',
      }),
      true,
    )
    expect(result).toBe(false)
  })

  it('is false when there is no computed value at all (no frame truth yet)', () => {
    expect(rendersUnstoredValue(provenance({ computedValue: undefined }), false)).toBe(false)
  })

  it('is true for an inherited property with a real computed value and nothing stored anywhere', () => {
    expect(
      rendersUnstoredValue(
        provenance({ property: 'color', computedValue: 'rgb(0, 0, 0)', inherited: true }),
        false,
      ),
    ).toBe(true)
  })

  it('is false for a non-inherited property whose computed value IS the true CSS initial', () => {
    expect(
      rendersUnstoredValue(
        provenance({ property: 'backgroundColor', computedValue: 'rgba(0, 0, 0, 0)', inherited: false }),
        false,
      ),
    ).toBe(false)
  })

  it('is true for a non-inherited property whose computed value differs from the true CSS initial', () => {
    expect(
      rendersUnstoredValue(
        provenance({ property: 'backgroundColor', computedValue: 'rgb(255, 255, 255)', inherited: false }),
        false,
      ),
    ).toBe(true)
  })

  it('is false when there is no provenance at all', () => {
    expect(rendersUnstoredValue(undefined, false)).toBe(false)
  })

  // `STATE.md` panel-32 — the breakpoint-context gap: something DOES declare
  // the property (a real class source, from the EFFECTIVE chain), just not
  // at the active context. This must qualify on its own, without consulting
  // the CSS-initial-value guard — a declared source is never a UA default.
  describe('panel-32 — declared elsewhere, not at the active context', () => {
    it('is true when a class source declares it but the active context does not store it', () => {
      expect(
        rendersUnstoredValue(
          provenance({
            property: 'color',
            sources: [{ kind: 'class', classId: 'sc-1', label: '.title', value: 'var(--text-base-default)', winner: true }],
            confidence: 'exact-match',
            computedValue: 'rgb(17, 17, 17)',
            inherited: false,
          }),
          false,
        ),
      ).toBe(true)
    })

    it('is false once the active context DOES store it — a normal stored row, not muted', () => {
      expect(
        rendersUnstoredValue(
          provenance({
            property: 'color',
            sources: [{ kind: 'class', classId: 'sc-1', label: '.title', value: 'var(--text-base-default)', winner: true }],
            confidence: 'exact-match',
            computedValue: 'rgb(17, 17, 17)',
            inherited: false,
          }),
          true,
        ),
      ).toBe(false)
    })

    it('still requires a real computed value even when a source declares it elsewhere', () => {
      expect(
        rendersUnstoredValue(
          provenance({
            property: 'color',
            sources: [{ kind: 'class', classId: 'sc-1', label: '.title', value: 'var(--text-base-default)', winner: true }],
            confidence: 'exact-match',
            computedValue: undefined,
          }),
          false,
        ),
      ).toBe(false)
    })
  })
})
