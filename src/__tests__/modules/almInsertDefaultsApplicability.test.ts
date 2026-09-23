/**
 * What an insert WRITES must be a prop the inserted variant can use.
 *
 * `PropSpec.appliesWhen` records the package's own "shown by
 * `gpay-personalized`" note, and the Properties panel has honoured it since
 * PR #119 hid the rows that do not apply. The insert path did not: it seeded
 * every documented example unconditionally, so a freshly inserted
 * `<Button variant="primary">` arrived carrying `cardLast4="1394"` — a masked
 * card number only the `gpay-personalized` variant ever renders — and the
 * panel then hid the very row that would have let the author remove it.
 *
 * Two shapes of assertion, on purpose. The manifest-wide invariant is what
 * keeps the NEXT gated prop honest without anyone naming it; the hand-built
 * spec pins the other half of the rule — a gate that IS satisfied by the
 * seeded (or curated) controlling value keeps its example.
 */
import { describe, expect, it } from 'bun:test'
import manifestJson from '@modules/alm/manifest.generated.json'
import type { ComponentManifest, PropSpec } from '@core/component-manifest'
import type { DesignSystemComponentSpec } from '@core/design-system-manifest'
import { buildDefaults } from '@modules/alm/inspectorSchema'

const manifest = manifestJson as ComponentManifest

function specFor(name: string): DesignSystemComponentSpec {
  const spec = manifest.components.find((c) => c.name === name)
  if (!spec) throw new Error(`No ${name} in the generated manifest`)
  return { ...spec, description: '', keywords: [], group: 'test' }
}

function prop(name: string, extra: Partial<PropSpec>): PropSpec {
  return { name, tsType: 'unknown', required: false, kind: 'string', ...extra }
}

const cardSpec = (variantExample: string | undefined): DesignSystemComponentSpec => ({
  name: 'CardButton',
  file: 'x.jsx',
  exportName: 'CardButton',
  isDefaultExport: false,
  description: '',
  keywords: [],
  group: 'test',
  props: [
    prop('variant', { kind: 'enum', enumValues: ['primary', 'gpay-personalized'], example: variantExample }),
    prop('cardLast4', { example: '1394', appliesWhen: { prop: 'variant', values: ['gpay-personalized'] } }),
    prop('label', { example: 'Pay' }),
  ],
})

describe('buildDefaults — a gated prop is written only for a variant it applies to', () => {
  it('a primary Button does not arrive carrying a card number', () => {
    const defaults = buildDefaults(specFor('Button'))
    expect(defaults.variant).toBe('primary')
    expect(defaults).not.toHaveProperty('cardLast4')
    expect(defaults).not.toHaveProperty('cardArt')
    // The fix is a filter, not a blanket: ungated content still seeds.
    expect(defaults.label).toBe('Label')
  })

  it('every gated default in the manifest is satisfied by the seeded value of its controlling prop', () => {
    for (const component of manifest.components) {
      const defaults = buildDefaults({ ...component, description: '', keywords: [], group: 'test' })
      for (const p of component.props) {
        if (!p.appliesWhen || !(p.name in defaults)) continue
        expect({ component: component.name, prop: p.name, controlling: defaults[p.appliesWhen.prop] }).toEqual({
          component: component.name,
          prop: p.name,
          controlling: expect.stringMatching(new RegExp(`^(${p.appliesWhen.values.join('|')})$`)),
        })
      }
    }
  })

  it('keeps the example when the seeded controlling value satisfies the gate', () => {
    expect(buildDefaults(cardSpec('gpay-personalized'))).toEqual({
      variant: 'gpay-personalized',
      cardLast4: '1394',
      label: 'Pay',
    })
  })

  it('drops it when the enum falls back to its first option, which the gate does not name', () => {
    expect(buildDefaults(cardSpec(undefined))).toEqual({ variant: 'primary', label: 'Pay' })
  })
})
