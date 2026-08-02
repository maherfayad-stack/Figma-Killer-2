/**
 * tokenExtractCssScan — the `:root` custom-property engine behind
 * `tokenExtract.ts`'s `project-css`/`vendor-css` sources: turns raw CSS text
 * into `ClassifiedTokens` (colors, spacing lengths, typography-size lengths,
 * plus honest counts of what didn't fit). Split out of `tokenExtract.ts`
 * purely to stay under the module-size-budget ceiling — this is one
 * coherent, self-contained concern (parse + resolve + classify), consumed by
 * both the CSS-text sources and, via its exported pieces, the Tailwind-theme
 * source (`tokenExtractTailwind.ts`) and the builder
 * (`tokenExtractBuild.ts`).
 *
 * ## Scanning — a brace-depth text scan, not a real CSS parser
 *
 * Mirrors `styleCompile.ts`'s `transformCssModuleText`: reading
 * `:root { --x: y }` out of CSS text needs no CSSOM, and this module must
 * stay Tier 0 (zero workspace code execution, zero extra runtime
 * dependency).
 *
 * Recursive into `@layer` (always) and a colour-scheme-only `@media` — real
 * design systems ship their dark palette (and, for Tailwind v4, their ENTIRE
 * token host) nested inside one of these two, and a scanner that only reads
 * unwrapped top-level rules sees none of it. `@alm-design/design-system`'s
 * own compiled CSS ships six `@media (prefers-color-scheme:dark){:root:not(
 * [data-theme=light]){…}}` blocks; Tailwind v4 emits its tokens as
 * `@layer theme{:root{…}}`. The recursion carries the nearest ancestor
 * `prefers-color-scheme` down: a global-token-host rule (`:root`/`html`/
 * `body`, see `isGlobalTokenHostSelector`) nested under
 * `prefers-color-scheme: dark` is DARK even when its own selector is a bare
 * `:root` that would otherwise read as light; nested under a `@layer` with
 * no colour-scheme prelude of its own, it classifies by its own selector
 * exactly as an unwrapped top-level rule would.
 *
 * Deliberately NOT recursive into anything else — any OTHER `@media`
 * (width/height/resolution/orientation/print/hover/…, or colour-scheme
 * combined with another feature via `and`/`,`), plus `@supports`,
 * `@container`, `@scope`, and anything unrecognised, is left exactly as
 * opaque as it always was (see `atRuleDescentContext`). This is not
 * laziness: a responsive `@media (min-width:900px){:root{--fs:48px}}`
 * override is NOT the canonical value of `--fs` — it's one breakpoint's
 * conditional override — and this scanner's whole contract is the
 * DEFAULT/canonical light and dark maps. Descending into it would let cascade
 * order silently clobber the real base value with whatever the widest
 * breakpoint (or a `@media print` block) happens to say, which is a
 * confidently WRONG value, strictly worse than the "missing" gap this module
 * otherwise tolerates. Recursion depth is bounded (`MAX_AT_RULE_DEPTH`) so
 * pathological/hostile `@layer` nesting can't run away — rules past the
 * ceiling are silently skipped, never a hang or a stack overflow. A handful
 * of known "dark" selector shapes (`:root[data-theme=dark]`, `:root.dark`,
 * `:root:not([data-theme=light])`, and now also the bare/non-`:root`-prefixed
 * forms `.dark`, `html.dark`, `[data-theme=dark]` — see `isDarkSelector`) are
 * recognised regardless of at-rule context.
 *
 * ## Classification — value first, name second
 *
 * A resolved value that parses as a color becomes a color token REGARDLESS
 * OF NAME. This matters concretely: a real design system's own semantic
 * aliases (`--text-base-default`, `--border-primary-hover`, …) read as
 * "typography"/"spacing" by name alone, but they are colors — `--text-*`
 * here means TEXT COLOR, not type scale. Checking the value first means
 * these classify correctly without a name-prefix denylist. Only once a
 * value is NOT a color does name-based classification apply:
 * `--space*|--gap*|--size*|--radius*` with a `px`/`rem`/`em` value ->
 * spacing; `--font*|--text*|--type*` -> a typography SIZE step when the
 * value is itself a bare length (or the name ends in `-size`), otherwise
 * typography DETAIL (family/weight/line-height/letter-spacing) — real, but
 * not representable in `FrameworkTypographyGroup` (see `tokenExtract.ts`'s
 * "Shape gap" doc), so it is counted, never guessed into the wrong shape.
 * Anything else is UNCLASSIFIED and counted — a wrong token is worse than a
 * missing one.
 *
 * `var(--other-token)` references are resolved (bounded depth, cycle-safe)
 * against the same `:root` scope before classification — most of a real
 * design system's semantic palette IS indirection (`--background-primary-
 * default: var(--color-aqua-100)`), so skipping resolution would silently
 * classify almost nothing as a color.
 *
 * ## Shared with `server/handlers/designImport/parseCssTokens.ts`
 *
 * This is now the ONE classification engine for both this module's own
 * `project-css`/`vendor-css` sources AND the manual "Import design tokens"
 * wizard (`designImport.ts`'s `buildTokenCandidates`) — `classifyDeclaration`,
 * `resolveVarValue`, `collectRootScopeMaps`, and `toPx` are exported for that
 * caller. Before this, `designImport`'s own `classifyToken` duplicated a
 * NAME-hint-first heuristic that never resolved `var()` — see that module's
 * doc comment for the (now historical) correctness gap this closed.
 *
 * ## Why this doesn't reuse `@core/siteImport`'s CSS-import color/font
 * extraction
 *
 * `extractRootColorTokens`/`extractRootFontTokens` (colorTokens.ts/
 * fontTokens.ts) already do a similar job for the CMS's own "Super Import"
 * wizard, and this module DOES reuse their leaf primitives — `isCssColorValue`
 * (the color-literal check) and `isRootScopeSelector` (`:root`/`html`/`body`
 * detection) — rather than re-implementing them. It does NOT reuse the two
 * extraction functions themselves: both explicitly decline any value that is
 * a `var(...)` reference ("meaningless as a standalone palette entry" — see
 * `colorTokens.ts`'s doc), which is correct for THAT caller (Super Import
 * flattens an arbitrary uploaded stylesheet into standalone tokens) but wrong
 * for this one, where resolving the indirection is most of the value (see
 * above). They also operate on already-parsed `NewStyleRule[]` from
 * `cssToStyleRules`'s happy-dom CSSOM pipeline, which this module avoids for
 * the same reason `transformCssModuleText` does: reading `:root { --x: y }`
 * declarations needs no real CSS parser.
 */
import { isCssColorValue, isRootScopeSelector } from '@core/siteImport'

// ---------------------------------------------------------------------------
// :root declaration scanning
// ---------------------------------------------------------------------------

interface CssRule {
  selector: string
  body: string
}

/**
 * Every rule at ONE level of `{ }` nesting in `css`, comment-aware — used
 * both for the outermost scan and, recursively, for the body of every
 * at-rule (`@media`/`@layer`/`@supports`) found at that level (see
 * `collectScopedRules`). An at-rule's own selector is the raw prelude text
 * (e.g. `@media (prefers-color-scheme:dark)`), always starting with `@`, and
 * its body is the untouched nested text — this function does not know or
 * care whether a rule is an at-rule; that decision lives in the caller.
 */
function scanRulesAtOneLevel(css: string): CssRule[] {
  const rules: CssRule[] = []
  let buffer = ''
  let i = 0
  const n = css.length
  while (i < n) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      buffer = ''
      continue
    }
    const ch = css[i]
    if (ch === '{') {
      const selector = buffer.trim()
      buffer = ''
      i++
      const bodyStart = i
      let depth = 1
      while (i < n && depth > 0) {
        if (css[i] === '/' && css[i + 1] === '*') {
          const end = css.indexOf('*/', i + 2)
          i = end === -1 ? n : end + 2
          continue
        }
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
        if (depth > 0) i++
      }
      const body = css.slice(bodyStart, i)
      i++ // consume the matching close brace
      if (selector.length > 0) rules.push({ selector, body })
      continue
    }
    if (ch === '}') {
      // A stray/unmatched close — resync rather than corrupting the rest of
      // the scan (or, one level down inside an at-rule body, the close of
      // that at-rule itself once its own scan of the body runs dry).
      buffer = ''
      i++
      continue
    }
    buffer += ch
    i++
  }
  return rules
}

const WRAPPED_HOST_RE = /^:(?:where|is)\(\s*(.+?)\s*\)$/i

/**
 * True when a selector targets the document root — `:root`/`html`/`body`
 * (via `isRootScopeSelector`), or a comma-separated list where AT LEAST ONE
 * segment does, optionally wrapped in a single `:where(...)`/`:is(...)` (the
 * low-specificity host pattern real design-token packages increasingly use
 * — e.g. open-props ships every token under `:where(html)`, not `:root`).
 * `.some`, not `.every`, on the comma split: `:root, [data-theme='dark']`
 * should still contribute its declarations even though the second segment
 * alone isn't root-scope.
 */
function isGlobalTokenHostSelector(selector: string): boolean {
  return selector.split(',').some((segment) => {
    const trimmed = segment.trim()
    if (isRootScopeSelector(trimmed)) return true
    const wrapped = WRAPPED_HOST_RE.exec(trimmed)
    return wrapped ? isRootScopeSelector(wrapped[1]!) : false
  })
}

/**
 * A selector shape that names dark mode explicitly, independent of any
 * `prefers-color-scheme` at-rule context: an OPTIONAL `:root`/`html`/`body`
 * host prefix (bare forms — `.dark`, `[data-theme=dark]` — are just as
 * common as `:root`-qualified ones in the wild) followed by exactly ONE dark
 * marker — a `[data-theme=dark]` attribute, a `.dark` class, or the
 * `:not([data-theme=light])` double-negative some design systems use to mean
 * "dark unless explicitly light". Anchored full-string (`^...$`) so a class
 * that merely CONTAINS "dark" (`.darkened`, `.dark-blue`) never matches —
 * there is no dangling text before or after the marker.
 */
const DARK_SELECTOR_RE = /^(?:html|body|:root)?(?:\[data-theme=["']?dark["']?\]|\.dark|:not\(\s*\[data-theme=["']?light["']?\]\s*\))$/i

/** `isDarkSelector`, unwrapped from a single `:where(...)`/`:is(...)` the same way `isGlobalTokenHostSelector` is — see that function's doc for why. */
function isDarkSelector(selector: string): boolean {
  const trimmed = selector.trim()
  if (DARK_SELECTOR_RE.test(trimmed)) return true
  const wrapped = WRAPPED_HOST_RE.exec(trimmed)
  return wrapped ? DARK_SELECTOR_RE.test(wrapped[1]!.trim()) : false
}

const DECLARATION_RE = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);?/g

function collectDeclarations(body: string, into: Map<string, string>): void {
  DECLARATION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DECLARATION_RE.exec(body))) {
    into.set(m[1]!, m[2]!.trim())
  }
}

export interface RootScopeMaps {
  light: Map<string, string>
  dark: Map<string, string>
}

/** `prefers-color-scheme` ambient context inherited while descending through at-rules — `null` means no ancestor at-rule declared one (today's top-level behavior applies: classify by the rule's own selector shape). */
type ColorSchemeContext = 'light' | 'dark' | null

/**
 * Recursion ceiling for at-rule descent (`@layer` can nest arbitrarily in
 * hostile/pathological input). A handful of real-world levels is normal;
 * this is generous while still bounding worst-case work to
 * O(`MAX_AT_RULE_DEPTH`) recursive calls — rules past the ceiling are
 * silently skipped, never a hang or a stack overflow.
 */
const MAX_AT_RULE_DEPTH = 32

/**
 * True only when the text after `@media` is EXACTLY one
 * `(prefers-color-scheme: dark|light)` feature — nothing else. This is
 * deliberately an exact match, not a substring test: a combined query like
 * `(min-width:900px) and (prefers-color-scheme:dark)` mentions dark
 * somewhere in its text but is still conditional on width, so its
 * declarations are a responsive breakpoint's OVERRIDE, not the canonical
 * dark value for a token — cascade order would otherwise let it silently
 * clobber the real base value the moment the widest breakpoint's `:root`
 * block is scanned. A comma-separated (OR) query is rejected for the same
 * reason: `(prefers-color-scheme:dark), (min-width:900px)` can also fire on
 * width alone.
 */
const COLOR_SCHEME_ONLY_MEDIA_RE = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i

function mediaColorSchemeOnly(preludeAfterAtMedia: string): ColorSchemeContext {
  const m = COLOR_SCHEME_ONLY_MEDIA_RE.exec(preludeAfterAtMedia.trim())
  return m ? (m[1]!.toLowerCase() as 'dark' | 'light') : null
}

const AT_LAYER_RE = /^@layer\b/i
const AT_MEDIA_RE = /^@media\b(.*)$/i

/**
 * Whether — and with what colour-scheme context — to descend into an
 * at-rule's body, or `undefined` to skip it entirely (treated exactly as
 * opaque as an unwrapped top-level scan always has — the safe default for
 * anything not explicitly recognised below as UNCONDITIONAL):
 *   - `@layer` (any form — named, anonymous, nested) is pure grouping with
 *     no conditionality of its own: always descend, inheriting `inherited`
 *     UNCHANGED. A `@layer` never introduces or resets a colour-scheme
 *     context; only a colour-scheme-only `@media` does that.
 *   - `@media` whose ENTIRE prelude is colour-scheme-only (see
 *     `mediaColorSchemeOnly`): descend with THAT scheme.
 *   - Every other `@media` — width/height/resolution/orientation/print/
 *     hover/…, or colour-scheme combined with anything else via `and`/`,` —
 *     plus `@supports`, `@container`, `@scope`, and anything unrecognised:
 *     `undefined`. These gate on something OTHER than (or in addition to)
 *     colour scheme, so their declarations are a conditional override, not
 *     the canonical light/dark value, and must never contaminate either map.
 */
function atRuleDescentContext(selector: string, inherited: ColorSchemeContext): ColorSchemeContext | undefined {
  const trimmed = selector.trim()
  if (AT_LAYER_RE.test(trimmed)) return inherited
  const media = AT_MEDIA_RE.exec(trimmed)
  if (media) {
    const scheme = mediaColorSchemeOnly(media[1]!)
    return scheme === null ? undefined : scheme
  }
  return undefined
}

/**
 * Recursively walks `css`, descending only into the UNCONDITIONAL at-rules
 * `atRuleDescentContext` recognises (`@layer`, and a colour-scheme-only
 * `@media`) — see that function's doc and the module doc for the
 * classification rule this implements. `light`/`dark` are mutated in place
 * (later declarations win on a name collision, matching cascade order, the
 * same as the non-recursive scan this replaces).
 */
function collectScopedRules(
  css: string,
  depth: number,
  colorScheme: ColorSchemeContext,
  light: Map<string, string>,
  dark: Map<string, string>,
): void {
  if (depth > MAX_AT_RULE_DEPTH) return
  for (const rule of scanRulesAtOneLevel(css)) {
    if (rule.selector.startsWith('@')) {
      const descendContext = atRuleDescentContext(rule.selector, colorScheme)
      if (descendContext !== undefined) collectScopedRules(rule.body, depth + 1, descendContext, light, dark)
      continue
    }
    if (colorScheme === 'dark') {
      if (isGlobalTokenHostSelector(rule.selector) || isDarkSelector(rule.selector)) collectDeclarations(rule.body, dark)
      continue
    }
    // `colorScheme === 'light'` and `colorScheme === null` (no ambient
    // context at all — today's top-level behavior) resolve identically: a
    // global host is light, a dark-shaped selector is still honoured even
    // inside a `prefers-color-scheme: light` block (an explicit `.dark`
    // override nested there is not a contradiction — it's a selector, not a
    // media feature).
    if (isGlobalTokenHostSelector(rule.selector)) collectDeclarations(rule.body, light)
    else if (isDarkSelector(rule.selector)) collectDeclarations(rule.body, dark)
  }
}

/** Builds the light/dark raw-declaration maps for every global-token-host (light — see `isGlobalTokenHostSelector`) and known dark-selector (dark) rule found in `css`, descending into `@layer` and colour-scheme-only `@media` at-rules (see module doc; `atRuleDescentContext` is the gate). Later declarations win on a name collision, matching cascade order. Exported for `designImport/parseCssTokens.ts`, which needs the raw (unresolved) light map to resolve `var()` chains itself before classifying. */
export function collectRootScopeMaps(css: string): RootScopeMaps {
  const light = new Map<string, string>()
  const dark = new Map<string, string>()
  collectScopedRules(css, 0, null, light, dark)
  return { light, dark }
}

// ---------------------------------------------------------------------------
// var() resolution — bounded, cycle-safe
// ---------------------------------------------------------------------------

const VAR_REF_RE = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/
const MAX_VAR_RESOLUTION_DEPTH = 8

/** Resolves `raw` through `map`'s `var(--x)` references to a leaf value. An unresolvable reference falls back to its `var(--x, fallback)` fallback text when present, else the unresolved `var(...)` text itself — never throws, never loops (depth + a per-call `seen` set catch both a too-long chain and a genuine cycle). Exported for `designImport/parseCssTokens.ts` (see module doc, "Shared with designImport"). */
export function resolveVarValue(raw: string, map: ReadonlyMap<string, string>, seen: Set<string> = new Set()): string {
  const trimmed = raw.trim()
  const m = VAR_REF_RE.exec(trimmed)
  if (!m) return trimmed
  const refName = m[1]!
  if (seen.has(refName) || seen.size >= MAX_VAR_RESOLUTION_DEPTH) return trimmed
  const refRaw = map.get(refName)
  if (refRaw === undefined) return (m[2] ?? trimmed).trim()
  seen.add(refName)
  return resolveVarValue(refRaw, map, seen)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const LENGTH_RE = /^-?\d*\.?\d+(px|rem|em|pt)$/
/**
 * Name hints — unanchored (`.test()` against the whole name, not a `--`
 * prefix match) so the SAME regex classifies both a CSS custom property name
 * (`--spacing-md`) and a bare JSON/JS token key with no `--` at all
 * (`spacing.md`, `fontSizeLg`) identically. Union of this module's original
 * (Studio's own `--space*|--gap*|--size*|--radius*` / `--font*|--text*|
 * --type*` convention) and `designImport`'s broader external-repo hint set
 * (`padding`/`margin`/`width`/`height`/`inset`/`leading`/`tracking`/
 * `heading`, plus `spacing` itself — `^--space` alone never matched
 * `--spacing-md`, a real gap for any corpus using the plural form).
 * Name hints are the FALLBACK, only consulted once `isCssColorValue` has
 * already ruled the resolved value out as a color — see `classifyDeclaration`.
 */
const SPACING_NAME_HINT_RE = /space|spacing|gap\b|padding|margin|radius|width|height|inset/i
const TYPOGRAPHY_NAME_HINT_RE = /font|text|type|leading|tracking|heading/i
/**
 * `size` names a measurement but NOT what is being measured, so unlike the
 * hints above it cannot decide a family on its own — the rest of the name
 * does. `--icon-size` is spacing; `--type-display-size` is a type step. It is
 * therefore consulted only AFTER the typography hint has had its turn, which
 * is why it is not folded into `SPACING_NAME_HINT_RE` (doing so made every
 * `--{font,text,type}-*-size` token classify as spacing, silently emptying the
 * typography ladder of any design system that suffixes its size steps).
 */
const GENERIC_SIZE_NAME_HINT_RE = /size/i
const TYPOGRAPHY_DETAIL_SUFFIX_RE = /-(weight|lh|line-height|ls|letter-spacing|family)$/i

export type Classification = 'color' | 'spacing' | 'typography-size' | 'typography-detail' | 'unclassified'

/**
 * Classifies one `name` + already-`var()`-resolved `resolved` value pair —
 * value first (a real color literal is ALWAYS a color, regardless of name),
 * name hint second (only once the value has failed the color check), no
 * "bare length with no name hint defaults to spacing" guess: an unclassified
 * token is reported honestly rather than guessed into the wrong family. The
 * single classification function behind both this module's CSS/Tailwind/
 * vendor-CSS sources and `designImport/parseCssTokens.ts`'s CSS/JSON/JS
 * sources.
 */
export function classifyDeclaration(name: string, resolved: string): Classification {
  if (isCssColorValue(resolved)) return 'color'
  // A hint that names a layout dimension outright wins over a typography hint
  // (`--heading-margin-block` is spacing, not type).
  if (SPACING_NAME_HINT_RE.test(name) && LENGTH_RE.test(resolved)) return 'spacing'
  if (TYPOGRAPHY_NAME_HINT_RE.test(name)) {
    if (TYPOGRAPHY_DETAIL_SUFFIX_RE.test(name)) return 'typography-detail'
    if (/-size$/i.test(name) || LENGTH_RE.test(resolved)) return 'typography-size'
    return 'typography-detail'
  }
  // Generic `size` last: only once no typography hint claimed the name.
  if (GENERIC_SIZE_NAME_HINT_RE.test(name) && LENGTH_RE.test(resolved)) return 'spacing'
  return 'unclassified'
}

/**
 * Parses a bare `px`/`rem`/`em`/`pt` length to a px number, or `null`.
 * `rem`/`em` are approximated against the standard 16px browser default —
 * this module has no way to know a project's own `html { font-size }`
 * override without a further scan, and the browser default is the correct
 * assumption for the overwhelming majority of real projects. `pt` converts
 * via the standard 96/72 (CSS px-per-inch over points-per-inch) ratio.
 */
export function toPx(value: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem|em|pt)$/.exec(value.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  if (m[2] === 'px') return n
  if (m[2] === 'pt') return n * (96 / 72)
  return n * 16 // rem/em
}

// ---------------------------------------------------------------------------
// ClassifiedTokens — the intermediate shape both CSS-text sources and the
// Tailwind theme source produce, before either is turned into real
// `FrameworkSettings` groups (`tokenExtractBuild.ts`).
// ---------------------------------------------------------------------------

export interface ClassifiedColor {
  name: string
  light: string
  dark?: string
}

export interface ClassifiedLength {
  name: string
  px: number
}

export interface ClassifiedTokens {
  colors: ClassifiedColor[]
  spacing: ClassifiedLength[]
  typographySizes: ClassifiedLength[]
  /** Real typography declarations (family/weight/line-height/letter-spacing) found but not representable in `FrameworkTypographyGroup` — counted, never guessed into the wrong shape. */
  typographyDetailCount: number
  unclassifiedCount: number
}

export function emptyClassifiedTokens(): ClassifiedTokens {
  return { colors: [], spacing: [], typographySizes: [], typographyDetailCount: 0, unclassifiedCount: 0 }
}

export function hasAnyTokens(t: ClassifiedTokens): boolean {
  return t.colors.length > 0 || t.spacing.length > 0 || t.typographySizes.length > 0
}

/** Classifies every `:root`-scope custom property found in `css` — the shared engine behind both the `project-css` and `vendor-css` sources (they differ only in which CSS text is handed in). */
export function classifyCssText(css: string): ClassifiedTokens {
  const result = emptyClassifiedTokens()
  if (!css) return result

  const { light, dark } = collectRootScopeMaps(css)
  if (light.size === 0) return result

  const darkMerged = dark.size > 0 ? new Map([...light, ...dark]) : undefined

  for (const [name, raw] of light) {
    const resolvedLight = resolveVarValue(raw, light)
    const kind = classifyDeclaration(name, resolvedLight)

    if (kind === 'color') {
      const darkRaw = dark.get(name)
      const resolvedDark = darkRaw !== undefined ? resolveVarValue(darkRaw, darkMerged!) : undefined
      result.colors.push({ name, light: resolvedLight, ...(resolvedDark !== undefined ? { dark: resolvedDark } : {}) })
      continue
    }
    if (kind === 'spacing') {
      const px = toPx(resolvedLight)
      if (px !== null) result.spacing.push({ name, px })
      else result.unclassifiedCount++
      continue
    }
    if (kind === 'typography-size') {
      const px = toPx(resolvedLight)
      if (px !== null) result.typographySizes.push({ name, px })
      else result.typographyDetailCount++ // e.g. a unitless `--text-lg: 1.25` — real, just not a px step
      continue
    }
    if (kind === 'typography-detail') {
      result.typographyDetailCount++
      continue
    }
    result.unclassifiedCount++
  }

  return result
}
