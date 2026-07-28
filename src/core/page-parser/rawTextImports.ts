/**
 * rawTextImports — turns `import icon from './x.svg?raw'` into the file's text.
 *
 * Vite's `?raw` suffix inlines a file's contents as the default export, and it is
 * how real repos ship every icon: a `?raw` SVG handed to
 * `dangerouslySetInnerHTML`, often via an `<Icon svg={…}/>` prop.
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

/** Guards against inlining a huge file into every expression that references it. */
const MAX_RAW_TEXT_BYTES = 512 * 1024

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
 * `import icon from './x.svg?raw'` -> the file's contents.
 *
 * Vite's `?raw` suffix inlines a file's text as the default export, and it is
 * how real repos ship inline icons: a `?raw` SVG handed to
 * `dangerouslySetInnerHTML`, often via a `<Icon svg={...} />` prop. Resolving
 * it here rather than in the parser means one mechanism covers every path the
 * value can travel — read directly, passed as a prop and substituted into a
 * component, or aliased through a local const.
 *
 * Relative specifiers and installed-package specifiers, only inside
 * `budget.workspaceRoot`, only regular files under `MAX_RAW_TEXT_BYTES`. Without
 * a configured root this returns `undefined` rather than reading anything: a
 * specifier can climb out of the workspace, and the evaluator must never
 * manufacture an escaping path.
 *
 * CONTAINMENT IS CHECKED ON THE REAL PATH, after following symlinks. A workspace
 * can arrive from `/import-github`, and git stores symlinks — so a
 * `node_modules` entry is untrusted input, and a textual containment check would
 * happily read `~/.ssh/id_rsa` through a link that merely *looks* like it sits
 * under the workspace. The cost is that a linked `file:../pkg` dependency does
 * not resolve; installing the package (a real directory) does.
 */
export function resolveRawTextImport(
  sourceFile: SourceFile,
  localName: string,
  workspaceRoot: string | undefined,
): string | undefined {
  const root = workspaceRoot
  if (!root) return undefined
  const resolvedRoot = path.resolve(root)
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
    if (!RAW_TEXT_SPECIFIER_RE.test(specifier)) return undefined
    const filePath = specifier.split('?')[0]!

    const fromDir = path.dirname(sourceFile.getFilePath())
    const absolute = isBareSpecifier(specifier)
      ? resolveInNodeModules(fromDir, filePath, resolvedRoot)
      : specifier.startsWith('.')
        ? path.resolve(fromDir, filePath)
        : undefined // absolute specifier — never read
    if (absolute === undefined) return undefined

    try {
      const real = realpathSync(absolute)
      const relFromRoot = path.relative(realRoot, real)
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return undefined
      const stats = statSync(real)
      if (!stats.isFile() || stats.size > MAX_RAW_TEXT_BYTES) return undefined
      return readFileSync(real, 'utf8').trim()
    } catch {
      return undefined // Missing/unreadable asset — unresolved, never a throw.
    }
  }
  return undefined
}

