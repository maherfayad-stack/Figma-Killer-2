/**
 * projectComponents — which of the project's declared components the Assets
 * panel offers as parts, and how search narrows them. Pure; the section that
 * renders them is `ProjectComponentsSection.tsx`.
 */
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'

/** Studio's built-in design system is offered under "Design system", not here. */
const DESIGN_SYSTEM_PREFIX = 'design-system/'

/** The catalog entries worth offering as parts: a reusable component (the server marks pages, by the
 * project's detected pages directory, and context providers apart), not the built-in design system. */
export function insertableProjectComponents(catalog: readonly LocalComponentSpec[]): LocalComponentSpec[] {
  return catalog.filter(
    (component) => !component.file.startsWith(DESIGN_SYSTEM_PREFIX) && component.role === 'component',
  )
}

/** Case-insensitive match on the component's name or its file path. */
export function matchProjectComponents(
  components: readonly LocalComponentSpec[],
  query: string,
): LocalComponentSpec[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...components]
  return components.filter(
    (component) => component.name.toLowerCase().includes(needle) || component.file.toLowerCase().includes(needle),
  )
}
