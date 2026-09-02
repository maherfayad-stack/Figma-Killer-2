/**
 * colorMath — parsing and PERCEPTUAL comparison of colours, for measuring a
 * design reference against a project's tokens, and (T9,
 * `STUDIO-FIGMA-PARITY-PLAN.md` §11) for a live AA/AAA contrast badge in the
 * colour picker.
 *
 * Moved here from `server/handlers/studio/colorMath.ts` — it was pure and
 * imported nothing Node-specific, but lived under `server/` where the
 * browser bundle could never reach it. `contrastRatio` had exactly two
 * consumers, both server-side (`referenceMeasure.ts`, `qualityAudit.ts`);
 * **zero** imports from `src/`, so no AA/AAA badge existed anywhere a human
 * could see it. This module is now the ONE implementation both sides share
 * — server code imports it the same way (`@core/design-tokens`), nothing
 * forked.
 *
 * ## Why perceptual, and not RGB distance
 *
 * The question this supports is "is the colour in this design the same colour
 * as this token, or a different one?" — and plain RGB distance answers it
 * wrongly in exactly the region that matters. Euclidean distance in RGB
 * treats a channel step in dark blue as equal to the same step in bright
 * green, so a near-black and a true black read as far apart while two clearly
 * different mid-greens read as close. The result is a tool that confidently
 * reports the wrong token name, which is worse than reporting none.
 *
 * CIE76 ΔE over CIELAB is the cheapest metric that is approximately uniform:
 * one unit is roughly one just-noticeable difference. Its known weakness is
 * saturated colours (where CIEDE2000 is better), but that costs a great deal
 * more arithmetic to move a threshold that is already being reported as a
 * number the caller can judge. The rule of thumb this file is calibrated
 * against: ΔE < 1 is invisible, < 2.3 is the classic JND, < 5 reads as "the
 * same colour, slightly off", and above ~10 is a different colour.
 *
 * D65, 2° observer — the sRGB standard illuminant, so a hex sampled from a
 * PNG and a hex written in a stylesheet are compared in the same space.
 */

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** `#rgb`, `#rrggbb`, and `#rrggbbaa` (alpha parsed and discarded — a token's opacity is not a colour difference). Returns `null` for anything else, including `rgb()`/`hsl()`/`currentColor`. Prefer `cssColorToRgb` for a value of unknown syntax. */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().toLowerCase()
  if (!hex.startsWith('#')) return null
  const digits = hex.slice(1)
  if (!/^[0-9a-f]+$/.test(digits)) return null

  if (digits.length === 3 || digits.length === 4) {
    return {
      r: parseInt(digits[0]! + digits[0]!, 16),
      g: parseInt(digits[1]! + digits[1]!, 16),
      b: parseInt(digits[2]! + digits[2]!, 16),
    }
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    }
  }
  return null
}

/** `hsl(h s% l%)`/`hsl(h, s%, l%)`, degrees + percentages only (no `hsla()` alpha channel affects RGB — alpha is discarded, same as `parseHexColor`). Returns `null` for anything that doesn't match exactly. */
function parseHslColor(value: string): Rgb | null {
  const m = /^hsla?\(\s*(-?\d*\.?\d+)(?:deg)?\s*[, ]\s*(\d*\.?\d+)%\s*[, ]\s*(\d*\.?\d+)%(?:\s*[,/]\s*[^)]+)?\s*\)$/i.exec(
    value.trim(),
  )
  if (!m) return null
  const h = (((Number(m[1]) % 360) + 360) % 360) / 360
  const s = Math.min(1, Math.max(0, Number(m[2]) / 100))
  const l = Math.min(1, Math.max(0, Number(m[3]) / 100))
  if (s === 0) {
    const gray = Math.round(l * 255)
    return { r: gray, g: gray, b: gray }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hueToRgb = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return {
    r: Math.round(hueToRgb(h + 1 / 3) * 255),
    g: Math.round(hueToRgb(h) * 255),
    b: Math.round(hueToRgb(h - 1 / 3) * 255),
  }
}

/** `rgb(r g b)`/`rgb(r, g, b)`/`rgba(...)`, integer 0–255 channels or `%` channels. Alpha, if present, is discarded. `null` for anything else. */
function parseRgbFunction(value: string): Rgb | null {
  const m = /^rgba?\(\s*([^)]+)\)$/i.exec(value.trim())
  if (!m) return null
  const parts = m[1]!.split(/[,/\s]+/).filter(Boolean)
  if (parts.length < 3) return null
  const toChannel = (part: string): number | null => {
    if (part.endsWith('%')) {
      const pct = Number(part.slice(0, -1))
      return Number.isFinite(pct) ? Math.round((pct / 100) * 255) : null
    }
    const n = Number(part)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  const r = toChannel(parts[0]!)
  const g = toChannel(parts[1]!)
  const b = toChannel(parts[2]!)
  if (r === null || g === null || b === null) return null
  return { r: clampChannel(r), g: clampChannel(g), b: clampChannel(b) }
}

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, n))
}

/**
 * Parses ANY of the three CSS colour syntaxes design tokens actually use —
 * hex, `rgb()`/`rgba()`, `hsl()`/`hsla()` — to `Rgb`, or `null` when the
 * value is a `var()` reference, `currentColor`, a named colour, or anything
 * else this function does not recognise. Deliberately does not cover the
 * full CSS named-colour table or `oklch()`/`lab()`/`color()` — none of
 * those appear in the real-project token corpora this is calibrated
 * against; extending this list is additive and safe if a real project needs
 * it.
 */
export function cssColorToRgb(value: string): Rgb | null {
  const v = value.trim()
  return parseHexColor(v) ?? parseRgbFunction(v) ?? parseHslColor(v)
}

interface Lab {
  readonly l: number
  readonly a: number
  readonly b: number
}

/** sRGB companding — the gamma curve has to come off before any linear-light maths, or dark colours compare as far closer together than they look. */
function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** D65 white point, 2° observer. */
const WHITE_X = 0.95047
const WHITE_Y = 1
const WHITE_Z = 1.08883

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29
}

function rgbToLab({ r, g, b }: Rgb): Lab {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / WHITE_X
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb) / WHITE_Y
  const z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / WHITE_Z

  const fx = labF(x)
  const fy = labF(y)
  const fz = labF(z)

  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/**
 * CIE76 ΔE between two colours. ~0 is identical; see the module doc for how
 * to read the magnitude.
 */
export function colorDifference(a: Rgb, b: Rgb): number {
  const la = rgbToLab(a)
  const lb = rgbToLab(b)
  return Math.sqrt((la.l - lb.l) ** 2 + (la.a - lb.a) ** 2 + (la.b - lb.b) ** 2)
}

/** Relative luminance (WCAG), for deciding which of two dominant colours in a text region is the ink and which is the paper. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG 2.x contrast ratio, 1–21. Reported alongside a measured foreground/background pair so an agent (or a human, via the picker's AA/AAA badge) can see when a design's own contrast is the thing it is reproducing. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Lowercase `#rrggbb`. */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`
}

export type WcagContrastLevel = 'AAA' | 'AA' | 'fail'

/**
 * WCAG 2.x pass/fail bands for a contrast ratio — the badge `TokenizedColorField`
 * shows beside a colour option once a `backgroundColor` from the same style
 * bag is resolvable. Thresholds per the spec's 1.4.3/1.4.6: normal text is AA
 * at 4.5, AAA at 7; large text (≥ 24px, or ≥ 19px bold — WCAG's "18pt/14pt
 * bold") is AA at 3, AAA at 4.5.
 */
export function contrastLevel(ratio: number, isLargeText = false): WcagContrastLevel {
  const aaaThreshold = isLargeText ? 4.5 : 7
  const aaThreshold = isLargeText ? 3 : 4.5
  if (ratio >= aaaThreshold) return 'AAA'
  if (ratio >= aaThreshold) return 'AA'
  return 'fail'
}
