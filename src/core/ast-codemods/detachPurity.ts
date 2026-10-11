/**
 * detachPurity - may a body value of the detached component be computed one
 * level up, in the page's own component, instead of where the author wrote it?
 *
 * Detach inlines a body `const` the markup reads once, at its one use. A value
 * the markup reads twice, inside a callback, or that is built from another body
 * value cannot be inlined faithfully (it would be recomputed, or written twice),
 * so it is HOISTED: written once at the top of the page's component, under a
 * fresh name, and the markup reads that (`DetachPlanner.hoistLocal`). That
 * moves the moment the initializer runs - to every render of the page's
 * component, whether or not the markup is currently shown - which is harmless
 * only when running it has no effect. Whether it has one is read from the
 * syntax, never by running it: this module answers "does this initializer
 * contain anything but plain expressions and calls to functions known not to
 * mutate or reach outside?". When it cannot tell, the answer is no and the
 * detach refuses `body-local` (and the editor answers with a component copy).
 *
 * Nothing inside a nested function counts: an arrow function is only DEFINED
 * where it is written, so a handler (`() => setOpen(!open)`) is as pure as the
 * literal it is. What it calls runs later, on the user's click, as it always did.
 */
import { Node, SyntaxKind } from 'ts-morph'

/** Methods that read their receiver and return a new value (never `sort`, `reverse`, `splice`, `push`: they mutate a prop's array). */
const PURE_METHODS: ReadonlySet<string> = new Set([
  'map', 'filter', 'join', 'slice', 'concat', 'includes', 'indexOf', 'lastIndexOf', 'find', 'findIndex', 'some', 'every', 'reduce', 'flat', 'flatMap', 'at',
  'toString', 'toFixed', 'toLocaleString', 'toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd', 'split', 'replace', 'replaceAll', 'startsWith',
  'endsWith', 'padStart', 'padEnd', 'charAt', 'substring', 'localeCompare', 'repeat',
])

/** Plain functions and namespaces whose members only compute. `cn`/`clsx` are the class-join helpers every codebase has. */
const PURE_FUNCTIONS: ReadonlySet<string> = new Set([
  'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'cn', 'clsx', 'classnames', 'classNames', 'twMerge',
])
const PURE_NAMESPACES: ReadonlySet<string> = new Set(['Math'])
const PURE_NAMESPACE_MEMBERS: ReadonlySet<string> = new Set([
  'Array.isArray', 'Array.from', 'JSON.stringify', 'JSON.parse', 'Object.keys', 'Object.values', 'Object.entries', 'Object.fromEntries',
])

const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '??=', '||=', '&&=', '<<=', '>>=', '>>>=', '&=', '|=', '^='])

function isFunctionLike(node: Node): boolean {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)
}

function isPureCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return true
  const callee = call.getExpression()
  if (Node.isIdentifier(callee)) return PURE_FUNCTIONS.has(callee.getText())
  if (!Node.isPropertyAccessExpression(callee)) return false
  const receiver = callee.getExpression()
  if (Node.isIdentifier(receiver)) {
    if (PURE_NAMESPACES.has(receiver.getText())) return true
    if (PURE_NAMESPACE_MEMBERS.has(`${receiver.getText()}.${callee.getName()}`)) return true
  }
  return PURE_METHODS.has(callee.getName())
}

/** True for a node that, evaluated, mutates or reaches outside - or whose effect this module cannot read off the syntax. */
function isImpure(node: Node): boolean {
  const kind = node.getKind()
  if (
    kind === SyntaxKind.AwaitExpression ||
    kind === SyntaxKind.YieldExpression ||
    kind === SyntaxKind.NewExpression ||
    kind === SyntaxKind.DeleteExpression ||
    kind === SyntaxKind.TaggedTemplateExpression ||
    kind === SyntaxKind.PostfixUnaryExpression
  ) {
    return true
  }
  if (Node.isPrefixUnaryExpression(node)) return node.getOperatorToken() === SyntaxKind.PlusPlusToken || node.getOperatorToken() === SyntaxKind.MinusMinusToken
  if (Node.isBinaryExpression(node)) return ASSIGNMENT_OPERATORS.has(node.getOperatorToken().getText())
  return Node.isCallExpression(node) && !isPureCall(node)
}

/** True when evaluating `initializer` early can have no effect: see this module's doc. */
export function isPureInitializer(initializer: Node): boolean {
  if (isFunctionLike(initializer)) return true
  if (isImpure(initializer)) return false
  let pure = true
  initializer.forEachDescendant((node, traversal) => {
    if (isFunctionLike(node)) {
      traversal.skip()
      return
    }
    if (isImpure(node)) {
      pure = false
      traversal.stop()
    }
  })
  return pure
}
