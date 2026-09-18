/**
 * Architecture gate — the Studio route table is EXACT in both directions.
 *
 * Every `/admin/api/studio/*` path the handler tree can actually serve must be
 * declared in `server/handlers/studio/routeCapabilities.ts`, and every
 * declaration must name a path the handler tree actually serves.
 *
 * The runtime already fails closed: `gateStudioRequest` answers 404 for an
 * undeclared path, so a route added without a declaration is dead rather than
 * open. This gate turns that dead route into a failing build, with the path
 * named, instead of a bug report that says "the new endpoint 404s".
 *
 * It is the inverse of `cms-handlers-capability-gated.test.ts`. That one scans
 * for a *call* (`requireCapability(...)`) because the CMS tree gates per
 * handler; this one scans for a *route match* because Studio gates per route
 * at one dispatch point. Scanning for the call would prove nothing here —
 * correctly gated Studio sub-routers contain no auth call at all.
 *
 * ## Why this scans route MATCHES and not path literals
 *
 * `sec-14`'s version matched every `'/admin/api/studio/…'` string literal in
 * the tree. That was enough while the table had six `subPaths: true`
 * namespaces, because `git/`, `github/`, `install/`, `deploy/`, `dev-server/`
 * and `prototype/` each absorbed whatever their sub-router dispatched
 * underneath them — and a literal scan cannot see that dispatch at all:
 * `gitSyncRoutes.ts` matches on `action === 'conflict/resolve'` after slicing
 * a prefix off, and `deploy.ts` matches on `` `${ROUTE_PREFIX}/status` ``.
 * Neither is a `/admin/api/studio/…` literal.
 *
 * `sec-16` showed the namespaces were the one place the table stopped being
 * fail-closed (an undeclared GET under any of them inherited `site.read`), and
 * `sec-18` deleted them. That makes the dispatch shapes above the ONLY record
 * of those ~30 paths, so this gate has to understand them:
 *
 *   - `pathname === '<literal>'`
 *   - `pathname === CONST` / `pathname !== CONST`   (resolved from the file)
 *   - ``pathname === `${CONST}/suffix` ``
 *   - `action === '<literal>'`                      (CONST is the file's `…/` prefix)
 *   - ``pathname.startsWith(`${CONST}/`)``          (the job-id shape)
 *
 * Each match also carries whatever `req.method === '…'` appears on the same
 * line, which is how a GET added to a POST-only route fails the build rather
 * than silently taking the route's `read` capability.
 */
import { describe, expect, it } from 'bun:test'
import { readSource, walkSourceTree } from './helpers/sourceTree'
import { toPosixPath } from './pathHelpers'

import { join, relative } from 'node:path'
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

const STUDIO_PATH_CHARS = '[a-z0-9\\-/]*'
/** `const NAME = '/admin/api/studio/…'` */
const CONST_LITERAL_RE = new RegExp(
  `(?:const|let)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*'(${STUDIO_ROUTE_PREFIX}${STUDIO_PATH_CHARS})'`,
  'g',
)
/** ``const NAME = `${OTHER}/suffix` `` */
const CONST_TEMPLATE_RE = /(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*`\$\{([A-Za-z_][A-Za-z0-9_]*)\}([a-z0-9\-/]*)`/g
/** Any `'/admin/api/studio/…'` literal, wherever it sits. */
const PATH_LITERAL_RE = new RegExp(`'(${STUDIO_ROUTE_PREFIX}${STUDIO_PATH_CHARS})'`, 'g')

const PATHNAME_LITERAL_RE = new RegExp(`pathname\\s*[=!]==?\\s*'(${STUDIO_ROUTE_PREFIX}${STUDIO_PATH_CHARS})'`, 'g')
const PATHNAME_CONST_RE = /pathname\s*[=!]==?\s*([A-Za-z_][A-Za-z0-9_]*)/g
const PATHNAME_TEMPLATE_RE = /pathname\s*[=!]==?\s*`\$\{([A-Za-z_][A-Za-z0-9_]*)\}([a-z0-9\-/]*)`/g
const ACTION_LITERAL_RE = /action\s*===\s*'([a-z0-9\-/]*)'/g
const STARTS_WITH_TEMPLATE_RE = /(!?)pathname\.startsWith\(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}\/`\)/g
const METHOD_RE = /req\.method\s*[=!]==?\s*'([A-Z]+)'/g

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const listSourceFiles = (dir: string): string[] =>
  walkSourceTree(dir, ['.ts']).filter(
    (f) => !toPosixPath(f).includes('/__tests__/') && !f.endsWith('.test.ts'),
  )

function scannedFiles(): string[] {
  return [STUDIO_ENTRY, ...listSourceFiles(STUDIO_DIR), ...SHARED_ROUTE_CONSTANT_FILES].filter(
    // The table itself is the declaration, not a usage — scanning it would
    // make every entry trivially justify itself.
    (file) => !file.endsWith('routeCapabilities.ts'),
  )
}

/**
 * `NAME -> '/admin/api/studio/…'` for one file, plus every name that is
 * declared EXACTLY ONCE across the whole scanned set (so an imported constant
 * like `STUDIO_SHARES_ROUTE` resolves, while `ROUTE_PATH` — declared in ~20
 * files with ~20 different values — deliberately does not leak between them).
 */
function collectConstants(sources: ReadonlyMap<string, string>): {
  perFile: Map<string, Map<string, string>>
  globallyUnique: Map<string, string>
} {
  const perFile = new Map<string, Map<string, string>>()
  const counts = new Map<string, Set<string>>()

  for (const [file, src] of sources) {
    const local = new Map<string, string>()
    for (const match of src.matchAll(CONST_LITERAL_RE)) local.set(match[1]!, match[2]!)
    // A second pass so `const B = `${A}/x`` can see `A` whichever order they appear in.
    for (const match of src.matchAll(CONST_TEMPLATE_RE)) {
      const base = local.get(match[2]!)
      if (base) local.set(match[1]!, `${base}${match[3]!}`)
    }
    perFile.set(file, local)
    for (const [name, value] of local) {
      const seen = counts.get(name) ?? new Set<string>()
      seen.add(value)
      counts.set(name, seen)
    }
  }

  const globallyUnique = new Map<string, string>()
  for (const [name, values] of counts) {
    if (values.size === 1) globallyUnique.set(name, [...values][0]!)
  }
  return { perFile, globallyUnique }
}

interface RouteMatch {
  path: string
  methods: string[]
  file: string
  line: number
}

/** Every path this handler tree can dispatch to, with the methods it dispatches on. */
function collectRouteMatches(): { routes: RouteMatch[]; jobIdParents: Map<string, string> } {
  const sources = new Map<string, string>()
  for (const file of scannedFiles()) sources.set(file, readSource(file))
  const { perFile, globallyUnique } = collectConstants(sources)

  const routes: RouteMatch[] = []
  const jobIdParents = new Map<string, string>()

  for (const [file, src] of sources) {
    const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')
    const local = perFile.get(file)!
    const resolveName = (name: string): string | undefined => local.get(name) ?? globallyUnique.get(name)
    // The one `'/admin/api/studio/…/'` constant in this file, if there is
    // exactly one — the prefix an `action === '…'` comparison is relative to.
    const prefixes = [...local.values()].filter((value) => value.endsWith('/'))
    const actionPrefix = prefixes.length === 1 ? prefixes[0]! : undefined

    src.split('\n').forEach((text, index) => {
      const methods = [...text.matchAll(METHOD_RE)].map((m) => m[1]!)
      const push = (path: string): void => {
        routes.push({ path, methods, file: rel, line: index + 1 })
      }

      for (const m of text.matchAll(PATHNAME_LITERAL_RE)) push(m[1]!)
      for (const m of text.matchAll(PATHNAME_CONST_RE)) {
        const name = m[1]!
        // `pathname !== X && !pathname.startsWith(`${X}/`)` is a sub-router's
        // "do I own this whole prefix" guard, not a claim that `X` itself is
        // a route — `dev-server` is owned but never served. A bare
        // `pathname !== X` (`componentBundle.ts`) IS the route.
        if (text.includes(`!pathname.startsWith(\`\${${name}}`)) continue
        const value = resolveName(name)
        if (value && !value.endsWith('/')) push(value)
      }
      for (const m of text.matchAll(PATHNAME_TEMPLATE_RE)) {
        const base = resolveName(m[1]!)
        if (base) push(`${base}${m[2]!}`)
      }
      if (actionPrefix) {
        for (const m of text.matchAll(ACTION_LITERAL_RE)) push(`${actionPrefix}${m[1]!}`)
      }
      for (const m of text.matchAll(STARTS_WITH_TEMPLATE_RE)) {
        // A NEGATED `startsWith` is the sub-router's "do I own this prefix"
        // guard, not a route. Only a positive one dispatches on the id.
        if (m[1] === '!') continue
        const base = resolveName(m[2]!)
        if (base && !base.endsWith('/')) jobIdParents.set(base, `${rel}:${index + 1}`)
      }
    })
  }

  return { routes, jobIdParents }
}

describe('studio-routes-capability-declared gate', () => {
  it('finds the Studio handler tree', () => {
    const { routes } = collectRouteMatches()
    // A regex that silently stopped matching would make this gate pass
    // forever. The tree serves ~90 (path, dispatch-site) pairs today.
    expect(routes.length).toBeGreaterThan(70)
    expect(new Set(routes.map((route) => route.path)).size).toBeGreaterThan(60)
  })

  it('every /admin/api/studio path the handler tree dispatches on has a capability declaration', () => {
    const undeclared = new Map<string, string>()
    for (const { path, file, line } of collectRouteMatches().routes) {
      if (resolveStudioRouteCapability(path)) continue
      if (!undeclared.has(path)) undeclared.set(path, `${file}:${String(line)}`)
    }

    if (undeclared.size > 0) {
      const lines = [...undeclared].map(([path, at]) => `  ${path}   (${at})`).join('\n')
      throw new Error(
        `[studio-routes-capability-declared] Studio routes with no capability declaration:\n${lines}\n\n` +
        `Every /admin/api/studio/** route is gated once, at dispatch, by ` +
        `server/handlers/studio/routeGate.ts using the capability declared in ` +
        `server/handlers/studio/routeCapabilities.ts. An undeclared path answers 404 ` +
        `and never reaches its sub-router.\n` +
        `Add an EXACT entry to STUDIO_ROUTE_CAPABILITIES naming the capability a read and a ` +
        `mutation of this route require (null on either side when the route has no ` +
        `method of that class). There are no namespaces — see that module's doc.`,
      )
    }
    expect(undeclared.size).toBe(0)
  })

  it('every /admin/api/studio literal anywhere in the handler tree is a declared route', () => {
    // The belt to the route-match scan's braces: a dispatch shape this file
    // does not understand still usually leaves its path as a literal
    // somewhere. Two exclusions, both deliberate:
    //   - a trailing `/` marks a PREFIX constant, which is not a route;
    //   - a `const NAME = '…'` DECLARATION is a name, not a dispatch. A
    //     sub-router can own a prefix it never serves bare (`dev-server`),
    //     and the route-match scan above is what decides whether a named
    //     constant is actually dispatched on.
    const undeclared = new Map<string, string>()
    for (const file of scannedFiles()) {
      const src = readSource(file)
      const declarations: [number, number][] = []
      for (const match of src.matchAll(CONST_LITERAL_RE)) {
        declarations.push([match.index, match.index + match[0].length])
      }
      for (const match of src.matchAll(PATH_LITERAL_RE)) {
        const path = match[1]!
        if (path.endsWith('/')) continue
        if (declarations.some(([start, end]) => match.index >= start && match.index < end)) continue
        if (resolveStudioRouteCapability(path)) continue
        undeclared.set(path, relative(REPO_ROOT, file).replaceAll('\\', '/'))
      }
    }
    expect([...undeclared].map(([path, file]) => `${path} (${file})`)).toEqual([])
  })

  it('every capability declaration is reachable from a route the handler tree dispatches on', () => {
    const { routes, jobIdParents } = collectRouteMatches()
    const dispatched = new Set(routes.map((route) => route.path))

    const stale = STUDIO_ROUTE_CAPABILITIES.filter((entry) => !dispatched.has(entry.path)).map((entry) => entry.path)
    if (stale.length > 0) {
      throw new Error(
        `[studio-routes-capability-declared] capability declarations no handler serves:\n` +
        stale.map((path) => `  ${path}`).join('\n') +
        `\n\nA declaration for a route that no longer exists is a capability nobody can ` +
        `audit. Delete the entry from STUDIO_ROUTE_CAPABILITIES.`,
      )
    }
    expect(stale).toHaveLength(0)

    // …and the same both ways for the job-id marker, which is the ONE thing
    // in the table that answers for a path no literal names.
    const declaredJobIds = STUDIO_ROUTE_CAPABILITIES.filter((entry) => entry.jobId).map((entry) => entry.path).sort()
    expect(declaredJobIds).toEqual([...jobIdParents.keys()].sort())
  })

  it('every method class the handler tree dispatches on is declared non-null', () => {
    const wrong: string[] = []
    for (const { path, methods, file, line } of collectRouteMatches().routes) {
      const declaration = resolveStudioRouteCapability(path)
      if (!declaration) continue // already reported by the test above
      for (const method of methods) {
        const isRead = READ_METHODS.has(method)
        const capability = isRead ? declaration.read : declaration.mutate
        if (capability) continue
        wrong.push(`  ${method} ${path} — declares ${isRead ? 'read' : 'mutate'}: null (${file}:${String(line)})`)
      }
    }

    if (wrong.length > 0) {
      throw new Error(
        `[studio-routes-capability-declared] routes dispatched on a method class the table says they do not have:\n` +
        `${wrong.join('\n')}\n\n` +
        `The gate answers 404 for a method class declared \`null\`, so these verbs are ` +
        `unreachable. Name the capability that method needs in STUDIO_ROUTE_CAPABILITIES.`,
      )
    }
    expect(wrong).toEqual([])
  })

  it('declares no namespace-style prefix entry', () => {
    // `sec-16`'s finding, closed at the mechanism: an entry that answered for
    // `${path}/<anything>` handed an undeclared GET `site.read`, the Client
    // role's capability. `jobId` is the deliberate, UUID-shaped replacement —
    // `deploy/run` does not resolve, `deploy/<uuid>` does.
    const table = STUDIO_ROUTE_CAPABILITIES as readonly (Record<string, unknown> & { path: string })[]
    expect(table.filter((entry) => 'subPaths' in entry).map((entry) => entry.path)).toEqual([])
    expect(resolveStudioRouteCapability('/admin/api/studio/git/brand-new-verb')).toBeNull()
    expect(resolveStudioRouteCapability('/admin/api/studio/dev-server/restart')).toBeNull()
    expect(resolveStudioRouteCapability('/admin/api/studio/deploy/run')).toBeNull()
    expect(resolveStudioRouteCapability('/admin/api/studio/install/anything')).toBeNull()
  })

  it('declares no capability outside the four write families plus site.read', () => {
    // Not a style rule — the point of the table is that a reader can see the
    // whole Studio authorization surface in one screen. A capability that
    // appears nowhere else in it would hide in the middle of ~70 rows.
    const allowed = new Set([
      'site.read',
      'site.content.edit',
      'site.structure.edit',
      'studio.write',
      'studio.run.project',
    ])
    const unexpected = new Set<string>()
    for (const entry of STUDIO_ROUTE_CAPABILITIES) {
      for (const capability of [entry.read, entry.mutate, entry.jobId?.read, entry.jobId?.mutate]) {
        if (capability && !allowed.has(capability)) unexpected.add(capability)
      }
    }
    expect([...unexpected]).toEqual([])
  })
})
