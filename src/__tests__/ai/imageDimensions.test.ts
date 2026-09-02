import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { readImageDimensions, type ImageDimensions } from '@core/ai'

describe('readImageDimensions', () => {
  it('reads PNG dimensions from the IHDR header alone', () => {
    expect(readImageDimensions(pngHeader(640, 480), 'image/png')).toEqual({ width: 640, height: 480 })
  })

  it('reads real JPEG and WebP dimensions without decoding pixels', async () => {
    const source = sharp({
      create: {
        width: 321,
        height: 123,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    })
    const [jpeg, webp] = await Promise.all([
      source.clone().jpeg().toBuffer(),
      source.clone().webp().toBuffer(),
    ])

    expect(readImageDimensions(jpeg, 'image/jpeg')).toEqual({ width: 321, height: 123 })
    expect(readImageDimensions(webp, 'image/webp')).toEqual({ width: 321, height: 123 })
  })

  it('accounts for EXIF display orientation on a JPEG', async () => {
    const oriented = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer()

    expect(readImageDimensions(oriented, 'image/jpeg')).toEqual({ width: 300, height: 400 })
  })

  it('throws on an unsupported mime type instead of guessing', () => {
    expect(() => readImageDimensions(new Uint8Array([1, 2, 3]), 'image/gif'))
      .toThrow('Image dimensions could not be read safely.')
  })

  it('throws on truncated/malformed bytes rather than returning nonsense dimensions', () => {
    expect(() => readImageDimensions(new Uint8Array([0x89, 0x50]), 'image/png'))
      .toThrow('Image dimensions could not be read safely.')
  })

  it('is exported through the @core/ai barrel with a stable shape', () => {
    const dims: ImageDimensions = readImageDimensions(pngHeader(10, 20), 'image/png')
    expect(dims).toEqual({ width: 10, height: 20 })
  })
})

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}
