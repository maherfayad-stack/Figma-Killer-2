/**
 * imageDimensions — an image's intrinsic pixel size, read from the header
 * bytes `sniffImageExtension` (`assetLanding.ts`) already recognised.
 *
 * Every landing response carries `width`/`height` so the element a drop writes
 * can reserve its aspect ratio (IMG-9 clamps them to the drop container). The
 * numbers come from the file's own header and nothing else: no decoder, no
 * `sharp`, no rendering — a landing must stay cheap and must never execute or
 * fully parse attacker-supplied bytes. Every read is bounds-checked, and
 * anything malformed, truncated or unsupported answers `null` ("unknown"),
 * which the caller turns into "write no size attribute", never a guess.
 *
 * Formats:
 *   - PNG: the IHDR chunk, which the spec requires to come first.
 *   - GIF: the logical screen descriptor.
 *   - JPEG: the first SOFn frame header, with the EXIF orientation applied —
 *     a phone photo stored landscape with orientation 6 DISPLAYS portrait
 *     (browsers honour `image-orientation: from-image` by default), and the
 *     displayed box is what `width`/`height` attributes describe.
 *   - WebP: the VP8 (lossy), VP8L (lossless) or VP8X (extended) header.
 *   - SVG: the root element's absolute `width`/`height`, falling back to its
 *     `viewBox`. Relative units (`%`, `em`) are unknown, not approximated.
 *   - AVIF: `null`. Its size lives in an `ispe` box nested inside the ISO-BMFF
 *     `meta` tree; walking that is not worth a second box parser here.
 *
 * Pure: bytes in, numbers out.
 */

export interface ImageDimensions {
  width: number
  height: number
}

/** The largest dimension believed. Every format here tops out well below it (JPEG/GIF: 65535; WebP: 16383; PNG: 2^31 in theory, never in practice). */
const MAX_DIMENSION = 1_000_000

function sized(width: number, height: number): ImageDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  const w = Math.round(width)
  const h = Math.round(height)
  if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION) return null
  return { width: w, height: h }
}

function u16be(b: Uint8Array, at: number): number {
  return (b[at]! << 8) | b[at + 1]!
}

function u16le(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8)
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!)
}

function u24le(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
}

function ascii(b: Uint8Array, at: number, length: number): string {
  if (at + length > b.length) return ''
  return String.fromCharCode(...b.subarray(at, at + length))
}

function pngDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
  return sized(u32be(b, 16), u32be(b, 20))
}

function gifDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 10) return null
  return sized(u16le(b, 6), u16le(b, 8))
}

/**
 * The EXIF orientation (1–8) in an APP1 payload, or `null`. `start` is the
 * first byte after the segment's length field, `end` its exclusive end.
 */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  if (end - start < 14 || ascii(b, start, 6) !== 'Exif\u0000\u0000') return null
  const tiff = start + 6
  const order = ascii(b, tiff, 2)
  if (order !== 'II' && order !== 'MM') return null
  const little = order === 'II'
  const read16 = (at: number) => (little ? u16le(b, at) : u16be(b, at))
  const read32 = (at: number) =>
    little ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000 : u32be(b, at)
  if (read16(tiff + 2) !== 42) return null
  const ifd = tiff + read32(tiff + 4)
  if (ifd + 2 > end) return null
  const count = read16(ifd)
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return null
    if (read16(entry) === 0x0112) {
      const value = read16(entry + 8)
      return value >= 1 && value <= 8 ? value : null
    }
  }
  return null
}

/** SOF markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but are not frames. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegDimensions(b: Uint8Array): ImageDimensions | null {
  let orientation = 1
  let at = 2 // past SOI
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    // Fill bytes: any number of 0xFF may precede a marker.
    while (at < b.length && b[at] === 0xff) at += 1
    if (at >= b.length) return null
    const marker = b[at]!
    at += 1
    // Standalone markers have no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0xd9 || marker === 0xda) return null // EOI / start of scan before any frame header
    if (at + 2 > b.length) return null
    const length = u16be(b, at)
    if (length < 2) return null
    const end = at + length
    if (end > b.length) return null
    if (marker === 0xe1) orientation = exifOrientation(b, at + 2, end) ?? orientation
    if (isStartOfFrame(marker)) {
      if (length < 7) return null
      const height = u16be(b, at + 3)
      const width = u16be(b, at + 5)
      // Orientations 5–8 rotate by 90°, so the DISPLAYED box is transposed.
      return orientation >= 5 ? sized(height, width) : sized(width, height)
    }
    at = end
  }
  return null
}

function webpDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 30) return null
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff)
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const b0 = b[21]!
    const b1 = b[22]!
    const b2 = b[23]!
    const b3 = b[24]!
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    return sized(width, height)
  }
  if (chunk === 'VP8X') {
    return sized(1 + u24le(b, 24), 1 + u24le(b, 27))
  }
  return null
}

/** An absolute SVG length — unitless or `px`. Anything relative (`%`, `em`, `vw`) is `null`: it has no intrinsic pixel size. */
function svgLength(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const match = /^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(raw)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

function svgDimensions(b: Uint8Array): ImageDimensions | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 8192))
  const root = /<svg\b([^>]*)>/i.exec(text)
  if (!root) return null
  const attrs: Record<string, string> = {}
  // `(?:^|\s)` rather than `\b`: `stroke-width` must not read as `width`.
  const attrPattern = /(?:^|\s)(width|height|viewbox)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  for (let m = attrPattern.exec(root[1]!); m !== null; m = attrPattern.exec(root[1]!)) {
    attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? ''
  }
  const width = svgLength(attrs.width)
  const height = svgLength(attrs.height)
  if (width !== null && height !== null) return sized(width, height)

  const box = (attrs.viewbox ?? '').trim().split(/[\s,]+/).map(Number)
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return null
  const [, , boxWidth, boxHeight] = box as [number, number, number, number]
  if (boxWidth <= 0 || boxHeight <= 0) return null
  if (width !== null) return sized(width, (width * boxHeight) / boxWidth)
  if (height !== null) return sized((height * boxWidth) / boxHeight, height)
  return sized(boxWidth, boxHeight)
}

/**
 * The intrinsic size of `bytes`, already sniffed as `ext`, or `null` when the
 * header does not say. For an SVG, pass the SANITISED bytes — the ones that
 * actually land on disk.
 */
export function readImageDimensions(bytes: Uint8Array, ext: string): ImageDimensions | null {
  switch (ext) {
    case 'png':
      return pngDimensions(bytes)
    case 'gif':
      return gifDimensions(bytes)
    case 'jpg':
      return jpegDimensions(bytes)
    case 'webp':
      return webpDimensions(bytes)
    case 'svg':
      return svgDimensions(bytes)
    default:
      return null
  }
}
