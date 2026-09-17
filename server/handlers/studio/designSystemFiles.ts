/**
 * designSystemFiles — `ensureDesignSystemFiles(dir)`: the Studio-written
 * `<project>/design-system/` folder that lets a DS-backed project build,
 * download and run with **no design-system package installed anywhere**.
 *
 * ## Why a folder in the project, and not a dependency
 *
 * Studio used to hand every new project a copy of `@alm-design/design-system`
 * in its own `node_modules` plus a `package.json` entry declaring it. Two
 * things were wrong with that. `node_modules/` is excluded from "Download the
 * code" by design, so the zip a user got named a dependency that the registry
 * has never heard of — `bun install` in the unzipped copy fails. And a
 * dependency that only Studio can satisfy is not "the repository is the
 * document": the document was incomplete without Studio standing behind it.
 *
 * So the design system's SOURCE is written into the project, and pages import
 * it relatively (`import { Button } from '../design-system'`). The downloaded
 * repo then builds with `react` + `vite` + `@vitejs/plugin-react` and nothing
 * else.
 *
 * ## The same contract `prototype/*.generated.*` already has
 *
 * The folder is Studio-managed: it is written from Studio's own vendored copy
 * (`./builtinDesignSystem.ts`'s `BUILTIN_DESIGN_SYSTEM_DIR`), rewritten when
 * that copy changes, and carries a `README.md` saying so. What makes "when it
 * changes" cheap is `.studio/design-system.json`: a content hash over the
 * whole source set plus the list of files written. A matching hash means the
 * folder is already exactly what this function would write, and nothing is
 * touched — which matters because a needless rewrite moves mtimes and
 * invalidates every cache keyed on them.
 *
 * ## What is copied, and what deliberately is not
 *
 * `src/index.js`, `components/`, `context/`, `tokens/`, `icons/LineIcons.jsx` —
 * and, of the 568 icon SVGs the vendored package ships, ONLY the ones a
 * component or `LineIcons.jsx` actually imports. Those import specifiers are
 * read STATICALLY, with a regex over the `.jsx` source: nothing in the design
 * system is executed here, at any trust tier, exactly as nothing in the user's
 * project is. Dropping the unreferenced icons is the difference between ~20
 * files and 3.8 MB of SVG in every project.
 *
 * ## Only for projects that asked
 *
 * `.studio/meta.json`'s `designSystem: 'alm'` is the write-side authority.
 * "New project" sets it (`./projectSeed.ts`) and so does the migration
 * (`./designSystemMigrate.ts`); a GitHub import never does, so an imported
 * repository does not get 600 KB of someone else's `.jsx` dropped into it.
 * The READ-side check other code uses is `isDesignSystemBacked(dir)` — the
 * folder is present — because that is the question "can a page import it"
 * actually asks.
 *
 * ## Filesystem safety
 *
 * Every write target is derived server-side from the source tree's own layout
 * and containment-checked against `<project>/design-system/` on its REAL path
 * (`isRealpathContainedAllowingMissing`), so a planted symlink cannot carry a
 * write out of the folder. Every source file is containment-checked against
 * the vendored `src/` the same way before it is read. The ONLY paths this
 * module ever deletes are files it recorded writing itself, in that one
 * folder; a stale manifest entry that is a symlink, or that resolves outside
 * the folder, is left alone rather than followed.
 *
 * Never throws: a project that cannot be given the folder is the project it
 * would have been without it, and the board still has to open.
 */
import { createHash } from 'node:crypto'
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, posix, sep } from 'node:path'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  BUILTIN_DESIGN_SYSTEM_DIR,
  PROJECT_DESIGN_SYSTEM_DIR,
  isDesignSystemBacked,
} from './builtinDesignSystem'
import { readStudioMeta } from './studioMeta'
import { isRealpathContained, isRealpathContainedAllowingMissing } from './workspacePackageResolve'

/** Where the hash of the written folder lives. Inside `.studio/`, so it never ships in a download. */
const MANIFEST_REL = '.studio/design-system.json'

/** Bumped only if the manifest's own SHAPE changes — the source set's version rides in the hash, via `VERSION`. */
const MANIFEST_VERSION = 1

/** Directories under the vendored `src/` copied wholesale. */
const COPIED_DIRS = ['components', 'context', 'tokens'] as const

/** Individual files under the vendored `src/` copied by name. */
const COPIED_FILES = ['index.js', 'icons/LineIcons.jsx'] as const

/** A walk bound, so a vendored tree that has grown a surprise cannot turn a project open into an unbounded read. */
const MAX_SOURCE_FILES = 2000

/** Per-file bound, same reasoning. The largest file in the real package's `src/` is ~48 KB. */
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024

const README = `# design-system

Studio-managed. Edit the design system in Studio's \`vendor/alm-design-system/\`,
then reopen the project — this folder is rewritten when stale.
`

const DesignSystemManifestSchema = Type.Object({
  /** {@link MANIFEST_VERSION} — the manifest's shape, not the design system's. */
  version: Type.Number(),
  /** SHA-256 over the whole source set (paths + contents) that produced this folder. */
  hash: Type.String(),
  /** `design-system/`-relative POSIX paths Studio wrote. The only paths it will ever delete. */
  files: Type.Array(Type.String()),
})
type DesignSystemManifest = Static<typeof DesignSystemManifestSchema>

/** Why `ensureDesignSystemFiles` did nothing, when it did nothing. */
export type DesignSystemSkipReason =
  | 'not-design-system-backed'
  | 'no-source'
  | 'up-to-date'
  | 'unsafe-target'

export interface EnsureDesignSystemResult {
  /** `design-system/`-relative POSIX paths created or rewritten. */
  written: string[]
  /** `design-system/`-relative POSIX paths deleted because they left the source set. */
  removed: string[]
  /** `null` when the folder was actually (re)written. */
  skipped: DesignSystemSkipReason | null
}

export interface EnsureDesignSystemOptions {
  /** Studio's vendored package root. Overridden only by tests, which build a small fake one. */
  sourceDir?: string
}

/** One file to write: where it goes under `design-system/`, and what goes in it. */
interface SourceFile {
  /** POSIX path relative to `<project>/design-system/`. */
  relPath: string
  contents: string
}

function emptyResult(skipped: DesignSystemSkipReason): EnsureDesignSystemResult {
  return { written: [], removed: [], skipped }
}

/**
 * A path this module is willing to write to, expressed relative to the folder
 * root: non-empty, never absolute, no `..` or empty segment on EITHER
 * separator. The value is derived from a directory walk rather than from a
 * request, so this is belt-and-braces — which is the point: the guard states
 * the rule where the write happens, not three modules away.
 */
function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0 || relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) return false
  const segments = relPath.split(/[\\/]/)
  return segments.every((segment) => segment.length > 0 && segment !== '..' && segment !== '.')
}

/** Every file under `root`, as POSIX paths relative to `root`. Never follows a symlinked directory out. */
function walkFiles(root: string, prefix: string, budget: { left: number }): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (budget.left <= 0) break
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) continue // a link in the vendored tree is never a file to copy
    if (entry.isDirectory()) {
      found.push(...walkFiles(join(root, entry.name), relPath, budget))
      continue
    }
    if (!entry.isFile()) continue
    budget.left -= 1
    found.push(relPath)
  }
  return found
}

/** Reads a source file, refusing anything that escapes `srcRoot` on its real path or busts the size cap. */
function readSourceFile(srcRoot: string, relPath: string): string | null {
  if (!isSafeRelPath(relPath)) return null
  const abs = join(srcRoot, ...relPath.split('/'))
  if (!isRealpathContained(abs, srcRoot)) return null
  try {
    if (statSync(abs).size > MAX_SOURCE_FILE_BYTES) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * Every `.svg` a collected `.jsx`/`.js` file imports, as a path relative to
 * the vendored `src/`.
 *
 * Read with a regex, not by executing or even parsing the module: the design
 * system's components import ~20 icons as `../icons/line-icons/<name>.svg?raw`
 * (a Vite `?raw` import), and the whole point of this pass is that a project
 * carries those twenty and not the other 548.
 */
const IMPORT_SPECIFIER_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g

function collectSvgImports(files: readonly SourceFile[]): string[] {
  const wanted = new Set<string>()
  for (const file of files) {
    if (!/\.(jsx|js)$/.test(file.relPath)) continue
    for (const match of file.contents.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1] ?? match[2]
      if (!specifier || !specifier.startsWith('.')) continue
      const withoutQuery = specifier.split('?')[0] ?? ''
      if (!withoutQuery.endsWith('.svg')) continue
      const resolved = posix.normalize(posix.join(posix.dirname(file.relPath), withoutQuery))
      if (isSafeRelPath(resolved)) wanted.add(resolved)
    }
  }
  return [...wanted].sort()
}

/** The vendored package's own `version`, or `'0.0.0'` when its manifest is missing or unreadable — never a guessed one. */
function readVendorVersion(sourceDir: string): string {
  const parsed = parseJsonWithFallback(
    readFileOrEmpty(join(sourceDir, 'package.json')),
    Type.Object({ version: Type.Optional(Type.String()) }, { additionalProperties: true }),
    {},
  )
  return parsed.version ?? '0.0.0'
}

function readFileOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The whole set of files a DS-backed project should carry, read out of the
 * vendored `src/`. `null` when there is no vendored source to read — which is
 * the state of a checkout that has not run DS-1's sync, and is a no-op rather
 * than an error.
 */
function collectSourceSet(sourceDir: string): SourceFile[] | null {
  const srcRoot = join(sourceDir, 'src')
  if (!existsSync(srcRoot)) return null

  const budget = { left: MAX_SOURCE_FILES }
  const relPaths: string[] = [...COPIED_FILES]
  for (const dir of COPIED_DIRS) {
    relPaths.push(...walkFiles(join(srcRoot, dir), dir, budget).map((rel) => rel))
  }

  const files: SourceFile[] = []
  for (const relPath of relPaths) {
    const contents = readSourceFile(srcRoot, relPath)
    if (contents === null) continue
    files.push({ relPath, contents })
  }
  if (files.length === 0) return null

  for (const relPath of collectSvgImports(files)) {
    const contents = readSourceFile(srcRoot, relPath)
    if (contents === null) continue
    files.push({ relPath, contents })
  }

  files.push({ relPath: 'README.md', contents: README })
  files.push({ relPath: 'VERSION', contents: `${readVendorVersion(sourceDir)}\n` })

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : 1))
  return files
}

/** One hash over the whole set — paths included, so adding or removing a file changes it even when no content did. */
function hashSourceSet(files: readonly SourceFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.relPath)
    hash.update('\0')
    hash.update(file.contents)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function readManifest(projectDir: string): DesignSystemManifest | null {
  const file = join(projectDir, ...MANIFEST_REL.split('/'))
  if (!existsSync(file)) return null
  const parsed = parseJsonWithFallback(readFileOrEmpty(file), DesignSystemManifestSchema, {
    version: 0,
    hash: '',
    files: [],
  })
  return parsed.hash.length > 0 ? parsed : null
}

function writeManifest(projectDir: string, manifest: DesignSystemManifest): void {
  const file = join(projectDir, ...MANIFEST_REL.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * Writes `<project>/design-system/` from Studio's vendored copy, if this
 * project is design-system-backed and the folder is not already exactly that.
 *
 * See the module doc for the full contract. Never throws.
 */
export function ensureDesignSystemFiles(
  projectDir: string,
  options: EnsureDesignSystemOptions = {},
): EnsureDesignSystemResult {
  const sourceDir = options.sourceDir ?? BUILTIN_DESIGN_SYSTEM_DIR
  try {
    if (!existsSync(projectDir)) return emptyResult('not-design-system-backed')
    if (readStudioMeta(projectDir).designSystem !== 'alm') return emptyResult('not-design-system-backed')

    const files = collectSourceSet(sourceDir)
    if (!files) return emptyResult('no-source')

    const dsRoot = join(projectDir, PROJECT_DESIGN_SYSTEM_DIR)
    // Refuse before creating anything: a `design-system` that is a symlink out
    // of the project would otherwise make every write below land elsewhere.
    if (!isRealpathContainedAllowingMissing(dsRoot, projectDir)) return emptyResult('unsafe-target')

    const hash = hashSourceSet(files)
    const manifest = readManifest(projectDir)
    if (manifest && manifest.hash === hash && isDesignSystemBacked(projectDir)) {
      return emptyResult('up-to-date')
    }

    mkdirSync(dsRoot, { recursive: true })
    const result: EnsureDesignSystemResult = { written: [], removed: [], skipped: null }

    for (const file of files) {
      if (!isSafeRelPath(file.relPath)) continue
      const abs = join(dsRoot, ...file.relPath.split('/'))
      if (!isRealpathContainedAllowingMissing(abs, dsRoot)) continue
      if (existsSync(abs) && readFileOrEmpty(abs) === file.contents) continue
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, file.contents, 'utf8')
      result.written.push(file.relPath)
    }

    const kept = new Set(files.map((file) => file.relPath))
    for (const stale of manifest?.files ?? []) {
      if (kept.has(stale) || !isSafeRelPath(stale)) continue
      const abs = join(dsRoot, ...stale.split('/'))
      if (!existsSync(abs)) continue
      // A manifest entry that has BECOME a symlink, or that resolves outside
      // the folder, is not something this module wrote — leave it.
      if (lstatSync(abs).isSymbolicLink() || !isRealpathContained(abs, dsRoot)) continue
      rmSync(abs, { force: true })
      result.removed.push(stale)
    }

    writeManifest(projectDir, { version: MANIFEST_VERSION, hash, files: files.map((file) => file.relPath) })
    return result
  } catch (err) {
    // An addition, never a precondition: the board still has to open.
    console.error('[studio/designSystemFiles]', err)
    return emptyResult('no-source')
  }
}

/**
 * The specifier a file in `fromDir` imports the project's design system by —
 * `'../design-system'` from `pages/`, `'../../design-system'` from
 * `pages/onboarding/`, and so on. Always `./`- or `../`-prefixed, always
 * POSIX, because it is going into a source file.
 *
 * Computed rather than hardcoded because the same folder is imported from
 * three different depths (`pages/`, `components/`, `prototype/`) and a page
 * may sit in a subdirectory of any of them.
 */
export function designSystemImportSpecifier(projectDir: string, fromDir: string): string {
  const toPosix = (value: string): string => (sep === '/' ? value : value.split(sep).join('/'))
  const target = posix.join(toPosix(projectDir), PROJECT_DESIGN_SYSTEM_DIR)
  const relative = posix.relative(toPosix(fromDir), target)
  if (relative.length === 0) return '.'
  return relative.startsWith('.') ? relative : `./${relative}`
}
