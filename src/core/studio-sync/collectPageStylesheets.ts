/**
 * collectPageStylesheets — §6.1 of the Studio import pipeline: works out which
 * stylesheets a parsed page actually depends on, in cascade order.
 *
 * eSIM-shaped React repos attach styling with `import './Screen.css'` plus a
 * `className` on each element. Studio's renderer never reads a literal
 * `className` prop — styling attaches through `classIds` -> `site.styleRules` —
 * so an imported page renders structurally correct and completely unstyled
 * until those `.css` files are parsed in. This module answers only the first
 * question: WHICH files, in WHAT order. Parsing them is `cssToStyleRules`'s
 * job; wiring the result into a site document is `server/handlers/studioCss.ts`'s.
 *
 * ## Which files contribute
 *
 * The page's own file plus every local component file that was inlined into it
 * (§2) — a component's CSS is every bit as load-bearing as the page's, since
 * after inlining its markup IS the page's markup.
 *
 * That set is derived from `ParsedNode.loc.file`, which inlining already
 * rewrites to the component's OWN file. The plan (§6.1) suggested threading a
 * `usedFiles` list out of `inlineLocalComponents` instead; reading `loc.file`
 * needs no new plumbing and cannot drift out of sync, because the set of files
 * that contributed nodes is exactly the set whose CSS matters — a component
 * that was NOT inlined (an `alm.*` package component) contributes no nodes and
 * correctly contributes no CSS.
 *
 * ## Order
 *
 * Files are visited page-first, then in the order their nodes first appear in
 * the tree; within a file, imports keep source order. The list is deduped
 * keeping the FIRST occurrence. Cascade order therefore follows render order,
 * which is stable across reloads and independent of filesystem iteration.
 *
 * ## What is deliberately NOT collected
 *
 * Only relative specifiers (`./x.css`, `../y.css`). A bare package specifier
 * (`@alm-design/design-system/dist/styles.css`) is skipped: those components
 * render through their own `alm.*` modules, which carry their own styling, and
 * pulling a dependency's whole stylesheet into the site's editable class list
 * would bury the user's own classes. Anything resolving outside the workspace
 * root is rejected outright.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Project } from 'ts-morph'
import type { ParsedPage } from '@core/page-parser'

/** Stylesheet extensions worth trying to parse. `.scss`/`.less` are accepted as specifiers but will only parse usefully if they contain plain CSS — `cssToStyleRules` reports the rest as warnings rather than failing the load. */
const STYLESHEET_EXTENSIONS: ReadonlySet<string> = new Set(['.css', '.scss', '.sass', '.less'])

export interface PageStylesheet {
  /** Workspace-relative POSIX path — the stable identity used for deterministic style-rule ids. */
  relPath: string
  /** Absolute path on disk, ready to read. */
  absPath: string
}

/**
 * Every stylesheet `parsed` depends on, in cascade order. Never throws: an
 * unreadable file, an unresolvable specifier, or a specifier escaping the
 * workspace is skipped, matching the parser's degrade-don't-fail contract.
 */
export function collectPageStylesheets(
  parsed: ParsedPage,
  pageRelFile: string,
  project: Project,
  workspaceRoot: string,
): PageStylesheet[] {
  const root = path.resolve(workspaceRoot)
  const collected = new Map<string, PageStylesheet>()

  for (const relFile of contributingFiles(parsed, pageRelFile)) {
    const absFile = path.resolve(root, relFile)
    const sourceFile = project.getSourceFile(absFile)
    if (!sourceFile) continue

    for (const decl of sourceFile.getImportDeclarations()) {
      const sheet = resolveStylesheetSpecifier(decl.getModuleSpecifierValue(), absFile, root)
      if (sheet && !collected.has(sheet.absPath)) collected.set(sheet.absPath, sheet)
    }
  }

  return [...collected.values()]
}

/** The page file, then every distinct `loc.file` in node-insertion order. Deduped, page always first. */
function contributingFiles(parsed: ParsedPage, pageRelFile: string): string[] {
  const seen = new Set<string>([pageRelFile])
  const ordered = [pageRelFile]
  for (const node of Object.values(parsed.nodes)) {
    if (seen.has(node.loc.file)) continue
    seen.add(node.loc.file)
    ordered.push(node.loc.file)
  }
  return ordered
}

/**
 * Resolves one import specifier to a stylesheet inside the workspace, or
 * `undefined` when it isn't one. Strips a Vite query suffix (`?inline`), keeps
 * relative specifiers only, and requires the resolved path to stay under
 * `root` — a `../../../etc/passwd.css` specifier must not become a readable file.
 */
function resolveStylesheetSpecifier(specifier: string, importerAbsPath: string, root: string): PageStylesheet | undefined {
  const withoutQuery = specifier.split('?')[0]!
  if (!withoutQuery.startsWith('./') && !withoutQuery.startsWith('../')) return undefined
  if (!STYLESHEET_EXTENSIONS.has(path.extname(withoutQuery).toLowerCase())) return undefined

  const absPath = path.resolve(path.dirname(importerAbsPath), withoutQuery)
  const relPath = path.relative(root, absPath)
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) return undefined
  if (!existsSync(absPath)) return undefined

  return { relPath: relPath.split(path.sep).join('/'), absPath }
}
