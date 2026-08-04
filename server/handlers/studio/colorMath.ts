/**
 * colorMath — parsing and PERCEPTUAL comparison of colours, for measuring a
 * design reference against a project's tokens.
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

/** `#rgb`, `#rrggbb`, and `#rrggbbaa` (alpha parsed and discarded — a token's opacity is not a colour difference). Returns `null` for anything else, including `rgb()`/`hsl()`/`currentColor`. */
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

/** WCAG 2.x contrast ratio, 1–21. Reported alongside a measured foreground/background pair so an agent can see when a design's own contrast is the thing it is reproducing. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}
