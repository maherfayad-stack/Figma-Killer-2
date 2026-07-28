/**
 * assetImports — resolves the two kinds of import that name a FILE rather than
 * a JavaScript module, both of which are static values the evaluator can hand
 * back like any other:
 *
 *   - `import icon from './x.svg?raw'`   → the file's text
 *   - `import chip from './chip.png'`    → a `studio-asset:<rel>` sentinel
 *
 * ts-morph only tracks `.ts/.tsx/.js/.jsx`, so neither specifier resolves to a
 * `SourceFile` — `resolveIdentifier` reaches both of these from its "an import
 * with no target file" branch, which is exactly what they are.
 *
 * Split out of `staticEvalCore` along a real seam — this module does filesystem
 * and module-specifier resolution, not expression evaluation. It imports nothing
 * from the evaluator (the workspace root arrives as a plain string), so the edge
 * runs one way only.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import * as path from 'node:path'
import type { SourceFile } from 'ts-morph'

/** Vite's `?raw` text-inlining suffix, e.g. `'./check-line.svg?raw'`. */
const RAW_TEXT_SPECIFIER_RE = /\.(svg|txt|html?|md|csv)\?raw$/i

/** An import of an image FILE, whose value at runtime is a URL, not text. */
const IMAGE_SPECIFIER_RE = /\.(png|jpe?g|svg|webp|gif|avif)$/i

/** Guards against inlining a huge file into every expression that references it. */
const MAX_RAW_TEXT_BYTES = 512 * 1024

/**
 * Marks a prop value as "the workspace-relative path of a local image", for
 * `server/handlers/studioPageLoad.ts` to rewrite into a fetchable
 * `/admin/api/studio/asset?dir=…&path=…` URL.
 *
 * The parser deliberately stops at the path: building the URL needs the
 * project's absolute `dir` and the endpoint's own query-param shape, neither of
 * which this layer knows or should know.
 */
export const STUDIO_ASSET_SENTINEL = 'studio-asset:'

/**
 * A specifier that names a file inside an installed package
 * (`@alm-design/design-system/src/icons/line-icons/headset.svg?raw`) rather than
 * a path relative to the importing file. Absolute specifiers are excluded here
 * and rejected outright — nothing legitimate imports `/etc/passwd?raw`.
 */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('\\')
}

/**
 * Node's own algorithm, narrowed to one file: walk up from the importing file
 * looking for `<dir>/node_modules/<specifier>`, stopping at the workspace root.
 *
 * A design system ships its icons as files inside its package, so an app that
 * imports 23 of them (`.../icons/line-icons/headset.svg?raw`) had every one
 * resolve to nothing before this. Hardcoding a path to this repo's own copy was
 * the alternative and would have been a workspace-specific hack; walking
 * `node_modules` is the general, correct rule — it just needs the package to
 * actually be installed.
 */
function resolveInNodeModules(fromDir: string, specifier: string, resolvedRoot: string): string | undefined {
  let dir = path.resolve(fromDir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', specifier)
    if (existsSync(candidate)) return candidate
    if (dir === resolvedRoot) return undefined
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** A file an import names, once it is known to exist inside the workspace. */
interface ResolvedAssetFile {
  /** Absolute, symlinks followed. */
  real: string
  /** POSIX path relative to the workspace root — what a caller may hand outward. */
  rel: string
  /** Size in bytes, already `statSync`'d. */
  bytes: number
}

/**
 * Finds the file a default import names, or `undefined` when there is no such
 * import, its specifier is not the shape `specifierTest` accepts, or the file
 * does not sit inside `workspaceRoot`.
 *
 * Relative specifiers always; installed-package specifiers only when
 * `allowBare` (a design system ships its icons as files inside its package).
 * Without a configured root this resolves nothing rather than touching the disk:
 * a specifier can climb out of the workspace, and the parser must never
 * manufacture an escaping path.
 *
 * CONTAINMENT IS CHECKED ON THE REAL PATH, after following symlinks. A workspace
 * can arrive from `/import-github`, and git stores symlinks — so a
 * `node_modules` entry is untrusted input, and a textual containment check would
 * happily read `~/.ssh/id_rsa` through a link that merely *looks* like it sits
 * under the workspace. The cost is that a linked `file:../pkg` dependency does
 * not resolve; installing the package (a real directory) does.
 */
function resolveImportedFile(
  sourceFile: SourceFile,
  localName: string,
  workspaceRoot: string | undefined,
  specifierTest: RegExp,
  allowBare: boolean,
): ResolvedAssetFile | undefined {
  if (!workspaceRoot) return undefined
  const resolvedRoot = path.resolve(workspaceRoot)
  // The root itself is routinely reached through a symlink (`/var` -> `/private/var`
  // on macOS, a linked checkout), so containment has to compare real path to real
  // path or every read under it looks like an escape.
  let realRoot: string
  try {
    realRoot = realpathSync(resolvedRoot)
  } catch {
    return undefined
  }

  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() !== localName) continue
    const specifier = decl.getModuleSpecifierValue()
    if (!specifierTest.test(specifier)) return undefined
    const filePath = specifier.split('?')[0]!

    const fromDir = path.dirname(sourceFile.getFilePath())
    const absolute = isBareSpecifier(specifier)
      ? (allowBare ? resolveInNodeModules(fromDir, filePath, resolvedRoot) : undefined)
      : specifier.startsWith('.')
        ? path.resolve(fromDir, filePath)
        : undefined // absolute specifier — never read
    if (absolute === undefined) return undefined

    try {
      const real = realpathSync(absolute)
      const rel = path.relative(realRoot, real)
      if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
      const stats = statSync(real)
      if (!stats.isFile()) return undefined
      return { real, rel: rel.split(path.sep).join('/'), bytes: stats.size }
    } catch {
      return undefined // Missing/unreadable asset — unresolved, never a throw.
    }
  }
  return undefined
}

/**
 * `import icon from './x.svg?raw'` -> the file's contents.
 *
 * Vite's `?raw` suffix inlines a file's text as the default export, and it is
 * how real repos ship inline icons: a `?raw` SVG handed to
 * `dangerouslySetInnerHTML`, often via a `<Icon svg={...} />` prop. Resolving
 * it here rather than in the parser means one mechanism covers every path the
 * value can travel — read directly, passed as a prop and substituted into a
 * component, or aliased through a local const.
 */
export function resolveRawTextImport(
  sourceFile: SourceFile,
  localName: string,
  workspaceRoot: string | undefined,
): string | undefined {
  const file = resolveImportedFile(sourceFile, localName, workspaceRoot, RAW_TEXT_SPECIFIER_RE, true)
  if (!file || file.bytes > MAX_RAW_TEXT_BYTES) return undefined
  try {
    return readFileSync(file.real, 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * `import chip from './chip.png'` -> `studio-asset:src/assets/chip.png`.
 *
 * A bundler turns an image import into a URL string, and this is the closest
 * static stand-in: the path, for the load handler to turn into a real URL.
 *
 * Resolved through the EVALUATOR rather than by matching a bare identifier at an
 * `<img src={…}>` attribute, because almost no real repo writes it that
 * directly. The eSIM corpus reaches its images as `deal.image` off a `const
 * DEALS = [{ image: dealCard1 }, …]`, as `SLIDE_IMAGES[index]`, and as a prop
 * forwarded into a child component — three shapes, none of them a bare
 * identifier, all of which the one evaluator already handles for every other
 * kind of value.
 *
 * Bare/installed-package specifiers are NOT resolved (unlike `?raw` text): the
 * asset endpoint refuses to serve out of `node_modules`, so a path it will never
 * honour is worse than no path at all.
 */
export function resolveImageAssetImport(
  sourceFile: SourceFile,
  localName: string,
  workspaceRoot: string | undefined,
): string | undefined {
  const file = resolveImportedFile(sourceFile, localName, workspaceRoot, IMAGE_SPECIFIER_RE, false)
  return file ? `${STUDIO_ASSET_SENTINEL}${file.rel}` : undefined
}
