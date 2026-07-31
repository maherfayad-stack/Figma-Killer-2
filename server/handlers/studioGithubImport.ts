/**
 * studioGithubImport — Phase 7B: "paste a GitHub repo URL, get a studio
 * workspace". Import is "fetch source, then load it via the Phase 7A
 * multi-file loader" — this module owns exactly the fetch-and-write step;
 * `/admin/api/studio/load` (see `server/handlers/studio.ts`) is unchanged and
 * does all the parsing, same as it already does for the hand-authored
 * `studio-workspace/`.
 *
 * This is one of TWO fetch strategies over `studio/archiveIngest.ts`'s
 * shared ingest engine — the other is `studio/importUpload.ts` (an uploaded
 * `.zip` or a picked folder). Everything about "which entries are safe,
 * which budgets apply, how the target directory gets cleared and
 * repopulated" lives in that shared module; this file owns only what's
 * actually GitHub-specific: parsing the URL, building the zipball request,
 * and fetching it.
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
 *   3. The response body is read through `readBytesWithLimit` (shared),
 *      capped at `MAX_ARCHIVE_BYTES` — a huge/hostile archive is rejected
 *      before it is ever fully buffered.
 *   4. `unzipSync(bytes, { filter })` — fflate's filter callback runs BEFORE
 *      each entry is inflated, driven by the shared `createArchiveEntryDecider`
 *      (`stripRootFolder: true` — a GitHub zipball always nests content under
 *      one top-level `<repo>-<sha>/` folder), so path-traversal / excluded-dir
 *      / per-file / total-size / file-count rejection all happen without ever
 *      allocating the rejected entry's decompressed bytes (the zip-bomb
 *      mitigation).
 *   5. `writeArchiveToWorkspace` (shared) clears and repopulates the target
 *      directory — `studio-workspace/<owner>-<repo>/` by default, never the
 *      user's hand-authored `studio-workspace/`. Clearing is safe here
 *      specifically because this per-repo directory IS the explicit target of
 *      this operation (the CLAUDE.md rule against deleting a non-explicit
 *      target does not apply); it also means re-importing the same repo
 *      doesn't leave stale files behind after an upstream rename/delete.
 *
 * Safety model: nothing fetched here is ever executed — this module only
 * writes bytes to disk; parsing back into pages happens later, statically,
 * through ts-morph (`/admin/api/studio/load`), same as any other workspace.
 */
import { join, resolve } from 'node:path'
import { unzipSync, type Unzipped } from 'fflate'
import {
  ArchiveIngestError,
  MAX_ARCHIVE_BYTES,
  createArchiveEntryDecider,
  readBytesWithLimit,
  writeArchiveToWorkspace,
} from './studio/archiveIngest'

/** Thrown for every rejection `runGithubImport` wants mapped to a specific HTTP status. */
export class GithubImportError extends ArchiveIngestError {
  constructor(message: string, status: number) {
    super(message, status)
    this.name = 'GithubImportError'
  }
}

/**
 * The shared engine (`archiveIngest.ts`) throws plain `ArchiveIngestError`
 * for its own rejections (oversized body, `.studio/` guard, empty archive).
 * `runGithubImport`'s external contract is "throws `GithubImportError`", so
 * every rejection from the shared engine is rethrown wearing that type here
 * — callers (`server/handlers/studio.ts`) only ever check `instanceof
 * GithubImportError`.
 */
function asGithubImportError(err: unknown): never {
  if (err instanceof ArchiveIngestError) {
    throw new GithubImportError(err.message, err.status)
  }
  throw err
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

/**
 * Default, repo-scoped import target — its own project folder under
 * `studio-workspace/`, alongside every hand-authored project. Never the root
 * itself: the target is `studio-workspace/<owner>-<repo>/`, so the import's
 * target-clearing step only ever touches that one project subfolder.
 */
export function defaultGithubImportDir(owner: string, repo: string): string {
  return join(process.cwd(), 'studio-workspace', `${owner}-${repo}`)
}

export interface GithubImportOptions {
  url: string
  ref?: string
  subdir?: string
  /** Sent as `Authorization: Bearer <token>` — never logged, never read from env. */
  token?: string
  /** Overrides the default `studio-workspace/<owner>-<repo>` target — mainly for tests. */
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
  const headers: Record<string, string> = { 'user-agent': 'studio-studio-import' }
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

  const zipBytes = await readBytesWithLimit(
    res,
    MAX_ARCHIVE_BYTES,
    `The repository archive is larger than the ${Math.round(MAX_ARCHIVE_BYTES / (1024 * 1024))} MB import limit.`,
  ).catch(asGithubImportError)

  // GitHub zipballs always nest content under one top-level `<repo>-<sha>/`
  // folder — `stripRootFolder: true` unconditionally, never a per-archive
  // guess (that guess only applies to an arbitrary user-uploaded zip; see
  // `studio/importUpload.ts`'s `detectSharedZipRoot`).
  const decider = createArchiveEntryDecider({ stripRootFolder: true, subdir: options.subdir })

  let zip: Unzipped
  try {
    zip = unzipSync(zipBytes, {
      filter(file) {
        return decider.decide(file.name, file.originalSize)
      },
    })
  } catch (err) {
    throw new GithubImportError(
      `The downloaded archive could not be read as a zip: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }

  if (decider.accepted.size === 0) {
    throw new GithubImportError(
      'No importable files were found — check the branch/ref and the subdir, if one was given.',
      422,
    )
  }

  const targetDir = resolve(options.dir ?? defaultGithubImportDir(owner, repo))

  return await writeArchiveToWorkspace(targetDir, decider.accepted, (name) => zip[name], decider.skipped).catch(
    asGithubImportError,
  )
}
