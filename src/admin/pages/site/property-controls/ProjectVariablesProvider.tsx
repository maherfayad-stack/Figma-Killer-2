/**
 * ProjectVariablesProvider — publishes the open project's CSS custom
 * properties to every field primitive inside the Properties panel.
 *
 * Split from `projectVariables.ts` for the same reason
 * `TokenCatalogProvider.tsx` is split from `TokenCatalogContext.ts`: React
 * Fast Refresh requires a file to export only components OR only
 * non-components.
 *
 * Mounted once, on the panel's root `<aside>` — the same altitude as
 * `data-field-skin="inspector"`, and for the same reason: the affordance has
 * to reach the ~40 components between the shell and a leaf `Input` without
 * being threaded as a prop through all of them. Computing it once here also
 * means the CSS scan runs once per panel render, not once per field.
 */
import type { ReactNode } from 'react'
import { VariableSourceContext } from '@ui/components/VariableField'
import { useProjectVariables } from './projectVariables'

export function ProjectVariablesProvider({ children }: { children: ReactNode }) {
  const variables = useProjectVariables()
  return (
    <VariableSourceContext.Provider value={variables}>{children}</VariableSourceContext.Provider>
  )
}
