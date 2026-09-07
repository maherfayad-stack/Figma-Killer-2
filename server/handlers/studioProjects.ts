/**
 * studioProjects — the project-directory model behind Studio's Overview
 * launcher and every `?dir=` resolution.
 *
 * A studio project is an immediate subfolder of `studio-workspace/` (hand-
 * authored or GitHub-imported — they all live in the same place). This module
 * owns the pure(ish) filesystem helpers: enumerating projects, resolving the
 * directory a request operates on, page discovery/counting, and the name
 * slugging used when scaffolding a new one. The starter FILES a scaffold
 * writes live in `./studio/pageTemplates.ts` — there is one per page kind
 * now, which is more template than a module about project paths should hold.
 *
 * Kept separate from `studio.ts` (the HTTP endpoint layer) so that file stays
 * focused on request wiring rather than growing into a god-module.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES, listWorkspaceFiles } from '@core/page-parser'
import type { ProjectPlatform } from '@core/studio-board'
import {
  DEFAULT_TRUST_TIER,
  mergeStudioMeta,
  readStudioMeta,
  writeStudioMeta,
  type StudioMeta,
  type TrustTier,
} from './studio/studioMeta'
import {
  compilableStyleToolchains,
  type CompilableStyleToolchain,
  type ProjectFramework,
} from './studio/projectProfileSchema'
import { PROJECTS_TRASH_DIR_NAME } from './studio/projectDirGuard'
import { readProjectThumbnailStat } from './studio/projectThumbnailFile'
import { isRealpathContainedAllowingMissing } from './studio/workspacePackageResolve'

/**
 * Root that holds every studio project. Each immediate subfolder of
 * `studio-workspace/` IS a project — hand-authored or GitHub-imported, they
 * all live in the same place. There is no single "default workspace" anymore;
 * the container itself is never a project.
 *
 * `STUDIO_WORKSPACE_DIR` relocates that root, read per call so it can be set
 * for the duration of one test file. It exists because this directory is the
 * anchor of every containment guard in the feature (`assertWithinWorkspace`,
 * `isRealpathContained`, git's `GIT_CEILING_DIRECTORIES`), so a test that
 * needs a project the guards accept would otherwise have to create it inside
 * the developer's OWN workspace — where a killed run leaves the fixture
 * behind and the launcher lists it as a real project. Tests point it at an OS
 * temp dir instead; unset (every normal run, dev or deployed) it is
 * `<cwd>/studio-workspace` exactly as before.
 */
export function projectsRootDir(): string {
  const override = process.env.STUDIO_WORKSPACE_DIR
  return override ? resolve(override) : join(process.cwd(), 'studio-workspace')
}

/**
 * Thrown by {@link resolveProjectDir} for a `dir` that resolves outside
 * `projectsRootDir()`. Named (not a bare `Error`) so callers — and the
 * router's own catch, which turns it into a 404 rather than a 500 — can tell
 * "you asked for somewhere you may not go" apart from any other failure.
 */
export class ProjectDirOutsideWorkspaceError extends Error {
  /** The offending path, as the caller wrote it. Carried as a FIELD, never in `message`: a route-local catch-all that renders `err.message` into a body would otherwise echo a prober's own path back at it. The router logs this; nothing sends it. */
  readonly path: string

  constructor(path: string) {
    super('Requested project directory is outside the Studio workspace root.')
    this.name = 'ProjectDirOutsideWorkspaceError'
    this.path = path
  }
}

/**
 * Re-throw the containment refusal, and only it. Call this FIRST in any
 * `catch` that turns an unknown error into a `Response`.
 *
 * Those catch-alls exist to keep an unexpected failure from taking the server
 * down, and they are right to do that — but a `dir` outside the workspace is
 * not an unexpected failure, it is a client asking for somewhere it may not
 * go, and the answer to that is decided in exactly one place: the router's
 * flat 404 (`server/router.ts`). Without this guard each route would flatten
 * the refusal into its own 404-or-500, which is how "one refusal, one answer"
 * quietly becomes thirty slightly different answers.
 */
export function rethrowProjectDirRefusal(err: unknown): void {
  if (err instanceof ProjectDirOutsideWorkspaceError) throw err
}

/**
 * Resolves the on-disk directory a studio request operates on. An explicit
 * `dir` (a project the client already knows about, always an immediate
 * subfolder of `studio-workspace/` in normal use) is resolved and
 * containment-checked. When no `dir` is supplied we fall back to the first
 * project on disk (or the root itself when none exist yet, which simply
 * yields an empty page list) so a fresh session still lands somewhere real.
 *
 * ## Containment (W10, sec)
 *
 * `dir` is client input on ~70 routes and every Studio MCP tool, and for most
 * of that surface this function is the ONLY thing standing between the string
 * and a filesystem read or write. A bare `resolve()` — what this did — let an
 * agent working in project A pass any absolute path at all and read or write
 * project B, or `~/.ssh`, with every call succeeding.
 *
 * So the resolved path must sit at or under `projectsRootDir()`, with
 * symlinks resolved on BOTH sides (`isRealpathContainedAllowingMissing`) —
 * containment on the textual path alone is bypassable by a symlink inside a
 * GitHub-imported repo, the failure mode `workspacePackageResolve.ts` was
 * written for. "Allowing missing" is what keeps the scaffold/import routes
 * working: a project directory that does not exist YET is checked against its
 * deepest existing ancestor, so a not-yet-created project inside the root
 * passes while `..`/symlink escapes still cannot.
 *
 * Callers do NOT each catch this. It throws, and the router's top-level
 * studio catch answers 404 — a refusal a caller cannot forget to make is
 * worth more than a per-route error branch, and every route on this surface
 * already answers 404 for a dir it will not serve.
 */
export function resolveProjectDir(requested: string | null | undefined): string {
  if (requested) {
    const resolved = resolve(requested)
    if (!isRealpathContainedAllowingMissing(resolved, projectsRootDir())) {
      throw new ProjectDirOutsideWorkspaceError(requested)
    }
    return resolved
  }
  const root = projectsRootDir()
  return listStudioProjects(root)[0]?.dir ?? root
}

/** File extensions a page file may use — `.tsx` (hand-authored) or `.jsx` (a plain-JS React repo, e.g. a GitHub import). */
const PAGE_FILE_EXTENSIONS = ['.tsx', '.jsx'] as const

/** A page file for every framework except `next-app` — the one rule, shared by discovery and by the launcher summary's count. */
function isPageFile(relPath: string): boolean {
  return PAGE_FILE_EXTENSIONS.some((ext) => relPath.endsWith(ext))
}

/**
 * Recursively discovers every page file under a workspace's pages directory
 * (Phase 7A — nested route/page dirs like `pages/marketing/Landing.tsx`, not
 * just a flat top-level scan), returning POSIX paths relative to `pagesDir`,
 * in deterministic sorted order (shared walk/exclusion rule with
 * `collectWorkspaceFiles` via `listWorkspaceFiles`).
 */
export function discoverPageFiles(pagesDir: string): string[] {
  return listWorkspaceFiles(pagesDir).filter(isPageFile)
}

// ---------------------------------------------------------------------------
// Next.js App Router (WS-1.3) — route discovery + layout chain. Only ever
// consulted when `ProjectProfile.framework === 'next-app'` (the probe already
// detected this, `meta-04`); `discoverPageFiles` above is UNCHANGED and stays
// the only page-discovery path for every other framework.
// ---------------------------------------------------------------------------

/** A `page.tsx`/`page.jsx` anywhere under `app/`, whatever the nesting. */
const NEXT_APP_PAGE_FILE_RE = /(^|\/)page\.(tsx|jsx)$/

/** A `page.tsx`/`page.jsx` — one App Router ROUTE, whatever the nesting. Shared with the launcher summary's count. */
function isAppRouterPageFile(relPath: string): boolean {
  return NEXT_APP_PAGE_FILE_RE.test(relPath)
}

/** One discovered App Router route: its `page.tsx` file and the URL it renders at. */
export interface AppRouterRoute {
  /** POSIX path to the route's `page.tsx`/`page.jsx`, relative to the app router directory (`app/` by default). */
  relPath: string
  /** The route derived from `relPath` — see `routeFromAppPageRelPath`. */
  route: string
}

/**
 * Discovers every ROUTE under a Next.js App Router directory — one
 * `page.tsx`/`page.jsx` per route, which is what should get one frame on the
 * board (`app/(marketing)/pricing/page.tsx` -> `/pricing`). `layout.tsx` and
 * `template.tsx` files are real and are discovered separately
 * (`collectAppRouterLayoutChain`) — they compose AROUND a route's page, they
 * are never routes of their own.
 *
 * Reuses `listWorkspaceFiles`'s sorted, excluded-dir-aware walk (skips
 * `.git`/`node_modules`/`.next`/etc, same list every other workspace scan
 * uses), so an `app/api/hello/route.ts` handler or a `loading.tsx`/`error.tsx`
 * boundary is walked over but never matches `NEXT_APP_PAGE_FILE_RE`.
 */
export function discoverAppRouterRoutes(appDir: string): AppRouterRoute[] {
  return listWorkspaceFiles(appDir)
    .filter(isAppRouterPageFile)
    .map((relPath) => ({ relPath, route: routeFromAppPageRelPath(relPath) }))
}

/**
 * `app/(marketing)/pricing/page.tsx` -> `/pricing`. Pure string transform of
 * the file's directory segments — the file's own name (`page.tsx`) is always
 * dropped, it names the file, not a path segment.
 *
 *   - A route GROUP (`(marketing)`) organizes files without appearing in the
 *     URL — dropped entirely.
 *   - A parallel-route slot (`@modal`) names a slot, not a path segment —
 *     dropped entirely, same reasoning.
 *   - A dynamic segment (`[slug]`) becomes `:slug` — still one segment,
 *     readable instead of bracketed.
 *   - A catch-all (`[...slug]`) or optional catch-all (`[[...slug]]`) becomes
 *     `*slug` — reads as "the rest of the path", and is unambiguous next to
 *     the `:slug` form above.
 *
 * A page with every segment stripped (e.g. `app/(marketing)/page.tsx`, the
 * marketing group's own index) is the root route, `/`.
 */
export function routeFromAppPageRelPath(relPath: string): string {
  const dirSegments = relPath.split('/').slice(0, -1)
  const routeSegments = dirSegments
    .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith('@'))
    .map((segment) => {
      const catchAll = /^\[\[?\.\.\.([^\]]+)\]?\]$/.exec(segment)
      if (catchAll) return `*${catchAll[1]}`
      const dynamic = /^\[([^.[\]]+)\]$/.exec(segment)
      if (dynamic) return `:${dynamic[1]}`
      return segment
    })
  return routeSegments.length > 0 ? `/${routeSegments.join('/')}` : '/'
}

/**
 * The `layout.tsx`/`layout.jsx` chain a route composes through, OUTERMOST
 * first: `app/layout.tsx` (Next requires a root layout), then each ancestor
 * segment's own `layout.tsx` down to — but not including — the page file
 * itself, in the order `composeAppRouterRoute` needs to wrap from the
 * outside in.
 *
 * Walks the page's RAW directory segments, route groups included — they are
 * real directories on disk (`app/(marketing)/layout.tsx` is a real file even
 * though `(marketing)` never appears in the URL). A directory with neither a
 * `.tsx` nor a `.jsx` layout simply contributes nothing at that level.
 */
export function collectAppRouterLayoutChain(appDir: string, pageRelPath: string): string[] {
  const dirSegments = pageRelPath.split('/').slice(0, -1)
  const chain: string[] = []
  for (let depth = 0; depth <= dirSegments.length; depth++) {
    const ancestorSegments = dirSegments.slice(0, depth)
    for (const ext of ['tsx', 'jsx']) {
      const relLayoutPath = [...ancestorSegments, `layout.${ext}`].join('/')
      if (existsSync(join(appDir, ...ancestorSegments, `layout.${ext}`))) {
        chain.push(relLayoutPath)
        break
      }
    }
  }
  return chain
}

/**
 * One on-disk studio project — an immediate subfolder of `studio-workspace/`.
 *
 * Everything past `pageCount` is what the Overview launcher needs to describe
 * a project card BEFORE the user opens it. All of it comes from reads
 * `listStudioProjects` was already doing and throwing away (`.studio/meta.json`
 * per entry, the pages-dir walk) plus one `statSync` per file in that walk —
 * nothing here probes, compiles, parses, or runs anything.
 */
export interface StudioProjectSummary {
  /** Absolute directory path — passed straight to `setStudioWorkspaceDir`. */
  dir: string
  /** Display name — `.studio/meta.json`'s `displayName`, else the folder name. */
  name: string
  /** Number of page files discovered under the project's pages dir (0 when it has none). */
  pageCount: number
  /**
   * The form factor chosen at creation (`.studio/meta.json`'s `platform`).
   * Absent for every GitHub/zip import and every project created before the
   * field existed — the launcher then badges nothing rather than guessing
   * "web" from a frame width that the author may simply never have changed.
   */
  platform?: ProjectPlatform
  /**
   * Framework from the CACHED probe (`.studio/meta.json`'s `profile`), absent
   * when the project has never been probed. This listing NEVER probes: a
   * probe reads package manifests and walks candidate directories for every
   * project on disk, which is not what a launcher render should cost.
   */
  framework?: ProjectFramework
  /** Trust tier from `.studio/meta.json`, `'static'` (Tier 0) when unset — which is every fresh import. */
  trust: TrustTier
  /**
   * Style toolchains the cached probe found that only run at Tier ≥ 1. Empty
   * for a project that renders everything it can at Tier 0, and empty for an
   * unprobed one. Paired with `trust === 'static'` this is the launcher's
   * answer to "why did this project open unstyled?" — asked before it opens.
   */
  styleToolchains: CompilableStyleToolchain[]
  /**
   * Newest mtime (epoch ms) among the files under the project's pages dir,
   * floored by the project directory's own mtime. This is "edited" in the
   * sense the user means it: writing a style into a `.tsx`, adding a page, or
   * changing a co-located `.module.css` all move it, and none of them move the
   * pages directory's own mtime (writing an existing file does not touch its
   * parent). A project with no pages dir reports its folder's mtime.
   */
  editedAt: number
  /**
   * W7-3 — whether `.studio/thumbnail.png` exists. The card renders the folder
   * glyph placeholder when it doesn't, and the listing route enqueues a
   * capture for exactly these projects (`studio/projectThumbnailQueue.ts`).
   */
  hasThumbnail: boolean
  /**
   * The thumbnail's mtime (epoch ms), absent when there is none. The card
   * carries it in the image URL so a NEW capture is fetched immediately
   * instead of waiting for the browser to revalidate a cached one — a
   * conditional GET the listing has already answered.
   */
  thumbnailUpdatedAt?: number
}

/** `statSync(path).mtimeMs`, or 0 for anything unreadable (a race with a delete, a permission error). Never throws — a listing must not fail on one file. */
function mtimeMsOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Page count + last-edited time for a project directory, from ONE walk of its
 * (possibly overridden) pages dir.
 *
 * A `next-app` project counts ROUTES (`page.tsx` files), not every
 * `.tsx`/`.jsx` under `app/` — that directory is full of
 * `layout.tsx`/`template.tsx`/`route.ts` files that are not pages of their
 * own. Branches on the cached probe profile, never a guess: an unprobed
 * project falls back to the plain page-file count unchanged.
 *
 * `editedAt` stats every file the walk found, not just the pages: a CSS
 * Module edit is an edit, and the alternative — one `statSync` on the
 * directory itself — reports the last time a file was ADDED or REMOVED, which
 * is not what the card claims. The walk itself already happens for the count;
 * the added cost is one `stat` per file in the pages dir, which is the same
 * order as the `readdir` that produced the list.
 */
function projectPageFacts(dir: string, framework: ProjectFramework | undefined): { pageCount: number; editedAt: number } {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) return { pageCount: 0, editedAt: mtimeMsOf(dir) }
  const relPaths = listWorkspaceFiles(pagesDir)
  const matches = framework === 'next-app' ? isAppRouterPageFile : isPageFile
  let editedAt = mtimeMsOf(dir)
  let pageCount = 0
  for (const relPath of relPaths) {
    if (matches(relPath)) pageCount += 1
    const mtime = mtimeMsOf(join(pagesDir, ...relPath.split('/')))
    if (mtime > editedAt) editedAt = mtime
  }
  return { pageCount, editedAt }
}

/**
 * The full launcher-facing description of one project directory.
 *
 * Single source of the summary shape: the listing, the create route, the
 * rename route and the duplicate route all return one of these, so a card
 * redrawn from a mutation's answer can never carry less than a card drawn
 * from the listing. (Before this existed, `/rename` hand-built its own
 * summary and recomputed `pageCount` with a bare `discoverPageFiles` — which
 * silently reported the wrong number for a `next-app` project.)
 */
export function studioProjectSummary(dir: string): StudioProjectSummary {
  const meta = readStudioMeta(dir)
  const framework = meta.profile?.framework
  const { pageCount, editedAt } = projectPageFacts(dir, framework)
  const thumbnail = readProjectThumbnailStat(dir)
  return {
    dir,
    name: meta.displayName ?? basename(dir) ?? dir,
    pageCount,
    ...(meta.platform !== undefined ? { platform: meta.platform } : null),
    ...(framework !== undefined ? { framework } : null),
    trust: meta.trust ?? DEFAULT_TRUST_TIER,
    styleToolchains: meta.profile ? compilableStyleToolchains(meta.profile) : [],
    editedAt,
    hasThumbnail: thumbnail !== null,
    ...(thumbnail !== null ? { thumbnailUpdatedAt: thumbnail.mtimeMs } : null),
  }
}

/**
 * `.studio/meta.json` — displayName decouples the user-facing project name
 * from the folder slug (a stable identifier assigned once at creation time;
 * renaming the FOLDER mid-session would invalidate any already-open
 * `studioWorkspaceDir` pointer), `pagesDir` overrides where a real-world
 * repo's screens live on disk (e.g. `'src/screens'`), and `previewLocale`
 * (§7.4) is the static evaluator's `preferredKey` for a dictionary indexed by
 * a non-static key.
 *
 * Ownership of the file itself — schema, read, write, merge-write — lives in
 * `./studio/studioMeta.ts` (WS-1.2: TypeBox-validated, additively extended
 * with `trust`, `profile` (the cached project probe), and `frameDefaults`).
 * The functions below keep their original names/signatures so every existing
 * caller (`studio.ts`, `studioProjects.test.ts`) needs no changes; only the
 * implementation now delegates to the schema-validated reader/writer.
 */

/** Writes `.studio/meta.json`, creating the `.studio/` sidecar dir if needed. */
export function writeProjectMeta(dir: string, meta: StudioMeta): void {
  writeStudioMeta(dir, meta)
}

/**
 * Rewrites ONLY the given fields in `.studio/meta.json`, preserving whatever
 * else is already there (a `pagesDir` override from a GitHub import, most
 * importantly — `writeProjectMeta` itself has no merge semantics). Used by
 * the rename endpoint.
 */
export function renameProjectDisplayName(dir: string, displayName: string): void {
  mergeStudioMeta(dir, { displayName })
}

/**
 * Records where this project's screens actually live — the `pagesDir`
 * override `projectPagesDir` consults FIRST, ahead of the probe's own guess.
 *
 * Written by the post-import summary step when the probe had to guess (see
 * `studio/importSummary.ts`), which is the only moment in the product where a
 * human is shown the ranked alternatives and can settle it. A merge write, for
 * the same reason `renameProjectDisplayName` is one: `writeProjectMeta` has no
 * merge semantics, so a plain write here would erase the `displayName` the
 * import had just recorded.
 *
 * No re-probe follows. The override outranks `profile.pagesDir` everywhere it
 * is read, so re-deriving the cached profile would change nothing the loader
 * consults and would risk overwriting the answer the user just gave.
 */
export function setProjectPagesDir(dir: string, pagesDir: string): void {
  mergeStudioMeta(dir, { pagesDir })
}

/**
 * WS-7.2 — "apply to all pages": merges `patch` into `.studio/meta.json`'s
 * `frameDefaults`, preserving whatever field the patch doesn't mention (a
 * width-only apply must not erase a previously-saved default height). Used
 * by the `/admin/api/studio/frame-defaults` route.
 */
export function mergeProjectFrameDefaults(
  dir: string,
  patch: { width?: number; height?: number },
): { width?: number; height?: number } {
  const existing = readStudioMeta(dir).frameDefaults ?? {}
  // Spreading `patch` directly would set e.g. `width: undefined` on a
  // height-only call, which JSON.stringify then drops on write — silently
  // erasing a previously-saved width. Only overwrite fields the caller
  // actually supplied.
  const merged = { ...existing }
  if (patch.width !== undefined) merged.width = patch.width
  if (patch.height !== undefined) merged.height = patch.height
  mergeStudioMeta(dir, { frameDefaults: merged })
  return merged
}

/**
 * The project's display name — `.studio/meta.json` if present, else the folder
 * name. Uses `basename` rather than splitting on `/`: `dir` is an absolute
 * platform path, so a manual POSIX split yields the whole path back on Windows
 * instead of the folder name.
 */
export function projectDisplayName(dir: string): string {
  return readStudioMeta(dir).displayName ?? basename(dir) ?? dir
}

/**
 * Absolute pages dir for a project, in precedence order: `.studio/meta.json`'s
 * explicit `pagesDir` override (hand-set, or set at import time) when present
 * and safe; else the cached probe's `ProjectProfile.pagesDir` (WS-1.2/1.3) —
 * for a `next-app` project this is `'app'`, and without this fallback a
 * probed-but-not-explicitly-overridden Next project would scan the
 * nonexistent `<dir>/pages` and find nothing; else the default `<dir>/pages`.
 *
 * An explicit override always wins over the probe: a user who has confirmed
 * or hand-set `pagesDir` knows something the probe's own heuristics don't.
 *
 * Belt-and-braces containment check runs on the FINAL joined path regardless
 * of which of the three sources it came from — a hand-edited `meta.json` gets
 * no other gate before this value is joined onto a real filesystem path, and
 * `profile.pagesDir` is schema-typed as a bare string with no traversal check
 * of its own.
 */
export function projectPagesDir(dir: string): string {
  const meta = readStudioMeta(dir)
  const pagesDir = join(dir, meta.pagesDir ?? meta.profile?.pagesDir ?? 'pages')
  const root = resolve(dir)
  const resolved = resolve(pagesDir)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Resolved pages dir "${resolved}" escapes project directory "${root}"`)
  }
  return pagesDir
}

/**
 * The project's preview locale (§7.4's `preferredKey`) — `.studio/meta.json`'s
 * `previewAxes.locale` when present, else `undefined` (the evaluator's own
 * fallback is then "first key in source order", which `staticEval.ts`'s
 * `preferredKey` option already implements when left unset). `readStudioMeta`
 * folds a legacy top-level `previewLocale` (pre-WS-10-§4.2 files) into
 * `previewAxes.locale` on read, so this one read path is correct for both an
 * old-shape and a new-shape `meta.json` — see `studioMeta.ts`'s
 * `foldLegacyPreviewLocale`.
 */
export function projectPreviewLocale(dir: string): string | undefined {
  return readStudioMeta(dir).previewAxes?.locale
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
 * other place a studio directory tree gets walked.
 *
 * Entries are sorted by DISPLAY name — the same string the launcher renders —
 * so the order a user reads matches the order they were promised. Sorting the
 * dirents by folder slug instead (what this did until W7-1) is wrong the
 * moment a project is renamed: `.studio/meta.json`'s `displayName` changes and
 * the folder never does, so a project renamed "Zebra" sorts under its original
 * slug forever.
 */
export function listStudioProjects(projectsRoot: string): StudioProjectSummary[] {
  if (!existsSync(projectsRoot) || !statSync(projectsRoot).isDirectory()) return []
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        // The trash is a sibling OF projects, not one of them. Without this
        // skip it lists itself as a project named `.trash`, and opening that
        // would point Studio at a directory whose children are deleted
        // projects. See `./studio/projectTrash.ts`.
        entry.name !== PROJECTS_TRASH_DIR_NAME &&
        !EXCLUDED_WORKSPACE_DIR_NAMES.has(entry.name),
    )
    .map((entry) => studioProjectSummary(join(projectsRoot, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
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
 * Next available auto name for a project's `pages/` dir: `<base>`, then
 * `<base>2`, `<base>3`, … — the first whose `<name><ext>` file doesn't already
 * exist. Used when a page is created without a user-supplied name (the
 * "New page" action).
 *
 * `ext` defaults to `.tsx` (D5's scaffold default) but MUST be the extension
 * the caller is about to write — passing the wrong one checks for collisions
 * against files that were never going to exist (e.g. checking `.tsx` in an
 * all-`.jsx` project always finds nothing free, and a real `Page.jsx`
 * collision goes undetected until the write itself 409s).
 *
 * `base` is the page KIND's own name base (`pageNameBase`, `./studio/
 * pageTemplates.ts`), so an unnamed bottom sheet lands as `Sheet`/`Sheet2`
 * rather than `Page7`. It defaults to `Page` because that is genuinely what an
 * ordinary screen is called, not as a shim for callers that forgot to pass it.
 *
 * The loop is bounded defensively; in practice it returns within the first few
 * iterations.
 */
export function nextPageName(pagesDir: string, ext: '.tsx' | '.jsx' = '.tsx', base = 'Page'): string {
  for (let n = 1; n < 100_000; n++) {
    const name = n === 1 ? base : `${base}${n}`
    if (!existsSync(join(pagesDir, `${name}${ext}`))) return name
  }
  // Unreachable in practice — a project with 100k pages is not a real case.
  return `${base}${Date.now()}`
}
