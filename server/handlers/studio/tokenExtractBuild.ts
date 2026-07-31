/**
 * tokenExtractBuild — `ClassifiedTokens -> FrameworkSettings`. Split out of
 * `tokenExtract.ts` purely to stay under the module-size-budget ceiling —
 * this is one coherent, self-contained concern (turning the parser's
 * intermediate shape into the real, schema-validated color tokens and
 * spacing/typography scale groups the Framework panel renders).
 *
 * ## Shape gap: typography is lossy by design
 *
 * `FrameworkTypographyGroup` (`@core/framework-schema`) represents ONE fluid
 * *size* ladder — `namingConvention` + `steps` + per-step `manualSizes`. It
 * has no field for a per-step font-family/weight/line-height/letter-spacing,
 * which a real design system (see the eSIM corpus's `--type-{scale}-family`/
 * `-weight`/`-lh`/`-ls`) very much has. `buildTypographyGroups` maps only the
 * discovered SIZE steps into a group (one group per distinct naming prefix);
 * every other typography-shaped declaration was already counted by
 * `tokenExtractCssScan.ts`'s classifier and is surfaced by `tokenExtract.ts`
 * as a `typography-detail-not-mapped` warning — honest about the gap rather
 * than inventing schema fields nothing else reads.
 *
 * Each extracted scale step gets `min === max` (no responsive information
 * exists in a static CSS custom property), and groups use `mode:
 * 'fluid_manual'` accordingly — the fluid `min`/`max` breakpoint fields are
 * still populated (structurally required by the schema) but are not
 * consulted in manual mode.
 */
import { createHash } from 'node:crypto'
import { normalizeFrameworkColorSlug } from '@core/framework'
import type {
  FrameworkColorToken,
  FrameworkScaleManualSize,
  FrameworkSettings,
  FrameworkSpacingGroup,
  FrameworkTypographyGroup,
} from '@core/framework-schema'
import type { ClassifiedColor, ClassifiedLength, ClassifiedTokens } from './tokenExtractCssScan'

// ---------------------------------------------------------------------------
// Deterministic ids — same input, same id, forever (matches `studioCss.ts`'s
// `styleRuleId` philosophy: these are machine-derived, not user-created, so a
// stable id keyed off identity beats a random one that churns every re-run).
// ---------------------------------------------------------------------------

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${createHash('sha1').update(seed).digest('hex').slice(0, 10)}`
}

/** Machine-derived entries never carry a real edit timestamp — fixed at 0, the same sentinel `studioCss.ts`'s `IMPORTED_RULE_TIMESTAMP` uses for the same reason. */
const EXTRACTED_TIMESTAMP = 0

/** `--type-display-size` -> `display`; `--font-size-md` -> `md`; `--text-lg` -> `lg`. Falls back to `'base'` when stripping leaves nothing. */
function typographyStepName(rawName: string): string {
  let s = rawName.replace(/^--/, '').replace(/^(font|text|type)-/i, '')
  s = s.replace(/^size-/i, '').replace(/-size$/i, '')
  return s || 'base'
}

/** `--space-lg` -> `lg`; `--radius-sm` -> `sm`. */
function spacingStepName(rawName: string): string {
  const s = rawName.replace(/^--/, '').replace(/^(space|gap|size|radius)-?/i, '')
  return s || 'base'
}

/** The first dash-delimited segment after `--` — `--background-primary-default` -> `background`, `--color-aqua-100` -> `color`. Used both to group color tokens (`FrameworkColorToken.category`) and to split spacing/typography tokens into one group per distinct naming convention. */
function namePrefix(rawName: string): string {
  const stripped = rawName.replace(/^--/, '')
  return stripped.split('-')[0] || stripped
}

function buildColorTokens(colors: readonly ClassifiedColor[]): FrameworkColorToken[] {
  return colors.map((c, order) => {
    const slug = normalizeFrameworkColorSlug(c.name)
    return {
      id: stableId('tok-color', c.name),
      category: namePrefix(c.name),
      slug,
      lightValue: c.light,
      darkValue: c.dark ?? '',
      darkModeEnabled: c.dark !== undefined && c.dark !== c.light,
      generateUtilities: { text: true, background: true, border: true, fill: false },
      generateTransparent: true,
      generateShades: { enabled: true, count: 4 },
      generateTints: { enabled: true, count: 4 },
      order,
      createdAt: EXTRACTED_TIMESTAMP,
      updatedAt: EXTRACTED_TIMESTAMP,
    }
  })
}

/** Groups `entries` by naming-convention prefix (see `namePrefix`) and builds one manual-mode scale group per prefix with at least one entry. `stepName`/`makeGroup` let the same builder serve both spacing and typography. */
function buildScaleGroups<TGroup>(
  entries: readonly ClassifiedLength[],
  stepName: (name: string) => string,
  makeGroup: (prefix: string, sizes: FrameworkScaleManualSize[], minPx: number, maxPx: number) => TGroup,
): TGroup[] {
  const byPrefix = new Map<string, ClassifiedLength[]>()
  for (const entry of entries) {
    const prefix = namePrefix(entry.name)
    const list = byPrefix.get(prefix) ?? []
    list.push(entry)
    byPrefix.set(prefix, list)
  }

  const groups: TGroup[] = []
  for (const [prefix, list] of [...byPrefix].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...list].sort((a, b) => a.px - b.px)
    const sizes: FrameworkScaleManualSize[] = sorted.map((e) => ({
      id: stableId('tok-step', e.name),
      name: stepName(e.name),
      min: e.px,
      max: e.px,
    }))
    const minPx = sorted[0]!.px
    const maxPx = sorted[sorted.length - 1]!.px
    groups.push(makeGroup(prefix, sizes, minPx, maxPx))
  }
  return groups
}

function buildSpacingGroups(entries: readonly ClassifiedLength[]): FrameworkSpacingGroup[] {
  return buildScaleGroups(entries, spacingStepName, (prefix, manualSizes, minPx, maxPx) => ({
    id: stableId('tok-spacing', prefix),
    name: prefix.charAt(0).toUpperCase() + prefix.slice(1),
    namingConvention: prefix,
    min: { size: minPx, scaleRatio: 1.25 },
    max: { size: maxPx, scaleRatio: 1.414 },
    steps: manualSizes.map((s) => s.name).join(','),
    baseScaleIndex: Math.floor((manualSizes.length - 1) / 2),
    mode: 'fluid_manual',
    manualSizes,
    order: 0,
    createdAt: EXTRACTED_TIMESTAMP,
    updatedAt: EXTRACTED_TIMESTAMP,
  }))
}

function buildTypographyGroups(entries: readonly ClassifiedLength[]): FrameworkTypographyGroup[] {
  return buildScaleGroups(entries, typographyStepName, (prefix, manualSizes, minPx, maxPx) => {
    // The step whose size is closest to a 16px base font — the universal
    // typographic anchor, unlike spacing which has no such convention.
    let baseScaleIndex = 0
    let bestDelta = Infinity
    manualSizes.forEach((s, i) => {
      const delta = Math.abs(s.min - 16)
      if (delta < bestDelta) {
        bestDelta = delta
        baseScaleIndex = i
      }
    })
    return {
      id: stableId('tok-typography', prefix),
      name: prefix.charAt(0).toUpperCase() + prefix.slice(1),
      namingConvention: prefix,
      min: { fontSize: minPx, scaleRatio: 1.125 },
      max: { fontSize: maxPx, scaleRatio: 1.333 },
      steps: manualSizes.map((s) => s.name).join(','),
      baseScaleIndex,
      mode: 'fluid_manual',
      manualSizes,
      order: 0,
      createdAt: EXTRACTED_TIMESTAMP,
      updatedAt: EXTRACTED_TIMESTAMP,
    }
  })
}

export function buildFrameworkSettings(tokens: ClassifiedTokens): FrameworkSettings {
  const colorTokens = buildColorTokens(tokens.colors)
  const spacingGroups = buildSpacingGroups(tokens.spacing)
  const typographyGroups = buildTypographyGroups(tokens.typographySizes)
  return {
    colors: { tokens: colorTokens },
    ...(typographyGroups.length > 0 ? { typography: { groups: typographyGroups } } : {}),
    ...(spacingGroups.length > 0 ? { spacing: { groups: spacingGroups } } : {}),
  }
}
