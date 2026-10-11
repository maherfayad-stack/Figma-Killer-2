/**
 * paramReads — how many places a component's body reads one of its own props.
 *
 * Shared by the two readers that must agree on "this prop feeds exactly one
 * place": the parser, which records `ParsedNode.propFeeds` only for such a prop,
 * and `exposeLiteralAsProp`, which refuses to write a call site's value for a
 * prop that also feeds something else. Pure syntax; nothing is evaluated.
 */
import { Node, SyntaxKind } from 'ts-morph'
import type { FunctionLike } from './types'

/**
 * How many times `fn`'s body reads `name` as a VALUE — not the binding in the
 * parameter list, not a property called `name` (`a.name`, `{ name: x }`), not a
 * JSX attribute name. A syntactic count, deliberately a little too high (a
 * shadowing parameter of the same name counts): the caller uses it only to
 * decide "this prop feeds exactly one place".
 */
export function paramReadCount(fn: FunctionLike, name: string): number {
  const first = fn.getParameters()[0]
  let reads = 0
  for (const id of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== name) continue
    if (first && id.getStart() >= first.getStart() && id.getEnd() <= first.getEnd()) continue
    const parent = id.getParent()
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) continue
    if ((Node.isPropertyAssignment(parent) || Node.isJsxAttribute(parent)) && parent.getNameNode() === id) continue
    reads += 1
  }
  return reads
}
