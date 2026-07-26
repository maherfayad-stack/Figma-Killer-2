/**
 * studioProjects — the project-directory model behind Studio's Overview
 * launcher and every `?dir=` resolution.
 *
 * A studio project is an immediate subfolder of `studio-workspace/` (hand-
 * authored or GitHub-imported — they all live in the same place). This module
 * owns the pure(ish) filesystem helpers: enumerating projects, resolving the
 * directory a request operates on, page discovery/counting, and the name
 * slugging + starter page used when scaffolding a new one. Kept separate from
 * `studio.ts` (the HTTP endpoint layer) so that file stays focused on request
 * wiring rather than growing into a god-module.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES, listWorkspaceFiles } from '@core/page-parser'

/**
 * Root that holds every studio project. Each immediate subfolder of
 * `studio-workspace/` IS a project — hand-authored or GitHub-imported, they
 * all live in the same place. There is no single "default workspace" anymore;
 * the container itself is never a project.
 */
export function projectsRootDir(): string {
  return join(process.cwd(), 'studio-workspace')
}

/**
 * Resolves the on-disk directory a studio request operates on. An explicit
 * `dir` (a project the client already knows about, always an immediate
 * subfolder of `studio-workspace/` in normal use) is resolved as-is. When no
 * `dir` is supplied we fall back to the first project on disk (or the root
 * itself when none exist yet, which simply yields an empty page list) so a
 * fresh session still lands somewhere real.
 */
export function resolveProjectDir(requested: string | null | undefined): string {
  if (requested) return resolve(requested)
  const root = projectsRootDir()
  return listStudioProjects(root)[0]?.dir ?? root
}

/**
 * Recursively discovers every page file under a workspace's `pages/` directory
 * (Phase 7A — nested route/page dirs like `pages/marketing/Landing.tsx`, not
 * just a flat top-level scan), returning POSIX paths relative to `pagesDir`,
 * in deterministic sorted order (shared walk/exclusion rule with
 * `collectWorkspaceFiles` via `listWorkspaceFiles`).
 */
export function discoverPageFiles(pagesDir: string): string[] {
  return listWorkspaceFiles(pagesDir).filter((relPath) => relPath.endsWith('.tsx'))
}

/** One on-disk studio project — an immediate subfolder of `studio-workspace/`. */
export interface StudioProjectSummary {
  /** Absolute directory path — passed straight to `setStudioWorkspaceDir`. */
  dir: string
  /** Display name = the folder name. */
  name: string
  /** Number of `.tsx` files discovered under `<dir>/pages/` (0 when it has none). */
  pageCount: number
}

/** `.tsx` page count for a project directory, 0 when it has no `pages/` dir at all. */
function pageCountFor(dir: string): number {
  const pagesDir = join(dir, 'pages')
  return existsSync(pagesDir) ? discoverPageFiles(pagesDir).length : 0
}

/**
 * Per-project display-name sidecar, alongside the existing `.studio/boards.json`
 * and `.studio/framework.json` conventions. Decouples the user-facing project
 * name from the folder slug: the folder is a stable identifier assigned once at
 * creation time (never renamed — renaming a directory mid-session would
 * invalidate any already-open `studioWorkspaceDir` pointer), while the display
 * name can change freely by just rewriting this small JSON file.
 */
interface StudioProjectMeta {
  displayName: string
}

function projectMetaFile(dir: string): string {
  return join(dir, '.studio', 'meta.json')
}

/** Reads `.studio/meta.json`, or `null` when absent/unparsable (falls back to the folder name). */
function readProjectMeta(dir: string): StudioProjectMeta | null {
  const file = projectMetaFile(dir)
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (
      parsed && typeof parsed === 'object' &&
      'displayName' in parsed && typeof parsed.displayName === 'string' &&
      parsed.displayName.trim().length > 0
    ) {
      return { displayName: parsed.displayName }
    }
    return null
  } catch {
    return null
  }
}

/** Writes `.studio/meta.json`, creating the `.studio/` sidecar dir if needed. */
export function writeProjectMeta(dir: string, meta: StudioProjectMeta): void {
  const file = projectMetaFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(meta, null, 2))
}

/** The project's display name — `.studio/meta.json` if present, else the folder name. */
export function projectDisplayName(dir: string): string {
  return readProjectMeta(dir)?.displayName ?? dir.split('/').filter(Boolean).pop() ?? dir
}

/**
 * Lists every studio project: one entry per immediate subfolder of
 * `projectsRoot` (`studio-workspace/`), whether hand-authored or GitHub-
 * imported. Pure-ish (one dir path in, project list out — only reads the
 * filesystem, never writes) so it's unit-testable against a temp fixture tree
 * without a full Request/Response round trip, mirroring `collectWorkspaceFiles`/
 * `discoverPageFiles`'s testing shape.
 *
 * A missing root is not an error — a fresh install with no projects yet simply
 * yields an empty list. Only real directories are considered: a stray file
 * sitting directly in the root is skipped, and the shared
 * `EXCLUDED_WORKSPACE_DIR_NAMES` walk policy keeps this in lockstep with every
 * other place a studio directory tree gets walked. Entries are sorted by
 * directory name for a deterministic response.
 */
export function listStudioProjects(projectsRoot: string): StudioProjectSummary[] {
  if (!existsSync(projectsRoot) || !statSync(projectsRoot).isDirectory()) return []
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !EXCLUDED_WORKSPACE_DIR_NAMES.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const dir = join(projectsRoot, entry.name)
      return { dir, name: projectDisplayName(dir), pageCount: pageCountFor(dir) }
    })
}

/**
 * Next available auto project name: `Untitled`, then `Untitled 2`, `Untitled 3`,
 * … — the first that doesn't collide with any existing project's DISPLAY name.
 * Used when a project is created without a user-supplied name (the one-click
 * "New project" action), mirroring `nextPageName`'s auto-naming pattern.
 */
export function nextProjectName(projectsRoot: string): string {
  const existingNames = new Set(listStudioProjects(projectsRoot).map((p) => p.name))
  for (let n = 1; n < 100_000; n++) {
    const name = n === 1 ? 'Untitled' : `Untitled ${n}`
    if (!existingNames.has(name)) return name
  }
  // Unreachable in practice — 100k untitled projects is not a real case.
  return `Untitled ${Date.now()}`
}

/**
 * Turns a user-supplied project name into a filesystem-safe folder name:
 * lowercased, non-alphanumerics collapsed to single hyphens, trimmed. Returns
 * `''` when nothing usable remains — the create endpoint rejects that rather
 * than writing a nameless folder. Being a pure slug (never `..`, never a path
 * separator) it also can't escape `projectsRootDir()`.
 */
export function safeProjectFolderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Turns a user-supplied page name into a PascalCase component/file name
 * (`"contact us"` → `"ContactUs"`). The result is the `.tsx` file's basename
 * and its default-export function name, so it must be a valid JS identifier:
 * non-alphanumerics split words, each word is capitalized, and a leading digit
 * is prefixed with `Page`. Returns `''` when nothing usable remains — the
 * create-page endpoint rejects that. Being a pure identifier (never `..`,
 * never a path separator) it also can't escape the project's `pages/` dir.
 */
export function pageComponentNameFromInput(name: string): string {
  const parts = name.trim().split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  if (!pascal) return ''
  return /^[0-9]/.test(pascal) ? `Page${pascal}` : pascal
}

/**
 * Next available auto page name for a project's `pages/` dir: `Page`, then
 * `Page2`, `Page3`, … — the first whose `<name>.tsx` file doesn't already
 * exist. Used when a page is created without a user-supplied name (the
 * one-click "New page" action). The loop is bounded defensively; in practice
 * it returns within the first few iterations.
 */
export function nextPageName(pagesDir: string): string {
  for (let n = 1; n < 100_000; n++) {
    const name = n === 1 ? 'Page' : `Page${n}`
    if (!existsSync(join(pagesDir, `${name}.tsx`))) return name
  }
  // Unreachable in practice — a project with 100k pages is not a real case.
  return `Page${Date.now()}`
}

/**
 * Starter page written into a freshly-created page/project so its canvas isn't
 * empty. `componentName` is both the default-export function name and the
 * heading text.
 */
export function starterPage(componentName: string): string {
  return `export default function ${componentName}() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "24px", padding: "64px" }}>
      <h1 style={{ fontSize: "32px", fontWeight: 700 }}>${componentName}</h1>
      <p style={{ color: "#666" }}>Start editing this page in Studio.</p>
    </div>
  )
}
`
}
