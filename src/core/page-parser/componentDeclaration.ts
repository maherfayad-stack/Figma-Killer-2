/**
 * componentDeclaration — "which function's `return`s are this component's
 * JSX?", asked of a file (the page's own component), of a name (a same-file
 * helper), or of a declaration the export graph handed back (an import).
 *
 * Every answer is a READ of the AST. Nothing here calls the wrapper it looks
 * through: the parse-never-execute rule is kept by recognising exactly which
 * shapes are transparent, never by running them.
 *
 * ## Transparent wrappers: `memo` and `forwardRef` (P3-B, WB-4)
 *
 * `memo(X)` renders exactly what `X` renders (it only skips re-renders), and
 * `forwardRef(fn)` renders exactly what `fn` renders (it only hands `fn` a
 * `ref`). So a component declared through either IS its inner function, for
 * every reader — the page walk, inlining, detach, swap, the slot codemods.
 * `getFunctionLikeNode` unwraps them, nested (`memo(forwardRef(…))`), when —
 * and only when — the callee is React's own export (`./reactImports`): a
 * user's own `memo` could do anything.
 *
 * ## Opaque wrappers: an unknown HOC, and a class (pages only, WB-5)
 *
 * `export default withLayout(Inner)` renders `Inner` INSIDE whatever
 * `withLayout` adds, and Studio cannot know what that is without running it.
 * What it can read is which component was handed in — so a PAGE renders that
 * component, with a note naming the wrapper whose effect is not shown
 * (`readPageComponent`). This is not Tier D: no branch is chosen and nothing is
 * evaluated; it is the same positional read parser-06 makes. It is deliberately
 * NOT part of `getFunctionLikeNode`: detaching `<Card/>` where
 * `Card = withTheme(CardBody)` would paste `CardBody`'s markup and silently
 * drop the theme, so every non-page reader keeps treating an unknown HOC as
 * unreadable.
 *
 * A class component's JSX is its `render()` method's return — same read.
 *
 * Whatever a page's default export is when neither applies (`lazy(…)`, a
 * component imported from another file, a plain object), `readPageComponent`
 * names the shape so the frame can say so instead of drawing a blank page.
 */
import {
  Node,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type MethodDeclaration,
  type SourceFile,
} from 'ts-morph'
import { containsJsx, getReturnedJsxRoots } from './branchSelection'
import { reactExportNameOf } from './reactImports'
import type { ComponentBody, FunctionLike } from './types'

/** React exports whose component renders exactly what its first argument renders. */
const TRANSPARENT_REACT_WRAPPERS: ReadonlySet<string> = new Set(['memo', 'forwardRef'])

/** Bounds every unwrap walk — `const A = memo(A)` is a type error, not a reason to hang. */
const MAX_UNWRAP_HOPS = 12

/**
 * Finds the declaration of the page's exported React component:
 *   1. `export default function Foo() {...}`
 *   2. `export default Foo` / `export default () => {...}` /
 *      `export default memo(Foo)` (an identifier resolves back to its local
 *      function/const declaration)
 *   3. Only when the file has NO default export at all: the first exported
 *      function declaration, or `const` whose initializer is a component (a
 *      function/arrow, or one inside `memo`/`forwardRef`), in source order.
 *
 * A default export the steps above cannot read (`withLayout(Page)`, a class,
 * `lazy(…)`) ends the search with `undefined` — it never falls through to some
 * OTHER exported function. That fallback used to render a Next-style page's
 * `getServerSideProps` (nothing, with no reason given) in place of
 * `export default withLayout(Page)`; `readPageComponent` reads those shapes.
 */
export function findComponentDeclaration(sourceFile: SourceFile): Node | undefined {
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isDefaultExport()) return fn
  }

  const exportAssignment = sourceFile.getExportAssignments().find((ea) => !ea.isExportEquals())
  if (exportAssignment) {
    const expr = exportAssignment.getExpression()
    if (Node.isIdentifier(expr)) {
      const declarations = expr.getSymbol()?.getDeclarations() ?? []
      const match = declarations.find((d) => Node.isVariableDeclaration(d) || Node.isFunctionDeclaration(d))
      if (match && getFunctionLikeNode(match)) return match
    } else if (getFunctionLikeNode(expr)) {
      return expr
    }
  }
  if (hasDefaultExport(sourceFile)) return undefined

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement) && statement.isExported()) {
      return statement
    }
    if (Node.isVariableStatement(statement) && statement.isExported()) {
      for (const decl of statement.getDeclarations()) {
        if (getFunctionLikeNode(decl)) return decl
      }
    }
  }

  return undefined
}

/** Any spelling of a default export: `export default …`, a default class or function, or `export { X as default } [from …]`. */
function hasDefaultExport(sourceFile: SourceFile): boolean {
  if (sourceFile.getExportAssignments().some((ea) => !ea.isExportEquals())) return true
  if (sourceFile.getFunctions().some((fn) => fn.isDefaultExport())) return true
  if (sourceFile.getClasses().some((cls) => cls.isDefaultExport())) return true
  return sourceFile
    .getExportDeclarations()
    .some((decl) => decl.getNamedExports().some((spec) => (spec.getAliasNode()?.getText() ?? spec.getNameNode().getText()) === 'default'))
}

/**
 * Finds a specific NAMED (non-default) declaration — a function declaration,
 * or a `const` whose initializer is a component. `requireExport` is `false`
 * only for a same-file declaration (see `CallTarget.sameFile`'s doc comment)
 * — a cross-file named import can only exist if the target IS exported, so
 * `requireExport` stays `true` there as a defence-in-depth check, not a guess.
 */
export function findNamedComponentDeclaration(sourceFile: SourceFile, name: string, requireExport: boolean): Node | undefined {
  const fn = sourceFile.getFunction(name)
  if (fn && (!requireExport || fn.isExported())) return fn

  const variableDecl = sourceFile.getVariableDeclaration(name)
  if (variableDecl && (!requireExport || variableDecl.getVariableStatement()?.isExported()) && getFunctionLikeNode(variableDecl)) {
    return variableDecl
  }
  return undefined
}

/**
 * Reads the component function out of a declaration: a function declaration
 * or expression, an arrow, a `const` holding one — and, through React's own
 * `memo`/`forwardRef` (see this module's header), the function they wrap. A
 * wrapper's argument may be a function, another wrapper, or the name of a
 * function/`const` declared at the top level of the SAME file.
 *
 * `undefined` for anything else. Never returns a function from another file:
 * every caller mints node ids from the file it read the declaration in.
 */
export function getFunctionLikeNode(decl: Node): FunctionLike | undefined {
  return unwrapComponent(decl, 0)
}

function unwrapComponent(node: Node, hops: number): FunctionLike | undefined {
  if (hops > MAX_UNWRAP_HOPS) return undefined
  if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer()
    return init ? unwrapComponent(init, hops + 1) : undefined
  }
  const bare = stripExpressionWrappers(node)
  if (bare !== node) return unwrapComponent(bare, hops + 1)
  if (!Node.isCallExpression(node)) return undefined
  const inner = transparentWrapperArgument(node)
  if (!inner) return undefined
  if (Node.isIdentifier(inner)) {
    const local = topLevelDeclaration(inner)
    return local ? unwrapComponent(local, hops + 1) : undefined
  }
  return unwrapComponent(inner, hops + 1)
}

/** `memo(X)`'s / `forwardRef(fn)`'s first argument, when the callee is React's own export; `undefined` for every other call. */
function transparentWrapperArgument(call: CallExpression): Node | undefined {
  const exportName = reactExportNameOf(call.getExpression())
  if (!exportName || !TRANSPARENT_REACT_WRAPPERS.has(exportName)) return undefined
  const first = call.getArguments()[0]
  return first ? stripExpressionWrappers(first) : undefined
}

/** `(x)`, `x as T`, `x satisfies T`, `x!` → `x`. Type assertions change nothing about what renders. */
function stripExpressionWrappers(node: Node): Node {
  let current = node
  for (let hop = 0; hop < MAX_UNWRAP_HOPS; hop += 1) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current)
    ) {
      current = current.getExpression()
      continue
    }
    return current
  }
  return current
}

/** The top-level function/`const`/class `identifier` names in its own file, or `undefined` (an import, a parameter, a global). */
function topLevelDeclaration(identifier: Node): Node | undefined {
  const name = identifier.getText()
  const sourceFile = identifier.getSourceFile()
  return sourceFile.getFunction(name) ?? sourceFile.getVariableDeclaration(name) ?? sourceFile.getClass(name)
}

// ---------------------------------------------------------------------------
// Pages: the default export, whatever shape it takes (WB-5)
// ---------------------------------------------------------------------------

/** What a page file's component is, as far as the parser can read it. */
export type PageComponent =
  | {
      kind: 'component'
      body: ComponentBody
      /**
       * Unknown HOCs the page's component was handed to, outermost first
       * (`['withLayout()']`). Their effect is not shown; the page records a
       * note saying so. Empty for a plain component, and for `memo`/`forwardRef`.
       */
      wrappedBy: string[]
    }
  | {
      kind: 'unreadable'
      /** The default export (or, with none, the file's first statement) — where the frame's notice points. */
      at: Node
      /** Completes "The default export of pages/X.tsx is …": `a call to lazy(), which …`. */
      shape: string
    }

/**
 * The component a PAGE file renders. Everything `findComponentDeclaration`
 * reads, plus the two page-only shapes in this module's header: a class
 * component (its `render()`), and an unknown HOC around a component declared
 * in the same file (that component, with the wrapper named in `wrappedBy`).
 * Anything else is `unreadable`, with the shape named.
 */
export function readPageComponent(sourceFile: SourceFile): PageComponent {
  const declaration = findComponentDeclaration(sourceFile)
  const fn = declaration ? getFunctionLikeNode(declaration) : undefined
  if (fn) return { kind: 'component', body: fn, wrappedBy: [] }

  const defaultClass = sourceFile.getClasses().find((cls) => cls.isDefaultExport())
  if (defaultClass) return readClassComponent(defaultClass, [])

  const exportAssignment = sourceFile.getExportAssignments().find((ea) => !ea.isExportEquals())
  if (exportAssignment) {
    const expr = stripExpressionWrappers(exportAssignment.getExpression())
    return readDefaultExpression(expr, [], 0) ?? { kind: 'unreadable', at: expr, shape: describeUnreadable(expr) }
  }

  const reexport = sourceFile.getExportDeclarations().find((decl) =>
    decl.getNamedExports().some((spec) => (spec.getAliasNode()?.getText() ?? spec.getNameNode().getText()) === 'default'),
  )
  if (reexport) {
    const specifier = reexport.getModuleSpecifierValue()
    // `export { Shelf as default }` — a local name, read like `export default Shelf`.
    const local = specifier
      ? undefined
      : reexport.getNamedExports().find((spec) => spec.getAliasNode()?.getText() === 'default')?.getNameNode()
    const found = local ? readDefaultExpression(local, [], 0) : undefined
    if (found) return found
    return {
      kind: 'unreadable',
      at: reexport,
      shape: specifier
        ? `re-exported from '${specifier}', and Studio does not follow a page into another file yet — that file's own frame shows it`
        : 'a re-export Studio cannot read',
    }
  }

  const first = sourceFile.getStatements()[0] ?? sourceFile
  return { kind: 'unreadable', at: first, shape: 'missing — the file exports no React component Studio can read' }
}

/** The page component behind a default-exported expression, or `undefined` when there is none to read. */
function readDefaultExpression(expr: Node, wrappedBy: string[], hops: number): PageComponent | undefined {
  if (hops > MAX_UNWRAP_HOPS) return undefined
  const fn = getFunctionLikeNode(expr)
  if (fn) return rendersJsx(fn) ? { kind: 'component', body: fn, wrappedBy } : undefined
  if (Node.isClassExpression(expr)) return readClassComponent(expr, wrappedBy)
  if (Node.isIdentifier(expr)) {
    const local = topLevelDeclaration(expr)
    if (!local) return undefined
    if (Node.isClassDeclaration(local)) return readClassComponent(local, wrappedBy)
    const localFn = getFunctionLikeNode(local)
    if (localFn) return rendersJsx(localFn) ? { kind: 'component', body: localFn, wrappedBy } : undefined
    // `const Page = withLayout(Inner); export default Page` — the same HOC read, one name away.
    const init = Node.isVariableDeclaration(local) ? local.getInitializer() : undefined
    return init ? readDefaultExpression(stripExpressionWrappers(init), wrappedBy, hops + 1) : undefined
  }
  if (!Node.isCallExpression(expr)) return undefined
  // An unknown HOC: `withLayout(Inner)`, `connect(mapState)(Inner)`,
  // `withA(withB(Inner))`. Its FIRST argument that is itself a readable page
  // component is the one it wraps — a helper function (`withData(fetchUser,
  // Page)`) returns no JSX and is passed over.
  const wrapper = `${shortSource(expr.getExpression().getText())}()`
  for (const arg of expr.getArguments()) {
    const found = readDefaultExpression(stripExpressionWrappers(arg), [...wrappedBy, wrapper], hops + 1)
    if (found?.kind === 'component') return found
  }
  return undefined
}

/** A class component's `render()`, when it returns JSX. */
function readClassComponent(cls: ClassDeclaration | ClassExpression, wrappedBy: string[]): PageComponent {
  const render: MethodDeclaration | undefined = cls.getMethod('render')
  if (render && rendersJsx(render)) return { kind: 'component', body: render, wrappedBy }
  return { kind: 'unreadable', at: cls, shape: 'a class with no render() that returns JSX' }
}

/**
 * Whether `body` returns JSX anywhere. A concise arrow's body counts as its
 * return whatever it is, so `() => import('./Page')` (a `lazy` loader) has a
 * "return" and no JSX — it is not the component being wrapped.
 */
function rendersJsx(body: ComponentBody): boolean {
  return getReturnedJsxRoots(body).some((root) => containsJsx(root.expr))
}

/** Completes "The default export of <file> is …" for an expression `readDefaultExpression` could not read. */
function describeUnreadable(expr: Node): string {
  if (Node.isCallExpression(expr)) {
    const callee = shortSource(expr.getExpression().getText())
    if (transparentWrapperArgument(expr)) {
      return `${callee}() around a component that is not declared in this file — Studio does not follow a page into another file yet`
    }
    return `a call to ${callee}(), which Studio would have to run to see what it renders`
  }
  if (Node.isIdentifier(expr)) {
    return `'${expr.getText()}', which is not a component declared in this file — Studio does not follow a page into another file yet`
  }
  return 'not a function or class component'
}

function shortSource(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat
}
