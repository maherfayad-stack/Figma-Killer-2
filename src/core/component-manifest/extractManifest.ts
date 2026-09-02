/**
 * Scans a folder of `.tsx` files and produces a manifest describing every
 * exported React component and its typed props, using `react-docgen-typescript`.
 *
 * DEFAULT vs NAMED EXPORT HEURISTIC
 * ----------------------------------
 * `react-docgen-typescript` only reports a component's `displayName` — it
 * does not say whether that component was the file's default export or a
 * named export. To fill in `exportName` / `isDefaultExport` we do a light
 * pass over each file's AST (via the TypeScript compiler API, not full type
 * checking) collecting:
 *   - every identifier that is exported as the file's default export
 *     (`export default Foo`, `export default function Foo() {}`,
 *     `export default class Foo {}`, or `export { Foo as default }`)
 *   - every identifier that is exported under a name
 *     (`export const Foo = ...`, `export function Foo() {}`,
 *     `export { Foo }`, `export { Foo as Bar }`)
 * We then match the component's `displayName` against those sets:
 *   - if it's a default export, `isDefaultExport = true` and
 *     `exportName = 'default'` (the conventional name for a default export,
 *     since consumers may import it under any local alias)
 *   - if it's a named export, `isDefaultExport = false` and
 *     `exportName` is the external (post-`as`) name it's exported under
 *   - otherwise (component declared but never actually exported — should not
 *     happen for files react-docgen-typescript found a component in, but
 *     kept as a safe fallback) we fall back to `isDefaultExport = false`,
 *     `exportName = displayName`
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { withCompilerOptions } from 'react-docgen-typescript'
import type { ComponentDoc, PropItem, PropItemType } from 'react-docgen-typescript'
import * as ts from 'typescript'
import type { ComponentManifest, ComponentSpec, PropSpec } from './types'

const require = createRequire(import.meta.url)

const SKIP_DIRS = new Set(['node_modules', '__tests__'])

function isSkippedFile(fileName: string): boolean {
  return fileName.endsWith('.test.tsx') || fileName.endsWith('.stories.tsx')
}

/** Recursively collects `.tsx` files under `dir`, skipping excluded dirs/files. */
function findTsxFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      results.push(...findTsxFiles(join(dir, entry.name)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.tsx') && !isSkippedFile(entry.name)) {
      results.push(join(dir, entry.name))
    }
  }
  return results
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

// ---------------------------------------------------------------------------
// Export analysis (default vs named), see file header for the heuristic.
// ---------------------------------------------------------------------------

interface FileExportInfo {
  /** Local identifier names that are the file's default export. */
  defaultLocalNames: Set<string>
  /** Local identifier name -> external (exported-as) name. */
  namedExports: Map<string, string>
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false) : false
}

function analyzeExports(filePath: string): FileExportInfo {
  const sourceText = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const defaultLocalNames = new Set<string>()
  const namedExports = new Map<string, string>()

  for (const stmt of sourceFile.statements) {
    // `export default <identifier>`
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (ts.isIdentifier(stmt.expression)) {
        defaultLocalNames.add(stmt.expression.text)
      }
      continue
    }

    // `export default function Foo() {}` / `export function Foo() {}`
    // `export default class Foo {}` / `export class Foo {}`
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      if (!stmt.name) continue
      if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
        defaultLocalNames.add(stmt.name.text)
      } else if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        namedExports.set(stmt.name.text, stmt.name.text)
      }
      continue
    }

    // `export const Foo = ...`
    if (ts.isVariableStatement(stmt) && hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          namedExports.set(decl.name.text, decl.name.text)
        }
      }
      continue
    }

    // `export { Foo }`, `export { Foo as Bar }`, `export { Foo as default }`
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const localName = (el.propertyName ?? el.name).text
        const externalName = el.name.text
        if (externalName === 'default') {
          defaultLocalNames.add(localName)
        } else {
          namedExports.set(localName, externalName)
        }
      }
    }
  }

  return { defaultLocalNames, namedExports }
}

function resolveExportInfo(
  displayName: string,
  info: FileExportInfo,
): { exportName: string; isDefaultExport: boolean } {
  if (info.defaultLocalNames.has(displayName)) {
    return { exportName: 'default', isDefaultExport: true }
  }
  const namedExportName = info.namedExports.get(displayName)
  if (namedExportName !== undefined) {
    return { exportName: namedExportName, isDefaultExport: false }
  }
  // Fallback: component found by react-docgen-typescript but not matched to
  // a statement our lightweight export scan understands.
  return { exportName: displayName, isDefaultExport: false }
}

// ---------------------------------------------------------------------------
// Prop mapping
// ---------------------------------------------------------------------------

function stripQuotes(value: string): string {
  const isQuoted =
    value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  return isQuoted ? value.slice(1, -1) : value
}

/**
 * When `shouldExtractLiteralValuesFromEnum` is enabled, a string-literal
 * union (e.g. `'primary' | 'secondary'`) is reported as `type.name === 'enum'`
 * with `type.value` holding each literal (quoted, and including `"undefined"`
 * for optional props). We strip the quotes and drop the undefined marker.
 */
function extractEnumValues(type: PropItemType): string[] | undefined {
  if (type.name !== 'enum' || !Array.isArray(type.value)) return undefined
  const values = (type.value as Array<{ value: unknown }>)
    .map((entry) => String(entry.value))
    .filter((value) => value !== 'undefined' && value !== 'null')
    .map(stripQuotes)
  return values.length > 0 ? values : undefined
}

function mapProp(prop: PropItem): PropSpec {
  const spec: PropSpec = {
    name: prop.name,
    tsType: prop.type.name,
    required: prop.required,
  }

  if (prop.defaultValue?.value !== undefined) {
    spec.defaultValue = String(prop.defaultValue.value)
  }

  const enumValues = extractEnumValues(prop.type)
  if (enumValues) {
    spec.enumValues = enumValues
  }

  if (prop.description) {
    spec.description = prop.description
  }

  return spec
}

// ---------------------------------------------------------------------------
// Compiler options
// ---------------------------------------------------------------------------

/**
 * Fixture/consumer files being scanned may live outside this repo's own
 * directory tree (e.g. a temp dir in tests), so TypeScript's default
 * ancestor-directory lookup for `@types` packages (React's JSX typings,
 * etc.) can't find this repo's `node_modules`. We resolve it explicitly by
 * locating `react-docgen-typescript`'s own install location (which is
 * necessarily inside this repo's `node_modules`) and pointing `typeRoots`
 * at its sibling `@types` folder.
 */
function buildCompilerOptions(): ts.CompilerOptions {
  const reactDocgenPkgPath = require.resolve('react-docgen-typescript/package.json')
  const nodeModulesDir = dirname(dirname(reactDocgenPkgPath))

  return {
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ESNext,
    allowJs: false,
    typeRoots: [toPosix(join(nodeModulesDir, '@types'))],
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recursively scans `appDir` for `.tsx` files and returns a manifest of every
 * exported React component and its typed props.
 */
export function extractManifest(appDir: string): ComponentManifest {
  const absoluteAppDir = resolve(appDir)
  const files = findTsxFiles(absoluteAppDir)

  if (files.length === 0) {
    return { components: [] }
  }

  const parser = withCompilerOptions(buildCompilerOptions(), {
    savePropValueAsString: true,
    shouldExtractLiteralValuesFromEnum: true,
  })

  const docs: ComponentDoc[] = parser.parse(files)

  const exportInfoCache = new Map<string, FileExportInfo>()
  const getExportInfo = (filePath: string): FileExportInfo => {
    let info = exportInfoCache.get(filePath)
    if (!info) {
      info = analyzeExports(filePath)
      exportInfoCache.set(filePath, info)
    }
    return info
  }

  const components: ComponentSpec[] = docs.map((doc) => {
    const exportInfo = getExportInfo(doc.filePath)
    const { exportName, isDefaultExport } = resolveExportInfo(doc.displayName, exportInfo)

    return {
      name: doc.displayName,
      file: toPosix(relative(absoluteAppDir, doc.filePath)),
      exportName,
      isDefaultExport,
      props: Object.values(doc.props).map(mapProp),
    }
  })

  return { components }
}
