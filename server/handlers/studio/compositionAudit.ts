/**
 * compositionAudit — the page-level half of `studio_quality_check`: whether a
 * screen's spacing sits on the project's own rhythm, whether its type sizes
 * sit on the project's own scale, and whether it has a type hierarchy at all.
 * W9-3 (`STUDIO-WAVE7-PLAN.md`).
 *
 * ## Why this is its own module
 *
 * `qualityAudit.ts` grades COMPLIANCE — one finding per authored declaration
 * that should have been a token, per file. That is a different unit of work
 * from what lives here, in two ways that make sharing a module wrong:
 *
 *   - These are **aggregates**: at most one finding per rule per page,
 *     carrying a count, a ratio and the offending `file:line` list. Per
 *     declaration would double-report every value `raw-px-length` already
 *     flags, and is also not a shape a weaker model can act on — 40 findings
 *     read as noise where one ratio reads as a next step.
 *   - These are **page-level**, spanning every stylesheet the page imports.
 *     Per-file would make `flat-type-hierarchy` simply wrong: a screen's type
 *     scale lives across its whole sheet set, so "largest ÷ body" computed
 *     inside one `.module.css` measures a fragment and calls it a hierarchy.
 *
 * Compliance-only feedback is also what produces template-y output: a screen
 * can satisfy every rule in `qualityAudit.ts` and still be three stacked grey
 * boxes with one type size. These rules grade what a token swap cannot.
 *
 * ## Findings
 *
 *   - `off-scale-spacing` — padding/margin/gap values that are not multiples
 *     of the step the project's own spacing tokens are built on.
 *   - `off-scale-type-size` — font-sizes sitting on no step of the project's
 *     own declared type scale.
 *   - `flat-type-hierarchy` — largest type ÷ the page's most common (body)
 *     size, under `MIN_TYPE_HIERARCHY_RATIO`. The screen has no SCALE.
 *   - `monotone-band-rhythm` (A13) — the screen's spacing is one value
 *     repeated: too few distinct steps, or no gap large enough to separate
 *     one band from the next. Everything is equidistant, so nothing groups.
 *   - `no-focal-point` (A13) — the screen has a scale but nothing LEADS:
 *     fewer than three type sizes in use, or the biggest size used so many
 *     times that it is a body style, or a top-two gap too small to pick an
 *     entry point from. Never fires when `flat-type-hierarchy` did — a screen
 *     with no scale at all is one problem reported once.
 *
 * ## Layout archetypes (A13)
 *
 * {@link LAYOUT_ARCHETYPES} is the shared vocabulary for the shapes a screen
 * is actually built out of. Two pools, tagged by `surface` (AI-12): the web
 * bands a marketing or product page is made of (hero, feature grid, split,
 * testimonial band, pricing, footer), and the bands a MOBILE APP screen is
 * made of (list rows, grouped settings list, form step, card feed, stats and
 * chart, order summary, detail header, empty state). Studio projects are
 * overwhelmingly app screens, and a variant set built from hero/pricing/footer
 * for a 393px checkout screen produced a web page squeezed into a phone. App
 * CHROME (the top bar, a tab bar or a pinned action) is not a band — it frames
 * every app screen — so it is stated once, as {@link APP_CHROME_RULE}. It
 * lives here, beside the rules that grade composition, and is consumed in two
 * places that must agree:
 *
 *   - `variantSeeds.ts` gives each variant a different archetype SEQUENCE, so
 *     A/B/C differ in STRUCTURE and not only in tokens. Three screens with
 *     the same three stacked bands in a different accent are one screen.
 *   - the creative fidelity block names them, so a from-scratch brief starts
 *     from a composition rather than from a `<div>`.
 *
 * The archetypes are not detected from CSS and deliberately never will be:
 * "is this a testimonial band" is a semantic question about content, and a
 * textual scan that guessed at it would be exactly the word-overlap heuristic
 * `qualityAudit.ts` already prototyped and rejected. They are a GENERATOR's
 * vocabulary; what this module grades is whether the result reads as designed.
 *
 * Both scale rules run ONLY against the project's own declared tokens (the
 * SAME `buildProjectTokenIndex` index `qualityAudit.ts` uses — nothing new is
 * computed). A project that declares no spacing tokens gets no spacing rhythm
 * rule and a project that declares no type tokens gets no type scale rule,
 * rather than being graded against an invented 4px/1.25 default it never
 * agreed to. `flat-type-hierarchy` needs no tokens at all: it is a ratio
 * between the page's own largest and most-common type size.
 *
 * Same static, textual, never-execute posture as `qualityAudit.ts`, whose
 * scan primitives (`RULE_BLOCK_RE`, `DECLARATION_RE`, `RAW_PX_RE`, `lineAt`)
 * and finding types this module reuses rather than restates.
 */
import type { ProjectTokenIndex } from './projectTokenIndex'
import {
  DECLARATION_RE,
  RAW_PX_RE,
  RULE_BLOCK_RE,
  lineAt,
  type QualityAuditResult,
  type QualityFinding,
} from './qualityAudit'

/** Spacing/rhythm properties. Narrower than `SIZE_PROPERTY_RE` on purpose: `width`/`height`/`top` are positions and box sizes, which have legitimate off-rhythm values (a 44px tap target, a 1px rule); padding, margin and gap are the rhythm. */
const SPACING_PROPERTY_RE = /^(padding|padding-top|padding-right|padding-bottom|padding-left|margin|margin-top|margin-right|margin-bottom|margin-left|gap|row-gap|column-gap)$/i
/** A custom property whose name reads as spacing rhythm rather than a radius, a border or an icon box. */
const SPACING_TOKEN_NAME_RE = /(space|spacing|gap)/i
/** One px length inside a possibly-shorthand value (`padding: 8px 12px`). */
const PX_TOKEN_RE = /(-?\d+(?:\.\d+)?)px/g
/** `var(--token)`, optional fallback ignored — the fallback is by policy absent in this repo and irrelevant to what the value resolves to in the project's own CSS. */
const VAR_REFERENCE_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,.*)?\)$/

/** Below this many samples an aggregate is an anecdote, not a rhythm. */
const MIN_SPACING_SAMPLES = 6
/** Same, for the type scale — three sizes is the minimum at which "largest vs. body" is a hierarchy rather than two values. */
const MIN_TYPE_SAMPLES = 3
/** A project declaring fewer type tokens than this has no scale to be off. */
const MIN_TYPE_TOKENS = 3
/** Largest type size ÷ the page's most common (body) size. Below this the page reads flat — everything is body copy with a slightly bigger heading. 1.6 is roughly a major-third step twice over (1.25² = 1.5625): one heading level of genuine contrast above body. */
export const MIN_TYPE_HIERARCHY_RATIO = 1.6
/** How close a raw px font-size must be to a declared type token to count as on-scale. Half a pixel — a design system's own scale is exact; 15px next to a 16px token is a different size, not a rounding. */
const TYPE_SCALE_TOLERANCE_PX = 0.5
/** Offending values listed inside one aggregate finding. */
const MAX_OFFENDERS_IN_FINDING = 8

// ---------------------------------------------------------------------------
// A13 — layout archetypes and the rules that make a screen read as designed
// ---------------------------------------------------------------------------

/**
 * One archetype: the shape, and the sentence that tells an agent what it is
 * for. The `brief` text is sent VERBATIM into a variant directive, so it has
 * to stand alone — a subagent sees only the text it is handed.
 */
export interface LayoutArchetype {
  readonly id: string
  readonly label: string
  readonly brief: string
  /** Which kind of screen this band belongs on: a web page, a mobile app screen, or either. */
  readonly surface: 'web' | 'app' | 'both'
}

/** The two kinds of screen a variant set is planned for. */
export type ArchetypeSurface = 'web' | 'app'

/**
 * The shapes a screen is almost always built out of — six for a web page,
 * eight for a mobile app screen (AI-12).
 *
 * Small pools, not twenty entries each: each pool exists so three variants can
 * be given three genuinely different SEQUENCES, and a pool that is just large
 * enough to guarantee distinctness is small enough that every entry is a shape
 * a weaker model can actually execute. Each `brief` names the structure and
 * the one thing that makes it read as that structure rather than as a stack of
 * boxes. {@link archetypesFor} picks the pool.
 */
export const LAYOUT_ARCHETYPES: readonly LayoutArchetype[] = [
  {
    id: 'hero',
    surface: 'web',
    label: 'Hero',
    brief: 'A hero band: one headline at the top of the type scale, one supporting line at body size, one primary action. Nothing else competes for attention in this band — a second button, a third line, or a headline at the same size as the section below it all cost the screen its entry point.',
  },
  {
    id: 'feature-grid',
    surface: 'web',
    label: 'Feature grid',
    brief: 'A feature grid: three or four equal cards in a row (stacking on narrow widths), each with one icon or mark, one short title a step above body, and one or two lines of copy. Equal cards means EQUAL — same padding, same radius, same internal rhythm; a grid whose cards differ reads as a mistake rather than as emphasis.',
  },
  {
    id: 'split',
    surface: 'web',
    label: 'Split',
    brief: 'A split band: content on one side, a single image or visual on the other, meeting on a shared vertical centre. Use logical properties so the split flips in RTL. The copy side carries the type hierarchy; the visual side carries no text at all.',
  },
  {
    id: 'testimonial-band',
    surface: 'web',
    label: 'Testimonial band',
    brief: 'A testimonial band: one quotation set noticeably larger than body copy, with an attribution line below it at or under body size. One quote, not a carousel of three — the band earns its space by being the one thing on screen, and the size gap between quote and attribution is what makes it read as a quotation.',
  },
  {
    id: 'pricing',
    surface: 'web',
    label: 'Pricing',
    brief: 'A pricing band: two or three plan columns, each with a name, a price set at the top of the type scale, a short feature list, and one action. Exactly one column is emphasised — by the accent, not by being bigger — and the others are visually identical to each other.',
  },
  {
    id: 'footer',
    surface: 'web',
    label: 'Footer',
    brief: 'A footer: two to four link columns with a small column heading each, a divider or surface change separating it from the band above, and everything at or below body size. A footer that uses a heading size from the top of the scale competes with the hero it sits furthest from.',
  },
  {
    id: 'detail-header',
    surface: 'app',
    label: 'Detail header',
    brief: 'A detail header: the one fact this screen is about, large — a balance, a plan name, a destination and date — with a single supporting line under it and at most one secondary action beside it. It sits directly under the top bar and is the entry point; nothing else on the screen uses its type size.',
  },
  {
    id: 'list-rows',
    surface: 'app',
    label: 'List rows',
    brief: 'A list of rows: each row a leading icon or avatar, a title with one line of meta under it, and a trailing value or chevron, every row at least 44px tall and the whole row tappable. Rows share one height and one inset; separation is a hairline divider or the gap between rows, never both.',
  },
  {
    id: 'grouped-list',
    surface: 'app',
    label: 'Grouped list',
    brief: 'A grouped settings list: rows gathered into two to four groups, each with a small uppercase or muted group label above an inset surface, and a larger gap between groups than between rows. Toggles and values sit right-aligned on one edge; a destructive row, if any, is last and alone.',
  },
  {
    id: 'form-step',
    surface: 'app',
    label: 'Form step',
    brief: 'A form step: one question or one group of related fields per screen, a step indicator above it, labels above inputs (never placeholder-as-label), and ONE primary action pinned at the bottom in thumb reach, full width, disabled until the step is valid. Error text sits under its own field.',
  },
  {
    id: 'card-feed',
    surface: 'app',
    label: 'Card feed',
    brief: 'A card feed: full-width cards stacked with one consistent gap, each card with one image or media block, a title, one line of meta and at most one action. Equal internal padding and one radius on every card; the feed scrolls, so the first card must read without scrolling.',
  },
  {
    id: 'stats-chart',
    surface: 'app',
    label: 'Stats and chart',
    brief: 'A stats band: two or three key numbers in a row, set large in tabular figures with a small label under each, then one chart for one measure over time with a period switcher (week / month / year). One accent marks the series that matters; axis labels stay at or below body size.',
  },
  {
    id: 'order-summary',
    surface: 'app',
    label: 'Order summary',
    brief: 'An order summary: line items with name left and price right in tabular figures, a divider, subtotal and fees muted, the total larger and bold, then one pinned primary action that repeats the total ("Pay $42.00"). Prices align on one right edge; nothing else competes with the pay action.',
  },
  {
    id: 'empty-state',
    surface: 'app',
    label: 'Empty state',
    brief: 'An empty state: centred in the space the content would fill, one real image or icon at a modest size, one short line saying what will appear here, one line saying how to make it appear, and one action that does it. It is written for this screen — never a generic "No data".',
  },
]

/**
 * App chrome — the frame every mobile app screen sits in, which is not one of
 * its bands. Quoted verbatim into the creative block and every app-surface
 * variant directive.
 */
export const APP_CHROME_RULE =
  'App chrome frames every app screen and is not a band: a top bar with the screen title and at most two actions, and at the bottom EITHER a tab bar of three to five destinations (a top-level screen) OR one pinned primary action (a task step, checkout, a form) — never both. Respect the safe areas: nothing interactive under the status bar or the home indicator.'

/** The archetype pool for one kind of screen. */
export function archetypesFor(surface: ArchetypeSurface): LayoutArchetype[] {
  return LAYOUT_ARCHETYPES.filter((archetype) => archetype.surface === surface || archetype.surface === 'both')
}

/**
 * The rules that separate "compiles and renders" from "reads as designed",
 * stated once here and quoted verbatim into the creative fidelity block and
 * every variant directive.
 *
 * Each one is either graded by a finding in this file or by an existing one in
 * `qualityAudit.ts` — nothing in this list is advice the tools cannot check,
 * because a rule with no grader is a rule nobody follows twice.
 */
export const COMPOSITION_RULES: readonly string[] = [
  'At least three steps of the type scale in use — a body size, a section heading, and one display size that leads. Two sizes is a document, not a screen. (graded: no-focal-point)',
  'One accent colour, spent on the single most important thing on the screen. An accent on every band is a colour scheme, not emphasis.',
  'One radius family. Sharp, soft, round or pill — pick one and use it on every card, input and button. Mixed radii read as unfinished.',
  'At least one spacing step MORE between bands than inside them, so sections separate without a rule or a border doing it. (graded: monotone-band-rhythm)',
  'Every text/background pair at WCAG AA or better. (graded: low-contrast-pair)',
]

/** Fewer distinct type sizes than this and nothing can lead: there is body copy and one heading. */
const MIN_TYPE_STEPS_IN_USE = 3
/** How many rules may carry the page's LARGEST type size before it stops being a focal point and becomes a body style. Two — a heading and its mirror in a narrow-width media query is legitimate; five of them is a repeated style. */
const MAX_FOCAL_OCCURRENCES = 2
/** Largest distinct type size ÷ the second-largest. Below this the top two levels read as the same weight and the eye has no single entry point. 1.2 rather than `MIN_TYPE_HIERARCHY_RATIO`: that ratio grades the whole scale (display vs. body), and applying a display-sized step BETWEEN two adjacent levels would fail every well-built modular scale. */
const MIN_FOCAL_STEP_RATIO = 1.2
/** Below this many distinct spacing values, a screen has no rhythm — everything is equidistant. Two: a gap inside a group and a larger one between groups is the minimum that groups anything. */
const MIN_DISTINCT_SPACING_STEPS = 2

/** One page stylesheet's already-read text. `auditCompositionQuality` takes the page's WHOLE set (see the module doc: a per-file type hierarchy measures a fragment). */
export interface PageStylesheetText {
  readonly relFile: string
  readonly cssText: string
}

interface ValueSample {
  readonly px: number
  readonly file: string
  readonly line: number
  readonly selector: string
  readonly property: string
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y > 0) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

/**
 * The project's own spacing step, as the GCD of every integer px value its
 * spacing tokens declare — a `4/8/12/16/24` scale yields 4, an `8/16/24`
 * scale yields 8.
 *
 * `undefined` when the project declares no spacing tokens, or when the GCD
 * collapses to 1 (a scale with an odd value in it is not a rhythm anything
 * can be measured against). Both cases DISABLE the rule rather than falling
 * back to a conventional 4px base: grading a project against a scale it never
 * declared is exactly the invented-rule shape this module refuses.
 */
function detectSpacingBasePx(tokens: ProjectTokenIndex): number | undefined {
  const values = tokens.lengths
    .filter((t) => SPACING_TOKEN_NAME_RE.test(t.name) && t.px >= 2 && Number.isInteger(t.px))
    .map((t) => t.px)
  if (values.length < 2) return undefined
  const base = values.reduce((acc, px) => gcd(acc, px))
  return base >= 2 ? base : undefined
}

/** The most frequent value in `values`; ties resolve to the smaller, which is the one that reads as body copy. */
function modeOf(values: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = values[0]!
  let bestCount = 0
  for (const [value, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

function describeOffenders(samples: readonly ValueSample[]): string {
  const shown = samples.slice(0, MAX_OFFENDERS_IN_FINDING)
  const more = samples.length - shown.length
  return `${shown.map((s) => `${s.px}px (${s.file}:${s.line}, ${s.selector})`).join('; ')}${more > 0 ? `; and ${more} more` : ''}`
}

/**
 * Grade a page's COMPOSITION — spacing rhythm, type scale, type hierarchy —
 * across every stylesheet it imports, using only the project's own declared
 * tokens (`buildProjectTokenIndex`; nothing new is computed).
 *
 * Page-level, and aggregate: at most one finding per rule per page, each
 * carrying a count, a ratio and the offending `file:line` list. See the module
 * doc's "Composition and coverage" for why it is neither per-declaration
 * (double-reports `raw-px-length`) nor per-file (a fragment is not a
 * hierarchy).
 *
 * Never throws: a malformed stylesheet yields fewer samples, matching
 * `auditStylesheetQuality`'s own posture.
 */
export function auditCompositionQuality(
  sheets: readonly PageStylesheetText[],
  tokens: ProjectTokenIndex,
): QualityAuditResult {
  const findings: QualityFinding[] = []
  let rulesScanned = 0

  const spacing: ValueSample[] = []
  const typeSizes: ValueSample[] = []

  for (const sheet of sheets) {
    for (const block of sheet.cssText.matchAll(RULE_BLOCK_RE)) {
      const selector = block[1]!.trim().replace(/\s+/g, ' ')
      const body = block[2]!
      const blockStart = block.index ?? 0
      for (const decl of body.matchAll(DECLARATION_RE)) {
        const property = decl[1]!.trim().toLowerCase()
        const value = decl[2]!.trim()
        const line = lineAt(sheet.cssText, blockStart + (decl.index ?? 0))

        if (SPACING_PROPERTY_RE.test(property)) {
          for (const px of value.matchAll(PX_TOKEN_RE)) {
            const n = Number(px[1])
            // 0 has no rhythm, and a sub-2px inset is a hairline, not spacing.
            if (n >= 2) spacing.push({ px: n, file: sheet.relFile, line, selector, property })
          }
          continue
        }

        if (property === 'font-size') {
          const varRef = VAR_REFERENCE_RE.exec(value)
          if (varRef) {
            const token = tokens.fontSizes.find((t) => t.name === varRef[1]) ?? tokens.lengths.find((t) => t.name === varRef[1])
            if (token) typeSizes.push({ px: token.px, file: sheet.relFile, line, selector, property })
            continue
          }
          const px = RAW_PX_RE.exec(value)
          if (px) typeSizes.push({ px: Number(px[1]), file: sheet.relFile, line, selector, property })
        }
      }
    }
  }

  const spacingBase = detectSpacingBasePx(tokens)
  if (spacingBase !== undefined && spacing.length >= MIN_SPACING_SAMPLES) {
    rulesScanned += 1
    const offScale = spacing.filter((s) => !Number.isInteger(s.px / spacingBase))
    if (offScale.length > 0) {
      const pct = Math.round((offScale.length / spacing.length) * 100)
      findings.push({
        code: 'off-scale-spacing',
        file: offScale[0]!.file,
        line: offScale[0]!.line,
        selector: offScale[0]!.selector,
        message: `${offScale.length} of ${spacing.length} padding/margin/gap values on this screen (${pct}%) are not multiples of ${spacingBase}px — the step this project's own spacing tokens are built on. Off-rhythm spacing is what makes a screen read as "almost right" with nothing nameable wrong. Off-scale: ${describeOffenders(offScale)}. Round each to the nearest multiple of ${spacingBase}px and use the var(--token) that carries it.`,
      })
    }
  }

  if (tokens.fontSizes.length >= MIN_TYPE_TOKENS && typeSizes.length >= MIN_TYPE_SAMPLES) {
    rulesScanned += 1
    const offScale = typeSizes.filter((s) => !tokens.fontSizes.some((t) => Math.abs(t.px - s.px) <= TYPE_SCALE_TOLERANCE_PX))
    if (offScale.length > 0) {
      const scale = tokens.fontSizes.map((t) => `${t.px}px`).join(', ')
      findings.push({
        code: 'off-scale-type-size',
        file: offScale[0]!.file,
        line: offScale[0]!.line,
        selector: offScale[0]!.selector,
        message: `${offScale.length} of ${typeSizes.length} font-size values on this screen sit on no step of the project's own type scale (${scale}). A one-off size does not compound into a system — it just makes one heading slightly different from every other screen's. Off-scale: ${describeOffenders(offScale)}.`,
      })
    }
  }

  if (typeSizes.length >= MIN_TYPE_SAMPLES) {
    rulesScanned += 1
    const values = typeSizes.map((s) => s.px)
    const body = modeOf(values)
    const largest = Math.max(...values)
    const ratio = body > 0 ? Math.round((largest / body) * 100) / 100 : 0
    const biggest = typeSizes.find((s) => s.px === largest)!
    const flat = ratio < MIN_TYPE_HIERARCHY_RATIO
    if (flat) {
      findings.push({
        code: 'flat-type-hierarchy',
        file: biggest.file,
        line: biggest.line,
        selector: biggest.selector,
        message: `This screen's largest type is ${largest}px against a body size of ${body}px — a ratio of ${ratio}, under the ${MIN_TYPE_HIERARCHY_RATIO} that reads as hierarchy. Everything is roughly the same size, so nothing leads: the eye has no entry point and the screen reads as a list of equals. Take the top-level heading up the project's own type scale (available: ${tokens.fontSizes.map((t) => `${t.px}px`).join(', ') || 'no type tokens declared'}) rather than adding weight or colour to compensate.`,
      })
    } else {
      // A13 — only reachable when the screen HAS a scale. A screen with no
      // scale at all is one problem, and `flat-type-hierarchy` above has
      // already reported it; adding a second finding for the same cause is
      // one mistake told twice, which is how a tool starts reading as noise.
      rulesScanned += 1
      const distinct = [...new Set(values)].sort((a, b) => b - a)
      const largestOccurrences = values.filter((px) => px === largest).length
      const secondLargest = distinct[1]
      const focalStep = secondLargest && secondLargest > 0 ? Math.round((largest / secondLargest) * 100) / 100 : null

      const causes: string[] = []
      if (distinct.length < MIN_TYPE_STEPS_IN_USE) {
        causes.push(`only ${distinct.length} distinct type size${distinct.length === 1 ? '' : 's'} in use (${distinct.map((px) => `${px}px`).join(', ')}) — a screen needs at least ${MIN_TYPE_STEPS_IN_USE}: body, a section heading, and one display size that leads`)
      }
      if (largestOccurrences > MAX_FOCAL_OCCURRENCES) {
        causes.push(`the largest size (${largest}px) is set on ${largestOccurrences} rules — a size used that often is a body style, not a focal point`)
      }
      if (focalStep !== null && focalStep < MIN_FOCAL_STEP_RATIO) {
        causes.push(`the top two sizes are ${largest}px and ${secondLargest}px, a step of ${focalStep} — under the ${MIN_FOCAL_STEP_RATIO} at which two levels read as different rather than as the same weight twice`)
      }

      if (causes.length > 0) {
        findings.push({
          code: 'no-focal-point',
          file: biggest.file,
          line: biggest.line,
          selector: biggest.selector,
          message: `Nothing on this screen leads the eye. ${causes.join('; ')}. The scale itself is fine (largest ${largest}px over body ${body}px is a ratio of ${ratio}) — what is missing is ONE element that is unmistakably the most important thing here. Pick it, put it at the top of the scale, and leave every other element a clear step below it.`,
        })
      }
    }
  }

  // A13 — band rhythm. Runs off the same spacing samples collected above and
  // needs no tokens at all: the question is whether this screen's own spacing
  // separates one band from the next, which is true or false regardless of
  // whose scale the values came from.
  if (spacing.length >= MIN_SPACING_SAMPLES) {
    rulesScanned += 1
    const values = spacing.map((s) => s.px)
    const distinct = [...new Set(values)].sort((a, b) => a - b)
    const inner = modeOf(values)
    const largest = distinct.at(-1)!
    // "One step" is the project's own base where it has one, and otherwise
    // the smallest gap this screen actually uses — never an invented 4px,
    // for the same reason `detectSpacingBasePx` refuses to invent one.
    const step = spacingBase ?? distinct[0]!
    const bandGap = largest - inner

    const causes: string[] = []
    if (distinct.length < MIN_DISTINCT_SPACING_STEPS) {
      causes.push(`every padding, margin and gap on the screen is ${largest}px — one value repeated ${values.length} times`)
    } else if (bandGap < step) {
      causes.push(`the largest gap is ${largest}px against an inner rhythm of ${inner}px, a difference of ${bandGap}px — less than the ${step}px step that would separate one band from the next`)
    }

    if (causes.length > 0) {
      const worst = spacing.find((s) => s.px === largest)!
      findings.push({
        code: 'monotone-band-rhythm',
        file: worst.file,
        line: worst.line,
        selector: worst.selector,
        message: `This screen has no band rhythm: ${causes[0]}. Equidistant spacing groups nothing — every element is as related to its neighbour as to the section above it, so the screen reads as one undifferentiated column no matter what is in it. Use the tight step INSIDE a group and at least one step more BETWEEN groups (${step}px inner, ${step * 2}px or more between bands), so the structure is visible before a single word is read.`,
      })
    }
  }

  return { findings, rulesScanned, truncated: false }
}
