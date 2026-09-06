/**
 * variationAxes — G9 (STUDIO-INSPECTOR-DISCLOSURE-PLAN.md).
 *
 * `parseFontVariationAxes` reads a real (synthetic, minimal) `fvar` table out
 * of an `sfnt` byte buffer — no font-file fixture, no network, no browser
 * font APIs. That is deliberate: the Typography settings popover's Variable
 * tab decides whether to exist from this function's return value, so it has
 * to be exactly this cheap to get right.
 */
import { describe, expect, it } from 'bun:test'
import {
  findProbableVariableFontFile,
  parseFontVariationAxes,
  parseFontVariationSettingsValue,
  serializeFontVariationSettingsValue,
  type FontVariationAxis,
} from '@core/fonts'
import type { FontEntry, FontFile } from '@core/fonts'

// ---------------------------------------------------------------------------
// A minimal, real `sfnt` + `fvar` byte buffer — two axes (wght, wdth).
// ---------------------------------------------------------------------------

function writeFixed(view: DataView, offset: number, value: number): void {
  view.setInt32(offset, Math.round(value * 65536), false)
}

function writeTag(bytes: Uint8Array, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) bytes[offset + i] = tag.charCodeAt(i)
}

function buildSfntWithFvar(): Uint8Array {
  const FVAR_TABLE_OFFSET = 28
  const AXIS_COUNT = 2
  const FVAR_HEADER_SIZE = 16
  const AXIS_SIZE = 20
  const fvarLength = FVAR_HEADER_SIZE + AXIS_COUNT * AXIS_SIZE
  const totalLength = FVAR_TABLE_OFFSET + fvarLength

  const bytes = new Uint8Array(totalLength)
  const view = new DataView(bytes.buffer)

  // sfnt header
  view.setUint32(0, 0x00010000, false) // sfntVersion: TrueType outlines
  view.setUint16(4, 1, false) // numTables
  view.setUint16(6, 0, false) // searchRange (unused by the parser)
  view.setUint16(8, 0, false) // entrySelector
  view.setUint16(10, 0, false) // rangeShift

  // one table record: 'fvar'
  writeTag(bytes, 12, 'fvar')
  view.setUint32(16, 0, false) // checksum (unused)
  view.setUint32(20, FVAR_TABLE_OFFSET, false) // offset
  view.setUint32(24, fvarLength, false) // length

  // fvar header
  view.setUint16(FVAR_TABLE_OFFSET + 0, 1, false) // majorVersion
  view.setUint16(FVAR_TABLE_OFFSET + 2, 0, false) // minorVersion
  view.setUint16(FVAR_TABLE_OFFSET + 4, FVAR_HEADER_SIZE, false) // axesArrayOffset
  view.setUint16(FVAR_TABLE_OFFSET + 6, 2, false) // reserved
  view.setUint16(FVAR_TABLE_OFFSET + 8, AXIS_COUNT, false) // axisCount
  view.setUint16(FVAR_TABLE_OFFSET + 10, AXIS_SIZE, false) // axisSize
  view.setUint16(FVAR_TABLE_OFFSET + 12, 0, false) // instanceCount
  view.setUint16(FVAR_TABLE_OFFSET + 14, 4, false) // instanceSize

  // axis 1: wght 100..900, default 400
  const axis1 = FVAR_TABLE_OFFSET + FVAR_HEADER_SIZE
  writeTag(bytes, axis1, 'wght')
  writeFixed(view, axis1 + 4, 100)
  writeFixed(view, axis1 + 8, 400)
  writeFixed(view, axis1 + 12, 900)
  view.setUint16(axis1 + 16, 0, false)
  view.setUint16(axis1 + 18, 256, false)

  // axis 2: wdth 75..125, default 100
  const axis2 = axis1 + AXIS_SIZE
  writeTag(bytes, axis2, 'wdth')
  writeFixed(view, axis2 + 4, 75)
  writeFixed(view, axis2 + 8, 100)
  writeFixed(view, axis2 + 12, 125)
  view.setUint16(axis2 + 16, 0, false)
  view.setUint16(axis2 + 18, 257, false)

  return bytes
}

function buildStaticSfntWithNoFvar(): Uint8Array {
  const bytes = new Uint8Array(12 + 16)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x00010000, false)
  view.setUint16(4, 1, false)
  writeTag(bytes, 12, 'glyf')
  view.setUint32(16, 0, false)
  view.setUint32(20, 28, false)
  view.setUint32(24, 0, false)
  return bytes
}

// ---------------------------------------------------------------------------
// parseFontVariationAxes
// ---------------------------------------------------------------------------

describe('parseFontVariationAxes', () => {
  it('reads a real fvar table into a typed axis list', () => {
    const axes = parseFontVariationAxes(buildSfntWithFvar())
    expect(axes).toEqual([
      { tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 },
      { tag: 'wdth', name: 'Width', min: 75, max: 125, default: 100 },
    ])
  })

  it('returns [] for a static font with no fvar table', () => {
    expect(parseFontVariationAxes(buildStaticSfntWithNoFvar())).toEqual([])
  })

  it('returns [] for a WOFF signature — compressed formats are not decoded', () => {
    const bytes = new Uint8Array(16)
    writeTag(bytes, 0, 'wOFF')
    expect(parseFontVariationAxes(bytes)).toEqual([])
  })

  it('returns [] rather than throwing on a truncated buffer', () => {
    expect(parseFontVariationAxes(new Uint8Array(4))).toEqual([])
    expect(parseFontVariationAxes(new Uint8Array(0))).toEqual([])
  })

  it('falls back to the raw tag when the axis has no well-known name', () => {
    const bytes = buildSfntWithFvar()
    // Corrupt axis 2's tag to something unregistered ('zzzz') in place.
    writeTag(bytes, 28 + 16 + 20, 'zzzz')
    const axes = parseFontVariationAxes(bytes)
    expect(axes[1]).toMatchObject({ tag: 'zzzz', name: 'zzzz' })
  })
})

// ---------------------------------------------------------------------------
// findProbableVariableFontFile
// ---------------------------------------------------------------------------

function fontFile(overrides: Partial<FontFile>): FontFile {
  return { variant: '400', subset: 'latin', path: '/uploads/fonts/x.woff2', format: 'woff2', ...overrides }
}

function fontEntry(files: FontFile[]): FontEntry {
  return {
    id: 'f1',
    source: 'custom',
    family: 'Test Sans',
    variants: [],
    subsets: [],
    files,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('findProbableVariableFontFile', () => {
  it('is undefined for an entry with only woff2 files (every Google install)', () => {
    const entry = fontEntry([fontFile({ format: 'woff2', path: '/uploads/fonts/a.woff2' })])
    expect(findProbableVariableFontFile(entry)).toBeUndefined()
  })

  it('finds a ttf file among mixed formats', () => {
    const ttf = fontFile({ format: 'ttf', path: '/uploads/media/a.ttf' })
    const entry = fontEntry([fontFile({ format: 'woff2', path: '/uploads/fonts/a.woff2' }), ttf])
    expect(findProbableVariableFontFile(entry)).toEqual(ttf)
  })

  it('finds an otf file too', () => {
    const otf = fontFile({ format: 'otf', path: '/uploads/media/a.otf' })
    const entry = fontEntry([otf])
    expect(findProbableVariableFontFile(entry)).toEqual(otf)
  })
})

// ---------------------------------------------------------------------------
// font-variation-settings value parse / serialize
// ---------------------------------------------------------------------------

describe('parseFontVariationSettingsValue / serializeFontVariationSettingsValue', () => {
  const axes: FontVariationAxis[] = [
    { tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 },
    { tag: 'wdth', name: 'Width', min: 75, max: 125, default: 100 },
  ]

  it('parses a two-axis value', () => {
    expect(parseFontVariationSettingsValue('"wght" 650, "wdth" 87.5')).toEqual({ wght: 650, wdth: 87.5 })
  })

  it('treats undefined/normal/garbage as no axes set', () => {
    expect(parseFontVariationSettingsValue(undefined)).toEqual({})
    expect(parseFontVariationSettingsValue('normal')).toEqual({})
    expect(parseFontVariationSettingsValue(42)).toEqual({})
  })

  it('serializes only the axes actually present, in axis order', () => {
    expect(serializeFontVariationSettingsValue({ wdth: 90 }, axes)).toBe('"wdth" 90')
    expect(serializeFontVariationSettingsValue({ wght: 650, wdth: 90 }, axes)).toBe('"wght" 650, "wdth" 90')
  })

  it('returns undefined (clear the property) when nothing is set', () => {
    expect(serializeFontVariationSettingsValue({}, axes)).toBeUndefined()
  })

  it('round-trips', () => {
    const value = serializeFontVariationSettingsValue({ wght: 650, wdth: 90 }, axes)
    expect(parseFontVariationSettingsValue(value)).toEqual({ wght: 650, wdth: 90 })
  })
})
