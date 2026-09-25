/**
 * parserCodeDigest — a fingerprint of the CODE that produces a cached route
 * parse, so the on-disk parse cache (`parseCacheStore.ts`) never serves a
 * result an older Studio computed (P6-B).
 *
 * A persisted parse outlives the process that made it, and so outlives the
 * parser: pull a Studio that fixed how a `.map()` expands, restart, and every
 * entry on disk still holds the old expansion. A hand-bumped version constant
 * would be forgotten the first time someone fixes the parser, so this module
 * derives the version from the source itself: the SHA-256 of every module
 * reachable by `import`/`export … from` from the parse's entry points
 * ({@link ENTRY_CLOSURES}), plus the files whose own code shapes the cached
 * result without being imported by it ({@link ENTRY_FILES}), plus the
 * installed versions of the packages that code imports (`ts-morph` and
 * `typescript` decide what the AST looks like).
 *
 * Computed once per process, lazily. `null` when the source cannot be read
 * (a bundled deployment with no `src/` on disk): the disk tier then turns
 * itself off — a cache whose validity cannot be established is not used.
 *
 * The import scan is a regex over the text, not a TypeScript parse. It over-
 * includes (a type-only import, a commented-out one) and that is the safe
 * direction: an extra file only means the cache resets on a Studio upgrade
 * that did not strictly need it to.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { sha256Hex } from './loadDigest'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

/** Modules whose whole import closure produces the cached `ParsedPage` + `componentSources`. */
const ENTRY_CLOSURES = ['src/core/page-parser/index.ts', 'server/handlers/studio/storyPages.ts']

/** The route-parse orchestration itself — which options it hands the parser — without its (unrelated) closure. */
const ENTRY_FILES = ['server/handlers/studioPageLoad.ts']

/** Bump when the on-disk entry's SHAPE changes in a way the code digest would not see. */
export const PARSE_CACHE_FORMAT = 1

const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@core/', 'src/core/'],
  ['@ui/', 'src/ui/'],
]

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g

function resolveLocal(fromFile: string, specifier: string): string | null {
  const bare = specifier.split('?')[0]!
  let base: string | null = null
  if (bare.startsWith('.')) base = resolve(dirname(fromFile), bare)
  else {
    for (const [alias, target] of ALIASES) {
      if (bare.startsWith(alias)) base = join(REPO_ROOT, target, bare.slice(alias.length))
    }
  }
  if (base === null) return null
  const known = resolvedBases.get(base)
  if (known !== undefined) return known
  let found: string | null = null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.(tsx?|json|svg|css)$/.test(candidate) && existsSync(candidate)) {
      found = candidate
      break
    }
  }
  resolvedBases.set(base, found)
  return found
}

/** One `existsSync` probe per distinct import target per process — the closure imports the same modules from hundreds of files. */
const resolvedBases = new Map<string, string | null>()

/** `name@version` for a bare package specifier (`ts-morph`, `@scope/pkg/sub`), or the bare name when not installed. */
function packageVersion(specifier: string): string | null {
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return null
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8'))
    const version = manifest && typeof manifest === 'object' && 'version' in manifest ? String(manifest.version) : '?'
    return `${name}@${version}`
  } catch (_err) {
    return name
  }
}

/**
 * Every local module in the entry points' import closure → its bytes, plus
 * the packages it imports. This runs on the first load of every process, so
 * its cost is load latency: each file is read ONCE (scanned, then hashed from
 * the same buffer), and each distinct specifier is resolved once.
 */
function importClosure(): { files: Map<string, Buffer>; packages: Set<string> } {
  const files = new Map<string, Buffer>()
  const packages = new Set<string>()
  const seenPackageSpecifiers = new Set<string>()
  const pending = ENTRY_CLOSURES.map((rel) => join(REPO_ROOT, rel))
  while (pending.length > 0) {
    const file = pending.pop()!
    if (files.has(file)) continue
    const bytes = readFileSync(file)
    files.set(file, bytes)
    if (!/\.tsx?$/.test(file)) continue
    for (const match of bytes.toString('utf8').matchAll(SPECIFIER_RE)) {
      const specifier = match[1]!
      const local = resolveLocal(file, specifier)
      if (local) {
        if (!files.has(local)) pending.push(local)
      } else if (!specifier.startsWith('.') && !specifier.startsWith('@core/') && !specifier.startsWith('@ui/')) {
        if (seenPackageSpecifiers.has(specifier)) continue
        seenPackageSpecifiers.add(specifier)
        const pkg = packageVersion(specifier)
        if (pkg) packages.add(pkg)
      }
    }
  }
  return { files, packages }
}

function compute(): string {
  const { files, packages } = importClosure()
  for (const rel of ENTRY_FILES) {
    const file = join(REPO_ROOT, rel)
    if (!files.has(file)) files.set(file, readFileSync(file))
  }
  const parts: string[] = [`format:${PARSE_CACHE_FORMAT}`, ...[...packages].sort()]
  for (const [file, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    parts.push(`${file.slice(REPO_ROOT.length)}:${sha256Hex(bytes)}`)
  }
  return sha256Hex(parts.join('\n'))
}

let cached: { digest: string | null } | null = null

/** The parser-code fingerprint, or `null` when the source is not on disk. See this module's doc. */
export function parserCodeDigest(): string | null {
  if (cached) return cached.digest
  try {
    cached = { digest: compute() }
  } catch (err) {
    console.error('[studio:parserCodeDigest] parser source unreadable; the on-disk parse cache is off:', err)
    cached = { digest: null }
  }
  return cached.digest
}

/** The local modules the fingerprint covers, repo-relative POSIX. Test-only. */
export function parserCodeDigestFilesForTesting(): string[] {
  return [...importClosure().files.keys()].map((file) => file.slice(REPO_ROOT.length + 1).split(sep).join('/')).sort()
}
