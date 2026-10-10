/**
 * projectComponents — which of the project's declared components the Assets
 * panel offers as parts, and how search narrows them. Pure; the section that
 * renders them is `ProjectComponentsSection.tsx`.
 */
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'

/** Route and framework entry files declare components too, but they are pages, not parts. */
const ROUTE_FILE_RE = /(^|\/)(page|layout|loading|error|not-found|template|route|_app|_document)\.[jt]sx?$/

/** Studio's built-in design system is offered under "Design system", not here. */
const DESIGN_SYSTEM_PREFIX = 'design-system/'

/** The catalog entries worth offering as parts: not a route file, not the built-in design system. */
export function insertableProjectComponents(catalog: readonly LocalComponentSpec[]): LocalComponentSpec[] {
  return catalog.filter(
    (component) => !component.file.startsWith(DESIGN_SYSTEM_PREFIX) && !ROUTE_FILE_RE.test(component.file),
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
