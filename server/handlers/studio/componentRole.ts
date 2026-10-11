/**
 * What a declared component IS in the user's project — a reusable part, a
 * route page, or a context provider — read from the AST and the project's
 * detected pages directory, never by executing anything. The component
 * catalog (`componentSpecExtract.ts`) stamps it on every entry so the Assets
 * panel offers only parts a designer places.
 */
import { Node, SyntaxKind } from 'ts-morph'

/** Route and framework entry files declare components too, but they are pages, not parts. */
const ROUTE_FILE_RE = /(^|\/)(page|layout|loading|error|not-found|template|route|_app|_document)\.[jt]sx?$/

function isPageFile(relFile: string, pagesPrefix: string | null): boolean {
  return ROUTE_FILE_RE.test(relFile) || (pagesPrefix !== null && relFile.startsWith(pagesPrefix))
}

function meaningfulChildren(node: Node): Node[] {
  if (!Node.isJsxElement(node) && !Node.isJsxFragment(node)) return []
  return node.getJsxChildren().filter((child) => !(Node.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces()))
}

/** `{children}` or `{props.children}` — the pass-through a context wrapper renders. */
function isChildrenExpression(node: Node): boolean {
  if (!Node.isJsxExpression(node)) return false
  const expr = node.getExpression()
  if (!expr) return false
  if (Node.isIdentifier(expr)) return expr.getText() === 'children'
  return Node.isPropertyAccessExpression(expr) && expr.getName() === 'children'
}

/**
 * Does this JSX render nothing but `{children}` inside one or more
 * `<Something.Provider>` / `<SomethingProvider>` wrappers? Parse-only: the
 * chain is walked on the written AST, never evaluated.
 */
function isProviderJsx(node: Node | undefined): boolean {
  let sawProvider = false
  let current: Node | undefined = node
  while (current) {
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression()
      continue
    }
    if (Node.isJsxFragment(current)) {
      const kids = meaningfulChildren(current)
      if (kids.length !== 1) return false
      current = kids[0]
      continue
    }
    if (Node.isJsxExpression(current)) return sawProvider && isChildrenExpression(current)
    if (!Node.isJsxElement(current)) return false
    if (!/Provider$/.test(current.getOpeningElement().getTagNameNode().getText())) return false
    sawProvider = true
    const kids = meaningfulChildren(current)
    if (kids.length !== 1) return false
    current = kids[0]
  }
  return false
}

/** The expression a component declaration returns when it is a single `return <jsx/>` / `=> <jsx/>`. */
function singleReturnedJsx(declaration: Node): Node | undefined {
  let fn: Node | undefined = declaration
  if (Node.isVariableDeclaration(declaration)) {
    let init: Node | undefined = declaration.getInitializer()
    // `memo(function …)` / `forwardRef((…) => …)` — look through one call.
    if (init && Node.isCallExpression(init)) init = init.getArguments()[0]
    fn = init
  }
  if (!fn) return undefined
  let body: Node | undefined
  if (Node.isArrowFunction(fn)) body = fn.getBody()
  else if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) body = fn.getBody()
  if (!body) return undefined
  if (!Node.isBlock(body)) return body
  const returns = body.getDescendantsOfKind(SyntaxKind.ReturnStatement)
  return returns.length === 1 ? returns[0].getExpression() : undefined
}


/** The role `declaration` (declared in `relFile`) plays in a project whose pages live under `pagesPrefix`. */
export function componentRole(relFile: string, pagesPrefix: string | null, declaration: Node): 'page' | 'provider' | 'component' {
  if (isPageFile(relFile, pagesPrefix)) return 'page'
  return isProviderJsx(singleReturnedJsx(declaration)) ? 'provider' : 'component'
}
