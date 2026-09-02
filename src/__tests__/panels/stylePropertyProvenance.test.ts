import { describe, expect, it } from 'bun:test'
import {
  buildClassChain,
  provenanceEqual,
  resolvePropertyProvenance,
  type ClassChainEntry,
  type PropertyProvenance,
} from '@site/panels/PropertiesPanel/stylePropertyProvenance'
import type { StyleRule } from '@core/page-tree'

function makeRule(overrides: Partial<StyleRule> & { id: string; name: string }): StyleRule {
  return {
    kind: 'class',
    selector: `.${overrides.name}`,
    order: 0,
    styles: {},
    contextStyles: {},
    ...overrides,
  } as StyleRule
}

describe('buildClassChain', () => {
  it('resolves each class to its base styles when no context is active', () => {
    const card = makeRule({ id: 'c1', name: 'card', styles: { padding: '8px' } })
    const chain = buildClassChain([card], null)
    expect(chain).toEqual([{ classId: 'c1', selector: '.card', styles: { padding: '8px' } }])
  })

  it('merges the context override on top of base styles for the active context', () => {
    const card = makeRule({
      id: 'c1',
      name: 'card',
      styles: { padding: '8px', color: 'black' },
      contextStyles: { mobile: { padding: '4px' } },
    })
    const chain = buildClassChain([card], 'mobile')
    expect(chain[0].styles).toEqual({ padding: '4px', color: 'black' })
  })

  it('falls back to base styles when the active context has no override for this class', () => {
    const card = makeRule({ id: 'c1', name: 'card', styles: { padding: '8px' }, contextStyles: {} })
    const chain = buildClassChain([card], 'mobile')
    expect(chain[0].styles).toEqual({ padding: '8px' })
  })
})

describe('resolvePropertyProvenance', () => {
  it('reports "none" confidence and no sources when nothing declares the property', () => {
    const result = resolvePropertyProvenance('color', {
      classChain: [],
      inlineStyles: {},
      computedValue: 'rgb(0, 0, 0)',
    })
    expect(result.sources).toEqual([])
    expect(result.confidence).toBe('none')
  })

  it('marks inline as the winner over any class, and the class as a struck-through loser', () => {
    const classChain: ClassChainEntry[] = [{ classId: 'c1', selector: '.card', styles: { color: 'blue' } }]
    const result = resolvePropertyProvenance('color', {
      classChain,
      inlineStyles: { color: 'red' },
      computedValue: 'rgb(255, 0, 0)',
    })
    expect(result.confidence).toBe('inline')
    const inlineSource = result.sources.find((s) => s.kind === 'inline')!
    const classSource = result.sources.find((s) => s.kind === 'class')!
    expect(inlineSource.winner).toBe(true)
    expect(classSource.winner).toBe(false)
  })

  it('marks the single class source as winner with exact-match confidence when inline is absent', () => {
    const classChain: ClassChainEntry[] = [{ classId: 'c1', selector: '.card', styles: { color: 'blue' } }]
    const result = resolvePropertyProvenance('color', {
      classChain,
      inlineStyles: {},
      computedValue: 'rgb(0, 0, 255)',
    })
    expect(result.confidence).toBe('exact-match')
    expect(result.sources[0].winner).toBe(true)
  })

  it('attributes the winner among multiple classes by matching the computed value, striking through the other', () => {
    const classChain: ClassChainEntry[] = [
      { classId: 'c1', selector: '.card', styles: { color: 'blue' } },
      { classId: 'c2', selector: '.override', styles: { color: 'green' } },
    ]
    const result = resolvePropertyProvenance('color', {
      classChain,
      inlineStyles: {},
      computedValue: 'green',
    })
    expect(result.confidence).toBe('exact-match')
    const winner = result.sources.find((s) => s.winner)
    expect(winner?.classId).toBe('c2')
    expect(result.sources.find((s) => s.classId === 'c1')?.winner).toBe(false)
  })

  it('refuses to guess a winner among multiple classes when the computed value matches none or several — honest ambiguity, not a fabricated answer', () => {
    const classChain: ClassChainEntry[] = [
      { classId: 'c1', selector: '.card', styles: { color: 'blue' } },
      { classId: 'c2', selector: '.override', styles: { color: 'green' } },
    ]
    const result = resolvePropertyProvenance('color', {
      classChain,
      inlineStyles: {},
      computedValue: 'rgb(128, 0, 128)', // matches neither
    })
    expect(result.confidence).toBe('ambiguous')
    expect(result.sources.every((s) => !s.winner)).toBe(true)
  })

  it('flags a plausible ancestor-inherited value when nothing declares an inheritable property', () => {
    const result = resolvePropertyProvenance('color', {
      classChain: [],
      inlineStyles: {},
      computedValue: 'rgb(51, 51, 51)',
    })
    expect(result.inherited).toBe(true)
  })

  it('does not flag inheritance for a non-inheritable property with no declaration', () => {
    const result = resolvePropertyProvenance('display', {
      classChain: [],
      inlineStyles: {},
      computedValue: 'block',
    })
    expect(result.inherited).toBe(false)
  })

  it('does not flag inheritance when computedValue is unavailable (no frame rendered)', () => {
    const result = resolvePropertyProvenance('color', {
      classChain: [],
      inlineStyles: {},
      computedValue: undefined,
    })
    expect(result.inherited).toBe(false)
  })

  it('treats an empty-string stored value as unset, matching hasStyleValue everywhere else', () => {
    const classChain: ClassChainEntry[] = [{ classId: 'c1', selector: '.card', styles: { color: '' } }]
    const result = resolvePropertyProvenance('color', {
      classChain,
      inlineStyles: {},
      computedValue: 'rgb(0,0,0)',
    })
    expect(result.sources).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// provenanceEqual — perf-01
//
// `StyleSurface` recomputes `resolvePropertyProvenance` for all ~101 curated
// properties on every render (cheap — a short array filter per property).
// What used to hand every unaffected `ClassPropertyRow` a NEW object every
// keystroke was building a fresh `Map` of fresh result objects regardless of
// whether a given property's result actually changed. `provenanceEqual` is
// what lets `StyleSurface` reuse the PREVIOUS render's object for a property
// whose provenance is unchanged — these tests pin its equality contract
// directly, independent of the `useRef`-based map-reuse it enables.
// ---------------------------------------------------------------------------

describe('provenanceEqual', () => {
  const classChain: ClassChainEntry[] = [{ classId: 'c1', selector: '.card', styles: { color: 'blue' } }]

  function provenanceFor(computedValue: string | undefined): PropertyProvenance {
    return resolvePropertyProvenance('color', { classChain, inlineStyles: {}, computedValue })
  }

  it('is true for two structurally identical results computed separately', () => {
    const a = provenanceFor('rgb(0, 0, 255)')
    const b = provenanceFor('rgb(0, 0, 255)')
    expect(a).not.toBe(b) // distinct objects...
    expect(provenanceEqual(a, b)).toBe(true) // ...but equal
  })

  it('is false when the computed (ground-truth) value differs', () => {
    const a = provenanceFor('rgb(0, 0, 255)')
    const b = provenanceFor('rgb(0, 255, 0)')
    expect(provenanceEqual(a, b)).toBe(false)
  })

  it('is false when a source value changes even though computedValue is unchanged', () => {
    const a = resolvePropertyProvenance('color', {
      classChain: [{ classId: 'c1', selector: '.card', styles: { color: 'blue' } }],
      inlineStyles: {},
      computedValue: undefined,
    })
    const b = resolvePropertyProvenance('color', {
      classChain: [{ classId: 'c1', selector: '.card', styles: { color: 'navy' } }],
      inlineStyles: {},
      computedValue: undefined,
    })
    expect(provenanceEqual(a, b)).toBe(false)
  })

  it('is false when the winner attribution changes even though the source list looks the same', () => {
    const twoClasses: ClassChainEntry[] = [
      { classId: 'c1', selector: '.card', styles: { color: 'blue' } },
      { classId: 'c2', selector: '.override', styles: { color: 'green' } },
    ]
    const a = resolvePropertyProvenance('color', { classChain: twoClasses, inlineStyles: {}, computedValue: 'blue' })
    const b = resolvePropertyProvenance('color', { classChain: twoClasses, inlineStyles: {}, computedValue: 'green' })
    expect(provenanceEqual(a, b)).toBe(false)
  })

  it('is true for two empty (no sources, no computed value) results', () => {
    const a = resolvePropertyProvenance('display', { classChain: [], inlineStyles: {}, computedValue: undefined })
    const b = resolvePropertyProvenance('display', { classChain: [], inlineStyles: {}, computedValue: undefined })
    expect(provenanceEqual(a, b)).toBe(true)
  })
})
