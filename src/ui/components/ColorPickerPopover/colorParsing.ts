/**
 * colorParsing — the boundary the colour picker sits on.
 *
 * `ColorPickerPopover` never renders a value it invented. Every value shown
 * on the saturation/value square, the hue rail, the alpha rail, or the
 * model text field is produced by parsing whatever CSS colour string the
 * caller handed it — `hex3` / `hex4` / `hex6` / `hex8`, `rgb()` / `rgba()`
 * (comma or space+slash syntax, integer or percentage channels), `hsl()` /
 * `hsla()` (same two syntaxes), and the 17 CSS Level 1 named colours
 * (`red`, `black`, `transparent`, …) this project's projects actually write.
 * `var(--token)` references are a different kind of value entirely — see
 * `isColorToken` — and are never handed to `parseCssColor`.
 *
 * **A value this module cannot parse returns `null`. It never falls back to
 * a guessed colour (`#000000`, `transparent`, …).** `ColorPickerPopover`
 * reads that `null` as "render the raw text unmodified, do not draw the
 * square" — the same "one honest write target" contract the gradient and
 * box-shadow parsers in the wider disclosure plan follow. Silently
 * rewriting a user's declaration into a normalised form we guessed is
 * exactly the kind of write this repository refuses.
 *
 * `Rgba` (integer 0-255 channels + 0-1 alpha) is the one pivot representation
 * every conversion goes through: `hsvaToRgba` / `rgbaToHsva` for the picker's
 * drag surfaces, `hslaToRgba` / `rgbaToHsla` for the HSL model field. Nothing
 * converts HSV directly to/from HSL — going through `Rgba` means there is
 * exactly one rounding policy, not two that can drift apart.
 */

export type ColorModel = 'hex' | 'rgb' | 'hsl'

export interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

export interface Hsva {
  readonly h: number
  readonly s: number
  readonly v: number
  readonly a: number
}

export interface Hsla {
  readonly h: number
  readonly s: number
  readonly l: number
  readonly a: number
}

export interface ParsedColor {
  readonly rgba: Rgba
  /** Which model tab the picker should show this value under initially. */
  readonly model: ColorModel
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function normalizeHue(value: number): number {
  return ((value % 360) + 360) % 360
}

// ---------------------------------------------------------------------------
// Token references — a `var(--x)` is not a colour this module parses; the
// caller resolves it to a real colour (or doesn't) before this module ever
// sees it. Exported so callers share one definition of "is this a token".
// ---------------------------------------------------------------------------

const TOKEN_RE = /^var\(\s*--[a-z0-9_-]+\s*\)$/i

export function isColorToken(value: string): boolean {
  return TOKEN_RE.test(value.trim())
}

// ---------------------------------------------------------------------------
// hex3 / hex4 / hex6 / hex8
// ---------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function parseHex(value: string): Rgba | null {
  const match = HEX_RE.exec(value.trim())
  if (!match) return null
  const digits = match[1]!
  const expand = (c: string) => parseInt(c.length === 1 ? c + c : c, 16)

  if (digits.length === 3) {
    return { r: expand(digits[0]!), g: expand(digits[1]!), b: expand(digits[2]!), a: 1 }
  }
  if (digits.length === 4) {
    return {
      r: expand(digits[0]!),
      g: expand(digits[1]!),
      b: expand(digits[2]!),
      a: round2(expand(digits[3]!) / 255),
    }
  }
  if (digits.length === 6) {
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: 1,
    }
  }
  // 8 digits
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
    a: round2(parseInt(digits.slice(6, 8), 16) / 255),
  }
}

// ---------------------------------------------------------------------------
// rgb() / rgba() — comma syntax and modern space+slash syntax, integer or
// percentage channels, alpha as a bare 0-1 number or a percentage.
// ---------------------------------------------------------------------------

const RGB_FUNCTION_RE = /^rgba?\(\s*([^)]+)\)$/i

function parseChannelToken(token: string): number | null {
  const t = token.trim()
  if (t === '') return null
  if (t.endsWith('%')) {
    const pct = Number(t.slice(0, -1))
    return Number.isFinite(pct) ? clamp(Math.round((pct / 100) * 255), 0, 255) : null
  }
  const n = Number(t)
  return Number.isFinite(n) ? clamp(Math.round(n), 0, 255) : null
}

function parseAlphaToken(token: string | undefined): number {
  if (token === undefined) return 1
  const t = token.trim()
  if (t === '') return 1
  if (t.endsWith('%')) {
    const pct = Number(t.slice(0, -1))
    return Number.isFinite(pct) ? clamp(round2(pct / 100), 0, 1) : 1
  }
  const n = Number(t)
  return Number.isFinite(n) ? clamp(round2(n), 0, 1) : 1
}

/** Splits a colour function's inner text into channel tokens + an optional alpha token, accepting both `a, b, c, d` and `a b c / d` syntax. */
function splitColorFunctionArgs(inner: string): { channels: string[]; alpha: string | undefined } {
  if (inner.includes(',')) {
    const parts = inner.split(',').map((p) => p.trim())
    const alpha = parts.length === 4 ? parts.pop() : undefined
    return { channels: parts, alpha }
  }
  const [channelPart, alphaPart] = inner.split('/')
  const channels = (channelPart ?? '').trim().split(/\s+/).filter(Boolean)
  return { channels, alpha: alphaPart?.trim() }
}

function parseRgbFunction(value: string): Rgba | null {
  const match = RGB_FUNCTION_RE.exec(value.trim())
  if (!match) return null
  const { channels, alpha } = splitColorFunctionArgs(match[1]!)
  if (channels.length !== 3) return null
  const r = parseChannelToken(channels[0]!)
  const g = parseChannelToken(channels[1]!)
  const b = parseChannelToken(channels[2]!)
  if (r === null || g === null || b === null) return null
  return { r, g, b, a: parseAlphaToken(alpha) }
}

// ---------------------------------------------------------------------------
// hsl() / hsla()
// ---------------------------------------------------------------------------

const HSL_FUNCTION_RE = /^hsla?\(\s*([^)]+)\)$/i

function parseHslFunction(value: string): Rgba | null {
  const match = HSL_FUNCTION_RE.exec(value.trim())
  if (!match) return null
  const { channels, alpha } = splitColorFunctionArgs(match[1]!)
  if (channels.length !== 3) return null

  const hToken = channels[0]!.replace(/deg$/i, '')
  const sToken = channels[1]!
  const lToken = channels[2]!
  if (!sToken.endsWith('%') || !lToken.endsWith('%')) return null

  const h = Number(hToken)
  const s = Number(sToken.slice(0, -1))
  const l = Number(lToken.slice(0, -1))
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null

  return hslaToRgba({ h: normalizeHue(h), s: clamp(s, 0, 100), l: clamp(l, 0, 100), a: parseAlphaToken(alpha) })
}

// ---------------------------------------------------------------------------
// Named colours — the CSS Level 1 keyword set plus `transparent`. Not the
// full CSS named-colour table (147 entries): these 17 are the ones real
// project stylesheets actually reach for by name (see `colorMath.ts`'s doc
// for the same "extend later if a real project needs it" stance).
// ---------------------------------------------------------------------------

const NAMED_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 255, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
}

function parseNamedColor(value: string): Rgba | null {
  const key = value.trim().toLowerCase()
  if (key === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const rgb = NAMED_COLORS[key]
  return rgb ? { r: rgb[0], g: rgb[1], b: rgb[2], a: 1 } : null
}

// ---------------------------------------------------------------------------
// Public parse entry point
// ---------------------------------------------------------------------------

/**
 * Parses a single CSS colour value. Returns `null` for anything this module
 * does not recognise — including `var()` references (use `isColorToken`
 * first), `currentColor`, `calc()` expressions, and any colour function this
 * module doesn't cover (`oklch()`, `lab()`, `color()`, …). Callers MUST NOT
 * substitute a default colour when this returns `null` — see the module doc.
 */
export function parseCssColor(value: string): ParsedColor | null {
  const v = value.trim()
  if (v === '') return null

  const hex = parseHex(v)
  if (hex) return { rgba: hex, model: 'hex' }

  const rgb = parseRgbFunction(v)
  if (rgb) return { rgba: rgb, model: 'rgb' }

  const hsl = parseHslFunction(v)
  if (hsl) return { rgba: hsl, model: 'hsl' }

  const named = parseNamedColor(v)
  if (named) return { rgba: named, model: 'hex' }

  return null
}

// ---------------------------------------------------------------------------
// Rgba <-> Hsva (the picker's drag surfaces)
// ---------------------------------------------------------------------------

export function rgbaToHsva({ r, g, b, a }: Rgba): Hsva {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min

  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }

  const v = max
  const s = max === 0 ? 0 : d / max
  return { h: round1(h), s: round1(s * 100), v: round1(v * 100), a: round2(a) }
}

export function hsvaToRgba({ h, s, v, a }: Hsva): Rgba {
  const hh = normalizeHue(h)
  const sn = clamp(s, 0, 100) / 100
  const vn = clamp(v, 0, 100) / 100
  const c = vn * sn
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = vn - c

  let rp = 0
  let gp = 0
  let bp = 0
  if (hh < 60) {
    rp = c
    gp = x
  } else if (hh < 120) {
    rp = x
    gp = c
  } else if (hh < 180) {
    gp = c
    bp = x
  } else if (hh < 240) {
    gp = x
    bp = c
  } else if (hh < 300) {
    rp = x
    bp = c
  } else {
    rp = c
    bp = x
  }

  return {
    r: clamp(Math.round((rp + m) * 255), 0, 255),
    g: clamp(Math.round((gp + m) * 255), 0, 255),
    b: clamp(Math.round((bp + m) * 255), 0, 255),
    a: clamp(round2(a), 0, 1),
  }
}

// ---------------------------------------------------------------------------
// Rgba <-> Hsla (the HSL model field)
// ---------------------------------------------------------------------------

export function rgbaToHsla({ r, g, b, a }: Rgba): Hsla {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min

  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }

  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return { h: round1(h), s: round1(s * 100), l: round1(l * 100), a: round2(a) }
}

export function hslaToRgba({ h, s, l, a }: Hsla): Rgba {
  const hh = normalizeHue(h)
  const sn = clamp(s, 0, 100) / 100
  const ln = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = ln - c / 2

  let rp = 0
  let gp = 0
  let bp = 0
  if (hh < 60) {
    rp = c
    gp = x
  } else if (hh < 120) {
    rp = x
    gp = c
  } else if (hh < 180) {
    gp = c
    bp = x
  } else if (hh < 240) {
    gp = x
    bp = c
  } else if (hh < 300) {
    rp = x
    bp = c
  } else {
    rp = c
    bp = x
  }

  return {
    r: clamp(Math.round((rp + m) * 255), 0, 255),
    g: clamp(Math.round((gp + m) * 255), 0, 255),
    b: clamp(Math.round((bp + m) * 255), 0, 255),
    a: clamp(round2(a), 0, 1),
  }
}

// ---------------------------------------------------------------------------
// Serialization — the ONLY place this module writes a CSS string. Alpha at
// (or effectively at) 1 always serializes as the alpha-less form
// (`#rrggbb`, `rgb()`, `hsl()`) rather than an `a: 1` layer nobody wrote.
// ---------------------------------------------------------------------------

function toHexByte(n: number): string {
  return clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
}

export function formatColor(rgba: Rgba, model: ColorModel): string {
  const a = clamp(round2(rgba.a), 0, 1)
  const opaque = a >= 0.995

  if (model === 'hex') {
    const base = `#${toHexByte(rgba.r)}${toHexByte(rgba.g)}${toHexByte(rgba.b)}`
    return opaque ? base : `${base}${toHexByte(a * 255)}`
  }

  if (model === 'rgb') {
    return opaque
      ? `rgb(${rgba.r}, ${rgba.g}, ${rgba.b})`
      : `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${a})`
  }

  const hsla = rgbaToHsla(rgba)
  return opaque
    ? `hsl(${hsla.h}, ${hsla.s}%, ${hsla.l}%)`
    : `hsla(${hsla.h}, ${hsla.s}%, ${hsla.l}%, ${a})`
}
