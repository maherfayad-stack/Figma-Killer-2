/**
 * defaultLiteralBindings — parser-07's "what does this binding start as?" read.
 *
 * A design tool parsing a screen standalone has no call site and no runtime, so
 * a guard like `{showDataHelp && <Overlay/>}` or `{step === 'intro' ? … : …}`
 * has nothing to resolve against — unless the binding carries its OWN default
 * in the source. Two shapes cover nearly every real component:
 *
 *   function Screen({ introVariant = 'checklist' }) { … }   // a param default
 *   const [showDataHelp, setShowDataHelp] = useState(false)  // a useState default
 *
 * Reading that literal is Tier A, not the banned Tier D: nothing is EXECUTED —
 * no hook runs, no setter is simulated, no state transition is modeled, no call
 * site is guessed at. The literal the author wrote in the signature/hook call
 * is read exactly the way a module-scope `const` initializer already is, and
 * the answer is the component's FIRST PAINT with no props passed — precisely
 * what a screen on a board should show by default. See
 * `docs/features/studio-import.md`'s tier table.
 *
 * This module is a PURE AST LEAF: it returns the literal's `Node`, never a
 * value, and imports nothing from the evaluator. That is what lets both
 * consumers use it without a cycle and without duplicating the lookup —
 * `staticEvalCore.ts`'s `evaluateConditionOperand` (truthiness, for `&&`/
 * ternary/`||`) and `staticEval.ts`'s `evaluateStaticNullish` (null-ness, for
 * `??`) each evaluate the returned node with their own budget and semantics.
 *
 * It is deliberately NOT wired into `buildComponentLocals`/`resolveIdentifier`,
 * the chain every OTHER Tier A/B resolution shares — see
 * `staticEvalCore.ts`'s `evaluateConditionOperand` for the concrete regression
 * that would cause (Tier B.4's dynamic-dictionary-key pick would start
 * silently overriding the `previewLocale` option the language-switcher pattern
 * depends on).
 */
import { Node, SyntaxKind } from 'ts-morph'
import type { FunctionLike } from './types'

/**
 * The nearest enclosing component/hook function body, or `undefined` for a
 * module-scope expression. Shared by Tier B's provider tracing
 * (`./staticEvalCalls`'s `traceProvider`) and `findDefaultLiteralNode` below —
 * both need to walk from an arbitrary expression up to the function whose
 * top-level statements might declare the binding they care about.
 */
export function enclosingFunctionLike(node: Node): FunctionLike | undefined {
  return node.getFirstAncestor(
    (a): a is FunctionLike =>
      Node.isArrowFunction(a) || Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a),
  )
}

/**
 * The literal `Node` that `identifier` starts out holding on first paint, or
 * `undefined` when the source does not state one.
 *
 * Two lookups, checked in order — a name is never both:
 *
 * 1. **A destructured parameter's own default** (`{ introVariant = 'checklist' }`):
 *    `findParamDefaultLiteral` reads the FIRST parameter's object-binding
 *    pattern, the same shape `componentSubstitution.ts`'s `buildSubstitutionEnv`
 *    already reads for a locally-inlined call site's fallback value — this is
 *    that identical literal-read, reached when there is no call site at all.
 * 2. **A `const [x] = useState(<default>)` binding**: the `useState` argument
 *    is accepted either as a bare literal (string/template/number/`true`/
 *    `false`/`null`) OR — the shape the real eSIM corpus actually uses, in
 *    `ActivationFlowScreen`'s `useState(initialStep)` where
 *    `({ initialStep = 'intro' })` is what really gates its five overlays — as
 *    an identifier that is ITSELF a defaulted parameter, recursing into lookup
 *    1 exactly once (parameter defaults are always literals, so one hop is
 *    enough and no cycle is possible). A genuinely COMPUTED or prop-derived
 *    initializer with no default anywhere (`useState(props.x)`,
 *    `useState(compute())`) has no single value to read and returns
 *    `undefined` — the honest "cannot decide" answer.
 *
 * Both lookups share one more guard: the binding must never be reassigned
 * elsewhere in the function body (a plain `x = …`, not a call to the setter —
 * the setter never rewrites this identifier's text). A `let`-declared pair that
 * IS hand-mutated outside React's setter contract would misrepresent even the
 * first paint, so that returns `undefined` too. Only the function's own
 * TOP-LEVEL statements and first parameter are scanned — the same flat, not
 * block-scoped simplification `buildComponentLocals` already makes.
 */
export function findDefaultLiteralNode(identifier: Node): Node | undefined {
  if (!Node.isIdentifier(identifier)) return undefined
  const fn = enclosingFunctionLike(identifier)
  if (!fn) return undefined
  const name = identifier.getText()

  const paramDefault = findParamDefaultLiteral(name, fn)
  if (paramDefault) return isReassignedInBody(name, fn) ? undefined : paramDefault

  const body = fn.getBody()
  if (!body || !Node.isBlock(body)) return undefined
  for (const statement of body.getStatements()) {
    if (!Node.isVariableStatement(statement)) continue
    for (const decl of statement.getDeclarations()) {
      const nameNode = decl.getNameNode()
      if (!Node.isArrayBindingPattern(nameNode)) continue
      const [first] = nameNode.getElements()
      if (!first || !Node.isBindingElement(first)) continue
      const elName = first.getNameNode()
      if (!Node.isIdentifier(elName) || elName.getText() !== name) continue

      const init = decl.getInitializer()
      const arg = init && stateArgument(init)
      if (!arg) return undefined
      const literal = literalOrParamDefault(arg, fn)
      if (!literal) return undefined
      return isReassignedInBody(name, fn) ? undefined : literal
    }
  }
  return undefined
}

/** `useState`'s sole argument node, whatever it is. Named without a `use` prefix on purpose — it is not a hook, and `eslint-plugin-react-hooks` treats any `use*` function name as one. */
function stateArgument(init: Node): Node | undefined {
  if (!Node.isCallExpression(init)) return undefined
  const callee = init.getExpression()
  if (!Node.isIdentifier(callee) || callee.getText() !== 'useState') return undefined
  return init.getArguments()[0]
}

/** `expr` itself when it is a bare literal, or — one hop — a defaulted parameter's own literal default when `expr` is an identifier naming one. */
function literalOrParamDefault(expr: Node, fn: FunctionLike): Node | undefined {
  if (isBareLiteral(expr)) return expr
  if (Node.isIdentifier(expr)) return findParamDefaultLiteral(expr.getText(), fn)
  return undefined
}

function isBareLiteral(node: Node): boolean {
  const kind = node.getKind()
  return (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isNumericLiteral(node) ||
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.NullKeyword
  )
}

/**
 * `name`'s own `= <literal>` default in `fn`'s FIRST parameter's destructured
 * object-binding pattern (`function Foo({ introVariant = 'checklist' })`), or
 * `undefined` when `fn` has no such parameter, the pattern isn't a plain object
 * destructure, `name` isn't one of its elements, or its default isn't itself a
 * bare literal.
 */
function findParamDefaultLiteral(name: string, fn: FunctionLike): Node | undefined {
  const first = fn.getParameters()[0]
  if (!first) return undefined
  const pattern = first.getNameNode()
  if (!Node.isObjectBindingPattern(pattern)) return undefined
  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken()) continue
    const elName = element.getNameNode()
    if (!Node.isIdentifier(elName) || elName.getText() !== name) continue
    const init = element.getInitializer()
    return init && isBareLiteral(init) ? init : undefined
  }
  return undefined
}

/** Whether `name` is the target of a plain `name = …` assignment anywhere in `fn`'s body. */
function isReassignedInBody(name: string, fn: FunctionLike): boolean {
  const body = fn.getBody()
  if (!body) return false
  return body.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((bin) => {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return false
    const left = bin.getLeft()
    return Node.isIdentifier(left) && left.getText() === name
  })
}
