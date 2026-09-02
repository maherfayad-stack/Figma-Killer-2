import {
  AI_USER_IMAGE_MAX_BYTES,
  AI_USER_IMAGE_MAX_EDGE,
  AI_USER_IMAGE_MAX_PIXELS,
  AI_USER_IMAGE_MAX_SOURCE_BYTES,
  AI_USER_IMAGE_MAX_SOURCE_EDGE,
  AI_USER_IMAGE_MAX_SOURCE_PIXELS,
  isAiUserImageSourceMimeType,
  readImageDimensions,
  type AiUserImageBlock,
  type ImageDimensions,
} from '@core/ai'

const JPEG_QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58] as const
const MIN_RESIZE_SCALE = 0.5

export type AgentImageSize = ImageDimensions

/** Fit an image inside both the long-edge and total-pixel policy. */
export function fitAgentImageSize(width: number, height: number): AgentImageSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('Image has invalid dimensions.')
  }
  const edgeScale = Math.min(1, AI_USER_IMAGE_MAX_EDGE / Math.max(width, height))
  const pixelScale = Math.min(1, Math.sqrt(AI_USER_IMAGE_MAX_PIXELS / (width * height)))
  const scale = Math.min(edgeScale, pixelScale)
  return {
    // Floor so rounding can never put the output one pixel beyond the server's
    // edge or area ceiling (notably a square at sqrt(MAX_PIXELS)).
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

/** Decode, resize, strip metadata, and encode one clipboard image as JPEG. */
export async function normaliseAgentImage(
  file: File,
  signal?: AbortSignal,
): Promise<AiUserImageBlock> {
  signal?.throwIfAborted()
  if (!isAiUserImageSourceMimeType(file.type)) {
    throw new Error('Use a PNG, JPEG, or WebP image.')
  }
  if (file.size > AI_USER_IMAGE_MAX_SOURCE_BYTES) {
    throw new Error(`Source image must be smaller than ${formatMegabytes(AI_USER_IMAGE_MAX_SOURCE_BYTES)} MB.`)
  }

  const sourceBytes = new Uint8Array(await file.arrayBuffer())
  signal?.throwIfAborted()
  const sourceSize = readAgentImageSourceSize(sourceBytes, file.type)
  if (
    sourceSize.width > AI_USER_IMAGE_MAX_SOURCE_EDGE
    || sourceSize.height > AI_USER_IMAGE_MAX_SOURCE_EDGE
    || sourceSize.width * sourceSize.height > AI_USER_IMAGE_MAX_SOURCE_PIXELS
  ) {
    throw new Error(
      `Source image dimensions exceed the ${AI_USER_IMAGE_MAX_SOURCE_EDGE}px / ${AI_USER_IMAGE_MAX_SOURCE_PIXELS.toLocaleString()}px limit.`,
    )
  }
  const decodeSize = fitAgentImageSize(sourceSize.width, sourceSize.height)
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
    resizeWidth: decodeSize.width,
    resizeHeight: decodeSize.height,
    resizeQuality: 'high',
  })
  if (signal?.aborted) {
    bitmap.close()
    signal.throwIfAborted()
  }
  try {
    let size = fitAgentImageSize(bitmap.width, bitmap.height)
    for (let resizeAttempt = 0; resizeAttempt < 3; resizeAttempt += 1) {
      const canvas = drawBitmap(bitmap, size)
      let lastBlob: Blob | null = null
      for (const quality of JPEG_QUALITIES) {
        signal?.throwIfAborted()
        const blob = await canvasToJpeg(canvas, quality)
        signal?.throwIfAborted()
        lastBlob = blob
        if (blob.size <= AI_USER_IMAGE_MAX_BYTES) {
          if (blob.type !== 'image/jpeg') {
            throw new Error('This browser could not encode the pasted image as JPEG.')
          }
          const data = await blobToBase64(blob, signal)
          signal?.throwIfAborted()
          return {
            kind: 'image',
            mimeType: 'image/jpeg',
            data,
          }
        }
      }

      if (!lastBlob) break
      const scale = Math.max(
        MIN_RESIZE_SCALE,
        Math.sqrt(AI_USER_IMAGE_MAX_BYTES / lastBlob.size) * 0.9,
      )
      size = {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      }
    }
  } finally {
    bitmap.close()
  }

  throw new Error(`Image could not be reduced below ${formatMegabytes(AI_USER_IMAGE_MAX_BYTES)} MB.`)
}

/**
 * Read raster dimensions from bounded source bytes before allocating a
 * decoder. Thin wrapper over the shared `@core/ai` sniffer — kept as its own
 * export here because it's part of this module's public/tested surface
 * (`agentImageAttachment.test.ts` imports it by this name).
 */
export function readAgentImageSourceSize(
  bytes: Uint8Array,
  mimeType: string,
): AgentImageSize {
  return readImageDimensions(bytes, mimeType)
}

function drawBitmap(bitmap: ImageBitmap, size: AgentImageSize): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot prepare image attachments.')
  // JPEG has no alpha channel. A white matte keeps transparent mockups legible.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  return canvas
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('This browser could not encode the pasted image.'))
    }, 'image/jpeg', quality)
  })
}

async function blobToBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  signal?.throwIfAborted()
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    signal?.throwIfAborted()
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function formatMegabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}
