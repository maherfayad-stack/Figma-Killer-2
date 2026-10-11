/**
 * detachCallSiteValues - what a prop IS at the call site being detached: the
 * explicit attribute (a string, an expression, a bare `true`), the last
 * spread's member, the component's own destructured default when the call site
 * did not give one, and `children` as a value. Reads only; the `Value` it
 * returns is what `detachPlanner.ts` writes where the markup read the prop.
 *
 * Split out of the planner at the module-size ceiling, along the seam it
 * already had: nothing here depends on how the markup is rendered, only on the
 * call site and on how to write the component's own default
 * (`componentValue`, passed in).
 */
import { Node, type JsxAttribute } from 'ts-morph'
import type { DetachNameResolver } from './detachNames'
import {
  NO_NAMES,
  TRUE_VALUE,
  UNDEFINED_VALUE,
  fail,
  isJsxNode,
  isNeverUndefined,
  jsStringLiteral,
  jsxStringValue,
  jsxTextValue,
  nodeValue,
  type CallSite,
  type CallSiteAttr,
  type Value,
} from './detachSource'
import { freeReferenceNames } from './subtreeFreeVariables'

export class CallSiteValues {
  private readonly callSite: CallSite
  private readonly names: DetachNameResolver
  private readonly componentName: string
  private readonly componentValue: (node: Node) => Value

  constructor(callSite: CallSite, names: DetachNameResolver, componentName: string, componentValue: (node: Node) => Value) {
    this.callSite = callSite
    this.names = names
    this.componentName = componentName
    this.componentValue = componentValue
  }

  /** A call-site expression as a `Value`, its free names recorded so the gate checks they still bind at the call site. */
  callSiteValue(node: Node): Value {
    const free = new Set(freeReferenceNames(node))
    this.names.expectCallSiteNames(free)
    return nodeValue(node, node.getText(), free)
  }

  lastAttribute(name: string): CallSiteAttr | undefined {
    return this.callSite.attrs.filter((a) => a.name === name).at(-1)
  }

  attributeValue(name: string, fallback: Node | undefined): Value {
    const explicit = this.lastAttribute(name)
    const spreads = this.callSite.spreads
    const lastSpread = spreads.at(-1)
    if (lastSpread && (!explicit || explicit.index < lastSpread.index)) {
      if (explicit) {
        fail(
          'spread-ambiguous',
          `This call site sets \`${name}\` and then spreads {...${lastSpread.expr.getText()}}, so which value renders is unknown. Set \`${name}\` after the spread in the code.`,
        )
      }
      if (spreads.length > 1) {
        fail('spread-ambiguous', `This call site spreads ${spreads.length} objects, and \`${name}\` could come from any of them. Spread a single object instead.`)
      }
      if (!Node.isIdentifier(lastSpread.expr)) {
        fail('spread-ambiguous', `This call site spreads {...${lastSpread.expr.getText()}}, which detach cannot read a prop out of. Spread a named object instead.`)
      }
      const base = lastSpread.expr.getText()
      const text = /^[A-Za-z_$][\w$]*$/.test(name) ? `${base}.${name}` : `${base}[${jsStringLiteral(name)}]`
      const free = new Set([base])
      this.names.expectCallSiteNames(free)
      const member: Value = { expr: () => text, primary: true, free }
      return fallback ? this.defaulted(member, fallback) : member
    }
    if (explicit) return this.explicitValue(explicit.attr, fallback)
    return fallback ? this.componentValue(fallback) : UNDEFINED_VALUE
  }

  explicitValue(attr: JsxAttribute, fallback: Node | undefined): Value {
    const initializer = attr.getInitializer()
    if (!initializer) return TRUE_VALUE
    if (Node.isStringLiteral(initializer)) {
      const text = initializer.getText()
      return jsxStringValue(initializer.getLiteralText(), text, NO_NAMES, text.charAt(0))
    }
    if (Node.isJsxExpression(initializer)) {
      const expr = initializer.getExpression()
      if (!expr || (Node.isIdentifier(expr) && expr.getText() === 'undefined')) {
        return fallback ? this.componentValue(fallback) : UNDEFINED_VALUE
      }
      const value = this.callSiteValue(expr)
      return fallback && !isNeverUndefined(expr) ? this.defaulted(value, fallback) : value
    }
    return this.callSiteValue(initializer)
  }

  /** A destructured default applies exactly when the value is `undefined` — so that is what gets written. */
  private defaulted(value: Value, fallback: Node): Value {
    const alternative = this.componentValue(fallback)
    const operand = value.primary ? value.expr() : `(${value.expr()})`
    return {
      expr: () => `${operand} === undefined ? ${alternative.expr()} : ${value.expr()}`,
      primary: false,
      free: new Set([...value.free, ...alternative.free]),
    }
  }

  /** `children` as a VALUE (anywhere but a `{children}` child slot): one element, one expression, or one run of text. */
  childrenValue(): Value {
    const nodes = this.callSite.children!.nodes
    const only = nodes.length === 1 ? nodes[0]! : undefined
    if (only && isJsxNode(only)) return this.callSiteValue(only)
    if (only && Node.isJsxExpression(only) && only.getExpression()) return this.callSiteValue(only.getExpression()!)
    if (only && Node.isJsxText(only)) {
      const raw = jsxTextValue(only.getText())
      const attrText = raw.includes('"') ? (raw.includes("'") ? undefined : `'${raw}'`) : `"${raw}"`
      return jsxStringValue(raw, /[\r\n]/.test(raw) ? undefined : attrText, NO_NAMES)
    }
    fail('unsupported-params', `${this.componentName} uses its children as a value, and this call site passes more than one child. Pass a single child.`)
  }
}
