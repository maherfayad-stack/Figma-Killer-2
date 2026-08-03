import { Type, type Static } from '@core/utils/typeboxHelpers'
import { AI_USER_IMAGE_SOURCE_MIME_TYPES, isAiUserImageSourceMimeType } from './userImage'

/**
 * A design reference is a project artifact used for pixel-diffing — NOT a
 * chat attachment. `userImage.ts`'s `AI_USER_IMAGE_*` policy bounds what a
 * vision model is shown in a turn (re-encoded to a bounded JPEG); it is
 * deliberately left untouched by this module. A design reference is never
 * sent to a model as an image block at all — it is uploaded losslessly
 * (original bytes, original dimensions, PNG stays PNG) and handed to a
 * server-side pixel-diff tool that needs the real bytes to produce an
 * honest score. See `docs/features/*` (WS-9 fidelity tooling) for the
 * consumer side.
 *
 * Cap justification for `DESIGN_REFERENCE_MAX_BYTES` — lossless is not
 * unlimited: a 3x Figma export of a tall mobile screen (e.g. a 390pt-wide,
 * 3000-8000pt-tall scrolling marketing page → ~1170x9000-24000px at 3x) as a
 * 24-bit PNG with photography/gradients commonly weighs 15-40 MB; a WebP or
 * JPEG export of the same content is smaller. 50 MB leaves comfortable
 * headroom above that real-world ceiling while still bounding the
 * worst-case disk/memory cost of a single reference upload.
 */
export const DESIGN_REFERENCE_ACCEPTED_MIME_TYPES = AI_USER_IMAGE_SOURCE_MIME_TYPES
export const DESIGN_REFERENCE_MAX_BYTES = 50 * 1024 * 1024

/**
 * Sanity ceiling on DECLARED pixel dimensions. This path never resizes —
 * these exist only to reject a decode-bomb-shaped file (a tiny byte count
 * claiming an enormous canvas) before it ever reaches an upload or a
 * server-side diff step. Comfortably above any real composite export
 * (e.g. a 36-megapixel 3000x12000 tall-page capture).
 */
export const DESIGN_REFERENCE_MAX_EDGE = 20_000
export const DESIGN_REFERENCE_MAX_PIXELS = 120_000_000

/**
 * Wire shape for one uploaded design reference — mirrors
 * `server/handlers/studio/designReferenceSchema.ts`'s `DesignReferenceSchema`
 * (the durable `.studio/references/manifest.json` entry shape) field-for-
 * field, so a browser upload route that lands on `registerDesignReference`
 * can return its result here unmodified. `id`/`relPath`/`contentHash`/
 * `createdAt` are server-assigned; `width`/`height`/`sizeBytes` are the
 * server's OWN measurement of the landed file (probed via `sharp`) — never
 * whatever the browser sniffed before upload. `ext` is intentionally the
 * server's full raster set (including `gif`/`avif`, which this browser path
 * does not offer for upload — see `DESIGN_REFERENCE_ACCEPTED_MIME_TYPES`)
 * so restoring an existing reference registered some other way (e.g. a
 * future `studio_register_design_reference` MCP call) still validates.
 * Left permissive (no `additionalProperties: false`) so a field the server
 * side adds later doesn't break this client's validation.
 */
export const DesignReferenceMetaSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  ext: Type.Union([
    Type.Literal('png'),
    Type.Literal('jpg'),
    Type.Literal('gif'),
    Type.Literal('webp'),
    Type.Literal('avif'),
  ]),
  mimeType: Type.String({ minLength: 1 }),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  contentHash: Type.String({ minLength: 1 }),
  relPath: Type.String({ minLength: 1 }),
  createdAt: Type.String({ minLength: 1 }),
  pageId: Type.Optional(Type.String({ minLength: 1 })),
  /** Human-readable name — this browser path uploads the picked file's own name here. */
  label: Type.Optional(Type.String({ minLength: 1 })),
  source: Type.Optional(Type.String({ minLength: 1 })),
})
export type DesignReferenceMeta = Static<typeof DesignReferenceMetaSchema>

/** Field-local validation before a design reference ever reaches the network. */
export function validateDesignReferenceFile(file: File): string | null {
  if (!isAiUserImageSourceMimeType(file.type)) {
    return 'Use a PNG, JPEG, or WebP image.'
  }
  if (file.size === 0) return 'The file is empty.'
  if (file.size > DESIGN_REFERENCE_MAX_BYTES) {
    return `Design references must be smaller than ${Math.round(DESIGN_REFERENCE_MAX_BYTES / (1024 * 1024))} MB.`
  }
  return null
}

/** Sanity-checks dimensions read from the file's own header (best-effort, pre-upload). */
export function validateDesignReferenceDimensions(width: number, height: number): string | null {
  if (width > DESIGN_REFERENCE_MAX_EDGE || height > DESIGN_REFERENCE_MAX_EDGE) {
    return `Image dimensions exceed the ${DESIGN_REFERENCE_MAX_EDGE.toLocaleString()}px limit.`
  }
  if (width * height > DESIGN_REFERENCE_MAX_PIXELS) {
    return `Image is larger than the ${DESIGN_REFERENCE_MAX_PIXELS.toLocaleString()}px area limit.`
  }
  return null
}
