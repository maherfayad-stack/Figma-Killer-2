/**
 * loadDigest — the load path's two ways of saying "this file is the same as
 * it was", and the one hash every load-path cache keys on (P6-B, PERF-8).
 *
 * ## `digestOf` replaces the 32-bit rolling hash
 *
 * `studioLoadMemo.ts`'s workspace fingerprint and `pageParseCache.ts`'s
 * config hash were both `hash = hash * 31 + charCode | 0` — Java's
 * `String.hashCode`. That hash is not merely weak, it is trivially
 * collidable: `"Aa"` and `"BB"` hash alike, so a project whose page
 * `pages/Aa.tsx` became `pages/BB.tsx` with the same size and mtime produced
 * the SAME fingerprint, and the memo served the old page list. A collision
 * there is a stale load, which is a correctness bug rather than a perf trade,
 * so every load-path key is SHA-256 now. Hashing the payload costs
 * microseconds; the work around it (stats, reads) is what costs time.
 *
 * ## Stamps and content digests
 *
 * A **stamp** (`size:mtimeMs`, or {@link MISSING}) is the cheap check: one
 * `stat`. It is what an in-process cache compares, exactly as the caches did
 * before. A **content digest** is what survives a process restart: a stamp
 * means nothing to the next process (a `git checkout` rewrites every mtime
 * without changing a byte, and a same-size edit inside the clock's
 * granularity keeps one), so the on-disk parse cache compares SHA-256 of the
 * bytes instead. {@link fileContentDigest} memoizes digest-by-stamp so a file
 * is only re-read when its stamp moves.
 *
 * ## The race rule: {@link consistentStamps}
 *
 * A cache entry records its dependencies' stamps AFTER the work that read
 * them. A file written in between (while a 40-page parse runs, say) would be
 * recorded with its NEW stamp beside a result computed from its OLD text —
 * and from then on every check says "unchanged". Two cases, two rules:
 *
 *   - a file the work read from a KNOWN version — the kept ts-morph
 *     `Project`'s copy, whose stamp `workspaceProject.ts` recorded before it
 *     read the text — is consistent exactly when that recorded stamp is still
 *     the stamp on disk. No clock involved;
 *   - a file read straight off disk during the work (a `?raw` icon, an image,
 *     a JSON dictionary) has no recorded version, so it is consistent only
 *     when its `mtime` is before the moment the work began, minus
 *     {@link MTIME_SLACK_MS} for clock granularity (on Windows an mtime reads
 *     up to a millisecond EARLIER than a `Date.now()` taken just before the
 *     write, `projectWriteLock.ts` measured). A filesystem with coarse mtimes
 *     (FAT's two seconds) can hide a write inside its granularity; no Studio
 *     workspace is expected to live on one.
 *
 * An inconsistent file means the result is not cached at all. It is
 * recomputed next time, which is the only honest answer.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/** The stamp of a file that does not exist — a dependency on absence is a real dependency. */
export const MISSING = 'missing'

/** Clock-granularity slack for {@link consistentStamps} — see this module's doc. */
export const MTIME_SLACK_MS = 5

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** SHA-256 of `parts`' JSON — the collision-safe key every load-path cache compares. */
export function digestOf(parts: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(parts))
}

interface FileStat {
  stamp: string
  mtimeMs: number | null
}

function statFile(absFile: string): FileStat {
  try {
    const stat = statSync(absFile)
    if (!stat.isFile()) return { stamp: MISSING, mtimeMs: null }
    return { stamp: `${stat.size}:${stat.mtimeMs}`, mtimeMs: stat.mtimeMs }
  } catch (_err) {
    return { stamp: MISSING, mtimeMs: null } // absent or unreadable — both mean "not the bytes we saw"
  }
}

/** `size:mtimeMs`, or {@link MISSING}. */
export function fileStamp(absFile: string): string {
  return statFile(absFile).stamp
}

/**
 * The stamp of each file, or `null` when any of them may have changed while
 * the work that read it ran — a result built from them must not be cached.
 * `knownStamp` answers the stamp of the version the work read, for a file it
 * read from a kept copy (`undefined` otherwise); `startedAtMs` is when the
 * work began. See this module's doc.
 */
export function consistentStamps(
  absFiles: Iterable<string>,
  options: { startedAtMs: number; knownStamp: (absFile: string) => string | undefined },
): Map<string, string> | null {
  const stamps = new Map<string, string>()
  for (const absFile of absFiles) {
    if (stamps.has(absFile)) continue
    const { stamp, mtimeMs } = statFile(absFile)
    const known = options.knownStamp(absFile)
    if (known !== undefined) {
      if (known !== stamp) return null
    } else if (mtimeMs !== null && mtimeMs >= options.startedAtMs - MTIME_SLACK_MS) {
      return null
    }
    stamps.set(absFile, stamp)
  }
  return stamps
}

/** Whether every recorded stamp still matches the disk. */
export function stampsUnchanged(stamps: ReadonlyMap<string, string>): boolean {
  for (const [absFile, stamp] of stamps) {
    if (fileStamp(absFile) !== stamp) return false
  }
  return true
}

/** Digest memo: absolute path → the digest of the bytes it had at `stamp`. Bounded by clearing — it is a pure cache. */
const digestByStamp = new Map<string, { stamp: string; digest: string }>()
const MAX_REMEMBERED_DIGESTS = 50_000

/** A file's content digest (`null` when it does not exist) together with the stamp it had while those bytes were read. */
export interface FileDigest {
  stamp: string
  digest: string | null
}

/**
 * SHA-256 of `absFile`'s bytes, with the stamp that goes with them. Re-reads
 * the file only when its stamp moved since the last call. A file that changes
 * WHILE it is being read (stamp before ≠ stamp after) reports `undefined` —
 * the caller cannot know which bytes it hashed.
 */
export function fileContentDigest(absFile: string): FileDigest | undefined {
  const before = fileStamp(absFile)
  if (before === MISSING) return { stamp: MISSING, digest: null }
  const known = digestByStamp.get(absFile)
  if (known && known.stamp === before) return { stamp: before, digest: known.digest }
  let bytes: Buffer
  try {
    bytes = readFileSync(absFile)
  } catch (_err) {
    return undefined // vanished between the stat and the read
  }
  const digest = sha256Hex(bytes)
  if (fileStamp(absFile) !== before) return undefined
  if (digestByStamp.size >= MAX_REMEMBERED_DIGESTS) digestByStamp.clear()
  digestByStamp.set(absFile, { stamp: before, digest })
  return { stamp: before, digest }
}

/** Test-only: forget every remembered digest. */
export function clearFileDigests(): void {
  digestByStamp.clear()
}
