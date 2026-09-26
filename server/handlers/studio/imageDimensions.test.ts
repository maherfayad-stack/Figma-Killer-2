/**
 * imageDimensions — the intrinsic size every landing response reports
 * (IMG-1, audit 07 §A.3). Each format is built byte by byte from its spec so
 * the test pins the header layout, not a sample file's accident. Every
 * malformed input must answer `null` ("unknown"), never a guess and never a
 * throw: these bytes are attacker-supplied.
 */
import { describe, expect, it } from 'bun:test'
import { readImageDimensions } from './imageDimensions'

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

function png(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...ascii('IHDR'), ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0, 0, 0, 0, 0,
  ])
}

function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0])
}

/** A big-endian EXIF APP1 segment carrying only an Orientation tag. */
function exifApp1(orientation: number): number[] {
  const payload = [
    ...ascii('Exif'), 0, 0,
    ...ascii('MM'), ...u16be(42), ...u32be(8),
    ...u16be(1), // one IFD entry
    ...u16be(0x0112), ...u16be(3), ...u32be(1), ...u16be(orientation), 0, 0,
    ...u32be(0), // no next IFD
  ]
  return [0xff, 0xe1, ...u16be(payload.length + 2), ...payload]
}

function jpeg(width: number, height: number, options: { orientation?: number; sof?: number } = {}): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const sof = [0xff, options.sof ?? 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  return new Uint8Array([
    0xff, 0xd8,
    ...app0,
    ...(options.orientation === undefined ? [] : exifApp1(options.orientation)),
    ...sof,
    0xff, 0xd9,
  ])
}

function riff(chunk: string, body: number[]): Uint8Array {
  return new Uint8Array([...ascii('RIFF'), ...u32be(0), ...ascii('WEBP'), ...ascii(chunk), ...u32be(0), ...body])
}

function webpLossy(width: number, height: number): Uint8Array {
  return riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height), 0, 0])
}

function webpLossless(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14)
  return riff('VP8L', [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0])
}

function webpExtended(width: number, height: number): Uint8Array {
  return riff('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)])
}

const svg = (root: string) => new TextEncoder().encode(`<?xml version="1.0"?>\n${root}<rect/></svg>`)

describe('readImageDimensions — each format', () => {
  it('PNG: the IHDR chunk', () => {
    expect(readImageDimensions(png(640, 480), 'png')).toEqual({ width: 640, height: 480 })
  })

  it('GIF: the logical screen descriptor', () => {
    expect(readImageDimensions(gif(320, 200), 'gif')).toEqual({ width: 320, height: 200 })
  })

  it('JPEG: the first frame header, past the APP segments', () => {
    expect(readImageDimensions(jpeg(1024, 768), 'jpg')).toEqual({ width: 1024, height: 768 })
  })

  it('JPEG: a progressive frame (SOF2) too', () => {
    expect(readImageDimensions(jpeg(1024, 768, { sof: 0xc2 }), 'jpg')).toEqual({ width: 1024, height: 768 })
  })

  it('JPEG: an EXIF rotation of 90° reports the DISPLAYED box, transposed', () => {
    // A phone photo: stored 4032×3024, shown portrait.
    expect(readImageDimensions(jpeg(4032, 3024, { orientation: 6 }), 'jpg')).toEqual({ width: 3024, height: 4032 })
    expect(readImageDimensions(jpeg(4032, 3024, { orientation: 3 }), 'jpg')).toEqual({ width: 4032, height: 3024 })
  })

  it('WebP: lossy (VP8), lossless (VP8L) and extended (VP8X)', () => {
    expect(readImageDimensions(webpLossy(800, 600), 'webp')).toEqual({ width: 800, height: 600 })
    expect(readImageDimensions(webpLossless(1234, 567), 'webp')).toEqual({ width: 1234, height: 567 })
    expect(readImageDimensions(webpExtended(4000, 3000), 'webp')).toEqual({ width: 4000, height: 3000 })
  })

  it('SVG: absolute width and height win', () => {
    expect(readImageDimensions(svg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40px" viewBox="0 0 12 4">'), 'svg')).toEqual({
      width: 120,
      height: 40,
    })
  })

  it('SVG: falls back to the viewBox', () => {
    expect(readImageDimensions(svg('<svg viewBox="0 0 24 16">'), 'svg')).toEqual({ width: 24, height: 16 })
    expect(readImageDimensions(svg("<svg viewBox='0,0,24,16'>"), 'svg')).toEqual({ width: 24, height: 16 })
  })

  it('SVG: one absolute side plus a viewBox keeps the aspect ratio', () => {
    expect(readImageDimensions(svg('<svg width="48" viewBox="0 0 24 16">'), 'svg')).toEqual({ width: 48, height: 32 })
  })

  it('SVG: a relative width is unknown, not approximated', () => {
    expect(readImageDimensions(svg('<svg width="100%" height="100%">'), 'svg')).toBeNull()
    expect(readImageDimensions(svg('<svg width="100%" height="100%" viewBox="0 0 10 5">'), 'svg')).toEqual({ width: 10, height: 5 })
  })

  it('SVG: `stroke-width` on the root is not read as `width`', () => {
    expect(readImageDimensions(svg('<svg stroke-width="2" viewBox="0 0 24 16">'), 'svg')).toEqual({ width: 24, height: 16 })
  })

  it('AVIF is unknown', () => {
    expect(readImageDimensions(new Uint8Array(64), 'avif')).toBeNull()
  })
})

describe('readImageDimensions — malformed input answers null', () => {
  it('a truncated header', () => {
    expect(readImageDimensions(png(640, 480).subarray(0, 20), 'png')).toBeNull()
    expect(readImageDimensions(gif(1, 1).subarray(0, 8), 'gif')).toBeNull()
    expect(readImageDimensions(jpeg(10, 10).subarray(0, 30), 'jpg')).toBeNull()
    expect(readImageDimensions(webpLossy(10, 10).subarray(0, 26), 'webp')).toBeNull()
  })

  it('a zero dimension', () => {
    expect(readImageDimensions(png(0, 480), 'png')).toBeNull()
    expect(readImageDimensions(gif(10, 0), 'gif')).toBeNull()
  })

  it('a JPEG whose scan starts before any frame header', () => {
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]), 'jpg')).toBeNull()
  })

  it('a JPEG segment length that runs past the end', () => {
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0]), 'jpg')).toBeNull()
  })

  it('an EXIF IFD offset that points past the segment keeps the stored size', () => {
    const bytes = jpeg(40, 20, { orientation: 6 })
    // Corrupt the IFD0 offset (the u32 after "MM\0*") to point far away.
    const at = bytes.findIndex((b, i) => b === 0x4d && bytes[i + 1] === 0x4d)
    bytes.set(u32be(0xfffffff0), at + 4)
    expect(readImageDimensions(bytes, 'jpg')).toEqual({ width: 40, height: 20 })
  })

  it('a WebP with an unknown chunk, or a VP8 frame without its start code', () => {
    expect(readImageDimensions(riff('ALPH', new Array(12).fill(0)), 'webp')).toBeNull()
    const broken = webpLossy(10, 10)
    broken[23] = 0
    expect(readImageDimensions(broken, 'webp')).toBeNull()
  })

  it('a pathological SVG length answers quickly (security review F3: no quadratic backtracking)', () => {
    const digits = '1'.repeat(7000)
    const spaces = ' '.repeat(7000)
    const started = performance.now()
    for (let i = 0; i < 20; i += 1) {
      expect(readImageDimensions(svg(`<svg width="${digits}x" height="1">`), 'svg')).toBeNull()
      expect(readImageDimensions(svg(`<svg width="1${spaces}x" height="1">`), 'svg')).toBeNull()
    }
    // 40 parses of an 8 KB window; the old pattern took ~50 ms EACH at 4000 digits.
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('an SVG length with surrounding whitespace and px still reads', () => {
    expect(readImageDimensions(svg('<svg width=" 12.5px " height="8">'), 'svg')).toEqual({ width: 13, height: 8 })
  })

  it('an SVG with no root element', () => {
    expect(readImageDimensions(new TextEncoder().encode('<html></html>'), 'svg')).toBeNull()
  })
})
