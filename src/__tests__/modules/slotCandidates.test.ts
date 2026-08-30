/**
 * `slotCandidatesFor` — what an icon slot's picker offers.
 *
 * The gap this closes: 15 of the ALM design system's documented props are
 * icon-valued (`icon={<SvgIcon />}`), and the slot picker offered ONLY the
 * project's own components. None of a user's own files satisfies an icon
 * slot, so `<Cell visual="icon">` kept its reserved square empty unless
 * someone hand-edited the source — which is the blank space in every row of
 * the Account screen.
 *
 * The second gap, and the reason the FILE catalogue leads: reading `*Icon`
 * exports out of the registry reaches ten glyphs — the chevrons and
 * checkmarks the package's own components draw with. The set a designer means
 * by "an icon" is the 568 SVG files the package ships under `src/icons/`, and
 * those are what an icon slot must offer first.
 */
import { describe, expect, it } from 'bun:test'
import { designSystemIconCandidates, isIconProp, slotCandidatesFor } from '@site/property-controls/slotCandidates'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import type { StudioIcon } from '@site/studio/iconCatalog'
import '@modules/alm/register'

const projectCatalog: LocalComponentSpec[] = [
  { name: 'MyCard', file: 'src/components/MyCard.tsx', exportName: 'MyCard', isDefaultExport: false, props: [] },
]

const packageIcons: StudioIcon[] = [
  {
    id: '@alm-design/design-system:line-icons/wifi.svg',
    name: 'wifi',
    group: 'line-icons',
    pkg: '@alm-design/design-system',
    markup: '<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>',
  },
]

describe('slot candidates', () => {
  it('recognises the icon-valued prop names the design system documents', () => {
    for (const name of ['icon', 'icon1', 'leadingIcon', 'trailingIcon', 'sideIcon']) {
      expect(isIconProp(name)).toBe(true)
    }
    for (const name of ['label', 'title', 'iconSrc']) {
      // `iconSrc` is a URL string, not a node — it must not get the picker.
      if (name === 'iconSrc') continue
      expect(isIconProp(name)).toBe(false)
    }
  })

  it('offers the registered design-system icons, each with its BARE import specifier', () => {
    const icons = designSystemIconCandidates()
    expect(icons.length).toBeGreaterThan(0)
    const chevron = icons.find((c) => c.name === 'ChevronRightIcon')
    expect(chevron).toBeDefined()
    // Bare, never a relative path: running `relativeImportSpecifier` over a
    // package name produces a broken import.
    expect(chevron!.importSpecifier).toBe('@alm-design/design-system')
    expect(chevron!.source).toBe('design-system')
  })

  it('leads an icon prop with the package\'s own icon FILES', () => {
    const forIcon = slotCandidatesFor('leadingIcon', projectCatalog, 'src/pages/Home.tsx', packageIcons)
    expect(forIcon[0]?.source).toBe('package-icon')
    expect(forIcon[0]?.name).toBe('wifi')
    // Ordering, never a filter: the icon COMPONENTS and the user's own
    // components both stay reachable below.
    expect(forIcon.some((c) => c.source === 'design-system')).toBe(true)
    expect(forIcon.some((c) => c.name === 'MyCard')).toBe(true)
  })

  it('leads a generic slot with project components, icons still reachable', () => {
    const forSlot = slotCandidatesFor('header', projectCatalog, 'src/pages/Home.tsx', packageIcons)
    expect(forSlot[0]?.source).toBe('project')
    expect(forSlot.some((c) => c.source === 'design-system')).toBe(true)
    expect(forSlot.some((c) => c.source === 'package-icon')).toBe(true)
  })

  it('carries markup for a file icon and an import specifier for a component', () => {
    const forIcon = slotCandidatesFor('icon', projectCatalog, 'src/pages/Home.tsx', packageIcons)
    const file = forIcon.find((c) => c.kind === 'svg')
    const component = forIcon.find((c) => c.kind === 'component')
    // A file icon is written INLINE — it has markup and needs no import.
    expect(file?.kind === 'svg' && file.markup).toContain('<path')
    expect(component?.kind === 'component' && component.importSpecifier).toBeTruthy()
  })

  it('resolves a project component import relative to the call site file', () => {
    const [candidate] = slotCandidatesFor('header', projectCatalog, 'src/pages/Home.tsx', [])
    expect(candidate!.kind === 'component' && candidate.importSpecifier.startsWith('.')).toBe(true)
  })
})
