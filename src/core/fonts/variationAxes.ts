/**
 * variationAxes — reading which OpenType Variation axes (`fvar` table) a font
 * file actually exposes, and translating between that axis set and the CSS
 * `font-variation-settings` shorthand.
 *
 * docs/features/inspector-disclosure.md G9 / F27: the Typography settings
 * popover's "Variable" tab must render ONLY for a font that genuinely has
 * variable axes — a slider for `wght` on Helvetica is a control that lies.
 * The only honest source for that fact is the font file's own `fvar` table,
 * so this module reads it directly rather than guessing from a family name.
 *
 * SCOPE, STATED HONESTLY: `parseFontVariationAxes` reads an UNCOMPRESSED
 * `sfnt` container (TrueType / CFF-flavoured OpenType — `.ttf` / `.otf`). It
 * does not decompress WOFF or WOFF2 (Brotli, in WOFF2's case) — neither this
 * module nor the browser ships a decoder for either, and adding one is a
 * real follow-up, not this work order's job. See
 * `findProbableVariableFontFile`'s doc for the practical consequence: every
 * Google-installed font is served as `.woff2` (`FontEntry`'s own doc:
 * "Google installs are always woff2"), so axis detection today only ever
 * fires for a self-hosted `.ttf` / `.otf` upload — even when the underlying
 * family genuinely is variable. The honest behaviour in the meantime is to
 * admit "can't tell" and omit the tab, never to guess.
 */

import type { FontEntry, FontFile } from './schemas'

export interface FontVariationAxis {
  /** Four-letter OpenType axis tag, e.g. `wght`. */
  tag: string
  /** A well-known registered axis's display name, or the tag itself. */
  name: string
  min: number
  max: number
  default: number
}

/** Registered axis tags (OpenType spec) with a human name worth showing instead of the raw tag. Any other tag renders as itself — still honest, just less pretty. */
const KNOWN_AXIS_NAMES: Readonly<Record<string, string>> = {
  wght: 'Weight',
  wdth: 'Width',
  slnt: 'Slant',
  ital: 'Italic',
  opsz: 'Optical size',
  GRAD: 'Grade',
}

/** Reads a big-endian 16.16 fixed-point number (OpenType `Fixed`) at `offset`. */
function readFixed(view: DataView, offset: number): number {
  return view.getInt32(offset, false) / 65536
}

function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

/**
 * Parses the `fvar` table out of a raw `sfnt` font container. Returns `[]` —
 * never throws — for anything that isn't a well-formed `sfnt` with an `fvar`
 * table: a WOFF/WOFF2 signature, a truncated buffer, a non-font file, a
 * static font with no `fvar` at all. This is a read, not a validator — a
 * font this permissive about rejects is still rendered by the browser
 * regardless of what this function returns; it only decides whether the
 * Variable tab has anything honest to show.
 */
export function parseFontVariationAxes(bytes: Uint8Array): FontVariationAxis[] {
  try {
    if (bytes.byteLength < 12) return []
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    const sfntVersion = view.getUint32(0, false)
    // 0x00010000 = TrueType outlines, 'OTTO' = CFF outlines. A WOFF ('wOFF')
    // or WOFF2 ('wOF2') signature fails this check and correctly returns [].
    if (sfntVersion !== 0x00010000 && sfntVersion !== 0x4f54544f) return []

    const numTables = view.getUint16(4, false)
    let fvarOffset: number | undefined
    for (let i = 0; i < numTables; i++) {
      const recordOffset = 12 + i * 16
      if (recordOffset + 16 > bytes.byteLength) break
      if (readTag(bytes, recordOffset) === 'fvar') {
        fvarOffset = view.getUint32(recordOffset + 8, false)
        break
      }
    }
    if (fvarOffset === undefined || fvarOffset + 16 > bytes.byteLength) return []

    const axesArrayOffset = view.getUint16(fvarOffset + 4, false)
    const axisCount = view.getUint16(fvarOffset + 8, false)
    const axisSize = view.getUint16(fvarOffset + 10, false)
    // `axisSize` must be at least the 20-byte VariationAxisRecord; a bound on
    // `axisCount` keeps a corrupt/hostile table from spinning this loop —
    // no real font declares anywhere near 64 axes.
    if (axisSize < 20 || axisCount === 0 || axisCount > 64) return []

    const axes: FontVariationAxis[] = []
    for (let i = 0; i < axisCount; i++) {
      const recordOffset = fvarOffset + axesArrayOffset + i * axisSize
      if (recordOffset + 20 > bytes.byteLength) break
      const tag = readTag(bytes, recordOffset)
      const min = readFixed(view, recordOffset + 4)
      const defaultValue = readFixed(view, recordOffset + 8)
      const max = readFixed(view, recordOffset + 12)
      axes.push({ tag, name: KNOWN_AXIS_NAMES[tag] ?? tag, min, max, default: defaultValue })
    }
    return axes
  } catch {
    return []
  }
}

/**
 * The one `FontFile` of an entry `parseFontVariationAxes` can actually read
 * — an uncompressed `.ttf` / `.otf` slice. `undefined` when the entry has
 * none (every Google-installed font, and any custom upload that only
 * carries a `.woff` / `.woff2`) — the honest "can't tell" case the Variable
 * tab omits itself for. When an entry has more than one qualifying file
 * (e.g. separate regular/italic uploads), the first is representative enough
 * — variable fonts declare the same axis set across their static-style
 * siblings.
 */
export function findProbableVariableFontFile(entry: FontEntry): FontFile | undefined {
  return entry.files.find((file) => file.format === 'ttf' || file.format === 'otf')
}

// ---------------------------------------------------------------------------
// font-variation-settings CSS value — parse / serialize
// ---------------------------------------------------------------------------

const AXIS_VALUE_RE = /"([A-Za-z0-9]{1,4})"\s*(-?\d+(?:\.\d+)?)/g

/**
 * Parses a `font-variation-settings` value into a `tag → number` map.
 * `undefined`, `'normal'`, or anything unparseable yields an empty map —
 * never a throw.
 */
export function parseFontVariationSettingsValue(value: unknown): Record<string, number> {
  if (typeof value !== 'string') return {}
  const result: Record<string, number> = {}
  for (const match of value.matchAll(AXIS_VALUE_RE)) {
    const tag = match[1]
    const parsed = Number(match[2])
    if (Number.isFinite(parsed)) result[tag] = parsed
  }
  return result
}

/**
 * Serializes a `tag → number` map back into a `font-variation-settings`
 * value, in `axes`' own order (only axes with an explicit entry in `values`
 * are written — an axis left at its font-native default doesn't need
 * declaring). `undefined` when nothing is set, so the caller can clear the
 * property entirely rather than writing an empty string.
 */
export function serializeFontVariationSettingsValue(
  values: Readonly<Record<string, number>>,
  axes: ReadonlyArray<FontVariationAxis>,
): string | undefined {
  const entries = axes
    .filter((axis) => values[axis.tag] !== undefined)
    .map((axis) => `"${axis.tag}" ${values[axis.tag]}`)
  return entries.length > 0 ? entries.join(', ') : undefined
}
