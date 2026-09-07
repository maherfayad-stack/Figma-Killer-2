/**
 * projectVariables — the catalog behind the inspector's "Apply variable"
 * picker: every CSS custom property the OPEN project actually declares.
 *
 * ## Why the project's own properties, and not just the framework scales
 *
 * `tokenUtils.ts`'s `Token` is a step in one of STUDIO's generated framework
 * scales. That is the right vocabulary for the spacing/typography
 * autocomplete, and the wrong one for "show me my variables": a user who
 * opened a real React repo has `--color-primary`, `--space-4`,
 * `--radius-card` in their own stylesheets, and none of those are framework
 * steps. Offering only the framework scales would answer "what variables do
 * I have" with a list the user did not write.
 *
 * ## Where the bytes come from — an existing channel, not a new one
 *
 * `studioRawCssStores.ts` already holds the two raw CSS strings a Studio
 * load carries: `authoredCss` (the project's own `.css`, concatenated in
 * cascade order) and `vendorCss` (a design system's package stylesheets).
 * Both are already on the client for `ProjectCssInjector`/
 * `AuthoredCssInjector`. This module scans them; no server change, no second
 * wire format, and — importantly — the catalog can never disagree with what
 * the canvas is rendering, because it IS what the canvas is rendering.
 *
 * The framework scales are folded in as a third source by generating their
 * `:root` block with `generateFrameworkRootCss` and scanning it too — the
 * same generator `canvasClassCss.ts` feeds the canvas. That gives framework
 * steps a RESOLVED value (so they get a swatch and a correct kind) through
 * exactly the same code path as everything else, instead of a second,
 * name-based classification that could disagree with the first.
 *
 * ## What is deliberately NOT here
 *
 * A per-variable source FILE. The client receives the project's stylesheets
 * already concatenated (see `studioCss.ts`'s `authoredCssParts.join`), so
 * there is no honest file attribution to show. The picker groups by bundle
 * (Project / Package / Framework) instead of inventing one.
 */
import { useSyncExternalStore } from 'react'
import {
  filterReemittableColorTokens,
  generateFrameworkRootCss,
} from '@core/framework'
import {
  classifyVariableValue,
  type VariableOption,
  type VariableSource,
} from '@ui/components/VariableField'
import { useEditorStore } from '@site/store/store'
import {
  getStudioAuthoredCss,
  getStudioVendorCss,
  subscribeStudioAuthoredCss,
  subscribeStudioVendorCss,
} from '@site/studio/studioRawCssStores'

/**
 * A custom-property declaration anywhere in the sheet — not only in `:root`.
 * A design system routinely declares its dark values under
 * `[data-theme='dark']` and its component tokens on a component class, and
 * all of those are variables the user can legitimately reference. Selector
 * scope is not modelled: the picker's job is "which names exist and roughly
 * what do they hold", and the last declaration wins, matching the cascade
 * for the common case (two `:root` blocks declaring the same name).
 */
const DECLARATION_RE = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)/g

/** Matches a value that is exactly one `var()` reference, for chain resolution. */
const LONE_VAR_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)$/

/**
 * Cap the scan. A minified design-system bundle can carry thousands of
 * declarations, and a picker listing 4,000 rows is not a picker. Far above
 * any hand-authored token set.
 */
const MAX_VARIABLES_PER_SOURCE = 500

/** Bound `var()` → `var()` chains so a cyclic stylesheet cannot hang the panel. */
const MAX_RESOLUTION_DEPTH = 8

/**
 * Every custom property declared in `css`, in declaration order, last
 * declaration winning for a repeated name (the insertion order of the first
 * occurrence is kept — a scale declared small-to-large stays in that order
 * even if a later block overrides one step).
 */
export function scanCssCustomProperties(css: string): Map<string, string> {
  const found = new Map<string, string>()
  if (!css) return found
  DECLARATION_RE.lastIndex = 0
  let match = DECLARATION_RE.exec(css)
  while (match !== null) {
    const value = match[2].trim()
    if (value.length > 0) found.set(match[1], value)
    if (found.size >= MAX_VARIABLES_PER_SOURCE) break
    match = DECLARATION_RE.exec(css)
  }
  return found
}

/**
 * Follows `var(--a)` → `var(--b)` → `4px` to a concrete value, falling back
 * to the chain's own `var(--x, FALLBACK)` argument when a link is missing.
 * Returns the last expression reached when the chain does not terminate in a
 * literal — that value still classifies as `other`, which is honest.
 */
export function resolveVariableValue(
  raw: string,
  declarations: ReadonlyMap<string, string>,
): string {
  let current = raw.trim()
  for (let depth = 0; depth < MAX_RESOLUTION_DEPTH; depth += 1) {
    const lone = LONE_VAR_RE.exec(current)
    if (!lone) return current
    const next = declarations.get(lone[1])
    if (next === undefined) return (lone[2] ?? '').trim() || current
    current = next.trim()
  }
  return current
}

/**
 * Builds the picker catalog from the three CSS bundles. Order matters: later
 * sources do NOT overwrite an earlier source's entry for the same name,
 * because the user's own stylesheet is the one they will recognise, and a
 * package re-declaring `--color-primary` should not relabel it "Package".
 */
export function buildVariableCatalog(sources: {
  projectCss: string
  vendorCss: string
  frameworkCss: string
}): VariableOption[] {
  const entries: Array<{ source: VariableSource; declarations: Map<string, string> }> = [
    { source: 'project', declarations: scanCssCustomProperties(sources.projectCss) },
    { source: 'vendor', declarations: scanCssCustomProperties(sources.vendorCss) },
    { source: 'framework', declarations: scanCssCustomProperties(sources.frameworkCss) },
  ]

  // One merged map for resolution, so a project variable pointing at a
  // package variable (`--btn-bg: var(--color-primary)`) still resolves.
  const all = new Map<string, string>()
  for (const entry of entries) {
    for (const [name, value] of entry.declarations) {
      if (!all.has(name)) all.set(name, value)
    }
  }

  const catalog: VariableOption[] = []
  const claimed = new Set<string>()
  for (const entry of entries) {
    for (const [name, raw] of entry.declarations) {
      if (claimed.has(name)) continue
      claimed.add(name)
      const resolvedValue = resolveVariableValue(raw, all)
      catalog.push({
        name,
        resolvedValue,
        kind: classifyVariableValue(resolvedValue),
        source: entry.source,
      })
    }
  }
  return catalog
}

/**
 * The live catalog for the open project. Re-derived when the load's raw CSS
 * changes (once per project load) or when the framework settings change —
 * both of which are exactly when the set of declared variables can differ.
 */
export function useProjectVariables(): VariableOption[] {
  const projectCss = useSyncExternalStore(subscribeStudioAuthoredCss, getStudioAuthoredCss)
  const vendorCss = useSyncExternalStore(subscribeStudioVendorCss, getStudioVendorCss)
  const framework = useEditorStore((state) => state.site?.settings?.framework)

  const frameworkCss = generateFrameworkRootCss({
    colors: filterReemittableColorTokens(framework?.colors),
    typography: framework?.typography,
    spacing: framework?.spacing,
    preferences: framework?.preferences,
  })

  return buildVariableCatalog({ projectCss, vendorCss, frameworkCss })
}
