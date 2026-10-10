/**
 * detachConditionals — the part of detach that writes a decided conditional as
 * the branch it takes (P0-6). `detachConstantFold.ts` is the pure decision
 * (which literals a test reads as, which branch results); this applies it to
 * the planner's rendering: a JSX child `{test ? a : b}` or an attribute
 * `x={test ? 'a' : 'b'}`. It never reads the component itself — everything it
 * needs from the planner comes through {@link ConditionalHost}.
 */
import { Node } from 'ts-morph'
import { foldConditional, literalOfNode, type FoldedBranch, type Literal } from './detachConstantFold'
import { isJsxAttributeSafe, isJsxNode, type Value } from './detachSource'

/** One piece of the component's source being rewritten: the chosen JSX root, or a default/initializer inlined into it. */
export interface Unit {
  node: Node
  /** Names the rendered text reads from outside itself. */
  free: Set<string>
}

/** What the planner lends this collaborator. */
export interface ConditionalHost {
  /** For a reference that is a component prop (or a `rest.x` member): `{ literal }` (undefined literal = not a literal). Otherwise `undefined`. */
  readProp(reference: Node, unit: Unit): { literal: Literal | undefined } | undefined
  renderNode(node: Node, unit: Unit): string
  siteValue(node: Node, unit: Unit): Value | undefined
  admit(site: Node, names: ReadonlySet<string>, unit: Unit): void
  attributeText(name: string, value: Value): string | undefined
}

export class DetachConditionals {
  private readonly host: ConditionalHost

  constructor(host: ConditionalHost) {
    this.host = host
  }

  /**
   * Which branch a conditional takes, when its test is made of props the call
   * site gave literals — and at least one prop takes part, so an author's own
   * `true ? a : b` is left alone. `undefined` is "not decidable".
   */
  private decide(expression: Node, unit: Unit, inChild: boolean): FoldedBranch | undefined {
    let readAProp = false
    const read = (reference: Node): Literal | undefined => {
      const prop = this.host.readProp(reference, unit)
      if (!prop) return undefined
      readAProp = true
      return prop.literal
    }
    const decided = foldConditional(expression, read, inChild)
    return decided && readAProp ? decided : undefined
  }

  /** A JSX child `{test ? a : b}` / `{test && a}` written as the branch that renders; `undefined` when it cannot be decided. */
  child(expression: Node, unit: Unit): string | undefined {
    const decided = this.decide(expression, unit, true)
    if (!decided) return undefined
    let branch = decided.branch
    while (branch && Node.isParenthesizedExpression(branch)) branch = branch.getExpression()
    if (!branch) return ''
    const nested = this.child(branch, unit)
    if (nested !== undefined) return nested
    if (isJsxNode(branch)) return this.host.renderNode(branch, unit)
    const literal = literalOfNode(branch)
    if (literal && (literal.v === null || literal.v === undefined || typeof literal.v === 'boolean')) return ''
    return `{${this.host.renderNode(branch, unit)}}`
  }

  /**
   * An attribute value `{test ? a : b}` written as the attribute the taken
   * branch makes. `undefined`: not a decidable conditional. `{ text: undefined }`:
   * decided, and the attribute is dropped (React drops an `undefined` value).
   */
  attribute(name: string, expression: Node, unit: Unit): { text: string | undefined } | undefined {
    const chosen = this.chosen(expression, unit)
    if (chosen === undefined) return undefined
    return { text: chosen === null ? undefined : this.attributeText(name, chosen, unit) }
  }

  /** The expression an attribute's conditional reduces to, `null` for a dropped value, `undefined` when not decidable. */
  private chosen(expression: Node, unit: Unit): Node | null | undefined {
    const decided = this.decide(expression, unit, false)
    if (!decided || decided.branch === null) return undefined
    let branch: Node = decided.branch
    while (Node.isParenthesizedExpression(branch)) branch = branch.getExpression()
    const nested = this.chosen(branch, unit)
    if (nested !== undefined) return nested
    const literal = literalOfNode(branch)
    return literal !== undefined && literal.v === undefined ? null : branch
  }

  private attributeText(name: string, chosen: Node, unit: Unit): string | undefined {
    const value = this.host.siteValue(chosen, unit)
    if (value) {
      this.host.admit(chosen, value.free, unit)
      return this.host.attributeText(name, value)
    }
    const literal = literalOfNode(chosen)
    if (typeof literal?.v === 'string' && isJsxAttributeSafe(literal.v)) return `${name}="${literal.v}"`
    return `${name}={${this.host.renderNode(chosen, unit)}}`
  }
}
