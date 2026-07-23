/**
 * studioGithubImport — Phase 7B: "paste a GitHub repo URL, get a studio
 * workspace". Import is "fetch source, then load it via the Phase 7A
 * multi-file loader" — this module owns exactly the fetch-and-write step;
 * `/admin/api/studio/load` (see `server/handlers/studio.ts`) is unchanged and
 * does all the parsing, same as it already does for the hand-authored
 * `studio-workspace/`.
 *
 * Flow (`runGithubImport`):
 *   1. `parseGithubRepoUrl` — pure URL → `{ owner, repo }`, rejecting anything
 *      that isn't `https://github.com/<owner>/<repo>` (`.git` suffix and a
 *      trailing slash tolerated; extra path segments like `/tree/main` are
 *      ignored rather than rejected, since that's what a browser address-bar
 *      copy/paste actually looks like).
 *   2. `buildGithubZipballUrl` — the GitHub REST zipball endpoint
 *      (`/repos/{owner}/{repo}/zipball/{ref}`), not `codeload.github.com` —
 *      the API endpoint resolves `HEAD` to the repo's default branch, so we
 *      never have to guess `main` vs `master`. Private repos need `token`,
 *      sent as `Authorization: Bearer <token>` — never read from env, never
 *      logged.
 *   3. The response body is read through `readBytesWithLimit`, capped at
 *      `MAX_IMPORT_DOWNLOAD_BYTES` — a huge/hostile archive is rejected before
 *      it is ever fully buffered.
 *   4. `unzipSync(bytes, { filter })` — fflate's filter callback runs BEFORE
 *      each entry is inflated, so path-traversal / excluded-dir / per-file /
 *      total-size / file-count rejection all happen without ever allocating
 *      the rejected entry's decompressed bytes (the zip-bomb mitigation).
 *      `resolveZipEntryRelPath` is the pure per-entry decision: strips the
 *      zipball's top-level `<repo>-<sha>/` folder, applies `subdir` scoping,
 *      and runs the same path-traversal / excluded-dir guard the download
 *      export already relies on (`EXCLUDED_WORKSPACE_DIR_NAMES`).
 *   5. The target directory — `studio-workspace-imports/<owner>-<repo>/` by
 *      default, never the user's hand-authored `studio-workspace/` — is
 *      cleared and repopulated. Clearing is safe here specifically because
 *      this per-repo directory IS the explicit target of this operation (the
 *      CLAUDE.md rule against deleting a non-explicit target does not apply);
 *      it also means re-importing the same repo doesn't leave stale files
 *      behind after an upstream rename/delete.
 *
 * Safety model: nothing fetched here is ever executed — this module only
 * writes bytes to disk; parsing back into pages happens later, statically,
 * through ts-morph (`/admin/api/studio/load`), same as any other workspace.
 */
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { unzipSync, type Unzipped } from 'fflate'
import {
  EXCLUDED_WORKSPACE_DIR_NAMES,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_FILES,
} from '@core/page-parser'

/** Compressed-download cap — rejected before the body is ever fully buffered. */
const MAX_IMPORT_DOWNLOAD_BYTES = 100 * 1024 * 1024 // 100 MB

/**
 * Aggregate *uncompressed* budget across every accepted file. Bounds the
 * worst case memory footprint of `unzipSync`'s output independently of the
 * per-file (`WORKSPACE_MAX_FILE_BYTES`) and file-count (`WORKSPACE_MAX_FILES`)
 * caps — those two alone could still add up to tens of GB.
 */
const MAX_IMPORT_TOTAL_BYTES = 300 * 1024 * 1024 // 300 MB

/** Thrown for every rejection `runGithubImport` wants mapped to a specific HTTP status. */
export class GithubImportError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'GithubImportError'
    this.status = status
  }
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
/** GitHub owner/repo names: alphanumeric plus `-`, `_`, `.`. */
const SAFE_REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/

/**
 * Parses a GitHub repository URL into `{ owner, repo }`. Pure — no network,
 * no filesystem. Accepts `https://github.com/owner/repo`, tolerating a
 * trailing `.git`, a trailing slash, and extra path segments after the repo
 * name (e.g. `/tree/main`, from copying the address bar on a branch view).
 * Returns `null` for anything else: wrong host, non-http(s) protocol, a
 * missing repo segment, or an owner/repo containing characters outside
 * GitHub's safe segment charset.
 */
export function parseGithubRepoUrl(input: string): { owner: string; repo: string } | null {
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) return null

  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/i, '')
  if (!SAFE_REPO_SEGMENT.test(owner) || !SAFE_REPO_SEGMENT.test(repo)) return null

  return { owner, repo }
}

/**
 * The GitHub REST zipball endpoint for `owner/repo` at `ref` (branch, tag, or
 * commit SHA). `ref` defaults to `HEAD`, which the API resolves to the
 * repository's current default branch — this is why we use the API endpoint
 * rather than `codeload.github.com/<owner>/<repo>/zip/refs/heads/<branch>`,
 * which requires already knowing the branch name.
 */
export function buildGithubZipballUrl(owner: string, repo: string, ref?: string): string {
  const safeRef = ref && ref.trim().length > 0 ? ref.trim() : 'HEAD'
  return `https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(safeRef)}`
}

/** True when every path segment is a plain name — no traversal, no absolute path, no drive letter. */
function isSafeRelPath(relPath: string): boolean {
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

/**
 * Resolves one zip entry's name to the workspace-relative path it should be
 * written to, or `null` when the entry should be skipped silently (a
 * directory entry, the zipball's own root folder, outside the requested
 * `subdir`, or — the path-traversal guard — anything that would normalize
 * outside the target directory). Pure; unit-tested directly against raw zip
 * entry names, no filesystem or network involved.
 *
 * GitHub zipballs always nest content under one top-level `<repo>-<sha>/`
 * folder; that prefix is stripped unconditionally (whatever it's actually
 * named — we never assume the exact `owner-repo-sha` shape).
 */
export function resolveZipEntryRelPath(entryName: string, subdir?: string): string | null {
  if (entryName.endsWith('/')) return null // directory entry — nothing to write

  const firstSlash = entryName.indexOf('/')
  if (firstSlash === -1) return null // no root folder to strip — not a shape we expect; skip defensively
  const withoutRoot = entryName.slice(firstSlash + 1)
  if (withoutRoot.length === 0) return null

  let rel = withoutRoot
  if (subdir) {
    const normalizedSubdir = subdir.replace(/^\/+/, '').replace(/\/+$/, '')
    if (normalizedSubdir.length === 0 || !isSafeRelPath(normalizedSubdir)) return null
    const prefix = `${normalizedSubdir}/`
    if (!rel.startsWith(prefix)) return null
    rel = rel.slice(prefix.length)
    if (rel.length === 0) return null
  }

  return isSafeRelPath(rel) ? rel : null
}

/** Default, repo-scoped import target — never the hand-authored `studio-workspace/`. */
export function defaultGithubImportDir(owner: string, repo: string): string {
  return join(process.cwd(), 'studio-workspace-imports', `${owner}-${repo}`)
}

/**
 * Reads a Response body into memory, aborting once `maxBytes` is exceeded
 * (checking `content-length` up front, then the actual streamed byte count —
 * a spoofed/missing header can't bypass the cap). Mirrors `readJsonWithLimit`
 * in `server/http.ts`, adapted for a binary body instead of JSON.
 */
async function readBytesWithLimit(res: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = res.headers.get('content-length')
  if (contentLength) {
    const parsed = Number(contentLength)
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new GithubImportError(
        `The repository archive is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB import limit.`,
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
      throw new GithubImportError(
        `The repository archive is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB import limit.`,
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

export interface GithubImportOptions {
  url: string
  ref?: string
  subdir?: string
  /** Sent as `Authorization: Bearer <token>` — never logged, never read from env. */
  token?: string
  /** Overrides the default `studio-workspace-imports/<owner>-<repo>` target — mainly for tests. */
  dir?: string
}

export interface GithubImportOutcome {
  dir: string
  files: number
  skipped: number
}

export interface GithubImportDeps {
  fetchImpl?: typeof fetch
}

/**
 * Fetches a GitHub repo's zipball and writes it into a studio workspace
 * directory. Throws `GithubImportError` (carrying an HTTP status the route
 * handler maps straight through) for every rejection: a bad URL, a missing
 * ref/private-without-token repo, an oversized archive, or a corrupt zip.
 * Everything else (fs errors, etc.) propagates as a plain `Error` — the route
 * handler's catch-all maps that to 500.
 */
export async function runGithubImport(
  options: GithubImportOptions,
  deps: GithubImportDeps = {},
): Promise<GithubImportOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch

  const parsedRepo = parseGithubRepoUrl(options.url)
  if (!parsedRepo) {
    throw new GithubImportError(
      'Not a valid GitHub repository URL — expected https://github.com/<owner>/<repo>.',
      400,
    )
  }
  const { owner, repo } = parsedRepo

  const zipUrl = buildGithubZipballUrl(owner, repo, options.ref)
  const headers: Record<string, string> = { 'user-agent': 'instatic-studio-import' }
  if (options.token) headers.authorization = `Bearer ${options.token}`

  let res: Response
  try {
    res = await fetchImpl(zipUrl, { headers })
  } catch (err) {
    throw new GithubImportError(
      `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new GithubImportError(
        `Repository "${owner}/${repo}"${options.ref ? ` at ref "${options.ref}"` : ''} was not found. ` +
          `Check the URL/branch, or supply a token if the repository is private.`,
        404,
      )
    }
    if (res.status === 401 || res.status === 403) {
      throw new GithubImportError(
        'GitHub denied the request — check the token, or the repository visibility.',
        res.status,
      )
    }
    throw new GithubImportError(
      `GitHub returned an unexpected status (${res.status}) while fetching the archive.`,
      502,
    )
  }

  const zipBytes = await readBytesWithLimit(res, MAX_IMPORT_DOWNLOAD_BYTES)

  let skipped = 0
  let totalBytes = 0
  const nameToRelPath = new Map<string, string>()

  let zip: Unzipped
  try {
    zip = unzipSync(zipBytes, {
      filter(file) {
        const relPath = resolveZipEntryRelPath(file.name, options.subdir)
        if (relPath === null) return false // directory entry / outside subdir / unsafe — not reported as a skip

        if (file.originalSize > WORKSPACE_MAX_FILE_BYTES) {
          skipped += 1
          return false
        }
        if (nameToRelPath.size >= WORKSPACE_MAX_FILES) {
          skipped += 1
          return false
        }
        if (totalBytes + file.originalSize > MAX_IMPORT_TOTAL_BYTES) {
          skipped += 1
          return false
        }

        totalBytes += file.originalSize
        nameToRelPath.set(file.name, relPath)
        return true
      },
    })
  } catch (err) {
    throw new GithubImportError(
      `The downloaded archive could not be read as a zip: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }

  if (Object.keys(zip).length === 0) {
    throw new GithubImportError(
      'No importable files were found — check the branch/ref and the subdir, if one was given.',
      422,
    )
  }

  const targetDir = resolve(options.dir ?? defaultGithubImportDir(owner, repo))

  // This directory IS the explicit target of the import (never the
  // hand-authored studio-workspace/), so clearing it before repopulating is
  // safe and keeps a re-import of the same repo from leaving stale files
  // behind after an upstream rename/delete.
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  let files = 0
  for (const [entryName, contents] of Object.entries(zip)) {
    const relPath = nameToRelPath.get(entryName)
    if (!relPath) continue
    const fullPath = join(targetDir, ...relPath.split('/'))
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, Buffer.from(contents))
    files += 1
  }

  return { dir: targetDir, files, skipped }
}
