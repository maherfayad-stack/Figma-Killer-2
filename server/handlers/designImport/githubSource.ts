/**
 * designImport/githubSource — fetches a GitHub repo's zipball and returns
 * every matching source file found (in memory — nothing is written to disk
 * here; that only happens if the user applies the import, via a separate
 * "copy CSS" step). Reuses `studioGithubImport.ts`'s URL parsing + zipball
 * URL builder, and `studio/archiveIngest.ts`'s zip-entry path-traversal
 * guard (`resolveZipEntryRelPath`, `stripRootFolder: true` — a GitHub
 * zipball always nests under one root folder) — the exact same trusted
 * fetch, just filtered to token-scannable files instead of writing every
 * file to a project directory. `.css` files are unconditionally accepted;
 * JSON/JS/TS files are accepted only when their name looks like a token
 * definition — see `isCandidateTokenFile`.
 */
import { unzipSync, type Unzipped } from 'fflate'
import { buildGithubZipballUrl, parseGithubRepoUrl } from '../studioGithubImport'
import { resolveZipEntryRelPath } from '../studio/archiveIngest'
import {
  DesignImportError,
  isCandidateTokenFile,
  MAX_DESIGN_IMPORT_DOWNLOAD_BYTES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_FILES,
  readBytesWithLimit,
  type FetchedSource,
} from './shared'

export interface GithubSourceOptions {
  url: string
  ref?: string
  subdir?: string
  token?: string
}

export interface GithubSourceDeps {
  fetchImpl?: typeof fetch
}

/**
 * Fetches `options.url`'s zipball and returns every CSS/token-file candidate
 * it contains (after the same root-folder-stripping + subdir-scoping +
 * path-traversal guard `runGithubImport` uses). Throws `DesignImportError`
 * for every user-facing rejection — bad URL, network failure, GitHub error
 * status, oversized archive, corrupt zip, or zero matching files found.
 */
export async function fetchGithubCssSource(
  options: GithubSourceOptions,
  deps: GithubSourceDeps = {},
): Promise<FetchedSource> {
  const fetchImpl = deps.fetchImpl ?? fetch

  const parsedRepo = parseGithubRepoUrl(options.url)
  if (!parsedRepo) {
    throw new DesignImportError(
      'Not a valid GitHub repository URL — expected https://github.com/<owner>/<repo>.',
      400,
    )
  }
  const { owner, repo } = parsedRepo

  const zipUrl = buildGithubZipballUrl(owner, repo, options.ref)
  const headers: Record<string, string> = { 'user-agent': 'studio-design-import' }
  if (options.token) headers.authorization = `Bearer ${options.token}`

  let res: Response
  try {
    res = await fetchImpl(zipUrl, { headers })
  } catch (err) {
    throw new DesignImportError(
      `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new DesignImportError(
        `Repository "${owner}/${repo}"${options.ref ? ` at ref "${options.ref}"` : ''} was not found. ` +
          `Check the URL/branch, or supply a token if the repository is private.`,
        404,
      )
    }
    if (res.status === 401 || res.status === 403) {
      throw new DesignImportError(
        'GitHub denied the request — check the token, or the repository visibility.',
        res.status,
      )
    }
    throw new DesignImportError(
      `GitHub returned an unexpected status (${res.status}) while fetching the archive.`,
      502,
    )
  }

  const zipBytes = await readBytesWithLimit(res, MAX_DESIGN_IMPORT_DOWNLOAD_BYTES)

  let truncated = false
  const decoder = new TextDecoder()
  const relPathByEntry = new Map<string, string>()
  let acceptedCount = 0

  let zip: Unzipped
  try {
    zip = unzipSync(zipBytes, {
      filter(file) {
        const relPath = resolveZipEntryRelPath(file.name, { stripRootFolder: true, subdir: options.subdir })
        if (relPath === null) return false
        const lower = relPath.toLowerCase()
        if (!lower.endsWith('.css') && !isCandidateTokenFile(relPath)) return false
        if (file.originalSize > MAX_SOURCE_FILE_BYTES) return false
        if (acceptedCount >= MAX_SOURCE_FILES) {
          truncated = true
          return false
        }
        acceptedCount += 1
        relPathByEntry.set(file.name, relPath)
        return true
      },
    })
  } catch (err) {
    throw new DesignImportError(
      `The downloaded archive could not be read as a zip: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }

  if (Object.keys(zip).length === 0) {
    throw new DesignImportError(
      'No .css or token files were found — check the branch/ref and the subdir, if one was given.',
      422,
    )
  }

  const cssFiles: FetchedSource['cssFiles'] = []
  const tokenFiles: FetchedSource['tokenFiles'] = []
  for (const [name, contents] of Object.entries(zip)) {
    const relPath = relPathByEntry.get(name)!
    const file = { relPath, contents: decoder.decode(contents) }
    if (relPath.toLowerCase().endsWith('.css')) cssFiles.push(file)
    else tokenFiles.push(file)
  }

  return { label: `${owner}/${repo}`, cssFiles, tokenFiles, truncated }
}
