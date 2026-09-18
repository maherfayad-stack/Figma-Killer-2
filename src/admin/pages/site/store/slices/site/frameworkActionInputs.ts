/**
 * The argument shapes of the framework and font token actions on `SiteSlice`.
 *
 * They live here rather than in `types.ts` for the reason `historyTypes.ts`
 * already exists: that file is the slice's public action surface and it passed
 * the 700-line ceiling again when wave 2 landed the two transplant actions.
 * These seven are one responsibility — what a caller hands the Colors,
 * Typography, Spacing and Fonts panels' actions — and none of them describes
 * the store, so they split off without leaving a seam behind.
 *
 * `types.ts` re-exports every one of them, so the slice keeps ONE front door:
 * every consumer already imports from `@site/store/slices/site/types` and none
 * of them has to learn a second path.
 */
import type {
  FrameworkColorUtilityType,
  FrameworkScaleManualSize,
  FrameworkScaleMode,
  FrameworkSpacingGroup,
  FrameworkTypographyGroup,
} from '@core/framework-schema'

export type ColorVariantOptions = { enabled: boolean; count: number }

export interface CreateFrameworkColorTokenInput {
  category?: string
  slug: string
  lightValue: string
  darkValue?: string
  darkModeEnabled?: boolean
  generateUtilities?: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent?: boolean
  generateShades?: Partial<ColorVariantOptions>
  generateTints?: Partial<ColorVariantOptions>
}

export type UpdateFrameworkColorTokenPatch = Partial<{
  category: string
  slug: string
  lightValue: string
  darkValue: string
  darkModeEnabled: boolean
  generateUtilities: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent: boolean
  generateShades: Partial<ColorVariantOptions>
  generateTints: Partial<ColorVariantOptions>
  order: number
}>

export type UpdateFrameworkTypographyGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  /** Patch into the `min` breakpoint config — fields are merged, untouched fields preserved. */
  min: Partial<FrameworkTypographyGroup['min']>
  max: Partial<FrameworkTypographyGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

export type UpdateFrameworkSpacingGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  min: Partial<FrameworkSpacingGroup['min']>
  max: Partial<FrameworkSpacingGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

export interface CreateFontTokenInput {
  name: string
  variable?: string
  familyId?: string | null
  fallback?: string
}

export type UpdateFontTokenPatch = Partial<{
  name: string
  variable: string
  familyId: string | null
  fallback: string
  order: number
}>
