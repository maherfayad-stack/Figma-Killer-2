/**
 * componentSpecExtract — the shared, PACKAGE-AGNOSTIC half of WS-3.1's
 * component/prop extraction, split out of `packageManifest.ts` (Track E1,
 * `STUDIO-FIGMA-PARITY-PLAN.md` §8) so the exact same syntactic classifier
 * serves TWO producers instead of one:
 *
 *   - `packageManifest.ts` — one npm PACKAGE's own `.d.ts`/`.tsx` entry,
 *     walked through its exported-declarations graph (barrels included).
 *   - `components.ts` (`GET /admin/api/studio/components`) — every LOCAL
 *     component declared anywhere in the workspace `Project`
 *     (`extractLocalComponentCatalog`, below), scanned file-by-file instead
 *     of through one entry's re-export graph — see that function's own doc
 *     for why.
 *
 * Everything here is **fully syntactic, never the type checker** — see
 * `packageManifest.ts`'s own module doc for the full rationale (reading
 * `ReactNode`'s WRITTEN text instead of asking the checker to resolve it,
 * which would silently degrade to `any` whenever `react`'s own `.d.ts` isn't
 * in the `Project`, which it deliberately never is here).
 *
 * **K3 — a named union type alias now classifies as `enum`.**
 * `variant?: ButtonVariant` used to return `unknown` for any `TypeReference`,
 * so the single most common shape MUI/Chakra/Mantine/shadcn all ship
 * (`type ButtonVariant = 'primary' | 'ghost' | 'danger'`, referenced by
 * name rather than written inline) rendered a free-text box instead of a
 * dropdown. `resolveNamedUnionAlias` extends the SAME bounded alias
 * resolution `findNamedTypeMembers` already uses for the object-shape props
 * path — same depth bound (3), same "no cross-package chasing beyond what
 * already exists", just applied to a UNION alias body instead of an
 * interface/type-literal's members. Still not the checker: a `TypeAliasDeclaration`
 * is read by NAME off the `Project`'s own source files, and its `getTypeNode()`
 * is the literal text the author wrote.
 */
import { basename } from 'node:path'
import {
  Node,
  Project,
  SyntaxKind,
  type ClassDeclaration,
  type FunctionDeclaration,
  type PropertySignature,
  type SourceFile,
  type TypeNode,
  type VariableDeclaration,
} from 'ts-morph'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { ComponentSpec, PropKind, PropSpec } from './packageManifestSchema'
import { PropSpecSchema } from './packageManifestSchema'

// ---------------------------------------------------------------------------
// Path helper — shared by both producers
// ---------------------------------------------------------------------------

export function toPosix(p: string): string {
  return p.split('\\').join('/')
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

/** A string-literal type node's own value (`'primary'` -> `'primary'`), or `undefined` for anything else. */
function stringLiteralValue(node: TypeNode): string | undefined {
  if (node.getKind() !== SyntaxKind.LiteralType) return undefined
  const literal = node.asKindOrThrow(SyntaxKind.LiteralType).getLiteral()
  return literal.getKind() === SyntaxKind.StringLiteral ? literal.getText().slice(1, -1) : undefined
}

/**
 * Per-`Project` memo: type-alias name -> its own type node, built once by
 * scanning every source file the `Project` knows about, then reused by every
 * `TypeReference` classification that `Project` sees. Unlike
 * `findNamedTypeMembers` below (which scans once PER COMPONENT, an
 * acceptable pre-existing cost), K3's alias lookup runs once per PROP — an
 * unmemoized scan would turn a large local-component catalog build
 * (`extractLocalComponentCatalog` walks the WHOLE workspace `Project`) into
 * O(props × files) instead of O(files) amortized.
 */
const typeAliasIndexCache = new WeakMap<Project, Map<string, TypeNode>>()

function typeAliasIndex(project: Project): Map<string, TypeNode> {
  let index = typeAliasIndexCache.get(project)
  if (index) return index
  index = new Map()
  for (const sourceFile of project.getSourceFiles()) {
    for (const alias of sourceFile.getTypeAliases()) {
      const body = alias.getTypeNode()
      // First declaration wins on a name collision across files — same "don't
      // guess" posture as the rest of this module: resolving an ambiguous
      // alias name via real module-scoped identifier resolution would need
      // the checker, which this module deliberately never uses.
      if (body && !index.has(alias.getName())) index.set(alias.getName(), body)
    }
  }
  typeAliasIndexCache.set(project, index)
  return index
}

/**
 * K3 — resolves a NAMED type reference (`ButtonVariant`) to a `PropKind.enum`
 * when the alias it names is itself a union of string literals, chasing an
 * alias-to-alias chain (`type A = B; type B = 'x' | 'y'`) up to the same
 * depth bound `findNamedTypeMembers` already uses. `undefined` for
 * everything else — a reference that isn't an alias at all, an alias whose
 * body isn't a union, or a union with a non-literal member — so the caller
 * falls through to `unknown` instead of guessing.
 */
function resolveNamedUnionAlias(project: Project, typeNode: TypeNode, depth: number): PropKind | undefined {
  if (depth > 3 || typeNode.getKind() !== SyntaxKind.TypeReference) return undefined
  const ref = typeNode.asKindOrThrow(SyntaxKind.TypeReference)
  const name = ref.getTypeName().getText().split('.').pop()
  if (!name) return undefined

  const aliasBody = typeAliasIndex(project).get(name)
  if (!aliasBody) return undefined

  if (aliasBody.getKind() === SyntaxKind.UnionType) {
    const literalValues = aliasBody.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes().map(stringLiteralValue)
    if (literalValues.every((v): v is string => v !== undefined)) {
      return { kind: 'enum', values: literalValues }
    }
    return undefined // a union with a non-literal member — not this function's job to guess
  }

  // An alias-to-alias chain (`type ButtonVariant = BaseVariant`) — chase it, bounded.
  return resolveNamedUnionAlias(project, aliasBody, depth + 1)
}

/** A single (already non-nullish) type node -> `PropKind`. Never touches the checker — see module doc. */
function classifyNonNullish(project: Project, name: string, node: TypeNode): PropKind {
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

  if (node.getKind() === SyntaxKind.TypeReference) {
    const resolved = resolveNamedUnionAlias(project, node, 0)
    if (resolved) return resolved
  }

  return { kind: 'unknown' }
}

/**
 * Classifies a property's declared type. `undefined`/`null` union members are
 * stripped first (an optional prop's syntactic type is `T | undefined`, which
 * must classify exactly like `T`, not fall through to `unknown`). A union of
 * two-or-more string literals becomes `enum`; a union of anything else — the
 * single remaining member aside — stays `unknown` rather than guessing.
 *
 * `project` is needed for K3's named-union-alias resolution
 * (`resolveNamedUnionAlias`) — every OTHER classification ignores it.
 */
export function classifyPropType(project: Project, name: string, typeNode: TypeNode | undefined): PropKind {
  if (!typeNode) return { kind: 'unknown' }

  if (typeNode.getKind() === SyntaxKind.UnionType) {
    const members = typeNode.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes()
    const nonNullish = members.filter((m) => {
      const t = normalizedTypeText(m)
      return t !== 'undefined' && t !== 'null'
    })
    if (nonNullish.length === 0) return { kind: 'unknown' }
    if (nonNullish.length === 1) return classifyNonNullish(project, name, nonNullish[0]!)

    const literalValues = nonNullish.map(stringLiteralValue)
    if (literalValues.every((v): v is string => v !== undefined)) {
      return { kind: 'enum', values: literalValues }
    }
    return { kind: 'unknown' }
  }

  return classifyNonNullish(project, name, typeNode)
}

// ---------------------------------------------------------------------------
// Props-type resolution — from a component declaration to its member list
// ---------------------------------------------------------------------------

/** The minimal shape this module needs from a props type's declaration — `InterfaceDeclaration` and `TypeLiteralNode` both mix in `getProperties(): PropertySignature[]` syntactically (no checker involved), which already satisfies this structurally; the intersection-merge case below builds a plain object of the same shape. */
export interface MemberedNode {
  getProperties(): PropertySignature[]
}

/** Finds an interface or type-alias-to-object-shape declared UNDER THIS SAME `Project` by name — a component's props type is almost always declared in the same package/workspace, sometimes a different file within it. */
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
export function resolveTypeNodeToMembers(project: Project, typeNode: TypeNode | undefined, depth = 0): MemberedNode | undefined {
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

/** The props type node for one component declaration — direct parameter type annotation, a `React.FC<X>`-style type argument, or a class's own heritage clause type argument. */
export function resolvePropsTypeNode(declaration: Node): TypeNode | undefined {
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

/** The generic wrapper names a component's declared type is written under — mirrors `projectProbe.ts`'s own `REACT_COMPONENT_EXPORT_RE` token set, so a random other generic-typed export (`const Config: Array<string>`) isn't mistaken for a component just because it has a type argument. */
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

export function extractPropsFromMembers(project: Project, members: MemberedNode): PropSpec[] {
  const props: PropSpec[] = []
  for (const prop of members.getProperties()) {
    const kind = classifyPropType(project, prop.getName(), prop.getTypeNode())
    if (kind.kind === 'handler') continue // dropped, never stubbed — see module doc
    props.push({ name: prop.getName(), kind, required: !prop.hasQuestionToken() })
  }
  return props
}

/**
 * One export candidate -> a `ComponentSpec`, or `undefined` when the name
 * shape/declaration doesn't look like a component (`isComponentCandidate`).
 * Shared by BOTH producers — `packageManifest.ts`'s `manifestFromEntry` (one
 * package entry's own resolved export map) and `extractLocalComponentCatalog`
 * below (every workspace file's own top-level declarations) — this is the
 * one place "declaration -> spec" is decided, so the two never drift.
 */
export function buildComponentSpec(
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
  const props = members ? extractPropsFromMembers(project, members) : []

  return { name, file: relFile, exportName, isDefaultExport, props }
}

// ---------------------------------------------------------------------------
// Local component catalog — Track E1: every exported, PascalCase-named
// component declared ANYWHERE in a workspace `Project`
// ---------------------------------------------------------------------------

/**
 * The wire shape `GET /admin/api/studio/components` (`components.ts`)
 * returns — structurally identical to `packageManifestSchema.ts`'s
 * `ComponentSpec`, but `file` carries a DIFFERENT meaning worth its own type:
 * relative to the WORKSPACE ROOT, never a package root. Kept as its own named
 * schema (not a re-export of `ComponentSpecSchema`) so a future divergence
 * (e.g. recording which page(s) actually use a local component) doesn't
 * retroactively change what a package manifest's `file` field means.
 */
export const LocalComponentSpecSchema = Type.Object({
  /** Display name — the export's own name, or a name recovered from the file's basename for an anonymous default export (`pascalCaseFromFileBase`). */
  name: Type.String(),
  /** POSIX path to the file the export was found in, relative to the WORKSPACE ROOT (the same root `createWorkspaceProject` was built from, and the same root every `nodeId`'s `rel` segment uses) — e.g. `src/components/Card.tsx`. */
  file: Type.String(),
  /** The literal export name at `file` — `'default'` for a default export, otherwise identical to `name`. */
  exportName: Type.String(),
  isDefaultExport: Type.Boolean(),
  props: Type.Array(PropSpecSchema),
})
export type LocalComponentSpec = Static<typeof LocalComponentSpecSchema>

/** `export default Card` — an identifier referencing an ALREADY-declared local binding — read off the file's own export assignment. `undefined` for every other default-export shape (an inline arrow/anonymous function, a class expression, a non-identifier expression): those are read directly off their own declaration node (`FunctionDeclaration.isDefaultExport()` / `ClassDeclaration.isDefaultExport()`, both consulted separately below) rather than through this lookup. */
function identifierDefaultExportName(sourceFile: SourceFile): string | undefined {
  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) continue // `export = X` — CommonJS-style, not a default export
    const expr = assignment.getExpression()
    if (Node.isIdentifier(expr)) return expr.getText()
  }
  return undefined
}

/**
 * Every exported, PascalCase-named component declared ANYWHERE in `project`
 * — the whole-workspace counterpart to `packageManifest.ts`'s single-package
 * `manifestFromEntry`. Scans each source file's OWN top-level declarations
 * directly (`getFunctions()`/`getClasses()`/an exported `VariableStatement`'s
 * declarations, plus an `export default <identifier>` pointing at one of
 * those) rather than walking `getExportedDeclarations()`'s export-graph per
 * file:
 *
 *   - A pure re-export (`export { Card } from './Card'`) creates NO
 *     declaration node in the barrel file at all, so this naturally
 *     attributes every component to the file that actually declares it —
 *     no risk of counting the same component once per barrel that forwards
 *     it, and no need to walk barrels at all.
 *   - `resolveExportedDeclaration` (`componentSources.ts`) already pays the
 *     export-graph-walk cost, but only once per NAMED IMPORT a page actually
 *     uses. Paying it once per FILE in a large workspace, for a catalog that
 *     wants every component whether or not any page currently imports it,
 *     would be materially more expensive for no benefit — this walk is
 *     `O(files)`, not `O(files × barrel depth)`.
 *
 * `workspaceRoot` — the same directory `createWorkspaceProject` was built
 * from — is what `file` is made relative to. JS-only files with no type
 * annotation on their props parameter yield `props: []` (via
 * `resolvePropsTypeNode` returning `undefined`) — the identical, honest
 * "nothing static to read" answer `buildPackageManifest`'s own `.tsx`
 * source-fallback tier already gives; this module never fabricates a prop
 * kind it can't read from a type annotation.
 */
export function extractLocalComponentCatalog(project: Project, workspaceRoot: string): LocalComponentSpec[] {
  const specs: LocalComponentSpec[] = []

  for (const sourceFile of project.getSourceFiles()) {
    const relFile = toPosix(sourceFile.getFilePath()).replace(toPosix(workspaceRoot), '').replace(/^\/+/, '')
    if (!relFile) continue // shouldn't happen for a file `createWorkspaceProject` itself added, belt-and-braces

    for (const fn of sourceFile.getFunctions()) {
      if (fn.isDefaultExport()) {
        const spec = buildComponentSpec(project, 'default', fn, relFile, true)
        if (spec) specs.push(spec)
      } else if (fn.isExported() && fn.getName()) {
        const spec = buildComponentSpec(project, fn.getName()!, fn, relFile, false)
        if (spec) specs.push(spec)
      }
    }

    for (const cls of sourceFile.getClasses()) {
      if (cls.isDefaultExport()) {
        const spec = buildComponentSpec(project, 'default', cls, relFile, true)
        if (spec) specs.push(spec)
      } else if (cls.isExported() && cls.getName()) {
        const spec = buildComponentSpec(project, cls.getName()!, cls, relFile, false)
        if (spec) specs.push(spec)
      }
    }

    for (const stmt of sourceFile.getVariableStatements()) {
      if (!stmt.isExported()) continue
      for (const decl of stmt.getDeclarations()) {
        const spec = buildComponentSpec(project, decl.getName(), decl, relFile, false)
        if (spec) specs.push(spec)
      }
    }

    // `export default Card` where `Card` was declared (and possibly ALSO
    // named-exported) earlier in the same file — the three loops above can't
    // see this, because the declaration itself carries no `export`/
    // `export default` keyword of its own; only the separate export
    // assignment statement does.
    const defaultIdentifierName = identifierDefaultExportName(sourceFile)
    if (defaultIdentifierName) {
      const declaration =
        sourceFile.getFunction(defaultIdentifierName) ??
        sourceFile.getClass(defaultIdentifierName) ??
        sourceFile.getVariableDeclaration(defaultIdentifierName)
      if (declaration) {
        const spec = buildComponentSpec(project, 'default', declaration, relFile, true)
        if (spec) specs.push(spec)
      }
    }
  }

  return specs.sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.exportName.localeCompare(b.exportName),
  )
}
