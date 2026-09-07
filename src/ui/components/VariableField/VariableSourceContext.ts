/**
 * VariableSourceContext — how a `src/ui/` field primitive learns which
 * project variables exist without importing `src/admin`.
 *
 * The catalog is built from the OPEN project's stylesheets, which is
 * site-editor state (`src/admin/pages/site/property-controls/
 * projectVariables.ts`). `ScrubInput`, `Input` and friends are portable
 * primitives and must not reach into that; so the admin side provides the
 * catalog through this context and the primitives consume it.
 *
 * Outside a provider the catalog is EMPTY, and an empty catalog renders no
 * "Apply variable" affordance at all. That is the deliberate default: a bare
 * unit test rendering a `ScrubInput` in isolation, or an admin form far away
 * from the site editor, gets exactly the field it asked for and no icon for
 * a variable system it has no access to.
 */
import { createContext, useContext } from 'react'
import { filterVariablesByKind, type VariableKind, type VariableOption } from './variableKind'

const EMPTY_CATALOG: readonly VariableOption[] = []

export const VariableSourceContext = createContext<readonly VariableOption[]>(EMPTY_CATALOG)

/**
 * The variables a field accepting `accept` may offer. Returns a stable empty
 * array when nothing matches, so callers can branch on `.length === 0` to
 * decide whether to render the affordance at all.
 */
export function useVariableOptions(accept: readonly VariableKind[]): readonly VariableOption[] {
  const catalog = useContext(VariableSourceContext)
  if (catalog.length === 0) return EMPTY_CATALOG
  const filtered = filterVariablesByKind(catalog, accept)
  return filtered.length === 0 ? EMPTY_CATALOG : filtered
}

/** The whole catalog, unfiltered — for resolving a binding's current value. */
export function useVariableCatalog(): readonly VariableOption[] {
  return useContext(VariableSourceContext)
}
