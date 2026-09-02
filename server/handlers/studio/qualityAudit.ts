/**
 * qualityAudit — reference-free quality signals over a screen's OWN authored
 * source: its stylesheet (raw values that should have been tokens, colour
 * pairs that fail WCAG contrast) AND its `.tsx` (hand-authored vector paths,
 * hardcoded inline sizing, and whether the screen adopted the project's own
 * design system at all). A2/A3 (STUDIO-FIGMA-PARITY-PLAN.md); the `.tsx`
 * checks close a diagnosed, reproduced gap: an agent that hits friction with
 * a design-system component silently falls back to hand-rolling, and nothing
 * checked for that.
 *
 * ## Why this exists
 *
 * `studio_compare` and `studio_measure_reference` both require a registered
 * design reference. On a from-scratch brief — no pasted comp, no Figma
 * connector, the ordinary "build me a settings screen" request — neither
 * tool has anything to measure against, so the agent's only signal was
 * `studio_screenshot` plus its own subjective judgement of a picture. This
 * closes part of that gap with numbers instead of vibes, over the thing that
 * needs no reference at all: whether the screen's OWN source follows the
 * project's own rules.
 *
 * ## What this is, deliberately
 *
 * A static, textual scan — the same "no real parser, no execution" posture
 * `checkSingleStylingMechanism` (`@core/page-parser/canonicalCheck.ts`) and
 * `tokenExtractTailwind.ts` share — over two kinds of already-written text:
 *
 *   - the page's `.css`/`.module.css`, against the project's own declared
 *     token index (the SAME `buildProjectTokenIndex`, `projectTokenIndex.ts`,
 *     and `contrastRatio`, `@core/design-tokens`, `studio_measure_reference`
 *     already uses, pointed at a different source);
 *   - the page's own `.tsx`, for three narrow, high-precision textual
 *     patterns (see "Finding codes" below) — deliberately NOT a semantic
 *     "did you hand-build something the design system already has a
 *     component for" check: a word-overlap heuristic against the catalog's
 *     component names was prototyped and rejected (see `qualityCheck.ts`'s
 *     module doc) because it fired on ordinary English words
 *     (`backButton`/`channelText`/`codeCell`) far more often than on a real
 *     hand-rolled component.
 *
 * Both scans are bounded by the size of one file, never a whole project.
 *
 * Complements, does not replace, `studio_screenshot`: this finds "you wrote
 * a raw #ef4550 where --color-coral-500 exists", "this button's text fails
 * WCAG AA against its own background", and "this is a hand-drawn `<path>`,
 * not an icon" — findings a picture doesn't hand you as a number. It does
 * not (and cannot, from static text alone) know what the screen actually
 * LOOKS like; sight still comes from `studio_screenshot`.
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
 *   - `hand-authored-vector-path` — a literal `<svg>...</svg>` in the page's
 *     JSX containing a `<path d="…">`. The exact shape the system prompt
 *     bans by name ("a hand-written path is not an icon"). Does NOT fire on
 *     a real icon asset rendered via `dangerouslySetInnerHTML` from an
 *     imported `?raw` SVG file — the literal `<path>` text lives in that
 *     file, never in the page's own `.tsx`.
 *   - `hardcoded-inline-sizing` — an inline `style={{…}}` object setting a
 *     layout/sizing property (`width`, `padding`, `borderRadius`, …) to a
 *     literal number or literal px/rem/%/vw/vh string — `style={{ width: 24
 *     }}`, not `style={{ width: computedWidth }}`. Deliberately does NOT
 *     fire on a CSS custom-property key (`style={{ '--x': value }}`) — the
 *     project's own documented exception for a dynamic value the stylesheet
 *     reads back via `var(--x)` — nor on any non-literal value (an
 *     identifier, a template literal, a function call), which is exactly
 *     the legitimate "one dynamic value" case this rule must not punish.
 *   - `unresolved-asset-import` — a `?raw` text import naming a file that is
 *     not on disk. Resolved through the parser's own `resolveImportedFile`,
 *     so it reports exactly what the canvas failed to resolve — never a
 *     guess. Zero-judgement: the file either exists or it does not.
 *   - `design-system-unused` — the page's own `.tsx` contains no import
 *     specifier naming the project's configured component package(s) at
 *     all. Fires only when the project genuinely HAS a component package
 *     installed (`ProjectProfile.componentPackages`) — a project with no
 *     design system has nothing to compare against, so this never fires
 *     there. Coarse by design: it says "worth checking", not "wrong" — a
 *     screen with no UI beyond native HTML is a legitimate reason for zero
 *     imports.
 */
import type { UnresolvedAssetImport } from '@core/page-parser'
import { colorDifference, contrastRatio, parseHexColor, type Rgb } from '@core/design-tokens'
import { nearestSizeToken, type ColorTokenEntry, type ProjectTokenIndex } from './projectTokenIndex'

/** ΔE beyond which a raw colour is reported with no suggested token — same rationale as `referenceMeasure.ts`'s identical constant, kept local since the two call sites answer different questions (a MEASURED pixel vs. an AUTHORED literal) and are not guaranteed to want the same threshold forever. */
const COLOR_MATCH_MAX_DELTA_E = 5
/** WCAG AA, normal text. See the module doc's `low-contrast-pair` entry for why this is the only threshold applied. */
const WCAG_AA_NORMAL_TEXT = 4.5
/** Bounds the scan so a pathological stylesheet cannot dominate a turn — far above any real screen's own rule count. */
const MAX_FINDINGS = 60
/** Same rationale as `MAX_FINDINGS`, applied to the page's `.tsx` scan — a distinct constant because a pathological page (a 500-line kitchen-sink screen) and a pathological stylesheet are unrelated failure modes, not guaranteed to want the same cap forever. */
const MAX_PAGE_SOURCE_FINDINGS = 60

const COLOR_PROPERTY_RE = /^(color|background|background-color|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color|fill|stroke|outline-color)$/i
const SIZE_PROPERTY_RE = /^(font-size|padding|padding-top|padding-right|padding-bottom|padding-left|margin|margin-top|margin-right|margin-bottom|margin-left|gap|row-gap|column-gap|border-radius|width|height|min-width|min-height|max-width|max-height|top|right|bottom|left)$/i
const RAW_HEX_RE = /^#[0-9a-fA-F]{3,8}$/
const RAW_PX_RE = /^(-?\d+(?:\.\d+)?)px$/
/** A rule block: `selector { declarations }`, non-nested (matches `single-styling-mechanism`'s textual-scan posture — no real CSS parser). */
const RULE_BLOCK_RE = /([^{}]+)\{([^{}]*)\}/g
const DECLARATION_RE = /([a-zA-Z-]+)\s*:\s*([^;]+);?/g

/** A literal `<svg ...>...</svg>` block in JSX text — non-nested, same "no real parser" posture as `RULE_BLOCK_RE`: an `<svg>` nested inside another `<svg>` (vanishingly rare in authored JSX) under-scans rather than mis-scans. */
const SVG_BLOCK_RE = /<svg\b[^>]*>[\s\S]*?<\/svg>/g
/** A `<path>` element carrying a `d` attribute — the literal hand-drawn geometry the system prompt bans by name. Matched inside an already-captured `<svg>` block, never against the whole file, so it can't fire on an unrelated `d` prop elsewhere. */
const PATH_WITH_D_RE = /<path\b[^>]*\bd\s*=/i

/** A JSX inline `style={{ ... }}` object — non-nested, same posture as above: a nested object or a `{` inside a template-literal value ends the capture early rather than mis-capturing. */
const STYLE_OBJECT_RE = /style=\{\{([^{}]*)\}\}/g
/** One `key: value` entry inside an already-captured `style={{…}}` body. The key is either a bare identifier (`width`) or a quoted custom-property name (`'--foo'`/`"--foo"`); a comma inside the VALUE itself (`rgba(0,0,0,1)`) truncates only that one segment's captured value, which just means the strict literal check below fails to match it — it can never turn into a false positive, only a missed one. */
const STYLE_DECLARATION_RE = /(?:'(--[\w-]+)'|"(--[\w-]+)"|([a-zA-Z_$][\w$]*))\s*:\s*([^,]+?)(?:,|$)/g
/** A bare numeric literal (`24`, `-4.5`) — deliberately not an identifier, template literal, or call expression, so a genuinely dynamic/computed inline value never matches. */
const NUMERIC_LITERAL_RE = /^-?\d+(?:\.\d+)?$/
/** A quoted literal length (`'24px'`, `"1.5rem"`) — same "literal only" restriction as `NUMERIC_LITERAL_RE`. */
const QUOTED_LENGTH_LITERAL_RE = /^['"]-?\d+(?:\.\d+)?(?:px|rem|em|%|vw|vh)['"]$/

/** Layout/sizing style keys worth flagging when hardcoded inline — the same dimensional surface `SIZE_PROPERTY_RE` scans in a stylesheet, spelled camelCase for a JS object key. Deliberately excludes non-dimensional properties (`opacity`, `zIndex`, `transform`, colours) — those have plausible legitimate one-off dynamic uses this rule is not trying to police. */
const SIZING_STYLE_KEYS = new Set([
  'fontSize',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'gap', 'rowGap', 'columnGap', 'borderRadius',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'top', 'right', 'bottom', 'left',
])

export type QualityFindingCode =
  | 'raw-hex-color'
  | 'raw-px-length'
  | 'low-contrast-pair'
  | 'hand-authored-vector-path'
  | 'hardcoded-inline-sizing'
  | 'design-system-unused'
  | 'unresolved-asset-import'

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

/**
 * Scan a page's own already-written `.tsx` text (never a compiled/bundled
 * one) for three narrow, high-precision patterns of hand-rolling around a
 * design system the project has — see the module doc's "Finding codes" for
 * each rule's exact shape and why the fourth, harder pattern (hand-built
 * markup for a role the catalog maps to a component) was prototyped and
 * rejected instead of shipped here.
 *
 * `designSystemPackages` is `ProjectProfile.componentPackages` — pass `[]`
 * for a project with no installed component package, which correctly
 * disables the `design-system-unused` check (nothing to compare against)
 * without disabling the other two, source-only checks.
 *
 * Never throws: a malformed/partial `.tsx` just yields fewer findings,
 * matching `auditStylesheetQuality`'s own posture.
 */
export function auditPageSourceQuality(
  tsxText: string,
  relFile: string,
  designSystemPackages: readonly string[],
  unresolvedImports: readonly UnresolvedAssetImport[] = [],
): QualityAuditResult {
  const findings: QualityFinding[] = []
  let rulesScanned = 0

  // Reported first: an icon that is simply ABSENT outranks every stylistic
  // finding below it, and it is the one thing on this list that no other
  // signal — not the canvas, not a screenshot, not `tsc` — will ever say.
  for (const dead of unresolvedImports) {
    rulesScanned += 1
    if (findings.length >= MAX_PAGE_SOURCE_FINDINGS) break
    findings.push({
      code: 'unresolved-asset-import',
      file: relFile,
      line: dead.line,
      selector: dead.localName,
      message: `"${dead.localName}" imports "${dead.specifier}", and that file is not on disk. Nothing renders where it is used — the element keeps its class and its box and comes out EMPTY, which looks like a layout bug rather than a missing file, and it typechecks because "*.svg?raw" is declared ambiently. Check the real filename in the design system's icon directory (studio_design_system_guide lists them) and import that.`,
    })
  }

  for (const block of tsxText.matchAll(SVG_BLOCK_RE)) {
    rulesScanned += 1
    if (findings.length >= MAX_PAGE_SOURCE_FINDINGS) break
    if (!PATH_WITH_D_RE.test(block[0])) continue
    const pathCount = [...block[0].matchAll(/<path\b/gi)].length
    findings.push({
      code: 'hand-authored-vector-path',
      file: relFile,
      line: lineAt(tsxText, block.index ?? 0),
      selector: '<svg>',
      message: `A literal <svg> with ${pathCount} hand-written <path d="…"> element${pathCount === 1 ? '' : 's'} — a hand-drawn path is not an icon; it renders as a coloured blob at any size other than the one it was traced at. Use a real icon from the design system instead (its exact import is listed in the generated icon reference).`,
    })
  }

  for (const block of tsxText.matchAll(STYLE_OBJECT_RE)) {
    rulesScanned += 1
    if (findings.length >= MAX_PAGE_SOURCE_FINDINGS) break
    const body = block[1]!
    const blockStart = block.index ?? 0
    for (const decl of body.matchAll(STYLE_DECLARATION_RE)) {
      if (findings.length >= MAX_PAGE_SOURCE_FINDINGS) break
      const customProp = decl[1] ?? decl[2]
      if (customProp) continue // a CSS custom property read back via var(--x) — the project's own documented exception, never flagged
      const key = decl[3]
      if (!key || !SIZING_STYLE_KEYS.has(key)) continue
      const value = decl[4]!.trim()
      if (!NUMERIC_LITERAL_RE.test(value) && !QUOTED_LENGTH_LITERAL_RE.test(value)) continue
      findings.push({
        code: 'hardcoded-inline-sizing',
        file: relFile,
        line: lineAt(tsxText, blockStart + (decl.index ?? 0)),
        selector: 'style={{…}}',
        message: `style={{ ${key}: ${value} }} hardcodes a layout value inline. Real styling belongs in the stylesheet, not style={{…}} — move this into the page's own stylesheet and reference it with a class; keep the inline style only for a value that is genuinely computed at runtime.`,
      })
    }
  }

  if (designSystemPackages.length > 0) {
    const imported = designSystemPackages.some(
      // A named/default import (`from '<pkg>'`) AND a bare side-effect import
      // (`import '<pkg>/dist/index.css'`, no `from`) both count as adoption —
      // check the quoted specifier itself, not the `from` keyword.
      (pkg) => tsxText.includes(`'${pkg}'`) || tsxText.includes(`"${pkg}"`) || tsxText.includes(`'${pkg}/`) || tsxText.includes(`"${pkg}/`),
    )
    if (!imported) {
      findings.push({
        code: 'design-system-unused',
        file: relFile,
        line: 1,
        selector: 'imports',
        message: `This file imports nothing from ${designSystemPackages.join(', ')} — this project's own design system. If this screen is deliberately plain (no UI beyond native elements), that's fine; otherwise check whether something that should be a design-system component got hand-rolled instead.`,
      })
    }
  }

  return { findings: findings.slice(0, MAX_PAGE_SOURCE_FINDINGS), rulesScanned, truncated: findings.length > MAX_PAGE_SOURCE_FINDINGS }
}
