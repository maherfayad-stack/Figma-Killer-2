import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'
import { buildDesignSystemManifest } from '../buildDesignSystemManifest'
import type { ComponentManifest } from '../../component-manifest/types'

// Runs against the REAL installed `@alm-design/design-system` package.
// Pinned to 1.1.2 so the assertions below (component names, Accolade's
// documented `size` enum) stay deterministic.
const require = createRequire(import.meta.url)
const installedVersion = (require('@alm-design/design-system/package.json') as { version: string }).version

describe('buildDesignSystemManifest', () => {
  it('is running against the pinned design-system version', () => {
    expect(installedVersion).toBe('1.1.2')
  })

  it('includes the expected core components', async () => {
    const manifest = await buildDesignSystemManifest()
    const names = manifest.components.map((c) => c.name)
    for (const expected of ['Button', 'Chip', 'Cell', 'Dialog', 'Accolade']) {
      expect(names).toContain(expected)
    }
  })

  it('gives Button a non-empty props array with name/tsType/required on every prop', async () => {
    const manifest = await buildDesignSystemManifest()
    const button = manifest.components.find((c) => c.name === 'Button')
    expect(button).toBeDefined()
    expect(button!.props.length).toBeGreaterThan(0)
    for (const prop of button!.props) {
      expect(typeof prop.name).toBe('string')
      expect(prop.name.length).toBeGreaterThan(0)
      expect(typeof prop.tsType).toBe('string')
      expect(typeof prop.required).toBe('boolean')
    }
  })

  it("parses Accolade's size enum from its apiDoc usage example", async () => {
    const manifest = await buildDesignSystemManifest()
    const accolade = manifest.components.find((c) => c.name === 'Accolade')
    expect(accolade).toBeDefined()

    const sizeProp = accolade!.props.find((p) => p.name === 'size')

    if (sizeProp?.enumValues) {
      // Preferred, explicit assertion: the package's documented behavior as
      // of 1.1.2 — `size="regular" // regular | small`.
      expect(sizeProp.enumValues).toContain('regular')
      expect(sizeProp.enumValues).toContain('small')
    } else {
      // Fallback only if the installed package genuinely differs: find ANY
      // component+prop with a parsed enum of at least two values.
      const anyEnumProp = manifest.components
        .flatMap((c) => c.props.map((p) => ({ component: c.name, prop: p })))
        .find(({ prop }) => (prop.enumValues?.length ?? 0) >= 2)

      expect(anyEnumProp).toBeDefined()
      expect(anyEnumProp!.prop.enumValues!.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('cleans enum tokens to bare values, dropping parenthetical/prose but keeping hyphenated values intact', async () => {
    const manifest = await buildDesignSystemManifest()
    const button = manifest.components.find((c) => c.name === 'Button')
    expect(button).toBeDefined()

    const sizeProp = button!.props.find((p) => p.name === 'size')
    expect(sizeProp?.enumValues).toEqual(['default', 'medium', 'small'])

    const dirProp = button!.props.find((p) => p.name === 'dir')
    expect(dirProp?.enumValues).toEqual(['ltr', 'rtl'])

    // Hyphenated values with no trailing space/paren must survive untouched.
    const variantProp = button!.props.find((p) => p.name === 'variant')
    expect(variantProp?.enumValues).toContain('primary')
    expect(variantProp?.enumValues).toContain('primary-inverted')

    const cell = manifest.components.find((c) => c.name === 'Cell')
    expect(cell).toBeDefined()
    const visualProp = cell!.props.find((p) => p.name === 'visual')
    expect(visualProp?.enumValues).toContain('icon')
    expect(visualProp?.enumValues).toContain('3d-icon')
    expect(visualProp?.enumValues).toContain('image')
    expect(visualProp?.enumValues).toContain('null')
  })

  it('keeps a multi-word enum value whole', async () => {
    // `Separator`'s `type="cell separator"  // cell separator (default) |
    // section separator`. The cleaner used to cut at the first whitespace,
    // which is identical for every single-word value and wrong here: the panel
    // offered `cell` / `section`, two values the component does not accept, and
    // an insert wrote one of them into the user's source.
    const manifest = await buildDesignSystemManifest()
    const separator = manifest.components.find((c) => c.name === 'Separator')
    expect(separator!.props.find((p) => p.name === 'type')?.enumValues).toEqual([
      'cell separator',
      'section separator',
    ])
  })

  it('drops a scope prefix in front of an option list', async () => {
    // `AdBanner`'s `size="small"  // mobile only: small (row) | medium | large`
    // — the prose names which layout the list applies to; the first option is
    // `small`, not `mobile`.
    const manifest = await buildDesignSystemManifest()
    const adBanner = manifest.components.find((c) => c.name === 'AdBanner')
    expect(adBanner!.props.find((p) => p.name === 'size')?.enumValues).toEqual(['small', 'medium', 'large'])
  })

  it("carries the package's documented example for a scalar prop, not just a collection", async () => {
    // This ran for collections only, on the reasoning that every other kind
    // already has an editable control. A component's CONTENT lives in its
    // scalars, so the result was that inserting one drew an empty shell.
    const manifest = await buildDesignSystemManifest()
    const byName = new Map(manifest.components.map((c) => [c.name, c]))
    const exampleOf = (component: string, prop: string) =>
      byName.get(component)?.props.find((p) => p.name === prop)?.example

    expect(exampleOf('SystemBanner', 'title')).toBe('Title')
    expect(exampleOf('Snackbar', 'message')).toBe('Seat preference saved')
    expect(exampleOf('Tooltip', 'content')).toBe('Tooltip text')
    expect(exampleOf('Accordion', 'title')).toBe('Accordion Item')
    expect(exampleOf('LinearProgressIndicator', 'value')).toBe(40)
    expect(exampleOf('ProgressStepper', 'steps')).toBe(5)
    expect(exampleOf('ProgressStepper', 'currentStep')).toBe(2)
  })

  it('reads props written several to a line', async () => {
    // `<Badge variant="alert" count={5} max={99} />`. The line-based pass needs
    // one prop per line — it is anchored at both ends so the trailing enum
    // comment is not swallowed into the value — so a one-line example yielded
    // nothing at all: all three props unclassified (a text box each) and
    // unseeded, and an inserted Badge was an empty pip forever.
    const manifest = await buildDesignSystemManifest()
    const badge = manifest.components.find((c) => c.name === 'Badge')
    const prop = (name: string) => badge!.props.find((p) => p.name === name)
    expect(prop('variant')?.kind).toBe('string')
    expect(prop('variant')?.example).toBe('alert')
    expect(prop('count')?.kind).toBe('number')
    expect(prop('count')?.example).toBe(5)
    expect(prop('max')?.example).toBe(99)
  })

  it('reads only the FIRST usage example when a fence holds several', async () => {
    // `Dialog` documents an iOS call (`primaryAction`/`destructiveAction`/
    // `secondaryAction`) and then an Android one (`action1`/`action2`) in one
    // fence. They are alternatives: reading the whole fence seeded all five, so
    // an inserted iOS dialog arrived carrying two Android-only buttons.
    const manifest = await buildDesignSystemManifest()
    const dialog = manifest.components.find((c) => c.name === 'Dialog')
    const example = (name: string) => dialog!.props.find((p) => p.name === name)?.example
    expect(example('primaryAction')).toEqual({ label: 'Primary' })
    expect(example('secondaryAction')).toEqual({ label: 'Secondary' })
    expect(example('action1')).toBeUndefined()
    expect(example('action2')).toBeUndefined()
  })

  it('does not truncate a multi-line example at a blank line inside it', async () => {
    // `Navbar`'s single example is full of blank lines and section comments
    // INSIDE its `toolbar={{ … }}` object. A blank-line cut left it with three
    // props and cost the component its `chips` and `segmentedControl` — an
    // empty bar, the exact defect the first-example rule was added to prevent.
    const manifest = await buildDesignSystemManifest()
    const navbar = manifest.components.find((c) => c.name === 'Navbar')
    const chips = navbar!.props.find((p) => p.name === 'chips')?.example
    expect(Array.isArray(chips)).toBe(true)
    expect((chips as unknown[]).length).toBeGreaterThan(0)
  })

  it('records no example for an asset path or a React node', async () => {
    // `imageSrc="/photo.jpg"` names a file the user's project does not have,
    // and `icon={<SvgIcon/>}` has no JSON form at all.
    const manifest = await buildDesignSystemManifest()
    const byName = new Map(manifest.components.map((c) => [c.name, c]))
    const exampleOf = (component: string, prop: string) =>
      byName.get(component)?.props.find((p) => p.name === prop)?.example

    expect(exampleOf('VisualCard', 'imageSrc')).toBeUndefined()
    expect(exampleOf('Banner', 'iconSrc')).toBeUndefined()
    expect(exampleOf('Cell', 'sideIconSrc')).toBeUndefined()
    expect(exampleOf('IconButton', 'icon')).toBeUndefined()
  })

  it("sets every component's file to the package import specifier", async () => {
    const manifest: ComponentManifest = await buildDesignSystemManifest()
    expect(manifest.components.length).toBeGreaterThan(0)
    for (const component of manifest.components) {
      expect(component.file).toBe('@alm-design/design-system')
    }
  })
})
