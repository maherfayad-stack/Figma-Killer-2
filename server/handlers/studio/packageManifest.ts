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
 * **Fully syntactic, never the type checker.** Classifying a prop's type
 * (`classifyPropType` below) reads the WRITTEN type annotation text/AST
 * shape directly (`PropertySignature.getTypeNode()`), never
 * `type.getType()`/the checker's resolved `Type`. A package's own `.d.ts`
 * typically does `import type { ReactNode } from 'react'`, and this
 * extractor's ts-morph `Project` never adds `react`'s own `.d.ts` files (no
 * reason to — nothing here needs semantic resolution) — asking the CHECKER
 * to resolve `ReactNode` would silently degrade to `any` the moment `react`'s
 * types aren't in scope, which erases exactly the signal this module exists
 * to extract. Reading the syntax directly sidesteps that entirely: whether or
 * not `react` resolves, the written text is still literally `ReactNode`.
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
import { basename, join } from 'node:path'
import {
  Node,
  Project,
  SyntaxKind,
  type ClassDeclaration,
  type FunctionDeclaration,
  type PropertySignature,
  type TypeNode,
  type VariableDeclaration,
} from 'ts-morph'
import { Type, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import type { ProbeWarning } from './projectProfileSchema'
import type { ComponentSpec, PropKind, PropSpec } from './packageManifestSchema'
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
// Prop-type classification — purely syntactic, see module doc
// ---------------------------------------------------------------------------

const COLOR_NAME_RE = /color|fill|stroke|bg/i
const IMAGE_NAME_RE = /src|image|icon|avatar|logo/i
const REACT_NODE_TEXT_RE = /^(React\.)?(ReactNode|ReactElement(<.*>)?)$|^JSX\.Element$/

function normalizedTypeText(node: TypeNode): string {
  return node.getText().replace(/\s+/g, ' ').trim()
}

/** A single (already non-nullish) type node -> `PropKind`. Never touches the checker — see module doc. */
function classifyNonNullish(name: string, node: TypeNode): PropKind {
  if (node.getKind() === SyntaxKind.FunctionType) return { kind: 'handler' }

  const text = normalizedTypeText(node)
  if (REACT_NODE_TEXT_RE.test(text)) return { kind: 'node' }

  if (node.getKind() === SyntaxKind.StringKeyword) {
    if (COLOR_NAME_RE.test(name)) return { kind: 'color' }
    if (IMAGE_NAME_RE.test(name)) return { kind: 'image' }
    return { kind: 'string' }
  }
  if (node.getKind() === SyntaxKind.NumberKeyword) return { kind: 'number' }
  if (node.getKind() === SyntaxKind.BooleanKeyword) return { kind: 'boolean' }

  return { kind: 'unknown' }
}

/** A string-literal type node's own value (`'primary'` -> `'primary'`), or `undefined` for anything else. */
function stringLiteralValue(node: TypeNode): string | undefined {
  if (node.getKind() !== SyntaxKind.LiteralType) return undefined
  const literal = node.asKindOrThrow(SyntaxKind.LiteralType).getLiteral()
  return literal.getKind() === SyntaxKind.StringLiteral ? literal.getText().slice(1, -1) : undefined
}

/**
 * Classifies a property's declared type. `undefined`/`null` union members are
 * stripped first (an optional prop's syntactic type is `T | undefined`, which
 * must classify exactly like `T`, not fall through to `unknown`). A union of
 * two-or-more string literals becomes `enum`; a union of anything else — the
 * single remaining member aside — stays `unknown` rather than guessing.
 */
export function classifyPropType(name: string, typeNode: TypeNode | undefined): PropKind {
  if (!typeNode) return { kind: 'unknown' }

  if (typeNode.getKind() === SyntaxKind.UnionType) {
    const members = typeNode.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes()
    const nonNullish = members.filter((m) => {
      const t = normalizedTypeText(m)
      return t !== 'undefined' && t !== 'null'
    })
    if (nonNullish.length === 0) return { kind: 'unknown' }
    if (nonNullish.length === 1) return classifyNonNullish(name, nonNullish[0]!)

    const literalValues = nonNullish.map(stringLiteralValue)
    if (literalValues.every((v): v is string => v !== undefined)) {
      return { kind: 'enum', values: literalValues }
    }
    return { kind: 'unknown' }
  }

  return classifyNonNullish(name, typeNode)
}

// ---------------------------------------------------------------------------
// Props-type resolution — from a component declaration to its member list
// ---------------------------------------------------------------------------

/** The minimal shape this module needs from a props type's declaration — `InterfaceDeclaration` and `TypeLiteralNode` both mix in `getProperties(): PropertySignature[]` syntactically (no checker involved), which already satisfies this structurally; the intersection-merge case below builds a plain object of the same shape. */
interface MemberedNode {
  getProperties(): PropertySignature[]
}

/** Finds an interface or type-alias-to-object-shape declared UNDER THIS SAME `.d.ts`'s `Project` by name — a component's props type is almost always declared in the same package, sometimes a different file within it. */
function findNamedTypeMembers(project: Project, name: string, depth: number): MemberedNode | undefined {
  if (depth > 3) return undefined // bounded — a self-referential alias chain must not loop forever
  for (const sourceFile of project.getSourceFiles()) {
    const iface = sourceFile.getInterface(name)
    if (iface) return iface
    const alias = sourceFile.getTypeAlias(name)
    if (alias) {
      const resolved = resolveTypeNodeToMembers(project, alias.getTypeNode(), depth + 1)
      if (resolved) return resolved
    }
  }
  return undefined
}

/** A props TYPE NODE (from a function parameter, or a `React.FC<X>`-style type argument) -> the object-like declaration whose properties are the component's props. Handles a direct type literal, a named reference (interface/alias lookup), and an intersection (merges every resolvable member — the common `Props & RefAttributes<T>` forwardRef shape; `RefAttributes` itself won't resolve locally and is silently skipped, which is the correct outcome — it contributes no prop a user would edit). */
function resolveTypeNodeToMembers(project: Project, typeNode: TypeNode | undefined, depth = 0): MemberedNode | undefined {
  if (!typeNode || depth > 3) return undefined

  if (Node.isTypeLiteral(typeNode)) return typeNode

  if (typeNode.getKind() === SyntaxKind.TypeReference) {
    const ref = typeNode.asKindOrThrow(SyntaxKind.TypeReference)
    const name = ref.getTypeName().getText().split('.').pop()
    if (!name) return undefined
    return findNamedTypeMembers(project, name, depth + 1)
  }

  if (typeNode.getKind() === SyntaxKind.IntersectionType) {
    const parts = typeNode.asKindOrThrow(SyntaxKind.IntersectionType).getTypeNodes()
    const merged = new Map<string, PropertySignature>()
    for (const part of parts) {
      const resolved = resolveTypeNodeToMembers(project, part, depth + 1)
      if (!resolved) continue
      for (const prop of resolved.getProperties()) merged.set(prop.getName(), prop)
    }
    if (merged.size === 0) return undefined
    // A synthetic membered node isn't available from ts-morph directly — the
    // caller only ever needs the PROPERTY LIST, so hand that back via a tiny
    // adapter rather than a real AST node. Structurally satisfies `MemberedNode`.
    return { getProperties: () => [...merged.values()] }
  }

  return undefined
}

/** A generic type reference's first type argument — `React.FC<ButtonProps>` -> `ButtonProps`'s type node. Syntactic (`TypeReferenceNode.getTypeArguments()`), no checker. */
function firstTypeArgument(typeNode: TypeNode | undefined): TypeNode | undefined {
  if (!typeNode || typeNode.getKind() !== SyntaxKind.TypeReference) return undefined
  return typeNode.asKindOrThrow(SyntaxKind.TypeReference).getTypeArguments()[0]
}

/** The props type node for one component declaration — see the three shapes handled in the module doc's tier list. */
function resolvePropsTypeNode(declaration: Node): TypeNode | undefined {
  if (Node.isFunctionDeclaration(declaration) || Node.isArrowFunction(declaration) || Node.isFunctionExpression(declaration)) {
    return declaration.getParameters()[0]?.getTypeNode()
  }

  if (Node.isVariableDeclaration(declaration)) {
    const declaredType = declaration.getTypeNode()
    if (declaredType) {
      if (declaredType.getKind() === SyntaxKind.FunctionType) {
        return declaredType.asKindOrThrow(SyntaxKind.FunctionType).getParameters()[0]?.getTypeNode()
      }
      const typeArg = firstTypeArgument(declaredType)
      if (typeArg) return typeArg
    }
    const initializer = declaration.getInitializer()
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer.getParameters()[0]?.getTypeNode()
    }
  }

  if (Node.isClassDeclaration(declaration)) {
    for (const clause of declaration.getHeritageClauses()) {
      for (const typeExpr of clause.getTypeNodes()) {
        const args = typeExpr.getTypeArguments()
        if (args[0]) return args[0]
      }
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Component-candidate detection
// ---------------------------------------------------------------------------

const PASCAL_CASE_RE = /^[A-Z][A-Za-z0-9]*$/

/** The generic wrapper names a `.d.ts` declares a component under — mirrors `projectProbe.ts`'s own `REACT_COMPONENT_EXPORT_RE` token set, so a random other generic-typed export (`const Config: Array<string>`) isn't mistaken for a component just because it has a type argument. */
const COMPONENT_WRAPPER_NAME_RE = /^(React\.)?(FC|FunctionComponent|VFC|ComponentType|ForwardRefExoticComponent|NamedExoticComponent|MemoExoticComponent)$/

/** Whether an exported declaration LOOKS like a component worth manifesting — name shape only; the actual props (if any) are extracted separately and an unresolvable props type just yields `props: []`, not exclusion. */
function isComponentCandidate(name: string, declaration: Node): declaration is FunctionDeclaration | VariableDeclaration | ClassDeclaration {
  if (!PASCAL_CASE_RE.test(name)) return false
  if (Node.isFunctionDeclaration(declaration)) return true
  if (Node.isClassDeclaration(declaration)) return true
  if (Node.isVariableDeclaration(declaration)) {
    const declaredType = declaration.getTypeNode()
    if (declaredType) {
      if (declaredType.getKind() === SyntaxKind.FunctionType) return true
      if (declaredType.getKind() === SyntaxKind.TypeReference) {
        const refName = declaredType.asKindOrThrow(SyntaxKind.TypeReference).getTypeName().getText()
        if (COMPONENT_WRAPPER_NAME_RE.test(refName)) return true
      }
    }
    const initializer = declaration.getInitializer()
    return Boolean(initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)))
  }
  return false
}

/** `Button.d.ts` -> `Button`; strips a trailing `.d` from `.d.ts`'s own basename handling. */
function pascalCaseFromFileBase(relPath: string): string | undefined {
  const base = basename(relPath).replace(/\.(d\.)?(ts|tsx|js|jsx)$/, '')
  const cleaned = base.replace(/[^A-Za-z0-9]/g, '')
  if (!cleaned) return undefined
  const capitalized = cleaned[0]!.toUpperCase() + cleaned.slice(1)
  return PASCAL_CASE_RE.test(capitalized) ? capitalized : undefined
}

function extractPropsFromMembers(members: MemberedNode): PropSpec[] {
  const props: PropSpec[] = []
  for (const prop of members.getProperties()) {
    const kind = classifyPropType(prop.getName(), prop.getTypeNode())
    if (kind.kind === 'handler') continue // dropped, never stubbed — see module doc
    props.push({ name: prop.getName(), kind, required: !prop.hasQuestionToken() })
  }
  return props
}

function buildComponentSpec(
  project: Project,
  exportName: string,
  declaration: Node,
  relFile: string,
  isDefaultExport: boolean,
): ComponentSpec | undefined {
  const declaredName = Node.hasName(declaration) ? declaration.getName() : undefined
  const name = isDefaultExport ? declaredName ?? pascalCaseFromFileBase(relFile) ?? exportName : exportName

  if (!isComponentCandidate(name, declaration)) return undefined

  const propsTypeNode = resolvePropsTypeNode(declaration)
  const members = resolveTypeNodeToMembers(project, propsTypeNode)
  const props = members ? extractPropsFromMembers(members) : []

  return { name, file: relFile, exportName, isDefaultExport, props }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

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
