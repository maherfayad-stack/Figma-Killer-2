/**
 * variantStore — the disk half of W9-3's variant seeds: `.studio/variants.json`.
 *
 * ## Why the seed is persisted at all
 *
 * So that "make B but tighter" is an EDIT. A seed that lives only in one
 * chat turn's context is a seed that cannot be revisited: the next turn (or
 * the next session, or a different agent) can only re-roll and hope to land
 * near the thing the user liked. With the set on disk, variant B's exact
 * decisions are addressable — change `density` from `airy` to `compact`,
 * leave the accent, the type contrast and the corners exactly where they
 * were.
 *
 * ## Where it lives, and why not `.studio/cache/`
 *
 * `.studio/variants.json` is a sibling of `.studio/boards.json` and
 * `.studio/meta.json`, for the same reason `designReferenceStore.ts` gives
 * for its own manifest: `.studio/cache/` is disposable output regenerable
 * from the project's own source, and a variant set is the opposite — it is a
 * record of user-facing intent (this brief, these three directions) that
 * nothing can reconstruct once it is gone. Unlike a design reference it is a
 * few KB of JSON, so it is small enough to be carried in git with the
 * project, like `boards.json`.
 *
 * ## Bounded
 *
 * Only the most recent `MAX_STORED_VARIANT_SETS` sets are kept. This file is
 * read whole on every access and returned through a tool result, so it is
 * capped for the same reason every other Studio payload is — an unbounded
 * append log would eventually dominate a chat turn.
 *
 * A hand-edited `variants.json` is untrusted input at the same trust level as
 * `.studio/meta.json`: it is validated against `VariantManifestSchema` on
 * read and degrades to an EMPTY manifest rather than throwing, matching
 * `designReferenceStore.ts`'s `parseJsonWithFallback` posture. Nothing here
 * derives a filesystem path from stored content.
 */
import { randomUUID } from 'node:crypto'
import { readStudioStoreJson, writeStudioStoreJson } from './studioStore'
import {
  EMPTY_VARIANT_MANIFEST,
  VariantManifestSchema,
  type VariantManifest,
  type VariantSeed,
  type VariantSet,
} from './variantSeeds'

/** Enough to hold the sets of one working session; far below anything that would dominate a turn. */
const MAX_STORED_VARIANT_SETS = 20

const VARIANTS_FILE = 'variants.json'

export function readVariantManifest(dir: string): VariantManifest {
  return readStudioStoreJson(dir, VARIANTS_FILE, VariantManifestSchema, EMPTY_VARIANT_MANIFEST)
}

function writeVariantManifest(dir: string, manifest: VariantManifest): void {
  writeStudioStoreJson(dir, VARIANTS_FILE, manifest, { pretty: true })
}

/** Newest first — the order every caller wants, since the set under discussion is almost always the last one generated. */
export function listVariantSets(dir: string): VariantSet[] {
  return [...readVariantManifest(dir).sets].reverse()
}

export function getVariantSet(dir: string, setId: string): VariantSet | null {
  return readVariantManifest(dir).sets.find((s) => s.id === setId) ?? null
}

export interface RecordVariantSetInput {
  readonly baseName: string
  readonly brief: string
  readonly rngSeed: number
  readonly variants: readonly VariantSeed[]
}

/** Append a set and return it, id and timestamp assigned here so the caller never has to invent either. */
export function recordVariantSet(dir: string, input: RecordVariantSetInput): VariantSet {
  const set: VariantSet = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    baseName: input.baseName,
    brief: input.brief,
    rngSeed: input.rngSeed,
    variants: [...input.variants],
  }
  const manifest = readVariantManifest(dir)
  const sets = [...manifest.sets, set].slice(-MAX_STORED_VARIANT_SETS)
  writeVariantManifest(dir, { version: 1, sets })
  return set
}
