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
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES, listWorkspaceFiles } from '@core/page-parser'
import { mergeStudioMeta, readStudioMeta, writeStudioMeta, type StudioMeta } from './studio/studioMeta'

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

/** File extensions a page file may use — `.tsx` (hand-authored) or `.jsx` (a plain-JS React repo, e.g. a GitHub import). */
const PAGE_FILE_EXTENSIONS = ['.tsx', '.jsx'] as const

/**
 * Recursively discovers every page file under a workspace's pages directory
 * (Phase 7A — nested route/page dirs like `pages/marketing/Landing.tsx`, not
 * just a flat top-level scan), returning POSIX paths relative to `pagesDir`,
 * in deterministic sorted order (shared walk/exclusion rule with
 * `collectWorkspaceFiles` via `listWorkspaceFiles`).
 */
export function discoverPageFiles(pagesDir: string): string[] {
  return listWorkspaceFiles(pagesDir).filter((relPath) => PAGE_FILE_EXTENSIONS.some((ext) => relPath.endsWith(ext)))
}

// ---------------------------------------------------------------------------
// Next.js App Router (WS-1.3) — route discovery + layout chain. Only ever
// consulted when `ProjectProfile.framework === 'next-app'` (the probe already
// detected this, `meta-04`); `discoverPageFiles` above is UNCHANGED and stays
// the only page-discovery path for every other framework.
// ---------------------------------------------------------------------------

/** A `page.tsx`/`page.jsx` anywhere under `app/`, whatever the nesting. */
const NEXT_APP_PAGE_FILE_RE = /(^|\/)page\.(tsx|jsx)$/

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
    .filter((relPath) => NEXT_APP_PAGE_FILE_RE.test(relPath))
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

/** One on-disk studio project — an immediate subfolder of `studio-workspace/`. */
export interface StudioProjectSummary {
  /** Absolute directory path — passed straight to `setStudioWorkspaceDir`. */
  dir: string
  /** Display name = the folder name. */
  name: string
  /** Number of page files discovered under the project's pages dir (0 when it has none). */
  pageCount: number
}

/**
 * Page count for a project directory, 0 when its (possibly overridden) pages
 * dir doesn't exist. A `next-app` project counts ROUTES (`page.tsx` files),
 * not every `.tsx`/`.jsx` under `app/` — that directory is full of
 * `layout.tsx`/`template.tsx`/`route.ts` files that are not pages of their
 * own, and `discoverPageFiles` (used for every other framework) has no notion
 * of that distinction. Branches on the cached probe profile, never a guess —
 * an unprobed project (no `.studio/meta.json` yet) falls back to the
 * `discoverPageFiles` count unchanged, exactly today's behaviour.
 */
function pageCountFor(dir: string): number {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) return 0
  if (readStudioMeta(dir).profile?.framework === 'next-app') return discoverAppRouterRoutes(pagesDir).length
  return discoverPageFiles(pagesDir).length
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
 * The project's `previewLocale` (§7.4) — `.studio/meta.json`'s value when
 * present, else `undefined` (the evaluator's own fallback is then "first key
 * in source order", which `staticEval.ts`'s `preferredKey` option already
 * implements when left unset).
 */
export function projectPreviewLocale(dir: string): string | undefined {
  return readStudioMeta(dir).previewLocale
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
 * `Page2`, `Page3`, … — the first whose `<name><ext>` file doesn't already
 * exist. Used when a page is created without a user-supplied name (the
 * one-click "New page" action). `ext` defaults to `.tsx` (D5's scaffold
 * default) but MUST be the extension the caller is about to write — passing
 * the wrong one checks for collisions against files that were never going to
 * exist (e.g. checking `.tsx` in an all-`.jsx` project always finds nothing
 * free, and a real `Page.jsx` collision goes undetected until the write
 * itself 409s). The loop is bounded defensively; in practice it returns
 * within the first few iterations.
 */
export function nextPageName(pagesDir: string, ext: '.tsx' | '.jsx' = '.tsx'): string {
  for (let n = 1; n < 100_000; n++) {
    const name = n === 1 ? 'Page' : `Page${n}`
    if (!existsSync(join(pagesDir, `${name}${ext}`))) return name
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
