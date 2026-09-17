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
import { COMPOSITION_RULES, LAYOUT_ARCHETYPES, MIN_TYPE_HIERARCHY_RATIO, type LayoutArchetype } from './compositionAudit'
import { DEFAULT_DESIGN_POLICY, DESIGN_POLICIES, type DesignPolicy } from './designPolicy'
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

/**
 * A13 — how many archetype bands one variant's sequence holds.
 *
 * Three: enough that two variants' sequences genuinely differ in STRUCTURE
 * (six archetypes taken three at a time is twenty orderings, so a collision
 * between three variants is rare rather than likely), and few enough that one
 * subagent finishes the screen inside its own step budget.
 */
const ARCHETYPES_PER_VARIANT = 3

/**
 * A13, `free` policy only — type-contrast targets beyond what the project's
 * own scale expresses.
 *
 * Under `follow`/`balanced` the seed may only propose ratios the project can
 * actually hit with a declared token, because a seed that asks for 3.2 on a
 * scale topping out at 2.0 hands the subagent an instruction its own quality
 * check then fails. Under `free` there is no such obligation — the design
 * system is optional and an editorial display size IS the distinct visual
 * language the policy asks for.
 */
const FREE_TYPE_CONTRAST_POOL: readonly number[] = [1.8, 2.4, 3.2, 4]
/** How each `free` contrast level reads, keyed by index into `FREE_TYPE_CONTRAST_POOL`. */
const FREE_TYPE_CONTRAST_LABEL: readonly string[] = ['confident', 'editorial', 'poster', 'billboard']
/** `free` radius families: the whole vocabulary, not only the ones the project declares a token for. */
const FREE_RADIUS_FAMILIES: readonly VariantRadiusFamily[] = VARIANT_RADIUS_FAMILIES
/** `free` spacing bases, in px. Each is a coherent rhythm on its own; varying the BASE (not just the multiplier) is what makes two free variants feel like different systems rather than one system at two densities. */
const FREE_SPACING_BASES: readonly number[] = [4, 6, 8]

// ---------------------------------------------------------------------------
// Persisted shape — schemas are the source of truth (CLAUDE.md §Validation)
// ---------------------------------------------------------------------------

/** Built once here rather than inline, so the union and `DESIGN_POLICIES` can never fall out of step. */
const DESIGN_POLICIES_LITERALS = DESIGN_POLICIES.map((p) => Type.Literal(p))

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
  /** A13 — the archetype ids this variant's screen is composed from, top to bottom. The axis that makes A/B/C differ in STRUCTURE rather than only in tokens. */
  archetypes: Type.Array(Type.String()),
  /** The design policy this seed was generated under. Recorded because a `free` seed may carry values the project declares no token for — a reader that did not know the policy would read those as a generator bug. */
  designPolicy: Type.Union(DESIGN_POLICIES_LITERALS),
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
  /**
   * A12/A13 — the resolved design policy. Only `free` changes anything: it
   * widens the type, spacing, radius and accent pools past what the project
   * declares, because under `free` the design system is optional and the
   * policy explicitly asks for a distinct visual language. `follow` and
   * `balanced` both stay inside the project's own token space, which is what
   * keeps a generated seed from proposing a screen its own quality check
   * would then fail.
   */
  readonly designPolicy?: DesignPolicy
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
  const designPolicy = options.designPolicy ?? DEFAULT_DESIGN_POLICY
  const free = designPolicy === 'free'
  const count = Math.max(1, Math.min(options.count, MAX_VARIANTS_PER_SET))
  const rng = makeRng(rngSeed)

  const spacingBase = detectSpacingBase(tokens)
  const bodyToken = detectBodyToken(tokens)
  const bodySizePx = bodyToken?.px ?? FALLBACK_BODY_SIZE_PX

  // Axis 1 — type contrast, without replacement. Under `free` the pool is the
  // extended one: the design system is optional, so a display step the
  // project's own scale cannot express is a legitimate answer rather than a
  // seed that fails its own audit.
  const contrastPool = free ? FREE_TYPE_CONTRAST_POOL : TYPE_CONTRAST_POOL
  const contrastLabels = free ? FREE_TYPE_CONTRAST_LABEL : TYPE_CONTRAST_LABEL
  const contrastOrder = shuffled(contrastPool.map((ratio, i) => ({ ratio, label: contrastLabels[i]! })), rng)
  const contrasts = takeCycling(contrastOrder, count)

  // Axis 2 — density, without replacement.
  const densities = takeCycling(shuffled(VARIANT_DENSITIES, rng), count)

  // Axis 2b — `free` varies the spacing BASE too, not only the multiplier:
  // two variants at the same base and different densities are one system at
  // two zoom levels, which is not the "distinct visual language" this policy
  // asks for. Everything else stays on the project's own base.
  const freeBases = takeCycling(shuffled(FREE_SPACING_BASES, rng), count)

  // Axis 3 — radius family. Restricted to families the project actually has
  // tokens for (a project whose only radius token is 4px gets `soft` for every
  // variant rather than an invented `pill` no token expresses) — unless the
  // policy is `free`, where the whole vocabulary is available and the
  // directive says to write the raw value.
  const radiusTokens = tokens.lengths.filter((t) => RADIUS_TOKEN_NAME_RE.test(t.name))
  const familyToToken = new Map<VariantRadiusFamily, SizeTokenEntry>()
  for (const token of radiusTokens) {
    const family = radiusFamilyOf(token.px)
    if (!familyToToken.has(family)) familyToToken.set(family, token)
  }
  const radiusPool = free ? FREE_RADIUS_FAMILIES : [...familyToToken.keys()]
  const radiusChoices = takeCycling(shuffled(radiusPool, rng), count)

  // Axis 4 — accent colour, without replacement, from the project's palette.
  // Under `free` the whole palette is eligible, neutrals aside: the accent
  // filter exists to stop a seed picking `--text-muted` as a brand colour, and
  // that is still wrong at every policy.
  const accentPool = tokens.colors.filter((c) => ACCENT_TOKEN_NAME_RE.test(c.name) && !NON_ACCENT_TOKEN_NAME_RE.test(c.name))
  const nonNeutral = tokens.colors.filter((c) => !NON_ACCENT_TOKEN_NAME_RE.test(c.name))
  const fallbackPool = free ? (nonNeutral.length > 0 ? nonNeutral : accentPool) : (accentPool.length > 0 ? accentPool : nonNeutral)
  const accents = takeCycling(shuffled(fallbackPool, rng), count)

  // Axis 5 (A13) — the archetype SEQUENCE. Shuffled ONCE and then walked with
  // a per-variant offset, so every variant gets a different starting shape AND
  // a different order: A might be hero → feature grid → pricing where B is
  // split → testimonial band → footer. This is the axis that makes the three
  // screens structurally different rather than three tints of one screen.
  const archetypeOrder = shuffled(LAYOUT_ARCHETYPES, rng)

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
    // Under `free` the TARGET wins even when a token is nearer something else:
    // the whole point of the extended pool is a display size the project's own
    // scale does not carry, and snapping back to the nearest token would
    // silently discard it. Under every other policy the token wins, always.
    const headingSizePx = free || headingToken === undefined
      ? Math.round(bodySizePx * target.ratio)
      : headingToken.px
    const achievedRatio = Math.round((headingSizePx / bodySizePx) * 100) / 100

    const density = densities[i] ?? 'regular'
    // `free` varies the base itself; every other policy stays on the project's
    // own, which is what keeps `off-scale-spacing` satisfiable by construction.
    const basePx = free ? (freeBases[i] ?? spacingBase.px) : spacingBase.px
    const spacingStepPx = basePx * DENSITY_MULTIPLIER[density]
    const radiusFamily = radiusChoices[i] ?? 'soft'
    const radiusToken = familyToToken.get(radiusFamily)
    const accent = accents[i]

    // A13 — walk the shuffled archetype order from a per-variant offset of
    // ONE, wrapping. Every variant opens on a different shape and repeats no
    // band inside itself.
    //
    // Three variants x three bands is nine slots over six archetypes, so some
    // OVERLAP between variants is arithmetic, not a bug — and the structural
    // difference this axis buys is the opening and the order, which a stride
    // of one guarantees and a larger stride does not (a stride equal to
    // `ARCHETYPES_PER_VARIANT` wraps variant C straight back onto variant A's
    // opening whenever the pool is a multiple of it).
    const archetypes = Array.from(
      { length: Math.min(ARCHETYPES_PER_VARIANT, archetypeOrder.length) },
      (_, step) => archetypeOrder[(i + step) % archetypeOrder.length]!,
    )

    const style: VariantStyleSeed = {
      typeScaleRatio: achievedRatio,
      typeContrast: target.label,
      bodySizePx,
      ...(bodyToken ? { bodySizeToken: bodyToken.name } : {}),
      headingSizePx,
      // Named only when the size IS that token's value — under `free` the
      // heading is computed from the target ratio, and naming a token whose
      // px differs would put a lie in the directive.
      ...(headingToken && !free ? { headingSizeToken: headingToken.name } : {}),
      spacingBasePx: basePx,
      spacingBaseIsFallback: free ? false : spacingBase.fallback,
      density,
      spacingStepPx,
      radiusFamily,
      ...(radiusToken ? { radiusPx: radiusToken.px, radiusToken: radiusToken.name } : {}),
      ...(accent ? { accentToken: accent.name, accentHex: accent.hex } : {}),
      archetypes: archetypes.map((a) => a.id),
      designPolicy,
    }

    seeds.push({
      letter,
      pageName: `${baseName}${letter}`,
      style,
      directive: renderVariantDirective(letter, `${baseName}${letter}`, brief, style, archetypes),
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
export function renderVariantDirective(
  letter: string,
  pageName: string,
  brief: string,
  style: VariantStyleSeed,
  /**
   * A13 — the archetype sequence, resolved. Passed in rather than looked up
   * from `style.archetypes`'s ids so the directive cannot render a band whose
   * brief text does not exist; a caller re-rendering an OLD recorded seed
   * passes `[]` and simply gets the pre-A13 directive back, which is what
   * that seed actually described.
   */
  archetypes: readonly LayoutArchetype[] = [],
): string {
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

  // The one sentence that changes with the policy, because it is the one
  // instruction that is genuinely different: under `free` a raw value is the
  // point, and under everything else it is a defect.
  const tokenRule = style.designPolicy === 'free'
    ? `Every value below is a decision, not a suggestion. This project's design system is OPTIONAL here — where a seed value has no token, write the raw value and keep it consistent across the whole screen. What is NOT optional: WCAG AA contrast on every text/background pair, a font the project can actually load, and real assets rather than hand-drawn paths.`
    : `Your style seed — these are decisions already made, not suggestions. Every value is a token this project already declares; do not substitute a raw hex or a raw px for any of them.`

  const composition = archetypes.length > 0
    ? [
      ``,
      `Compose the screen out of these bands, in this order. The order is part of the variant — it is what makes this screen structurally different from the others, so do not reorder it, merge two bands, or add a fourth.`,
      ...archetypes.map((archetype, index) => `${index + 1}. ${archetype.label} — ${archetype.brief}`),
      ``,
      `The rules that make a screen read as designed rather than as rendered:`,
      ...COMPOSITION_RULES.map((rule) => `- ${rule}`),
    ]
    : []

  return [
    `Variant ${letter}. Build this as the page "${pageName}" and nothing else. You own ${pageName}.tsx and ${pageName}.module.css; touch no other file.`,
    ``,
    `The brief, which is identical for every variant and which you must not reinterpret:`,
    brief,
    ``,
    tokenRule,
    `- Type contrast: ${style.typeContrast}, ratio ${style.typeScaleRatio}. Largest type ${type}.`,
    `- Spacing step: ${spacingNote}. That is the SMALLEST gap allowed on this screen; every margin, padding and gap is a whole multiple of it. This is the axis that makes ${style.density} read as ${style.density} — do not tighten it back up because a section looks empty.`,
    `- Corners: ${radius}.`,
    `- Accent: ${accent}. One accent, used for what matters most on the screen — not spread across every element.`,
    ...composition,
    ``,
    `Two rules that make this a variant rather than a copy: do not look at what the other variants are doing, and do not change the brief to suit the seed. Differences between variants come from the seed above; everything the brief asks for must appear in all of them.`,
    `When the page is written, run studio_typecheck and studio_quality_check on it. Both must pass before you report back.`,
  ].join('\n')
}
