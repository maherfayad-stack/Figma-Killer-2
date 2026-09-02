/**
 * designImport/shared — primitives shared by the GitHub and npm source
 * fetchers: the error class, the download-size guard, and the source-file
 * acceptance caps. Kept separate from `studioGithubImport.ts`'s own
 * `GithubImportError`/`readBytesWithLimit` because those are tied to a
 * "repository archive" wording — this module's fetches can come from either
 * a GitHub zipball or an npm tarball, so the error text and caps stay
 * source-agnostic here instead of stretching the existing GitHub-specific
 * helper to cover a second, unrelated source.
 */

/** Thrown for every rejection the design-import routes want mapped to a specific HTTP status. */
export class DesignImportError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DesignImportError'
    this.status = status
  }
}

/** Compressed-download cap — rejected before the body is ever fully buffered. */
export const MAX_DESIGN_IMPORT_DOWNLOAD_BYTES = 100 * 1024 * 1024 // 100 MB

/** Only files at or under this size are scanned for tokens — mirrors `WORKSPACE_MAX_FILE_BYTES`'s intent, scoped to token sources specifically. */
export const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024 // 2 MB

/** Hard cap on how many source files (CSS + token files combined) a single import scans, independent of the source's total file count. */
export const MAX_SOURCE_FILES = 200

/**
 * A non-CSS file is only fetched/scanned when its NAME looks like a token
 * definition (contains "token", or is a conventionally-named `theme.json`) —
 * unlike `.css`, which is accepted unconditionally. Repos ship a LOT of
 * arbitrary `.json`/`.ts`/`.js`, most of it irrelevant (package.json,
 * tsconfig.json, application code); scanning all of it would be slow, noisy,
 * and could pull in huge unrelated files. `.css` needs no such filename
 * check because stylesheets are inherently in-scope for a "design tokens"
 * import regardless of what they're called.
 */
const TOKEN_FILENAME_RE = /token|^theme\.json$/i

/** True when `relPath`'s extension + name make it worth scanning as a token file (JSON or a plain-object JS/TS module). */
export function isCandidateTokenFile(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  const isTokenExt = /\.(json|ts|tsx|js|jsx|mjs|cjs)$/.test(lower)
  if (!isTokenExt) return false
  const basename = lower.split('/').pop() ?? lower
  return TOKEN_FILENAME_RE.test(basename)
}

/**
 * Reads a Response body into memory, aborting once `maxBytes` is exceeded
 * (checking `content-length` up front, then the actual streamed byte count —
 * a spoofed/missing header can't bypass the cap). Mirrors
 * `studioGithubImport.ts`'s `readBytesWithLimit`, generalized to a
 * source-agnostic error/message since this backs both the GitHub and npm
 * fetchers.
 */
export async function readBytesWithLimit(res: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = res.headers.get('content-length')
  if (contentLength) {
    const parsed = Number(contentLength)
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new DesignImportError(
        `The source archive is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB import limit.`,
        413,
      )
    }
  }

  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(await res.arrayBuffer())

  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new DesignImportError(
        `The source archive is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB import limit.`,
        413,
      )
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

/** One text file fetched from a source, ready for token extraction (and, for CSS, project copy-back). */
export interface FetchedTextFile {
  /** Path relative to the source root, POSIX separators. */
  relPath: string
  contents: string
}

/**
 * Result of fetching a design-import source, capped by `MAX_SOURCE_FILES`/
 * `MAX_SOURCE_FILE_BYTES`. Split into two roles:
 *   - `cssFiles` — every `.css` file found. Scanned for tokens AND eligible
 *     to be copied verbatim into the project (the "and the css also" half of
 *     this feature) — a stylesheet is directly reusable as CSS.
 *   - `tokenFiles` — JSON/TS/JS files whose NAME looks like a token
 *     definition (`isCandidateTokenFile`). Scanned for tokens only; never
 *     offered for project copy-back (a raw `tokens.ts` isn't a stylesheet).
 */
export interface FetchedSource {
  /** Human-readable label for the source, e.g. `"owner/repo"` or `"open-props@1.7.0"`. */
  label: string
  cssFiles: FetchedTextFile[]
  tokenFiles: FetchedTextFile[]
  /** True when the source had more matching files than `MAX_SOURCE_FILES` — some were skipped. */
  truncated: boolean
}
