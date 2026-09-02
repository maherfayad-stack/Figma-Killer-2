/**
 * designVariableIndex — turns a set of applicable `DesignVariableSet`s
 * (`resolveApplicableDesignVariableSets`) into a flat, searchable index, and
 * answers "which declared variable is this measured value closest to".
 *
 * This is the middle hop of the three-way mapping `referenceMeasure.ts`
 * wires up: measured pixel value -> design variable name (this module) ->
 * project token (`projectTokenIndex.nearestColorToken`/`nearestSizeToken`,
 * applied to the VARIABLE's own normalised value, not the noisy pixel).
 *
 * Mirrors `projectTokenIndex.ts`'s nearest-match shape and thresholds
 * deliberately — a colour match here and a colour match against a project
 * token should mean the same thing at the same confidence, or an agent
 * reading both fields would have to learn two different scales for "close
 * enough".
 */
import { colorDifference, parseHexColor, type Rgb } from '@core/design-tokens'
import type { DesignVariableSet } from './designVariableSchema'

/** Shared with `referenceMeasure.ts`'s own project-token matching — see that module's `COLOR_MATCH_MAX_DELTA_E`. Kept as an independent constant (not imported) because the two thresholds are allowed to diverge in the future for a reason specific to one comparison; today they intentionally agree. */
export const DESIGN_VARIABLE_COLOR_MATCH_MAX_DELTA_E = 5

export interface DesignVariableProvenance {
  readonly name: string
  readonly raw: string
  readonly setId: string
  readonly source: string
  readonly label?: string
}

export interface DesignVariableColorEntry extends DesignVariableProvenance {
  readonly hex: string
  readonly rgb: Rgb
}

export interface DesignVariableSizeEntry extends DesignVariableProvenance {
  readonly px: number
  readonly unitAssumed: boolean
}

export interface DesignVariableIndex {
  readonly colors: readonly DesignVariableColorEntry[]
  readonly sizes: readonly DesignVariableSizeEntry[]
}

/** Bound so a pathological accumulation of sets cannot dominate a single measurement call — far above any real design's variable count. */
const MAX_INDEXED_PER_KIND = 4000

export function buildDesignVariableIndex(sets: readonly DesignVariableSet[]): DesignVariableIndex {
  const colors: DesignVariableColorEntry[] = []
  const sizes: DesignVariableSizeEntry[] = []

  for (const set of sets) {
    for (const variable of set.variables) {
      const provenance: DesignVariableProvenance = {
        name: variable.name,
        raw: variable.raw,
        setId: set.id,
        source: set.source,
        ...(set.label ? { label: set.label } : {}),
      }
      if (variable.kind === 'color' && variable.hex) {
        const rgb = parseHexColor(variable.hex)
        if (rgb && colors.length < MAX_INDEXED_PER_KIND) colors.push({ ...provenance, hex: variable.hex, rgb })
      } else if (variable.kind === 'size' && variable.px !== undefined) {
        if (sizes.length < MAX_INDEXED_PER_KIND) {
          sizes.push({ ...provenance, px: variable.px, unitAssumed: variable.unitAssumed === true })
        }
      }
    }
  }

  return { colors, sizes }
}

export interface NearestDesignVariableColor {
  readonly variable: DesignVariableColorEntry
  readonly deltaE: number
}

/**
 * The closest indexed variable colour to `rgb`, when within
 * `DESIGN_VARIABLE_COLOR_MATCH_MAX_DELTA_E` — `undefined` otherwise, same
 * "report nothing rather than a wrong name" stance as
 * `projectTokenIndex.nearestColorToken`. On an exact tie the LATER entry in
 * `colors` wins (see `resolveApplicableDesignVariableSets`'s ordering doc).
 */
export function nearestDesignVariableColor(
  colors: readonly DesignVariableColorEntry[],
  rgb: Rgb,
): NearestDesignVariableColor | undefined {
  let best: NearestDesignVariableColor | undefined
  for (const variable of colors) {
    const deltaE = colorDifference(rgb, variable.rgb)
    if (best === undefined || deltaE <= best.deltaE) best = { variable, deltaE }
  }
  if (best === undefined || best.deltaE > DESIGN_VARIABLE_COLOR_MATCH_MAX_DELTA_E) return undefined
  return { variable: best.variable, deltaE: Math.round(best.deltaE * 100) / 100 }
}

export interface NearestDesignVariableSize {
  readonly variable: DesignVariableSizeEntry
  readonly deltaPx: number
}

/**
 * The closest indexed variable size to `px` — always returned when any size
 * variable exists, even a poor match, mirroring
 * `projectTokenIndex.nearestSizeToken`: the CALLER (a font-size range, here)
 * decides what counts as close enough. On an exact tie the LATER entry
 * wins.
 */
export function nearestDesignVariableSize(
  sizes: readonly DesignVariableSizeEntry[],
  px: number,
): NearestDesignVariableSize | undefined {
  let best: NearestDesignVariableSize | undefined
  for (const variable of sizes) {
    const deltaPx = Math.round((variable.px - px) * 100) / 100
    if (best === undefined || Math.abs(deltaPx) <= Math.abs(best.deltaPx)) best = { variable, deltaPx }
  }
  return best
}
