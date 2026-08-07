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
 * The same CSS the CANVAS gets, not a second source of truth:
 * `compileProjectStyles` already produces `vendorCss` (package stylesheets
 * reached through a bare-specifier import — the design system's own
 * `dist/index.css`) and `css` (the project's own compiled stylesheets,
 * including any `styles/imported/` token files). Both are scanned for custom
 * property declarations. A token that is not in the CSS the canvas loads is
 * not a token the agent can use, so indexing anything else would produce
 * confident advice that renders as nothing.
 *
 * Deliberately NOT sourced from `.studio/framework.json`: that store holds
 * Studio's OWN generated framework scale (`--text-xs`…`--text-4xl`), which is
 * a different scale from the design system's, and offering both would answer
 * "which token is #0C9AB0" with two names from two systems.
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
import { cssColorToRgb, rgbToHex, type Rgb } from '@core/design-tokens'
import { collectRootScopeMaps, detectRootFontSizePx, resolveVarValue, toPx } from './tokenExtractCssScan'

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
