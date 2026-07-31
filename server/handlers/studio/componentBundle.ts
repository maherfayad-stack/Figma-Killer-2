/**
 * componentBundle — WS-3.2 of `STUDIO-IMPORT-V2-PLAN.md`: turns the
 * component manifests `packageManifest.ts` extracts into an actual, browser-
 * loadable bundle the canvas can `import()`.
 *
 *   POST /admin/api/studio/component-bundle   body: { dir? }
 *       -> `{ ok: true, url, hash, components, warnings }` on success, or
 *          `{ ok: false, code, message, warnings? }` on a REFUSAL (Tier 0,
 *          React-major mismatch, a build that failed) — never a thrown 500
 *          for an expected condition, matching `compileProjectStyles`'s own
 *          "never throws, warnings/refusals only" contract.
 *   GET  /admin/api/studio/component-bundle?dir=<abs>&hash=<hash>
 *       Serves the built `.js` file at `url` above — same containment
 *       posture as `studioAsset.ts` (belt-and-braces realpath containment),
 *       applied to `.studio/cache/bundle-<hash>.js` specifically (which
 *       `resolveStudioAssetResponse` itself would REFUSE, since `.studio` is
 *       in `EXCLUDED_WORKSPACE_DIR_NAMES` — this route exists precisely
 *       because that endpoint is deliberately not the right tool for a
 *       generated artefact).
 *
 * **React identity — the crux, and why this file invents nothing new.**
 * Two React copies in one page means hooks throw ("Invalid hook call") and
 * context is invisible across the boundary. The roadmap's own sketch
 * proposed a NEW import map + new shim endpoints
 * (`/admin/api/studio/react-shim.js`, …) — but `standing-04` (STATE.md) points
 * at a mechanism that already exists and already does exactly this: the
 * PLUGIN runtime's import map, declared once in `index.html`:
 *
 *     "react": "/runtime/react.js"
 *     "react-dom": "/runtime/react-dom.js"
 *     "react/jsx-runtime": "/runtime/react-jsx-runtime.js"
 *     "react/jsx-dev-runtime": "/runtime/react-jsx-dev-runtime.js"
 *
 * Those shims (`public/runtime/*.js`) re-export `globalThis.__studio.React`
 * — the editor's OWN live React instance, populated once by
 * `src/admin/pluginRuntimeBootstrap.ts`'s `installPluginRuntime()`. That
 * import map is declared at the TOP-LEVEL document (not per-iframe — the
 * plugin SANDBOX case in `moduleSandboxSrcDoc.ts` additionally repeats it
 * inside each sandboxed `srcDoc`, which is a different consumer of the same
 * shim files). A package-component bundle is `import()`ed from the admin's
 * OWN top-level document too (components render via `NodeRenderer`, portalled
 * into the canvas iframe — the same arrangement `src/modules/alm/register.tsx`
 * already uses today, successfully, for the hardcoded `@alm-design` case) —
 * so it resolves through the SAME already-declared map, for free. This
 * module's only job is making `EXTERNAL_SPECIFIERS` below match that map's
 * key names exactly (`Bun.build`'s `external` list) — zero new shim files,
 * zero new route, zero `index.html` change.
 *
 * **This was measured against the alternative, not assumed.** A Bun-plugin
 * rewrite of bare `react` imports to `globalThis.__studio.React` directly
 * (the roadmap's own documented fallback) would ALSO work, but is strictly
 * worse here: it requires writing and maintaining a `Bun.build` plugin, and
 * still needs `globalThis.__studio` populated before the bundle runs — the
 * import-map path needs neither a new plugin nor a new document change,
 * because both pieces (the map, the global) already ship for the plugin
 * host. The one thing a FUTURE integration (WS-3.3, the actual
 * `import()`/registration step — out of scope here) must do: call
 * `installPluginRuntime()` (or confirm it already ran) BEFORE `import()`ing
 * a bundle URL this route returns, exactly like `PluginPageRenderer.tsx`
 * already does for plugin bundles. See the `pkg-01` STATE.md entry.
 *
 * **Security posture — Bundling is Tier 1, no exceptions.** `Bun.build` can
 * execute a Bun **macro** at build time, and it resolves whatever the
 * bundled package's OWN code imports from `node_modules` — running a
 * workspace's real code. This route refuses outright at Tier 0
 * (`readStudioMeta(dir).trust !== 'static'`, `meta-03` decision 1: never
 * auto-promote) BEFORE doing anything Tier-1-shaped. The actual `Bun.build`
 * call happens in a subprocess (`componentBundleWorker.ts`, spawned via
 * `subprocessRunner.ts`'s `runCappedSubprocess` with
 * `minimalSubprocessEnv()`) — same reasoning, same primitives `sec-01`
 * already built for `styleCompile.ts`'s Sass/PostCSS/Tailwind execution,
 * reused rather than reimplemented. `packageManifest.ts`'s OWN extraction
 * (called from THIS process, not the subprocess) never executes anything —
 * it only ever parses `.d.ts`/`.tsx` text — so it is safe to run even before
 * the Tier-1 gate gets checked; this route still gates the WHOLE endpoint at
 * Tier 1 regardless, because the manifest alone is useless without the
 * bundle, and one consent gate for the whole feature is simpler to reason
 * about than two.
 *
 * Demand list (WS-3.1's own spec): `ProjectProfile.componentPackages` only,
 * for THIS slice — the plan's second source ("any bare specifier the parser
 * actually saw a JSX component imported from") would need a full page-parse
 * pass this route has no other reason to run, and is an explicit, documented
 * gap here rather than an unbounded scope expansion. See the `pkg-01`
 * STATE.md entry for what would need to be true to add it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { sanitizePackageName } from '@core/module-engine'
import { safeParseJson } from '@core/utils/jsonValidate'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { serveStaticFile } from '../../static'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { resolveAppRoot } from './appRoot'
import { buildPackageManifest, resolvePackageDtsEntry, resolvePackageTsxEntry } from './packageManifest'
import type { ComponentSpec } from './packageManifestSchema'
import { probeProject } from './projectProbe'
import type { ProbeWarning } from './projectProfileSchema'
import { runCappedSubprocess, minimalSubprocessEnv } from './subprocessRunner'
import { DEFAULT_TRUST_TIER, readStudioMeta, type TrustTier } from './studioMeta'
import { isRealpathContained } from './workspacePackageResolve'
import type { ComponentBundleTask, ComponentBundleWorkerResult } from './componentBundleWorker'

const ROUTE_PATH = '/admin/api/studio/component-bundle'

/** Matches `index.html`'s plugin-runtime import map keys exactly — see module doc. */
const EXTERNAL_SPECIFIERS = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] as const

const BUNDLE_TIMEOUT_MS = 60_000
/** Unminified per WS-3.2's own spec (readable stack traces) — generous but bounded; a component subset of even a large design system stays well under this. */
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
/** stdout only ever carries `{ ok, errors }` now — the bundle itself is written straight to disk by the worker (`componentBundleWorker.ts`'s own doc explains why). */
const WORKER_MAX_STDOUT_BYTES = 256 * 1024
const WORKER_MAX_STDERR_BYTES = 64 * 1024

const WORKER_SCRIPT_PATH = join(import.meta.dir, 'componentBundleWorker.ts')

/** `ComponentSpec` itself is package-agnostic (see `packageManifest.ts`'s own contract) — `pkg` is the aggregation this route's response adds on top. */
export type BundledComponentSpec = ComponentSpec & { pkg: string }

// ---------------------------------------------------------------------------
// Demand list — WS-3.1's `ProjectProfile.componentPackages` source only, see module doc
// ---------------------------------------------------------------------------

function componentPackageDemand(dir: string): string[] {
  const profile = readStudioMeta(dir).profile ?? probeProject(dir)
  return [...profile.componentPackages].sort()
}

// ---------------------------------------------------------------------------
// React version-skew check — read from package.json, per WS-3.2's own spec
// ---------------------------------------------------------------------------

const PackageJsonReactFieldsSchema = Type.Object({
  version: Type.Optional(Type.String()),
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
})

function readPackageJsonFields(absPath: string) {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > 2_000_000) return undefined
    const result = safeParseJson(readFileSync(absPath, 'utf8'), PackageJsonReactFieldsSchema)
    return result.ok ? result.value : undefined
  } catch {
    return undefined
  }
}

function majorFromVersion(version: string): number | undefined {
  const match = /(\d+)/.exec(version)
  if (!match) return undefined
  const n = Number.parseInt(match[1]!, 10)
  return Number.isFinite(n) ? n : undefined
}

/** The admin server's OWN installed React major — this repo's own `node_modules/react`, always present (it's a direct dependency). */
function hostReactMajor(): number | undefined {
  const version = readPackageJsonFields(join(process.cwd(), 'node_modules', 'react', 'package.json'))?.version
  return version ? majorFromVersion(version) : undefined
}

/** The workspace's DECLARED react dependency major, read from `package.json` — per WS-3.2's own spec ("detect the workspace's React major from its package.json"), not the installed `node_modules` copy. `appRootAbs` (`approot-01`) — a nested app's own `package.json` is not necessarily at the project directory. */
function workspaceReactMajor(appRootAbs: string): number | undefined {
  const fields = readPackageJsonFields(join(appRootAbs, 'package.json'))
  const spec = fields?.dependencies?.react ?? fields?.devDependencies?.react
  return spec ? majorFromVersion(spec) : undefined
}

// ---------------------------------------------------------------------------
// Cache — content-hash keyed, `.studio/cache/bundle-<hash>.{js,json}`
// ---------------------------------------------------------------------------

function cacheFilePaths(dir: string, hash: string): { js: string; json: string } {
  const cacheDir = join(dir, '.studio', 'cache')
  return { js: join(cacheDir, `bundle-${hash}.js`), json: join(cacheDir, `bundle-${hash}.json`) }
}

function readPackageVersion(pkgJsonPath: string): string | undefined {
  return readPackageJsonFields(pkgJsonPath)?.version
}

/**
 * Fingerprints the trust tier, each demanded package's installed version, and
 * each package's resolved `.d.ts`/`.tsx` entry file's stat (size + mtime) —
 * the version-alone key would go stale for a locally-linked package whose
 * source changed without a version bump, same reasoning
 * `computeStyleCacheKey` gives for over-invalidating on purpose. `dir` is
 * whichever directory's OWN `node_modules` the demanded packages resolve
 * from — the real route passes its resolved app root (`approot-01`), not
 * necessarily the project directory.
 */
export function computeBundleCacheKey(dir: string, trust: TrustTier, demand: readonly string[]): string {
  const hash = createHash('sha1')
  hash.update(trust)
  for (const pkg of demand) {
    const pkgDir = join(dir, 'node_modules', ...pkg.split('/'))
    hash.update(`${pkg}@${readPackageVersion(join(pkgDir, 'package.json')) ?? 'unknown'}`)
    for (const entry of [resolvePackageDtsEntry(dir, pkg), resolvePackageTsxEntry(dir, pkg)]) {
      if (!entry) continue
      try {
        const stat = statSync(entry)
        hash.update(`${entry}:${stat.size}:${stat.mtimeMs}`)
      } catch {
        // missing between resolution and stat — ignore, the version fingerprint above still contributes
      }
    }
  }
  return hash.digest('hex').slice(0, 16)
}

interface BundleCacheSidecar {
  components: BundledComponentSpec[]
  warnings: ProbeWarning[]
}

function readBundleCacheSidecar(jsonPath: string): BundleCacheSidecar | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const { components, warnings } = parsed as Record<string, unknown>
    if (!Array.isArray(components) || !Array.isArray(warnings)) return undefined
    return { components: components as BundledComponentSpec[], warnings: warnings as ProbeWarning[] }
  } catch {
    return undefined
  }
}

function bundleUrl(dir: string, hash: string): string {
  return `${ROUTE_PATH}?dir=${encodeURIComponent(dir)}&hash=${hash}`
}

// ---------------------------------------------------------------------------
// Barrel generation — one generated entry re-exporting every manifested component
// ---------------------------------------------------------------------------

/**
 * `@acme/ui` -> `_acme_ui` — a valid JS identifier fragment, used to
 * namespace the bundle's own export names so two packages exporting the same
 * component name (`Button`) coexist without a local-binding collision (each
 * is its own `export ... from '<pkg>'` re-export statement, which never
 * introduces a local binding at all).
 *
 * Re-exported (not redefined) from `@core/module-engine`'s
 * `packageModuleId.ts` — WS-3.3's `resolveModuleId` (`studioPageLoad.ts`)
 * needs the IDENTICAL sanitization to assign a `PageNode.moduleId` that
 * `registerProjectModules.ts` will actually find in the registry; two
 * separately-maintained copies of this regex would drift silently. Kept as a
 * named export here too so `componentBundle.test.ts`'s existing import
 * (`import { sanitizePackageName } from '../studio/componentBundle'`) keeps
 * working unchanged.
 */
export { sanitizePackageName }

function generateBarrelSource(manifestsByPkg: ReadonlyMap<string, ComponentSpec[]>): string {
  const lines: string[] = []
  for (const [pkg, specs] of manifestsByPkg) {
    const sanitized = sanitizePackageName(pkg)
    for (const spec of specs) {
      const local = spec.isDefaultExport ? 'default' : spec.exportName
      lines.push(`export { ${local} as ${sanitized}__${spec.name} } from ${JSON.stringify(pkg)}`)
    }
  }
  return lines.join('\n') + '\n'
}

function flattenBundledComponents(manifestsByPkg: ReadonlyMap<string, ComponentSpec[]>): BundledComponentSpec[] {
  const out: BundledComponentSpec[] = []
  for (const [pkg, specs] of manifestsByPkg) {
    for (const spec of specs) out.push({ ...spec, pkg })
  }
  return out
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ComponentBundleBodySchema = Type.Object({ dir: Type.Optional(Type.String()) })
const BUNDLE_HASH_RE = /^[0-9a-f]{16}$/

/**
 * `GET/POST /admin/api/studio/component-bundle` — see module doc for the
 * full contract. Matches the `(req, url, pathname) => Response | null`
 * sub-router shape `server/handlers/studio.ts` composes at the top level
 * (`tryServeStudioProbe`/`tryServeStudioInstall`/`tryServeStudioIngest`) —
 * NOT wired into `STUDIO_SUB_ROUTERS` by this change; that file is the
 * orchestrator's, per this work order's own instructions (`standing-05`'s
 * parallel-wave protocol) — see the `pkg-01` STATE.md entry.
 */
export async function tryServeStudioComponentBundle(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const hash = url.searchParams.get('hash')
      if (!hash || !BUNDLE_HASH_RE.test(hash)) return new Response('Not found', { status: 404 })
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

      const { js } = cacheFilePaths(dir, hash)
      if (!isRealpathContained(js, dir)) return new Response('Not found', { status: 404 }) // belt-and-braces, same posture as studioAsset.ts

      const served = await serveStaticFile(dir, `/.studio/cache/bundle-${hash}.js`, req)
      return served ?? new Response('Not found', { status: 404 })
    } catch (err) {
      console.error('[studio:componentBundle]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, ComponentBundleBodySchema)
      if (!body) return badRequest('invalid component-bundle body')
      const dir = resolveProjectDir(body.dir)
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
      // `approot-01` — every node_modules-touching step below (React-version
      // check, cache key, manifest extraction, the bundler subprocess itself)
      // targets the project's APP ROOT, not necessarily `dir`: a nested app
      // installs its own `node_modules` there. `.studio/cache` (the artefact
      // and its sidecar) stays at the PROJECT root regardless — it's Studio's
      // own sidecar, not part of "the app".
      const appRootAbs = resolveAppRoot(dir)

      const demand = componentPackageDemand(dir)
      if (demand.length === 0) {
        return jsonResponse({ ok: true, url: null, hash: null, components: [] as BundledComponentSpec[], warnings: [] as ProbeWarning[] })
      }

      const trust = readStudioMeta(dir).trust ?? DEFAULT_TRUST_TIER
      if (trust === 'static') {
        return jsonResponse({
          ok: false,
          code: 'trust-tier-required',
          message: "This project is at Tier 0 (static), which never runs code. Rendering package components needs Tier 1 (render-packages) — promote the project's trust tier, then try again.",
        })
      }

      const hostMajor = hostReactMajor()
      const wsMajor = workspaceReactMajor(appRootAbs)
      if (wsMajor === undefined) {
        return jsonResponse({
          ok: false,
          code: 'react-not-declared',
          message: "The workspace's package.json declares no react dependency, so its React version can't be confirmed compatible with the editor's own.",
        })
      }
      if (hostMajor !== undefined && wsMajor !== hostMajor) {
        return jsonResponse({
          ok: false,
          code: 'react-version-mismatch',
          message: `This project's React (major ${wsMajor}) differs from the editor's own React (major ${hostMajor}). Rendering package components would throw "Invalid hook call" errors rather than partially render, so this refuses instead.`,
        })
      }

      const hash = computeBundleCacheKey(appRootAbs, trust, demand)
      const { js, json } = cacheFilePaths(dir, hash)
      if (existsSync(js) && existsSync(json)) {
        const cached = readBundleCacheSidecar(json)
        if (cached) return jsonResponse({ ok: true, url: bundleUrl(dir, hash), hash, components: cached.components, warnings: cached.warnings })
      }

      const warnings: ProbeWarning[] = []
      const manifestsByPkg = new Map<string, ComponentSpec[]>()
      for (const pkg of demand) {
        const result = buildPackageManifest(appRootAbs, pkg)
        warnings.push(...result.warnings)
        if (result.components.length > 0) manifestsByPkg.set(pkg, result.components)
      }

      if (manifestsByPkg.size === 0) {
        return jsonResponse({ ok: false, code: 'no-components-found', message: 'No demanded package exposed a component this manifest extractor could find.', warnings })
      }

      const cacheDir = join(dir, '.studio', 'cache')
      mkdirSync(cacheDir, { recursive: true })
      // `approot-01` — the generated barrel MUST live inside the app root's
      // own directory tree: `Bun.build` resolves a bare specifier
      // (`from '@acme/ui'`) by walking UP from the entry file's own location
      // looking for `node_modules` (`componentBundleWorker.ts`'s own doc), so
      // an entry file under `<dir>/.studio/cache/` would never reach
      // `<appRootAbs>/node_modules` when `appRootAbs !== dir` — a SIBLING
      // subtree, never an ancestor. Placed directly at `appRootAbs`'s own
      // top level (zero hops up to its `node_modules`), dot-prefixed as
      // transient scaffolding, deleted right after the subprocess returns —
      // never the artefact itself (that stays at `js`, under `.studio/cache/`).
      const entryAbsPath = join(appRootAbs, `.studio-bundle-entry-${hash}.ts`)
      writeFileSync(entryAbsPath, generateBarrelSource(manifestsByPkg))

      const task: ComponentBundleTask = { entryAbsPath, outputAbsPath: js, external: [...EXTERNAL_SPECIFIERS], maxBundleBytes: MAX_BUNDLE_BYTES }
      const result = await runCappedSubprocess([process.execPath, WORKER_SCRIPT_PATH, JSON.stringify(task)], {
        cwd: appRootAbs,
        env: minimalSubprocessEnv(),
        timeoutMs: BUNDLE_TIMEOUT_MS,
        maxStdoutBytes: WORKER_MAX_STDOUT_BYTES,
        maxStderrBytes: WORKER_MAX_STDERR_BYTES,
      })
      rmSync(entryAbsPath, { force: true }) // scaffolding, not the artefact — never left behind either way

      if (result.timedOut) {
        return jsonResponse({ ok: false, code: 'component-bundle-timeout', message: `Bundling timed out after ${BUNDLE_TIMEOUT_MS}ms.`, warnings })
      }

      let workerResult: ComponentBundleWorkerResult | undefined
      try {
        workerResult = JSON.parse(result.stdout) as ComponentBundleWorkerResult
      } catch {
        // unparseable — handled by the `!workerResult` branch below
      }

      if (!workerResult || result.exitCode !== 0 || !workerResult.ok) {
        console.error('[studio:componentBundle] build failed', result.exitCode, result.stderr, workerResult?.errors)
        return jsonResponse({
          ok: false,
          code: 'component-bundle-failed',
          message: workerResult?.errors.join('; ') || result.stderr.slice(0, 500) || 'Bundling failed.',
          warnings,
        })
      }

      const components = flattenBundledComponents(manifestsByPkg)
      writeFileSync(json, JSON.stringify({ components, warnings } satisfies BundleCacheSidecar))

      return jsonResponse({ ok: true, url: bundleUrl(dir, hash), hash, components, warnings })
    } catch (err) {
      console.error('[studio:componentBundle]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
