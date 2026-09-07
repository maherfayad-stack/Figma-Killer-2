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
 *     size, under `MIN_TYPE_HIERARCHY_RATIO`.
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
    if (ratio < MIN_TYPE_HIERARCHY_RATIO) {
      const biggest = typeSizes.find((s) => s.px === largest)!
      findings.push({
        code: 'flat-type-hierarchy',
        file: biggest.file,
        line: biggest.line,
        selector: biggest.selector,
        message: `This screen's largest type is ${largest}px against a body size of ${body}px — a ratio of ${ratio}, under the ${MIN_TYPE_HIERARCHY_RATIO} that reads as hierarchy. Everything is roughly the same size, so nothing leads: the eye has no entry point and the screen reads as a list of equals. Take the top-level heading up the project's own type scale (available: ${tokens.fontSizes.map((t) => `${t.px}px`).join(', ') || 'no type tokens declared'}) rather than adding weight or colour to compensate.`,
      })
    }
  }

  return { findings, rulesScanned, truncated: false }
}
