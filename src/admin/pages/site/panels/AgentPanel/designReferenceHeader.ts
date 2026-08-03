import { readImageDimensions, type ImageDimensions } from '@core/ai'

/**
 * Enough header bytes to cover PNG `IHDR` (24 bytes), WebP's early chunks,
 * and a JPEG SOF marker even behind an unusually large embedded ICC
 * profile/thumbnail. Reading a bounded prefix — not the whole file — keeps
 * this cheap even for a 30-40 MB lossless reference; the sniff only reads
 * disk, it never decodes pixels.
 */
const HEADER_SNIFF_BYTES = 2 * 1024 * 1024

/**
 * Best-effort intrinsic-size read for a design reference, straight off the
 * file's own container header — no `createImageBitmap`/canvas decode, so
 * this never allocates memory proportional to the image's pixel count.
 * Throws if the header can't be parsed (caller treats that as "unknown for
 * now"; the server's own measurement of the landed file is the source of
 * truth once upload completes).
 */
export async function readDesignReferenceDimensions(file: File): Promise<ImageDimensions> {
  const headerBytes = new Uint8Array(await file.slice(0, HEADER_SNIFF_BYTES).arrayBuffer())
  return readImageDimensions(headerBytes, file.type)
}
