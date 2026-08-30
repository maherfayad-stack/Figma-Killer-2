/**
 * The Properties panel's control for every `@alm-design/design-system` prop,
 * end to end from the generated manifest.
 *
 * Three defects this pins, all of them the same root cause — `register.tsx`
 * carried its OWN two-case control mapping (enum -> select, everything else ->
 * text) instead of the shared `controlForPropKind` every other component
 * surface uses:
 *   1. a boolean rendered as a text box you had to type the word `false` into;
 *   2. a number and a node rendered the same way;
 *   3. an `onClick` rendered as an editable field at all, which could only
 *      ever write a string where the component expects a function.
 *
 * And one that is not a control at all: `dir` was defaulted onto every
 * inserted component from the manifest's own enum order, and an explicit prop
 * outranks `DesignSystemProvider`, so the board's RTL toggle was defeated on
 * the 33 of 39 components that document a `dir` prop.
 */
import { describe, expect, it } from 'bun:test'
import { registry } from '@core/module-engine'
import manifestJson from '@modules/alm/manifest.generated.json'
import type { ComponentManifest } from '@core/component-manifest'
import '@modules/alm/register'

const manifest = manifestJson as ComponentManifest
const byName = new Map(manifest.components.map((c) => [c.name, c]))

function schemaFor(component: string): Record<string, { type: string }> {
  const mod = registry.get(`alm.${component}`)
  if (!mod) throw new Error(`alm.${component} is not registered`)
  return (mod.schema ?? {}) as Record<string, { type: string }>
}

describe('alm module prop controls', () => {
  it('gives a documented boolean a toggle, not a text box', () => {
    // `<Checkbox checked={false} disabled={false} error={false} skeleton={false}/>`
    const schema = schemaFor('Checkbox')
    for (const prop of ['checked', 'disabled', 'error', 'skeleton']) {
      expect(byName.get('Checkbox')?.props.find((p) => p.name === prop)?.kind).toBe('boolean')
      expect(schema[prop]?.type).toBe('toggle')
    }
  })

  it('gives a documented enum a select', () => {
    // `<GlassButton bg="default" // default | primary | dim />`
    expect(schemaFor('GlassButton').bg?.type).toBe('select')
  })

  it('gives a documented number a number control', () => {
    const cell = byName.get('Cell')!
    const numberProp = cell.props.find((p) => p.kind === 'number')!
    expect(numberProp).toBeDefined()
    expect(schemaFor('Cell')[numberProp.name]?.type).toBe('number')
  })

  it('gives an icon-valued prop the slot picker, never a text box', () => {
    // `<GlassButton icon1={<SvgIcon />} />`
    expect(byName.get('GlassButton')?.props.find((p) => p.name === 'icon1')?.kind).toBe('icon')
    expect(schemaFor('GlassButton').icon1?.type).toBe('slot')
  })

  it('offers no control at all for a handler prop', () => {
    expect(byName.get('GlassButton')?.props.find((p) => p.name === 'onClick')?.kind).toBe('handler')
    expect(schemaFor('GlassButton').onClick).toBeUndefined()
  })

  // The board's direction axis drives `dir` through `DesignSystemProvider`.
  // A per-node value — panel-set OR defaulted — outranks the provider and
  // pins that component against the toggle, so there must not be one.
  it('never exposes or defaults `dir` on any component', () => {
    const withDir = manifest.components.filter((c) => c.props.some((p) => p.name === 'dir'))
    expect(withDir.length).toBeGreaterThan(20) // the manifest really does document it widely
    for (const component of withDir) {
      const mod = registry.get(`alm.${component.name}`)!
      expect(schemaFor(component.name).dir).toBeUndefined()
      expect((mod.defaults as Record<string, unknown>).dir).toBeUndefined()
    }
  })
})
