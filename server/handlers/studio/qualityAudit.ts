/**
 * qualityAudit — reference-free quality signals over a screen's OWN authored
 * stylesheet: raw values that should have been tokens, and colour pairs that
 * fail WCAG contrast. A2/A3 (STUDIO-FIGMA-PARITY-PLAN.md).
 *
 * ## Why this exists
 *
 * `studio_compare` and `studio_measure_reference` both require a registered
 * design reference. On a from-scratch brief — no pasted comp, no Figma
 * connector, the ordinary "build me a settings screen" request — neither
 * tool has anything to measure against, so the agent's only signal was
 * `studio_screenshot` plus its own subjective judgement of a picture. This
 * closes part of that gap with numbers instead of vibes, over the thing that
 * needs no reference at all: whether the screen's OWN stylesheet follows the
 * project's own rules.
 *
 * ## What this is, deliberately
 *
 * A static scan of the page's already-written `.css`/`.module.css` text
 * against the project's own declared token index — the SAME
 * `buildProjectTokenIndex` (`projectTokenIndex.ts`) and `contrastRatio`
 * (`@core/design-tokens`) `studio_measure_reference` already uses, pointed at a
 * different source. No execution, no capture, no browser bridge — the same
 * "no execution" posture `checkSingleStylingMechanism`
 * (`@core/page-parser/canonicalCheck.ts`) and `tokenExtractTailwind.ts` share.
 * Bounded by the size of one stylesheet, never a whole project.
 *
 * Complements, does not replace, `studio_screenshot`: this finds "you wrote
 * a raw #ef4550 where --color-coral-500 exists" and "this button's text
 * fails WCAG AA against its own background" — findings a picture doesn't
 * hand you as a number. It does not (and cannot, from static CSS text alone)
 * know what the screen actually LOOKS like; sight still comes from
 * `studio_screenshot`.
 *
 * ## Finding codes
 *
 *   - `raw-hex-color` — a literal hex colour where the project declares a
 *     token; `token` is the nearest one, if any is close enough to be the
 *     obvious swap.
 *   - `raw-px-length` — a literal px length (font-size, spacing, radius, an
 *     explicit width/height) where the project declares a token for that
 *     kind of value.
 *   - `low-contrast-pair` — a single CSS rule declares both `color` and a
 *     background whose WCAG ratio falls under the 4.5:1 AA-normal-text
 *     floor. A coarse, single threshold — this cannot see the rule's
 *     `font-size`/`font-weight` to apply AA-large's looser 3:1, so a
 *     genuinely large/bold text rule may be flagged despite passing WCAG AA
 *     in practice; the message says so.
 */
import { colorDifference, contrastRatio, parseHexColor, type Rgb } from '@core/design-tokens'
import { nearestSizeToken, type ColorTokenEntry, type ProjectTokenIndex } from './projectTokenIndex'

/** ΔE beyond which a raw colour is reported with no suggested token — same rationale as `referenceMeasure.ts`'s identical constant, kept local since the two call sites answer different questions (a MEASURED pixel vs. an AUTHORED literal) and are not guaranteed to want the same threshold forever. */
const COLOR_MATCH_MAX_DELTA_E = 5
/** WCAG AA, normal text. See the module doc's `low-contrast-pair` entry for why this is the only threshold applied. */
const WCAG_AA_NORMAL_TEXT = 4.5
/** Bounds the scan so a pathological stylesheet cannot dominate a turn — far above any real screen's own rule count. */
const MAX_FINDINGS = 60

const COLOR_PROPERTY_RE = /^(color|background|background-color|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color|fill|stroke|outline-color)$/i
const SIZE_PROPERTY_RE = /^(font-size|padding|padding-top|padding-right|padding-bottom|padding-left|margin|margin-top|margin-right|margin-bottom|margin-left|gap|row-gap|column-gap|border-radius|width|height|min-width|min-height|max-width|max-height|top|right|bottom|left)$/i
const RAW_HEX_RE = /^#[0-9a-fA-F]{3,8}$/
const RAW_PX_RE = /^(-?\d+(?:\.\d+)?)px$/
/** A rule block: `selector { declarations }`, non-nested (matches `single-styling-mechanism`'s textual-scan posture — no real CSS parser). */
const RULE_BLOCK_RE = /([^{}]+)\{([^{}]*)\}/g
const DECLARATION_RE = /([a-zA-Z-]+)\s*:\s*([^;]+);?/g

export type QualityFindingCode = 'raw-hex-color' | 'raw-px-length' | 'low-contrast-pair'

export interface QualityFinding {
  readonly code: QualityFindingCode
  readonly file: string
  /** 1-based line in `file` where the declaration/rule starts. */
  readonly line: number
  readonly selector: string
  readonly message: string
  /** Present only for `raw-hex-color`/`raw-px-length`, when a project token is within range of the authored value. */
  readonly suggestedToken?: { readonly name: string; readonly value: string }
}

export interface QualityAuditResult {
  readonly findings: readonly QualityFinding[]
  readonly rulesScanned: number
  readonly truncated: boolean
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

function nearestColorToken(tokens: readonly ColorTokenEntry[], rgb: Rgb): { name: string; hex: string; deltaE: number } | undefined {
  let best: { name: string; hex: string; deltaE: number } | undefined
  for (const token of tokens) {
    const deltaE = colorDifference(rgb, token.rgb)
    if (best === undefined || deltaE < best.deltaE) best = { name: token.name, hex: token.hex, deltaE }
  }
  if (best === undefined || best.deltaE > COLOR_MATCH_MAX_DELTA_E) return undefined
  return best
}

/** Resolves a declared value to an `Rgb`, either a raw hex literal or a `var(--token)` reference the caller's token index already knows. `undefined` for anything else (a function call, a keyword, `currentColor`, an unresolvable var). */
function resolveColorValue(value: string, tokens: ProjectTokenIndex): { rgb: Rgb; raw: boolean } | undefined {
  const trimmed = value.trim()
  const direct = parseHexColor(trimmed)
  if (direct) return { rgb: direct, raw: true }
  const varMatch = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,.*)?\)$/.exec(trimmed)
  if (!varMatch) return undefined
  const token = tokens.colors.find((t) => t.name === varMatch[1])
  return token ? { rgb: token.rgb, raw: false } : undefined
}

/**
 * Scan `cssText` (a page's own authored stylesheet — never a compiled/vendor
 * one) for one-off values a project token already covers, and for
 * same-rule colour pairs that fail WCAG AA contrast.
 *
 * Never throws: a malformed/partial stylesheet just yields fewer findings,
 * matching the "no execution" posture of every other static scan in this
 * codebase.
 */
export function auditStylesheetQuality(cssText: string, relFile: string, tokens: ProjectTokenIndex): QualityAuditResult {
  const findings: QualityFinding[] = []
  let rulesScanned = 0

  for (const block of cssText.matchAll(RULE_BLOCK_RE)) {
    rulesScanned += 1
    if (findings.length >= MAX_FINDINGS) break
    const selector = block[1]!.trim().replace(/\s+/g, ' ')
    const body = block[2]!
    const blockStart = block.index ?? 0

    let colorValue: string | undefined
    let backgroundValue: string | undefined

    for (const decl of body.matchAll(DECLARATION_RE)) {
      if (findings.length >= MAX_FINDINGS) break
      const property = decl[1]!.trim().toLowerCase()
      const value = decl[2]!.trim()
      const declLine = lineAt(cssText, blockStart + (decl.index ?? 0))

      if (property === 'color') colorValue = value
      if (property === 'background' || property === 'background-color') backgroundValue = value

      if (COLOR_PROPERTY_RE.test(property) && RAW_HEX_RE.test(value)) {
        const rgb = parseHexColor(value)!
        const token = nearestColorToken(tokens.colors, rgb)
        findings.push({
          code: 'raw-hex-color',
          file: relFile,
          line: declLine,
          selector,
          message: token
            ? `${property}: ${value} — ${token.name} (${token.hex}) is within perceptual range (ΔE ${token.deltaE.toFixed(1)}); consider var(${token.name}) instead of the raw hex.`
            : `${property}: ${value} — a raw hex with no project token close enough to suggest. If this is intentional, it is still worth a one-line note in the reply per the system prompt's own rule.`,
          ...(token ? { suggestedToken: { name: token.name, value: token.hex } } : {}),
        })
        continue
      }

      if (SIZE_PROPERTY_RE.test(property)) {
        const px = RAW_PX_RE.exec(value)
        if (!px) continue
        const pxValue = Number(px[1])
        const candidates = property === 'font-size' ? tokens.fontSizes : tokens.lengths
        const nearest = nearestSizeToken(candidates, pxValue)
        const closeEnough = nearest && Math.abs(nearest.deltaPx) <= 1
        findings.push({
          code: 'raw-px-length',
          file: relFile,
          line: declLine,
          selector,
          message: closeEnough
            ? `${property}: ${value} — var(${nearest!.token.name}) is ${nearest!.token.px}px, effectively the same value; use the token instead of the raw px.`
            : nearest
              ? `${property}: ${value} — nearest project token is ${nearest.token.name} (${nearest.token.px}px, ${nearest.deltaPx > 0 ? '+' : ''}${nearest.deltaPx}px away). No token covers this value exactly; a raw px may be the honest choice, or this is off-rhythm.`
              : `${property}: ${value} — no project token of this kind exists to compare against.`,
          ...(closeEnough ? { suggestedToken: { name: nearest!.token.name, value: `${nearest!.token.px}px` } } : {}),
        })
      }
    }

    if (colorValue && backgroundValue && findings.length < MAX_FINDINGS) {
      const fg = resolveColorValue(colorValue, tokens)
      const bg = resolveColorValue(backgroundValue, tokens)
      if (fg && bg) {
        const ratio = Math.round(contrastRatio(fg.rgb, bg.rgb) * 100) / 100
        if (ratio < WCAG_AA_NORMAL_TEXT) {
          findings.push({
            code: 'low-contrast-pair',
            file: relFile,
            line: lineAt(cssText, blockStart),
            selector,
            message: `color: ${colorValue} on background: ${backgroundValue} is ${ratio}:1 — below the WCAG AA normal-text floor of ${WCAG_AA_NORMAL_TEXT}:1. This check cannot see font-size/font-weight, so a genuinely large or bold rule may still pass WCAG AA's looser 3:1 large-text threshold in practice — verify against the actual rendered text size before treating this as certain.`,
          })
        }
      }
    }
  }

  return { findings, rulesScanned, truncated: findings.length >= MAX_FINDINGS }
}
