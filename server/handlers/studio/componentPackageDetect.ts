/**
 * componentPackageDetect — WS-1.2's "which dependencies ship React
 * components?" rule, extracted out of `projectProbe.ts` so that module stays
 * under the size ceiling and so this one detection question has one file.
 * Nothing here executes anything: every answer comes from reading a
 * `package.json`, a `.d.ts`, or a built `.js` entry as text.
 *
 * **Two tiers, tried in order.**
 *
 * 1. **Declarations.** A package with an entry `.d.ts` is read for a
 *    PascalCase declaration whose type mentions a React element/component
 *    type (`JSX.Element`, `ReactElement`, `React.FC`, `ComponentType`). This
 *    is the precise answer, so it is tried first.
 *
 * 2. **The built JS entry.** A package with no declarations is not
 *    automatically "not a component package" — plenty of hand-rolled JS
 *    design systems ship none. The real corpus this repo is dogfooded against
 *    (`@alm-design/design-system`, 39 components, the package that actually
 *    renders the eSIM board) is exactly that: no `.d.ts`, and no `.tsx`/`.jsx`
 *    source in its published `files` either — just a bundled `dist/index.js`.
 *    Under a declarations-only rule it was reported as NOT a component
 *    package, which is why `componentPackages` was empty for the one project
 *    that most needed it. So a JS entry counts when it shows BOTH halves of
 *    the evidence:
 *      - it creates JSX — it imports `react/jsx-runtime` /
 *        `react/jsx-dev-runtime`, or calls `React.createElement`; and
 *      - it exports at least one PascalCase binding.
 *    Both halves are required precisely to keep `react`, `react-dom` and the
 *    long tail of react-adjacent utility packages out: `react-dom` imports
 *    react but never the JSX runtime, and a hook/util package that DOES
 *    import the runtime exports `useThing`/`createThing`, not `Thing`.
 *
 * Tier 2 is a heuristic and is documented as one — it can only ever be a
 * heuristic, because a JS bundle carries no types. It is deliberately biased
 * toward a false NEGATIVE (a package whose components are reachable only
 * through `export default` is missed) over a false positive, because a false
 * positive puts a package into WS-3.2's bundle demand list.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { readJsonFileSafe, readTextCapped } from './cappedFileRead'
import type { ProbeWarning } from './projectProfileSchema'

/**
 * The one warning code that says "this profile was computed without
 * `node_modules`". `projectProbe.ts`'s staleness check keys off it, so it
 * lives here beside the only place that emits it rather than as a bare string
 * literal in two files.
 */
export const DEPENDENCIES_NOT_INSTALLED = 'dependencies-not-installed'

/** `package.json` fields naming an entry file. `exports` is read separately (see `PackageExportsSchema`) so one exotic subpath map cannot cost us `main`/`module` too. */
const PackageEntrySchema = Type.Object({
  types: Type.Optional(Type.String()),
  typings: Type.Optional(Type.String()),
  module: Type.Optional(Type.String()),
  main: Type.Optional(Type.String()),
})

/** One `exports` target: a bare path, or a conditions object. Extra conditions (`node`, `browser`, `types`, …) are tolerated and ignored — only the three that name a runtime entry are read. */
const ExportTargetSchema = Type.Union([
  Type.String(),
  Type.Object({
    import: Type.Optional(Type.String()),
    require: Type.Optional(Type.String()),
    default: Type.Optional(Type.String()),
  }),
])

/**
 * The `exports` field, in its own schema and its own read. Covers the two
 * shapes that name a package's MAIN entry — the sugar form
 * (`"exports": "./dist/index.js"` or `"exports": { "import": … }`) and the
 * subpath map's `"."` key — and tolerates every other key by validating the
 * map's values as targets. A field this permissive can still fail (a subpath
 * mapped to `null` to block it, a nested condition object); that failure
 * costs only the `exports`-derived candidate, never the sibling
 * `main`/`module` fields, which is exactly why it is a separate read.
 */
const PackageExportsSchema = Type.Object({
  exports: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), ExportTargetSchema)])),
})

const PACKAGE_JSON_MAX_BYTES = 500_000
/** A built design-system bundle is routinely a few hundred KB (the real corpus's is 610 KB). Generous, still bounded. */
const JS_ENTRY_MAX_BYTES = 4_000_000
const DTS_MAX_BYTES = 200_000

const REACT_COMPONENT_EXPORT_RE =
  /export\s+(?:declare\s+)?(?:const|function|class)\s+[A-Z][A-Za-z0-9]*\b[^;{]*(?:JSX\.Element|ReactElement|React\.FC\b|\bFC<|React\.ComponentType|ComponentType<)/

/** `import … from 'react/jsx-runtime'` / `'react/jsx-dev-runtime'`, in ESM or CJS form — the compiler-emitted marker that a module builds JSX. */
const JSX_RUNTIME_RE = /(?:from\s*|require\(\s*)["']react\/jsx-(?:dev-)?runtime["']/

/** The pre-JSX-transform equivalent, for a bundle built with the classic runtime. */
const CREATE_ELEMENT_RE = /\bcreateElement\s*\(/

/** `export const Foo` / `export function Foo` / `export class Foo`. */
const PASCAL_DECLARATION_EXPORT_RE = /export\s+(?:default\s+)?(?:const|let|var|function|class)\s+[A-Z][A-Za-z0-9]*\b/

/** `export { … }` blocks — each specifier's EXPORTED name is what matters (`export { wt as Accolade }` exports `Accolade`). */
const NAMED_EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}/g
const PASCAL_NAME_RE = /^[A-Z][A-Za-z0-9]*$/

function packageDir(root: string, name: string): string {
  return join(root, 'node_modules', ...name.split('/'))
}

type PackageEntryFields = Static<typeof PackageEntrySchema>
type PackageExportsField = Static<typeof PackageExportsSchema>['exports']

function readPackageEntryFields(pkgDir: string): { entry: PackageEntryFields | undefined; exports: PackageExportsField } {
  const jsonPath = join(pkgDir, 'package.json')
  return {
    entry: readJsonFileSafe(jsonPath, PackageEntrySchema, PACKAGE_JSON_MAX_BYTES),
    exports: readJsonFileSafe(jsonPath, PackageExportsSchema, PACKAGE_JSON_MAX_BYTES)?.exports,
  }
}

/** The relative path `exports` names for the package's own entry (`"."`), or the sugar form's target. `undefined` when `exports` is absent or names nothing readable. */
function exportsEntryPath(field: PackageExportsField): string | undefined {
  if (field === undefined) return undefined
  if (typeof field === 'string') return field

  const dot = field['.']
  if (dot !== undefined) return typeof dot === 'string' ? dot : (dot.import ?? dot.default ?? dot.require)

  // Sugar form: the conditions sit directly on `exports` with no subpath key.
  for (const condition of ['import', 'default', 'require'] as const) {
    const value = field[condition]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** First candidate that exists on disk, in caller-supplied priority order. */
function firstExisting(pkgDir: string, candidates: readonly (string | undefined)[]): string | undefined {
  for (const rel of candidates) {
    if (!rel) continue
    const abs = join(pkgDir, ...rel.split('/'))
    if (existsSync(abs)) return abs
  }
  return undefined
}

/** Tier 1 — an entry `.d.ts` declaring a PascalCase React component. */
function hasComponentDeclarations(pkgDir: string, entry: PackageEntryFields | undefined): boolean {
  const candidates = [entry?.types, entry?.typings, 'index.d.ts', 'dist/index.d.ts']
  for (const rel of candidates) {
    if (!rel) continue
    const text = readTextCapped(join(pkgDir, ...rel.split('/')), DTS_MAX_BYTES)
    if (text && REACT_COMPONENT_EXPORT_RE.test(text)) return true
  }
  return false
}

/** True when `text` exports at least one PascalCase binding, by declaration or by an `export { … }` specifier. */
function exportsPascalCaseBinding(text: string): boolean {
  if (PASCAL_DECLARATION_EXPORT_RE.test(text)) return true
  NAMED_EXPORT_BLOCK_RE.lastIndex = 0
  let block: RegExpExecArray | null
  while ((block = NAMED_EXPORT_BLOCK_RE.exec(text)) !== null) {
    for (const specifier of block[1]!.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/)
      const exported = parts[parts.length - 1]?.trim()
      if (exported && PASCAL_NAME_RE.test(exported)) return true
    }
  }
  return false
}

/** Tier 2 — a built JS entry that both creates JSX and exports a PascalCase binding. See the module doc for why both halves are required. */
function hasComponentJsEntry(
  pkgDir: string,
  entry: PackageEntryFields | undefined,
  exportsField: PackageExportsField,
): boolean {
  const abs = firstExisting(pkgDir, [
    exportsEntryPath(exportsField),
    entry?.module,
    entry?.main,
    'dist/index.js',
    'dist/index.mjs',
    'index.js',
    'index.mjs',
  ])
  if (!abs) return false
  const text = readTextCapped(abs, JS_ENTRY_MAX_BYTES)
  if (!text) return false
  if (!JSX_RUNTIME_RE.test(text) && !CREATE_ELEMENT_RE.test(text)) return false
  return exportsPascalCaseBinding(text)
}

/** `<root>/node_modules/<name>` ships React components — declarations first, built JS entry second. Never throws. */
export function isComponentPackage(root: string, name: string): boolean {
  const pkgDir = packageDir(root, name)
  const { entry, exports } = readPackageEntryFields(pkgDir)
  if (hasComponentDeclarations(pkgDir, entry)) return true
  return hasComponentJsEntry(pkgDir, entry, exports)
}

/**
 * Every declared dependency of `pkg` that `isComponentPackage` says ships
 * React components, sorted. An absent `node_modules` is NOT an empty answer —
 * it is an unanswerable question, and it pushes the `dependencies-not-installed`
 * warning that `projectProbe.ts`'s `isProfileStale` later uses to recognize a
 * cached profile that has outlived its truth. Rename that code and you break
 * both the staleness check and whatever is showing it to the user.
 */
export function detectComponentPackages(
  root: string,
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined,
  warnings: ProbeWarning[],
): string[] {
  const names = pkg ? [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])] : []
  if (names.length === 0) return []
  if (!existsSync(join(root, 'node_modules'))) {
    warnings.push({
      code: DEPENDENCIES_NOT_INSTALLED,
      message: 'package.json lists dependencies but node_modules is missing, so package-component detection was skipped.',
      fix: 'Run dependency install (WS-1.4), then re-run the project probe.',
    })
    return []
  }
  return names.filter((name) => isComponentPackage(root, name)).sort()
}
