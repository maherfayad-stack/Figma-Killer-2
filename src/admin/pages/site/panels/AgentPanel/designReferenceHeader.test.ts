import { describe, expect, it } from 'bun:test'
import { readDesignReferenceDimensions } from './designReferenceHeader'

function pngFile(width: number, height: number): File {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return new File([bytes], 'reference.png', { type: 'image/png' })
}

describe('readDesignReferenceDimensions', () => {
  it('reads dimensions from a bounded header slice, not the whole file', async () => {
    const dims = await readDesignReferenceDimensions(pngFile(1290, 8400))
    expect(dims).toEqual({ width: 1290, height: 8400 })
  })

  it('rejects a file whose header does not match its declared type', async () => {
    const notAnImage = new File([new Uint8Array([1, 2, 3, 4])], 'reference.png', { type: 'image/png' })
    await expect(readDesignReferenceDimensions(notAnImage)).rejects.toThrow(
      'Image dimensions could not be read safely.',
    )
  })
})
