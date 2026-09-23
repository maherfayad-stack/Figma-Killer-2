/**
 * projectTokenIndex — the project's CSS custom properties, indexed so a
 * MEASURED value (a hex read out of a design, a type size in CSS px) can be
 * answered with the token name that already carries it.
 *
 * ## Why this exists
 *
 * The Studio prompt is unambiguous: "A colour, radius, font size or spacing
 * that a token covers is written var(--token), never a raw hex or a
 * hard-coded px." It is a rule the agent could not follow, because the two
 * halves were never connected. `studio_list_tokens` answers "what tokens
 * exist"; nothing answered "which token IS this value". So the agent picked
 * tokens BY NAME — `--type-headline-size` for a screen title, because
 * "headline" sounds like a heading — and on a real project that put a 26px
 * token where the design drew ~21px, on every screen, consistently too
 * large. Selecting by name skews big for exactly the reason it feels right.
 *
 * `studio_measure_reference` measures the design and asks this index what the
 * measurement is called, so "the heading is 21px" becomes "that is
 * --type-title-size (18px), or no token at all — say so".
 *
 * ## Where the values come from
 *
 * The same CSS the CANVAS gets, not a second source of truth — collected in
 * ONE place, `projectTokenSources.ts`'s `collectProjectTokenSources`, which
 * every caller of this module goes through: Studio's built-in design-system
 * sheet for a DS-backed project, the package stylesheets `compileProjectStyles`
 * reached through a bare-specifier import (`vendorCss`), its compiled CSS
 * Modules and Sass/PostCSS/Tailwind output (`css`), and the global stylesheets
 * the app's entry module imports (`src/index.css` — where a Vite app keeps its
 * tokens). A token that is not in the CSS the canvas loads is not a token the
 * agent can use, so indexing anything else would produce confident advice
 * that renders as nothing.
 *
 * Two views over those sources live here, and they share one scan:
 * {@link buildProjectTokenIndex} (value → token name, for measurement
 * matching) and {@link listProjectTokens} (every token with its dark value,
 * family and declaring `file:line`, for `studio_list_tokens`).
 *
 * Deliberately NOT sourced from `.studio/framework.json`: that store holds
 * Studio's OWN generated framework scale (`--text-xs`…`--text-4xl`), which is
 * a different scale from the design system's, and offering both would answer
 * "which token is #0C9AB0" with two names from two systems. (`studio_list_tokens`
 * used to read exactly that file, and on every real project it answered with
 * an empty palette — AI-4.)
 *
 * ## One scanner, not two (`STUDIO-FIGMA-PARITY-PLAN.md` §11, T12)
 *
 * This index used to carry its own `:root`-only regex scan, its own
 * hex-only colour parser, and its own bare-`px`-only length parser — three
 * ways this module could name a token `tokenExtractCssScan.ts`'s scan (the
 * picker's own source) would disagree with: a `@layer`/colour-scheme-`@media`
 * -nested declaration was invisible here, `hsl(...)`/`rgb(...)` tokens were
 * invisible here, and `rem`/`em` tokens were refused outright here while the
 * picker resolved them at a 16px root. The agent could measure a value and
 * name a token the picker never offered, and vice versa.
 *
 * It now shares the SAME scan and resolution primitives —
 * `collectRootScopeMaps` (at-rule descent, dark-selector recognition),
 * `resolveVarValue` (bounded, cycle-safe, not one-level), `toPx`
 * (`rem`/`em`/`pt`, not `px`-only) — and colour detection now goes through
 * `cssColorToRgb` (hex + `rgb()`/`rgba()` + `hsl()`/`hsla()`, not hex-only).
 * `nearestSizeToken`/`rgbToHex` stay here as the ranking helpers this
 * module's own callers (`referenceMeasure.ts`) need; they are not scan logic.
 */
import { cssColorToRgb, rgbToHex, type DesignTokenFamily, type Rgb } from '@core/design-tokens'
import {
  classifyDesignTokenFamily,
  collectRootScopeDeclarations,
  collectRootScopeMaps,
  detectRootFontSizePx,
  resolveVarValue,
  toPx,
  type ScopedDeclaration,
} from './tokenExtractCssScan'

export { rgbToHex }

/** A custom property whose value is a colour. */
export interface ColorTokenEntry {
  /** Property name including the leading dashes, e.g. `--color-aqua-100`. */
  readonly name: string
  /** Normalised lowercase 6-digit hex, e.g. `#0c9ab0`. */
  readonly hex: string
  readonly rgb: Rgb
}

/** A custom property whose value is a pixel length. */
export interface SizeTokenEntry {
  readonly name: string
  readonly px: number
}

export interface ProjectTokenIndex {
  readonly colors: readonly ColorTokenEntry[]
  /** Every px-valued custom property whose name reads as a font size (`*-size`, `*-font-size`, `--text-*`). */
  readonly fontSizes: readonly SizeTokenEntry[]
  /** Every other px-valued custom property — spacing, radius, and anything else a design measurement might land on. */
  readonly lengths: readonly SizeTokenEntry[]
}

/** A name that reads as a font size rather than a spacing or radius. */
const FONT_SIZE_NAME_RE = /(^--text-)|(-size$)|(font-size)/i
/** Names whose `-size` suffix is NOT type — a radius or an icon box would otherwise be offered as a font size. */
const NON_TYPE_SIZE_NAME_RE = /(radius|rounded|icon|avatar|space|spacing|gap|border|width|height)/i

/** Bound the scan so a pathological stylesheet cannot dominate a chat turn. Far above any real token set. */
const MAX_TOKENS_PER_KIND = 600

/**
 * Build the index from raw CSS text. Takes the CSS rather than a `dir` so the
 * caller decides which stylesheets count (and so this stays testable without
 * a project on disk).
 *
 * Last declaration wins, matching the cascade for two `:root` blocks that
 * declare the same property — the design system's own `dist/index.css` and a
 * project's `styles/imported/` copy of the same tokens routinely both appear.
 * Only LIGHT values are indexed — a static design reference has no dark-mode
 * concept to measure against, so there is nothing for a dark value to answer.
 */
export function buildProjectTokenIndex(...cssSources: readonly string[]): ProjectTokenIndex {
  const light = new Map<string, string>()
  // First source with an explicit `html`/`:root { font-size }` wins — the
  // same "first, then last-declaration-wins for names" precedent this
  // function already applies; in practice at most one source declares this.
  let rootFontSizePx: number | undefined
  for (const css of cssSources) {
    if (!css) continue
    for (const [name, raw] of collectRootScopeMaps(css).light) light.set(name, raw)
    if (rootFontSizePx === undefined) {
      const detected = detectRootFontSizePx(css)
      if (detected !== 16) rootFontSizePx = detected
    }
  }

  const colors: ColorTokenEntry[] = []
  const fontSizes: SizeTokenEntry[] = []
  const lengths: SizeTokenEntry[] = []

  for (const [name, rawValue] of light) {
    const value = resolveVarValue(rawValue, light)

    const rgb = cssColorToRgb(value)
    if (rgb) {
      if (colors.length < MAX_TOKENS_PER_KIND) colors.push({ name, hex: rgbToHex(rgb), rgb })
      continue
    }

    const px = toPx(value, rootFontSizePx ?? 16)
    if (px !== null) {
      const entry: SizeTokenEntry = { name, px }
      const isType = FONT_SIZE_NAME_RE.test(name) && !NON_TYPE_SIZE_NAME_RE.test(name)
      const bucket = isType ? fontSizes : lengths
      if (bucket.length < MAX_TOKENS_PER_KIND) bucket.push(entry)
    }
  }

  fontSizes.sort((a, b) => a.px - b.px)
  lengths.sort((a, b) => a.px - b.px)
  return { colors, fontSizes, lengths }
}

/**
 * The token closest to a measured size, with the signed error in px.
 *
 * Returns the nearest entry even when it is a poor match — the CALLER decides
 * what counts as close enough, and reporting "nearest is --type-title-size,
 * 3px away" is strictly more useful than reporting nothing. `null` only when
 * there are no candidates at all.
 */
export function nearestSizeToken(
  candidates: readonly SizeTokenEntry[],
  px: number,
): { token: SizeTokenEntry; deltaPx: number } | null {
  let best: { token: SizeTokenEntry; deltaPx: number } | null = null
  for (const token of candidates) {
    const deltaPx = Math.round((token.px - px) * 100) / 100
    if (best === null || Math.abs(deltaPx) < Math.abs(best.deltaPx)) best = { token, deltaPx }
  }
  return best
}

// ---------------------------------------------------------------------------
// The listing — every token, with where it is declared (`studio_list_tokens`)
// ---------------------------------------------------------------------------

/**
 * One stylesheet the canvas loads, as the token listing reads it. Produced by
 * `projectTokenSources.ts` (which does the I/O); this module stays pure.
 */
export interface TokenCssSource {
  /** How the file is named to the agent: a project-relative path, a package stylesheet specifier, Studio's own copy, or the compiler for compiled output. */
  readonly file: string
  /**
   * `project` — a file in the user's repo; its lines are its own.
   * `package` — a stylesheet a dependency ships (`node_modules`); read-only.
   * `studio-design-system` — Studio's built-in design system copy the canvas renders from; read-only.
   * `compiled` — Sass/PostCSS/Tailwind OUTPUT; its lines point at nothing a person edits, so no line is reported.
   */
  readonly origin: 'project' | 'package' | 'studio-design-system' | 'compiled'
  readonly css: string
}

/** The coarse families the agent picks by. Type tokens also carry a `role`. */
export type TokenFamily = 'color' | 'type' | 'space' | 'radius' | 'shadow' | 'other'

/** Listing order — what an agent building a screen reaches for first. */
export const TOKEN_FAMILIES: readonly TokenFamily[] = ['color', 'type', 'space', 'radius', 'shadow', 'other']

type TypeRole = Extract<DesignTokenFamily, 'font-family' | 'font-size' | 'font-weight' | 'line-height' | 'letter-spacing'>

export interface ListedToken {
  /** Property name including the leading dashes — what goes inside `var()`. */
  readonly name: string
  /** The light (default) value with every `var()` chain resolved — the value the canvas actually paints. */
  readonly value: string
  /** The dark-scheme value, resolved, only when the project declares one that differs. */
  readonly dark?: string
  /** The token this one is an alias of, when its declaration is exactly `var(--other)`. */
  readonly aliasOf?: string
  readonly family: TokenFamily
  /** For `type` tokens: which typographic property the value is for. */
  readonly role?: TypeRole
  /** The stylesheet whose declaration wins the cascade — its {@link TokenCssSource.file}. */
  readonly file: string
  /** 1-based line of that declaration; `null` for compiled output, whose lines point at nothing a person edits. */
  readonly line: number | null
  readonly origin: TokenCssSource['origin']
}

const VAR_ALIAS_RE = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/

function familyOf(designFamily: DesignTokenFamily | 'unclassified'): { family: TokenFamily; role?: TypeRole } {
  switch (designFamily) {
    case 'color':
    case 'space':
    case 'radius':
      return { family: designFamily }
    case 'elevation':
      return { family: 'shadow' }
    case 'font-family':
    case 'font-size':
    case 'font-weight':
    case 'line-height':
    case 'letter-spacing':
      return { family: 'type', role: designFamily }
    case 'unclassified':
      return { family: 'other' }
  }
}

/** 1-based line of `offset` in `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

interface Located {
  readonly declaration: ScopedDeclaration
  readonly source: TokenCssSource
}

/**
 * Every CSS custom property the given stylesheets declare at the document
 * root, in cascade order (a later source overrides an earlier one, exactly as
 * {@link buildProjectTokenIndex} and the canvas treat them), each with its
 * resolved value, its dark value where one differs, its family, and the
 * `file:line` of the declaration that actually wins.
 *
 * Same scan as the index above (`collectRootScopeDeclarations` is the
 * position-keeping form of `collectRootScopeMaps`), so the listing and the
 * token a measurement is matched to can never disagree about what a token's
 * value is. Sorted by family ({@link TOKEN_FAMILIES}), then by name.
 */
export function listProjectTokens(sources: readonly TokenCssSource[]): ListedToken[] {
  const light = new Map<string, Located>()
  const dark = new Map<string, Located>()
  for (const source of sources) {
    if (!source.css) continue
    const declarations = collectRootScopeDeclarations(source.css)
    for (const [name, declaration] of declarations.light) light.set(name, { declaration, source })
    for (const [name, declaration] of declarations.dark) dark.set(name, { declaration, source })
  }

  const lightRaw = new Map([...light].map(([name, located]) => [name, located.declaration.raw]))
  const darkRaw = new Map([...lightRaw, ...[...dark].map(([name, located]) => [name, located.declaration.raw] as const)])

  const listed: ListedToken[] = []
  for (const name of new Set([...light.keys(), ...dark.keys()])) {
    const winner = light.get(name) ?? dark.get(name)!
    const value = light.has(name) ? resolveVarValue(winner.declaration.raw, lightRaw) : resolveVarValue(winner.declaration.raw, darkRaw)
    // Resolved against the dark map even when THIS token has no dark
    // declaration of its own: an alias of a token that changes in dark mode
    // paints differently in dark mode too.
    const darkValue = light.has(name) ? resolveVarValue(darkRaw.get(name)!, darkRaw) : undefined
    const alias = VAR_ALIAS_RE.exec(winner.declaration.raw)?.[1]
    const { family, role } = familyOf(classifyDesignTokenFamily(name, value))
    listed.push({
      name,
      value,
      ...(darkValue !== undefined && darkValue !== value ? { dark: darkValue } : {}),
      ...(alias ? { aliasOf: alias } : {}),
      family,
      ...(role ? { role } : {}),
      file: winner.source.file,
      line: winner.source.origin === 'compiled' ? null : lineAt(winner.source.css, winner.declaration.offset),
      origin: winner.source.origin,
    })
  }

  const rank = new Map(TOKEN_FAMILIES.map((family, index) => [family, index]))
  return listed.sort((a, b) => rank.get(a.family)! - rank.get(b.family)! || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
