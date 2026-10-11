/**
 * VariableSourceContext - how a `src/ui/` field primitive learns which
 * project variables exist (and can be created) without importing `src/admin`.
 *
 * The catalog is built from the OPEN project's stylesheets by the token
 * catalog route (`property-controls/projectVariables.ts` fetches it);
 * `ScrubInput`, `Input` and friends are portable primitives and must not reach
 * into that. So the admin side provides the catalog - and the one write it
 * can do, creating a variable - through these contexts and the primitives
 * consume them.
 *
 * Outside a provider the catalog is EMPTY and nothing can be created, and an
 * empty catalog renders no "Apply variable" affordance at all. That is the
 * deliberate default: a bare unit test rendering a `ScrubInput` in isolation,
 * or an admin form far away from the site editor, gets exactly the field it
 * asked for and no icon for a variable system it has no access to.
 */
import { createContext, useContext } from 'react'
import { filterVariablesByKind, type VariableKind, type VariableOption } from './variableKind'

const EMPTY_CATALOG: readonly VariableOption[] = []

export const VariableSourceContext = createContext<readonly VariableOption[]>(EMPTY_CATALOG)

/**
 * The write half: declare a new project variable. Provided by the editor; the
 * implementation writes the token to a project stylesheet and resolves to the
 * name it declared. It REJECTS with a readable message when the server refuses
 * (no project stylesheet, name already declared), which the picker shows next
 * to the control - a refusal is never a silent no-op.
 */
export interface VariableActions {
  createVariable(request: { name: string; value: string }): Promise<string>
}

export const VariableActionsContext = createContext<VariableActions | null>(null)

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

/** The whole catalog, unfiltered - for resolving a binding's current value. */
export function useVariableCatalog(): readonly VariableOption[] {
  return useContext(VariableSourceContext)
}

/** The editor's variable writer, or `null` outside the site editor. */
export function useVariableActions(): VariableActions | null {
  return useContext(VariableActionsContext)
}
