/**
 * ONE walk of the repository, shared by every whole-tree architecture gate.
 *
 * ## The problem this exists for
 *
 * Sixty of the gates in this folder used to carry a private, byte-identical
 * copy of the same recursive walker:
 *
 * ```ts
 * for (const entry of readdirSync(dir)) {
 *   const stat = statSync(join(dir, entry))       // one syscall per entry
 *   if (stat.isDirectory()) out.push(...collect(join(dir, entry)))
 *   else if (exts.includes(extname(entry))) out.push(join(dir, entry))
 * }
 * ```
 *
 * …followed by a serial `readFileSync(file, 'utf8')` loop. On Windows both
 * halves are expensive: `statSync` per entry costs roughly 3x what
 * `readdirSync(dir, { withFileTypes: true })` costs for the same information,
 * and a serial read of the ~4,500-file tree measured **14.6 s cold / 19 s**
 * against **154 ms** for the same bytes read in parallel through `Bun.file`
 * (`no-nul-bytes-in-source.test.ts` found that number first and is why this
 * module reads the way it does).
 *
 * Paid once per gate, that is merely slow. Paid sixty times — and several
 * gates paid it once PER RULE, so `ai-driver-isolation.test.ts` read all of
 * `src/` + `server/` six times and took **29.7 s alone**, blowing its own
 * 20 s per-test budget — it turns the architecture suite into the thing
 * everyone learns to ignore. A gate that times out under load is a gate that
 * stops being read.
 *
 * ## What this module does instead
 *
 * The tree is walked once and read once, in parallel, at module-evaluation
 * time (top-level await). Bun evaluates an imported module once per process,
 * so with `bun test --parallel=4` the whole architecture suite pays four
 * walks, not sixty — and every gate that imports this gets its file list and
 * its file contents from memory.
 *
 * ## The interface is deliberately the old one
 *
 * {@link walkSourceTree} returns `string[]` of ABSOLUTE, OS-separator paths in
 * the same depth-first `readdirSync` order the private walkers produced, and
 * {@link readSource} returns exactly what `readFileSync(path, 'utf8')`
 * returned. That is not nostalgia: it is what makes each gate's conversion a
 * deletion of its walker rather than a rewrite of its rule, so the rule's
 * semantics are preserved by construction instead of by review.
 *
 * ## Two guards, because a scan that inspects zero files passes forever
 *
 * - Asking for a directory that exists but lives under {@link SKIPPED_DIRS}
 *   (`dist/`, `.tmp/`, `studio-workspace/`, …) **throws**. Such a directory is
 *   not in the cache, so a silent `[]` would turn the gate green forever.
 *   Build-output gates (`bundle-size-budgets.test.ts`) legitimately read
 *   `dist/` and must keep their own `readdirSync` — this module is for source.
 * - Asking for an extension outside {@link CACHED_EXTENSIONS} **throws**, for
 *   the same reason: the cache does not hold those files and would answer
 *   "no violations" about a set it never looked at.
 *
 * A directory that genuinely does not exist returns `[]`, which is what the
 * private walkers did (they each opened with `if (!existsSync(dir)) return`).
 *
 * ## Windows
 *
 * {@link toRepoRelativePosix} is the only correct way to compare a walked path
 * against an allowlist literal in this repo. `path.relative` returns
 * backslashes on win32 and a byte comparison against `'admin/pages/…'` then
 * never matches — which does not produce a narrow false positive, it silently
 * disables the whole gate. See `pathHelpers.ts` for the long version.
 */
import { readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

/** Repository root — this file lives at `src/__tests__/architecture/helpers/`. */
export const REPO_ROOT = resolve(join(import.meta.dir, '../../../../'))

/**
 * Directories that are never repository source: dependencies, build output,
 * the user's own React projects (`studio-workspace/` is user data and
 * `.gitattributes` marks it `-text` for that reason), runtime uploads, and
 * scratch roots. Kept identical to the set `no-nul-bytes-in-source.test.ts`
 * arrived at, plus the scratch roots this repo's tooling writes.
 */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.coverage',
  'studio-workspace',
  'uploads',
  '.tmp',
  '.tmp-lint',
  '.claude',
])

/**
 * Every extension any gate scans, unioned. A gate asking for one outside this
 * set throws rather than silently scanning nothing.
 */
export const CACHED_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.cjs',
  '.cts',
  '.css',
  '.md',
  '.json',
  '.html',
]

const CACHED_EXTENSION_SET = new Set(CACHED_EXTENSIONS)

/**
 * `withFileTypes` avoids a `statSync` per entry — on Windows that alone is the
 * difference between 280 ms and 90 ms for this tree. Order is the plain
 * `readdirSync` order with directories recursed in place, which is exactly the
 * order the private walkers produced.
 */
function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (CACHED_EXTENSION_SET.has(extname(entry.name))) out.push(full)
  }
  return out
}

const FILES: readonly string[] = walk(REPO_ROOT, [])

/**
 * Read every cached file's bytes in parallel. 4,505 files / 41 MB in ~154 ms
 * warm on this machine, against 14.6 s for the same files read serially.
 */
const BYTES_BY_PATH = new Map<string, Uint8Array>()
await Promise.all(
  FILES.map(async (file) => {
    BYTES_BY_PATH.set(file, await Bun.file(file).bytes())
  }),
)

/**
 * `ignoreBOM: true` is NOT a relaxation — it is what makes this byte-identical
 * to `readFileSync(path, 'utf8')`. The default (`false`) STRIPS a leading
 * U+FEFF; Node's utf8 decode keeps it. A gate that scans for a BOM, or one
 * whose offsets feed a line number, would read differently otherwise.
 */
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true })

const TEXT_BY_PATH = new Map<string, string>()

/** Repo-relative, forward slashes — the form every allowlist literal is written in. */
export function toRepoRelativePosix(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join('/')
}

function firstSkippedSegment(absPath: string): string | null {
  const rel = relative(REPO_ROOT, absPath)
  if (rel.startsWith('..')) return null
  for (const segment of rel.split(sep)) {
    if (SKIPPED_DIRS.has(segment)) return segment
  }
  return null
}

/**
 * The files under `dir`, recursively — absolute paths, OS separators, in the
 * cache's walk order. Drop-in for the private `collectFiles` / `walk` helpers
 * the gates used to carry.
 *
 * @param dir Absolute path to a directory inside the repository.
 * @param extensions Extensions to keep, each with its leading dot. Defaults to
 * `['.ts', '.tsx']`, which is what most gates asked for.
 */
export function walkSourceTree(dir: string, extensions: readonly string[] = ['.ts', '.tsx']): string[] {
  for (const ext of extensions) {
    if (!CACHED_EXTENSION_SET.has(ext)) {
      throw new Error(
        `[sourceTree] '${ext}' is not cached, so this scan would inspect zero ${ext} files and pass forever. ` +
          `Add it to CACHED_EXTENSIONS in src/__tests__/architecture/helpers/sourceTree.ts ` +
          `(cached today: ${CACHED_EXTENSIONS.join(', ')}).`,
      )
    }
  }

  const absolute = resolve(dir)
  const outside = relative(REPO_ROOT, absolute).startsWith('..')
  if (outside) {
    throw new Error(
      `[sourceTree] ${absolute} is outside the repository root ${REPO_ROOT}, so it is not in the shared ` +
        `tree cache. Read it with node:fs directly — this helper only serves repository source.`,
    )
  }

  const skipped = firstSkippedSegment(absolute)
  if (skipped !== null) {
    throw new Error(
      `[sourceTree] ${toRepoRelativePosix(absolute)} lives under '${skipped}', which the shared tree cache ` +
        `never walks (dependencies, build output, user projects, scratch roots). Returning an empty list ` +
        `here would make your gate pass forever without inspecting anything. Either scan a source ` +
        `directory, or — if you genuinely need build output, as bundle-size-budgets.test.ts does — keep ` +
        `your own readdirSync and do not use this helper.`,
    )
  }

  // Cheap existence check: the private walkers all opened with
  // `if (!existsSync(dir)) return []`, and a few gates rely on that for
  // optional directories.
  try {
    if (!statSync(absolute).isDirectory()) return []
  } catch {
    return []
  }

  const wanted = new Set(extensions)
  const prefix = absolute.endsWith(sep) ? absolute : absolute + sep
  const out: string[] = []
  for (const file of FILES) {
    if (!file.startsWith(prefix)) continue
    if (!wanted.has(extname(file))) continue
    out.push(file)
  }
  return out
}

/**
 * The cached UTF-8 text of a file the walk found — identical to
 * `readFileSync(absPath, 'utf8')`. Decoded once, on first ask.
 *
 * Throws for a path the walk did not reach, because the alternative (reading
 * it from disk here) would let a gate quietly scan files the cache's guards
 * were never applied to.
 */
export function readSource(absPath: string): string {
  const cached = TEXT_BY_PATH.get(absPath)
  if (cached !== undefined) return cached
  const bytes = BYTES_BY_PATH.get(absPath)
  if (bytes === undefined) {
    throw new Error(
      `[sourceTree] ${absPath} is not in the shared tree cache. Pass a path that came from ` +
        `collectFiles(), or read a one-off file with node:fs directly.`,
    )
  }
  const text = DECODER.decode(bytes)
  TEXT_BY_PATH.set(absPath, text)
  return text
}

/** The raw bytes of a cached file — for gates that must not decode (NUL / BOM scans). */
export function readSourceBytes(absPath: string): Uint8Array {
  const bytes = BYTES_BY_PATH.get(absPath)
  if (bytes === undefined) {
    throw new Error(`[sourceTree] ${absPath} is not in the shared tree cache.`)
  }
  return bytes
}

/** Every file the shared walk reached — absolute paths, walk order. */
export function allCachedFiles(): readonly string[] {
  return FILES
}
