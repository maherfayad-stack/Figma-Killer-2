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
import { NewLineKind, Node, Project, type SourceFile } from 'ts-morph'
import type { ParsedPage } from './types'
import { isDesignSystemPath } from './designSystemDir'
import { EolPreservingFileSystem } from './eolFileSystem'
import { listWorkspaceSourceFiles } from './workspaceFiles'

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
 *
 * ## A tsconfig that does not parse costs its aliases, never the project (WB-23)
 *
 * ts-morph reads the tsconfig in the constructor and THROWS on one it cannot
 * parse (`'}' expected.`) — and every caller builds its project first, so one
 * missing brace, typed mid-edit by the user or an agent, took the whole board
 * down with a raw TypeScript message and a 500. A project without the
 * tsconfig is still an honest project: its only contribution is path-alias
 * resolution, so the fallback loses exactly that and nothing else. The loss is
 * reported, never silent — `warnings` receives one `tsconfig-unreadable`
 * entry, which a load hands to the client.
 */
export function createWorkspaceProject(workspaceRoot: string, warnings?: WorkspaceProjectWarning[]): Project {
  const tsConfigFilePath = path.join(workspaceRoot, 'tsconfig.json')
  let project: Project
  try {
    project = newWorkspaceProject(existsSync(tsConfigFilePath) ? tsConfigFilePath : undefined)
  } catch (err) {
    warnings?.push({
      code: 'tsconfig-unreadable',
      message:
        `tsconfig.json could not be read (${err instanceof Error ? err.message : String(err)}), so its path ` +
        'aliases are ignored until it is fixed. Everything else loads as usual.',
    })
    project = newWorkspaceProject(undefined)
  }

  // The explicit list, not a glob: `listWorkspaceSourceFiles` is the ONE
  // rule for which files are the user's source (the same walk the download
  // zip and page discovery use, minus Studio's own preview shell), and
  // `server/handlers/studio/workspaceProject.ts` re-runs it to keep a kept
  // `Project` in step with the disk — a second selection rule here would be
  // a second answer to "which files exist".
  const root = path.resolve(workspaceRoot)
  for (const relPath of listWorkspaceSourceFiles(root)) {
    project.addSourceFileAtPath(path.join(root, ...relPath.split('/')))
  }
  return project
}

/** Something `createWorkspaceProject` had to give up to build a project at all. `code` is stable — the client keys off it. */
export interface WorkspaceProjectWarning {
  code: 'tsconfig-unreadable'
  message: string
}

function newWorkspaceProject(tsConfigFilePath: string | undefined): Project {
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
    // The user's repo may be a CRLF checkout. `EolPreservingFileSystem` hands
    // ts-morph LF-only text so a page tree cannot depend on which way Git
    // checked the repo out, and puts each file's own ending back at the one
    // moment bytes reach the disk. See `./eolFileSystem`.
    fileSystem: new EolPreservingFileSystem(),
    // Codemods write through this project too; pin the printer to the same
    // LF the file system normalises to, so the single place a line ending is
    // decided stays the file system.
    manipulationSettings: { newLineKind: NewLineKind.LineFeed },
    ...(tsConfigFilePath ? { tsConfigFilePath } : {}),
  })
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
    const imported = importMap[identifier]
    const source = imported?.source ?? declaredInSameFile(sourceFile, identifier, root)
    if (!source) continue
    // `<DS.Button/>` off `import * as DS from '../design-system'` is bound
    // under "DS", so the map's `name` is the namespace, not the component.
    // The trailing segment is the one that names a real `alm.*` module.
    const memberName = node.name.includes('.') ? node.name.split('.').pop() : undefined
    if (source.kind === 'design-system' && memberName) {
      result[node.id] = { kind: 'design-system', name: memberName }
      continue
    }
    // P3-B (WB-4) — `<UI.Arrow/>` off `import * as UI from '../components'`:
    // the namespace names a module, often a barrel that declares nothing, and
    // the member is the export to follow. Classified against the file that
    // DECLARES it, exactly as `import { Arrow } from '../components'` is below.
    if (source.kind === 'local' && memberName && imported?.namespaceOf) {
      const declaring = node.name.split('.').length === 2
        ? resolveExportedDeclaration(imported.namespaceOf, memberName)
        : undefined
      if (declaring) result[node.id] = classifyImport(declaring.sourceFile, root, imported.specifier, memberName)
      continue
    }
    result[node.id] = source
  }

  return result
}

/** One import binding's classification, plus — for `import * as X` — the module it names, so a member tag can be followed into it. */
interface ImportedBinding {
  source: ComponentSource
  specifier: string
  namespaceOf?: SourceFile
}

/** Maps every locally-bound import identifier in `sourceFile` to its classified source. */
function buildImportIdentifierMap(sourceFile: SourceFile, workspaceRoot: string): Record<string, ImportedBinding> {
  const map: Record<string, ImportedBinding> = {}

  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue()
    const target = declaration.getModuleSpecifierSourceFile()

    const defaultImport = declaration.getDefaultImport()
    if (defaultImport) {
      // A default import may be re-exported too (`export { default } from
      // './Card'`, or `import Card from './Card'; export default Card`) —
      // classified against the file that declares it, same as a named one.
      const declaring = resolveExportedDeclaration(target, 'default')
      map[defaultImport.getText()] = {
        source: classifyImport(declaring ? declaring.sourceFile : target, workspaceRoot, specifier, defaultImport.getText()),
        specifier,
      }
    }

    const namespaceImport = declaration.getNamespaceImport()
    if (namespaceImport) {
      map[namespaceImport.getText()] = {
        source: classifyImport(target, workspaceRoot, specifier, namespaceImport.getText()),
        specifier,
        ...(target ? { namespaceOf: target } : {}),
      }
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
      map[localName] = {
        source: classifyImport(declaring ? declaring.sourceFile : target, workspaceRoot, specifier, importedName),
        specifier,
      }
    }
  }

  return map
}

/** An exported name, followed to the declaration that backs it. See `resolveExportedDeclaration`. */
export interface ExportedDeclaration {
  /** The file that DECLARES it — not the barrel the import named. */
  sourceFile: SourceFile
  /**
   * The declaration as ts-morph's export graph reports it: a
   * `FunctionDeclaration`, `VariableDeclaration` or `ClassDeclaration`, or —
   * for `export default <expression>` — the expression itself
   * (`memo(Card)`, `() => <div/>`). `getFunctionLikeNode` reads a component
   * out of any of them.
   */
  node: Node
  /** The declaration's own name, when it has one (`Card` for `const Card = …`); `undefined` for an anonymous default export. */
  name: string | undefined
}

/**
 * Where an exported name is actually DECLARED, following `export { X } from './X'`,
 * `export { default as X } from './X'`, `export * from './X'` and
 * `import X from './X'; export default X` chains to any depth. `'default'`
 * asks for the module's default export.
 *
 * `getExportedDeclarations()` is ts-morph's own export-graph walk, so this
 * inherits its handling of re-export chains, aliases, and `export *` — rather
 * than this module re-implementing module resolution. Returns the declaration's
 * own name too, which is what makes a renaming barrel
 * (`export { Card as PlanCard }`) resolve: the page's local name does not exist
 * in the declaring file.
 *
 * P3-B (WB-4) — returns the declaration NODE, not just its name. A default
 * export has no name to look up again (`export default memo(Arrow)`,
 * `export default () => …`), and a `const Arrow = …; export default Arrow`
 * has a name that is not itself `export`ed — re-finding either by name is what
 * turned every `export { default as Arrow } from './Arrow'` barrel into an
 * "Unknown module".
 *
 * Results are cached per `SourceFile` — the walk is not cheap, and a barrel is
 * consulted once per named import on every page that uses it.
 */
export function resolveExportedDeclaration(
  file: SourceFile | undefined,
  exportedName: string,
): ExportedDeclaration | undefined {
  if (!file) return undefined

  let byName = exportedDeclarationCache.get(file)
  if (!byName) {
    byName = new Map()
    exportedDeclarationCache.set(file, byName)
  }
  if (byName.has(exportedName)) return byName.get(exportedName)

  const declaration = file.getExportedDeclarations().get(exportedName)?.[0]
  // `hasName`, not `isNameable`: a `const Card = () => …` is a VariableDeclaration
  // whose name is REQUIRED, so it is "named" and not "nameable" — the narrower
  // predicate silently matched nothing and every barrel import stayed opaque.
  const resolved = declaration
    ? {
        sourceFile: declaration.getSourceFile(),
        node: declaration,
        name: Node.hasName(declaration) ? declaration.getName() : undefined,
      }
    : undefined

  byName.set(exportedName, resolved)
  return resolved
}

/**
 * Every file an import of `exportedName` from `file` passes THROUGH on its way
 * to the declaration — `file` itself, then each module an `export { … } from`
 * / `export * from` hands it on to.
 *
 * `resolveExportedDeclaration` answers WHERE a name lands but not by which
 * route, and a route's parse is cached on the files it depends on
 * (`pageParseCache.ts`): re-pointing a barrel at another component changes
 * what a page renders without touching the page or either component file.
 * Recording the hops makes that edit invalidate the parse. Follows ONE name's
 * route rather than everything a barrel re-exports, so editing an unrelated
 * component behind the same barrel costs this page nothing. Bounded, and a
 * cycle ends the walk.
 */
export function reexportChainFiles(file: SourceFile | undefined, exportedName: string): SourceFile[] {
  const hops: SourceFile[] = []
  const seen = new Set<SourceFile>()
  let current: { file: SourceFile; name: string } | undefined = file ? { file, name: exportedName } : undefined
  while (current && !seen.has(current.file) && seen.size < 16) {
    seen.add(current.file)
    hops.push(current.file)
    current = nextReexportHop(current.file, current.name)
  }
  return hops
}

/** The module (and the name there) `file` re-exports `name` from, or `undefined` when `file` declares it itself or does not export it. */
function nextReexportHop(file: SourceFile, name: string): { file: SourceFile; name: string } | undefined {
  for (const declaration of file.getExportDeclarations()) {
    const target = declaration.getModuleSpecifierSourceFile()
    if (!target) continue
    const named = declaration.getNamedExports()
    if (named.length === 0) {
      // `export * from './X'` passes on every name X exports except `default`.
      if (name !== 'default' && target.getExportedDeclarations().has(name)) return { file: target, name }
      continue
    }
    for (const specifier of named) {
      const exportedAs = specifier.getAliasNode()?.getText() ?? specifier.getNameNode().getText()
      if (exportedAs === name) return { file: target, name: specifier.getNameNode().getText() }
    }
  }
  return undefined
}

/** Per-`SourceFile` memo for `resolveExportedDeclaration`. A barrel's answer depends on the files it re-exports, so a kept `Project` resets this whenever any file changes (`./parserCaches`). */
let exportedDeclarationCache = new WeakMap<SourceFile, Map<string, ExportedDeclaration | undefined>>()

/** Drops every memoized barrel resolution — see `exportedDeclarationCache`. */
export function forgetExportedDeclarationCache(): void {
  exportedDeclarationCache = new WeakMap()
}

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
