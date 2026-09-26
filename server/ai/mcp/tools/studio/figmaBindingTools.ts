/**
 * studio_list_component_bindings — the raw Figma Code Connect binding for a
 * project's design-system component(s), exposed headlessly.
 *
 * `studio_list_components`/`studio_find_component` (`componentCatalogTools.ts`)
 * already surface a per-component `figma` SUMMARY (url, fileKey, nodeId,
 * verifiedNote, example, and the raw prop mapping) so an agent browsing the
 * component catalog sees the binding without a second call. This tool is the
 * deep-dive sibling for when that summary isn't enough: EVERY Figma-value ->
 * code-value pair in a mapping (not just the reduced code-side `PropKind` the
 * catalog tools compute), the full verification/caveat prose, and — the
 * reason this exists as its own tool rather than only a field on the other
 * two — a `fileKeys` rollup so a caller planning a future "pull this
 * component's assets from Figma" step can tell in ONE call whether a
 * project's design system lives in one Figma file or several (measured
 * against the real `@alm-design/design-system` corpus: it is two — a
 * "Styles---Components" file most components map into, and a separate
 * "ALM-2.0--WIP-" file two components — `Checkbox`/`Radio` — map into
 * instead. A caller that assumed one hardcoded file key would silently
 * target the wrong Figma file for those two).
 *
 * Same extraction, same posture as `componentCatalogTools.ts`'s
 * `apiSource: 'code-connect'` entries — see `figmaCodeConnect.ts`'s own
 * header for the full "parse, never execute" contract and the real-corpus
 * shapes this degrades gracefully around (a `REPLACE-ME` placeholder node-id,
 * an all-boolean enum mapping, a literal empty `props: {}`, an inline
 * `(approx)` caveat comment). `execution: 'server'`, no
 * `requiredCapabilities` — a pure read, same posture as
 * `studio_list_components`.
 */
import { join } from 'node:path'
import { StudioListComponentBindingsInputSchema } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { resolveAppRoot } from '../../../../handlers/studio/appRoot'
import { collectFigmaCodeConnectComponents } from '../../../../handlers/studio/figmaCodeConnect'
import type { FigmaCodeConnectComponent } from '../../../../handlers/studio/figmaCodeConnectSchema'
import type { ProbeWarning } from '../../../../handlers/studio/projectProfileSchema'

const DEFAULT_LIMIT = 40

type Binding = FigmaCodeConnectComponent & { pkg: string }

function collectBindings(dir: string): { packages: string[]; bindings: Binding[]; warnings: ProbeWarning[] } {
  const profile = resolveProjectProfile(dir)
  const appRootAbs = resolveAppRoot(dir)
  const warnings: ProbeWarning[] = []
  const bindings: Binding[] = []
  const packagesWithBindings: string[] = []

  for (const pkg of profile.componentPackages) {
    const pkgDir = join(appRootAbs, 'node_modules', ...pkg.split('/'))
    const result = collectFigmaCodeConnectComponents(pkgDir, pkg)
    warnings.push(...result.warnings)
    if (result.components.length > 0) packagesWithBindings.push(pkg)
    for (const component of result.components) bindings.push({ ...component, pkg })
  }
  bindings.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.component.localeCompare(b.component))

  return { packages: packagesWithBindings.sort(), bindings, warnings }
}

const listComponentBindingsTool: AiTool = {
  name: 'studio_list_component_bindings',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'List the project\'s Figma Code Connect bindings (the *.figma.tsx files a design-system package ships) in full: the per-value Figma-to-code mapping, caveats and the exact Figma node. Entry: { pkg, component, file, figmaUrl, figmaFileKey, figmaNodeId, nodeIdPlaceholder, verifiedNote, props[{ name, figmaProperty, kind, mapping?[{ figmaValue, codeValue, note? }], note? }], example }. nodeIdPlaceholder true is an unfilled REPLACE-ME template, not a real node: never fetch it. codeValue may be a string, boolean or number. fileKeys lists every distinct Figma file referenced; a system can span several. filter and package narrow it; capped (default 40, max 200) with truncated and omittedCount. No Code Connect files is an empty list, not an error. The per-component summary is studio_list_components\' figma field.',
  inputSchema: StudioListComponentBindingsInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, filter, package: packageFilter, limit } = input as {
      dir?: string
      filter?: string
      package?: string
      limit?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const { packages, bindings, warnings } = collectBindings(dir)

    const needle = filter?.trim().toLowerCase() ?? ''
    const pkgFilter = packageFilter?.trim()
    const matched = bindings.filter((b) => {
      if (pkgFilter && b.pkg !== pkgFilter) return false
      if (needle.length > 0 && !b.component.toLowerCase().includes(needle)) return false
      return true
    })

    const cap = limit ?? DEFAULT_LIMIT
    const shown = matched.slice(0, cap)
    const omittedCount = matched.length - shown.length
    const fileKeys = [...new Set(matched.map((b) => b.figmaFileKey).filter((k): k is string => Boolean(k)))].sort()

    return {
      ok: true,
      dir,
      packages,
      fileKeys,
      totalBindings: bindings.length,
      matchedBindings: matched.length,
      returnedBindings: shown.length,
      ...(omittedCount > 0
        ? { truncated: true, omittedCount, note: `${omittedCount} more binding(s) matched but were not returned — narrow with filter/package, or raise limit (max 200).` }
        : {}),
      bindings: shown,
      warnings,
    }
  },
}

export const studioFigmaBindingMcpTools: AiTool[] = [listComponentBindingsTool]
