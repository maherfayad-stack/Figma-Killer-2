/**
 * designImport/tarReader — minimal POSIX ustar/GNU-tar reader.
 *
 * npm packages are distributed as `.tgz` (gzip-compressed tar), and no tar
 * library exists in this codebase. The read this needs is narrow — enumerate
 * regular-file entries with a name and byte contents, nothing else (no
 * writing, no permissions/symlinks, no directory entries) — simple enough
 * that a small hand-rolled reader is more direct than adding a dependency for
 * it (same call the zip-entry safety code in `studioGithubImport.ts` already
 * makes: hand-roll the narrow, well-understood parsing this actually needs).
 *
 * Format notes: a tar archive is a sequence of 512-byte header blocks, each
 * followed by the entry's content padded up to the next 512-byte boundary.
 * Two zeroed 512-byte blocks in a row mark the end of the archive.
 *
 * Supported: standard ustar headers, and GNU long-name entries (`typeflag
 * 'L'`) — common enough in real npm tarballs. NOT supported: PAX extended
 * headers (`typeflag 'x'/'g'`) — skipped as unknown entries rather than
 * parsed. npm package trees are typically shallow (`package/lib/foo.css`),
 * so PAX's long-path use case is rare here; a skipped PAX entry just means
 * that one file (almost never one we'd want — PAX headers are metadata, not
 * CSS) doesn't show up, not a corrupted read of everything else.
 */

const BLOCK_SIZE = 512

export interface TarEntry {
  name: string
  contents: Uint8Array
}

function isZeroBlock(buf: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK_SIZE && i < buf.length; i++) {
    if (buf[i] !== 0) return false
  }
  return true
}

function readHeaderString(buf: Uint8Array, offset: number, start: number, length: number): string {
  const slice = buf.subarray(offset + start, offset + start + length)
  const nul = slice.indexOf(0)
  return new TextDecoder().decode(nul === -1 ? slice : slice.subarray(0, nul)).trim()
}

function readHeaderOctal(buf: Uint8Array, offset: number, start: number, length: number): number {
  const raw = readHeaderString(buf, offset, start, length)
  if (raw.length === 0) return 0
  const parsed = Number.parseInt(raw, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Parses a decompressed tar byte stream into its regular-file entries. Best-effort past the first malformed header — returns whatever was read cleanly before it. */
export function readTarEntries(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let pendingLongName: string | null = null

  while (offset + BLOCK_SIZE <= buf.length) {
    if (isZeroBlock(buf, offset)) break // end-of-archive marker

    const typeflag = readHeaderString(buf, offset, 156, 1)
    const size = readHeaderOctal(buf, offset, 124, 12)
    const namePrefix = readHeaderString(buf, offset, 345, 155) // ustar prefix field
    const nameField = readHeaderString(buf, offset, 0, 100)
    const name = pendingLongName ?? (namePrefix ? `${namePrefix}/${nameField}` : nameField)
    pendingLongName = null

    const dataStart = offset + BLOCK_SIZE
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    const contents = buf.subarray(dataStart, Math.min(dataStart + size, buf.length))

    if (typeflag === 'L') {
      // GNU long-name entry: its *contents* is the long name for the NEXT header.
      pendingLongName = new TextDecoder().decode(contents).replace(/\0+$/, '')
    } else if (typeflag === '' || typeflag === '0' || typeflag === '\0') {
      // Regular file (ustar leaves this empty for old-style archives; '0' is the modern flag).
      entries.push({ name, contents })
    }
    // typeflag '5' = directory, '1'/'2' = links, 'x'/'g' = PAX headers — skipped.

    offset = dataStart + paddedSize
  }

  return entries
}
