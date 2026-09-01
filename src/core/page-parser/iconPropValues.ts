/**
 * iconPropValues — turning a JSX-valued prop into the `{ svg: markup }` the
 * page tree can carry, at the top of a prop and at every level inside it.
 *
 * Split out of `jsxAttributeReaders.ts`, which reads ATTRIBUTES: how they are
 * written, which reader owns which, what a resolved value looks like. This
 * answers one narrower question that grew its own rules — "is this value an
 * icon, and what is its markup" — for four shapes (`<span
 * dangerouslySetInnerHTML/>`, `<Icon svg={…}/>`, a literal `<svg>`, and any of
 * those nested inside an `items` array) that no other reader cares about.
 *
 * `svg` is the SAME key a node carrying raw markup uses (`resolveModuleId`
 * promotes such a node to `base.svg`), so this is one convention read at two
 * altitudes rather than a new one. The module layer turns it back into an
 * element — see `src/modules/alm/register.tsx`'s `reviveIconProps`.
 */
import { Node } from 'ts-morph'
import type { JsxAttribute, JsxSpreadAttribute } from 'ts-morph'
import type { ParsedPropValue } from './types'
import { tryResolveExpression, type PageEvalContext } from './nodeResolution'
import { serializeInlineSvg } from './inlineSvg'

/**
 * Markup that actually opens an `<svg>` document.
 *
 * This prop can carry any HTML, and handing arbitrary markup to `base.svg` —
 * whose whole contract is "an inline SVG" — would be a category error. Exported
 * for `inlineLocalComponents`, which applies the same test to a value it
 * substitutes in from a call site.
 */
export const SVG_DOCUMENT_RE = /^\s*<svg[\s>]/i

/**
 * The `<expr>` inside `dangerouslySetInnerHTML={{ __html: <expr> }}`, or
 * `undefined` when this element has no such attribute (or writes it in a shape
 * this parser does not read — a spread, a call, a non-literal object).
 *
 * Split out from `extractRawSvgMarkup` because two callers need this one shape
 * and resolve `<expr>` differently: the parser hands it to §7's evaluator, while
 * `inlineLocalComponents` looks it up in a call site's substitution env (a
 * component parameter has no value the evaluator could reach). Sharing the
 * reader keeps "how the attribute is written" in one place.
 */
export function rawHtmlValueExpression(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
): Node | undefined {
  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue
    if (attribute.getNameNode().getText() !== 'dangerouslySetInnerHTML') continue

    const initializer = attribute.getInitializer()
    if (!initializer || !Node.isJsxExpression(initializer)) return undefined
    const objectExpr = initializer.getExpression()
    if (!objectExpr || !Node.isObjectLiteralExpression(objectExpr)) return undefined

    const htmlProp = objectExpr.getProperty('__html')
    return htmlProp && Node.isPropertyAssignment(htmlProp) ? htmlProp.getInitializer() : undefined
  }
  return undefined
}

/**
 * The raw SVG markup an element injects via
 * `dangerouslySetInnerHTML={{ __html: <expr> }}`, or `undefined`.
 *
 * `<expr>` goes through §7's evaluator, which resolves a `?raw` text import
 * (`resolveRawTextImport` in `./staticEvalCore`) as well as a local alias, a
 * member chain, or a value substituted in from a call site — so this one path
 * covers `<span dangerouslySetInnerHTML={{__html: checkSvg}} />` written
 * directly. The far more common `<Icon svg={checkSvg} />` reaches the same span
 * through `inlineLocalComponents`, which substitutes the `svg` param into this
 * same attribute — a component parameter has no value for §7 to resolve here.
 *
 * Only markup that actually opens an `<svg>` document is returned — see
 * `SVG_DOCUMENT_RE`.
 */
export function extractRawSvgMarkup(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  evalCtx: PageEvalContext | undefined,
): string | undefined {
  const valueExpr = rawHtmlValueExpression(attributes)
  return valueExpr ? resolveRawSvgMarkup(valueExpr, evalCtx) : undefined
}

/**
 * The SVG markup a `__html` expression yields — the resolved value when §7 can
 * evaluate it, otherwise the markup its TRANSFORM was handed.
 *
 * The fallback exists because the common real shape is not a bare identifier but
 * `__html: applyTokens(svg)`, where `applyTokens` LOOPS over a substitution
 * table swapping hardcoded hex fills for design tokens. A loop over a resolved
 * array in a callee's body is a statement-level evaluation the §7 evaluator does
 * not do, so the call returns unresolved — and 9 illustration icons on the eSIM
 * corpus's homepage rendered as blank 48px boxes with their markup sitting in
 * plain sight one argument away.
 *
 * What this gives up, stated plainly: the icon renders with the fills the source
 * file holds rather than the ones the transform would have produced (here, real
 * hex instead of `var(--color-aqua-*)`, so it does not follow a dark theme). That
 * is the same trade `applySubstitutions` already makes for a computed
 * `className`, keeping the static prefix for visual fidelity — and it beats a
 * blank box, which tells the user nothing about their screen.
 *
 * Deliberately ONE call level deep and argument-order-first: this recovers the
 * input of a transform, it does not try to guess at nested composition.
 *
 * Exported for `componentSubstitution`, which re-reads the same attribute against
 * a call site's param-bound scope.
 */
export function resolveRawSvgMarkup(valueExpr: Node, evalCtx: PageEvalContext | undefined): string | undefined {
  const direct = tryResolveExpression(valueExpr, evalCtx)?.value
  if (typeof direct === 'string' && SVG_DOCUMENT_RE.test(direct)) return direct

  if (!Node.isCallExpression(valueExpr)) return undefined
  for (const argument of valueExpr.getArguments()) {
    const inner = tryResolveExpression(argument, evalCtx)?.value
    if (typeof inner === 'string' && SVG_DOCUMENT_RE.test(inner)) return inner
  }
  return undefined
}

/**
 * The value shape a JSX-valued icon prop is captured as: `{ svg: markup }`.
 *
 * `<Cell icon={<Icon svg={rewardCardSvg}/>}/>` is how a design system's icon
 * slots are actually filled, and a React element has no JSON form — so the prop
 * was skipped and the cell rendered with an empty visual slot (8 of them across
 * the eSIM corpus, in `Cell`, `GlassButton`, and the `leadingIcon`/`trailingIcon`
 * slots).
 *
 * `svg` is the SAME key a node carrying raw markup uses (`resolveModuleId`
 * promotes such a node to `base.svg`), so this is one convention read at two
 * altitudes rather than a new one: a value holding `svg` IS inline SVG. The
 * module layer turns it back into an element — see `src/modules/alm/register.tsx`.
 */
export const ICON_PROP_SVG_KEY = 'svg'

/**
 * The inline SVG markup a JSX-valued prop's element renders, as
 * `{ svg: markup }`, or `undefined` when the element yields no markup.
 *
 * Reads only the element's OWN attributes, one level deep: its
 * `dangerouslySetInnerHTML` (the `<span dangerouslySetInnerHTML/>` shape), or any
 * attribute whose value resolves to a string that opens an `<svg>` document
 * (the `<Icon svg={…}/>` shape, where the wrapper component is what would
 * eventually inject it). Anything else — a nested layout, a component whose
 * markup only materialises after inlining — declines, and the prop stays absent
 * rather than being guessed at.
 */
export function iconPropFromJsx(
  expression: Node,
  evalCtx: PageEvalContext | undefined,
): Record<string, string> | undefined {
  if (!Node.isJsxElement(expression) && !Node.isJsxSelfClosingElement(expression)) return undefined
  const attributes = Node.isJsxElement(expression)
    ? expression.getOpeningElement().getAttributes()
    : expression.getAttributes()

  const rawHtml = rawHtmlValueExpression(attributes)
  const injected = rawHtml ? resolveRawSvgMarkup(rawHtml, evalCtx) : undefined
  if (injected !== undefined) return { [ICON_PROP_SVG_KEY]: injected }

  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue
    const initializer = attribute.getInitializer()
    if (!initializer || !Node.isJsxExpression(initializer)) continue
    const inner = initializer.getExpression()
    if (!inner) continue
    const resolved = tryResolveExpression(inner, evalCtx)?.value
    if (typeof resolved === 'string' && SVG_DOCUMENT_RE.test(resolved)) {
      return { [ICON_PROP_SVG_KEY]: resolved }
    }
  }
  return undefined
}

/**
 * The same `{ svg: markup }` capture {@link iconPropFromJsx} does at the top of
 * a prop, applied to every JSX value nested INSIDE a structured one.
 *
 * A design system's list content carries its own icons:
 * `items={[{ icon: <svg…/>, label: 'Home' }, …]}` is the documented shape of a
 * `TabBar`, and the two readers above only ever looked at the top of the
 * attribute. So the evaluator reached the nested element, had no kind for a
 * React element, and dropped the entry — `staticValueToPropValue` keeps an
 * object that loses one key — leaving `{ label: 'Home' }`. The canvas drew a
 * tab bar with correct labels and five empty icon slots, which is exactly what
 * it was told.
 *
 * Walks the ORIGINAL expression in parallel with the RESOLVED value rather than
 * re-evaluating: the resolved half is already correct for everything that is
 * not a React element, and the AST is the only place the element survives.
 * Positions are matched conservatively — an array whose element count no longer
 * matches the resolved one (a spread collapsed it) is left exactly as it is,
 * because a misaligned index would move one tab's icon onto another.
 */
export function withNestedIconValues(
  expr: Node,
  value: ParsedPropValue,
  evalCtx: PageEvalContext | undefined,
): ParsedPropValue {
  const node = unwrapParentheses(expr)
  if (Node.isArrayLiteralExpression(node) && Array.isArray(value)) {
    const elements = node.getElements()
    if (elements.length !== value.length) return value
    return value.map((item, index) => nestedIconOrWalk(elements[index]!, item, evalCtx))
  }
  if (Node.isObjectLiteralExpression(node) && isPlainPropObject(value)) {
    const out: Record<string, ParsedPropValue> = { ...value }
    for (const property of node.getProperties()) {
      if (!Node.isPropertyAssignment(property)) continue
      const key = property.getName().replace(/^['"]|['"]$/g, '')
      const initializer = property.getInitializer()
      if (!initializer) continue
      const icon = nestedIconValue(initializer, evalCtx)
      if (icon !== undefined) {
        out[key] = icon
        continue
      }
      const existing = out[key]
      if (existing !== undefined) out[key] = withNestedIconValues(initializer, existing, evalCtx)
    }
    return out
  }
  return value
}

/** One array element: its own icon if it is a JSX value, else the same walk one level down. */
function nestedIconOrWalk(
  expr: Node,
  value: ParsedPropValue,
  evalCtx: PageEvalContext | undefined,
): ParsedPropValue {
  return nestedIconValue(expr, evalCtx) ?? withNestedIconValues(expr, value, evalCtx)
}

/**
 * A nested JSX value as `{ svg: markup }`, or `undefined` when it is not one.
 *
 * Accepts BOTH forms this corpus writes: the wrapper shapes
 * {@link iconPropFromJsx} already reads (`<span dangerouslySetInnerHTML/>`,
 * `<Icon svg={…}/>`), and a literal inline `<svg>` element — which is what
 * Studio itself writes when an icon is placed from the picker, and the only
 * portable form (see `svgToJsxNode.ts` for why an SVG *import* is not one
 * Studio can honestly write into a project whose bundler it does not own).
 */
function nestedIconValue(expr: Node, evalCtx: PageEvalContext | undefined): Record<string, string> | undefined {
  const node = unwrapParentheses(expr)
  if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) return undefined
  const wrapped = iconPropFromJsx(node, evalCtx)
  if (wrapped !== undefined) return wrapped
  const markup = serializeInlineSvg(node, evalCtx)
  return markup === undefined ? undefined : { [ICON_PROP_SVG_KEY]: markup }
}

/** A resolved value that is a plain object — not an array, not a scalar. */
function isPlainPropObject(value: ParsedPropValue): value is Record<string, ParsedPropValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `({ … })` and `(<svg/>)` — the parentheses a formatter adds carry no meaning here. */
function unwrapParentheses(expr: Node): Node {
  let node = expr
  while (Node.isParenthesizedExpression(node)) node = node.getExpression()
  return node
}
