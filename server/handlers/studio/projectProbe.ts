/**
 * projectProbe — WS-1.2 of `STUDIO-IMPORT-V2-PLAN.md`: `dir → ProjectProfile`.
 *
 * Pure(ish): every detection rule reads files (config files, `package.json`,
 * a `.d.ts`, an entry HTML/JS file) and never executes anything — same
 * "parse, never execute" posture as the page parser, extended to project
 * *shape* detection instead of page *content*. Safe to call on a directory
 * that doesn't exist yet, or a project with no `node_modules` installed: every
 * detector degrades to "not found" rather than throwing, so a fresh,
 * uninstalled GitHub import still gets a profile back (just a sparser one,
 * with warnings explaining what's missing).
 *
 * Detection rules (framework, style toolchain, aliases, component packages)
 * follow the table in §WS-1.2 of the plan. Where the plan's own example
 * `ProjectProfile` interface couldn't express a requirement — "present the
 * top 3 candidates so the UI can ask" for the no-routing-framework case —
 * this module adds `pagesDirCandidates` rather than silently picking one and
 * hiding the ambiguity in a warning string.
 *
 * Every entry in `warnings` carries a stable `code` (see the `warnings.push`
 * call sites below for the full set) — WS-9 turns these into MCP fidelity
 * findings, so a code, once shipped, is a contract: rename it and you break
 * whatever's showing it to the user.
 *
 * The `ProjectProfile` shape itself lives in `./projectProfileSchema.ts`, a
 * pure schema leaf, so `studioMeta.ts` can validate the profile it persists
 * without importing this module (which imports it back). Add fields there,
 * not here.
 *
 * Also exports `tryServeStudioProbe`, a router sub-handler with the same
 * `(req, url, pathname) => Response | null` shape `server/router.ts`
 * composes at the top level — `server/handlers/studio.ts` wires it in
 * (that file is the orchestrator's, not touched here).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import { findEntryFile } from '@core/studio-sync/collectPageStylesheets'
import { Type, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir } from '../studioProjects'
import { mergeStudioMeta, readStudioMeta } from './studioMeta'
import type { ProbeWarning, ProjectProfile } from './projectProfileSchema'

// ---------------------------------------------------------------------------
// package.json / tsconfig.json — narrow schemas, real files trusted no further
// ---------------------------------------------------------------------------

const PackageJsonSchema = Type.Object({
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
})
type PackageJsonShape = Static<typeof PackageJsonSchema>

const PackageEntrySchema = Type.Object({
  types: Type.Optional(Type.String()),
  typings: Type.Optional(Type.String()),
})

const VersionOnlySchema = Type.Object({ version: Type.Optional(Type.String()) })

const TsconfigSchema = Type.Object({
  compilerOptions: Type.Optional(
    Type.Object({
      paths: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Config-file name conventions
// ---------------------------------------------------------------------------

const NEXT_CONFIG_NAMES = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'] as const
const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cjs'] as const
const POSTCSS_CONFIG_NAMES = ['postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.ts'] as const
const TAILWIND_CONFIG_NAMES = ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts'] as const
const CRA_ENTRY_CANDIDATES = ['src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js'] as const
/** Directory segments the pages-dir heuristic and the file scans below never consider a "screens" directory. */
const NON_PAGES_DIR_SEGMENTS = new Set(['public', '__tests__', '__mocks__'])

// ---------------------------------------------------------------------------
// Small file-read primitives
// ---------------------------------------------------------------------------

function readTextCapped(absPath: string, maxBytes: number): string | undefined {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > maxBytes) return undefined
    return readFileSync(absPath, 'utf8')
  } catch {
    return undefined
  }
}

function readJsonFileSafe<T extends TSchema>(absPath: string, schema: T, maxBytes: number): Static<T> | undefined {
  const text = readTextCapped(absPath, maxBytes)
  if (text === undefined) return undefined
  const result = safeParseJson(text, schema)
  return result.ok ? result.value : undefined
}

/** JSON.parse, retrying once with `//` line-comments and `/* *\/` block comments stripped — a best-effort JSONC reader for hand-edited tsconfig files. Never throws. */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // fall through to the comment-stripped retry
  }
  try {
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    return JSON.parse(stripped)
  } catch {
    return undefined
  }
}

function findConfigFile(root: string, names: readonly string[]): string | undefined {
  return names.find((name) => existsSync(join(root, name)))
}

/** `path.relative` normalized to POSIX separators — Windows' `path.relative` returns `\`-joined paths, and `ProjectProfile`'s paths are contractually POSIX. */
function toPosixRel(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

function readPackageJson(root: string): PackageJsonShape | undefined {
  return readJsonFileSafe(join(root, 'package.json'), PackageJsonSchema, 2_000_000)
}

function hasDependency(pkg: PackageJsonShape, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
}

// ---------------------------------------------------------------------------
// Package manager
// ---------------------------------------------------------------------------

function detectPackageManager(root: string): 'bun' | 'pnpm' | 'npm' | 'yarn' {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun'
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

// ---------------------------------------------------------------------------
// Framework + routing
// ---------------------------------------------------------------------------

interface FrameworkShape {
  framework: ProjectProfile['framework']
  pagesDir?: string
  routeStyle?: ProjectProfile['routeStyle']
  entryFiles: string[]
  warnings: ProbeWarning[]
}

function hasPageFileUnder(root: string, relDir: string): boolean {
  return listWorkspaceFiles(join(root, ...relDir.split('/'))).some((f) => /(^|\/)page\.(tsx|jsx)$/.test(f))
}

function detectNextRoutes(root: string): { framework: 'next-app' | 'next-pages'; pagesDir: string } | undefined {
  const appDir = existsSync(join(root, 'app')) ? 'app' : existsSync(join(root, 'src', 'app')) ? 'src/app' : undefined
  if (appDir && hasPageFileUnder(root, appDir)) return { framework: 'next-app', pagesDir: appDir }

  const pagesDir = existsSync(join(root, 'pages')) ? 'pages' : existsSync(join(root, 'src', 'pages')) ? 'src/pages' : undefined
  if (pagesDir) return { framework: 'next-pages', pagesDir }

  return undefined
}

function detectFrameworkShape(root: string, pkg: PackageJsonShape | undefined): FrameworkShape {
  const warnings: ProbeWarning[] = []

  if (findConfigFile(root, NEXT_CONFIG_NAMES)) {
    const routes = detectNextRoutes(root)
    if (routes) return { ...routes, routeStyle: 'file-router', entryFiles: [], warnings }
    warnings.push({
      code: 'next-config-no-routes-found',
      message: 'A next.config file was found but neither app/**/page.tsx nor a pages/ directory exists.',
      fix: 'Confirm this is a Next.js project, or remove the next.config file if it is a leftover from scaffolding.',
    })
    return { framework: 'unknown', entryFiles: [], warnings }
  }

  const viteConfig = findConfigFile(root, VITE_CONFIG_NAMES)
  if (viteConfig) {
    const entry = findEntryFile(root)
    if (!entry) {
      warnings.push({
        code: 'vite-entry-not-found',
        message: 'vite.config was found but no entry module (index.html\'s <script type="module" src="...">, or a conventional src/main.* file) could be located.',
        fix: 'Check that index.html\'s module script tag points at a real file.',
      })
    }
    return { framework: 'vite', entryFiles: entry ? [toPosixRel(root, entry)] : [], warnings }
  }

  if (pkg && hasDependency(pkg, 'react-scripts')) {
    const entry = CRA_ENTRY_CANDIDATES.find((rel) => existsSync(join(root, ...rel.split('/'))))
    return { framework: 'cra', entryFiles: entry ? [entry] : [], warnings }
  }

  return { framework: 'unknown', entryFiles: [], warnings }
}

/** Cheap, regex-level "does this file's default export return JSX" signal — not a parse, just a structural smell test for the ranking heuristic below. */
function fileDefaultExportsJsx(absPath: string): boolean {
  const text = readTextCapped(absPath, 100_000)
  if (!text) return false
  if (!/export\s+default\b/.test(text)) return false
  return /return\s*\(?\s*</.test(text) || /=>\s*\(?\s*</.test(text)
}

interface PagesDirCandidate {
  dir: string
  score: number
}

/**
 * Ranks every directory under `root` containing `.tsx`/`.jsx` files by
 * (files whose default export returns JSX) / (total files in that
 * directory), descending. Directories with zero matches are dropped
 * entirely — a components/ or utils/ dir full of non-page helpers should
 * never outrank an empty result. Ties break on match count, then path.
 */
function rankPagesDirCandidates(root: string): PagesDirCandidate[] {
  const byDir = new Map<string, string[]>()
  for (const relFile of listWorkspaceFiles(root)) {
    if (!/\.(tsx|jsx)$/.test(relFile)) continue
    const segments = relFile.split('/')
    if (segments.length < 2) continue // a file sitting at the workspace root isn't "a directory of pages"
    if (segments.some((seg) => NON_PAGES_DIR_SEGMENTS.has(seg))) continue
    const dir = segments.slice(0, -1).join('/')
    const list = byDir.get(dir) ?? []
    list.push(relFile)
    byDir.set(dir, list)
  }

  const scored: (PagesDirCandidate & { matched: number })[] = []
  for (const [dir, relFiles] of byDir) {
    const matched = relFiles.filter((relFile) => fileDefaultExportsJsx(join(root, ...relFile.split('/')))).length
    if (matched === 0) continue
    scored.push({ dir, score: Math.round((matched / relFiles.length) * 100) / 100, matched })
  }
  scored.sort((a, b) => b.score - a.score || b.matched - a.matched || a.dir.localeCompare(b.dir))
  return scored.map(({ dir, score }) => ({ dir, score }))
}

// ---------------------------------------------------------------------------
// Style toolchain
// ---------------------------------------------------------------------------

function resolveInstalledVersion(root: string, pkgName: string): string | undefined {
  return readJsonFileSafe(join(root, 'node_modules', ...pkgName.split('/'), 'package.json'), VersionOnlySchema, 200_000)?.version
}

function cleanSemverSpec(spec: string | undefined): string {
  if (!spec) return 'unknown'
  return spec.replace(/^[~^>=<\s]+/, '') || 'unknown'
}

function findTailwindV4Import(root: string): string | undefined {
  for (const relFile of listWorkspaceFiles(root)) {
    if (!/\.css$/i.test(relFile)) continue
    const text = readTextCapped(join(root, ...relFile.split('/')), 50_000)
    if (text && /@import\s+["']tailwindcss["']/.test(text)) return relFile
  }
  return undefined
}

/** v3 is detected by a config file; v4 by `@import "tailwindcss"` in a stylesheet — the two ship genuinely different config surfaces, so config-file presence alone would misdetect a v4 project. */
function detectTailwind(
  root: string,
  pkg: PackageJsonShape | undefined,
  warnings: ProbeWarning[],
): { version: string; configPath: string } | null {
  if (!pkg || !hasDependency(pkg, 'tailwindcss')) return null
  const declaredSpec = pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss
  const version = () => resolveInstalledVersion(root, 'tailwindcss') ?? cleanSemverSpec(declaredSpec)

  const v3Config = findConfigFile(root, TAILWIND_CONFIG_NAMES)
  if (v3Config) return { version: version(), configPath: v3Config }

  const v4Import = findTailwindV4Import(root)
  if (v4Import) return { version: version(), configPath: v4Import }

  warnings.push({
    code: 'tailwind-config-not-found',
    message: 'tailwindcss is a dependency but neither a v3 config file nor a v4 `@import "tailwindcss"` was found in any stylesheet.',
    fix: 'Add a tailwind.config.{js,ts} (v3) or an `@import "tailwindcss";` line to your entry CSS (v4).',
  })
  return null
}

function hasCssModules(root: string): boolean {
  return listWorkspaceFiles(root).some((f) => /\.module\.(css|scss|sass|less)$/i.test(f))
}

function hasSass(root: string, pkg: PackageJsonShape | undefined): boolean {
  if (pkg && (hasDependency(pkg, 'sass') || hasDependency(pkg, 'node-sass'))) return true
  return listWorkspaceFiles(root).some((f) => /\.(scss|sass)$/i.test(f))
}

function detectCssInJs(pkg: PackageJsonShape | undefined): 'styled-components' | 'emotion' | 'stitches' | null {
  if (!pkg) return null
  if (hasDependency(pkg, 'styled-components')) return 'styled-components'
  if (hasDependency(pkg, '@emotion/react') || hasDependency(pkg, '@emotion/styled')) return 'emotion'
  if (hasDependency(pkg, '@stitches/react')) return 'stitches'
  return null
}

// ---------------------------------------------------------------------------
// Component packages
// ---------------------------------------------------------------------------

const REACT_COMPONENT_EXPORT_RE =
  /export\s+(?:declare\s+)?(?:const|function|class)\s+[A-Z][A-Za-z0-9]*\b[^;{]*(?:JSX\.Element|ReactElement|React\.FC\b|\bFC<|React\.ComponentType|ComponentType<)/

function isComponentPackage(root: string, name: string): boolean {
  const pkgDir = join(root, 'node_modules', ...name.split('/'))
  const entry = readJsonFileSafe(join(pkgDir, 'package.json'), PackageEntrySchema, 200_000)
  const candidates = [entry?.types, entry?.typings, 'index.d.ts', 'dist/index.d.ts'].filter(
    (v): v is string => Boolean(v),
  )
  for (const rel of candidates) {
    const text = readTextCapped(join(pkgDir, ...rel.split('/')), 200_000)
    if (text && REACT_COMPONENT_EXPORT_RE.test(text)) return true
  }
  return false
}

function detectComponentPackages(root: string, pkg: PackageJsonShape | undefined, warnings: ProbeWarning[]): string[] {
  const names = pkg ? [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])] : []
  if (names.length === 0) return []
  if (!existsSync(join(root, 'node_modules'))) {
    warnings.push({
      code: 'dependencies-not-installed',
      message: 'package.json lists dependencies but node_modules is missing, so package-component detection was skipped.',
      fix: 'Run dependency install (WS-1.4), then re-run the project probe.',
    })
    return []
  }
  return names.filter((name) => isComponentPackage(root, name)).sort()
}

// ---------------------------------------------------------------------------
// Aliases — tsconfig `paths` merged UNDER vite `resolve.alias` (vite wins)
// ---------------------------------------------------------------------------

function extractTsconfigAliases(root: string): Record<string, string> {
  const file = findConfigFile(root, ['tsconfig.json', 'jsconfig.json'])
  if (!file) return {}
  const text = readTextCapped(join(root, file), 500_000)
  if (text === undefined) return {}
  const raw = parseJsonLoose(text)
  if (!compiledCheck(TsconfigSchema, raw)) return {}
  const paths = raw.compilerOptions?.paths
  if (!paths) return {}
  const aliases: Record<string, string> = {}
  for (const [key, targets] of Object.entries(paths)) {
    const target = targets[0]
    if (!target) continue
    aliases[key.replace(/\*$/, '')] = target.replace(/\*$/, '')
  }
  return aliases
}

/**
 * Best-effort regex extraction of `resolve.alias` entries from a
 * `vite.config.*` file — genuinely running the config to get the real value
 * would mean executing arbitrary code from an unaudited repo, which this
 * probe never does. Handles the two shapes real configs actually use:
 * `'@': path.resolve(__dirname, './src')` and `'@': '/src'`. A config that
 * builds its alias map some other way (a spread, a helper function) simply
 * yields no aliases here rather than a wrong one.
 */
function extractViteAliases(root: string): Record<string, string> {
  const configFile = findConfigFile(root, VITE_CONFIG_NAMES)
  if (!configFile) return {}
  const text = readTextCapped(join(root, configFile), 200_000)
  if (!text) return {}
  const aliasBlock = /alias\s*:\s*\{([\s\S]*?)\n\s*\}/m.exec(text) ?? /alias\s*:\s*\{([\s\S]*?)\}/m.exec(text)
  if (!aliasBlock) return {}

  const aliases: Record<string, string> = {}
  const pairRe = /['"]([^'"]+)['"]\s*:\s*(?:path\.(?:resolve|join)\([^)]*?['"]([^'"]+)['"]\s*\)|['"]([^'"]+)['"])/g
  let match: RegExpExecArray | null
  while ((match = pairRe.exec(aliasBlock[1])) !== null) {
    const key = match[1]
    const value = match[2] ?? match[3]
    if (key && value) aliases[key] = value
  }
  return aliases
}

// ---------------------------------------------------------------------------
// probeProject — the entry point
// ---------------------------------------------------------------------------

export function probeProject(dir: string): ProjectProfile {
  const root = resolve(dir)
  const pkg = readPackageJson(root)
  const packageManager = detectPackageManager(root)
  const shape = detectFrameworkShape(root, pkg)
  const warnings: ProbeWarning[] = [...shape.warnings]

  let pagesDir = shape.pagesDir
  let routeStyle = shape.routeStyle
  let pagesDirCandidates: PagesDirCandidate[] | undefined

  if (!pagesDir) {
    const ranked = rankPagesDirCandidates(root)
    if (ranked.length > 0) {
      pagesDir = ranked[0]!.dir
      routeStyle = 'flat'
      pagesDirCandidates = ranked.slice(0, 3)
      warnings.push({
        code: 'pages-dir-heuristic',
        message: `No routing framework convention matched; guessed the pages directory "${pagesDir}" by ranking directories on the fraction of files with a JSX-returning default export.`,
        fix: 'Confirm the pages directory in the import dialog, or set "pagesDir" explicitly in .studio/meta.json.',
      })
    } else {
      pagesDir = 'pages'
      routeStyle = 'flat'
      warnings.push({
        code: 'pages-dir-not-found',
        message: 'No directory containing JSX-returning default-export components was found.',
        fix: 'Create a pages directory, or set "pagesDir" explicitly in .studio/meta.json.',
      })
    }
  }

  return {
    framework: shape.framework,
    pagesDir,
    routeStyle: routeStyle ?? 'flat',
    entryFiles: shape.entryFiles,
    packageManager,
    styleToolchain: {
      tailwind: detectTailwind(root, pkg, warnings),
      cssModules: hasCssModules(root),
      sass: hasSass(root, pkg),
      postcssConfigPath: findConfigFile(root, POSTCSS_CONFIG_NAMES) ?? null,
      cssInJs: detectCssInJs(pkg),
    },
    componentPackages: detectComponentPackages(root, pkg, warnings),
    aliases: { ...extractTsconfigAliases(root), ...extractViteAliases(root) },
    warnings,
    ...(pagesDirCandidates ? { pagesDirCandidates } : {}),
  }
}

// ---------------------------------------------------------------------------
// Route — GET/POST /admin/api/studio/probe
// ---------------------------------------------------------------------------

const ProbeBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
})

/**
 * `GET  /admin/api/studio/probe?dir=<abs>` → `{ profile }`. Read-only: returns
 * the cached `.studio/meta.json` profile when present, else probes fresh
 * WITHOUT persisting — a GET must not write. No re-validation is needed here:
 * `readStudioMeta` validates `profile` against `ProjectProfileSchema` itself
 * and drops a stale cache, so an absent value already means "probe fresh".
 *
 * `POST /admin/api/studio/probe  { dir }` → `{ profile }`. Always re-probes,
 * then persists via `mergeStudioMeta` (never clobbers `displayName`/
 * `pagesDir`/etc — see that function's doc).
 */
export async function tryServeStudioProbe(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== '/admin/api/studio/probe') return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const profile = readStudioMeta(dir).profile ?? probeProject(dir)
      return jsonResponse({ profile })
    } catch (err) {
      console.error('[studio/projectProbe]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, ProbeBodySchema)
      if (!body) return badRequest('invalid probe body')
      const dir = resolveProjectDir(body.dir)
      const profile = probeProject(dir)
      mergeStudioMeta(dir, { profile })
      return jsonResponse({ profile })
    } catch (err) {
      console.error('[studio/projectProbe]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
