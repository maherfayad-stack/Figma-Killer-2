/**
 * archiveIngest — the shared engine behind "land a project on disk from an
 * archive or a batch of uploaded files". Two routes drive this module:
 *
 *   - `studioGithubImport.ts`'s `runGithubImport` (a GitHub zipball)
 *   - `studio/importUpload.ts`'s `tryServeStudioIngest` (a user-uploaded
 *     `.zip`, or N files from an `<input webkitdirectory>` folder picker)
 *
 * Both are "fetch/collect entries, decide which ones are safe to write, then
 * write them into a fresh project directory" — this module owns exactly that
 * shared middle step so there is ONE decision function and ONE write path,
 * not a second hand-rolled copy per import source. Nothing here is source-
 * specific: the "strip the archive's single root folder" behaviour (GitHub
 * zipballs always nest content under one `<repo>-<sha>/` folder; a directory
 * upload's caller has typically already stripped it client-side) is a
 * boolean the CALLER passes to `resolveZipEntryRelPath`/
 * `createArchiveEntryDecider`, never a branch inside this engine.
 *
 * Security properties every caller inherits for free:
 *
 *   - **Entry decisions happen before any bytes are read.** `createArchiveEntryDecider`
 *     only ever looks at an entry's NAME and declared SIZE — never its
 *     content — so a caller can reject a hostile entry (a zip-bomb, a
 *     traversal attempt) without ever allocating its decompressed bytes.
 *     For `fflate`'s `unzipSync({ filter })` this happens naturally (the
 *     filter runs before inflation); for an uploaded `File`, `.size` is
 *     known from the browser without ever calling `.arrayBuffer()`.
 *   - **Three independent budgets** — per-file (`WORKSPACE_MAX_FILE_BYTES`),
 *     total uncompressed (`MAX_IMPORT_TOTAL_BYTES`), and file count
 *     (`WORKSPACE_MAX_FILES`) — because any two alone still allow tens of GB
 *     (a huge count of files just under the per-file cap).
 *   - **Traversal/excluded-dir guard** (`isSafeRelPath`) runs on every entry,
 *     rejecting absolute paths, `..`, empty segments, and anything under
 *     `EXCLUDED_WORKSPACE_DIR_NAMES` — checked on BOTH separators, since a
 *     zip entry name is just a string and nothing stops it from containing a
 *     literal backslash regardless of platform.
 *   - **The write target is always cleared through `writeArchiveToWorkspace`**,
 *     which refuses a target containing `.studio/` (real user board/sticky
 *     data with no other copy) before ever calling `rmSync`. No caller
 *     reaches `rmSync`/`writeFileSync` directly.
 *   - **Byte caps are enforced by streamed count, not `content-length`** —
 *     `readBytesWithLimit` checks the header as a fast pre-check ONLY;  the
 *     authoritative check is the running total of bytes actually read off
 *     the stream, so a spoofed/missing header can't bypass the cap.
 *
 * What this module deliberately does NOT do: decide where `targetDir` is —
 * every caller derives that itself (repo owner/name for GitHub, a slugified
 * project name for uploads) and passes it in already resolved. Accepting a
 * caller-supplied target here would make this module a generic recursive-
 * delete primitive.
 */
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { EXCLUDED_WORKSPACE_DIR_NAMES, WORKSPACE_MAX_FILE_BYTES, WORKSPACE_MAX_FILES } from '@core/page-parser'
import { toArrayBuffer } from '../../binary'

/**
 * Aggregate *uncompressed* budget across every accepted file in one archive.
 * Bounds the worst-case memory footprint of unpacking independently of the
 * per-file (`WORKSPACE_MAX_FILE_BYTES`) and file-count (`WORKSPACE_MAX_FILES`)
 * caps — those two alone could still add up to tens of GB.
 */
export const MAX_IMPORT_TOTAL_BYTES = 300 * 1024 * 1024 // 300 MB

/**
 * Compressed-download / raw-request-body cap, shared by the GitHub zipball
 * fetch and the upload route — rejected before the body is ever fully
 * buffered (see `readBytesWithLimit`).
 */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024 // 100 MB

/** Thrown for every rejection a route wants mapped to a specific HTTP status. */
export class ArchiveIngestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ArchiveIngestError'
    this.status = status
  }
}

/**
 * True when every path segment is a plain name — no traversal, no absolute
 * path, no drive letter, no excluded dir anywhere in the path. Split on `/`
 * only because a caller must already have normalized `\` away (a relPath
 * containing a literal backslash is rejected outright below) — Windows
 * accepts backslash separators even inside a value that otherwise looks like
 * a POSIX path, so a check that only inspected `/`-split segments would miss
 * `..\\..\\secret`.
 */
export function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0 || relPath.startsWith('/') || relPath.includes('\\')) return false
  const segments = relPath.split('/')
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.includes(':') &&
      !EXCLUDED_WORKSPACE_DIR_NAMES.has(segment),
  )
}

export interface ResolveEntryRelPathOptions {
  /**
   * Strip the entry's own single top-level path segment before applying any
   * other rule. GitHub zipballs always nest content under one
   * `<repo>-<sha>/` folder (whatever it's actually named — never assume the
   * exact `owner-repo-sha` shape) and pass `true` unconditionally. A
   * directory upload's client already strips the picked folder's own name
   * client-side (see `studio/importUpload.ts`'s doc comment) and passes
   * `false`. An uploaded `.zip` decides per-archive, based on whether every
   * entry shares one common root (`detectSharedZipRoot`).
   */
  stripRootFolder: boolean
  /** Scope the import to one subdirectory of the (post-strip) entry tree. */
  subdir?: string
}

/**
 * Resolves one archive entry's name to the workspace-relative path it should
 * be written to, or `null` when the entry should be skipped silently (a
 * directory entry, the archive's own root folder, outside the requested
 * `subdir`, or — the path-traversal guard — anything that would normalize
 * outside the target directory). Pure; no filesystem or network involved.
 */
export function resolveZipEntryRelPath(entryName: string, options: ResolveEntryRelPathOptions): string | null {
  if (entryName.endsWith('/')) return null // directory entry — nothing to write

  let rel: string
  if (options.stripRootFolder) {
    const firstSlash = entryName.indexOf('/')
    if (firstSlash === -1) return null // no root folder to strip — not a shape we expect; skip defensively
    const withoutRoot = entryName.slice(firstSlash + 1)
    if (withoutRoot.length === 0) return null
    rel = withoutRoot
  } else {
    rel = entryName
  }

  if (options.subdir) {
    const normalizedSubdir = options.subdir.replace(/^\/+/, '').replace(/\/+$/, '')
    if (normalizedSubdir.length === 0 || !isSafeRelPath(normalizedSubdir)) return null
    const prefix = `${normalizedSubdir}/`
    if (!rel.startsWith(prefix)) return null
    rel = rel.slice(prefix.length)
    if (rel.length === 0) return null
  }

  return isSafeRelPath(rel) ? rel : null
}

export interface ArchiveEntryDecider {
  /**
   * Decides whether one entry is accepted, updating the running budgets as a
   * side effect. Returns `true` when accepted (caller should now read the
   * entry's bytes), `false` when rejected (caller must NOT read its bytes —
   * that's the zip-bomb mitigation: a rejected entry is never inflated).
   */
  decide(name: string, size: number): boolean
  /** Original entry name -> destination workspace-relative path, accepted entries only, in decision order. */
  readonly accepted: Map<string, string>
  /** Count of entries seen but rejected by a budget (NOT entries silently skipped as directories/traversal/subdir-mismatch). */
  readonly skipped: number
}

/**
 * The ONE per-entry decision function every archive-ingest route shares.
 * Stateful across a whole archive (an entry-by-entry stream, e.g. `fflate`'s
 * `unzipSync({ filter })`, can only ever see one entry at a time) so the
 * running total/count budgets are enforced correctly regardless of whether
 * the caller has the full entry list up front or not.
 */
export function createArchiveEntryDecider(options: ResolveEntryRelPathOptions): ArchiveEntryDecider {
  const accepted = new Map<string, string>()
  let skipped = 0
  let totalBytes = 0

  return {
    decide(name, size) {
      const relPath = resolveZipEntryRelPath(name, options)
      if (relPath === null) return false // directory entry / outside subdir / unsafe — not counted as a skip

      if (size > WORKSPACE_MAX_FILE_BYTES) {
        skipped += 1
        return false
      }
      if (accepted.size >= WORKSPACE_MAX_FILES) {
        skipped += 1
        return false
      }
      if (totalBytes + size > MAX_IMPORT_TOTAL_BYTES) {
        skipped += 1
        return false
      }

      totalBytes += size
      accepted.set(name, relPath)
      return true
    },
    accepted,
    get skipped() {
      return skipped
    },
  }
}

/**
 * Refuses to touch a target directory that already holds a hand-authored
 * studio workspace — `.studio/` marks real user data (boards, sticky notes)
 * with no other copy. Defense in depth: every caller derives `targetDir`
 * itself, but this check runs no matter which caller asks, so a bug in a
 * future caller's derivation can't turn into silent data loss.
 */
export function refuseIfStudioWorkspace(targetDir: string): void {
  if (existsSync(join(targetDir, '.studio'))) {
    throw new ArchiveIngestError(
      'Refusing to import: the target already contains an existing studio workspace (has a .studio/ directory). Imports must target a directory with no existing workspace data.',
      400,
    )
  }
}

export interface ArchiveIngestOutcome {
  dir: string
  files: number
  skipped: number
}

/**
 * Clears (if safe — see `refuseIfStudioWorkspace`) and repopulates
 * `targetDir` with every accepted entry. The ONLY code path that ever calls
 * `rmSync`/`writeFileSync` for an archive import — every route funnels
 * through here so the `.studio/` guard and the write-target confinement
 * (every `relPath` already passed `isSafeRelPath`, so `join(targetDir, ...)`
 * cannot normalize outside it) are inherited automatically.
 *
 * `readEntryBytes` is called ONLY for accepted entries, and only one at a
 * time (never all up front) — for a zip this reads the already-inflated
 * `Unzipped` map; for an uploaded `File` it awaits `.arrayBuffer()`. Either
 * shape is fine since the return type also accepts a `Promise`.
 */
export async function writeArchiveToWorkspace(
  targetDir: string,
  accepted: ReadonlyMap<string, string>,
  readEntryBytes: (entryName: string) => Uint8Array | Promise<Uint8Array>,
  skipped: number,
): Promise<ArchiveIngestOutcome> {
  refuseIfStudioWorkspace(targetDir)

  // Clearing the target keeps a re-import from leaving stale files behind
  // after an upstream rename/delete. Safe here specifically because
  // `targetDir` IS the explicit target of this operation and every caller
  // derives it server-side (never from a caller-supplied `dir` field).
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  let files = 0
  for (const [entryName, relPath] of accepted) {
    const bytes = await readEntryBytes(entryName)
    const fullPath = join(resolve(targetDir), ...relPath.split('/'))
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, Buffer.from(bytes))
    files += 1
  }

  return { dir: targetDir, files, skipped }
}

/**
 * Reads a `Request`/`Response` body into memory, aborting once `maxBytes` is
 * exceeded (checking `content-length` up front as a fast pre-check, then the
 * actual streamed byte count — a spoofed/missing header can't bypass the
 * cap). Shared by the GitHub zipball fetch (`Response`) and the upload
 * route's raw request body (`Request`) — both shapes expose `headers` +
 * `body: ReadableStream<Uint8Array> | null`.
 */
export async function readBytesWithLimit(
  source: { headers: Headers; body: ReadableStream<Uint8Array> | null; arrayBuffer(): Promise<ArrayBuffer> },
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const contentLength = source.headers.get('content-length')
  if (contentLength) {
    const parsed = Number(contentLength)
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new ArchiveIngestError(tooLargeMessage, 413)
    }
  }

  const reader = source.body?.getReader()
  if (!reader) return new Uint8Array(await source.arrayBuffer())

  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ArchiveIngestError(tooLargeMessage, 413)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Reads a `multipart/form-data` request body capped by streamed byte count
 * (via `readBytesWithLimit`), then hands the buffered bytes to the platform
 * multipart parser via a throwaway `Response`. Reconstructing a `Response`
 * (rather than parsing multipart by hand) means we inherit the same
 * boundary/charset handling `Request.formData()` already has, while still
 * enforcing our own cap instead of trusting `content-length`.
 */
export async function readFormDataWithLimit(req: Request, maxBytes: number): Promise<FormData> {
  const tooLargeMessage = `The upload is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB import limit.`
  const bytes = await readBytesWithLimit(req, maxBytes, tooLargeMessage)
  const contentType = req.headers.get('content-type') ?? ''
  return new Response(toArrayBuffer(bytes), { headers: { 'content-type': contentType } }).formData()
}
