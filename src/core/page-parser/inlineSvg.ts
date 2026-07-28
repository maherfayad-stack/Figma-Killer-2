/**
 * inlineSvg — serialises an `<svg>` written as JSX ELEMENTS back into markup.
 *
 * A hand-rolled graphic in a React file is real JSX, not a string:
 *
 *   <svg className="ring__svg" viewBox="0 0 40 40">
 *     <circle className="ring__track" cx="20" cy="20" r={RING_RADIUS} />
 *     <circle strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} … />
 *   </svg>
 *
 * The canvas has exactly one way to render an inline SVG — `base.svg`, which
 * takes MARKUP — and the page tree is JSON, so the subtree has to become text
 * somewhere. Doing it here, at parse time, is what lets the evaluator supply the
 * computed geometry (`strokeDashoffset` above resolves through §7 like any other
 * expression).
 *
 * The alternative was to keep the children as real nodes with `base.container`
 * carrying `customTag: 'circle'`. That renders an element with no geometry:
 * `base.container` has no generic attribute passthrough, so every `cx`/`r`/
 * `stroke-*` would be dropped and the graphic would come out blank — the exact
 * symptom this replaces, one layer down.
 *
 * What this deliberately does NOT do: keep the graphic editable. An `<svg>`
 * subtree collapses to one locked `base.svg` node. Its interior is drawing
 * instructions, not page structure, and `base.svg`'s own editor is the place to
 * change markup.
 */
import { Node } from 'ts-morph'
import type { JsxAttribute, JsxSpreadAttribute } from 'ts-morph'
import type { PageEvalContext } from './resolutionLock'
import { tryResolveExpression } from './resolutionLock'

/**
 * SVG attributes that really are camelCase in markup. Everything else that
 * carries a capital is a React-ism for a dashed attribute (`strokeWidth` →
 * `stroke-width`), which is how React itself splits the two cases.
 */
const CAMEL_CASE_SVG_ATTRIBUTES: ReadonlySet<string> = new Set([
  'attributeName', 'attributeType', 'baseFrequency', 'baseProfile', 'calcMode',
  'clipPathUnits', 'diffuseConstant', 'edgeMode', 'filterUnits', 'gradientTransform',
  'gradientUnits', 'kernelMatrix', 'kernelUnitLength', 'keyPoints', 'keySplines',
  'keyTimes', 'lengthAdjust', 'limitingConeAngle', 'markerHeight', 'markerUnits',
  'markerWidth', 'maskContentUnits', 'maskUnits', 'numOctaves', 'pathLength',
  'patternContentUnits', 'patternTransform', 'patternUnits', 'pointsAtX',
  'pointsAtY', 'pointsAtZ', 'preserveAlpha', 'preserveAspectRatio', 'primitiveUnits',
  'refX', 'refY', 'repeatCount', 'repeatDur', 'requiredExtensions', 'specularConstant',
  'specularExponent', 'spreadMethod', 'startOffset', 'stdDeviation', 'stitchTiles',
  'surfaceScale', 'systemLanguage', 'tableValues', 'targetX', 'targetY', 'textLength',
  'viewBox', 'xChannelSelector', 'yChannelSelector', 'zoomAndPan',
])

/** Attributes that are React plumbing, never markup. */
const DROPPED_ATTRIBUTES: ReadonlySet<string> = new Set(['key', 'ref', 'dangerouslySetInnerHTML'])

/** SVG elements with no closing tag. */
const VOID_SVG_TAGS: ReadonlySet<string> = new Set([
  'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'stop', 'use', 'image',
])

/**
 * Ceiling on generated markup. A graphic an order of magnitude past this is a
 * data blob (a traced map, an embedded raster) and truncating it mid-tag would
 * produce invalid markup, so the whole serialisation declines instead.
 */
const MAX_MARKUP_LENGTH = 64 * 1024

/** React prop name -> markup attribute name. */
function attributeName(name: string): string {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  if (name.startsWith('data-') || name.startsWith('aria-') || name.includes(':')) return name
  if (CAMEL_CASE_SVG_ATTRIBUTES.has(name)) return name
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** `strokeWidth` -> `stroke-width` for a `style={{…}}` entry; `--x` passes through. */
function cssPropertyName(name: string): string {
  return name.startsWith('--') ? name : name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

/** The literal or §7-resolved value of one attribute, or `undefined` to omit it. */
function attributeValue(
  attribute: JsxAttribute,
  evalCtx: PageEvalContext | undefined,
): string | undefined {
  const initializer = attribute.getInitializer()
  if (initializer === undefined) return '' // valueless shorthand -> boolean attribute
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralValue()
  if (!Node.isJsxExpression(initializer)) return undefined

  const expression = initializer.getExpression()
  if (expression === undefined) return undefined
  if (Node.isObjectLiteralExpression(expression)) return undefined // `style` — handled separately

  const resolved = tryResolveExpression(expression, evalCtx)
  if (resolved === undefined || typeof resolved.value === 'boolean') return undefined
  return String(resolved.value)
}

/** A `style={{…}}` object literal as a CSS declaration string, or `undefined`. */
function styleAttributeValue(
  attribute: JsxAttribute,
  evalCtx: PageEvalContext | undefined,
): string | undefined {
  const initializer = attribute.getInitializer()
  if (!initializer || !Node.isJsxExpression(initializer)) return undefined
  const objectExpr = initializer.getExpression()
  if (!objectExpr || !Node.isObjectLiteralExpression(objectExpr)) return undefined

  const declarations: string[] = []
  for (const property of objectExpr.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue
    const nameNode = property.getNameNode()
    const key = Node.isIdentifier(nameNode)
      ? nameNode.getText()
      : Node.isStringLiteral(nameNode)
        ? nameNode.getLiteralValue()
        : undefined
    const valueNode = property.getInitializer()
    if (key === undefined || valueNode === undefined) continue

    const value = Node.isStringLiteral(valueNode)
      ? valueNode.getLiteralValue()
      : Node.isNumericLiteral(valueNode)
        ? String(valueNode.getLiteralValue())
        : tryResolveExpression(valueNode, evalCtx)?.value
    if (value === undefined || typeof value === 'boolean') continue
    declarations.push(`${cssPropertyName(key)}: ${value}`)
  }
  return declarations.length > 0 ? declarations.join('; ') : undefined
}

function serializeAttributes(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  evalCtx: PageEvalContext | undefined,
): string {
  let out = ''
  for (const attribute of attributes) {
    // A spread carries an unknown set of attributes; there is nothing to write.
    if (!Node.isJsxAttribute(attribute)) continue
    const name = attribute.getNameNode().getText()
    if (DROPPED_ATTRIBUTES.has(name) || name.startsWith('on')) continue

    const value = name === 'style'
      ? styleAttributeValue(attribute, evalCtx)
      : attributeValue(attribute, evalCtx)
    if (value === undefined) continue
    out += value === '' ? ` ${attributeName(name)}` : ` ${attributeName(name)}="${escapeAttribute(value)}"`
  }
  return out
}

/**
 * One JSX node as markup. Returns `''` for anything that carries nothing
 * renderable (a comment-only expression, an unresolvable interpolation) —
 * omitting a shape rather than guessing at it.
 */
function serializeNode(node: Node, evalCtx: PageEvalContext | undefined): string {
  if (Node.isJsxText(node)) {
    // NOT escaped: JSX text and markup text are the same syntax, entities
    // included, so the source text is already what belongs in the output.
    // Escaping it turned an authored `&lt;` into a visible `&amp;lt;`.
    const text = node.getLiteralText()
    return text.trim().length === 0 ? '' : text
  }

  if (Node.isJsxExpression(node)) {
    const expression = node.getExpression()
    if (expression === undefined) return ''
    const resolved = tryResolveExpression(expression, evalCtx)
    return resolved === undefined ? '' : escapeText(String(resolved.value))
  }

  if (Node.isJsxFragment(node)) {
    return node.getJsxChildren().map((child) => serializeNode(child, evalCtx)).join('')
  }

  if (Node.isJsxSelfClosingElement(node)) {
    const tag = node.getTagNameNode().getText()
    const attrs = serializeAttributes(node.getAttributes(), evalCtx)
    return VOID_SVG_TAGS.has(tag) ? `<${tag}${attrs}/>` : `<${tag}${attrs}></${tag}>`
  }

  if (Node.isJsxElement(node)) {
    const opening = node.getOpeningElement()
    const tag = opening.getTagNameNode().getText()
    const attrs = serializeAttributes(opening.getAttributes(), evalCtx)
    const children = node.getJsxChildren().map((child) => serializeNode(child, evalCtx)).join('')
    return `<${tag}${attrs}>${children}</${tag}>`
  }

  return ''
}

/**
 * An `<svg>` element written as JSX -> its markup, or `undefined` when the tag
 * is not an `<svg>` or the result would exceed `MAX_MARKUP_LENGTH`.
 *
 * A COMPONENT tag is refused even if it is spelled `svg`-ish: only a lowercase
 * host `svg` element is a literal SVG document. Custom components have to keep
 * going through the normal component path.
 */
export function serializeInlineSvg(
  element: Node,
  evalCtx: PageEvalContext | undefined,
): string | undefined {
  const tagNode = Node.isJsxElement(element)
    ? element.getOpeningElement().getTagNameNode()
    : Node.isJsxSelfClosingElement(element)
      ? element.getTagNameNode()
      : undefined
  if (tagNode === undefined || tagNode.getText() !== 'svg') return undefined

  const markup = serializeNode(element, evalCtx)
  return markup.length > 0 && markup.length <= MAX_MARKUP_LENGTH ? markup : undefined
}
