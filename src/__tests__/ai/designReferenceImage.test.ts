import { describe, expect, it } from 'bun:test'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import {
  DESIGN_REFERENCE_MAX_BYTES,
  DESIGN_REFERENCE_MAX_EDGE,
  DESIGN_REFERENCE_MAX_PIXELS,
  DesignReferenceMetaSchema,
  validateDesignReferenceDimensions,
  validateDesignReferenceFile,
} from '@core/ai'

function file(bytes: number, type = 'image/png'): File {
  return new File([new Uint8Array(bytes)], 'reference.png', { type })
}

describe('validateDesignReferenceFile', () => {
  it('accepts a PNG/JPEG/WebP file within the byte cap', () => {
    expect(validateDesignReferenceFile(file(1024, 'image/png'))).toBeNull()
    expect(validateDesignReferenceFile(file(1024, 'image/jpeg'))).toBeNull()
    expect(validateDesignReferenceFile(file(1024, 'image/webp'))).toBeNull()
  })

  it('rejects an unsupported mime type', () => {
    expect(validateDesignReferenceFile(file(1024, 'image/gif')))
      .toBe('Use a PNG, JPEG, or WebP image.')
  })

  it('rejects an empty file', () => {
    expect(validateDesignReferenceFile(file(0))).toBe('The file is empty.')
  })

  it('rejects a file over the lossless byte cap without weakening it silently', () => {
    const message = validateDesignReferenceFile(file(DESIGN_REFERENCE_MAX_BYTES + 1))
    expect(message).toContain('50 MB')
  })
})

describe('validateDesignReferenceDimensions', () => {
  it('accepts a real-world tall 3x export', () => {
    expect(validateDesignReferenceDimensions(1170, 12_000)).toBeNull()
  })

  it('rejects a declared edge above the sanity ceiling', () => {
    expect(validateDesignReferenceDimensions(DESIGN_REFERENCE_MAX_EDGE + 1, 100)).toContain('20,000px')
  })

  it('rejects a declared pixel count above the sanity ceiling even under the edge cap', () => {
    const edge = Math.floor(Math.sqrt(DESIGN_REFERENCE_MAX_PIXELS)) + 1
    expect(validateDesignReferenceDimensions(edge, edge)).toContain('px area limit')
  })
})

describe('DesignReferenceMetaSchema', () => {
  const base = {
    id: 'a1b2c3d4-0000-4000-8000-000000000000',
    ext: 'png',
    mimeType: 'image/png',
    width: 1290,
    height: 8400,
    sizeBytes: 21_000_000,
    contentHash: 'a'.repeat(64),
    relPath: '.studio/references/a1b2c3d4.png',
    createdAt: '2026-08-03T00:00:00.000Z',
  }

  it('validates a well-formed payload matching the server DesignReference shape', () => {
    expect(compiledCheck(DesignReferenceMetaSchema, base)).toBe(true)
  })

  it('accepts the optional label/source/pageId fields', () => {
    expect(compiledCheck(DesignReferenceMetaSchema, {
      ...base,
      label: 'homepage.png',
      source: 'pasted by user',
      pageId: 'page_1',
    })).toBe(true)
  })

  it('rejects an ext outside the server-side raster set', () => {
    expect(compiledCheck(DesignReferenceMetaSchema, { ...base, ext: 'bmp' })).toBe(false)
  })

  it('rejects a zero-dimension reference', () => {
    expect(compiledCheck(DesignReferenceMetaSchema, { ...base, width: 0 })).toBe(false)
  })
})
