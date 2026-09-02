/**
 * designReferenceSchema — the persisted shape of one entry in
 * `.studio/references/manifest.json` (see `designReferenceStore.ts`).
 *
 * Kept as its own schema leaf, same split `projectProfileSchema.ts` uses
 * relative to `projectProbe.ts`: `designReferenceStore.ts` both READS and
 * WRITES this shape, so the schema can't live inside it without becoming a
 * self-import.
 *
 * **This is the shared wire contract.** `@core/ai`'s `designReferenceImage.ts`
 * (`DesignReferenceMetaSchema`, the chat panel's browser-side type) mirrors
 * this shape field-for-field, so `POST /admin/api/studio/reference-upload`
 * (`referenceUpload.ts`) can return a `registerDesignReference` result
 * unmodified. Do not drift the two schemas independently — a field added
 * here that the panel needs should be added there too, by that file's own
 * owner.
 *
 * Raster formats only — `png`/`jpg`/`gif`/`webp`/`avif`. SVG is deliberately
 * excluded: a design reference exists to be diffed pixel-for-pixel against a
 * rendered frame, and an SVG has no fixed intrinsic pixel size (it scales to
 * its container) to diff against. `designReferenceStore.ts`'s
 * `registerDesignReference` refuses an SVG outright with this reasoning in
 * the error message, before anything is written. The browser upload path
 * only ever offers `png`/`jpg`/`webp` (`DESIGN_REFERENCE_ACCEPTED_MIME_TYPES`);
 * `gif`/`avif` stay in this server-side set so a reference registered another
 * way (a `studio_register_design_reference` MCP call fed a URL or base64
 * bytes) still validates against the shared schema.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const DESIGN_REFERENCE_EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'avif'] as const
export type DesignReferenceExt = typeof DESIGN_REFERENCE_EXTENSIONS[number]

const DesignReferenceExtSchema = Type.Union(
  DESIGN_REFERENCE_EXTENSIONS.map((ext) => Type.Literal(ext)),
)

export function isDesignReferenceExt(ext: string): ext is DesignReferenceExt {
  return (DESIGN_REFERENCE_EXTENSIONS as readonly string[]).includes(ext)
}

/** `ext` -> the MIME type reported alongside it (e.g. in an MCP image block, or the HTTP upload response). */
export const DESIGN_REFERENCE_MIME_TYPES: Record<DesignReferenceExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

export const DesignReferenceSchema = Type.Object({
  /** UUID v4, generated at registration — the address every tool uses. Also the on-disk filename stem (`<id>.<ext>`), never a caller-supplied name. */
  id: Type.String({ minLength: 1 }),
  ext: DesignReferenceExtSchema,
  mimeType: Type.String({ minLength: 1 }),
  /** Intrinsic pixel dimensions, probed once at registration via `sharp` — never re-derived from a caller's claim. */
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  /** sha256 of the ORIGINAL bytes (before any use) — lets a caller verify integrity or notice a re-registration of identical content. Not used as the identity key; `id` is. */
  contentHash: Type.String({ minLength: 1 }),
  /** Display-only. Never trusted for a filesystem read — see `designReferenceStore.ts`'s `readDesignReferenceBytes`, which re-derives the real path from `id`+`ext` instead, since this manifest is plain hand-editable JSON. */
  relPath: Type.String({ minLength: 1 }),
  createdAt: Type.String({ minLength: 1 }),
  /** Which Studio page/frame this is a reference FOR, when known. Optional — a reference can be registered before the caller has decided, or apply generally. */
  pageId: Type.Optional(Type.String({ minLength: 1 })),
  /** Human-readable name, e.g. "Homepage hero — Figma export". The browser upload path stores the picked file's own name here. */
  label: Type.Optional(Type.String({ minLength: 1 })),
  /** Free-form provenance, e.g. a Figma file/node URL or "pasted by user". */
  source: Type.Optional(Type.String({ minLength: 1 })),
})
export type DesignReference = Static<typeof DesignReferenceSchema>

export const DesignReferenceManifestSchema = Type.Object({
  version: Type.Literal(1),
  references: Type.Array(DesignReferenceSchema),
})
export type DesignReferenceManifest = Static<typeof DesignReferenceManifestSchema>

export const EMPTY_DESIGN_REFERENCE_MANIFEST: DesignReferenceManifest = { version: 1, references: [] }
