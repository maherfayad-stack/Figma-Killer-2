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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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

describe('structured props offer no control', () => {
  /**
   * THE BUG: `items={[{ icon: <HomeIcon/>, label: 'Home' }]}` was classified
   * `undefined` by the docs pass and fell through to a TEXT BOX. The module
   * doc called that "the honest failure mode"; it is not. Every value the box
   * accepts is wrong — typing `5` reached `items.map(...)` inside the real
   * component and put "TabBar (render error)" on the canvas. A write with no
   * honest target is one the editor is supposed to REFUSE, which for a
   * property row means not offering the row.
   */
  const manifest = manifestJson as ComponentManifest

  it('classifies a documented array literal as a collection', () => {
    const tabBar = manifest.components.find((c) => c.name === 'TabBar')
    expect(tabBar?.props.find((p) => p.name === 'items')?.kind).toBe('collection')
  })

  it('offers no property row for any collection prop', () => {
    const offenders: string[] = []
    for (const component of manifest.components) {
      const mod = registry.get(`alm.${component.name}`)
      if (!mod) continue
      for (const prop of component.props) {
        if (prop.kind !== 'collection') continue
        if (prop.name in mod.schema) offenders.push(`${component.name}.${prop.name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('still finds collection props at all, so the classifier cannot silently stop working', () => {
    // 21 across 12 components when this landed. A drop to zero would mean the
    // docs pass regressed and every one of them is a text box again.
    const total = manifest.components.reduce(
      (count, c) => count + c.props.filter((p) => p.kind === 'collection').length,
      0,
    )
    expect(total).toBeGreaterThan(10)
  })

  it('leaves scalar props alone', () => {
    // The refusal must be narrow: TabBar's other props are still editable.
    const tabBar = registry.get('alm.TabBar')
    expect(tabBar && 'platform' in tabBar.schema).toBe(true)
    expect(tabBar && 'value' in tabBar.schema).toBe(true)
  })
})

describe('a structured prop holding a scalar is reported, not rendered', () => {
  /**
   * The state Studio's own text box created and left behind in real sources:
   * `<TabBar platform="ios" items="5" />`. `items.map(...)` threw and the
   * boundary could only say "TabBar (render error)" — the component's name and
   * nothing else, so finding the cause meant deleting props one at a time.
   *
   * The node is deliberately still NOT rendered. Dropping the bad prop would
   * show a healthy TabBar over source that genuinely breaks in a real browser,
   * and a canvas more forgiving than reality is the one thing it must not be.
   */
  function renderAlm(name: string, props: Record<string, unknown>): string {
    const mod = registry.get(`alm.${name}`)
    if (!mod?.component) return ''
    return renderToStaticMarkup(createElement(mod.component as never, { props } as never))
  }

  it('names the offending prop and the value it found', () => {
    const html = renderAlm('TabBar', { platform: 'ios', items: '5' })
    expect(html).toContain('items')
    expect(html).toContain('5')
    expect(html).not.toContain('render error')
  })

  it('renders normally when the structured prop is absent', () => {
    // `<TabBar platform="ios" />` is valid — the component supplies its own
    // default, so this must not be dragged into the refusal.
    const html = renderAlm('TabBar', { platform: 'ios' })
    expect(html).not.toContain('expects a list')
  })

  it('accepts a real list', () => {
    const html = renderAlm('TabBar', { platform: 'ios', items: [{ label: 'Home' }] })
    expect(html).not.toContain('expects a list')
  })
})

