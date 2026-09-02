/**
 * packageManifest — WS-3.1 of `STUDIO-IMPORT-V2-PLAN.md`: `dir + package name
 * -> ComponentSpec[]`, server-side, replacing the one thing that never
 * generalized about `src/modules/alm/register.tsx` — a manifest generated at
 * BUILD time by `scripts/gen-alm-manifest.mjs`, hardcoded to
 * `@alm-design/design-system`. This module does the same extraction against
 * ANY installed package, at IMPORT time, for whichever packages a project
 * actually declares (see `componentBundle.ts`'s demand-list computation).
 *
 * Source of truth, in order — cheapest/most-honest first:
 *   1. The package's `.d.ts` — real prop types, real unions. Best.
 *   2. Its `.tsx`/`.jsx` SOURCE, when a `.d.ts` isn't shipped (a package.json
 *      `source` field, or a conventional `src/index.tsx`/`index.tsx`) — same
 *      extraction logic, since a component's typed parameter looks the same
 *      whether it's declared in a `.d.ts` or written inline in `.tsx`.
 *   3. Nothing static found: `components: []` plus a warning. WS-3.1's own
 *      Gate only requires tiers 1–2 (see the Gate list in the work order);
 *      a THIRD tier — `Object.keys()` of the actual executed module,
 *      names-only — needs running the package's real JS, which is Tier-1
 *      code EXECUTION (unlike this file, which only ever PARSES declaration
 *      text — same "parse, never execute" invariant page-parser holds
 *      everywhere else). That fallback is intentionally NOT built here; see
 *      this module's own doc for where it would have to live
 *      (`componentBundleWorker.ts`, which is already a Tier-1 subprocess) —
 *      flagged as an explicit, honest gap in the `pkg-01` STATE.md entry.
 *
 * **The actual prop-type classification (`classifyPropType`), props-type
 * resolution (`resolvePropsTypeNode`), and member extraction
 * (`extractPropsFromMembers`) live in `componentSpecExtract.ts`** — moved
 * out (Track E1, `STUDIO-FIGMA-PARITY-PLAN.md` §8) so the exact same
 * syntactic classifier also serves `components.ts`'s whole-workspace LOCAL
 * component catalog, not just this file's single-package extraction. See
 * that module's own doc for the K3 named-union-alias resolution it added.
 *
 * Every resolution step is symlink-containment-checked against `dir` via
 * `workspacePackageResolve.ts`'s `isRealpathContained` (`sec-01`'s own
 * primitive, reused rather than reimplemented — see
 * `.claude/agents/security-guard.md` "Paths").
 *
 * `dir` throughout this file means "the directory whose OWN `node_modules`
 * to search" — for a project whose app root is not its project directory
 * (`approot-01`), the caller (`componentBundle.ts`) resolves that first
 * (`resolveAppRoot`/`joinAppRoot`, `./appRoot.ts`) and passes the resolved
 * app root here, never the bare project directory.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Project } from 'ts-morph'
import { Type, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { buildComponentSpec, toPosix } from './componentSpecExtract'
import type { ProbeWarning } from './projectProfileSchema'
import type { ComponentSpec } from './packageManifestSchema'
import { isRealpathContained } from './workspacePackageResolve'

export interface PackageManifestResult {
  components: ComponentSpec[]
  warnings: ProbeWarning[]
}

// ---------------------------------------------------------------------------
// Entry resolution — `.d.ts` first, then `.tsx`/`.jsx` source
// ---------------------------------------------------------------------------

const PackageEntryFieldsSchema = Type.Object({
  types: Type.Optional(Type.String()),
  typings: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
})

function readJsonFileSafe<T extends TSchema>(absPath: string, schema: T, maxBytes: number): Static<T> | undefined {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > maxBytes) return undefined
    const result = safeParseJson(readFileSync(absPath, 'utf8'), schema)
    return result.ok ? result.value : undefined
  } catch {
    return undefined
  }
}

/** First candidate that exists on disk AND survives a realpath-containment check against `dir` — never falls back to the admin server's own `node_modules`, same posture as `resolveWorkspacePackageEntry`. */
function firstContainedCandidate(dir: string, pkgDir: string, candidates: readonly string[]): string | undefined {
  for (const rel of candidates) {
    const candidate = join(pkgDir, ...rel.split('/'))
    if (existsSync(candidate) && isRealpathContained(candidate, dir)) return candidate
  }
  return undefined
}

/** `<dir>/node_modules/<pkgName>`'s `.d.ts` entry — `package.json#types`/`#typings` first, then the two conventional fallbacks `projectProbe.ts`'s own component-package detector already trusts. */
export function resolvePackageDtsEntry(dir: string, pkgName: string): string | undefined {
  const pkgDir = join(dir, 'node_modules', ...pkgName.split('/'))
  const fields = readJsonFileSafe(join(pkgDir, 'package.json'), PackageEntryFieldsSchema, 500_000)
  const candidates = [fields?.types, fields?.typings, 'index.d.ts', 'dist/index.d.ts'].filter(
    (v): v is string => Boolean(v),
  )
  return firstContainedCandidate(dir, pkgDir, candidates)
}

/** `<dir>/node_modules/<pkgName>`'s raw `.tsx`/`.jsx` source entry — only consulted when no `.d.ts` resolved. */
export function resolvePackageTsxEntry(dir: string, pkgName: string): string | undefined {
  const pkgDir = join(dir, 'node_modules', ...pkgName.split('/'))
  const fields = readJsonFileSafe(join(pkgDir, 'package.json'), PackageEntryFieldsSchema, 500_000)
  const candidates = [fields?.source, 'src/index.tsx', 'index.tsx', 'src/index.jsx', 'index.jsx'].filter(
    (v): v is string => Boolean(v),
  )
  return firstContainedCandidate(dir, pkgDir, candidates)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** One ts-morph `Project` scoped to a single package directory's declaration/source tree — never the workspace's own files, never `react`'s (see module doc for why that's deliberate). Every file matching `glob` is added so the entry file's `export * from './Button'`-style re-export chains resolve; only the ENTRY file's own resolved export map is walked, though — see `manifestFromEntry` — so an internal helper `.d.ts` never masquerades as public API. */
function createPackageProject(pkgDir: string, glob: string): Project {
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } })
  project.addSourceFilesAtPaths(`${toPosix(pkgDir)}/${glob}`)
  return project
}

/** Walks ONLY `entryAbsPath`'s own resolved export map (following `export * from`/`export { X } from` chains via ts-morph's `getExportedDeclarations()`, same mechanism `componentSources.ts` already relies on) — never every `.d.ts` file in the package independently, so an internal, non-exported helper file never contributes a false component. */
function manifestFromEntry(project: Project, entryAbsPath: string, pkgDir: string): ComponentSpec[] {
  const entrySourceFile = project.getSourceFile(toPosix(entryAbsPath))
  if (!entrySourceFile) return []
  const relFile = toPosix(entrySourceFile.getFilePath()).replace(toPosix(pkgDir), '').replace(/^\/+/, '')

  const specs: ComponentSpec[] = []
  for (const [exportName, declarations] of entrySourceFile.getExportedDeclarations()) {
    const declaration = declarations[0]
    if (!declaration) continue
    // The declaration may live in a DIFFERENT file than the entry (a re-export)
    // — attribute `file` to where the declaration itself is written, not the
    // barrel that re-exports it, so a consumer can find the real source.
    const declaredFile = toPosix(declaration.getSourceFile().getFilePath()).replace(toPosix(pkgDir), '').replace(/^\/+/, '')
    const spec = buildComponentSpec(project, exportName, declaration, declaredFile || relFile, exportName === 'default')
    if (spec) specs.push(spec)
  }
  return specs
}

/**
 * `dir + packageName -> ComponentSpec[]`. Never throws (matches every other
 * `probe*`/`compile*` entry point's "degrade to a warning" contract) — a
 * package that isn't installed, has no usable declarations, or whose entry
 * escapes `dir` through a symlink all yield `{ components: [], warnings }`
 * rather than an exception.
 */
export function buildPackageManifest(dir: string, packageName: string): PackageManifestResult {
  const warnings: ProbeWarning[] = []
  const pkgDir = join(dir, 'node_modules', ...packageName.split('/'))

  try {
    const dtsEntry = resolvePackageDtsEntry(dir, packageName)
    if (dtsEntry) {
      const project = createPackageProject(pkgDir, '**/*.d.ts')
      const specs = manifestFromEntry(project, dtsEntry, pkgDir)
      if (specs.length > 0) return { components: specs.sort((a, b) => a.name.localeCompare(b.name)), warnings }
    }

    const tsxEntry = resolvePackageTsxEntry(dir, packageName)
    if (tsxEntry) {
      const project = createPackageProject(pkgDir, '**/*.{tsx,jsx}')
      const specs = manifestFromEntry(project, tsxEntry, pkgDir)
      if (specs.length > 0) return { components: specs.sort((a, b) => a.name.localeCompare(b.name)), warnings }
    }

    warnings.push({
      code: 'package-manifest-static-empty',
      message: `"${packageName}" has neither a resolvable \`.d.ts\` nor a \`.tsx\`/\`.jsx\` source entry with any exported component — no static manifest could be built.`,
      fix: 'Confirm the package is installed and ships type declarations, or a source entry (package.json "source").',
    })
    return { components: [], warnings }
  } catch (err) {
    console.error('[studio:packageManifest]', err)
    warnings.push({
      code: 'package-manifest-failed',
      message: `Could not build a component manifest for "${packageName}": ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check the package for malformed type declarations.',
    })
    return { components: [], warnings }
  }
}
