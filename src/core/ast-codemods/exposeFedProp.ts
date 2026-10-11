/**
 * exposeFedProp — OD-19 for a value that is ALREADY a prop.
 *
 * `exposeLiteralAsProp` turns a literal in a component's markup into an
 * optional prop. After it has run once (or in any component written that way
 * by hand), the next instance's element no longer holds a literal:
 *
 *     <h2>{heading}</h2>          // heading = 'Main hall' by default
 *
 * Editing that text for ONE instance needs no change to the component at all —
 * the honest target is the call site, which either already passes `heading`
 * (replace its literal) or does not (add the attribute). That is this module:
 * it recognises a target that is the BARE read of one of the component's own
 * props, checks it feeds exactly one place, and plans the call-site text edit.
 * The component is touched only to widen the prop's declared type, when the new
 * value is of another primitive than the one it carries today.
 *
 * Refuses (the caller reports the reason, files untouched):
 *   - `shared-prop` — the component reads the prop in more than one place, so
 *     setting it would change places the user did not point at;
 *   - `not-a-literal` — the call site passes the prop as an expression (a
 *     binding is never baked), or there is no value to write;
 *   - `call-site-spread` — a spread comes AFTER the attribute that would be
 *     replaced, so the spread could still override what is written.
 */
import { Node } from 'ts-morph'
import { paramReadCount, type FunctionLike } from '@core/page-parser'
import { jsStringLiteral, isJsxAttributeSafe } from './detachSource'
import type { JsxOpeningLikeElement } from './locateJsxElement'
import type { ExposeTarget } from './exposeLiteralAsProp'

export type FedValueType = 'string' | 'number' | 'boolean'

export type FedPlan =
  | {
      ok: true
      /** The splice that makes this call site pass `value`. */
      edit: { pos: number; remove: number; text: string }
      /** The primitive type the prop carries today (call site's literal, else the default's), when it can be told. */
      currentType: FedValueType | undefined
    }
  | { ok: false; reason: 'shared-prop' | 'not-a-literal' | 'call-site-spread'; message: string }

/** The expression an override's target reads, when it is a single expression (`{heading}`, `alt={altText}`, `width: widthValue`). */
function targetExpression(element: JsxOpeningLikeElement, target: ExposeTarget): Node | undefined {
  if (target.kind === 'text') {
    const parent = Node.isJsxOpeningElement(element) ? element.getParent() : undefined
    if (!parent || !Node.isJsxElement(parent)) return undefined
    const meaningful = parent.getJsxChildren().filter((child) => {
      if (Node.isJsxText(child)) return !child.containsOnlyTriviaWhiteSpaces()
      return !(Node.isJsxExpression(child) && child.getExpression() === undefined)
    })
    const only = meaningful.length === 1 ? meaningful[0] : undefined
    return only && Node.isJsxExpression(only) ? only.getExpression() : undefined
  }
  const attributeName = target.kind === 'attribute' ? target.name : 'style'
  const attribute = element.getAttributes().find((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === attributeName)
  const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
  const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
  if (target.kind === 'attribute') return expression
  if (!expression || !Node.isObjectLiteralExpression(expression)) return undefined
  for (const member of expression.getProperties()) {
    if (!Node.isPropertyAssignment(member) && !Node.isShorthandPropertyAssignment(member)) continue
    const key = member.getNameNode()
    const keyText = Node.isIdentifier(key) ? key.getText() : Node.isStringLiteral(key) ? key.getLiteralValue() : undefined
    if (keyText === target.property) return Node.isShorthandPropertyAssignment(member) ? key : member.getInitializer()
  }
  return undefined
}

/** The local name of the prop the target reads bare, or `undefined` when it reads anything else (a literal, a call, a member chain). */
export function fedIdentifier(element: JsxOpeningLikeElement, target: ExposeTarget): string | undefined {
  const expression = targetExpression(element, target)
  return expression && Node.isIdentifier(expression) ? expression.getText() : undefined
}

function valueType(value: string | number | boolean): FedValueType {
  return typeof value as FedValueType
}

/** The primitive type of a default written as source (`'x'`, `8`, `true`), or `undefined` for anything else. */
function defaultType(defaultText: string | undefined): FedValueType | undefined {
  if (defaultText === undefined) return undefined
  const text = defaultText.trim()
  if (/^(['"`]).*\1$/s.test(text)) return 'string'
  if (/^-?\d+(\.\d+)?$/.test(text)) return 'number'
  return text === 'true' || text === 'false' ? 'boolean' : undefined
}

function attributeText(name: string, value: string | number | boolean): string {
  if (value === true) return name
  if (typeof value === 'string') return isJsxAttributeSafe(value) ? `${name}="${value}"` : `${name}={${jsStringLiteral(value)}}`
  return `${name}={${String(value)}}`
}

/** The type of a call site's own literal attribute, or `undefined` for anything that is not one. */
function attributeLiteralType(initializer: Node | undefined): FedValueType | undefined {
  if (initializer === undefined) return 'boolean'
  if (Node.isStringLiteral(initializer)) return 'string'
  if (!Node.isJsxExpression(initializer)) return undefined
  const expression = initializer.getExpression()
  if (!expression) return undefined
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) return 'string'
  if (Node.isNumericLiteral(expression)) return 'number'
  return Node.isTrueLiteral(expression) || Node.isFalseLiteral(expression) ? 'boolean' : undefined
}

export function planFedOverride(params: {
  fn: FunctionLike
  callSite: JsxOpeningLikeElement
  /** The local binding the target reads, and the call-site attribute it is passed under. */
  paramName: string
  propName: string
  defaultText: string | undefined
  value: string | number | boolean
}): FedPlan {
  const { fn, callSite, paramName, propName, defaultText, value } = params
  if (paramReadCount(fn, paramName) !== 1) {
    return { ok: false, reason: 'shared-prop', message: `\`${propName}\` feeds more than one place in this component, so setting it here would change places you did not point at.` }
  }

  const attributes = callSite.getAttributes()
  const index = attributes.findIndex((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === propName)
  const existing = index >= 0 ? attributes[index] : undefined

  if (existing && Node.isJsxAttribute(existing)) {
    const currentType = attributeLiteralType(existing.getInitializer())
    if (currentType === undefined) {
      return { ok: false, reason: 'not-a-literal', message: `This call site passes \`${propName}\` as a value read from code, which is never overwritten with a literal.` }
    }
    if (attributes.slice(index + 1).some((attr) => Node.isJsxSpreadAttribute(attr))) {
      return { ok: false, reason: 'call-site-spread', message: `A spread after \`${propName}\` on this call site could still override the value written, so nothing was changed.` }
    }
    const start = existing.getStart()
    return { ok: true, edit: { pos: start, remove: existing.getEnd() - start, text: attributeText(propName, value) }, currentType }
  }

  const last = attributes[attributes.length - 1]
  const pos = last ? last.getEnd() : callSite.getTagNameNode().getEnd()
  // Appended last, so it wins over any spread before it.
  return { ok: true, edit: { pos, remove: 0, text: ` ${attributeText(propName, value)}` }, currentType: defaultType(defaultText) }
}

/** Does writing `value` need the prop's declared type widened? Unknown current type means the declared type is checked. */
export function needsWidening(plan: Extract<FedPlan, { ok: true }>, value: string | number | boolean): FedValueType | undefined {
  return plan.currentType === valueType(value) ? undefined : valueType(value)
}
