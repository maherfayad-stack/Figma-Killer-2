/**
 * Architecture gate — every `/admin/api/studio/*` path that appears in the
 * Studio handler tree must be declared in
 * `server/handlers/studio/routeCapabilities.ts`.
 *
 * The runtime already fails closed: `gateStudioRequest` answers 404 for an
 * undeclared path, so a route added without a declaration is dead rather than
 * open. This gate turns that dead route into a failing build, with the path
 * named, instead of a bug report that says "the new endpoint 404s".
 *
 * It is the inverse of `cms-handlers-capability-gated.test.ts`. That one scans
 * for a *call* (`requireCapability(...)`) because the CMS tree gates per
 * handler; this one scans for a *path literal* because Studio gates per route
 * at one dispatch point. Scanning for the call would prove nothing here —
 * correctly gated Studio sub-routers contain no auth call at all.
 *
 * Two directions are checked:
 *
 *   1. Every literal `'/admin/api/studio/…'` in the handler tree resolves to a
 *      declaration (the one that catches a new route).
 *   2. Every declaration is reachable from some literal (the one that catches
 *      a stale entry left behind by a deleted route — a declaration nothing
 *      serves is a capability nobody can audit).
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveStudioRouteCapability,
  STUDIO_ROUTE_CAPABILITIES,
  STUDIO_ROUTE_PREFIX,
} from '../../../server/handlers/studio/routeCapabilities'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const STUDIO_DIR = join(REPO_ROOT, 'server', 'handlers', 'studio')
const STUDIO_ENTRY = join(REPO_ROOT, 'server', 'handlers', 'studio.ts')

/**
 * Files outside the handler tree that nonetheless DEFINE a Studio route path.
 * A route whose URL the browser has to build too keeps its constant in
 * `src/core/` so client and server cannot drift — `shareRoutes.ts` matches on
 * `STUDIO_SHARES_ROUTE`, not on a literal of its own.
 */
const SHARED_ROUTE_CONSTANT_FILES = [
  join(REPO_ROOT, 'src', 'core', 'studio-share', 'shareWire.ts'),
]

/**
 * A path literal in source. Trailing `/` is kept out of the capture so a
 * namespace root written as `'/admin/api/studio/git/'` (the shape `git.ts`
 * uses to slice an action off) resolves the same as `'/admin/api/studio/git'`.
 */
const STUDIO_PATH_RE = /'(\/admin\/api\/studio\/[a-z0-9\-/]*)'/g

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      if (entry === '__tests__') continue
      out.push(...listSourceFiles(full))
      continue
    }
    if (!stats.isFile() || extname(entry) !== '.ts') continue
    if (entry.endsWith('.test.ts')) continue
    out.push(full)
  }
  return out
}

interface FoundPath {
  path: string
  file: string
}

function collectStudioPathLiterals(): FoundPath[] {
  const files = [STUDIO_ENTRY, ...listSourceFiles(STUDIO_DIR), ...SHARED_ROUTE_CONSTANT_FILES]
  const found: FoundPath[] = []
  for (const file of files) {
    // The table itself is the declaration, not a usage — scanning it would
    // make every entry trivially justify itself.
    if (file.endsWith('routeCapabilities.ts')) continue
    const src = readFileSync(file, 'utf8')
    for (const match of src.matchAll(STUDIO_PATH_RE)) {
      const raw = match[1]!
      const path = raw.length > STUDIO_ROUTE_PREFIX.length && raw.endsWith('/') ? raw.slice(0, -1) : raw
      if (path === STUDIO_ROUTE_PREFIX || path === STUDIO_ROUTE_PREFIX.slice(0, -1)) continue
      found.push({ path, file: relative(REPO_ROOT, file).replaceAll('\\', '/') })
    }
  }
  return found
}

describe('studio-routes-capability-declared gate', () => {
  it('finds the Studio handler tree', () => {
    const literals = collectStudioPathLiterals()
    // A regex that silently stops matching would make this gate pass forever.
    expect(literals.length).toBeGreaterThan(40)
  })

  it('every /admin/api/studio path in the handler tree has a capability declaration', () => {
    const undeclared = new Map<string, string>()
    for (const { path, file } of collectStudioPathLiterals()) {
      if (resolveStudioRouteCapability(path)) continue
      if (!undeclared.has(path)) undeclared.set(path, file)
    }

    if (undeclared.size > 0) {
      const lines = [...undeclared].map(([path, file]) => `  ${path}   (${file})`).join('\n')
      throw new Error(
        `[studio-routes-capability-declared] Studio routes with no capability declaration:\n${lines}\n\n` +
        `Every /admin/api/studio/** route is gated once, at dispatch, by ` +
        `server/handlers/studio/routeGate.ts using the capability declared in ` +
        `server/handlers/studio/routeCapabilities.ts. An undeclared path answers 404 ` +
        `and never reaches its sub-router.\n` +
        `Add an entry to STUDIO_ROUTE_CAPABILITIES naming the capability a read and a ` +
        `mutation of this route require (null on either side when the route has no ` +
        `method of that class).`,
      )
    }
    expect(undeclared.size).toBe(0)
  })

  it('every capability declaration is reachable from a route literal', () => {
    const literals = new Set(collectStudioPathLiterals().map((entry) => entry.path))
    const stale = STUDIO_ROUTE_CAPABILITIES.filter((entry) => {
      if (literals.has(entry.path)) return false
      // A namespace is justified by any literal underneath it.
      if (entry.subPaths && [...literals].some((path) => path.startsWith(`${entry.path}/`))) return false
      return true
    }).map((entry) => entry.path)

    if (stale.length > 0) {
      throw new Error(
        `[studio-routes-capability-declared] capability declarations no handler serves:\n` +
        stale.map((path) => `  ${path}`).join('\n') +
        `\n\nA declaration for a route that no longer exists is a capability nobody can ` +
        `audit. Delete the entry from STUDIO_ROUTE_CAPABILITIES.`,
      )
    }
    expect(stale).toHaveLength(0)
  })

  it('declares no capability outside the four write families plus site.read', () => {
    // Not a style rule — the point of the table is that a reader can see the
    // whole Studio authorization surface in one screen. A capability that
    // appears nowhere else in it would hide in the middle of ~55 rows.
    const allowed = new Set([
      'site.read',
      'site.content.edit',
      'site.structure.edit',
      'studio.write',
      'studio.run.project',
    ])
    const unexpected = new Set<string>()
    for (const entry of STUDIO_ROUTE_CAPABILITIES) {
      for (const capability of [entry.read, entry.mutate]) {
        if (capability && !allowed.has(capability)) unexpected.add(capability)
      }
    }
    expect([...unexpected]).toEqual([])
  })
})
