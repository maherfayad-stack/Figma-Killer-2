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
import { existsSync, readFileSync } from 'node:fs'
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
 * Conventional app entry points, tried in order when `index.html` doesn't name
 * one. Covers the Vite/CRA React layouts real repos actually use.
 */
const ENTRY_CANDIDATES = [
  'src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx',
  'main.tsx', 'main.jsx', 'index.tsx', 'index.jsx',
] as const

/** Bounds the entry-graph walk. A real app entry reaches every screen; this only stops a pathological repo. */
const MAX_ENTRY_GRAPH_FILES = 2000

/**
 * The GLOBAL stylesheets — the ones reached from the app's entry module rather
 * than from any one screen.
 *
 * This matters more than it sounds. In a Vite React app the design tokens,
 * resets, and the html/body height chain live in `src/index.css` and
 * `src/App.css`, imported by `main.jsx`/`App.jsx`. Neither file contributes a
 * single node to any page, so `collectPageStylesheets` never sees them — and
 * without them every `var(--space-lg)` in a screen's own CSS resolves to
 * nothing, collapsing all spacing. Measured on the eSIM corpus: screens
 * rendered as near-blank sheets until these were collected.
 *
 * The walk follows relative JS/TS imports from the entry, so it naturally
 * reaches `App.css` behind `App.jsx`. Order is source order from the entry
 * outward, which is the order the real app loads them in — and these come
 * FIRST in the cascade, before any page's own CSS, exactly as a reset should.
 */
export function collectEntryStylesheets(project: Project, workspaceRoot: string): PageStylesheet[] {
  const root = path.resolve(workspaceRoot)
  const entry = findEntryFile(root)
  if (!entry) return []

  const collected = new Map<string, PageStylesheet>()
  const visited = new Set<string>()
  const queue: string[] = [entry]

  while (queue.length > 0 && visited.size < MAX_ENTRY_GRAPH_FILES) {
    const absFile = queue.shift()!
    if (visited.has(absFile)) continue
    visited.add(absFile)

    const sourceFile = project.getSourceFile(absFile) ?? addSourceFileSafely(project, absFile)
    if (!sourceFile) continue

    for (const decl of sourceFile.getImportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue()
      const sheet = resolveStylesheetSpecifier(specifier, absFile, root)
      if (sheet) {
        if (!collected.has(sheet.absPath)) collected.set(sheet.absPath, sheet)
        continue
      }
      // Follow relative module imports so `main -> App -> App.css` is reachable.
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
      const target = decl.getModuleSpecifierSourceFile()
      const targetPath = target?.getFilePath()
      if (!targetPath) continue
      const rel = path.relative(root, targetPath)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      if (!visited.has(targetPath)) queue.push(targetPath)
    }
  }

  return [...collected.values()]
}

/** The path in `index.html`'s module script tag, else the first conventional candidate that exists. */
function findEntryFile(root: string): string | undefined {
  const indexHtml = path.join(root, 'index.html')
  if (existsSync(indexHtml)) {
    try {
      const html = readFileSync(indexHtml, 'utf8')
      const match = /<script[^>]*\stype=["']module["'][^>]*\ssrc=["']([^"']+)["']/i.exec(html)
        ?? /<script[^>]*\ssrc=["']([^"']+)["'][^>]*\stype=["']module["']/i.exec(html)
      const src = match?.[1]
      if (src) {
        const abs = path.resolve(root, src.replace(/^\//, ''))
        const rel = path.relative(root, abs)
        if (!rel.startsWith('..') && !path.isAbsolute(rel) && existsSync(abs)) return abs
      }
    } catch {
      // Unreadable index.html — fall through to the conventional candidates.
    }
  }
  for (const candidate of ENTRY_CANDIDATES) {
    const abs = path.join(root, ...candidate.split('/'))
    if (existsSync(abs)) return abs
  }
  return undefined
}

/** The entry graph reaches files no page pulled in, so they may not be in the Project yet. */
function addSourceFileSafely(project: Project, absFile: string): ReturnType<Project['getSourceFile']> {
  try {
    return project.addSourceFileAtPath(absFile)
  } catch {
    return undefined
  }
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
