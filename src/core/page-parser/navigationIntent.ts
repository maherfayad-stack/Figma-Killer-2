/**
 * navigationIntent — reading a screen destination out of a click handler,
 * WITHOUT executing anything.
 *
 * This is what lets Studio draw the flows a project already has, beside the
 * ones a designer drew on the board. It is bounded on purpose, and the bound is
 * the whole design: a handler either matches one of a small set of navigation
 * shapes with a literal destination, or it produces nothing. There is no
 * inference, no partial evaluation, no following a variable to its assignment.
 *
 * The reason is `origin: 'code'`. A derived link is presented as a FACT about
 * the user's source — drawn differently, not editable on the board — so a wrong
 * one is worse than a missing one: it tells the user their app does something it
 * does not. A missing one costs them drawing a link by hand.
 *
 * What counts, and nothing else does:
 *
 *   onClick={() => navigate('/sign-in')}
 *   onClick={() => router.push('/sign-in')}
 *   onClick={() => history.push('/sign-in')}
 *   onClick={() => setScreen('otp')}
 *   onClick={() => goTo('otp')}
 *   onClick={() => { … navigate('/otp') … }}     (a single navigating call)
 *
 * Refused: a template literal, a variable, a conditional destination, more than
 * one navigating call in one handler (which destination did the author mean?),
 * and anything whose callee is not one of the recognised names.
 */
import { Node } from 'ts-morph'
import type { ArrowFunction, FunctionExpression } from 'ts-morph'

/**
 * Function names that mean "go to a screen" across the routers a React project
 * in this repo's world actually uses, plus the two local-state idioms Studio's
 * own generated screens use.
 *
 * Matched on the CALLEE's last name segment, so `navigate(…)`, `router.push(…)`
 * and `props.history.push(…)` all land here without needing to know how the
 * router was obtained.
 */
const NAVIGATION_CALLEES: ReadonlySet<string> = new Set([
  'navigate',
  'push',
  'replace',
  'setScreen',
  'goTo',
  'go',
  'open',
])

/** The destination a handler navigates to, or `undefined`. */
export function readNavigationIntent(fn: ArrowFunction | FunctionExpression): string | undefined {
  const found: string[] = []

  const visit = (node: Node): void => {
    if (found.length > 1) return
    if (Node.isCallExpression(node)) {
      const destination = destinationOf(node)
      if (destination !== undefined) found.push(destination)
    }
    node.forEachChild(visit)
  }

  visit(fn)

  // Two destinations in one handler is a branch, and picking either would
  // invent a flow the code does not unconditionally have.
  return found.length === 1 ? found[0] : undefined
}

function destinationOf(call: Node): string | undefined {
  if (!Node.isCallExpression(call)) return undefined

  const expression = call.getExpression()
  const name = Node.isPropertyAccessExpression(expression)
    ? expression.getName()
    : Node.isIdentifier(expression)
      ? expression.getText()
      : undefined
  if (name === undefined || !NAVIGATION_CALLEES.has(name)) return undefined

  const [first] = call.getArguments()
  // A literal string is the only destination this reads. A template literal or
  // a variable means the destination is computed, and a computed destination
  // has no single honest answer.
  if (first === undefined || !Node.isStringLiteral(first)) return undefined

  const value = first.getLiteralValue().trim()
  return value.length > 0 ? value : undefined
}
