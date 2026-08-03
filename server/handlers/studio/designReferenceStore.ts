/**
 * designReferenceStore — a durable, per-project, addressable-by-id store for
 * design references (typically a Figma export) an agent wants to measure a
 * Studio frame against, instead of eyeballing it.
 *
 * Why this exists (see `docs/features/mcp-connectors.md`'s "Design
 * references" section and `STATE.md`'s handoff for the full reasoning):
 * a design a user pastes into chat is currently a TRANSIENT attachment,
 * re-encoded to a bounded JPEG (`AI_USER_IMAGE_MAX_EDGE`/`_MAX_BYTES`,
 * `src/core/ai/userImage.ts`) for the model's own vision input — lossy,
 * downsampled, and gone once the turn ends. There was no way to say "diff
 * THIS frame against THAT design" on a later turn. This store gives a design
 * reference a durable id, holding the ORIGINAL bytes untouched — re-encoding
 * a measurement baseline would defeat the entire point of measuring against
 * it.
 *
 * Where it lives, and why: `.studio/references/`, a NEW sibling of
 * `.studio/boards.json`/`.studio/meta.json` — deliberately NOT
 * `.studio/cache/`. `.studio/cache/` is gitignored, disposable, regenerable
 * output (compiled styles, rebuilt on demand from the project's own source);
 * a design reference is the opposite of regenerable — it is user-supplied
 * intent, closer in kind to `boards.json` than to a build artefact, and
 * losing it means the user has to re-upload the exact same file. It is NOT
 * placed under `src/assets` either: it is Studio's own bookkeeping, never an
 * `<img>` import target a component would reference.
 *
 * That said, a multi-megabyte PNG is a real, ongoing cost to keep inside a
 * git-tracked project (this matters concretely for THIS repo's own
 * `studio-workspace/*` dev fixtures, which this outer repo's git tracks) —
 * unlike `boards.json`/`meta.json`, whose few-KB JSON is nearly free to
 * carry forever. `.gitignore` therefore excludes `.studio/references/`
 * (binary bytes AND manifest) the same way it already excludes
 * `.studio/cache/`, `daemon.json`, and `install-job.json` — this store is
 * durable ON DISK for the life of a running server / workspace (which is the
 * property "let a tool address it across chat turns" actually needs), not
 * durable across a git clone. A reference lost that way is recovered the
 * same way it arrived: the user re-supplies the file. This is a pragmatic
 * call, not a claim that a design reference is disposable in the same sense
 * cache output is — see `.gitignore`'s own comment at that entry.
 *
 * Write path: `landAssetBytes` (`assetLanding.ts`) — the SAME magic-number
 * sniff / SVG-refusal / collision-safe write pipeline `studio_upload_asset`
 * and `studio_fetch_remote_asset` already use, via the one deliberate
 * `DESIGN_REFERENCE_ASSET_DIR` exception carved into `resolveAssetWriteDir`.
 * There is no second write path here.
 *
 * **Cardinality: many per project, explicitly.** The manifest is a list, not
 * a slot — a real fidelity workflow wants one reference per page/frame
 * (`pageId`-scoped), not one reference for the whole project. `POST
 * /admin/api/studio/reference-upload` (`referenceUpload.ts`), the chat
 * panel's simpler "one currently attached reference" HTTP contract, is a
 * PROJECTION over this same store (`getMostRecentDesignReference` — "most
 * recently registered", not a separate single-slot mode) rather than a
 * second cardinality model living beside it. Two consumers, one store, one
 * on-disk shape.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { isRealpathContained } from './workspacePackageResolve'
import { DESIGN_REFERENCE_ASSET_DIR, landAssetBytes, sniffImageExtension } from './assetLanding'
import {
  DESIGN_REFERENCE_MIME_TYPES,
  DesignReferenceManifestSchema,
  EMPTY_DESIGN_REFERENCE_MANIFEST,
  isDesignReferenceExt,
  type DesignReference,
  type DesignReferenceManifest,
} from './designReferenceSchema'

/** A hand-edited `manifest.json` is untrusted input (same trust level as `.studio/meta.json`) — `readDesignReferenceBytes` re-derives the real file path from `id`+`ext` rather than the manifest's own `relPath` string, so this pattern is what actually gates filesystem access. */
const REFERENCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function referencesDir(dir: string): string {
  return join(dir, ...DESIGN_REFERENCE_ASSET_DIR.split('/'))
}

function manifestFile(dir: string): string {
  return join(referencesDir(dir), 'manifest.json')
}

function readManifest(dir: string): DesignReferenceManifest {
  const file = manifestFile(dir)
  if (!existsSync(file)) return EMPTY_DESIGN_REFERENCE_MANIFEST
  const raw = readFileSync(file, 'utf8')
  return parseJsonWithFallback(raw, DesignReferenceManifestSchema, EMPTY_DESIGN_REFERENCE_MANIFEST)
}

function writeManifest(dir: string, manifest: DesignReferenceManifest): void {
  const file = manifestFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(manifest, null, 2))
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface RegisterDesignReferenceMeta {
  pageId?: string
  label?: string
  source?: string
}

export type RegisterDesignReferenceResult =
  | { ok: true; reference: DesignReference }
  | { ok: false; error: string }

/**
 * Land `bytes` as a new, durable design reference. Order matters: intrinsic
 * dimensions are probed via `sharp` BEFORE anything is written, so an
 * undecodable image never leaves an orphaned file behind. Never re-encodes
 * or downsamples — the bytes written are the bytes given, verbatim (SVG
 * would normally go through `landAssetBytes`'s sanitizer, but SVG is refused
 * outright before that point — see module doc).
 */
export async function registerDesignReference(
  dir: string,
  bytes: Uint8Array,
  meta: RegisterDesignReferenceMeta,
): Promise<RegisterDesignReferenceResult> {
  if (bytes.length === 0) return { ok: false, error: 'No image bytes were provided.' }

  const sniffed = sniffImageExtension(bytes)
  if (sniffed === null) {
    return { ok: false, error: 'The content is not a recognized image format.' }
  }
  if (!isDesignReferenceExt(sniffed)) {
    return {
      ok: false,
      error:
        'Design references must be a raster image (PNG, JPEG, GIF, WEBP, or AVIF) with fixed pixel dimensions — SVG has no fixed intrinsic pixel size to diff against.',
    }
  }

  let width: number | undefined
  let height: number | undefined
  try {
    const probe = await sharp(bytes).metadata()
    width = probe.width
    height = probe.height
  } catch (err) {
    console.error('[designReferenceStore] could not probe image dimensions', err)
    return { ok: false, error: 'Could not decode the image to determine its dimensions.' }
  }
  if (!width || !height) {
    return { ok: false, error: 'The image has no readable intrinsic dimensions.' }
  }

  const id = randomUUID()
  const landed = landAssetBytes(dir, DESIGN_REFERENCE_ASSET_DIR, bytes, id)
  if (!landed.ok) return { ok: false, error: landed.error }

  const reference: DesignReference = {
    id,
    ext: sniffed,
    mimeType: DESIGN_REFERENCE_MIME_TYPES[sniffed],
    width,
    height,
    sizeBytes: bytes.length,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    relPath: landed.relPath,
    createdAt: new Date().toISOString(),
    ...(meta.pageId ? { pageId: meta.pageId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
    ...(meta.source ? { source: meta.source } : {}),
  }

  const manifest = readManifest(dir)
  writeManifest(dir, { ...manifest, references: [...manifest.references, reference] })

  return { ok: true, reference }
}

// ---------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

export interface ListDesignReferencesResult {
  references: DesignReference[]
  totalCount: number
  truncated: boolean
  omittedCount: number
}

/** Capped, never a silent drop — `truncated`/`omittedCount` are always honest. */
export function listDesignReferences(
  dir: string,
  pageId: string | undefined,
  limit: number | undefined,
): ListDesignReferencesResult {
  const all = readManifest(dir).references.filter((r) => !pageId || r.pageId === pageId)
  const cap = Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT))
  const shown = all.slice(0, cap)
  return {
    references: shown,
    totalCount: all.length,
    truncated: all.length > shown.length,
    omittedCount: all.length - shown.length,
  }
}

export function getDesignReference(dir: string, referenceId: string): DesignReference | null {
  if (!REFERENCE_ID_PATTERN.test(referenceId)) return null
  return readManifest(dir).references.find((r) => r.id === referenceId) ?? null
}

/**
 * The most recently REGISTERED reference, or `null` if none exist —
 * `POST /admin/api/studio/reference-upload`'s GET projects this as "the
 * project's currently attached reference" for the chat panel's simpler
 * one-attachment mental model. This is a read-time projection over the
 * many-reference store, not a second storage mode: the manifest itself
 * still holds every reference ever registered (until explicitly removed),
 * addressable by id through `getDesignReference`/`listDesignReferences`.
 */
export function getMostRecentDesignReference(dir: string): DesignReference | null {
  const { references } = readManifest(dir)
  return references.length > 0 ? references[references.length - 1]! : null
}

/**
 * Read a registered reference's ORIGINAL bytes back off disk. Deliberately
 * ignores the manifest's own `relPath` field for the actual filesystem
 * access — see `REFERENCE_ID_PATTERN`'s doc comment — and re-derives the
 * path from `id` (pattern-checked) + `ext` (a closed enum) instead. Symlink
 * escape (a GitHub-imported project can contain one) is caught by
 * `isRealpathContained`, the same guard `studio_read_file` uses.
 */
export function readDesignReferenceBytes(dir: string, reference: DesignReference): Uint8Array | null {
  if (!REFERENCE_ID_PATTERN.test(reference.id) || !isDesignReferenceExt(reference.ext)) return null
  const abs = join(referencesDir(dir), `${reference.id}.${reference.ext}`)
  if (!isRealpathContained(abs, dir)) return null
  try {
    return new Uint8Array(readFileSync(abs))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export interface RemoveDesignReferenceResult {
  removed: boolean
}

/**
 * Remove a registered reference by id: deletes its manifest entry AND its
 * on-disk bytes. **Idempotent** — removing an id that doesn't exist (already
 * removed, never existed, or malformed) returns `{ removed: false }`, never
 * an error, because the caller-visible state ("is this reference gone") is
 * identical either way — this is what `POST /admin/api/studio/
 * reference-upload`'s DELETE and `studio_delete_design_reference` both rely
 * on to stay a plain `{ ok: true }` regardless of a double-click or a stale
 * id.
 */
export function removeDesignReference(dir: string, referenceId: string): RemoveDesignReferenceResult {
  const manifest = readManifest(dir)
  const target = manifest.references.find((r) => r.id === referenceId)
  if (!target) return { removed: false }

  writeManifest(dir, { ...manifest, references: manifest.references.filter((r) => r.id !== referenceId) })

  // Best-effort file cleanup, AFTER the manifest write above — every reader
  // (`getDesignReference`/`listDesignReferences`) already treats "not in the
  // manifest" as "does not exist", so a failed unlink here (already gone, a
  // fresh clone that never had the gitignored bytes) does not change the
  // outcome this function reports.
  if (isDesignReferenceExt(target.ext)) {
    try {
      unlinkSync(join(referencesDir(dir), `${target.id}.${target.ext}`))
    } catch {
      // Already gone — not a failure.
    }
  }

  return { removed: true }
}
