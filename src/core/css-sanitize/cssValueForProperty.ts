/**
 * Give a NUMERIC CSS value its implied unit, then sanitise it.
 *
 * A style bag can hold real numbers — `style={{ width: size, height: size }}` in
 * a parsed source file, a module's own default, an imported document. `width: 44`
 * is not valid CSS: the browser drops the whole declaration, in the canvas and in
 * published HTML alike. The value has to become `44px` somewhere, and the only
 * layer that can decide is one that knows the PROPERTY — `sanitiseCssValue` sees
 * the value alone, so it can only stringify.
 *
 * The rule is React's, because a style bag in this codebase IS a React style
 * object on the canvas path (`bagToReactStyle` feeds `style={…}`): a number gets
 * `px` unless the property is unitless. Matching React exactly means the canvas
 * and the publisher agree, and neither surprises anyone who has written JSX.
 *
 * Strings pass through untouched — an authored `'44'`, `'2rem'` or `'var(--x)'`
 * is the author's call, and guessing a unit for a bare numeric STRING would
 * change the meaning of a value someone wrote deliberately.
 */
import { sanitiseCssValue } from './sanitiseCssValue'

/**
 * Properties whose numeric values carry no unit — React's `isUnitlessNumber`
 * list, minus the vendor-prefixed aliases (this codebase emits standard CSS).
 *
 * Getting this wrong in either direction is a visible bug: a missing entry turns
 * `flexShrink: 0` into `0px` (invalid for a number, declaration dropped), and a
 * spurious one turns `width: 44` into `44` (also dropped).
 */
const UNITLESS_CSS_PROPERTIES: ReadonlySet<string> = new Set([
  'animationIterationCount',
  'aspectRatio',
  'borderImageOutset',
  'borderImageSlice',
  'borderImageWidth',
  'boxFlex',
  'boxFlexGroup',
  'boxOrdinalGroup',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexPositive',
  'flexShrink',
  'flexNegative',
  'flexOrder',
  'gridArea',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'fontWeight',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'scale',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
])

/** `true` when a bare number is already a complete value for `property`. */
export function isUnitlessCssProperty(property: string): boolean {
  // Custom properties (`--x`) take the value verbatim: what a bare number means
  // there depends entirely on where the `var()` is used, so never guess a unit.
  if (property.startsWith('--')) return true
  return UNITLESS_CSS_PROPERTIES.has(property)
}

/**
 * The emittable CSS text for `value` under `property`, or `null` to drop the
 * declaration. Every style-bag emitter goes through this rather than calling
 * `sanitiseCssValue` directly, so the px rule can't diverge between them.
 *
 * `property` may be camelCase (`flexShrink`, the bag's own shape) or the kebab
 * spelling — both are recognised.
 */
export function cssValueForProperty(property: string, value: string | number): string | null {
  if (typeof value !== 'number') return sanitiseCssValue(value)
  // 0 is valid unitless for every property, so it needs no unit either way.
  if (value === 0 || isUnitlessCssProperty(camelCaseCssProperty(property))) {
    return sanitiseCssValue(value)
  }
  return sanitiseCssValue(`${value}px`)
}

/** `flex-shrink` → `flexShrink`; an already-camelCase name is returned as-is. */
function camelCaseCssProperty(property: string): string {
  if (!property.includes('-') || property.startsWith('--')) return property
  return property.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase())
}
