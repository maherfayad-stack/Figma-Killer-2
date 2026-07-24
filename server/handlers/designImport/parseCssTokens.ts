/**
 * designImport/parseCssTokens — hand-rolled scanning for design-token import,
 * across three source shapes:
 *   - CSS: top-level `:root { --x: y; }`-style custom properties. No CSS
 *     parser dependency exists in this codebase (checked: no postcss/
 *     css-tree/lightningcss); the extraction needed is narrow enough that a
 *     small brace-depth scanner is simpler and lighter than a full CSS AST
 *     parser — see `extractRootCustomProperties`.
 *   - JSON: a recursive walk of the parsed value (real JSON.parse — always
 *     safe) — see `extractJsonTokens`.
 *   - JS/TS: a conservative TEXT-ONLY regex over `key: 'quoted string'` pairs
 *     — the source is NEVER parsed as code or executed — see
 *     `extractJsTokens`.
 *
 * Every extractor feeds the SAME `classifyToken` heuristic below, so a
 * `--brand-500` custom property, a `{"brand-500": {"value": "#fff"}}` JSON
 * leaf, and a `brand500: '#fff'` object-literal entry all classify
 * identically once extracted.
 *
 * Scope, deliberately narrow:
 *   - Only declared CUSTOM PROPERTIES inside a recognized global-token-host
 *     selector are extracted — `:root`, `html`, or either wrapped in a single
 *     `:where(...)`/`:is(...)` (real packages vary: open-props, for one,
 *     ships every token under `:where(html)` rather than `:root` — see
 *     `isGlobalHostSelectorSegment`) — not arbitrary color/length literals
 *     scattered through ordinary rules. Third-party CSS is unpredictable;
 *     custom properties on a recognized host are the closest thing to a
 *     declared "design token" a stylesheet can have, so restricting to them
 *     keeps the signal high (see the preview-dialog decision this backs — a
 *     raw literal-hunting scan would surface a lot of unrelated noise).
 *   - `@font-face` family names are NOT extracted as a token category: this
 *     app's Framework "Typography" settings are a numeric font-SIZE scale
 *     (`FrameworkTypographyGroup`), not a font-family picker — that's a
 *     separate subsystem (`@core/fonts`). Any `@font-face` rules in the
 *     source CSS still work because the raw file is copied into the project
 *     verbatim; they're just not surfaced as importable "typography" tokens.
 */

export interface ExtractedCssVar {
  /** Custom property name, without the leading `--`. */
  name: string
  /** Raw declared value, as written in the source (e.g. `"#4f46e5"`, `"1.25rem"`). */
  value: string
  /** Which source file this came from — surfaced in the preview for context. */
  file: string
}

export type TokenCategory = 'color' | 'typography' | 'spacing' | 'other'

/** One classified color candidate — ready for `createFrameworkColorToken`. */
export interface ColorTokenCandidate {
  id: string
  name: string
  value: string
  file: string
}

/**
 * One classified size candidate (typography or spacing) — ready for a
 * `fluid_manual` scale group's `manualSizes` entry. `px` is the value
 * converted to a plain number of pixels (see `convertLengthToPx`); size
 * candidates whose unit can't be safely converted (`%`, `vh`, `ch`, …) are
 * excluded from these lists entirely, not included with a guessed value.
 */
export interface SizeTokenCandidate {
  id: string
  name: string
  value: string
  px: number
  file: string
}

export interface TokenCandidates {
  colors: ColorTokenCandidate[]
  typography: SizeTokenCandidate[]
  spacing: SizeTokenCandidate[]
  /** Declared custom properties that didn't classify into any of the above — informational only, never applied. */
  otherCount: number
}

// ---------------------------------------------------------------------------
// :root custom-property extraction
// ---------------------------------------------------------------------------

/** Strips `/* … *\/` block comments — run before scanning so a commented-out `:root` or `--var` never matches. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * True when one comma-separated selector segment is a recognized "global
 * token host" — `:root`, `html`, or either wrapped in a single `:where(...)`/
 * `:is(...)` (the low-specificity pattern real design-token packages
 * increasingly use — e.g. open-props ships every token under
 * `:where(html)`, not `:root`). Exact/near-exact match on the trimmed
 * segment, NOT a substring test, so a class like `.html-embed` never
 * false-positives.
 */
function isGlobalHostSelectorSegment(segment: string): boolean {
  const trimmed = segment.trim().toLowerCase()
  if (/^:root(\[[^\]]*\])?$/.test(trimmed)) return true
  if (/^html(\[[^\]]*\])?$/.test(trimmed)) return true
  const wrapped = /^:(?:where|is)\(\s*(.+?)\s*\)$/.exec(trimmed)
  if (wrapped) return wrapped[1] === ':root' || wrapped[1] === 'html'
  return false
}

/**
 * Finds every top-level rule block whose selector is (or includes, in a
 * comma-separated list) a recognized global token host — see
 * `isGlobalHostSelectorSegment` — and returns the `{ … }` body of each. Brace-
 * depth counting (not a single regex) so a host selector nested inside a
 * `@media (...)` wrapper is still found, and a block containing nested
 * `@supports`/`@media` sub-blocks doesn't truncate at the first inner `}`.
 */
function findRootBlockBodies(css: string): string[] {
  const bodies: string[] = []
  const len = css.length
  let i = 0
  while (i < len) {
    const brace = css.indexOf('{', i)
    if (brace === -1) break
    const selector = css.slice(i, brace)
    const isHost = selector.split(',').some(isGlobalHostSelectorSegment)

    // Find this block's matching closing brace via depth-counting — this
    // always advances `i` past the WHOLE block, never just its opening `{`.
    // Skipping only past `{` would leave the skipped block's own body +
    // closing `}` inside the NEXT selector slice, corrupting it.
    let depth = 1
    let j = brace + 1
    while (j < len && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    if (isHost) {
      bodies.push(css.slice(brace + 1, j - 1))
    } else {
      // Not a host itself, but it may be a WRAPPER around one (e.g. a
      // `@media (...) { :root { … } }` block) — recurse into its body rather
      // than discarding it outright.
      bodies.push(...findRootBlockBodies(css.slice(brace + 1, j - 1)))
    }
    i = j
  }
  return bodies
}

const CUSTOM_PROP_RE = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g

/** Extracts every `--name: value;` declaration from every global-token-host block in `css` (see `isGlobalHostSelectorSegment`). */
export function extractRootCustomProperties(css: string, file: string): ExtractedCssVar[] {
  const cleaned = stripCssComments(css)
  const out: ExtractedCssVar[] = []
  for (const body of findRootBlockBodies(cleaned)) {
    let match: RegExpExecArray | null
    CUSTOM_PROP_RE.lastIndex = 0
    while ((match = CUSTOM_PROP_RE.exec(body)) !== null) {
      out.push({ name: match[1], value: match[2].trim(), file })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const COLOR_VALUE_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color)\(/i
const COLOR_NAME_HINT_RE = /color|background|border|accent|surface|foreground|fg\b|\bbg\b/i
const TYPOGRAPHY_NAME_HINT_RE = /font|text|type|leading|tracking|heading/i
const SPACING_NAME_HINT_RE = /space|spacing|gap\b|padding|margin|radius|size|width|height|inset/i

/**
 * Length units this import can safely convert to a plain px number.
 * `rem`/`em` are converted against the standard 16px browser default — NOT
 * this project's own `FrameworkPreferencesSettings.rootFontSize` (which
 * defaults to 10 and only governs how THIS app emits its own generated
 * clamp()/rem output; it has no bearing on what "1rem" means in someone
 * else's source CSS). `%`, `vh`, `vw`, `ch`, `vmin`, `vmax` are context-
 * dependent and are deliberately NOT converted — those candidates are
 * excluded from the size lists entirely rather than guessed at.
 */
const REM_EM_TO_PX = 16
const PT_TO_PX = 96 / 72

const LENGTH_RE = /^(-?\d*\.?\d+)(px|rem|em|pt)$/i

/** Converts a CSS length to a plain px number, or `null` if the unit isn't safely convertible (or the value isn't a length at all). */
export function convertLengthToPx(value: string): number | null {
  const match = LENGTH_RE.exec(value.trim())
  if (!match) return null
  const amount = Number.parseFloat(match[1])
  if (!Number.isFinite(amount)) return null
  const unit = match[2].toLowerCase()
  if (unit === 'px') return amount
  if (unit === 'rem' || unit === 'em') return amount * REM_EM_TO_PX
  if (unit === 'pt') return amount * PT_TO_PX
  return null
}

/**
 * Classifies one `--name: value` pair. Name hints are checked first — a var
 * named `--brand-color: var(--gray-900)` should classify as a color even
 * though its value is a reference, not a literal — falling back to shape-of-
 * value detection when the name gives no hint.
 */
export function classifyToken(name: string, value: string): TokenCategory {
  const trimmed = value.trim()
  if (COLOR_NAME_HINT_RE.test(name) || COLOR_VALUE_RE.test(trimmed)) return 'color'
  if (TYPOGRAPHY_NAME_HINT_RE.test(name)) return convertLengthToPx(trimmed) !== null ? 'typography' : 'other'
  if (SPACING_NAME_HINT_RE.test(name)) return convertLengthToPx(trimmed) !== null ? 'spacing' : 'other'
  // No name hint — fall back to value shape: a plain convertible length reads
  // as spacing (the more common bare-number use in a design-token sheet);
  // typography sizes without a name hint are rare enough to not guess at.
  if (convertLengthToPx(trimmed) !== null) return 'spacing'
  return 'other'
}

// ---------------------------------------------------------------------------
// JSON token extraction
// ---------------------------------------------------------------------------

/**
 * True for a DTCG-ish ("Design Tokens Community Group") leaf object —
 * `{ "value": "#fff", "type": "color" }` — the de-facto convention most
 * JSON token files (Style Dictionary, Tokens Studio, …) use instead of a
 * bare literal.
 */
function isDtcgLeaf(value: unknown): value is { value: string | number; type?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = (value as Record<string, unknown>).value
  return typeof v === 'string' || typeof v === 'number'
}

/**
 * Recursively walks a parsed JSON value, collecting every string/number leaf
 * as a candidate token — `name` is the dot-joined path (e.g.
 * `colors.brand.500`), which then runs through the SAME `classifyToken`
 * heuristic as a CSS custom property name. A DTCG-style `{value, type}` leaf
 * folds its `type` into the classified name (e.g. `color colors.brand.500`)
 * so a file that already declares "this is a color" gets that signal too,
 * without inventing a parallel type-hint system.
 */
export function extractJsonTokens(value: unknown, file: string, path: string[] = []): ExtractedCssVar[] {
  if (isDtcgLeaf(value)) {
    const name = [value.type, ...path].filter(Boolean).join(' ')
    return [{ name, value: String(value.value), file }]
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return path.length === 0 ? [] : [{ name: path.join('.'), value: String(value), file }]
  }
  if (Array.isArray(value)) return [] // token files don't meaningfully nest into arrays
  if (typeof value === 'object' && value !== null) {
    const out: ExtractedCssVar[] = []
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(...extractJsonTokens(child, file, [...path, key]))
    }
    return out
  }
  return []
}

// ---------------------------------------------------------------------------
// JS/TS token extraction (text-only — the source is never parsed as code,
// let alone executed)
// ---------------------------------------------------------------------------

/**
 * Strips `//` line comments and `/* … *\/` block comments from JS/TS source.
 * Deliberately simple (doesn't understand string literals containing `//`)
 * — acceptable here because the only thing this feeds into is a regex
 * looking for quoted string VALUES; a `//` inside a string just shortens
 * that one match's scan window, it doesn't corrupt anything else.
 */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const JS_STRING_ENTRY_RE = /(?:^|[{,])\s*(?:['"]?)([A-Za-z0-9_$-]+)(?:['"]?)\s*:\s*(['"])((?:(?!\2)[^\\\n]|\\.)*)\2/g

/**
 * Extracts `key: 'string value'` / `key: "string value"` pairs from JS/TS
 * source text — NOT a JS parser, and the source is never evaluated. This
 * only recognizes the simplest, most common token-file shape: a flat or
 * nested plain-object literal whose leaves are quoted strings (colors,
 * dimensions with units, font stacks). Computed keys, template literals,
 * spreads, and non-string (numeric/expression) values are not extracted —
 * acceptable because `classifyToken` still filters the result: a match on
 * unrelated code (e.g. `className: 'foo'`) simply won't look like a color or
 * length and lands in "other", same safety net the CSS path relies on.
 */
export function extractJsTokens(source: string, file: string): ExtractedCssVar[] {
  const cleaned = stripJsComments(source)
  const out: ExtractedCssVar[] = []
  let match: RegExpExecArray | null
  JS_STRING_ENTRY_RE.lastIndex = 0
  while ((match = JS_STRING_ENTRY_RE.exec(cleaned)) !== null) {
    out.push({ name: match[1], value: match[3].trim(), file })
  }
  return out
}

// ---------------------------------------------------------------------------
// Aggregate candidate list across every fetched file
// ---------------------------------------------------------------------------

let candidateIdCounter = 0
function nextCandidateId(): string {
  candidateIdCounter += 1
  return `design-import-${Date.now()}-${candidateIdCounter}`
}

/**
 * Scans every fetched source file — CSS via its `:root`-ish custom
 * properties, JSON/JS/TS token files (`isCandidateTokenFile`) via their own
 * extractors — classifies each declaration, and returns de-duplicated
 * candidate lists (later files win on a `name` collision — matches "last one
 * wins" cascade intuition for same-named tokens across multiple files).
 * `cssFiles` and `tokenFiles` are scanned identically past this point; they're
 * only kept apart upstream because CSS files are also eligible for
 * project copy-back and token files are not (see `FetchedSource`'s doc).
 */
export function buildTokenCandidates(
  cssFiles: ReadonlyArray<{ relPath: string; contents: string }>,
  tokenFiles: ReadonlyArray<{ relPath: string; contents: string }> = [],
): TokenCandidates {
  const byName = new Map<string, ExtractedCssVar>()
  for (const file of cssFiles) {
    for (const v of extractRootCustomProperties(file.contents, file.relPath)) {
      byName.set(v.name, v)
    }
  }
  for (const file of tokenFiles) {
    const isJson = file.relPath.toLowerCase().endsWith('.json')
    let vars: ExtractedCssVar[]
    if (isJson) {
      let parsed: unknown
      try {
        parsed = JSON.parse(file.contents)
      } catch {
        continue // malformed JSON — skip this file, not the whole import
      }
      vars = extractJsonTokens(parsed, file.relPath)
    } else {
      vars = extractJsTokens(file.contents, file.relPath)
    }
    for (const v of vars) byName.set(v.name, v)
  }

  const colors: ColorTokenCandidate[] = []
  const typography: SizeTokenCandidate[] = []
  const spacing: SizeTokenCandidate[] = []
  let otherCount = 0

  for (const v of byName.values()) {
    const category = classifyToken(v.name, v.value)
    if (category === 'color') {
      colors.push({ id: nextCandidateId(), name: v.name, value: v.value, file: v.file })
    } else if (category === 'typography') {
      const px = convertLengthToPx(v.value)
      if (px !== null) typography.push({ id: nextCandidateId(), name: v.name, value: v.value, px, file: v.file })
      else otherCount += 1
    } else if (category === 'spacing') {
      const px = convertLengthToPx(v.value)
      if (px !== null) spacing.push({ id: nextCandidateId(), name: v.name, value: v.value, px, file: v.file })
      else otherCount += 1
    } else {
      otherCount += 1
    }
  }

  return { colors, typography, spacing, otherCount }
}
