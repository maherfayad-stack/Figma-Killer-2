/**
 * variantSeeds — the CREATIVE half of W9-3 (`STUDIO-WAVE7-PLAN.md`): turn one
 * brief into N genuinely different screens instead of one screen with a
 * different accent colour.
 *
 * ## Why a seed, and not "make three versions"
 *
 * The creative fidelity block (`systemPrompt.ts`'s `MODE_BLOCK.creative`)
 * already asks for more than one idea. Asking is not enough, and it is not
 * enough for a measurable reason: a model given one brief three times returns
 * the same composition three times, because nothing in the second prompt
 * differs from the first. The variance has to come from OUTSIDE the model.
 *
 * So each variant gets a **style seed** — a small, explicit set of decisions
 * made before any authoring starts: how much type contrast, how much air,
 * how round, which accent. Three seeds that differ on those axes produce
 * three screens that differ structurally, from one brief, with no "be more
 * creative" instruction anywhere.
 *
 * ## Constrained randomisation over the PROJECT's own token space
 *
 * The randomisation is constrained in two directions, and both matter:
 *
 *   1. **Every value is one the project already declares.** The heading size
 *      is a real `--type-*` token, the radius is a real radius token, the
 *      accent is a real colour token, the spacing step is a multiple of the
 *      project's own base. A seed that invented `1.618` and `#7B61FF` would
 *      produce three screens that all fail `studio_quality_check`'s
 *      `raw-hex-color`/`off-scale-*` rules — variety bought by breaking the
 *      design system is not variety, it is three defects.
 *   2. **The axes are picked WITHOUT replacement.** Variant B does not get to
 *      re-roll variant A's density. Distinctness is structural, not a hope.
 *
 * The type-contrast pool is bounded below by `MIN_TYPE_HIERARCHY_RATIO` —
 * imported from `compositionAudit.ts`, not restated — so a seed can never propose
 * a screen that this project's own `flat-type-hierarchy` check would then
 * fail. The generator and the grader agree by construction.
 *
 * ## Why the seed is recorded (`.studio/variants.json`, `variantStore.ts`)
 *
 * So that "make B but tighter" is an EDIT and not a re-roll. Without a
 * recorded seed the only way back to variant B's decisions is to regenerate
 * and hope; with one, B's density moves from `airy` to `compact` and
 * everything else stays exactly where the user liked it. `rngSeed` is
 * recorded for the same reason one level up: the whole set is reproducible.
 *
 * Pure — no I/O, no randomness beyond the caller-supplied numeric seed.
 * `variantStore.ts` owns the disk half.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { MIN_TYPE_HIERARCHY_RATIO } from './compositionAudit'
import type { ProjectTokenIndex, SizeTokenEntry } from './projectTokenIndex'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** How much air the screen gives its content — the multiplier applied to the project's OWN spacing step, never a replacement for it. */
export const VARIANT_DENSITIES = ['compact', 'regular', 'airy'] as const
export type VariantDensity = (typeof VARIANT_DENSITIES)[number]

/** The multiplier each density applies to the project's spacing base. WHOLE multiples only: `off-scale-spacing` grades every padding/margin/gap against the project's base, so a 1.5x step would hand every variant a rhythm its own quality check then flags. */
const DENSITY_MULTIPLIER: Readonly<Record<VariantDensity, number>> = { compact: 1, regular: 2, airy: 3 }

/** Corner language, bucketed by px so it can be matched against whatever radius tokens the project actually declares. */
export const VARIANT_RADIUS_FAMILIES = ['sharp', 'soft', 'round', 'pill'] as const
export type VariantRadiusFamily = (typeof VARIANT_RADIUS_FAMILIES)[number]

/**
 * Type contrast, as a target heading÷body ratio.
 *
 * The floor is `MIN_TYPE_HIERARCHY_RATIO` — the same number
 * `auditCompositionQuality`'s `flat-type-hierarchy` rule grades against — so
 * the least-contrasty seed this generator can produce is exactly the flattest
 * screen the quality check will still accept. Above it, two clearly separated
 * steps rather than a continuum: a 1.62 and a 1.68 are the same screen.
 */
const TYPE_CONTRAST_POOL: readonly number[] = [MIN_TYPE_HIERARCHY_RATIO, 2, 2.6]

/** How each contrast level reads, for the directive text. Keyed by index into `TYPE_CONTRAST_POOL`. */
const TYPE_CONTRAST_LABEL: readonly string[] = ['restrained', 'confident', 'editorial']

/** Names that read as a corner radius rather than a spacing or a font size. */
const RADIUS_TOKEN_NAME_RE = /(radius|rounded|corner)/i
/** Names that read as an accent/brand colour rather than a neutral surface, a text colour or a state colour. */
const ACCENT_TOKEN_NAME_RE = /(accent|brand|primary|highlight)/i
/** Names that are explicitly NOT an accent — a neutral, a surface, or a semantic state. Excluded even when they match the accent pattern (`--primary-text` is text, not an accent). */
const NON_ACCENT_TOKEN_NAME_RE = /(text|fg|foreground|bg|background|surface|border|shadow|overlay|scrim|neutral|grey|gray|white|black|danger|error|warning|success|info|disabled|muted)/i
/** Names that read as spacing rhythm — the same vocabulary `compositionAudit.ts` uses to derive a spacing base. */
const SPACING_TOKEN_NAME_RE = /(space|spacing|gap)/i

/** The conventional step used when the project declares no spacing tokens of its own. Named here rather than hidden in a `??` so the directive can SAY that it is a fallback. */
const FALLBACK_SPACING_BASE_PX = 4
/** A body size to anchor the type scale against when nothing in the project's own type tokens is near it. */
const FALLBACK_BODY_SIZE_PX = 16
/** How many variants a single set may hold. Three is the plan's N; the cap exists so a caller cannot ask for twenty screens that no agent will finish. */
export const MAX_VARIANTS_PER_SET = 4
/** Variant letters, in order. `MAX_VARIANTS_PER_SET` entries. */
const VARIANT_LETTERS = ['A', 'B', 'C', 'D'] as const

// ---------------------------------------------------------------------------
// Persisted shape — schemas are the source of truth (CLAUDE.md §Validation)
// ---------------------------------------------------------------------------

export const VariantStyleSeedSchema = Type.Object({
  /** Achieved heading÷body ratio — what the chosen tokens actually produce, never the target that was aimed at. */
  typeScaleRatio: Type.Number(),
  /** How that ratio reads in words, for the directive. */
  typeContrast: Type.String(),
  bodySizePx: Type.Number(),
  bodySizeToken: Type.Optional(Type.String()),
  headingSizePx: Type.Number(),
  headingSizeToken: Type.Optional(Type.String()),
  /** The project's OWN spacing step. Not varied per variant — varying it would leave the project's token space. */
  spacingBasePx: Type.Number(),
  /** True when `spacingBasePx` is the conventional fallback rather than something the project declares. */
  spacingBaseIsFallback: Type.Boolean(),
  density: Type.Union(VARIANT_DENSITIES.map((d) => Type.Literal(d))),
  /** `spacingBasePx x DENSITY_MULTIPLIER[density]` — this variant's SMALLEST gap, and the unit every larger gap is a whole multiple of. Always a whole multiple of `spacingBasePx`, so every value it generates stays on the project's own rhythm. */
  spacingStepPx: Type.Number(),
  radiusFamily: Type.Union(VARIANT_RADIUS_FAMILIES.map((r) => Type.Literal(r))),
  radiusPx: Type.Optional(Type.Number()),
  radiusToken: Type.Optional(Type.String()),
  accentToken: Type.Optional(Type.String()),
  accentHex: Type.Optional(Type.String()),
})
export type VariantStyleSeed = Static<typeof VariantStyleSeedSchema>

export const VariantSeedSchema = Type.Object({
  /** `A`, `B`, `C` — the letter, which is also the page-name suffix. */
  letter: Type.String(),
  /** The page this variant is authored as, e.g. `HomeB`. */
  pageName: Type.String(),
  style: VariantStyleSeedSchema,
  /** The self-contained style paragraph to send to this variant's subagent, verbatim. */
  directive: Type.String(),
})
export type VariantSeed = Static<typeof VariantSeedSchema>

export const VariantSetSchema = Type.Object({
  id: Type.String(),
  createdAt: Type.String(),
  /** The page name the variants are suffixed off, e.g. `Home` -> `HomeA`/`HomeB`/`HomeC`. */
  baseName: Type.String(),
  /** The one brief every variant shares, verbatim as the caller gave it. */
  brief: Type.String(),
  /** Reproduces this exact set. Recorded so a re-roll is a decision, not an accident. */
  rngSeed: Type.Number(),
  variants: Type.Array(VariantSeedSchema),
})
export type VariantSet = Static<typeof VariantSetSchema>

export const VariantManifestSchema = Type.Object({
  version: Type.Literal(1),
  sets: Type.Array(VariantSetSchema),
})
export type VariantManifest = Static<typeof VariantManifestSchema>

export const EMPTY_VARIANT_MANIFEST: VariantManifest = { version: 1, sets: [] }

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** mulberry32 — a small, deterministic PRNG. Deterministic is the requirement: the same `rngSeed` must reproduce the same set, or "recorded seed" means nothing. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates over a copy, driven by `rng` — so an axis is consumed WITHOUT replacement (variant B cannot re-roll variant A's density). */
function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Take `count` items from `pool`, cycling when the pool is smaller — a project with only two radius families still gets three variants, two of which share one. Honest degradation rather than an invented third family. */
function takeCycling<T>(pool: readonly T[], count: number): T[] {
  if (pool.length === 0) return []
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]!)
}

function radiusFamilyOf(px: number): VariantRadiusFamily {
  if (px <= 2) return 'sharp'
  if (px <= 8) return 'soft'
  if (px <= 24) return 'round'
  return 'pill'
}

/** The project's own spacing step: the GCD of its integer spacing-token values. Mirrors `compositionAudit.ts`'s `detectSpacingBasePx` — same question, and a different answer here would mean a seed proposing spacing its own audit flags. */
function detectSpacingBase(tokens: ProjectTokenIndex): { px: number; fallback: boolean } {
  const values = tokens.lengths
    .filter((t) => SPACING_TOKEN_NAME_RE.test(t.name) && t.px >= 2 && Number.isInteger(t.px))
    .map((t) => t.px)
  if (values.length < 2) return { px: FALLBACK_SPACING_BASE_PX, fallback: true }
  let base = values[0]!
  for (const px of values) {
    let x = base
    let y = px
    while (y > 0) {
      const t = x % y
      x = y
      y = t
    }
    base = x
  }
  return base >= 2 ? { px: base, fallback: false } : { px: FALLBACK_SPACING_BASE_PX, fallback: true }
}

/** The project's body type token: the declared font size nearest 16px. `undefined` when the project declares no type tokens at all. */
function detectBodyToken(tokens: ProjectTokenIndex): SizeTokenEntry | undefined {
  let best: SizeTokenEntry | undefined
  for (const token of tokens.fontSizes) {
    if (best === undefined || Math.abs(token.px - FALLBACK_BODY_SIZE_PX) < Math.abs(best.px - FALLBACK_BODY_SIZE_PX)) best = token
  }
  return best
}

export interface GenerateVariantSeedsOptions {
  readonly tokens: ProjectTokenIndex
  /** The one brief every variant shares. Echoed into each directive so a subagent prompt is self-contained. */
  readonly brief: string
  /** The page name to suffix, e.g. `Home`. */
  readonly baseName: string
  readonly count: number
  readonly rngSeed: number
}

/**
 * N style seeds for one brief, each a set of decisions made from the
 * project's OWN tokens, differing structurally from every other.
 *
 * See the module doc for why the randomisation is constrained in both
 * directions. Never throws and never returns fewer than `count` seeds: a
 * project with no tokens at all still gets three seeds, they just carry
 * fewer token names and say so in the directive.
 */
export function generateVariantSeeds(options: GenerateVariantSeedsOptions): VariantSeed[] {
  const { tokens, brief, baseName, rngSeed } = options
  const count = Math.max(1, Math.min(options.count, MAX_VARIANTS_PER_SET))
  const rng = makeRng(rngSeed)

  const spacingBase = detectSpacingBase(tokens)
  const bodyToken = detectBodyToken(tokens)
  const bodySizePx = bodyToken?.px ?? FALLBACK_BODY_SIZE_PX

  // Axis 1 — type contrast, without replacement.
  const contrastOrder = shuffled(TYPE_CONTRAST_POOL.map((ratio, i) => ({ ratio, label: TYPE_CONTRAST_LABEL[i]! })), rng)
  const contrasts = takeCycling(contrastOrder, count)

  // Axis 2 — density, without replacement.
  const densities = takeCycling(shuffled(VARIANT_DENSITIES, rng), count)

  // Axis 3 — radius family, restricted to families the project actually has
  // tokens for. A project whose only radius token is 4px gets `soft` for
  // every variant rather than an invented `pill` no token expresses.
  const radiusTokens = tokens.lengths.filter((t) => RADIUS_TOKEN_NAME_RE.test(t.name))
  const familyToToken = new Map<VariantRadiusFamily, SizeTokenEntry>()
  for (const token of radiusTokens) {
    const family = radiusFamilyOf(token.px)
    if (!familyToToken.has(family)) familyToToken.set(family, token)
  }
  const radiusChoices = takeCycling(shuffled([...familyToToken.keys()], rng), count)

  // Axis 4 — accent colour, without replacement, from the project's palette.
  const accentPool = tokens.colors.filter((c) => ACCENT_TOKEN_NAME_RE.test(c.name) && !NON_ACCENT_TOKEN_NAME_RE.test(c.name))
  const fallbackPool = accentPool.length > 0 ? accentPool : tokens.colors.filter((c) => !NON_ACCENT_TOKEN_NAME_RE.test(c.name))
  const accents = takeCycling(shuffled(fallbackPool, rng), count)

  const seeds: VariantSeed[] = []
  for (let i = 0; i < count; i += 1) {
    const letter = VARIANT_LETTERS[i]!
    const target = contrasts[i] ?? { ratio: MIN_TYPE_HIERARCHY_RATIO, label: 'restrained' }

    // The heading is a REAL project token — the one whose ratio to body lands
    // nearest the target — never `bodySizePx * ratio`, which would be an
    // off-scale size this project's own audit flags.
    let headingToken: SizeTokenEntry | undefined
    for (const token of tokens.fontSizes) {
      if (token.px <= bodySizePx) continue
      const current = Math.abs(token.px / bodySizePx - target.ratio)
      const bestSoFar = headingToken ? Math.abs(headingToken.px / bodySizePx - target.ratio) : Infinity
      if (current < bestSoFar) headingToken = token
    }
    const headingSizePx = headingToken?.px ?? Math.round(bodySizePx * target.ratio)
    const achievedRatio = Math.round((headingSizePx / bodySizePx) * 100) / 100

    const density = densities[i] ?? 'regular'
    const spacingStepPx = spacingBase.px * DENSITY_MULTIPLIER[density]
    const radiusFamily = radiusChoices[i] ?? 'soft'
    const radiusToken = familyToToken.get(radiusFamily)
    const accent = accents[i]

    const style: VariantStyleSeed = {
      typeScaleRatio: achievedRatio,
      typeContrast: target.label,
      bodySizePx,
      ...(bodyToken ? { bodySizeToken: bodyToken.name } : {}),
      headingSizePx,
      ...(headingToken ? { headingSizeToken: headingToken.name } : {}),
      spacingBasePx: spacingBase.px,
      spacingBaseIsFallback: spacingBase.fallback,
      density,
      spacingStepPx,
      radiusFamily,
      ...(radiusToken ? { radiusPx: radiusToken.px, radiusToken: radiusToken.name } : {}),
      ...(accent ? { accentToken: accent.name, accentHex: accent.hex } : {}),
    }

    seeds.push({
      letter,
      pageName: `${baseName}${letter}`,
      style,
      directive: renderVariantDirective(letter, `${baseName}${letter}`, brief, style),
    })
  }
  return seeds
}

/**
 * The paragraph a variant's subagent is sent, VERBATIM.
 *
 * Self-contained on purpose — `docs/features/agent.md`'s subagent contract is
 * that a delegated agent sees only the text it is given, so a directive that
 * says "as discussed above" is a directive that produces the default screen.
 * It restates the brief, names every decision as a token, and closes with the
 * two rules that make three variants three variants: do not look at the
 * others, do not change the brief.
 */
export function renderVariantDirective(letter: string, pageName: string, brief: string, style: VariantStyleSeed): string {
  const type = style.headingSizeToken
    ? `var(${style.headingSizeToken}) (${style.headingSizePx}px) over body var(${style.bodySizeToken ?? '--?'}) (${style.bodySizePx}px)`
    : `${style.headingSizePx}px over ${style.bodySizePx}px body`
  const radius = style.radiusToken
    ? `${style.radiusFamily} corners — var(${style.radiusToken}) (${style.radiusPx}px)`
    : `${style.radiusFamily} corners (this project declares no radius token for that family — use the nearest one it does declare and say which)`
  const accent = style.accentToken
    ? `var(${style.accentToken}) (${style.accentHex})`
    : 'no accent token could be resolved from this project — pick one with studio_list_tokens and name it in your reply'
  const spacingNote = style.spacingBaseIsFallback
    ? `${style.spacingStepPx}px (this project declares no spacing tokens, so this is the conventional ${style.spacingBasePx}px base at ${style.density} density — prefer any real spacing token you find)`
    : `${style.spacingStepPx}px — the project's own ${style.spacingBasePx}px base at ${style.density} density`

  return [
    `Variant ${letter}. Build this as the page "${pageName}" and nothing else. You own ${pageName}.tsx and ${pageName}.module.css; touch no other file.`,
    ``,
    `The brief, which is identical for every variant and which you must not reinterpret:`,
    brief,
    ``,
    `Your style seed — these are decisions already made, not suggestions. Every value is a token this project already declares; do not substitute a raw hex or a raw px for any of them.`,
    `- Type contrast: ${style.typeContrast}, ratio ${style.typeScaleRatio}. Largest type ${type}.`,
    `- Spacing step: ${spacingNote}. That is the SMALLEST gap allowed on this screen; every margin, padding and gap is a whole multiple of it. This is the axis that makes ${style.density} read as ${style.density} — do not tighten it back up because a section looks empty.`,
    `- Corners: ${radius}.`,
    `- Accent: ${accent}. One accent, used for what matters most on the screen — not spread across every element.`,
    ``,
    `Two rules that make this a variant rather than a copy: do not look at what the other variants are doing, and do not change the brief to suit the seed. Differences between variants come from the seed above; everything the brief asks for must appear in all of them.`,
    `When the page is written, run studio_typecheck and studio_quality_check on it. Both must pass before you report back.`,
  ].join('\n')
}
