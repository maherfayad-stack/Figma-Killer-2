import type { StyleRule } from '@core/page-tree'
import type {
  FrameworkColorSettings,
  FrameworkPreferencesSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework-schema'
import type { FrameworkColorVariableSets } from './colors'
import {
  formatFrameworkColorThemeCss,
  generateFrameworkColorPlan,
  generateFrameworkColorUtilityClasses,
  generateFrameworkColorVariableSets,
} from './colors'
import type { FrameworkScaleVariable } from './scaleModule'
import {
  generateFrameworkTypographyPlan,
  generateFrameworkTypographyUtilityClasses,
  generateFrameworkTypographyVariables,
} from './typography'
import {
  generateFrameworkSpacingPlan,
  generateFrameworkSpacingUtilityClasses,
  generateFrameworkSpacingVariables,
} from './spacing'
import { resolveFrameworkPreferences } from './preferences'
import { formatCssVariableBlock } from './cssVariables'

export interface FrameworkGenerationSettings {
  colors?: FrameworkColorSettings | null
  typography?: FrameworkTypographySettings | null
  spacing?: FrameworkSpacingSettings | null
  preferences?: FrameworkPreferencesSettings | null
}

/**
 * The two framework CSS outputs the publisher needs, built together: the merged
 * `:root` variable block (+ color theme scopes) and the locked utility classes.
 */
interface FrameworkPlan {
  rootCss: string
  utilityClasses: Record<string, StyleRule>
}

/**
 * Compose the `:root` block from the color variable sets and the scale
 * variables. Shared by `generateFrameworkRootCss` (single output) and
 * `buildFrameworkPlan` (both outputs) so they stay byte-identical.
 */
/**
 * The `html { font-size }` rule that makes a non-default `rootFontSize`
 * preference TRUE.
 *
 * Every generated `rem` is `px / rootFontSize`, which is only correct if the
 * document's root really is that size. Emitting nothing — the old behaviour —
 * silently scaled every generated value by `16 / rootFontSize`; at the previous
 * default of 10 that was a uniform 1.6x inflation of all type and spacing.
 *
 * Nothing is emitted at 16 because 16 needs no rule: it is what an unstyled
 * document already uses, and writing it anyway would override a host page that
 * deliberately set something else.
 */
export function emitRootFontSizeCss(rootFontSize: number): string {
  if (!Number.isFinite(rootFontSize) || rootFontSize <= 0 || rootFontSize === 16) return ''
  return `html {\n  font-size: ${rootFontSize}px;\n}`
}

/**
 * Compose the `:root` block from the color variable sets and the scale
 * variables. Shared by `generateFrameworkRootCss` (single output) and
 * `buildFrameworkPlan` (both outputs) so they stay byte-identical.
 */
function composeFrameworkRootCss(
  colorVariables: FrameworkColorVariableSets,
  scaleVariables: FrameworkScaleVariable[],
  rootFontSize: number,
): string {
  return [
    emitRootFontSizeCss(rootFontSize),
    formatCssVariableBlock(':root', [...colorVariables.light, ...scaleVariables]),
    formatFrameworkColorThemeCss(colorVariables),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function generateFrameworkRootCss(
  settings: FrameworkGenerationSettings | null | undefined,
): string {
  const preferences = resolveFrameworkPreferences(settings?.preferences)
  return composeFrameworkRootCss(
    generateFrameworkColorVariableSets(settings?.colors),
    [
      ...generateFrameworkTypographyVariables(settings?.typography, preferences),
      ...generateFrameworkSpacingVariables(settings?.spacing, preferences),
    ],
    preferences.rootFontSize,
  )
}

export function generateFrameworkUtilityClasses(
  settings: FrameworkGenerationSettings | null | undefined,
): Record<string, StyleRule> {
  return {
    ...generateFrameworkColorUtilityClasses(settings?.colors),
    ...generateFrameworkTypographyUtilityClasses(settings?.typography),
    ...generateFrameworkSpacingUtilityClasses(settings?.spacing),
  }
}

/**
 * Build the framework `:root` CSS and utility classes in one pass.
 *
 * Each family's variable + utility outputs are derived from a single shared,
 * ordered enumeration (`generateFramework*Plan`), so a publish walks each
 * family's tokens/groups once per pass instead of once per output. Equivalent
 * to `{ rootCss: generateFrameworkRootCss(s), utilityClasses: generateFrameworkUtilityClasses(s) }`
 * but without the duplicated traversals.
 */
export function buildFrameworkPlan(
  settings: FrameworkGenerationSettings | null | undefined,
): FrameworkPlan {
  const preferences = resolveFrameworkPreferences(settings?.preferences)
  const colors = generateFrameworkColorPlan(settings?.colors)
  const typography = generateFrameworkTypographyPlan(settings?.typography, preferences)
  const spacing = generateFrameworkSpacingPlan(settings?.spacing, preferences)

  return {
    rootCss: composeFrameworkRootCss(
      colors.variableSets,
      [...typography.variables, ...spacing.variables],
      preferences.rootFontSize,
    ),
    utilityClasses: {
      ...colors.utilityClasses,
      ...typography.utilityClasses,
      ...spacing.utilityClasses,
    },
  }
}
