/**
 * svgAttributeNames — the ONE mapping between an SVG attribute's markup name
 * and its JSX (React prop) name, in both directions.
 *
 * Three places translate SVG attribute names, and they used to carry three
 * private lists that disagreed:
 *
 *   - `inlineSvg.ts` (parse): JSX → markup, so a `<svg>` written as JSX can be
 *     rendered as markup on the canvas;
 *   - `svgToJsxNode.ts` (import): markup → JSX, so an SVG file can be written
 *     into the user's `.tsx`;
 *   - `splitSvgRoot.ts` (canvas render): markup → JSX, so a literal `<svg>`
 *     can be rendered AS an `<svg>` element with React props.
 *
 * The disagreement was real: the parse direction turned `xlinkHref` into
 * `xlink-href` and `tabIndex` into `tab-index`, names no browser reads, while
 * the import direction wrote `xlinkHref` for the same attribute. A graphic
 * that went markup → JSX → markup came back different. One table, read both
 * ways, is what makes the round trip an identity.
 *
 * The rules are React's own (`react-dom`'s `possibleStandardNames`):
 *   - `class` ⇄ `className`, `for` ⇄ `htmlFor`;
 *   - `data-*` / `aria-*` keep their hyphens;
 *   - the XML-namespaced attributes React understands have camelCase aliases
 *     (`xlink:href` ⇄ `xlinkHref`, `xml:space` ⇄ `xmlSpace`,
 *     `xmlns:xlink` ⇄ `xmlnsXlink`); any other namespaced name has no JSX
 *     spelling at all, because a colon cannot appear in a JSX attribute name;
 *   - attributes that really are camelCase in markup (`viewBox`,
 *     `preserveAspectRatio`, …) are the same in both;
 *   - every other hyphenated attribute camelCases (`stroke-width` ⇄
 *     `strokeWidth`).
 *
 * Pure: no DOM, no ts-morph. It runs in the parser, the browser and tests.
 */

/**
 * SVG attributes that really are camelCase in markup. Everything else that
 * carries a capital in JSX is a React-ism for a dashed attribute
 * (`strokeWidth` → `stroke-width`), which is how React itself splits the two
 * cases.
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

/**
 * Markup name → JSX name for every attribute that is neither a camelCase SVG
 * attribute nor a plain hyphen-to-camel conversion. Read in reverse for the
 * other direction.
 */
const SPECIAL_MARKUP_TO_JSX: Readonly<Record<string, string>> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  crossorigin: 'crossOrigin',
  'xlink:actuate': 'xlinkActuate',
  'xlink:arcrole': 'xlinkArcrole',
  'xlink:href': 'xlinkHref',
  'xlink:role': 'xlinkRole',
  'xlink:show': 'xlinkShow',
  'xlink:title': 'xlinkTitle',
  'xlink:type': 'xlinkType',
  'xml:base': 'xmlBase',
  'xml:lang': 'xmlLang',
  'xml:space': 'xmlSpace',
  'xmlns:xlink': 'xmlnsXlink',
}

const SPECIAL_JSX_TO_MARKUP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SPECIAL_MARKUP_TO_JSX).map(([markup, jsx]) => [jsx, markup]),
)

function isPassThroughName(name: string): boolean {
  return name.startsWith('data-') || name.startsWith('aria-')
}

/**
 * The JSX spelling of a markup attribute, or `undefined` when it has none (a
 * namespaced attribute React does not alias: `sodipodi:docname`,
 * `inkscape:label`). Callers drop an attribute this returns `undefined` for.
 */
export function markupToJsxAttributeName(name: string): string | undefined {
  const special = SPECIAL_MARKUP_TO_JSX[name]
  if (special !== undefined) return special
  if (name.includes(':')) return undefined
  if (isPassThroughName(name)) return name
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** The markup spelling of a JSX attribute name. */
export function jsxToMarkupAttributeName(name: string): string {
  const special = SPECIAL_JSX_TO_MARKUP[name]
  if (special !== undefined) return special
  if (isPassThroughName(name) || name.includes(':')) return name
  if (CAMEL_CASE_SVG_ATTRIBUTES.has(name)) return name
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}
