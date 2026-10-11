/**
 * projectVariables - the catalog behind the inspector's "Apply variable"
 * picker: every CSS custom property the OPEN project declares, plus Studio's
 * own Framework scales as a separate, read-only group.
 *
 * ## One catalog, from the server
 *
 * This module used to scan the two concatenated stylesheet strings the canvas
 * carries with its own regex. That could not say which FILE a variable lives
 * in, which declaration is its dark value, or whether a package owns it - and
 * it was a second scanner beside the one the agent writes through. The picker
 * now reads the token catalog (`GET /admin/api/studio/token-catalog`,
 * `server/handlers/studio/tokenCatalog.ts`): the exact stylesheet stack the
 * canvas loads, in cascade order, every declaration gated by the mode it sits
 * under. There is no CSS scan in this file.
 *
 * ## Framework scales are a generator, not the user's tokens (CT-OD-1)
 *
 * `@core/framework` generates `--text-xs...`, colour shades and spacing steps
 * from the Framework panel's settings. Those are not declared in any file of
 * the project, so they are not in the server catalog; their `:root` block is
 * generated here, read with the SAME pure gated scan the server uses, and
 * listed as a read-only "Framework" group that never shadows a project token
 * of the same name.
 *
 * Which value a variable shows: its default (`:root`) declaration, else the
 * declaration that paints, with its value in every other mode on the row's
 * tooltip.
 */
import { useSyncExternalStore } from 'react'
import { filterReemittableColorTokens, generateFrameworkRootCss } from '@core/framework'
import {
  modeOfGate,
  resolveVarValue,
  scanGatedDeclarations,
  type CatalogToken,
  type TokenCatalog,
  type TokenDecl,
} from '@core/studio-tokens'
import { classifyVariableValue, type VariableOption } from '@ui/components/VariableField'
import { useEditorStore } from '@site/store/store'
import { useStudioTokenCatalogSync } from '@site/studio/useStudioTokenCatalogSync'
import { getStudioTokenCatalog, subscribeStudioTokenCatalog } from '@site/studio/studioTokenCatalogStore'

/** The declaration a picker row shows: the default value, else the one that paints, else the first. */
function representativeDecl(token: CatalogToken): TokenDecl | undefined {
  return (
    token.decls.findLast((decl) => decl.gate.kind === 'base' && decl.winning) ??
    token.decls.findLast((decl) => decl.winning) ??
    token.decls[0]
  )
}

function collectionLabels(catalog: TokenCatalog): ReadonlyMap<string, string> {
  return new Map(catalog.collections.map((collection) => [collection.id, collection.label]))
}

/** The picker rows for the project's own tokens. */
export function projectVariableOptions(catalog: TokenCatalog): VariableOption[] {
  const labels = collectionLabels(catalog)
  const options: VariableOption[] = []
  for (const token of catalog.tokens) {
    const shown = representativeDecl(token)
    if (!shown) continue
    const modes = token.decls
      .filter((decl) => decl.winning && decl !== shown)
      .flatMap((decl) => {
        const mode = modeOfGate(decl.gate)
        return mode ? [{ label: mode.modeLabel, value: decl.resolvedValue }] : []
      })
    options.push({
      name: token.name,
      resolvedValue: shown.resolvedValue,
      kind: classifyVariableValue(shown.resolvedValue),
      // A package's tokens are the "Package" group; the project's own, and the
      // output of its Sass/PostCSS/Tailwind build, are the project's.
      source: shown.origin === 'package' || shown.origin === 'studio-design-system' ? 'vendor' : 'project',
      file: shown.file,
      ...(labels.get(token.collection) ? { collection: labels.get(token.collection) } : {}),
      ...(modes.length > 0 ? { modes } : {}),
    })
  }
  return options
}

/** The picker rows for Studio's generated Framework scales: values resolved, no file. */
export function frameworkVariableOptions(frameworkCss: string): VariableOption[] {
  const base = new Map<string, string>()
  const declared = scanGatedDeclarations(frameworkCss).filter((decl) => decl.gate.kind === 'base')
  for (const decl of declared) base.set(decl.name, decl.raw)
  return [...base].map(([name, raw]) => {
    const resolvedValue = resolveVarValue(raw, base)
    return { name, resolvedValue, kind: classifyVariableValue(resolvedValue), source: 'framework' as const }
  })
}

/**
 * Builds the picker catalog. The project's own tokens come first and are never
 * relabelled by a Framework step of the same name: the user's stylesheet is the
 * one they will recognise.
 */
export function buildVariableCatalog(catalog: TokenCatalog | null, frameworkCss: string): VariableOption[] {
  const project = catalog ? projectVariableOptions(catalog) : []
  const claimed = new Set(project.map((option) => option.name))
  return [...project, ...frameworkVariableOptions(frameworkCss).filter((option) => !claimed.has(option.name))]
}

/**
 * The live catalog for the open project. The server catalog is re-read once
 * per load - whenever the load's raw CSS changes, which is exactly when the
 * set of declared variables can differ - and the Framework group is
 * re-derived when the framework settings change.
 */
export function useProjectVariables(): VariableOption[] {
  const catalog = useSyncExternalStore(subscribeStudioTokenCatalog, getStudioTokenCatalog)
  const framework = useEditorStore((state) => state.site?.settings?.framework)
  useStudioTokenCatalogSync()

  const frameworkCss = generateFrameworkRootCss({
    colors: filterReemittableColorTokens(framework?.colors),
    typography: framework?.typography,
    spacing: framework?.spacing,
    preferences: framework?.preferences,
  })

  return buildVariableCatalog(catalog, frameworkCss)
}
