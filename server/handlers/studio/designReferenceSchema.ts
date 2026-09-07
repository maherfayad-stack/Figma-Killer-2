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

/**
 * `source` recorded on a reference armed from a chat attachment, so a human
 * reading the manifest back — and `designReferenceRole` below — can tell it
 * apart from a deliberate `studio_register_design_reference` call or a file
 * picked through the composer's DESIGN REFERENCE affordance.
 *
 * Lives in the schema leaf rather than beside the code that writes it
 * (`turnDesignReferences.ts`) because reading a legacy manifest entry's role
 * back out is a property of the PERSISTED SHAPE, not of the turn pipeline.
 */
export const CHAT_ATTACHMENT_REFERENCE_SOURCE = 'chat-attachment'

/**
 * What a registered reference IS, which is not the same question as what it
 * looks like.
 *
 * - `spec` — the design this page is supposed to match. Something the user
 *   deliberately pointed at: a Figma export, a file picked through the
 *   composer's DESIGN REFERENCE control, an explicit
 *   `studio_register_design_reference` call.
 * - `context` — an image that arrived in the conversation and is worth
 *   keeping, but was never nominated as the thing to match. Every ordinary
 *   chat attachment lands here: the "why does this look wrong?" crop, a
 *   screenshot of a bug, a photo of a whiteboard.
 *
 * The distinction exists because `registerTurnDesignReferences` registers
 * EVERY chat-attached image durably, and resolution used to pick the most
 * recently registered one. A pasted 943x294 question screenshot therefore
 * silently became the comparison spec for a page whose real Figma frame was
 * registered days earlier, and `studio_compare` then refused on aspect ratio
 * forever. A `context` image never outranks a `spec` one, and becomes the
 * spec only by an explicit gesture (a `referenceId` tool argument, or
 * registering it as `role: 'spec'`).
 */
export const DESIGN_REFERENCE_ROLES = ['spec', 'context'] as const
export type DesignReferenceRole = typeof DESIGN_REFERENCE_ROLES[number]

const DesignReferenceRoleSchema = Type.Union(DESIGN_REFERENCE_ROLES.map((r) => Type.Literal(r)))

/**
 * Per-reference fidelity mode — how strictly this particular design is meant
 * to be matched. Persisted here so it survives the conversation that set it;
 * the resolution precedence that CONSUMES it (tool arg > per-reference >
 * per-turn > per-project > derived) is W9-2's, not this file's. Nothing reads
 * it yet: this is the plumbing, deliberately landed with the role fix so the
 * on-disk shape only changes once.
 */
export const DESIGN_REFERENCE_FIDELITY_MODES = ['creative', 'balanced', 'strict'] as const
export type DesignReferenceFidelityMode = typeof DESIGN_REFERENCE_FIDELITY_MODES[number]

const DesignReferenceFidelityModeSchema = Type.Union(
  DESIGN_REFERENCE_FIDELITY_MODES.map((m) => Type.Literal(m)),
)

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
  /** `spec` (the design to match) or `context` (an image from the conversation). Optional so a manifest written before roles existed still validates — `designReferenceRole` derives it from `source` in that case. */
  role: Type.Optional(DesignReferenceRoleSchema),
  /** How strictly THIS design is meant to be matched. Plumbing for W9-2; nothing reads it yet. */
  mode: Type.Optional(DesignReferenceFidelityModeSchema),
  /** Overall similarity percentage `studio_compare` must reach for THIS reference to pass, overriding the tool default. Plumbing for W9-2; nothing reads it yet. */
  passScore: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  /** The largest share of the frame (percent) any single differing region may cover and still pass, for THIS reference. Plumbing for W9-2; nothing reads it yet. */
  maxRegionCoverage: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
})
export type DesignReference = Static<typeof DesignReferenceSchema>

/**
 * The role of a reference, including one written before the field existed.
 *
 * Old manifests carry no `role`, so it is derived from the one field that
 * already recorded how the reference arrived: `source`. `chat-attachment`
 * (the only value `registerTurnDesignReferences` has ever written) reads as
 * `context`; everything else — a Figma URL, a picked filename, a bare
 * `studio_register_design_reference` call with no source at all — reads as
 * `spec`, because every one of those paths is a person or an agent
 * deliberately naming a design. That is the same conclusion a human reading
 * the old manifest would draw, so no rewrite pass is needed and none is run:
 * an entry gains an explicit `role` only when it is next written.
 */
export function designReferenceRole(reference: DesignReference): DesignReferenceRole {
  if (reference.role !== undefined) return reference.role
  return reference.source === CHAT_ATTACHMENT_REFERENCE_SOURCE ? 'context' : 'spec'
}

export const DesignReferenceManifestSchema = Type.Object({
  version: Type.Literal(1),
  references: Type.Array(DesignReferenceSchema),
})
export type DesignReferenceManifest = Static<typeof DesignReferenceManifestSchema>

export const EMPTY_DESIGN_REFERENCE_MANIFEST: DesignReferenceManifest = { version: 1, references: [] }
