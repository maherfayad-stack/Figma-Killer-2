/**
 * componentSources — classifies each `kind: 'component'` node a `ParsedPage`
 * found as either:
 *
 *   - **local**  — its import resolves to a real file inside the workspace
 *                  (relative import, or a tsconfig path alias pointing
 *                  inside the workspace); the resolved workspace-relative
 *                  POSIX file path is recorded.
 *   - **package** — a bare/unresolvable specifier (an npm dependency), which
 *                  stays a read-only prop surface this slice.
 *   - **design-system** — it resolves to a real file inside the workspace,
 *                  but inside `<root>/design-system/`: Studio's OWN copy of
 *                  the built-in design system, written into the project so it
 *                  builds standalone. A black box, never a local component —
 *                  see `./designSystemDir`.
 *
 * This slice only RESOLVES and CLASSIFIES local components — it does not
 * parse a local component's own file into an editable tree (deferred; see
 * V1-CANVAS-PLAN.md Phase 7A backlog note).
 *
 * `parsePageFile` parses one file in isolation (a fresh, single-file
 * ts-morph `Project`), which is enough for the JSX element/instance tree but
 * NOT enough to resolve a relative import to another file — ts-morph only
 * resolves module specifiers to real `SourceFile`s among the files a single
 * `Project` knows about. `createWorkspaceProject` builds ONE `Project`
 * spanning every source file in the workspace so cross-file imports resolve;
 * pass that same instance to every `parsePageFile` call for one workspace
 * load (its `project` parameter defaults to a fresh isolated Project when
 * omitted, which is what every non-workspace caller — including this
 * module's tests — still gets).
 */
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { Node, Project, type SourceFile } from 'ts-morph'
import type { ParsedPage } from './types'
import { isDesignSystemPath } from './designSystemDir'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from './workspaceFiles'

export type ComponentSource =
  | { kind: 'local'; file: string }
  | { kind: 'package'; specifier: string }
  /**
   * Studio's built-in design system, reached through the project's own
   * `design-system/` folder. `name` is the component's PUBLIC EXPORT name
   * (`Button`), not the local binding — `import { Button as Btn }` still
   * resolves to the `alm.Button` module, and a member-access tag
   * (`<DS.Button/>`) resolves to its trailing segment.
   */
  | { kind: 'design-system'; name: string }

/**
 * Builds one ts-morph `Project` covering every `.ts`/`.tsx`/`.js`/`.jsx` file
 * under `workspaceRoot`, excluding `EXCLUDED_WORKSPACE_DIR_NAMES` (never add
 * `node_modules`/build output as if it were app source). Loads the
 * workspace's own `tsconfig.json` when it has one, so that workspace's own
 * `paths` aliases resolve too; falls back to ts-morph's defaults otherwise
 * (a workspace with no tsconfig simply has no aliases to resolve — every
 * non-relative import in it is a package import).
 *
 * `compilerOptions: { allowJs: true }` is passed explicitly (not just relied
 * on via a workspace tsconfig) so ts-morph parses `.jsx`/`.js` files at all —
 * a real-world React repo (the common GitHub-import case) is plain JS more
 * often than not. ts-morph merges tsconfig-derived compiler options first and
 * the explicit `compilerOptions` last (explicit wins), so a workspace
 * tsconfig that sets `allowJs: false` cannot turn this back off. Combined
 * with `skipAddingFilesFromTsConfig: true` (never let the tsconfig's own
 * `include`/`exclude` decide which files ts-morph adds — `addSourceFilesAtPaths`
 * below is the single source of truth for that), the workspace's tsconfig
 * only ever contributes path-alias resolution, never file selection or the
 * JS-parsing toggle.
 */
export function createWorkspaceProject(workspaceRoot: string): Project {
  const tsConfigFilePath = path.join(workspaceRoot, 'tsconfig.json')
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
    ...(existsSync(tsConfigFilePath) ? { tsConfigFilePath } : {}),
  })

  const root = path.resolve(workspaceRoot).split(path.sep).join('/')
  project.addSourceFilesAtPaths([
    `${root}/**/*.{ts,tsx,js,jsx}`,
    ...[...EXCLUDED_WORKSPACE_DIR_NAMES].map((name) => `!${root}/**/${name}/**`),
  ])
  return project
}

/**
 * Classifies every `kind: 'component'` node in `parsed` as local or package,
 * returning a map keyed by the SAME node ids `parsed.nodes` uses — callers
 * loading a multi-page workspace can merge every page's result into one flat
 * dictionary keyed by node id (ids already namespace by file, so there's no
 * cross-page collision).
 *
 * `project` must already know about `file` — see `createWorkspaceProject`.
 * A component identifier that resolves to neither an import nor a same-file
 * declaration (shouldn't happen for well-formed JSX/TSX) is simply omitted
 * from the result rather than guessed at.
 */
export function resolveComponentSources(
  project: Project,
  file: string,
  workspaceRoot: string,
  parsed: ParsedPage,
): Record<string, ComponentSource> {
  const sourceFile = project.getSourceFile(file)
  if (!sourceFile) return {}

  const root = path.resolve(workspaceRoot)
  const importMap = buildImportIdentifierMap(sourceFile, root)
  const result: Record<string, ComponentSource> = {}

  for (const node of Object.values(parsed.nodes)) {
    if (node.kind !== 'component') continue
    // A member-access tag (`<Foo.Bar/>`) is imported/declared under its
    // leading identifier ("Foo") — that's what's actually in scope.
    const identifier = node.name.split('.')[0]!
    const source = importMap[identifier] ?? declaredInSameFile(sourceFile, identifier, root)
    if (!source) continue
    // `<DS.Button/>` off `import * as DS from '../design-system'` is bound
    // under "DS", so the map's `name` is the namespace, not the component.
    // The trailing segment is the one that names a real `alm.*` module.
    const memberName = node.name.includes('.') ? node.name.split('.').pop() : undefined
    result[node.id] =
      source.kind === 'design-system' && memberName ? { kind: 'design-system', name: memberName } : source
  }

  return result
}

/** Maps every locally-bound import identifier in `sourceFile` to its classified source. */
function buildImportIdentifierMap(sourceFile: SourceFile, workspaceRoot: string): Record<string, ComponentSource> {
  const map: Record<string, ComponentSource> = {}

  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue()
    const target = declaration.getModuleSpecifierSourceFile()

    const defaultImport = declaration.getDefaultImport()
    if (defaultImport) {
      map[defaultImport.getText()] = classifyImport(target, workspaceRoot, specifier, defaultImport.getText())
    }

    const namespaceImport = declaration.getNamespaceImport()
    if (namespaceImport) {
      map[namespaceImport.getText()] = classifyImport(target, workspaceRoot, specifier, namespaceImport.getText())
    }

    for (const named of declaration.getNamedImports()) {
      const importedName = named.getNameNode().getText()
      const localName = named.getAliasNode()?.getText() ?? importedName
      // A NAMED import may be re-exported. `import { Card } from '../components'`
      // resolves to `components/index.ts`, which declares nothing — classifying
      // against that file recorded a "local component" whose file has no
      // component in it, so inlining bailed and the node stayed an opaque box.
      // A barrel between a page and its components is one of the most common
      // layouts there is.
      //
      // `importedName`, never `declaring.name`, is what a design-system
      // classification carries: the barrel's PUBLIC export name is what the
      // `alm.<Name>` module id is minted from, and a vendored component whose
      // internal declaration is named something else (`export { ButtonBase as
      // Button }`) must still resolve to `alm.Button`.
      const declaring = resolveExportedDeclaration(target, importedName)
      map[localName] = classifyImport(
        declaring ? declaring.sourceFile : target,
        workspaceRoot,
        specifier,
        importedName,
      )
    }
  }

  return map
}

/**
 * Where an exported name is actually DECLARED, following `export { X } from './X'`
 * and `export * from './X'` chains to any depth.
 *
 * `getExportedDeclarations()` is ts-morph's own export-graph walk, so this
 * inherits its handling of re-export chains, aliases, and `export *` — rather
 * than this module re-implementing module resolution. Returns the declaration's
 * own name too, which is what makes a renaming barrel
 * (`export { Card as PlanCard }`) resolve: the page's local name does not exist
 * in the declaring file.
 *
 * Results are cached per `SourceFile` — the walk is not cheap, and a barrel is
 * consulted once per named import on every page that uses it.
 */
export function resolveExportedDeclaration(
  file: SourceFile | undefined,
  exportedName: string,
): { sourceFile: SourceFile; name: string } | undefined {
  if (!file) return undefined

  let byName = exportedDeclarationCache.get(file)
  if (!byName) {
    byName = new Map()
    exportedDeclarationCache.set(file, byName)
  }
  if (byName.has(exportedName)) return byName.get(exportedName)

  const declarations = file.getExportedDeclarations().get(exportedName)
  const declaration = declarations?.[0]
  // `hasName`, not `isNameable`: a `const Card = () => …` is a VariableDeclaration
  // whose name is REQUIRED, so it is "named" and not "nameable" — the narrower
  // predicate silently matched nothing and every barrel import stayed opaque.
  const name = declaration && Node.hasName(declaration) ? declaration.getName() : undefined
  const resolved = declaration && name !== undefined
    ? { sourceFile: declaration.getSourceFile(), name }
    : undefined

  byName.set(exportedName, resolved)
  return resolved
}

/** Per-`SourceFile` memo for `resolveExportedDeclaration`; auto-GC'd with the Project. */
const exportedDeclarationCache = new WeakMap<
  SourceFile,
  Map<string, { sourceFile: SourceFile; name: string } | undefined>
>()

/**
 * local = resolves to a real file inside `workspaceRoot`, outside any
 * `node_modules` AND outside Studio's own `design-system/` folder.
 *
 * `exportName` is the component's public name at THIS import — used only by
 * the `design-system` branch, where the module id (`alm.<Name>`) is minted
 * from the name rather than from a file path.
 */
function classifyImport(
  resolved: SourceFile | undefined,
  workspaceRoot: string,
  specifier: string,
  exportName: string,
): ComponentSource {
  if (resolved) {
    const relFromRoot = path.relative(workspaceRoot, path.resolve(resolved.getFilePath()))
    const insideRoot = relFromRoot.length > 0 && !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)
    const insideNodeModules = relFromRoot.split(path.sep).includes('node_modules')
    if (insideRoot && !insideNodeModules) {
      const relPosix = relFromRoot.split(path.sep).join('/')
      // Checked on the RESOLVED file, not on the specifier: the barrel
      // (`../design-system`), a deep import (`../design-system/components/…`)
      // and a tsconfig alias all land in the same folder, and only the
      // resolved path says so.
      if (isDesignSystemPath(relPosix)) return { kind: 'design-system', name: exportName }
      return { kind: 'local', file: relPosix }
    }
  }
  return { kind: 'package', specifier }
}

/** A component declared (function/const) in the SAME file rather than imported — still local. */
function declaredInSameFile(
  sourceFile: SourceFile,
  identifier: string,
  workspaceRoot: string,
): ComponentSource | undefined {
  const declaredHere = sourceFile.getFunction(identifier) !== undefined || sourceFile.getVariableDeclaration(identifier) !== undefined
  if (!declaredHere) return undefined
  const relFromRoot = path.relative(workspaceRoot, path.resolve(sourceFile.getFilePath()))
  return { kind: 'local', file: relFromRoot.split(path.sep).join('/') }
}
