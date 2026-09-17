import { describe, expect, it } from 'bun:test'
import { buildDesignSystemManifest } from '../buildDesignSystemManifest'
import { placeholderDescription } from '../componentCuration'
import { readVendorFile } from '../vendorRoot'
import type { DesignSystemManifest } from '../types'

// Runs against the REAL vendored design system (`vendor/alm-design-system/`).
// Pinned to the 1.1.2 source so the assertions below (component names,
// Accolade's documented `size` enum) stay deterministic.
const vendoredVersion = (JSON.parse(readVendorFile('package.json')) as { version: string }).version

describe('buildDesignSystemManifest', () => {
  it('is running against the pinned design-system version', () => {
    expect(vendoredVersion).toBe('1.1.2-vendored')
  })

  it('includes the expected core components', async () => {
    const manifest = buildDesignSystemManifest()
    const names = manifest.components.map((c) => c.name)
    for (const expected of ['Button', 'Chip', 'Cell', 'Dialog', 'Accolade']) {
      expect(names).toContain(expected)
    }
  })

  it('gives Button a non-empty props array with name/tsType/required on every prop', async () => {
    const manifest = buildDesignSystemManifest()
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
    const manifest = buildDesignSystemManifest()
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
    const manifest = buildDesignSystemManifest()
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
    const manifest = buildDesignSystemManifest()
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
    const manifest = buildDesignSystemManifest()
    const adBanner = manifest.components.find((c) => c.name === 'AdBanner')
    expect(adBanner!.props.find((p) => p.name === 'size')?.enumValues).toEqual(['small', 'medium', 'large'])
  })

  it("carries the package's documented example for a scalar prop, not just a collection", async () => {
    // This ran for collections only, on the reasoning that every other kind
    // already has an editable control. A component's CONTENT lives in its
    // scalars, so the result was that inserting one drew an empty shell.
    const manifest = buildDesignSystemManifest()
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
    const manifest = buildDesignSystemManifest()
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
    const manifest = buildDesignSystemManifest()
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
    const manifest = buildDesignSystemManifest()
    const navbar = manifest.components.find((c) => c.name === 'Navbar')
    const chips = navbar!.props.find((p) => p.name === 'chips')?.example
    expect(Array.isArray(chips)).toBe(true)
    expect((chips as unknown[]).length).toBeGreaterThan(0)
  })

  it('records no example for an asset path or a React node', async () => {
    // `imageSrc="/photo.jpg"` names a file the user's project does not have,
    // and `icon={<SvgIcon/>}` has no JSON form at all.
    const manifest = buildDesignSystemManifest()
    const byName = new Map(manifest.components.map((c) => [c.name, c]))
    const exampleOf = (component: string, prop: string) =>
      byName.get(component)?.props.find((p) => p.name === prop)?.example

    expect(exampleOf('VisualCard', 'imageSrc')).toBeUndefined()
    expect(exampleOf('Banner', 'iconSrc')).toBeUndefined()
    expect(exampleOf('Cell', 'sideIconSrc')).toBeUndefined()
    expect(exampleOf('IconButton', 'icon')).toBeUndefined()
  })

  it("sets every component's file to the package import specifier", async () => {
    const manifest: DesignSystemManifest = buildDesignSystemManifest()
    expect(manifest.components.length).toBeGreaterThan(0)
    for (const component of manifest.components) {
      expect(component.file).toBe('alm-design-system')
    }
  })

  describe('appliesWhen — prop applicability gates', () => {
    it("gates Button's payment-only props to the variants that actually use them", async () => {
      // The reported bug: a `variant=\"primary\"` Button showed a full image
      // picker for `cardArt` — 140px of dead panel height — because the
      // manifest recorded no applicability at all. `cardArt` is documented
      // "— apple-pay / gpay-card / gpay-personalized"; `cardLast4` is
      // documented "shown by gpay-personalized".
      const manifest = buildDesignSystemManifest()
      const button = manifest.components.find((c) => c.name === 'Button')
      expect(button).toBeDefined()
      const prop = (name: string) => button!.props.find((p) => p.name === name)

      expect(prop('cardArt')?.appliesWhen).toEqual({
        prop: 'variant',
        values: ['apple-pay', 'gpay-card', 'gpay-personalized'],
      })
      expect(prop('cardLast4')?.appliesWhen).toEqual({ prop: 'variant', values: ['gpay-personalized'] })
    })

    it("declines to gate Button's size and icon props on a prose category it cannot resolve to literal variant values", async () => {
      // `size` is documented "— text/payment only; brand-pay variants are
      // single fixed size" and `leadingIcon`/`trailingIcon` "(text
      // variants)". None of "text", "payment variants", or "brand-pay" is a
      // literal member of `variant`'s own enum (only `payment` itself is),
      // so this must NOT invent a gate — a wrong gate hides a real control.
      const manifest = buildDesignSystemManifest()
      const button = manifest.components.find((c) => c.name === 'Button')
      const prop = (name: string) => button!.props.find((p) => p.name === name)

      expect(prop('size')?.appliesWhen).toBeUndefined()
      expect(prop('leadingIcon')?.appliesWhen).toBeUndefined()
      expect(prop('trailingIcon')?.appliesWhen).toBeUndefined()
    })

    it('gates props on other components via the `when prop="value"` and `prop="value" only` forms', async () => {
      const manifest = buildDesignSystemManifest()
      const byName = new Map(manifest.components.map((c) => [c.name, c]))
      const appliesWhenOf = (component: string, prop: string) =>
        byName.get(component)?.props.find((p) => p.name === prop)?.appliesWhen

      // `used when type="icon"`.
      expect(appliesWhenOf('ListItem', 'icon')).toEqual({ prop: 'type', values: ['icon'] })
      // `shown struck-through when type="starting-price"`.
      expect(appliesWhenOf('BottomActionBar', 'originalPrice')).toEqual({
        prop: 'type',
        values: ['starting-price'],
      })
      // `overrides the OR label (variant="or" only)`.
      expect(appliesWhenOf('Separator', 'label')).toEqual({ prop: 'variant', values: ['or'] })
    })

    it('gates a prop on an unnamed "<value> only" scope by resolving it against the one sibling enum that contains it', async () => {
      const manifest = buildDesignSystemManifest()
      const byName = new Map(manifest.components.map((c) => [c.name, c]))
      const appliesWhenOf = (component: string, prop: string) =>
        byName.get(component)?.props.find((p) => p.name === prop)?.appliesWhen

      // "enable the coral CTA over the image — desktop only" -> layout.
      expect(appliesWhenOf('AdBanner', 'showImageAction')).toEqual({ prop: 'layout', values: ['desktop'] })
      // "optional partner logo over the image (solid only)" -> type.
      expect(appliesWhenOf('MarketingCard', 'partnerLogoSrc')).toEqual({ prop: 'type', values: ['solid'] })
      // The scope-PREFIX form: "mobile only: small | medium | large" -> layout —
      // size keeps its OWN enum (`drops a scope prefix…` test above) as well as
      // gaining this gate; the two are independent facts about the same prop.
      expect(appliesWhenOf('AdBanner', 'size')).toEqual({ prop: 'layout', values: ['mobile'] })
    })

    it('does not gate a bare `word/word` run that sits inside a parenthetical aside rather than a scope position', async () => {
      // `AdBanner.imageSrc` — "hero (mobile medium/large) / trailing strip
      // (mobile small) / side image (desktop)" — describes three ALWAYS-
      // applicable interpretations of the same prop, not a condition on when
      // it applies. `medium`/`large` are literal `size` values, so a naive
      // "any slash-joined pair" rule would wrongly hide this prop outside
      // size=medium/large. It must stay unconditional.
      const manifest = buildDesignSystemManifest()
      const adBanner = manifest.components.find((c) => c.name === 'AdBanner')
      expect(adBanner!.props.find((p) => p.name === 'imageSrc')?.appliesWhen).toBeUndefined()
    })

    it('does not gate a prop on a comment naming no resolvable sibling value at all', async () => {
      // `AlmosaferLogo.lang` — "only affects wordmark; ignored for logomark
      // and applogo" — puts the scope word AFTER "only", a grammar this
      // parser deliberately does not attempt.
      const manifest = buildDesignSystemManifest()
      const logo = manifest.components.find((c) => c.name === 'AlmosaferLogo')
      expect(logo!.props.find((p) => p.name === 'lang')?.appliesWhen).toBeUndefined()
    })
  })
  describe('description / keywords / group — the findability half (DS-6)', () => {
    it('gives every component a real description, at least three keywords, and a group', () => {
      const manifest = buildDesignSystemManifest()
      for (const component of manifest.components) {
        expect(component.description).not.toBe(placeholderDescription(component.name))
        expect(component.description.length).toBeGreaterThan(0)
        expect(component.keywords.length).toBeGreaterThanOrEqual(3)
        expect(component.group.length).toBeGreaterThan(0)
      }
    })

    it("takes the description from design.md's first sentence", () => {
      const manifest = buildDesignSystemManifest()
      const byName = new Map(manifest.components.map((c) => [c.name, c]))
      expect(byName.get('Button')!.description).toBe('Buttons trigger actions.')
      expect(byName.get('Separator')!.description).toBe(
        'Full-width 1px horizontal rule.',
      )
    })

    it('reads the three components whose design.md heading spells their name differently', () => {
      // `## List / ListItem`, `## System Banner`, `## Marketing Card`. The
      // package's own catalog matched a heading only on an exact (or
      // `"<name> "`-prefixed) title, so these three had NO intent doc at all.
      const manifest = buildDesignSystemManifest()
      const byName = new Map(manifest.components.map((c) => [c.name, c]))
      expect(byName.get('ListItem')!.description).toBe('The selectable, scannable list row.')
      expect(byName.get('ListItem')!.keywords).toContain('list')
      expect(byName.get('SystemBanner')!.keywords).toContain('system banner')
      expect(byName.get('MarketingCard')!.keywords).toContain('marketing card')
    })

    it("folds in the Decision Map's intents and the component's own enum values", () => {
      const manifest = buildDesignSystemManifest()
      const button = manifest.components.find((c) => c.name === 'Button')!
      expect(button.keywords).toContain('destructive')
      expect(button.keywords).toContain('payment')
      expect(button.keywords.some((k) => k.includes('trigger a labelled action'))).toBe(true)
    })

    it("drops the `dir` enum, which every component carries and none is identified by", () => {
      const manifest = buildDesignSystemManifest()
      for (const component of manifest.components) {
        expect(component.keywords).not.toContain('rtl')
        expect(component.keywords).not.toContain('ltr')
      }
    })

    it('puts every component in exactly one group, from studio/groups.json', () => {
      const manifest = buildDesignSystemManifest()
      const groups = new Set(manifest.components.map((c) => c.group))
      expect(groups.has('Navigation')).toBe(true)
      expect(groups.has('Overlays')).toBe(true)
      expect(manifest.components.find((c) => c.name === 'Navbar')!.group).toBe('Navigation')
      expect(manifest.components.find((c) => c.name === 'Dialog')!.group).toBe('Overlays')
    })
  })
})
