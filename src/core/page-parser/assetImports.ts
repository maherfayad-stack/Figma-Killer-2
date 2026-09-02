/**
 * assetImports — resolves the three kinds of import that name a FILE rather
 * than a JavaScript module, all of which are static values the evaluator can
 * hand back like any other:
 *
 *   - `import icon from './x.svg?raw'`        → the file's text
 *   - `import chip from './chip.png'`         → a `studio-asset:<rel>` sentinel
 *   - `import styles from './Card.module.css'` → `{ localName: globalName }`
 *
 * ts-morph only tracks `.ts/.tsx/.js/.jsx`, so none of these specifiers
 * resolve to a `SourceFile` — `resolveIdentifier` reaches all three from its
 * "an import with no target file" branch, which is exactly what they are.
 *
 * Split out of `staticEvalCore` along a real seam — this module does filesystem
 * and module-specifier resolution, not expression evaluation. It imports nothing
 * from the evaluator (the workspace root arrives as a plain string), so the edge
 * runs one way only.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import * as path from 'node:path'
import type { Node, SourceFile } from 'ts-morph'

/** Vite's `?raw` text-inlining suffix, e.g. `'./check-line.svg?raw'`. */
const RAW_TEXT_SPECIFIER_RE = /\.(svg|txt|html?|md|csv)\?raw$/i

/**
 * An import of an image FILE, whose value at runtime is a URL, not text.
 * Exported so the asset-UPLOAD route (`server/handlers/studio/assetUpload.ts`)
 * validates a new file's extension against the exact same set this module
 * already treats as "an image import" — one definition, not two that can
 * drift apart.
 */
export const IMAGE_SPECIFIER_RE = /\.(png|jpe?g|svg|webp|gif|avif)$/i

/** `import styles from './Card.module.css'` — a CSS Modules stylesheet, whose value at runtime is `{ localName: generatedGlobalName }`. */
const CSS_MODULE_SPECIFIER_RE = /\.module\.(css|scss|sass|less)$/i

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

/**
 * Where an import declaration's own module-specifier string literal
 * physically lives — the file that WRITES `import heroImg from './hero.png'`,
 * not the asset it points at. This is what `setImportSpecifier` rewrites, and
 * what makes `<img src={heroImg}>` an honest writeback target: the JSX itself
 * can't be the target (there is no literal there to replace), but the import
 * statement one hop away is an ordinary string literal at a known position.
 * Structurally identical to `../page-parser`'s `ValueOrigin` (this module
 * deliberately does not import that type — see this file's own doc comment on
 * why it has no evaluator dependency), so a caller can hand this straight to
 * a `StaticValue`'s `origin` field.
 */
export interface ImportSpecifierLocation {
  /** Workspace-relative POSIX path of the file HOLDING the import statement. */
  rel: string
  /** 1-based line of the module-specifier string literal token. */
  line: number
  /** 1-based column of the module-specifier string literal token. */
  col: number
}

/** A file an import names, once it is known to exist inside the workspace. */
interface ResolvedAssetFile {
  /** Absolute, symlinks followed. */
  real: string
  /** POSIX path relative to the workspace root — what a caller may hand outward. */
  rel: string
  /** Size in bytes, already `statSync`'d. */
  bytes: number
  /** Where the import's OWN specifier literal lives, when it sits inside the workspace. */
  specifierLocation?: ImportSpecifierLocation
}

/**
 * `originOf`'s sibling for an import specifier: the (rel, line, col) of a
 * literal token, computed against the file that HOLDS it rather than the file
 * it resolves to. `sourceFile`/`specifierNode` are always the importing file's
 * own — this never touches the target asset file's location.
 */
function importSpecifierLocation(
  sourceFile: SourceFile,
  specifierNode: Node,
  resolvedRoot: string,
): ImportSpecifierLocation | undefined {
  const rel = path.relative(resolvedRoot, path.resolve(sourceFile.getFilePath()))
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const { line, column } = sourceFile.getLineAndColumnAtPos(specifierNode.getStart())
  return { rel: rel.split(path.sep).join('/'), line, col: column }
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
      return {
        real,
        rel: rel.split(path.sep).join('/'),
        bytes: stats.size,
        specifierLocation: importSpecifierLocation(sourceFile, decl.getModuleSpecifier(), resolvedRoot),
      }
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
 * `import chip from './chip.png'` -> `studio-asset:src/assets/chip.png`, plus
 * WHERE the `'./chip.png'` literal itself lives (`origin`) — the one honest
 * writeback target for an `<img src={chip}>` node (WS-8.3). The image FILE is
 * not editable in place; the import statement naming it is an ordinary string
 * literal at a known position, and `setImportSpecifier` rewrites exactly that.
 * `origin` is `undefined` when the specifier's own file sits outside the
 * workspace — same "nothing honest to write" policy as everywhere else here.
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
): { path: string; origin?: ImportSpecifierLocation } | undefined {
  const file = resolveImportedFile(sourceFile, localName, workspaceRoot, IMAGE_SPECIFIER_RE, false)
  if (!file) return undefined
  return { path: `${STUDIO_ASSET_SENTINEL}${file.rel}`, origin: file.specifierLocation }
}

/**
 * Why an image imported FROM AN INSTALLED PACKAGE resolves to nothing —
 * phrased as the fix, for the evaluator's `unresolved` channel.
 *
 * `resolveImageAssetImport` refuses these on purpose (`allowBare: false`,
 * see its own doc): the asset endpoint will not serve out of `node_modules`,
 * so the sentinel path would name a URL that 404s. But refusing SILENTLY was
 * its own failure. The value simply vanished, `<img src={packagedIcon}/>`
 * reached the canvas as a `base.image` with no `src`, and drew the generic
 * "No image selected" placeholder — indistinguishable from an `<img>` whose
 * source genuinely has no `src` yet. An agent looking at that box learns
 * "Studio cannot show packaged icons", which is false, and hand-draws SVG
 * path data instead of adding six characters to the specifier.
 *
 * So the refusal now says which import it refused and what to write instead.
 * `undefined` when this is not that case at all, leaving every other
 * unresolved import on its existing generic message.
 */
export function packagedImageImportRefusal(sourceFile: SourceFile, localName: string): string | undefined {
  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() !== localName) continue
    const specifier = decl.getModuleSpecifierValue()
    if (!isBareSpecifier(specifier) || !IMAGE_SPECIFIER_RE.test(specifier)) return undefined

    const preamble =
      `"${localName}" imports "${specifier}" from an installed package. Studio's asset endpoint does not ` +
      'serve files out of node_modules, so that URL never resolves and the image renders empty.'
    // An SVG has a strictly better form available — inline it as text, which
    // also lets it inherit `currentColor`. Any other format has to become a
    // real file inside the project first.
    return /\.svg$/i.test(specifier)
      ? `${preamble} Import it as text instead: add "?raw" to the specifier and inline the markup with dangerouslySetInnerHTML.`
      : `${preamble} Copy the file into the project (studio_upload_asset or studio_fetch_remote_asset) and import it by relative path.`
  }
  return undefined
}

/**
 * `import styles from './Card.module.css'` -> `{ card: 'Card_card__a1b2', … }`.
 *
 * WS-2.2: teaches the evaluator that a CSS Modules import has a static value —
 * an object whose keys are the file's local class names and whose values are
 * the generated global names `server/handlers/studio/styleCompile.ts` already
 * computed. `moduleClassMaps` is that compile step's output, keyed by the same
 * workspace-relative POSIX path `resolveImportedFile` derives here, so this
 * function does no compiling of its own — it only looks the file up.
 *
 * `undefined` when there is no configured `moduleClassMaps` (styles were never
 * compiled — e.g. no workspace root, or the load pipeline didn't run the
 * compile step), when the specifier isn't a `.module.css`-shaped import, or
 * when the resolved file has no entry in the map (compiled with zero classes,
 * or genuinely missing — same "unresolved, never a guess" policy as every
 * other import case here).
 */
export function resolveCssModuleImport(
  sourceFile: SourceFile,
  localName: string,
  workspaceRoot: string | undefined,
  moduleClassMaps: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
): Record<string, string> | undefined {
  if (!moduleClassMaps) return undefined
  const file = resolveImportedFile(sourceFile, localName, workspaceRoot, CSS_MODULE_SPECIFIER_RE, false)
  if (!file) return undefined
  const classMap = moduleClassMaps[file.rel]
  return classMap ? { ...classMap } : undefined
}

/**
 * One asset-shaped default import whose file is NOT on disk.
 *
 * `<span dangerouslySetInnerHTML={{ __html: chartIcon }} />` fed by
 * `import chartIcon from '@pkg/icons/chartLineDown.svg?raw'` — where that file
 * does not exist — is not a parse failure and not a type error. The evaluator
 * hands back `unresolved`, the node loses its `svg` prop, and the canvas draws
 * a correctly-classed, correctly-sized, EMPTY span. The icon is simply absent,
 * with nothing anywhere saying why, and `tsc` agrees the code is fine: a
 * project with `vite/client` types declares `*.svg?raw` ambiently, so the
 * specifier typechecks whether or not the file behind it exists.
 *
 * An agent inventing a plausible-but-wrong icon filename is a routine failure
 * (it happened on the real board this was written for, one row out of four),
 * and every downstream signal says "fine". This is what makes it sayable.
 */
export interface UnresolvedAssetImport {
  /** The import specifier exactly as written. */
  readonly specifier: string
  /** The local binding it was imported as — what to grep for at the use site. */
  readonly localName: string
  /** 1-based line of the import declaration. */
  readonly line: number
}

/**
 * Every `?raw` text import in `sourceFile` that names a file which is not
 * there (or sits outside `workspaceRoot`).
 *
 * Deliberately scoped to `?raw` text imports. An IMAGE import can fail to
 * resolve for a second, entirely different reason — it came from an installed
 * package, which `resolveImageAssetImport` refuses on purpose because the asset
 * endpoint will not serve out of `node_modules` — and
 * {@link packagedImageImportRefusal} already explains that one in its own
 * words. Reporting it here as "the file is missing" would be a lie, so this
 * asks only the question it can answer honestly.
 *
 * Resolution goes through the same `resolveImportedFile` the evaluator itself
 * used, so this can never disagree with what the canvas actually did.
 */
export function unresolvedRawTextImports(
  sourceFile: SourceFile,
  workspaceRoot: string | undefined,
): readonly UnresolvedAssetImport[] {
  if (!workspaceRoot) return []
  const unresolved: UnresolvedAssetImport[] = []
  for (const decl of sourceFile.getImportDeclarations()) {
    const defaultImport = decl.getDefaultImport()
    if (!defaultImport) continue
    const specifier = decl.getModuleSpecifierValue()
    if (!RAW_TEXT_SPECIFIER_RE.test(specifier)) continue
    const localName = defaultImport.getText()
    if (resolveImportedFile(sourceFile, localName, workspaceRoot, RAW_TEXT_SPECIFIER_RE, true)) continue
    unresolved.push({
      specifier,
      localName,
      line: sourceFile.getLineAndColumnAtPos(decl.getStart()).line,
    })
  }
  return unresolved
}
