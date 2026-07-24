/**
 * designImport/npmSource — resolves an npm package spec (`"open-props"`,
 * `"@radix-ui/colors@3.0.0"`) against the public registry, fetches its
 * tarball, and returns every CSS/token-file candidate found (`.css`
 * unconditionally, JSON/JS/TS only when the name looks like a token
 * definition — see `isCandidateTokenFile`). The registry metadata fetch
 * mirrors `server/publish/runtime/dependencyResolver.ts`'s existing
 * `registry.npmjs.org` call (there, for a runtime dependency lock; here, for
 * the package's own file contents) — this module adds the actual tarball
 * fetch + tar read, which nothing in this codebase does yet.
 */
import { gunzipSync } from 'fflate'
import { isSafeRelPath } from '../studioGithubImport'
import { readTarEntries } from './tarReader'
import {
  DesignImportError,
  isCandidateTokenFile,
  MAX_DESIGN_IMPORT_DOWNLOAD_BYTES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_FILES,
  readBytesWithLimit,
  type FetchedSource,
} from './shared'

export interface NpmSourceOptions {
  /** `"name"`, `"name@version"`, `"@scope/name"`, or `"@scope/name@version"`. */
  packageSpec: string
}

export interface NpmSourceDeps {
  fetchImpl?: typeof fetch
}

/** Splits a package spec into `{ name, version }`. `version` is `undefined` when none was given (resolve to `dist-tags.latest`). Handles the `@scope/name` case, where the FIRST `@` is part of the scope, not a version separator. */
export function parseNpmPackageSpec(spec: string): { name: string; version?: string } | null {
  const trimmed = spec.trim()
  if (trimmed.length === 0) return null

  const scoped = trimmed.startsWith('@')
  // For a scoped package, skip past the leading `@scope` before looking for a
  // version-separating `@`; for an unscoped package, the first `@` (if any)
  // IS the version separator.
  const searchFrom = scoped ? trimmed.indexOf('/') : 0
  if (scoped && searchFrom === -1) return null // "@scope" with no "/name"

  const atIndex = trimmed.indexOf('@', searchFrom + 1)
  if (atIndex === -1) return { name: trimmed }
  const name = trimmed.slice(0, atIndex)
  const version = trimmed.slice(atIndex + 1)
  if (name.length === 0 || version.length === 0) return null
  return { name, version }
}

/** `@scope/name` → `@scope%2Fname`, matching the registry's URL scheme (the metadata endpoint expects the scope's `/` percent-encoded, not a real path segment). */
function registryMetadataUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace('/', '%2F')}`
}

interface RegistryVersionMeta {
  dist?: { tarball?: string }
}
interface RegistryMetadata {
  'dist-tags'?: { latest?: string }
  versions?: Record<string, RegistryVersionMeta>
}

/**
 * Fetches `options.packageSpec`'s tarball from the npm registry and returns
 * every `.css` file it contains. Throws `DesignImportError` for every
 * user-facing rejection — invalid spec, unknown package/version, network
 * failure, oversized archive, unreadable tarball, or zero CSS files found.
 */
export async function fetchNpmCssSource(
  options: NpmSourceOptions,
  deps: NpmSourceDeps = {},
): Promise<FetchedSource> {
  const fetchImpl = deps.fetchImpl ?? fetch

  const parsed = parseNpmPackageSpec(options.packageSpec)
  if (!parsed) {
    throw new DesignImportError(
      `Not a valid npm package name: "${options.packageSpec}".`,
      400,
    )
  }

  let metaRes: Response
  try {
    metaRes = await fetchImpl(registryMetadataUrl(parsed.name), {
      headers: { accept: 'application/json', 'user-agent': 'instatic-design-import' },
    })
  } catch (err) {
    throw new DesignImportError(
      `Could not reach the npm registry: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }
  if (metaRes.status === 404) {
    throw new DesignImportError(`Package "${parsed.name}" was not found on the npm registry.`, 404)
  }
  if (!metaRes.ok) {
    throw new DesignImportError(
      `The npm registry returned an unexpected status (${metaRes.status}) for "${parsed.name}".`,
      502,
    )
  }

  const meta = (await metaRes.json()) as RegistryMetadata
  const version = parsed.version ?? meta['dist-tags']?.latest
  const versionMeta = version ? meta.versions?.[version] : undefined
  const tarballUrl = versionMeta?.dist?.tarball
  if (!version || !versionMeta || !tarballUrl) {
    throw new DesignImportError(
      `Version "${parsed.version ?? '(latest)'}" of "${parsed.name}" was not found.`,
      404,
    )
  }

  let tarRes: Response
  try {
    tarRes = await fetchImpl(tarballUrl, { headers: { 'user-agent': 'instatic-design-import' } })
  } catch (err) {
    throw new DesignImportError(
      `Could not download the package tarball: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }
  if (!tarRes.ok) {
    throw new DesignImportError(
      `Fetching the package tarball returned an unexpected status (${tarRes.status}).`,
      502,
    )
  }

  const gzBytes = await readBytesWithLimit(tarRes, MAX_DESIGN_IMPORT_DOWNLOAD_BYTES)

  let tarBytes: Uint8Array
  try {
    tarBytes = gunzipSync(gzBytes)
  } catch (err) {
    throw new DesignImportError(
      `The package tarball could not be decompressed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }

  const entries = readTarEntries(tarBytes)

  const cssFiles: FetchedSource['cssFiles'] = []
  const tokenFiles: FetchedSource['tokenFiles'] = []
  let acceptedCount = 0
  let truncated = false
  const decoder = new TextDecoder()
  for (const entry of entries) {
    if (acceptedCount >= MAX_SOURCE_FILES) {
      truncated = true
      break
    }
    // npm tarballs always nest content under a single `package/` folder,
    // regardless of the package's actual name.
    const firstSlash = entry.name.indexOf('/')
    if (firstSlash === -1) continue
    const relPath = entry.name.slice(firstSlash + 1)
    if (relPath.length === 0) continue
    const isCss = relPath.toLowerCase().endsWith('.css')
    if (!isCss && !isCandidateTokenFile(relPath)) continue
    if (!isSafeRelPath(relPath)) continue
    if (entry.contents.byteLength > MAX_SOURCE_FILE_BYTES) continue

    acceptedCount += 1
    const file = { relPath, contents: decoder.decode(entry.contents) }
    if (isCss) cssFiles.push(file)
    else tokenFiles.push(file)
  }

  if (cssFiles.length === 0 && tokenFiles.length === 0) {
    throw new DesignImportError(
      `No .css or token files were found in "${parsed.name}@${version}".`,
      422,
    )
  }

  return { label: `${parsed.name}@${version}`, cssFiles, tokenFiles, truncated }
}
