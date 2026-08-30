/**
 * slotCandidates — what a `node`-kind prop's picker can offer, from the three
 * sources that can honestly back an `insert-slot` write.
 *
 * `SlotControl` used to offer exactly one: the project's own components
 * (`GET /admin/api/studio/components`). That is the right list for a generic
 * content slot and the wrong list for an ICON slot, which is most of them —
 * 15 of the ALM design system's documented props are icon-valued, every one
 * declared `icon={<SvgIcon />}`, and not one is satisfied by a component the
 * user happens to have written.
 *
 * ## The three sources, and why each exists
 *
 * 1. **The package's own icon FILES** (`iconCatalog.ts`) — the real icon set.
 *    `@alm-design/design-system` publishes 568 SVGs under `src/icons/`
 *    (`package.json#exports` maps `"./src/icons/*"`), and they are the icons
 *    its screens are actually drawn with: `wifi`, `passport`, `bed`. None is
 *    a React export, so no registry lookup can see them.
 * 2. **`*Icon` React exports in the module registry** — the ten chevrons,
 *    checkmarks and radio glyphs the package's own components draw with.
 *    Every one is ALREADY a registered module (`register.tsx` discovers them
 *    by shape) carrying the `sourceImport` an insert needs, so reading them
 *    back out of the registry means the picker cannot list an icon the canvas
 *    cannot render, and a package that ships a new one appears the moment it
 *    is registered — no second catalogue to keep in sync.
 * 3. **The project's own components** — a genuinely custom icon the user
 *    wrote, or any component for a non-icon slot.
 *
 * Source 1 was the gap the user hit: the picker offered ten arrows for a set
 * containing three hundred glyphs.
 *
 * ## Why a candidate carries a resolved specifier or markup, not a file path
 *
 * The three do not write the same thing. A local component is imported by a
 * path RELATIVE to the call site's file; a package icon component by its BARE
 * specifier (running `relativeImportSpecifier` over
 * `'@alm-design/design-system'` produces a broken relative path); an SVG file
 * is written INLINE and imports nothing at all (`svgToJsxNode.ts` explains
 * why an import would be a guess about the user's bundler). So a candidate
 * carries the finished answer, and every kind reaches the same
 * `commitStudioInsertSlot` call.
 */
import { registry } from '@core/module-engine'
import type { StudioIcon } from '@site/studio/iconCatalog'
import type { LocalComponentSpec } from './componentPropKind'
import { relativeImportSpecifier } from './relativeImportSpecifier'

/** A component fill — written as `<Name />` plus an import. */
export interface ComponentSlotCandidate {
  kind: 'component'
  key: string
  name: string
  /** The exact specifier the insert writes an import for — bare for a package icon, relative for a local component. */
  importSpecifier: string
  source: 'design-system' | 'project'
}

/** An SVG fill — written inline, importing nothing. Covers both the package catalogue and a user upload. */
export interface SvgSlotCandidate {
  kind: 'svg'
  key: string
  name: string
  /** Directory below the package's icon root (`line-icons`), shown as a subtitle. */
  group: string
  /** RAW markup — sanitised by `svgToJsxNode`/the preview, never trusted here. */
  markup: string
  source: 'package-icon'
}

export type SlotCandidate = ComponentSlotCandidate | SvgSlotCandidate

/**
 * A prop whose node value is an ICON rather than arbitrary content. Mirrors
 * `buildDesignSystemManifest.ts`'s `ICON_PROP_NAME_RE` — the manifest records
 * the kind for a documented package component, and this covers the panel's
 * other entry points (a local component's `leadingIcon`, a package whose docs
 * Studio could not classify), so both arrive at the same picker.
 */
const ICON_PROP_NAME_RE = /(^|[a-z])icon([A-Z0-9]|$)/i

export function isIconProp(propName: string): boolean {
  return ICON_PROP_NAME_RE.test(propName)
}

/**
 * Every registered design-system icon module, as picker candidates. Empty
 * when no package is registered (a plain project with no design system).
 */
export function designSystemIconCandidates(): ComponentSlotCandidate[] {
  return registry
    .list()
    .filter((mod) => mod.sourceImport !== undefined && /Icon$/.test(mod.sourceImport.name))
    .map((mod) => ({
      kind: 'component' as const,
      key: `ds:${mod.id}`,
      name: mod.sourceImport!.name,
      importSpecifier: mod.sourceImport!.specifier,
      source: 'design-system' as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The package icon FILES as candidates, in catalogue order (already sorted by group then name server-side). */
export function packageIconCandidates(icons: readonly StudioIcon[]): SvgSlotCandidate[] {
  return icons.map((icon) => ({
    kind: 'svg' as const,
    key: `icon:${icon.id}`,
    name: icon.name,
    group: icon.group,
    markup: icon.markup,
    source: 'package-icon' as const,
  }))
}

/**
 * The project's own components as candidates, with each one's specifier
 * resolved relative to `ownerRelPath` — the file the call site being written
 * into lives in.
 */
export function projectComponentCandidates(
  catalog: readonly LocalComponentSpec[],
  ownerRelPath: string,
): ComponentSlotCandidate[] {
  return catalog.map((spec) => ({
    kind: 'component' as const,
    key: `project:${spec.file}#${spec.exportName}`,
    name: spec.name,
    importSpecifier: relativeImportSpecifier(ownerRelPath, spec.file),
    source: 'project' as const,
  }))
}

/**
 * The candidate list for one prop, in the order the picker shows it.
 *
 * For an icon prop the design system's own icons lead — the FILE catalogue
 * first, because that is the set a designer means by "an icon", then the
 * `*Icon` components — and the project's components follow. Everything else
 * leads with the project's components, with icons still reachable below.
 * Nothing is ever hidden: a custom icon component the user wrote works in an
 * icon slot, and a design-system glyph works in a generic one.
 */
export function slotCandidatesFor(
  propName: string,
  catalog: readonly LocalComponentSpec[],
  ownerRelPath: string,
  icons: readonly StudioIcon[],
): SlotCandidate[] {
  const packageIcons = packageIconCandidates(icons)
  const iconComponents = designSystemIconCandidates()
  const project = projectComponentCandidates(catalog, ownerRelPath)
  return isIconProp(propName)
    ? [...packageIcons, ...iconComponents, ...project]
    : [...project, ...iconComponents, ...packageIcons]
}
