/**
 * Every `@alm-design/design-system` module, inserted, one by one — does it
 * actually draw something?
 *
 * ## The defect this exists to end
 *
 * `<TabBar/>` was reported as "rendering with nothing in it", fixed by seeding
 * its `items` from the package's own documented example — and then the SAME
 * report came back pointing at a different empty bar. It was never a TabBar
 * bug. `buildDefaults` seeded exactly three things (a `label` from the
 * component's own name, a collection's example, an enum's first option) and
 * every other content-bearing prop got nothing, so a whole class of components
 * arrived on the canvas as blank shells:
 *
 *   - `SystemBanner`  — a bare tinted row (`title`, `description` unseeded)
 *   - `Snackbar`      — an empty capsule (`message`)
 *   - `Tooltip`       — an empty bubble (`content`)
 *   - `Accordion`     — an untitled header (`title`)
 *   - `ProgressStepper` — nothing at all (`steps` = 0 segments)
 *   - `LinearProgressIndicator` — a grey track at 0% (`value`)
 *   - `Badge`         — an empty pip (all three props unclassified)
 *
 * The author was handed a blank box and no clue which of eleven props would
 * make it visible. So this file does not test TabBar; it renders EVERY
 * registered module with the defaults an insert would write and fails on any
 * that comes out empty. Fixing one component at a time is what produced the
 * second bug report.
 *
 * ## What counts as "not empty"
 *
 * Deliberately generous, because these components are legitimately different
 * shapes: visible TEXT, or a glyph/control (`svg`, `img`, `input`, `hr`), or
 * internal STRUCTURE its props drove (`ProgressStepper` draws five bare divs
 * and `LinearProgressIndicator` a track + a fill — both correct, both
 * textless). The package's stylesheet is not loaded here, so anything
 * size-only is measured by the markup it emits rather than by pixels.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registry, type ModuleDefinition } from '@core/module-engine'
import manifestJson from '@modules/alm/manifest.generated.json'
import type { ComponentManifest } from '@core/component-manifest'
import { asJsonDataValue } from '@core/utils/jsonData'
import { svgToJsxNode } from '@site/studio/svgToJsxNode'
import '@modules/alm/register'

const manifest = manifestJson as ComponentManifest

/**
 * The one component that draws nothing from its defaults, and correctly.
 *
 * `IconButton`'s entire content is `icon={<SvgIcon/>}` — a React element, which
 * has no JSON form and therefore cannot be a seeded default. Inventing a glyph
 * would write design into the user's source that their own docs never asked
 * for, and an `<IconButton/>` with no icon renders an empty pill in a real
 * browser too. The canvas must not be more forgiving than reality; the
 * Properties panel gives `icon` a picker, which is where that value belongs.
 */
const DRAWS_NOTHING_BY_DESIGN = new Set(['alm.IconButton'])

function almModules(): ModuleDefinition[] {
  return registry
    .list()
    .filter((mod) => mod.id.startsWith('alm.'))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function renderWithDefaults(mod: ModuleDefinition): string {
  return renderToStaticMarkup(createElement(mod.component as never, { props: mod.defaults } as never))
}

/** `'text' | 'glyph' | 'structure'`, or `undefined` when the render drew nothing a user could see. */
function visibleContent(html: string): string | undefined {
  if (html.replace(/<[^>]*>/g, '').trim().length > 0) return 'text'
  if (/<(svg|img|input|hr|textarea|canvas|video)\b/.test(html)) return 'glyph'
  // The transparent `display: contents` host plus the component's own root are
  // structure every render has; anything beyond them was drawn from the props.
  return (html.match(/<[a-z]/g) ?? []).length > 2 ? 'structure' : undefined
}

describe('every alm module draws something when inserted', () => {
  it('registers a module for every documented component', () => {
    const missing = manifest.components.filter((c) => !registry.get(`alm.${c.name}`)).map((c) => c.name)
    expect(missing).toEqual([])
    expect(almModules().length).toBeGreaterThanOrEqual(manifest.components.length)
  })

  it('renders each one without throwing', () => {
    const threw: string[] = []
    for (const mod of almModules()) {
      try {
        renderWithDefaults(mod)
      } catch (err) {
        threw.push(`${mod.id}: ${(err as Error).message}`)
      }
    }
    expect(threw).toEqual([])
  })

  it('draws visible content for each one', () => {
    const blank: string[] = []
    for (const mod of almModules()) {
      if (DRAWS_NOTHING_BY_DESIGN.has(mod.id)) continue
      if (visibleContent(renderWithDefaults(mod)) === undefined) blank.push(mod.id)
    }
    expect(blank).toEqual([])
  })

  it('never falls back to the error boundary or the bad-prop notice', () => {
    // Both are real strings this render path can produce — `AlmErrorBoundary`'s
    // "(render error…)" and `badCollectionProps`' "expects a list" — and either
    // one on a freshly inserted component means its own defaults broke it.
    const broken: string[] = []
    for (const mod of almModules()) {
      const html = renderWithDefaults(mod)
      if (html.includes('render error') || html.includes('expects a list')) broken.push(mod.id)
    }
    expect(broken).toEqual([])
  })

  it('leaves the allowlist honest', () => {
    // An entry that has since started drawing content must be removed, or the
    // allowlist quietly stops being a list of known exceptions.
    const stillBlank = [...DRAWS_NOTHING_BY_DESIGN].filter((id) => {
      const mod = registry.get(id)
      return mod ? visibleContent(renderWithDefaults(mod)) === undefined : false
    })
    expect(stillBlank).toEqual([...DRAWS_NOTHING_BY_DESIGN])
  })
})

describe('what an insert seeds', () => {
  it('seeds every documented string and number example', () => {
    // The pipeline that produced 100+ of these can regress to zero silently —
    // the components still render, just empty, which is exactly how this went
    // unnoticed the first time.
    const unseeded: string[] = []
    for (const spec of manifest.components) {
      const mod = registry.get(`alm.${spec.name}`)
      if (!mod) continue
      for (const prop of spec.props) {
        if (prop.example === undefined || prop.name === 'dir') continue
        if (typeof prop.example === 'boolean' || /^error/i.test(prop.name)) continue
        if (mod.defaults[prop.name] === undefined) unseeded.push(`${spec.name}.${prop.name}`)
      }
    }
    expect(unseeded).toEqual([])
  })

  it('never seeds a component into its own error state', () => {
    // `TextInput`'s docs: "the error state is derived from `errorText` being
    // non-empty". Seeding the documented `"Error message"` put every newly
    // inserted field into its failure state, red border and all.
    const errored: string[] = []
    for (const mod of almModules()) {
      for (const name of Object.keys(mod.defaults)) {
        if (/^error/i.test(name)) errored.push(`${mod.id}.${name}`)
      }
    }
    expect(errored).toEqual([])
  })

  it('never seeds an asset path the project does not have', () => {
    // `imageSrc="/photo.jpg"` / `iconSrc="/icon.png"` are documentation
    // placeholders. Written into a real project they are guaranteed 404s.
    const paths: string[] = []
    for (const mod of almModules()) {
      for (const [name, value] of Object.entries(mod.defaults)) {
        if (typeof value === 'string' && /^\/.*\.(png|jpe?g|svg|webp|gif)$/i.test(value)) {
          paths.push(`${mod.id}.${name}=${value}`)
        }
      }
    }
    expect(paths).toEqual([])
  })

  it('survives the trip to disk — every seeded default is writable JSX', () => {
    // The seeding above is only half the fix. `insertableJsxProps` in
    // `nodeActions.ts` decides what actually reaches the user's `.tsx`, and it
    // used to drop every array and object — which is why "the tab bar renders
    // with nothing in it" survived two rounds of fixes: `items` was seeded,
    // reached that filter, and was discarded, so the source grew `<TabBar
    // platform="ios" value={0}/>` and the canvas re-read exactly that.
    const dropped: string[] = []
    for (const mod of almModules()) {
      for (const [name, value] of Object.entries(mod.defaults)) {
        if (asJsonDataValue(value) === undefined) dropped.push(`${mod.id}.${name}`)
      }
    }
    expect(dropped).toEqual([])
  })

  it('never seeds a boolean', () => {
    // A boolean is a mode, not content, and this package documents each at the
    // value the component already uses — so writing it back changes nothing and
    // costs an inserted `<TextInput>` five redundant attributes in a file a
    // human reads.
    const booleans: string[] = []
    for (const mod of almModules()) {
      for (const [name, value] of Object.entries(mod.defaults)) {
        if (typeof value === 'boolean') booleans.push(`${mod.id}.${name}`)
      }
    }
    expect(booleans).toEqual([])
  })
})

describe('TabBar — the two facts the package docs cannot supply', () => {
  /**
   * Reported against a screenshot of a real inserted tab bar: "icons didn't
   * load and I can't choose which tab is the current, and it's 5 tabs not 3".
   *
   * All three are the same gap. The docs pass reads the package's own example,
   * which writes `icon: <HomeIcon />` — no JSON form, so the icon is dropped —
   * and shows three tabs, while the same doc section says a tab bar holds "3–5
   * top-level destinations" and names five icons to use. See
   * `CURATED_DEFAULTS`.
   */
  const tabBar = () => registry.get('alm.TabBar')!
  const items = () => tabBar().defaults.items as { label?: string; icon?: { svg?: string } }[]

  it('starts with the five product destinations, in order', () => {
    expect(items().map((item) => item.label)).toEqual(['Home', 'Explore', 'My Trips', 'Top offers', 'Profile'])
  })

  it('gives every tab a real icon from the package', () => {
    for (const item of items()) {
      expect(item.icon?.svg).toContain('<svg')
      expect(item.icon?.svg).toContain('currentColor')
    }
  })

  it('renders all five icons, not five empty slots', () => {
    // `reviveIconProps` has to reach a `{ svg }` NESTED inside `items`. It only
    // looked at the top of a prop before, so the icons arrived as plain objects
    // and the component rendered nothing for them.
    const html = renderWithDefaults(tabBar())
    expect((html.match(/<svg/g) ?? [])).toHaveLength(5)
    for (const label of ['Home', 'Explore', 'My Trips', 'Top offers', 'Profile']) {
      expect(html).toContain(label)
    }
  })

  it('offers the tabs themselves for "which one is current", not a bare number', () => {
    // The panel used to show a field labelled `value` holding `0`, with nothing
    // saying it meant "which tab is selected".
    const control = tabBar().schema.value
    expect(control?.type).toBe('collection-index')
    expect((control as { collection?: string }).collection).toBe('items')
  })

  it('links the index to its collection from the docs, not from a hardcoded list', () => {
    // `value={0}  // active tab index (0-based, controlled)` — the comment is
    // the evidence, and exactly two props in this package carry it.
    const linked = manifest.components.flatMap((component) =>
      component.props
        .filter((prop) => prop.indexesCollection !== undefined)
        .map((prop) => `${component.name}.${prop.name}->${prop.indexesCollection}`),
    )
    expect(linked.sort()).toEqual(['SegmentedControl.value->items', 'TabBar.value->items'])
  })

  it('has icons that convert to a real <svg> element for the write to source', () => {
    // `icon={{ svg: "…" }}` renders on the canvas and throws "Objects are not
    // valid as a React child" in the user's actual app, so `insertableJsxProps`
    // converts each one through `svgToJsxNode` on the way to disk. A seeded icon
    // that cannot survive that conversion would be written as nothing at all —
    // an empty icon slot in the file, which is where this started.
    for (const item of items()) {
      const converted = svgToJsxNode(item.icon?.svg ?? '')
      expect(converted.ok).toBe(true)
      if (converted.ok) expect(converted.node.name).toBe('svg')
    }
  })
})
