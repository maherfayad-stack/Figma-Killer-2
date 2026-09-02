/**
 * inspectModel — pure transform: a rendered element's computed style ->
 * the structured shape the Inspect panel renders.
 *
 * Deliberately takes a plain, CSSStyleDeclaration-*shaped* record rather
 * than a live `CSSStyleDeclaration` so it is unit-testable without a
 * browser/DOM — the caller (`useInspectComputedStyle`) is the only place
 * that touches `getComputedStyle`.
 *
 * Color-token matching is best-effort and exact-only: a computed color is
 * canonicalized to its rgba channel tuple and compared against every
 * framework color variable's canonicalized value. A match surfaces the
 * token's `--variable-name`; anything else just shows the raw computed
 * value. Never blocks the rest of the panel on token resolution.
 */

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * The subset of `CSSStyleDeclaration` the Inspect panel reads, keyed by the
 * same camelCase property names `getComputedStyle(el)` exposes — so building
 * this from a real computed style is a straight field-by-field copy.
 */
export interface ComputedStyleSnapshot {
  color: string
  backgroundColor: string
  borderTopColor: string
  borderRightColor: string
  borderBottomColor: string
  borderLeftColor: string
  borderTopWidth: string
  borderRightWidth: string
  borderBottomWidth: string
  borderLeftWidth: string
  borderTopStyle: string
  borderRightStyle: string
  borderBottomStyle: string
  borderLeftStyle: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  letterSpacing: string
  width: string
  height: string
  marginTop: string
  marginRight: string
  marginBottom: string
  marginLeft: string
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
}

/** A design-token color variable — the shape `inspectModel` needs from
 *  `generateFrameworkColorVariableSets(...)`'s output entries. */
export interface ColorTokenLike {
  /** CSS variable name including leading `--` (e.g. `--color-primary-500`). */
  name: string
  /** Resolved CSS value (hex / rgb / rgba / hsl / hsla). */
  value: string
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface InspectColorValue {
  /** The computed value exactly as read from the browser. */
  raw: string
  /** Hex form (6 or 8 digit, lowercase) when the value parses; else null. */
  hex: string | null
  /** Exact-match design-token variable name, or null when none matched. */
  tokenName: string | null
}

export interface InspectColorSwatch {
  /** Human label, e.g. "Text", "Background", "Border", "Border top". */
  label: string
  /** The CSS property this swatch represents, e.g. "color", "border-top-color". */
  property: string
  value: InspectColorValue
}

export interface InspectTypography {
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  letterSpacing: string
}

export interface BoxSides {
  top: string
  right: string
  bottom: string
  left: string
}

export interface InspectBoxModel {
  width: string
  height: string
  margin: BoxSides
  padding: BoxSides
  borderWidth: BoxSides
}

export interface InspectModel {
  colors: InspectColorSwatch[]
  typography: InspectTypography
  boxModel: InspectBoxModel
  /** Compact, copyable block of the effective CSS declarations. */
  css: string
}

// ---------------------------------------------------------------------------
// Color parsing — hex / rgb(a) / hsl(a) -> canonical rgba channels
// ---------------------------------------------------------------------------

interface RgbaChannels {
  r: number
  g: number
  b: number
  a: number
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE = /^rgba?\(\s*(\d*\.?\d+)\s*[, ]\s*(\d*\.?\d+)\s*[, ]\s*(\d*\.?\d+)\s*(?:[,/]\s*(\d*\.?\d+%?))?\s*\)$/i
const HSL_RE = /^hsla?\(\s*([-+]?\d*\.?\d+)(?:deg)?\s*,?\s*([-+]?\d*\.?\d+)%\s*,?\s*([-+]?\d*\.?\d+)%\s*(?:[,/]\s*(\d*\.?\d+%?))?\s*\)$/i

function parseAlpha(raw: string | undefined): number {
  if (!raw) return 1
  const trimmed = raw.trim()
  if (trimmed.endsWith('%')) return clamp01(parseFloat(trimmed) / 100)
  return clamp01(parseFloat(trimmed))
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 1
  return Math.min(1, Math.max(0, n))
}

function clampByte(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(255, Math.max(0, Math.round(n)))
}

function expandHexDigit(ch: string): string {
  return ch + ch
}

function parseHex(hex: string): RgbaChannels | null {
  const body = hex.slice(1)
  if (body.length === 3) {
    const [r, g, b] = body
    return {
      r: parseInt(expandHexDigit(r), 16),
      g: parseInt(expandHexDigit(g), 16),
      b: parseInt(expandHexDigit(b), 16),
      a: 1,
    }
  }
  if (body.length === 4) {
    const [r, g, b, a] = body
    return {
      r: parseInt(expandHexDigit(r), 16),
      g: parseInt(expandHexDigit(g), 16),
      b: parseInt(expandHexDigit(b), 16),
      a: parseInt(expandHexDigit(a), 16) / 255,
    }
  }
  if (body.length === 6) {
    return {
      r: parseInt(body.slice(0, 2), 16),
      g: parseInt(body.slice(2, 4), 16),
      b: parseInt(body.slice(4, 6), 16),
      a: 1,
    }
  }
  // 8-digit
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
    a: parseInt(body.slice(6, 8), 16) / 255,
  }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const sat = clamp01(s / 100)
  const light = clamp01(l / 100)
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  const [r, g, b] =
    hue < 60 ? [c, x, 0] :
    hue < 120 ? [x, c, 0] :
    hue < 180 ? [0, c, x] :
    hue < 240 ? [0, x, c] :
    hue < 300 ? [x, 0, c] :
    [c, 0, x]
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)]
}

/** Parse a CSS color string (hex / rgb(a) / hsl(a)) into rgba channels, or
 *  null when the format isn't recognized. Exported for unit testing. */
export function parseCssColor(value: string): RgbaChannels | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }

  const hexMatch = HEX_RE.exec(trimmed)
  if (hexMatch) return parseHex(trimmed)

  const rgbMatch = RGB_RE.exec(trimmed)
  if (rgbMatch) {
    return {
      r: clampByte(parseFloat(rgbMatch[1])),
      g: clampByte(parseFloat(rgbMatch[2])),
      b: clampByte(parseFloat(rgbMatch[3])),
      a: parseAlpha(rgbMatch[4]),
    }
  }

  const hslMatch = HSL_RE.exec(trimmed)
  if (hslMatch) {
    const [r, g, b] = hslToRgb(parseFloat(hslMatch[1]), parseFloat(hslMatch[2]), parseFloat(hslMatch[3]))
    return { r, g, b, a: parseAlpha(hslMatch[4]) }
  }

  return null
}

/** Canonical string key for comparing two colors for exact equality
 *  regardless of the format each was expressed in. Exported for testing. */
export function canonicalColorKey(value: string): string | null {
  const channels = parseCssColor(value)
  if (!channels) return null
  return `${channels.r},${channels.g},${channels.b},${channels.a.toFixed(3)}`
}

/** Render rgba channels as a lowercase hex string — 6 digits when fully
 *  opaque, 8 digits (with alpha) otherwise. */
export function rgbaToHex({ r, g, b, a }: RgbaChannels): string {
  const toHexByte = (n: number) => clampByte(n).toString(16).padStart(2, '0')
  const base = `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`
  if (a >= 1) return base
  const alphaByte = Math.round(clamp01(a) * 255)
  return `${base}${alphaByte.toString(16).padStart(2, '0')}`
}

/** Find the design token whose value canonically matches `value`, or null. */
export function findMatchingColorToken(
  value: string,
  tokens: ReadonlyArray<ColorTokenLike>,
): string | null {
  const key = canonicalColorKey(value)
  if (!key) return null
  for (const token of tokens) {
    if (canonicalColorKey(token.value) === key) return token.name
  }
  return null
}

function toColorValue(raw: string, tokens: ReadonlyArray<ColorTokenLike>): InspectColorValue {
  const channels = parseCssColor(raw)
  return {
    raw,
    hex: channels ? rgbaToHex(channels) : null,
    tokenName: findMatchingColorToken(raw, tokens),
  }
}

// ---------------------------------------------------------------------------
// Box model helpers
// ---------------------------------------------------------------------------

function parsePx(value: string): number {
  const n = parseFloat(value)
  return Number.isNaN(n) ? 0 : n
}

interface BorderSide {
  side: 'top' | 'right' | 'bottom' | 'left'
  label: string
  color: string
  width: string
  style: string
}

function visibleBorderSides(snapshot: ComputedStyleSnapshot): BorderSide[] {
  const sides: BorderSide[] = [
    { side: 'top', label: 'Border top', color: snapshot.borderTopColor, width: snapshot.borderTopWidth, style: snapshot.borderTopStyle },
    { side: 'right', label: 'Border right', color: snapshot.borderRightColor, width: snapshot.borderRightWidth, style: snapshot.borderRightStyle },
    { side: 'bottom', label: 'Border bottom', color: snapshot.borderBottomColor, width: snapshot.borderBottomWidth, style: snapshot.borderBottomStyle },
    { side: 'left', label: 'Border left', color: snapshot.borderLeftColor, width: snapshot.borderLeftWidth, style: snapshot.borderLeftStyle },
  ]
  return sides.filter((s) => parsePx(s.width) > 0 && s.style !== 'none' && s.style !== '')
}

function buildColorSwatches(
  snapshot: ComputedStyleSnapshot,
  tokens: ReadonlyArray<ColorTokenLike>,
): InspectColorSwatch[] {
  const swatches: InspectColorSwatch[] = []

  if (snapshot.color) {
    swatches.push({ label: 'Text', property: 'color', value: toColorValue(snapshot.color, tokens) })
  }
  if (snapshot.backgroundColor) {
    swatches.push({
      label: 'Background',
      property: 'background-color',
      value: toColorValue(snapshot.backgroundColor, tokens),
    })
  }

  const visibleBorders = visibleBorderSides(snapshot)
  if (visibleBorders.length > 0) {
    const keys = visibleBorders.map((s) => canonicalColorKey(s.color) ?? s.color)
    const allSame = keys.every((k) => k === keys[0])
    if (allSame) {
      swatches.push({
        label: 'Border',
        property: 'border-color',
        value: toColorValue(visibleBorders[0].color, tokens),
      })
    } else {
      for (const side of visibleBorders) {
        swatches.push({
          label: side.label,
          property: `border-${side.side}-color`,
          value: toColorValue(side.color, tokens),
        })
      }
    }
  }

  return swatches
}

// ---------------------------------------------------------------------------
// Raw CSS block
// ---------------------------------------------------------------------------

/** Property order + kebab-case name for the raw CSS block. Skips a
 *  declaration entirely when the snapshot has no value for it. */
const CSS_BLOCK_PROPERTIES: ReadonlyArray<{ key: keyof ComputedStyleSnapshot; css: string }> = [
  { key: 'color', css: 'color' },
  { key: 'backgroundColor', css: 'background-color' },
  { key: 'borderTopWidth', css: 'border-top-width' },
  { key: 'borderTopStyle', css: 'border-top-style' },
  { key: 'borderTopColor', css: 'border-top-color' },
  { key: 'borderRightWidth', css: 'border-right-width' },
  { key: 'borderRightStyle', css: 'border-right-style' },
  { key: 'borderRightColor', css: 'border-right-color' },
  { key: 'borderBottomWidth', css: 'border-bottom-width' },
  { key: 'borderBottomStyle', css: 'border-bottom-style' },
  { key: 'borderBottomColor', css: 'border-bottom-color' },
  { key: 'borderLeftWidth', css: 'border-left-width' },
  { key: 'borderLeftStyle', css: 'border-left-style' },
  { key: 'borderLeftColor', css: 'border-left-color' },
  { key: 'fontFamily', css: 'font-family' },
  { key: 'fontSize', css: 'font-size' },
  { key: 'fontWeight', css: 'font-weight' },
  { key: 'lineHeight', css: 'line-height' },
  { key: 'letterSpacing', css: 'letter-spacing' },
  { key: 'width', css: 'width' },
  { key: 'height', css: 'height' },
  { key: 'marginTop', css: 'margin-top' },
  { key: 'marginRight', css: 'margin-right' },
  { key: 'marginBottom', css: 'margin-bottom' },
  { key: 'marginLeft', css: 'margin-left' },
  { key: 'paddingTop', css: 'padding-top' },
  { key: 'paddingRight', css: 'padding-right' },
  { key: 'paddingBottom', css: 'padding-bottom' },
  { key: 'paddingLeft', css: 'padding-left' },
]

function buildCssBlock(snapshot: ComputedStyleSnapshot): string {
  const lines: string[] = []
  for (const { key, css } of CSS_BLOCK_PROPERTIES) {
    const value = snapshot[key]
    if (!value) continue
    lines.push(`  ${css}: ${value};`)
  }
  return lines.length > 0 ? `{\n${lines.join('\n')}\n}` : '{}'
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Build the structured Inspect model from a computed-style snapshot. */
export function buildInspectModel(
  snapshot: ComputedStyleSnapshot,
  tokens: ReadonlyArray<ColorTokenLike> = [],
): InspectModel {
  return {
    colors: buildColorSwatches(snapshot, tokens),
    typography: {
      fontFamily: snapshot.fontFamily || '—',
      fontSize: snapshot.fontSize || '—',
      fontWeight: snapshot.fontWeight || '—',
      lineHeight: snapshot.lineHeight || '—',
      letterSpacing: snapshot.letterSpacing || '—',
    },
    boxModel: {
      width: snapshot.width || '—',
      height: snapshot.height || '—',
      margin: {
        top: snapshot.marginTop || '0px',
        right: snapshot.marginRight || '0px',
        bottom: snapshot.marginBottom || '0px',
        left: snapshot.marginLeft || '0px',
      },
      padding: {
        top: snapshot.paddingTop || '0px',
        right: snapshot.paddingRight || '0px',
        bottom: snapshot.paddingBottom || '0px',
        left: snapshot.paddingLeft || '0px',
      },
      borderWidth: {
        top: snapshot.borderTopWidth || '0px',
        right: snapshot.borderRightWidth || '0px',
        bottom: snapshot.borderBottomWidth || '0px',
        left: snapshot.borderLeftWidth || '0px',
      },
    },
    css: buildCssBlock(snapshot),
  }
}
